import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { PermissionMode, Persona } from "../src/shared/types";
import type { LaunchContext, Runtime } from "../src/server/runtimes";

let RUNTIMES: Record<string, Runtime>;
let DEFAULT_PERSONAS: Omit<Persona, "teamId">[];
const dir = mkdtempSync(`${tmpdir()}/aos-runtimes-`);

beforeAll(async () => {
  // runtimes.ts pulls in the store, which opens a database: keep it out of ./data.
  process.env.AOS_DATA_DIR = `${dir}/data`;
  process.env.AOS_CODEX_BIN = "/usr/local/bin/codex";
  ({ RUNTIMES } = await import("../src/server/runtimes"));
  ({ DEFAULT_PERSONAS } = await import("../src/server/default-personas"));
});

function ctx(permissionMode: PermissionMode, model = ""): LaunchContext {
  const persona: Persona = { ...DEFAULT_PERSONAS.find((p) => p.id === "sde")!, teamId: "main", runtime: "codex" as const, model };
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

describe("opencode runtime", () => {
  /** A stand-in binary that only answers --version, like OpenCode 1.x ("1.18.32") or 2.x ("opencode v2.0.12"). */
  async function stub(version: string) {
    const path = `${dir}/opencode-${version.replace(/\W/g, "_")}`;
    await Bun.write(path, `#!/bin/sh\necho "${version}"\n`);
    await Bun.$`chmod +x ${path}`;
    return path;
  }
  const build = async (bin: string, mode: PermissionMode) => {
    process.env.AOS_OPENCODE_BIN = bin;
    return RUNTIMES.opencode!.build({ ...ctx(mode), persona: { ...ctx(mode).persona, runtime: "opencode" } });
  };

  test("2.x gets a private server with --standalone", async () => {
    const { cmd } = await build(await stub("opencode v2.0.12"), "default");
    expect(cmd).toContain("--standalone");
  });

  test("1.x (what npm and the installer ship today) has no --standalone flag", async () => {
    const { cmd } = await build(await stub("1.18.32"), "default");
    expect(cmd).not.toContain("--standalone");
  });

  test("yolo is --auto; the MCP bridge and role file come through the config", async () => {
    const { cmd, env, firstInput } = await build(await stub("1.18.32"), "yolo");
    expect(cmd).toContain("--auto");
    expect(cmd.at(-1)).toBe("/work/space");
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
    expect(config.mcp.a2a.command).toEqual([process.execPath, "run", expect.stringMatching(/a2a-mcp\.ts$/), "--url", "http://127.0.0.1:4777", "--session", "sde-7", "--token", "tok-123"]);
    expect(config.instructions).toEqual([`${dir}/role.md`]);
    expect(firstInput).toContain("check_inbox");
  });
});

describe("codex folder trust", () => {
  test("recorded once per team folder when the deployment owns its folders, never otherwise", async () => {
    const home = `${dir}/codex-home`;
    await Bun.write(`${home}/config.toml`, 'model = "gpt-5"\n');
    process.env.CODEX_HOME = home;
    try {
      await RUNTIMES.codex!.build({ ...ctx("yolo"), cwd: "/workspace/mobile-app" });
      expect(await Bun.file(`${home}/config.toml`).text()).not.toContain("projects"); // AOS_TRUST_WORKSPACE unset

      process.env.AOS_TRUST_WORKSPACE = "1";
      await RUNTIMES.codex!.build({ ...ctx("yolo"), cwd: "/workspace/mobile-app" });
      await RUNTIMES.codex!.build({ ...ctx("yolo"), cwd: "/workspace/mobile-app" });
      await RUNTIMES.codex!.build({ ...ctx("yolo"), cwd: "/workspace/web" });
      const config = Bun.TOML.parse(await Bun.file(`${home}/config.toml`).text()) as any;
      expect(config.model).toBe("gpt-5");
      expect(config.projects).toEqual({ "/workspace/mobile-app": { trust_level: "trusted" }, "/workspace/web": { trust_level: "trusted" } });
    } finally {
      delete process.env.AOS_TRUST_WORKSPACE;
      delete process.env.CODEX_HOME;
    }
  });
});
