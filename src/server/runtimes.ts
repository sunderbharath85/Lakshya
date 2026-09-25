import { APP_NAME } from "../shared/brand";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { Persona, PermissionMode, RuntimeId } from "../shared/types";
import { ROOT } from "./store";

/** Everything a runtime needs to start one agent session. */
export interface LaunchContext {
  persona: Persona;
  sessionId: string;
  label: string;
  cwd: string;
  sessionDir: string;
  systemPromptFile: string;
  systemPrompt: string;
  permissionMode: PermissionMode;
  portalUrl: string;
  token: string;
}

export interface LaunchSpec {
  cmd: string[];
  env: Record<string, string>;
  /** Typed into the TUI once it is idle, for CLIs that cannot take a submitted first prompt. */
  firstInput?: string;
}

export interface Runtime {
  id: RuntimeId;
  name: string;
  binary: () => string | null;
  build: (ctx: LaunchContext) => Promise<LaunchSpec>;
}

const MCP_ENTRY = `${ROOT}/src/mcp/a2a-mcp.ts`;

function find(bin: string, fallbacks: string[]) {
  const override = process.env[`AOS_${bin.toUpperCase()}_BIN`];
  if (override) return override;
  return Bun.which(bin) ?? fallbacks.map((f) => f.replace("~", homedir())).find((f) => existsSync(f)) ?? null;
}

/** Extra CLI flags from the environment, e.g. AOS_CLAUDE_ARGS="--verbose". */
function extraArgs(runtime: RuntimeId) {
  return (process.env[`AOS_${runtime.toUpperCase()}_ARGS`] ?? "").split(" ").filter(Boolean);
}

/** The stdio MCP bridge every agent gets: its tools are how agents speak A2A. */
function mcpCommand(ctx: LaunchContext) {
  return [process.execPath, "run", MCP_ENTRY, "--url", ctx.portalUrl, "--session", ctx.sessionId, "--token", ctx.token];
}

/** First prompt for CLIs that have no flag for appending a system prompt. */
function kickoff(ctx: LaunchContext) {
  return `You are ${ctx.persona.name} (session ${ctx.sessionId}) in a ${APP_NAME} team. Your role, rules and the team protocol are in ${ctx.systemPromptFile}. Read that file now and follow it for this whole session. Then call the a2a check_inbox tool.`;
}

const claude: Runtime = {
  id: "claude",
  name: "Claude Code",
  binary: () => find("claude", ["~/.local/bin/claude", "~/.claude/local/claude"]),
  async build(ctx) {
    const [command, ...args] = mcpCommand(ctx);
    const mcpFile = `${ctx.sessionDir}/mcp.json`;
    await Bun.write(mcpFile, JSON.stringify({ mcpServers: { a2a: { type: "stdio", command, args } } }, null, 2));
    const cmd = [
      claude.binary()!,
      "--append-system-prompt",
      ctx.systemPrompt,
      "--mcp-config",
      mcpFile,
      "--allowedTools",
      "mcp__a2a",
    ];
    if (ctx.persona.model) cmd.push("--model", ctx.persona.model);
    if (ctx.permissionMode === "yolo") cmd.push("--dangerously-skip-permissions");
    else if (ctx.permissionMode === "acceptEdits") cmd.push("--permission-mode", "acceptEdits");
    cmd.push(...extraArgs("claude"));
    // wait_for_task can block for minutes
    return { cmd, env: { MCP_TOOL_TIMEOUT: "900000" } };
  },
};

const codex: Runtime = {
  id: "codex",
  name: "Codex",
  binary: () => find("codex", ["~/.local/bin/codex", "/opt/homebrew/bin/codex"]),
  async build(ctx) {
    const [command, ...args] = mcpCommand(ctx);
    const cmd = [
      codex.binary()!,
      "--cd",
      ctx.cwd,
      "-c",
      `mcp_servers.a2a.command=${JSON.stringify(command)}`,
      "-c",
      `mcp_servers.a2a.args=${JSON.stringify(args)}`,
      "-c",
      "mcp_servers.a2a.tool_timeout_sec=900",
    ];
    if (ctx.persona.model) cmd.push("--model", ctx.persona.model);
    if (ctx.permissionMode === "yolo") cmd.push("--dangerously-bypass-approvals-and-sandbox");
    else if (ctx.permissionMode === "acceptEdits") cmd.push("--full-auto");
    cmd.push(...extraArgs("codex"), kickoff(ctx));
    return { cmd, env: {} };
  },
};

const opencode: Runtime = {
  id: "opencode",
  name: "OpenCode",
  binary: () => find("opencode", ["~/.opencode/bin/opencode"]),
  async build(ctx) {
    const config: Record<string, unknown> = {
      $schema: "https://opencode.ai/config.json",
      instructions: [ctx.systemPromptFile],
      mcp: { a2a: { type: "local", command: mcpCommand(ctx), enabled: true, timeout: 900000 } },
    };
    if (ctx.persona.model) config.model = ctx.persona.model;
    const configFile = `${ctx.sessionDir}/opencode.json`;
    await Bun.write(configFile, JSON.stringify(config, null, 2));
    // --standalone gives each agent a private server, so this session's config and env stay its own.
    const cmd = [opencode.binary()!, "--standalone"];
    if (ctx.permissionMode === "yolo") cmd.push("--auto");
    cmd.push(...extraArgs("opencode"), ctx.cwd);
    // --prompt only prefills the input box in OpenCode v2, so the kickoff is typed in instead.
    return { cmd, env: { OPENCODE_CONFIG: configFile, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }, firstInput: kickoff(ctx) };
  },
};

export const RUNTIMES: Record<RuntimeId, Runtime> = { claude, codex, opencode };

export function runtimeAvailability() {
  return Object.values(RUNTIMES).map((r) => ({ id: r.id, name: r.name, path: r.binary() }));
}
