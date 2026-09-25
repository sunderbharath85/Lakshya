import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Codex personas in YOLO mode, end to end through the portal: spawn in a PTY, A2A task in,
// MCP bridge, update_task, result back to the requester.
//
//   bun test                         fake Codex (test/fake-codex.ts), no model calls
//   AOS_LIVE_CODEX=1 bun test        also drives the real `codex` CLI (needs `codex login`)

const servers: { proc: Bun.Subprocess; dir: string }[] = [];
afterAll(() => {
  for (const s of servers) {
    s.proc.kill();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

async function startServer(port: number, env: Record<string, string>) {
  const dir = mkdtempSync(`${tmpdir()}/aos-codex-`);
  const proc = Bun.spawn(["bun", "src/server/index.ts"], {
    env: { ...process.env, NODE_ENV: "production", AOS_PORT: String(port), AOS_DATA_DIR: `${dir}/data`, AOS_WORKSPACE: `${dir}/ws`, ...env },
    stdout: "ignore",
    stderr: "inherit",
  });
  servers.push({ proc, dir });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50 && !(await fetch(`${base}/api/state`).then((r) => r.ok, () => false)); i++) await Bun.sleep(100);

  const call = (path: string, method = "GET", body?: unknown) =>
    fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json() as Promise<any>);
  const screen = async (id: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/term/${id}`);
    let out = "";
    ws.onmessage = (e) => (out += typeof e.data === "string" ? JSON.parse(e.data).data : new TextDecoder().decode(e.data as ArrayBuffer));
    await Bun.sleep(300);
    ws.close();
    return out;
  };

  // The software engineer runs on Codex, and every new agent starts in YOLO mode.
  const sde = (await call("/api/personas")).find((p: any) => p.id === "sde");
  await call("/api/personas/sde", "PUT", { ...sde, runtime: "codex", permissionMode: "acceptEdits" });
  await call("/api/settings", "PUT", { yoloAll: true, autopilot: false });
  return { base, dir, call, screen };
}

/** Wait for a task to settle, failing fast if the agent gets stuck on a prompt only a person can answer. */
async function waitForTask(s: Awaited<ReturnType<typeof startServer>>, taskId: string, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  let stuckSince = 0;
  while (Date.now() < until) {
    const t = await s.call(`/api/tasks/${taskId}`);
    if (["completed", "failed", "canceled", "rejected", "input-required"].includes(t.status.state)) return t;
    const session = (await s.call("/api/state")).sessions.find((x: any) => x.id === t.metadata.to);
    if (session?.activity === "attention") {
      stuckSince ||= Date.now();
      if (Date.now() - stuckSince > 20_000) throw new Error(`${session.id} is waiting on a prompt in YOLO mode: ${session.attentionText}`);
    } else stuckSince = 0;
    await Bun.sleep(1000);
  }
  throw new Error(`task ${taskId} did not finish in ${timeoutMs / 1000}s`);
}

test("a Codex persona in YOLO mode takes an A2A task through its MCP bridge (fake codex)", async () => {
  const argvFile = `${tmpdir()}/fake-codex-argv-${process.pid}.json`;
  const s = await startServer(4798, { AOS_CODEX_BIN: `${import.meta.dir}/fake-codex.ts`, FAKE_CODEX_ARGV: argvFile });

  const task = await s.call("/api/request", "POST", { text: "Build the health endpoint", to: "sde" });
  expect(task.metadata.to).toBe("main.sde-1");
  const done = await waitForTask(s, task.id, 20_000);

  expect(done.status.state).toBe("completed");
  expect(done.artifacts[0].parts[0].text).toBe("done by fake codex (yolo=true)");
  const session = (await s.call("/api/state")).sessions.find((x: any) => x.id === "main.sde-1");
  expect(session.runtime).toBe("codex");

  // YOLO from Settings overrides the persona's own acceptEdits mode.
  const argv: string[] = JSON.parse(readFileSync(argvFile, "utf8"));
  expect(argv).toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(argv).not.toContain("--sandbox");
  rmSync(argvFile, { force: true });

  const screen = await s.screen("main.sde-1");
  expect(screen).toContain("fake codex ready (yolo=true");
  expect(screen).toContain("mcp tools: list_agents,send_message,check_inbox,update_task");
}, 30_000);

test("nothing is typed into Codex's trust menu; the task waits until a person answers it", async () => {
  const s = await startServer(4796, { AOS_CODEX_BIN: `${import.meta.dir}/fake-codex.ts`, FAKE_CODEX_TRUST: "1" });
  const task = await s.call("/api/request", "POST", { text: "Build the health endpoint", to: "sde" });

  // The session is flagged for a person and the [A2A] notice stays queued.
  let session: any;
  for (let i = 0; i < 40; i++) {
    session = (await s.call("/api/state")).sessions.find((x: any) => x.id === "main.sde-1");
    if (session?.activity === "attention") break;
    await Bun.sleep(250);
  }
  expect(session.activity).toBe("attention");
  expect(session.attentionText).toContain("Trust this folder");
  await Bun.sleep(2500);
  session = (await s.call("/api/state")).sessions.find((x: any) => x.id === "main.sde-1");
  expect(session.activity).toBe("attention");
  expect(session.pendingDeliveries).toBe(1);

  // The person accepts (the Accept button sends Enter); the notice is then delivered and the task completes.
  await s.call("/api/sessions/main.sde-1/input", "POST", { data: "\r" });
  const done = await waitForTask(s, task.id, 20_000);
  expect(done.status.state).toBe("completed");
}, 30_000);

test.skipIf(!process.env.AOS_LIVE_CODEX)(
  "the real Codex CLI in YOLO mode does the work and completes the task over A2A",
  async () => {
    // Codex only runs in folders it trusts, and it ignores trust given through -c. Work inside this repo,
    // like real use does (the default workspace lives here), so trust comes from the repo's own entry.
    const ws = `${import.meta.dir}/../workspace/live-codex-test`;
    rmSync(ws, { recursive: true, force: true });
    const s = await startServer(4797, { AOS_WORKSPACE: ws });
    const task = await s.call("/api/request", "POST", {
      text: 'Create a file named hello.txt in your working directory whose only content is the three words "hi from codex" (no quotes, no punctuation). Then complete this task with update_task, saying what you created.',
      to: "sde",
    });
    const done = await waitForTask(s, task.id, 6 * 60_000);

    expect(done.status.state).toBe("completed");
    expect(readFileSync(`${ws}/main/hello.txt`, "utf8").trim()).toBe("hi from codex"); // the main team's folder
    const cmd: string[] = JSON.parse(readFileSync(`${s.dir}/data/sessions/main.sde-1/command.json`, "utf8"));
    expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
    rmSync(ws, { recursive: true, force: true });
  },
  7 * 60_000,
);
