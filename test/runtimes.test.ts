import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { PermissionMode, Persona } from "../src/shared/types";
import type { LaunchContext, Runtime } from "../src/server/runtimes";

let RUNTIMES: Record<string, Runtime>;
let DEFAULT_PERSONAS: Persona[];
const dir = mkdtempSync(`${tmpdir()}/aos-runtimes-`);

beforeAll(async () => {
  // runtimes.ts pulls in the store, which opens a database: keep it out of ./data.
  process.env.AOS_DATA_DIR = `${dir}/data`;
  process.env.AOS_CODEX_BIN = "/usr/local/bin/codex";
  ({ RUNTIMES } = await import("../src/server/runtimes"));
  ({ DEFAULT_PERSONAS } = await import("../src/server/default-personas"));
});

function ctx(permissionMode: PermissionMode, model = ""): LaunchContext {
  const persona = { ...DEFAULT_PERSONAS.find((p) => p.id === "sde")!, runtime: "codex" as const, model };
  return {
    persona,
    sessionId: "sde-7",
    label: persona.name,
    cwd: "/work/space",
    sessionDir: dir,
    systemPrompt: "role",
    systemPromptFile: `${dir}/role.md`,
    permissionMode,
    portalUrl: "http://127.0.0.1:4777",
    token: "tok-123",
  };
}

/** Read `-c key=value` overrides the way Codex does: the value is TOML. */
function overrides(cmd: string[]) {
  const out: Record<string, unknown> = {};
  cmd.forEach((a, i) => {
    if (a !== "-c") return;
    const kv = cmd[i + 1]!;
    const eq = kv.indexOf("=");
    out[kv.slice(0, eq)] = (Bun.TOML.parse(`v = ${kv.slice(eq + 1)}`) as { v: unknown }).v;
  });
  return out;
}

describe("codex runtime", () => {
  test("yolo skips approvals and the sandbox, and nothing else", async () => {
    const { cmd } = await RUNTIMES.codex!.build(ctx("yolo"));
    expect(cmd[0]).toBe("/usr/local/bin/codex");
    expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(cmd).not.toContain("--sandbox");
    expect(cmd).not.toContain("--ask-for-approval");
    expect(cmd).not.toContain("--full-auto"); // removed from Codex; passing it makes the CLI exit
  });

  test("acceptEdits maps to workspace-write with on-request approvals", async () => {
    const { cmd } = await RUNTIMES.codex!.build(ctx("acceptEdits"));
    expect(cmd.join(" ")).toContain("--sandbox workspace-write --ask-for-approval on-request");
    expect(cmd).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(cmd).not.toContain("--full-auto");
  });

  test("default mode adds no permission flags", async () => {
    const { cmd } = await RUNTIMES.codex!.build(ctx("default"));
    for (const f of ["--sandbox", "--ask-for-approval", "--dangerously-bypass-approvals-and-sandbox", "--full-auto"]) expect(cmd).not.toContain(f);
  });

  test("the a2a MCP server is configured through TOML overrides Codex can parse", async () => {
    const { cmd } = await RUNTIMES.codex!.build(ctx("yolo"));
    const o = overrides(cmd);
    expect(o["mcp_servers.a2a.command"]).toBe(process.execPath);
    expect(o["mcp_servers.a2a.args"]).toEqual([
      "run",
      expect.stringMatching(/src\/mcp\/a2a-mcp\.ts$/),
      "--url",
      "http://127.0.0.1:4777",
      "--session",
      "sde-7",
      "--token",
      "tok-123",
    ]);
    // wait_for_task blocks for minutes; Codex's default tool timeout would cut it off.
    expect(o["mcp_servers.a2a.tool_timeout_sec"]).toBe(900);
  });

  test("working dir, model and the kickoff prompt", async () => {
    const { cmd } = await RUNTIMES.codex!.build(ctx("yolo", "gpt-5-codex"));
    expect(cmd.slice(cmd.indexOf("--cd"), cmd.indexOf("--cd") + 2)).toEqual(["--cd", "/work/space"]);
    expect(cmd.slice(cmd.indexOf("--model"), cmd.indexOf("--model") + 2)).toEqual(["--model", "gpt-5-codex"]);
    // Codex has no system-prompt flag: the kickoff prompt is the positional argument, and must be last.
    expect(cmd.at(-1)).toContain(`${dir}/role.md`);
    expect(cmd.at(-1)).toContain("check_inbox");
  });
});
