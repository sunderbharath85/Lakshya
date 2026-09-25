import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const PORT = 4799;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(`${tmpdir()}/aos-test-`);
let server: Bun.Subprocess;

beforeAll(async () => {
  server = Bun.spawn(["bun", "src/server/index.ts"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      AOS_PORT: String(PORT),
      AOS_DATA_DIR: `${dir}/data`,
      AOS_WORKSPACE: `${dir}/ws`,
      AOS_CLAUDE_BIN: `${import.meta.dir}/fake-agent.sh`,
      AOS_SWEEP_MS: "300",
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${BASE}/api/state`).then((r) => r.ok, () => false)) return;
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
});

afterAll(() => {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown, token?: string) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }).then((r) => r.json() as Promise<any>);
const get = (path: string, token?: string) =>
  fetch(`${BASE}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }).then((r) => r.json() as Promise<any>);
const rpc = (agent: string, method: string, params: unknown, token?: string) =>
  post(agent ? `/a2a/${agent}` : "/a2a", { jsonrpc: "2.0", id: 1, method, params }, token);
const tokenOf = (id: string) =>
  new Database(`${dir}/data/agentic-os.sqlite`, { readonly: true }).query<{ token: string }, [string]>("SELECT token FROM sessions WHERE id = ?").get(id)!.token;
const text = (t: string) => ({ kind: "message", messageId: crypto.randomUUID(), role: "user", parts: [{ kind: "text", text: t }] });

async function screenOf(id: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/term/${id}`);
  let out = "";
  ws.onmessage = (e) => (out += typeof e.data === "string" ? JSON.parse(e.data).data : new TextDecoder().decode(e.data as ArrayBuffer));
  await Bun.sleep(300);
  ws.close();
  return out;
}

test("serves an A2A agent card for the entry persona", async () => {
  const card = await get("/.well-known/agent-card.json");
  expect(card.name).toBe("Product Manager");
  expect(card.url).toBe(`${BASE}/a2a/product-manager`);
  expect(card.capabilities.streaming).toBe(true);
});

test("a request spawns the entry persona and types an [A2A] notice into its terminal", async () => {
  const task = await post("/api/request", { text: "Build a todo app" });
  expect(task.status.state).toBe("submitted");
  expect(task.metadata.to).toBe("product-manager-1");

  // The notice waits until the fake agent's screen is quiet, then is typed in.
  let screen = "";
  for (let i = 0; i < 40 && !screen.includes("got: [A2A]"); i++) {
    await Bun.sleep(250);
    screen = await screenOf("product-manager-1");
  }
  expect(screen).toContain(`got: [A2A] New task from the user. Task ${task.id}`);
});

test("agents delegate over A2A, reply, and results flow back", async () => {
  const pm = tokenOf("product-manager-1");
  const inbox = await post("/api/agent/inbox", {}, pm);
  expect(inbox.messages).toHaveLength(1);
  const userTask = inbox.tasks[0];
  expect(userTask.status.state).toBe("working");

  // PM delegates to the project manager via A2A message/send; a session starts for it.
  const sent = await rpc("project-manager", "message/send", { message: text("Plan the todo app from docs/brief.md") }, pm);
  expect(sent.result.metadata.from).toBe("product-manager-1");
  expect(sent.result.metadata.to).toBe("project-manager-1");
  const child = sent.result.id;

  // The project manager asks a question, the PM answers on the same task.
  const proj = tokenOf("project-manager-1");
  await post("/api/agent/inbox", {}, proj);
  await post(`/api/agent/tasks/${child}/status`, { state: "input-required", message: "Web or mobile?" }, proj);
  let t = (await rpc("", "tasks/get", { id: child }, pm)).result;
  expect(t.status.state).toBe("input-required");
  await rpc("", "message/send", { message: { ...text("Web."), taskId: child } }, pm);
  t = (await rpc("", "tasks/get", { id: child }, pm)).result;
  expect(t.status.state).toBe("working");

  // wait_for_task resolves as soon as the task completes.
  const waiting = get(`/api/agent/tasks/${child}/wait?timeout=10`, pm);
  await Bun.sleep(100);
  await post(`/api/agent/tasks/${child}/status`, { state: "completed", message: "Plan in docs/plan.md", artifactName: "plan" }, proj);
  const done = await waiting;
  expect(done.status.state).toBe("completed");
  expect(done.artifacts[0].name).toBe("plan");
  expect(done.history.map((m: any) => m.metadata.from)).toEqual(["product-manager-1", "project-manager-1", "product-manager-1", "project-manager-1"]);

  // The PM completes the user's task.
  const finished = await post(`/api/agent/tasks/${userTask.id}/status`, { state: "completed", message: "Shipped." }, pm);
  expect(finished.status.state).toBe("completed");
});

test("canTalkTo rules are enforced", async () => {
  const personas = await get("/api/personas");
  const qa = personas.find((p: any) => p.id === "qa-engineer");
  await fetch(`${BASE}/api/personas/qa-engineer`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...qa, canTalkTo: ["sde"] }),
  });
  const s = await post("/api/sessions", { personaId: "qa-engineer" });
  const res = await rpc("frontend-engineer", "message/send", { message: text("hi") }, tokenOf(s.id));
  expect(res.error.message).toContain("not allowed to contact frontend-engineer");
});

test("only the assignee can update a task, and only spawners can spawn", async () => {
  const pm = tokenOf("product-manager-1");
  const sent = await rpc("sde", "message/send", { message: text("Build the API") }, pm);
  const other = await post(`/api/agent/tasks/${sent.result.id}/status`, { state: "completed", message: "x" }, tokenOf("project-manager-1"));
  expect(other.error).toContain("Only");
  const denied = await post("/api/agent/spawn", { persona: "tester" }, tokenOf(sent.result.metadata.to));
  expect(denied.error).toContain("may not start sessions");
  const ok = await post("/api/agent/spawn", { persona: "tester" }, tokenOf("project-manager-1"));
  expect(ok.id).toBe("tester-1");
});

test("message/stream sends the task then status updates until it settles", async () => {
  const res = await fetch(`${BASE}/a2a/tester`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "message/stream", params: { message: text("Run the suite") } }),
  });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body!.getReader();
  const events: any[] = [];
  const read = (async () => {
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      for (const chunk of buf.split("\n\n").slice(0, -1)) events.push(JSON.parse(chunk.slice(6)).result);
      buf = buf.split("\n\n").at(-1)!;
    }
  })();
  await Bun.sleep(200);
  const taskId = events[0].id;
  const tester = tokenOf(events[0].metadata.to);
  await post(`/api/agent/tasks/${taskId}/status`, { state: "working", message: "running" }, tester);
  await post(`/api/agent/tasks/${taskId}/status`, { state: "completed", message: "12 passed" }, tester);
  await read;
  expect(events.map((e) => e.kind + (e.status ? `:${e.status.state}` : ""))).toEqual([
    "task:submitted",
    "status-update:working",
    "artifact-update",
    "status-update:completed",
  ]);
  expect(events.at(-1).final).toBe(true);
});

test("stopping a session fails the tasks it still owed", async () => {
  const pm = tokenOf("product-manager-1");
  const sent = await rpc("frontend-engineer", "message/send", { message: text("Build the UI") }, pm);
  const fe = sent.result.metadata.to;
  await fetch(`${BASE}/api/sessions/${fe}`, { method: "DELETE" });
  for (let i = 0; i < 30; i++) {
    const t = (await rpc("", "tasks/get", { id: sent.result.id }, pm)).result;
    if (t.status.state === "failed") return;
    await Bun.sleep(100);
  }
  throw new Error("task was not failed after its session stopped");
});

test("autopilot re-prompts an idle agent that still owes work", async () => {
  await fetch(`${BASE}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ nudgeAfterSec: 1 }) });
  const pm = tokenOf("product-manager-1");
  const sent = await rpc("tester", "message/send", { message: text("Write the e2e suite") }, pm);
  const id = sent.result.metadata.to;
  let screen = "";
  for (let i = 0; i < 40 && !screen.includes("Autopilot reminder 1/3"); i++) {
    await Bun.sleep(250);
    // Read the inbox as the agent would, so the only thing left is the open task.
    await post("/api/agent/inbox", {}, tokenOf(id));
    screen = await screenOf(id);
  }
  expect(screen).toContain(`Autopilot reminder 1/3: task ${sent.result.id}`);
  await fetch(`${BASE}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ autopilot: false }) });
}, 20_000);
