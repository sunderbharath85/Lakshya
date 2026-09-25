import type { A2AMessage, A2ATask, Part, Persona, TaskState } from "../shared/types";
import { TERMINAL_STATES, textOf } from "../shared/types";
import { emitLocal, onEvent } from "./bus";
import { canTalk } from "./prompt";
import { getSession, notify, onSessionExit, runningSessions, spawnSession } from "./sessions";
import { getPersona, getTask, listPersonas, listTasks, markRead, newId, saveMessage, saveTask, unreadFor } from "./store";

/** Who is calling: the human at the portal, an outside A2A client, or one of our agent sessions. */
export type Sender = { kind: "user" } | { kind: "external" } | { kind: "session"; id: string; persona: Persona };

export class A2AError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}
export const ERR = { invalidParams: -32602, methodNotFound: -32601, taskNotFound: -32001, notCancelable: -32002, forbidden: -32003 };

export const senderKey = (s: Sender) => (s.kind === "session" ? s.id : s.kind);

const currentContext = new Map<string, string>();

/** First line of a message, cut at a word boundary. */
function titleOf(text: string) {
  const line = text.split("\n")[0]!.trim();
  if (line.length <= 90) return line;
  const cut = line.slice(0, 90);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 60)).replace(/[\s,.:;-]+$/, "")}…`;
}

function label(key: string) {
  if (key === "user") return "the user";
  if (key === "external") return "an external A2A client";
  const s = getSession(key);
  const p = s && getPersona(s.personaId);
  return p ? `${p.name} (${key})` : key;
}

function publish(task: A2ATask, message?: A2AMessage) {
  const { history: _h, ...rest } = task;
  emitLocal({ type: "task", task: rest });
  if (message) emitLocal({ type: "message", message });
}

function makeMessage(task: A2ATask, from: string, to: string, role: "user" | "agent", parts: Part[]): A2AMessage {
  return {
    kind: "message",
    messageId: newId("msg"),
    role,
    parts,
    taskId: task.id,
    contextId: task.contextId,
    metadata: { from, to, createdAt: Date.now() },
  };
}

/** Store a message and tell its recipient about it. */
function deliver(task: A2ATask, message: A2AMessage, recipient: string, notice: string) {
  saveMessage(message, recipient);
  if (recipient !== "user" && recipient !== "external") {
    notify(recipient, `[A2A] ${notice} Task ${task.id}: "${task.metadata.title}". Call check_inbox.`);
  }
}

function setState(task: A2ATask, state: TaskState, message?: A2AMessage) {
  task.status = { state, message, timestamp: new Date().toISOString() };
  task.metadata.updatedAt = Date.now();
  saveTask(task);
}

/** Pick the session that should receive a new task for a persona, starting one if needed. */
async function resolveExecutor(to: string, sender: Sender, newSession: boolean): Promise<{ sessionId: string; persona: Persona | null }> {
  if (to === "user") {
    if (sender.kind !== "session") throw new A2AError(ERR.invalidParams, "Only agents can open tasks with the user");
    return { sessionId: "user", persona: null };
  }
  const session = getSession(to);
  if (session) {
    if (session.activity === "exited") throw new A2AError(ERR.invalidParams, `Session ${to} has exited. Message the persona "${session.personaId}" instead.`);
    return { sessionId: session.id, persona: getPersona(session.personaId)! };
  }
  const persona = getPersona(to);
  if (!persona) {
    const ids = listPersonas().map((p) => p.id).join(", ");
    throw new A2AError(ERR.invalidParams, `No agent "${to}". Personas: ${ids}, or a running session id.`);
  }
  const running = runningSessions(persona.id);
  const spawnedBy = senderKey(sender);
  if (running.length === 0 || (newSession && running.length < persona.maxInstances)) {
    if (newSession && sender.kind === "session" && !sender.persona.canSpawn) {
      throw new A2AError(ERR.forbidden, `${sender.persona.name} may not start new sessions (canSpawn is off)`);
    }
    const s = await spawnSession(persona.id, spawnedBy);
    return { sessionId: s.id, persona };
  }
  // Least busy running session.
  const open = listTasks().filter((t) => !TERMINAL_STATES.includes(t.status.state));
  const load = (id: string) => open.filter((t) => t.metadata.to === id).length;
  running.sort((a, b) => load(a.id) - load(b.id));
  return { sessionId: running[0]!.id, persona };
}

export interface SendParams {
  to?: string;
  parts: Part[];
  taskId?: string;
  contextId?: string;
  newSession?: boolean;
}

export async function sendMessage(sender: Sender, p: SendParams): Promise<A2ATask> {
  if (!p.parts?.length || !textOf(p.parts).trim()) throw new A2AError(ERR.invalidParams, "Message is empty");
  const me = senderKey(sender);

  // Follow-up on an existing task.
  if (p.taskId) {
    const task = getTask(p.taskId, false);
    if (!task) throw new A2AError(ERR.taskNotFound, `Task ${p.taskId} not found`);
    if (TERMINAL_STATES.includes(task.status.state)) {
      throw new A2AError(ERR.notCancelable, `Task ${task.id} is ${task.status.state}. Open a new task (same context_id ${task.contextId}) instead.`);
    }
    let recipient: string;
    let role: "user" | "agent";
    if (me === task.metadata.from || (sender.kind === "user" && me !== task.metadata.to)) {
      recipient = task.metadata.to;
      role = "user";
      if (task.status.state === "input-required") setState(task, "working");
    } else if (me === task.metadata.to) {
      recipient = task.metadata.from;
      role = "agent";
    } else {
      throw new A2AError(ERR.forbidden, `${label(me)} is not part of task ${task.id}`);
    }
    const msg = makeMessage(task, me, recipient, role, p.parts);
    task.metadata.updatedAt = Date.now();
    saveTask(task);
    deliver(task, msg, recipient, `New message from ${label(me)}.`);
    publish(task, msg);
    return task;
  }

  if (!p.to) throw new A2AError(ERR.invalidParams, "Say who the message is for (to)");
  if (sender.kind === "session") {
    const target = getSession(p.to)?.personaId ?? p.to;
    if (target !== "user" && !canTalk(sender.persona, target)) {
      throw new A2AError(ERR.forbidden, `${sender.persona.name} is not allowed to contact ${target}. Allowed: ${sender.persona.canTalkTo.join(", ")}`);
    }
  }
  const { sessionId, persona } = await resolveExecutor(p.to, sender, !!p.newSession);
  const text = textOf(p.parts).trim();
  const now = Date.now();
  const task: A2ATask = {
    kind: "task",
    id: newId("task"),
    contextId: p.contextId ?? currentContext.get(me) ?? newId("ctx"),
    status: { state: "submitted", timestamp: new Date(now).toISOString() },
    artifacts: [],
    metadata: {
      title: titleOf(text),
      from: me,
      to: sessionId,
      toPersona: persona?.id ?? "user",
      createdAt: now,
      updatedAt: now,
    },
  };
  if (sender.kind !== "session") currentContext.set(me, task.contextId);
  saveTask(task);
  const msg = makeMessage(task, me, sessionId, "user", p.parts);
  deliver(task, msg, sessionId, `New task from ${label(me)}.`);
  publish(task, msg);
  return task;
}

/** The executor of a task reports progress or a result. */
export function updateTask(sender: Sender, taskId: string, state: TaskState, text: string, artifactName?: string): A2ATask {
  const me = senderKey(sender);
  const task = getTask(taskId, false);
  if (!task) throw new A2AError(ERR.taskNotFound, `Task ${taskId} not found`);
  if (task.metadata.to !== me) throw new A2AError(ERR.forbidden, `Only ${label(task.metadata.to)} can update task ${taskId}`);
  if (TERMINAL_STATES.includes(task.status.state)) throw new A2AError(ERR.notCancelable, `Task ${taskId} is already ${task.status.state}`);
  const allowed: TaskState[] = ["working", "input-required", "completed", "failed", "rejected"];
  if (!allowed.includes(state)) throw new A2AError(ERR.invalidParams, `state must be one of ${allowed.join(", ")}`);

  const msg = text.trim() ? makeMessage(task, me, task.metadata.from, "agent", [{ kind: "text", text }]) : undefined;
  if (state === "completed" && text.trim()) {
    task.artifacts = [...(task.artifacts ?? []), { artifactId: newId("art"), name: artifactName || "result", parts: [{ kind: "text", text }] }];
  }
  setState(task, state, msg);
  if (msg) {
    const verb = { working: "sent an update", "input-required": "needs your input", completed: "completed", failed: "failed", rejected: "rejected" }[
      state as "working"
    ];
    deliver(task, msg, task.metadata.from, `${label(me)} ${verb}.`);
  }
  publish(task, msg);
  return task;
}

export function cancelTask(sender: Sender, taskId: string): A2ATask {
  const me = senderKey(sender);
  const task = getTask(taskId, false);
  if (!task) throw new A2AError(ERR.taskNotFound, `Task ${taskId} not found`);
  if (TERMINAL_STATES.includes(task.status.state)) throw new A2AError(ERR.notCancelable, `Task ${taskId} is already ${task.status.state}`);
  if (me !== task.metadata.from && sender.kind !== "user" && !(sender.kind === "session" && sender.persona.orchestrator)) {
    throw new A2AError(ERR.forbidden, `Only the requester can cancel task ${taskId}`);
  }
  const msg = makeMessage(task, me, task.metadata.to, "user", [{ kind: "text", text: `Task canceled by ${label(me)}. Stop working on it.` }]);
  setState(task, "canceled", msg);
  deliver(task, msg, task.metadata.to, `${label(me)} canceled a task.`);
  publish(task, msg);
  return task;
}

/** Unread messages for a session; opening them moves submitted tasks to working. */
export function readInbox(sessionId: string) {
  const messages = unreadFor(sessionId);
  markRead(messages.map((m) => m.messageId));
  const tasks = new Map<string, A2ATask>();
  for (const m of messages) {
    if (!m.taskId || tasks.has(m.taskId)) continue;
    const t = getTask(m.taskId, false);
    if (!t) continue;
    if (t.metadata.to === sessionId && t.status.state === "submitted") {
      setState(t, "working");
      publish(t);
    }
    currentContext.set(sessionId, t.contextId);
    tasks.set(t.id, t);
  }
  return { messages, tasks: [...tasks.values()] };
}

export function userInbox() {
  const messages = unreadFor("user");
  return messages;
}

export function markUserRead(ids: string[]) {
  markRead(ids);
}

/** Resolve when the task needs the caller (input-required) or is finished, or on timeout. */
export function waitForTask(taskId: string, timeoutMs: number): Promise<A2ATask | undefined> {
  const settled = (t?: A2ATask) => !t || TERMINAL_STATES.includes(t.status.state) || t.status.state === "input-required";
  const now = getTask(taskId);
  if (settled(now)) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      off();
      resolve(getTask(taskId));
    };
    const timer = setTimeout(done, timeoutMs);
    const off = onEvent((e) => {
      if (e.type === "task" && e.task.id === taskId && settled(e.task)) done();
    });
  });
}

/** When a session dies, fail the tasks it still owed. */
onSessionExit((s) => {
  for (const t of listTasks()) {
    if (t.metadata.to !== s.id || TERMINAL_STATES.includes(t.status.state)) continue;
    const msg = makeMessage(t, s.id, t.metadata.from, "agent", [
      { kind: "text", text: `Session ${s.id} exited before finishing this task. Send it again to start a new session.` },
    ]);
    setState(t, "failed", msg);
    deliver(t, msg, t.metadata.from, `${label(s.id)} exited.`);
    publish(t, msg);
  }
});

/** A note from the autopilot loop to whoever requested a task. */
export function autopilotNote(taskId: string, text: string) {
  const task = getTask(taskId, false);
  if (!task || TERMINAL_STATES.includes(task.status.state)) return;
  const msg = makeMessage(task, "autopilot", task.metadata.from, "agent", [{ kind: "text", text }]);
  task.metadata.updatedAt = Date.now();
  saveTask(task);
  deliver(task, msg, task.metadata.from, "Autopilot flagged a stalled task.");
  publish(task, msg);
}
