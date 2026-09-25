import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { A2AMessage, A2ATask, Persona, SessionInfo, Settings, Team } from "../shared/types";
import { DEFAULT_PERSONAS } from "./default-personas";

export const ROOT = resolve(import.meta.dir, "../..");
export const DATA_DIR = resolve(process.env.AOS_DATA_DIR ?? `${ROOT}/data`);
/** New teams get a folder here, named after the team. */
export const WORKSPACES_ROOT = resolve(process.env.AOS_WORKSPACE ?? `${ROOT}/workspace`);
export const MAIN_TEAM = "main";
mkdirSync(DATA_DIR, { recursive: true });

const dbPath = `${DATA_DIR}/agentic-os.sqlite`;
mkdirSync(dirname(dbPath), { recursive: true });
export const db = new Database(dbPath, { create: true, strict: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, data TEXT NOT NULL, position INTEGER NOT NULL);
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
migrate();

export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;

/**
 * Before teams, personas were keyed by id alone and there was one workspace. That setup becomes the
 * "main" team, keeping its folder, so existing files and history stay where they were.
 */
function migrate() {
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(personas)").all().map((c) => c.name);
  const hadData = cols.length > 0 || db.query<{ n: number }, []>("SELECT count(*) AS n FROM tasks").get()!.n > 0;

  if (cols.length === 0) {
    db.exec("CREATE TABLE personas (team_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (team_id, id))");
  } else if (!cols.includes("team_id")) {
    db.transaction(() => {
      db.exec("CREATE TABLE personas_v2 (team_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (team_id, id))");
      db.exec(`INSERT INTO personas_v2 SELECT '${MAIN_TEAM}', id, json_set(data, '$.teamId', '${MAIN_TEAM}'), position FROM personas`);
      db.exec("DROP TABLE personas");
      db.exec("ALTER TABLE personas_v2 RENAME TO personas");
    })();
  }

  if (!getTeam(MAIN_TEAM)) {
    const old = db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'workspaceDir'").get();
    // An upgraded install keeps working in the folder it used; a fresh one gets <root>/main like any team.
    const workspaceDir = old ? JSON.parse(old.value) : hadData ? WORKSPACES_ROOT : join(WORKSPACES_ROOT, MAIN_TEAM);
    saveTeam({ id: MAIN_TEAM, name: "Main", workspaceDir, createdAt: Date.now() });
  }
  if (listPersonas(MAIN_TEAM).length === 0) seedPersonas(MAIN_TEAM);
}

// ---------- teams ----------

export function listTeams(): Team[] {
  return db
    .query<{ data: string }, []>("SELECT data FROM teams ORDER BY position")
    .all()
    .map((r) => JSON.parse(r.data));
}

export function getTeam(id: string): Team | undefined {
  const r = db.query<{ data: string }, [string]>("SELECT data FROM teams WHERE id = ?").get(id);
  return r ? JSON.parse(r.data) : undefined;
}

export function saveTeam(t: Team) {
  const pos =
    db.query<{ position: number }, [string]>("SELECT position FROM teams WHERE id = ?").get(t.id)?.position ??
    db.query<{ n: number }, []>("SELECT coalesce(max(position), -1) + 1 AS n FROM teams").get()!.n;
  db.query("INSERT OR REPLACE INTO teams (id, data, position) VALUES (?, ?, ?)").run(t.id, JSON.stringify(t), pos);
}

/** Remove a team with its personas, tasks and messages. Its folder on disk is left alone. */
export function deleteTeam(id: string) {
  const taskIds = listTasks(100_000, id).map((t) => t.id);
  db.transaction(() => {
    db.query("DELETE FROM personas WHERE team_id = ?").run(id);
    const delTask = db.query("DELETE FROM tasks WHERE id = ?");
    const delMsgs = db.query("DELETE FROM messages WHERE task_id = ?");
    for (const t of taskIds) {
      delTask.run(t);
      delMsgs.run(t);
    }
    db.query("DELETE FROM teams WHERE id = ?").run(id);
  })();
}

// ---------- personas ----------

/** Give a team its personas: the defaults, or copies of another team's. */
export function seedPersonas(teamId: string, from?: Persona[]) {
  const source = from ?? DEFAULT_PERSONAS;
  db.transaction(() => {
    db.query("DELETE FROM personas WHERE team_id = ?").run(teamId);
    source.forEach((p, i) => savePersona({ ...structuredClone(p), teamId } as Persona, i));
  })();
}

/** Personas of one team, or of every team. */
export function listPersonas(teamId?: string): Persona[] {
  const rows = teamId
    ? db.query<{ data: string }, [string]>("SELECT data FROM personas WHERE team_id = ? ORDER BY position").all(teamId)
    : db.query<{ data: string }, []>("SELECT data FROM personas ORDER BY team_id, position").all();
  return rows.map((r) => JSON.parse(r.data));
}

export function getPersona(teamId: string, id: string): Persona | undefined {
  const r = db.query<{ data: string }, [string, string]>("SELECT data FROM personas WHERE team_id = ? AND id = ?").get(teamId, id);
  return r ? JSON.parse(r.data) : undefined;
}

export function savePersona(p: Persona, position?: number) {
  const pos =
    position ??
    db.query<{ position: number }, [string, string]>("SELECT position FROM personas WHERE team_id = ? AND id = ?").get(p.teamId, p.id)?.position ??
    db.query<{ n: number }, [string]>("SELECT coalesce(max(position), -1) + 1 AS n FROM personas WHERE team_id = ?").get(p.teamId)!.n;
  db.query("INSERT OR REPLACE INTO personas (team_id, id, data, position) VALUES (?, ?, ?, ?)").run(p.teamId, p.id, JSON.stringify(p), pos);
}

export function deletePersona(teamId: string, id: string) {
  db.query("DELETE FROM personas WHERE team_id = ? AND id = ?").run(teamId, id);
}

// ---------- sessions ----------

export function saveSession(s: SessionInfo, token?: string) {
  if (token) {
    db.query("INSERT OR REPLACE INTO sessions (id, data, token) VALUES (?, ?, ?)").run(s.id, JSON.stringify(s), token);
  } else {
    db.query("UPDATE sessions SET data = ? WHERE id = ?").run(JSON.stringify(s), s.id);
  }
}

export function listStoredSessions(): SessionInfo[] {
  return db
    .query<{ data: string }, []>("SELECT data FROM sessions")
    .all()
    .map((r) => ({ teamId: MAIN_TEAM, ...JSON.parse(r.data) }));
}

// ---------- tasks & messages ----------

/** Tasks from before teams belong to the main team. */
function parseTask(data: string): A2ATask {
  const t: A2ATask = JSON.parse(data);
  t.metadata.team ??= MAIN_TEAM;
  return t;
}

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
  const t = parseTask(r.data);
  if (withHistory) t.history = taskHistory(id);
  return t;
}

/** Newest first; one team's tasks, or every team's. */
export function listTasks(limit = 300, teamId?: string): A2ATask[] {
  const tasks = db
    .query<{ data: string }, []>("SELECT data FROM tasks ORDER BY updated_at DESC")
    .all()
    .map((r) => parseTask(r.data));
  return (teamId ? tasks.filter((t) => t.metadata.team === teamId) : tasks).slice(0, limit);
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

const SETTING_KEYS = ["yoloAll", "autopilot", "nudgeAfterSec"] as const;

export function getSettings(): Settings {
  const rows = db.query<{ key: string; value: string }, []>("SELECT key, value FROM settings").all();
  const map = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  return {
    workspacesRoot: WORKSPACES_ROOT,
    yoloAll: map.yoloAll ?? false,
    autopilot: map.autopilot ?? true,
    nudgeAfterSec: map.nudgeAfterSec ?? 90,
  };
}

export function saveSettings(patch: Partial<Settings>) {
  const q = db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  for (const k of SETTING_KEYS) if (patch[k] !== undefined) q.run(k, JSON.stringify(patch[k]));
  return getSettings();
}
