import { APP_NAME } from "../shared/brand";
import { accessSync, constants, mkdirSync } from "node:fs";
import { Terminal as Screen } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import type { Activity, Persona, SessionInfo } from "../shared/types";
import { emit, publishTerminal } from "./bus";
import { buildSystemPrompt } from "./prompt";
import { RUNTIMES } from "./runtimes";
import { DATA_DIR, getPersona, getSettings, getTeam, listStoredSessions, saveSession } from "./store";

const COLS = 120;
const ROWS = 36;
const QUIET_MS = 1500; // screen must be still this long before we type into it
const MAX_HOLD_MS = 120_000; // deliver to a busy agent after this long anyway; CLIs queue typed input

/** Screen text that means a person has to answer something in this terminal. */
const ATTENTION = [
  /Do you trust the files/i,
  /Yes, I trust this folder/i,
  /Bypass Permissions mode/i,
  /Do you want to (proceed|make this edit|create|allow|run)/i,
  /Would you like to (run|make|allow)/i,
  /Allow (command|this|once|always)\b/i,
  /Press Enter to continue/i,
  /Enter to (confirm|select|continue)/i,
  // Codex: "Trust this folder?" and other menus ("› 1. …", "enter continue · esc quit")
  /Trust this (folder|directory)/i,
  /enter (to )?continue\s*·\s*esc/i,
  // Selection menus, marked ❯ (Claude Code) or › (Codex). Typing into one can pick an option, even Quit.
  /^\s*[❯›]\s*(\d+\.|Yes\b|No\b)/m,
  /\((y\/n|Y\/n|y\/N)\)/,
  /approval required/i,
];
/** No credentials: the agent can't do anything until someone logs in. Answering "Accept" won't help. */
const LOGIN = [/Not logged in\s*·\s*Run \/login/i, /Sign in with ChatGPT/i];
/** If the input box hasn't shown up after this long, stop waiting for it and deliver anyway. */
const READY_TIMEOUT_MS = 30_000;
const WORKING = /esc (to )?(interrupt|cancel)|ctrl\+c to (interrupt|cancel)/i;

interface Live {
  info: SessionInfo;
  token: string;
  proc?: Bun.Subprocess;
  term?: Bun.Terminal;
  screen: Screen;
  serializer: SerializeAddon;
  queue: { text: string; since: number }[];
  lastOutput: number;
  startedAt: number;
  sawOutput: boolean;
  /** Screen text showing the CLI's input box is up; nothing is typed before it appears. */
  readyPattern?: RegExp;
  ready: boolean;
}

const live = new Map<string, Live>();
let portalUrl = "http://127.0.0.1:4777";
const exitHandlers: ((s: SessionInfo) => void)[] = [];

export function configureSessions(url: string) {
  portalUrl = url;
  // Anything that was running when the server last stopped is gone now.
  for (const s of listStoredSessions()) {
    if (s.activity !== "exited") saveSession({ ...s, activity: "exited", endedAt: s.endedAt ?? Date.now(), pendingDeliveries: 0 });
  }
  setInterval(tick, 700);
}

export function onSessionExit(fn: (s: SessionInfo) => void) {
  exitHandlers.push(fn);
}

export function listSessions(): SessionInfo[] {
  const stored = listStoredSessions().filter((s) => !live.has(s.id));
  const recentExited = stored.filter((s) => (s.endedAt ?? 0) > Date.now() - 24 * 3600_000);
  return [...[...live.values()].map((l) => l.info), ...recentExited].sort((a, b) => a.createdAt - b.createdAt);
}

export function getSession(id: string): SessionInfo | undefined {
  return live.get(id)?.info ?? listStoredSessions().find((s) => s.id === id);
}

/** Running sessions, optionally only one team's, or one persona's within a team. */
export function runningSessions(teamId?: string, personaId?: string): SessionInfo[] {
  return [...live.values()]
    .map((l) => l.info)
    .filter((s) => s.activity !== "exited" && (!teamId || s.teamId === teamId) && (!personaId || s.personaId === personaId));
}

/**
 * Our environment minus the markers a parent coding agent sets, so an agent started while the
 * portal itself runs inside Claude Code doesn't think it is a sub-session of it.
 */
const PARENT_MARKERS = new Set(["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT"]);
function agentEnv() {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || PARENT_MARKERS.has(k)) continue;
    if (/^CLAUDE_CODE_(ENTRYPOINT|MESSAGING_|BRIDGE_|EXECPATH|SESSION_|CHILD_SESSION)/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

/** "<team>.<persona>-<n>": unique across teams, and still readable for agents addressing a teammate. */
function nextSessionId(teamId: string, personaId: string) {
  const prefix = `${teamId}.${personaId}-`;
  const used = listStoredSessions()
    .filter((s) => s.id.startsWith(prefix))
    .map((s) => Number(s.id.slice(prefix.length)) || 0);
  return `${prefix}${Math.max(0, ...used) + 1}`;
}

export async function spawnSession(teamId: string, personaId: string, spawnedBy: string): Promise<SessionInfo> {
  const team = getTeam(teamId);
  if (!team) throw new Error(`Unknown team "${teamId}"`);
  const persona = getPersona(teamId, personaId);
  if (!persona) throw new Error(`${team.name} has no persona "${personaId}"`);
  const running = runningSessions(teamId, personaId);
  if (running.length >= persona.maxInstances) {
    throw new Error(`${persona.name} already has ${running.length} of ${persona.maxInstances} sessions running`);
  }
  const runtime = RUNTIMES[persona.runtime];
  if (!runtime?.binary()) throw new Error(`${runtime?.name ?? persona.runtime} is not installed (set AOS_${persona.runtime.toUpperCase()}_BIN)`);

  const settings = getSettings();
  const cwd = team.workspaceDir;
  try {
    mkdirSync(cwd, { recursive: true });
    accessSync(cwd, constants.W_OK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM" && code !== "EROFS") throw e;
    // Typically a host folder bind-mounted into Docker that the container's user (uid 1000) can't write.
    throw new Error(
      `${team.name}'s folder ${cwd} isn't writable (${code}). If it's a folder mounted from the host, give it to uid 1000: sudo chown -R 1000:1000 <host folder>. Or change the team's folder in its settings.`,
    );
  }
  const id = nextSessionId(teamId, personaId);
  const sessionDir = `${DATA_DIR}/sessions/${id}`;
  mkdirSync(sessionDir, { recursive: true });
  const token = crypto.randomUUID();
  const systemPrompt = buildSystemPrompt(team, persona, id);
  const systemPromptFile = `${sessionDir}/role.md`;
  await Bun.write(systemPromptFile, systemPrompt);
  const permissionMode = settings.yoloAll ? "yolo" : persona.permissionMode;

  const spec = await runtime.build({
    persona,
    sessionId: id,
    label: persona.name,
    cwd,
    sessionDir,
    systemPrompt,
    systemPromptFile,
    permissionMode,
    portalUrl,
    token,
  });

  const info: SessionInfo = {
    id,
    teamId,
    personaId,
    label: `${persona.name} ${id.split("-").at(-1)}`,
    runtime: persona.runtime,
    cwd,
    activity: "starting",
    pendingDeliveries: 0,
    spawnedBy,
    createdAt: Date.now(),
  };
  const screen = new Screen({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 2000 });
  const serializer = new SerializeAddon();
  screen.loadAddon(serializer as any);
  const l: Live = { info, token, screen, serializer, queue: [], lastOutput: Date.now(), startedAt: Date.now(), sawOutput: false, ready: false };
  live.set(id, l);
  saveSession(info, token);
  await Bun.write(`${sessionDir}/command.json`, JSON.stringify(spec.cmd.map((a) => (a === systemPrompt ? "<role.md>" : a)), null, 2));

  l.proc = Bun.spawn(spec.cmd, {
    cwd,
    env: { ...agentEnv(), ...spec.env, AOS_SESSION_ID: id, AOS_PORTAL_URL: portalUrl, TERM: "xterm-256color", COLORTERM: "truecolor" },
    terminal: {
      cols: COLS,
      rows: ROWS,
      data(_t, data) {
        l.lastOutput = Date.now();
        l.sawOutput = true;
        l.screen.write(data);
        publishTerminal(id, data);
      },
    },
    onExit(_p, exitCode) {
      l.info = { ...l.info, activity: "exited", endedAt: Date.now(), exitCode, pendingDeliveries: 0 };
      saveSession(l.info);
      emit({ type: "session", session: l.info });
      const msg = `\r\n\x1b[2m[${APP_NAME}] session exited with code ${exitCode}\x1b[0m\r\n`;
      l.screen.write(msg);
      publishTerminal(id, new TextEncoder().encode(msg));
      for (const h of exitHandlers) h(l.info);
    },
  });
  l.term = l.proc.terminal;
  emit({ type: "session", session: info });
  l.readyPattern = spec.ready;
  if (spec.firstInput) notify(id, spec.firstInput);
  return info;
}

export function stopSession(id: string) {
  const l = live.get(id);
  if (!l?.proc || l.info.activity === "exited") return false;
  l.proc.kill("SIGTERM");
  setTimeout(() => l.info.activity !== "exited" && l.proc?.kill("SIGKILL"), 4000);
  return true;
}

/** Drop an exited session's screen from memory. */
export function forgetSession(id: string) {
  const l = live.get(id);
  if (l && l.info.activity === "exited") {
    l.screen.dispose();
    live.delete(id);
  }
}

export function writeInput(id: string, data: string | Uint8Array) {
  const l = live.get(id);
  if (l?.term && !l.term.closed) l.term.write(data);
}

export function resizeSession(id: string, cols: number, rows: number) {
  const l = live.get(id);
  if (!l?.term || l.term.closed || cols < 20 || rows < 5) return;
  l.term.resize(cols, rows);
  l.screen.resize(cols, rows);
}

/** Current screen as an ANSI string a fresh xterm can replay. */
export function screenSnapshot(id: string, scrollback = 1000): { data: string; cols: number; rows: number } | null {
  const l = live.get(id);
  if (!l) return null;
  return { data: l.serializer.serialize({ scrollback }), cols: l.screen.cols, rows: l.screen.rows };
}

export function tokenOwner(token: string): string | undefined {
  for (const l of live.values()) if (l.token === token) return l.info.id;
  return undefined;
}

/** Queue a one-line notice to be typed into the agent's prompt once it is idle. */
export function notify(id: string, text: string) {
  const l = live.get(id);
  if (!l || l.info.activity === "exited") return false;
  const line = text.replace(/[\r\n]+/g, " ");
  // One pending notice is enough: it tells the agent to read its whole inbox.
  if (!l.queue.some((q) => q.text === line)) l.queue.push({ text: line, since: Date.now() });
  update(l, { pendingDeliveries: l.queue.length });
  return true;
}

function visibleText(screen: Screen) {
  const buf = screen.buffer.active;
  const out: string[] = [];
  for (let i = buf.viewportY; i < buf.viewportY + screen.rows; i++) out.push(buf.getLine(i)?.translateToString(true) ?? "");
  return out;
}

function update(l: Live, patch: Partial<SessionInfo>) {
  const next = { ...l.info, ...patch };
  if (JSON.stringify(next) === JSON.stringify(l.info)) return;
  l.info = next;
  saveSession(next);
  emit({ type: "session", session: next });
}

function tick() {
  const now = Date.now();
  for (const l of live.values()) {
    if (l.info.activity === "exited") continue;
    const lines = visibleText(l.screen);
    const text = lines.join("\n");
    let activity: Activity;
    let attentionText: string | undefined;
    let attentionKind: SessionInfo["attentionKind"];
    // Keystrokes sent while a TUI is still booting are lost, so wait until its input box is on screen.
    if (!l.ready && l.sawOutput && now - l.startedAt >= 2500) {
      l.ready = !l.readyPattern || l.readyPattern.test(text) || now - l.startedAt > READY_TIMEOUT_MS;
    }
    const login = LOGIN.find((re) => re.test(text));
    const hit = login ?? ATTENTION.find((re) => re.test(text));
    if (hit) {
      activity = "attention";
      attentionKind = login ? "login" : "prompt";
      // The line that matched, or just the matched phrase when it sits in a long status line.
      const line = lines.find((l) => hit.test(l))?.trim() ?? "";
      attentionText = (line.length > 90 ? (line.match(hit)?.[0] ?? line) : line).slice(0, 140);
    } else if (!l.ready) {
      activity = "starting";
    } else if (WORKING.test(text) || now - l.lastOutput < 900) {
      activity = "working";
    } else {
      activity = "idle";
    }
    update(l, { activity, attentionText, attentionKind, idleSince: activity === "idle" ? (l.info.idleSince ?? now) : undefined });

    const next = l.queue[0];
    if (!next || activity === "attention" || activity === "starting") continue;
    const quiet = now - l.lastOutput > QUIET_MS;
    if ((activity === "idle" && quiet) || now - next.since > MAX_HOLD_MS) {
      l.queue.shift();
      l.term?.write(next.text);
      // Enter as its own write so TUIs don't treat it as part of a paste.
      setTimeout(() => l.term?.write("\r"), 200);
      l.lastOutput = now;
      update(l, { pendingDeliveries: l.queue.length });
    }
  }
}

export function personaOf(sessionId: string): Persona | undefined {
  const s = getSession(sessionId);
  return s ? getPersona(s.teamId, s.personaId) : undefined;
}
