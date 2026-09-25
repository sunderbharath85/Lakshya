#!/usr/bin/env bun
// Stdio MCP server that gives a coding agent (Claude Code, Codex, OpenCode) its A2A tools.
// Each agent session runs its own copy, identified to the portal by a per-session bearer token.
import type { A2AMessage, A2ATask, Persona } from "../shared/types";
import { textOf } from "../shared/types";

const argv = process.argv.slice(2);
const arg = (name: string, env: string) => {
  const i = argv.indexOf(`--${name}`);
  return (i >= 0 ? argv[i + 1] : undefined) ?? process.env[env] ?? "";
};
const URL_BASE = arg("url", "AOS_PORTAL_URL") || "http://127.0.0.1:4777";
const SESSION = arg("session", "AOS_SESSION_ID");
const TOKEN = arg("token", "AOS_TOKEN");

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${URL_BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...init.headers },
  });
  const body = (await res.json()) as any;
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

let rpcId = 0;
async function a2a<T>(agent: string | null, method: string, params: unknown): Promise<T> {
  const body = await call<any>(agent ? `/a2a/${encodeURIComponent(agent)}` : "/a2a", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
}

// ---------- formatting ----------

function fmtTask(t: A2ATask, withHistory = false) {
  const lines = [
    `${t.id} [${t.status.state}] "${t.metadata.title}"`,
    `  from ${t.metadata.from} to ${t.metadata.to} · context ${t.contextId}`,
  ];
  if (t.status.message) lines.push(`  latest: ${textOf(t.status.message.parts)}`);
  for (const a of t.artifacts ?? []) lines.push(`  artifact ${a.name ?? a.artifactId}:\n${indent(textOf(a.parts))}`);
  if (withHistory && t.history?.length) {
    lines.push("  history:");
    for (const m of t.history) lines.push(`  - ${m.metadata?.from} → ${m.metadata?.to}:\n${indent(textOf(m.parts), 6)}`);
  }
  return lines.join("\n");
}
const indent = (s: string, n = 4) =>
  s
    .split("\n")
    .map((l) => " ".repeat(n) + l)
    .join("\n");

// ---------- tools ----------

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  when?: (p: Persona) => boolean;
  run: (args: any) => Promise<string>;
};

const str = (description: string) => ({ type: "string", description });

const TOOLS: Tool[] = [
  {
    name: "list_agents",
    description: "List the team: every persona, whether you may contact it, and its running sessions with their activity and open task count.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const dir = await call<any[]>("/api/agent/directory");
      return dir
        .map((p) => {
          const sessions = p.sessions.length
            ? p.sessions.map((s: any) => `${s.id} (${s.activity}, ${s.openTasks} open)`).join(", ")
            : "none running (a message will start one)";
          return `${p.id}: ${p.name}, ${p.title} [${p.runtime}]${p.yourRole ? " (your role)" : ""}${p.canContact ? "" : " (you may not contact)"}\n  ${p.description}\n  sessions: ${sessions}`;
        })
        .join("\n");
    },
  },
  {
    name: "send_message",
    description:
      "Send an A2A message. Without task_id it opens a new task with `to` (a persona id such as \"sde\", a session id such as \"sde-2\", or \"user\"); messaging a persona starts a session for it when none is running. With task_id it adds a follow-up message to that existing task (answer a question, add detail, push back). Returns the task id; use wait_for_task to wait for the result.",
    inputSchema: {
      type: "object",
      properties: {
        to: str("Persona id, session id, or \"user\". Not needed with task_id."),
        message: str("What you need, with enough context to act on without asking. Mention file paths."),
        task_id: str("Existing task to continue."),
        context_id: str("Group this task with an existing context (project). Defaults to the context you are working in."),
        new_session: { type: "boolean", description: "Start a fresh session of the persona for this task (parallel work). Needs spawn permission." },
      },
      required: ["message"],
    },
    async run(a) {
      if (!a.to && !a.task_id) throw new Error("Give `to` for a new task, or `task_id` to continue one.");
      const message: Partial<A2AMessage> = {
        kind: "message",
        messageId: crypto.randomUUID(),
        role: "user",
        parts: [{ kind: "text", text: a.message }],
        taskId: a.task_id,
        contextId: a.context_id,
      };
      const t = await a2a<A2ATask>(a.task_id ? null : a.to, "message/send", { message, metadata: { newSession: !!a.new_session } });
      return `${a.task_id ? "Follow-up sent on" : "Opened"} task ${t.id} with ${t.metadata.to} (state: ${t.status.state}, context ${t.contextId}).`;
    },
  },
  {
    name: "check_inbox",
    description: "Read your unread A2A messages: new tasks for you, questions, replies and results for tasks you opened. Opening a new task marks it working.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const { messages, tasks } = await call<{ messages: A2AMessage[]; tasks: A2ATask[] }>("/api/agent/inbox", { method: "POST" });
      if (!messages.length) return "Inbox is empty. Wait for the next [A2A] notice.";
      const byTask = new Map(tasks.map((t) => [t.id, t]));
      const out = messages.map((m) => {
        const t = m.taskId ? byTask.get(m.taskId) : undefined;
        const mine = t?.metadata.to === SESSION;
        const head = t
          ? `${mine ? "TASK FOR YOU" : "REPLY ON YOUR TASK"} ${t.id} [${t.status.state}] "${t.metadata.title}" (context ${t.contextId})`
          : "MESSAGE";
        return `${head}\nfrom ${m.metadata?.from}:\n${indent(textOf(m.parts))}${mine ? `\n→ When done: update_task task_id=${t!.id}` : ""}`;
      });
      return out.join("\n\n");
    },
  },
  {
    name: "update_task",
    description:
      "Report on a task assigned to you. state=working for a progress note, input-required to ask the requester a question, completed with the result (what you did, files, how to verify), failed or rejected with the reason. The requester is notified.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: str("Task id"),
        state: { type: "string", enum: ["working", "input-required", "completed", "failed", "rejected"] },
        message: str("Progress note, question, result or reason."),
        artifact_name: str("Optional name for the result artifact when completing, e.g. \"api-contract\"."),
      },
      required: ["task_id", "state", "message"],
    },
    async run(a) {
      const t = await call<A2ATask>(`/api/agent/tasks/${a.task_id}/status`, {
        method: "POST",
        body: JSON.stringify({ state: a.state, message: a.message, artifactName: a.artifact_name }),
      });
      return `Task ${t.id} is now ${t.status.state}. ${t.metadata.from} has been notified.`;
    },
  },
  {
    name: "get_task",
    description: "Get a task's state, artifacts and full message history.",
    inputSchema: { type: "object", properties: { task_id: str("Task id") }, required: ["task_id"] },
    async run(a) {
      return fmtTask(await a2a<A2ATask>(null, "tasks/get", { id: a.task_id }), true);
    },
  },
  {
    name: "wait_for_task",
    description:
      "Block until a task you opened is completed, failed, canceled or needs your input, or until the timeout. Use this instead of polling. If it times out, the task is still running; do other work or wait again.",
    inputSchema: {
      type: "object",
      properties: { task_id: str("Task id"), timeout_seconds: { type: "number", description: "Default 300, max 840." } },
      required: ["task_id"],
    },
    async run(a) {
      const t = await call<A2ATask>(`/api/agent/tasks/${a.task_id}/wait?timeout=${a.timeout_seconds ?? 300}`);
      const settled = ["completed", "failed", "canceled", "rejected", "input-required"].includes(t.status.state);
      return `${settled ? "" : "Still running after the timeout.\n"}${fmtTask(t, true)}`;
    },
  },
  {
    name: "cancel_task",
    description: "Cancel a task you opened. The assignee is told to stop.",
    inputSchema: { type: "object", properties: { task_id: str("Task id") }, required: ["task_id"] },
    async run(a) {
      const t = await a2a<A2ATask>(null, "tasks/cancel", { id: a.task_id });
      return `Task ${t.id} is ${t.status.state}.`;
    },
  },
  {
    name: "list_tasks",
    description: "List tasks. scope=mine (default): tasks you opened or own. scope=all (orchestrator only): every open task on the team.",
    inputSchema: { type: "object", properties: { scope: { type: "string", enum: ["mine", "all"] } } },
    async run(a) {
      const tasks = await call<A2ATask[]>(`/api/agent/tasks?scope=${a.scope ?? "mine"}`);
      return tasks.length ? tasks.map((t) => fmtTask(t)).join("\n") : "No tasks.";
    },
  },
  {
    name: "spawn_agent",
    description: "Start a new session of a persona (e.g. a second sde for parallel work). Returns its session id; address tasks to that id.",
    inputSchema: { type: "object", properties: { persona: str("Persona id") }, required: ["persona"] },
    when: (p) => p.canSpawn,
    async run(a) {
      const s = await call<any>("/api/agent/spawn", { method: "POST", body: JSON.stringify({ persona: a.persona }) });
      return `Started session ${s.id} (${s.runtime}). Send it work with send_message to="${s.id}".`;
    },
  },
  {
    name: "stop_agent",
    description: "Stop a session that is no longer needed. Its unfinished tasks are marked failed.",
    inputSchema: { type: "object", properties: { session_id: str("Session id") }, required: ["session_id"] },
    when: (p) => p.canSpawn,
    async run(a) {
      const r = await call<{ stopped: boolean }>("/api/agent/stop", { method: "POST", body: JSON.stringify({ session: a.session_id }) });
      return r.stopped ? `Stopping ${a.session_id}.` : `${a.session_id} was not running.`;
    },
  },
];

// ---------- MCP stdio protocol ----------

let me: { persona: Persona } | null = null;
async function persona() {
  if (!me) me = await call<{ persona: Persona }>("/api/agent/me").catch(() => null);
  return me?.persona;
}

const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");

async function handle(msg: any) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "agentic-os-a2a", version: "1.0.0" },
        instructions: `A2A tools for session ${SESSION}. When a line starting with [A2A] appears, call check_inbox.`,
      });
    case "ping":
      return reply({});
    case "tools/list": {
      const p = await persona();
      return reply({
        tools: TOOLS.filter((t) => !t.when || (p && t.when(p))).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    }
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool ${params?.name}` } });
      try {
        const text = await tool.run(params.arguments ?? {});
        return reply({ content: [{ type: "text", text }] });
      } catch (e) {
        return reply({ content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true });
      }
    }
    default:
      return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method ${method} not found` } });
  }
}

for await (const line of console) {
  if (!line.trim()) continue;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    continue;
  }
  // Handle concurrently: wait_for_task may block for minutes.
  handle(msg).catch((e) => send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e) } }));
}
