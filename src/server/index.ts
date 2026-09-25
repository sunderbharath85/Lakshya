import { APP_NAME } from "../shared/brand";
import index from "../web/index.html";
import type { A2ATask, Persona, TaskState } from "../shared/types";
import { TERMINAL_STATES } from "../shared/types";
import { A2AError, cancelTask, ERR, markUserRead, readInbox, sendMessage, updateTask, waitForTask, type Sender } from "./a2a";
import { EVENTS_TOPIC, onEvent, setPublisher, termTopic, emit } from "./bus";
import { canTalk } from "./prompt";
import { runtimeAvailability } from "./runtimes";
import { startSupervisor } from "./supervisor";
import {
  configureSessions,
  forgetSession,
  getSession,
  listSessions,
  personaOf,
  resizeSession,
  screenSnapshot,
  spawnSession,
  stopSession,
  tokenOwner,
  writeInput,
} from "./sessions";
import {
  DATA_DIR,
  deletePersona,
  getPersona,
  getSettings,
  getTask,
  listPersonas,
  listTasks,
  recentMessages,
  savePersona,
  saveSettings,
  seedPersonas,
} from "./store";

const PORT = Number(process.env.AOS_PORT ?? 4777);
const HOST = process.env.AOS_HOST ?? "127.0.0.1";
const PORTAL = `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`;

seedPersonas();
configureSessions(PORTAL);
startSupervisor();

// ---------- helpers ----------

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (message: string, status = 400) => json({ error: message }, status);

function senderFrom(req: Request): Sender {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const id = tokenOwner(auth.slice(7));
    const persona = id ? personaOf(id) : undefined;
    if (id && persona) return { kind: "session", id, persona };
  }
  return { kind: "external" };
}

function requireAgent(req: Request): Extract<Sender, { kind: "session" }> {
  const s = senderFrom(req);
  if (s.kind !== "session") throw new A2AError(ERR.forbidden, "Unknown or missing agent token");
  return s;
}

async function guard(fn: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof A2AError) return json({ error: e.message, code: e.code }, e.code === ERR.taskNotFound ? 404 : e.code === ERR.forbidden ? 403 : 400);
    return fail(e instanceof Error ? e.message : String(e), 500);
  }
}

function agentCard(persona: Persona, sessionId?: string) {
  const id = sessionId ?? persona.id;
  return {
    protocolVersion: "0.3.0",
    name: sessionId ? `${persona.name} (${sessionId})` : persona.name,
    description: `${persona.title}. ${persona.description}`,
    url: `${PORTAL}/a2a/${id}`,
    preferredTransport: "JSONRPC",
    version: "1.0.0",
    provider: { organization: APP_NAME, url: PORTAL },
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: persona.skills.map((s) => ({ ...s, examples: [] })),
    metadata: { runtime: persona.runtime, canTalkTo: persona.canTalkTo, orchestrator: persona.orchestrator },
  };
}

function entryPersona() {
  return listPersonas().find((p) => p.entry) ?? listPersonas()[0]!;
}

/** Shape a task for tools and A2A clients, trimming history when asked. */
function taskView(task: A2ATask, historyLength?: number) {
  const full = getTask(task.id) ?? task;
  if (historyLength !== undefined && full.history) full.history = full.history.slice(-historyLength);
  return full;
}

// ---------- A2A JSON-RPC ----------

type Rpc = { jsonrpc: "2.0"; id: string | number | null; method: string; params?: any };

async function rpcResult(rpc: Rpc, sender: Sender, agentId: string | undefined) {
  const p = rpc.params ?? {};
  switch (rpc.method) {
    case "message/send": {
      const m = p.message;
      if (!m?.parts) throw new A2AError(ERR.invalidParams, "params.message.parts is required");
      const task = await sendMessage(sender, {
        to: m.taskId ? undefined : (agentId ?? entryPersona().id),
        parts: m.parts,
        taskId: m.taskId,
        contextId: m.contextId,
        newSession: !!p.metadata?.newSession,
      });
      return taskView(task, p.configuration?.historyLength);
    }
    case "tasks/get": {
      const t = getTask(p.id);
      if (!t) throw new A2AError(ERR.taskNotFound, `Task ${p.id} not found`);
      return taskView(t, p.historyLength);
    }
    case "tasks/cancel":
      return taskView(cancelTask(sender, p.id));
    default:
      throw new A2AError(ERR.methodNotFound, `Method ${rpc.method} is not supported`);
  }
}

/** message/stream: SSE of the task, then status/artifact updates until it settles. */
function rpcStream(rpc: Rpc, sender: Sender, agentId: string | undefined) {
  const enc = new TextEncoder();
  let off = () => {};
  const stream = new ReadableStream({
    async start(controller) {
      const send = (result: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\n\n`));
      try {
        const task = (await rpcResult({ ...rpc, method: "message/send" }, sender, agentId)) as A2ATask;
        send(task);
        off = onEvent((e) => {
          if (e.type !== "task" || e.task.id !== task.id) return;
          const final = TERMINAL_STATES.includes(e.task.status.state) || e.task.status.state === "input-required";
          if (e.task.status.state === "completed") {
            for (const artifact of e.task.artifacts ?? []) {
              send({ kind: "artifact-update", taskId: task.id, contextId: task.contextId, artifact, lastChunk: true });
            }
          }
          send({ kind: "status-update", taskId: task.id, contextId: task.contextId, status: e.task.status, final });
          if (final) {
            off();
            controller.close();
          }
        });
      } catch (e) {
        const err = e instanceof A2AError ? { code: e.code, message: e.message } : { code: -32603, message: String(e) };
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: err })}\n\n`));
        controller.close();
      }
    },
    cancel() {
      off();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

async function handleRpc(req: Request, agentId?: string) {
  let rpc: Rpc;
  try {
    rpc = await req.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  if (agentId && agentId !== "user" && !getPersona(agentId) && !getSession(agentId)) {
    return json({ jsonrpc: "2.0", id: rpc.id, error: { code: ERR.invalidParams, message: `No agent ${agentId}` } });
  }
  const sender = senderFrom(req);
  if (rpc.method === "message/stream") return rpcStream(rpc, sender, agentId);
  try {
    return json({ jsonrpc: "2.0", id: rpc.id, result: await rpcResult(rpc, sender, agentId) });
  } catch (e) {
    const error = e instanceof A2AError ? { code: e.code, message: e.message } : { code: -32603, message: e instanceof Error ? e.message : String(e) };
    return json({ jsonrpc: "2.0", id: rpc.id, error });
  }
}

// ---------- directory (what an agent sees of its team) ----------

function directory(me?: Extract<Sender, { kind: "session" }>) {
  const sessions = listSessions().filter((s) => s.activity !== "exited");
  const open = listTasks().filter((t) => !TERMINAL_STATES.includes(t.status.state));
  return listPersonas().map((p) => ({
    id: p.id,
    name: p.name,
    title: p.title,
    description: p.description,
    runtime: p.runtime,
    canContact: me ? canTalk(me.persona, p.id) : true,
    yourRole: me?.persona.id === p.id,
    maxInstances: p.maxInstances,
    sessions: sessions
      .filter((s) => s.personaId === p.id)
      .map((s) => ({ id: s.id, activity: s.activity, openTasks: open.filter((t) => t.metadata.to === s.id).length })),
  }));
}

// ---------- server ----------

type WsData = { kind: "events" } | { kind: "term"; id: string };

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },
  idleTimeout: 0,
  routes: {
    "/": index,
    "/sessions/*": index,

    // ----- A2A discovery + JSON-RPC -----
    "/.well-known/agent-card.json": () => json(agentCard(entryPersona())),
    "/.well-known/agent.json": () => json(agentCard(entryPersona())),
    "/a2a": { POST: (req) => handleRpc(req) },
    "/a2a/:agent": { POST: (req) => handleRpc(req, req.params.agent) },
    "/a2a/:agent/.well-known/agent-card.json": (req) => {
      const s = getSession(req.params.agent);
      const p = getPersona(s?.personaId ?? req.params.agent);
      return p ? json(agentCard(p, s?.id)) : fail("No such agent", 404);
    },
    "/a2a-directory": () => json(listPersonas().map((p) => agentCard(p))),

    // ----- API used by the agents' MCP bridge (bearer token) -----
    "/api/agent/me": (req) =>
      guard(() => {
        const me = requireAgent(req);
        return json({ sessionId: me.id, persona: me.persona });
      }),
    "/api/agent/directory": (req) => guard(() => json(directory(requireAgent(req)))),
    "/api/agent/inbox": {
      POST: (req) =>
        guard(() => {
          const me = requireAgent(req);
          const { messages, tasks } = readInbox(me.id);
          return json({ messages, tasks });
        }),
    },
    "/api/agent/tasks": (req) =>
      guard(() => {
        const me = requireAgent(req);
        const scope = new URL(req.url).searchParams.get("scope") ?? "mine";
        let tasks = listTasks().filter((t) => !TERMINAL_STATES.includes(t.status.state) || Date.now() - t.metadata.updatedAt < 3600_000);
        if (scope === "mine") tasks = tasks.filter((t) => t.metadata.to === me.id || t.metadata.from === me.id);
        else if (!me.persona.orchestrator) return fail("Only the orchestrator can list every task", 403);
        return json(tasks);
      }),
    "/api/agent/tasks/:id/status": {
      POST: (req) =>
        guard(async () => {
          const me = requireAgent(req);
          const body = (await req.json()) as { state: TaskState; message?: string; artifactName?: string };
          return json(updateTask(me, req.params.id, body.state, body.message ?? "", body.artifactName));
        }),
    },
    "/api/agent/tasks/:id/wait": (req) =>
      guard(async () => {
        requireAgent(req);
        const timeout = Math.min(Number(new URL(req.url).searchParams.get("timeout") ?? 120), 840) * 1000;
        const t = await waitForTask(req.params.id, timeout);
        return t ? json(t) : fail(`Task ${req.params.id} not found`, 404);
      }),
    "/api/agent/spawn": {
      POST: (req) =>
        guard(async () => {
          const me = requireAgent(req);
          if (!me.persona.canSpawn) return fail(`${me.persona.name} may not start sessions`, 403);
          const { persona } = (await req.json()) as { persona: string };
          if (!canTalk(me.persona, persona)) return fail(`${me.persona.name} may not work with ${persona}`, 403);
          return json(await spawnSession(persona, me.id));
        }),
    },
    "/api/agent/stop": {
      POST: (req) =>
        guard(async () => {
          const me = requireAgent(req);
          const { session } = (await req.json()) as { session: string };
          const target = getSession(session);
          if (!target) return fail(`No session ${session}`, 404);
          if (!me.persona.canSpawn && target.spawnedBy !== me.id) return fail("You can only stop sessions you started", 403);
          if (target.id === me.id) return fail("You cannot stop yourself", 400);
          return json({ stopped: stopSession(session) });
        }),
    },

    // ----- API used by the web UI -----
    "/api/state": () =>
      json({
        personas: listPersonas(),
        sessions: listSessions(),
        tasks: listTasks(),
        messages: recentMessages(),
        settings: getSettings(),
        runtimes: runtimeAvailability(),
      }),
    "/api/runtimes": () => json(runtimeAvailability()),
    "/api/personas": {
      GET: () => json(listPersonas()),
      POST: (req) =>
        guard(async () => {
          const p = (await req.json()) as Persona;
          if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(p.id ?? "")) return fail("Id must be 2-40 lowercase letters, digits or dashes");
          if (getPersona(p.id)) return fail(`A persona with id "${p.id}" already exists`, 409);
          savePersona(p);
          emit({ type: "personas", personas: listPersonas() });
          return json(p, 201);
        }),
    },
    "/api/personas/reset": {
      POST: () => {
        seedPersonas(true);
        emit({ type: "personas", personas: listPersonas() });
        return json(listPersonas());
      },
    },
    "/api/personas/:id": {
      PUT: (req) =>
        guard(async () => {
          if (!getPersona(req.params.id)) return fail("No such persona", 404);
          const p = { ...((await req.json()) as Persona), id: req.params.id };
          if (p.entry) for (const other of listPersonas()) if (other.id !== p.id && other.entry) savePersona({ ...other, entry: false });
          savePersona(p);
          emit({ type: "personas", personas: listPersonas() });
          return json(p);
        }),
      DELETE: (req) => {
        deletePersona(req.params.id);
        emit({ type: "personas", personas: listPersonas() });
        return json({ ok: true });
      },
    },
    "/api/sessions": {
      POST: (req) =>
        guard(async () => {
          const { personaId } = (await req.json()) as { personaId: string };
          return json(await spawnSession(personaId, "user"), 201);
        }),
    },
    "/api/sessions/:id": {
      DELETE: (req) => json({ stopped: stopSession(req.params.id) }),
    },
    "/api/sessions/:id/input": {
      POST: async (req) => {
        const { data } = (await req.json()) as { data: string };
        writeInput(req.params.id, data);
        return json({ ok: true });
      },
    },
    "/api/sessions/:id/forget": { POST: (req) => (forgetSession(req.params.id), json({ ok: true })) },
    "/api/sessions/:id/role": async (req) => {
      const f = Bun.file(`${DATA_DIR}/sessions/${req.params.id}/role.md`);
      return (await f.exists()) ? new Response(f) : fail("No role file", 404);
    },
    "/api/request": {
      POST: (req) =>
        guard(async () => {
          const { text, to } = (await req.json()) as { text: string; to?: string };
          const task = await sendMessage({ kind: "user" }, { to: to || entryPersona().id, parts: [{ kind: "text", text }] });
          return json(task, 201);
        }),
    },
    "/api/tasks/:id": (req) => {
      const t = getTask(req.params.id);
      return t ? json(t) : fail("No such task", 404);
    },
    "/api/tasks/:id/reply": {
      POST: (req) =>
        guard(async () => {
          const { text, state } = (await req.json()) as { text: string; state?: TaskState };
          const task = getTask(req.params.id, false);
          if (!task) return fail("No such task", 404);
          // The user answers tasks assigned to them, and sends follow-ups on tasks they opened.
          if (task.metadata.to === "user") return json(updateTask({ kind: "user" }, task.id, state ?? "completed", text));
          return json(await sendMessage({ kind: "user" }, { taskId: task.id, parts: [{ kind: "text", text }] }));
        }),
    },
    "/api/tasks/:id/cancel": { POST: (req) => guard(() => json(cancelTask({ kind: "user" }, req.params.id))) },
    "/api/messages/read": {
      POST: async (req) => {
        const { ids } = (await req.json()) as { ids: string[] };
        markUserRead(ids);
        return json({ ok: true });
      },
    },
    "/api/settings": {
      GET: () => json(getSettings()),
      PUT: async (req) => {
        const settings = saveSettings(await req.json());
        emit({ type: "settings", settings });
        return json(settings);
      },
    },
  },

  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws/events") {
      return server.upgrade(req, { data: { kind: "events" } }) ? undefined : fail("Upgrade failed");
    }
    const m = url.pathname.match(/^\/ws\/term\/([\w-]+)$/);
    if (m) return server.upgrade(req, { data: { kind: "term", id: m[1]! } }) ? undefined : fail("Upgrade failed");
    return fail("Not found", 404);
  },

  websocket: {
    data: {} as WsData,
    open(ws) {
      if (ws.data.kind === "events") {
        ws.subscribe(EVENTS_TOPIC);
        return;
      }
      const snap = screenSnapshot(ws.data.id);
      ws.send(JSON.stringify({ type: "snapshot", ...(snap ?? { data: "\x1b[2mThis session's screen is no longer in memory.\x1b[0m\r\n", cols: 0, rows: 0 }) }));
      ws.subscribe(termTopic(ws.data.id));
    },
    message(ws, raw) {
      if (ws.data.kind !== "term") return;
      const msg = JSON.parse(String(raw)) as { type: "input"; data: string } | { type: "resize"; cols: number; rows: number };
      if (msg.type === "input") writeInput(ws.data.id, msg.data);
      else if (msg.type === "resize") resizeSession(ws.data.id, msg.cols, msg.rows);
    },
  },
});

setPublisher((topic, data) => server.publish(topic, data));

console.log(`${APP_NAME} running at ${PORTAL}`);
console.log(`A2A agent card: ${PORTAL}/.well-known/agent-card.json`);
for (const r of runtimeAvailability()) console.log(`  ${r.name.padEnd(12)} ${r.path ?? "not found"}`);
