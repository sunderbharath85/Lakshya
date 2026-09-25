// Types shared by the server, the MCP bridge and the web UI.

export type RuntimeId = "claude" | "codex" | "opencode";
/** yolo = skip every approval prompt (claude --dangerously-skip-permissions, codex --yolo, opencode --auto). */
export type PermissionMode = "default" | "acceptEdits" | "yolo";

export interface Skill {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export interface Persona {
  id: string;
  name: string;
  /** 1-3 letter code shown in the slim sidebar. */
  short?: string;
  title: string;
  color: string;
  description: string;
  runtime: RuntimeId;
  /** Model passed to the CLI; empty means the CLI's default. */
  model: string;
  permissionMode: PermissionMode;
  /** Role prompt appended to the agent's system prompt. */
  instructions: string;
  rules: string[];
  /** Persona ids this persona may open tasks with. "*" means everyone. */
  canTalkTo: string[];
  /** May start new sessions of other personas. */
  canSpawn: boolean;
  /** Coordinates the team; gets task-board tools. */
  orchestrator: boolean;
  /** Receives requests typed into the portal's request bar. */
  entry: boolean;
  maxInstances: number;
  skills: Skill[];
}

/** idle: waiting at its prompt. working: busy. attention: showing a prompt a person must answer. */
export type Activity = "starting" | "idle" | "working" | "attention" | "exited";

export interface SessionInfo {
  id: string;
  personaId: string;
  label: string;
  runtime: RuntimeId;
  cwd: string;
  activity: Activity;
  attentionText?: string;
  pendingDeliveries: number;
  /** When the agent last went idle at its prompt. */
  idleSince?: number;
  spawnedBy: string;
  createdAt: number;
  endedAt?: number;
  exitCode?: number | null;
}

// ---- A2A (Agent2Agent protocol v0.3) ----

export type TaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "canceled"
  | "failed"
  | "rejected";

export const TERMINAL_STATES: TaskState[] = ["completed", "canceled", "failed", "rejected"];

export interface TextPart {
  kind: "text";
  text: string;
}
export type Part = TextPart | { kind: "data"; data: unknown } | { kind: "file"; file: { name?: string; uri?: string; mimeType?: string } };

export interface A2AMessage {
  kind: "message";
  messageId: string;
  role: "user" | "agent";
  parts: Part[];
  taskId?: string;
  contextId?: string;
  metadata?: { from?: string; to?: string; createdAt?: number; [k: string]: unknown };
}

export interface Artifact {
  artifactId: string;
  name?: string;
  parts: Part[];
}

export interface A2ATask {
  kind: "task";
  id: string;
  contextId: string;
  status: { state: TaskState; message?: A2AMessage; timestamp: string };
  history?: A2AMessage[];
  artifacts?: Artifact[];
  metadata: {
    title: string;
    /** "user", "external" or a session id */
    from: string;
    /** session id of the executor */
    to: string;
    toPersona: string;
    createdAt: number;
    updatedAt: number;
  };
}

export interface Settings {
  workspaceDir: string;
  /** Forces yolo mode on every agent started from now on. */
  yoloAll: boolean;
  /** Supervisor loop: re-prompt idle agents that still owe work. */
  autopilot: boolean;
  /** How long an agent may sit idle on an open task before it is re-prompted. */
  nudgeAfterSec: number;
}

export type ServerEvent =
  | { type: "snapshot"; personas: Persona[]; sessions: SessionInfo[]; tasks: A2ATask[]; messages: A2AMessage[]; settings: Settings }
  | { type: "personas"; personas: Persona[] }
  | { type: "session"; session: SessionInfo }
  | { type: "task"; task: A2ATask }
  | { type: "message"; message: A2AMessage }
  | { type: "settings"; settings: Settings };

export function textOf(parts: Part[] | undefined): string {
  return (parts ?? [])
    .map((p) => (p.kind === "text" ? p.text : p.kind === "data" ? JSON.stringify(p.data) : `[file ${p.file.name ?? p.file.uri ?? ""}]`))
    .join("\n");
}
