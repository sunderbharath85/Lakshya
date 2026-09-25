import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { A2AMessage, A2ATask, Persona, SessionInfo, Settings } from "../shared/types";
import { DEFAULT_PERSONAS } from "./default-personas";

export const ROOT = resolve(import.meta.dir, "../..");
export const DATA_DIR = resolve(process.env.AOS_DATA_DIR ?? `${ROOT}/data`);
mkdirSync(DATA_DIR, { recursive: true });

const dbPath = `${DATA_DIR}/agentic-os.sqlite`;
mkdirSync(dirname(dbPath), { recursive: true });
export const db = new Database(dbPath, { create: true, strict: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
CREATE TABLE IF NOT EXISTS personas (id TEXT PRIMARY KEY, data TEXT NOT NULL, position INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, token TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, context_id TEXT, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, task_id TEXT, recipient TEXT NOT NULL, data TEXT NOT NULL,
  created_at INTEGER NOT NULL, read_at INTEGER
);
CREATE INDEX IF NOT EXISTS messages_recipient ON messages (recipient, read_at);
CREATE INDEX IF NOT EXISTS messages_task ON messages (task_id);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;

// ---------- personas ----------

export function seedPersonas(force = false) {
  const count = db.query<{ n: number }, []>("SELECT count(*) AS n FROM personas").get()!.n;
  if (count > 0 && !force) return;
  db.transaction(() => {
    db.exec("DELETE FROM personas");
    DEFAULT_PERSONAS.forEach((p, i) => savePersona(p, i));
  })();
}

export function listPersonas(): Persona[] {
  return db
    .query<{ data: string }, []>("SELECT data FROM personas ORDER BY position")
    .all()
    .map((r) => JSON.parse(r.data));
}

export function getPersona(id: string): Persona | undefined {
  const r = db.query<{ data: string }, [string]>("SELECT data FROM personas WHERE id = ?").get(id);
  return r ? JSON.parse(r.data) : undefined;
}

export function savePersona(p: Persona, position?: number) {
  const pos =
    position ??
    db.query<{ position: number }, [string]>("SELECT position FROM personas WHERE id = ?").get(p.id)?.position ??
    db.query<{ n: number }, []>("SELECT coalesce(max(position), -1) + 1 AS n FROM personas").get()!.n;
  db.query("INSERT OR REPLACE INTO personas (id, data, position) VALUES (?, ?, ?)").run(p.id, JSON.stringify(p), pos);
}

export function deletePersona(id: string) {
  db.query("DELETE FROM personas WHERE id = ?").run(id);
}

// ---------- sessions ----------

export function saveSession(s: SessionInfo, token?: string) {
  if (token) {
    db.query("INSERT OR REPLACE INTO sessions (id, data, token) VALUES (?, ?, ?)").run(s.id, JSON.stringify(s), token);
  } else {
    db.query("UPDATE sessions SET data = ? WHERE id = ?").run(JSON.stringify(s), s.id);
  }
}

export function sessionForToken(token: string): string | undefined {
  return db.query<{ id: string }, [string]>("SELECT id FROM sessions WHERE token = ?").get(token)?.id;
}

export function listStoredSessions(): SessionInfo[] {
  return db
    .query<{ data: string }, []>("SELECT data FROM sessions")
    .all()
    .map((r) => JSON.parse(r.data));
}

// ---------- tasks & messages ----------

export function saveTask(t: A2ATask) {
  const { history: _h, ...rest } = t;
  db.query("INSERT OR REPLACE INTO tasks (id, context_id, data, updated_at) VALUES (?, ?, ?, ?)").run(
    t.id,
    t.contextId,
    JSON.stringify(rest),
    t.metadata.updatedAt,
  );
}

export function getTask(id: string, withHistory = true): A2ATask | undefined {
  const r = db.query<{ data: string }, [string]>("SELECT data FROM tasks WHERE id = ?").get(id);
  if (!r) return undefined;
  const t: A2ATask = JSON.parse(r.data);
  if (withHistory) t.history = taskHistory(id);
  return t;
}

export function listTasks(limit = 300): A2ATask[] {
  return db
    .query<{ data: string }, [number]>("SELECT data FROM tasks ORDER BY updated_at DESC LIMIT ?")
    .all(limit)
    .map((r) => JSON.parse(r.data));
}

export function taskHistory(taskId: string): A2AMessage[] {
  return db
    .query<{ data: string }, [string]>("SELECT data FROM messages WHERE task_id = ? ORDER BY created_at")
    .all(taskId)
    .map((r) => JSON.parse(r.data));
}

export function saveMessage(m: A2AMessage, recipient: string) {
  db.query("INSERT INTO messages (id, task_id, recipient, data, created_at) VALUES (?, ?, ?, ?, ?)").run(
    m.messageId,
    m.taskId ?? null,
    recipient,
    JSON.stringify(m),
    m.metadata?.createdAt ?? Date.now(),
  );
}

export function unreadFor(recipient: string): A2AMessage[] {
  return db
    .query<{ data: string }, [string]>("SELECT data FROM messages WHERE recipient = ? AND read_at IS NULL ORDER BY created_at")
    .all(recipient)
    .map((r) => JSON.parse(r.data));
}

export function markRead(ids: string[]) {
  const q = db.query("UPDATE messages SET read_at = ? WHERE id = ?");
  const now = Date.now();
  db.transaction(() => ids.forEach((id) => q.run(now, id)))();
}

export function recentMessages(limit = 400): A2AMessage[] {
  return db
    .query<{ data: string }, [number]>("SELECT data FROM messages ORDER BY created_at DESC LIMIT ?")
    .all(limit)
    .map((r) => JSON.parse(r.data))
    .reverse();
}

// ---------- settings ----------

export function getSettings(): Settings {
  const rows = db.query<{ key: string; value: string }, []>("SELECT key, value FROM settings").all();
  const map = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  return {
    workspaceDir: map.workspaceDir ?? process.env.AOS_WORKSPACE ?? `${ROOT}/workspace`,
    yoloAll: map.yoloAll ?? false,
    autopilot: map.autopilot ?? true,
    nudgeAfterSec: map.nudgeAfterSec ?? 90,
  };
}

export function saveSettings(patch: Partial<Settings>) {
  const q = db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  for (const [k, v] of Object.entries(patch)) q.run(k, JSON.stringify(v));
  return getSettings();
}
