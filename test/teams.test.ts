import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DEFAULT_PERSONAS, DEVOPS_PERSONAS, MARKETING_PERSONAS } from "../src/server/default-personas";

const servers: { proc: Bun.Subprocess; dir: string }[] = [];
afterAll(() => {
  for (const s of servers) {
    s.proc.kill();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

async function startServer(port: number, prepare?: (dir: string) => void, reuseDir?: string) {
  const dir = reuseDir ?? mkdtempSync(`${tmpdir()}/aos-teams-`);
  prepare?.(dir);
  const proc = Bun.spawn(["bun", "src/server/index.ts"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      AOS_PORT: String(port),
      AOS_DATA_DIR: `${dir}/data`,
      AOS_WORKSPACE: `${dir}/ws`,
      AOS_CLAUDE_BIN: `${import.meta.dir}/fake-agent.sh`,
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  servers.push({ proc, dir });
  const stop = async () => {
    proc.kill();
    await proc.exited;
  };
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50 && !(await fetch(`${base}/api/state`).then((r) => r.ok, () => false)); i++) await Bun.sleep(100);
  const call = (path: string, method = "GET", body?: unknown, token?: string) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }).then((r) => r.json() as Promise<any>);
  const tokenOf = (id: string) =>
    new Database(`${dir}/data/agentic-os.sqlite`, { readonly: true }).query<{ token: string }, [string]>("SELECT token FROM sessions WHERE id = ?").get(id)!.token;
  const rpc = (path: string, method: string, params: unknown, token: string) => call(path, "POST", { jsonrpc: "2.0", id: 1, method, params }, token);
  return { base, dir, call, tokenOf, rpc, stop };
}

const text = (t: string) => ({ kind: "message", messageId: crypto.randomUUID(), role: "user", parts: [{ kind: "text", text: t }] });

test("teams have their own folder, personas and sessions, and agents only see their own team", async () => {
  const s = await startServer(4795);

  // A fresh install has one team, Main, working in <root>/main.
  let state = await s.call("/api/state");
  expect(state.teams.map((t: any) => [t.id, t.workspaceDir])).toEqual([["main", `${s.dir}/ws/main`]]);

  // A new team gets a slug id, a folder under the root, and its own copy of the default personas.
  const mobile = await s.call("/api/teams", "POST", { name: "Mobile App" });
  expect(mobile).toMatchObject({ id: "mobile-app", name: "Mobile App", workspaceDir: `${s.dir}/ws/mobile-app` });
  const mobilePersonas = await s.call("/api/teams/mobile-app/personas");
  expect(mobilePersonas.map((p: any) => p.id)).toEqual(DEFAULT_PERSONAS.map((p) => p.id));
  expect(mobilePersonas.every((p: any) => p.teamId === "mobile-app")).toBe(true);

  // Editing one team's persona leaves the other team's copy alone.
  const sde = mobilePersonas.find((p: any) => p.id === "sde");
  await s.call("/api/teams/mobile-app/personas/sde", "PUT", { ...sde, name: "Mobile Engineer" });
  expect((await s.call("/api/teams/main/personas")).find((p: any) => p.id === "sde").name).toBe("Software Engineer");
  expect((await s.call("/api/personas")).find((p: any) => p.id === "sde").name).toBe("Software Engineer"); // old route = main

  // Requests go to a team's own entry persona, which runs in that team's folder.
  const mainTask = await s.call("/api/request", "POST", { text: "Build the web app" });
  const mobileTask = await s.call("/api/request", "POST", { text: "Build the iOS app", team: "mobile-app" });
  expect(mainTask.metadata).toMatchObject({ team: "main", to: "main.product-manager-1" });
  expect(mobileTask.metadata).toMatchObject({ team: "mobile-app", to: "mobile-app.product-manager-1" });
  state = await s.call("/api/state");
  const cwd = (id: string) => state.sessions.find((x: any) => x.id === id).cwd;
  expect(cwd("main.product-manager-1")).toBe(`${s.dir}/ws/main`);
  expect(cwd("mobile-app.product-manager-1")).toBe(`${s.dir}/ws/mobile-app`);

  const mobilePm = s.tokenOf("mobile-app.product-manager-1");

  // Persona ids resolve within the sender's team: "sde" starts the mobile team's engineer.
  const toSde = await s.rpc("/a2a/sde", "message/send", { message: text("Build the login screen") }, mobilePm);
  expect(toSde.result.metadata).toMatchObject({ team: "mobile-app", to: "mobile-app.sde-1" });

  // Another team's agents and tasks are out of reach.
  const cross = await s.rpc("/a2a/main.product-manager-1", "message/send", { message: text("hello") }, mobilePm);
  expect(cross.error.message).toContain("on another team");
  const peek = await s.rpc("/a2a", "tasks/get", { id: mainTask.id }, mobilePm);
  expect(peek.error.message).toContain("not found");
  const wait = await s.call(`/api/agent/tasks/${mainTask.id}/wait?timeout=1`, "GET", undefined, mobilePm);
  expect(wait.error).toContain("not found");

  // The directory an agent sees is its own team.
  const dir = await s.call("/api/agent/directory", "GET", undefined, mobilePm);
  expect(dir.find((p: any) => p.id === "sde").name).toBe("Mobile Engineer");
  const sessions = dir.flatMap((p: any) => p.sessions.map((x: any) => x.id));
  expect(sessions.every((id: string) => id.startsWith("mobile-app."))).toBe(true);

  // A team with running agents can't be deleted; once they're stopped it can, and main never can.
  expect((await s.call("/api/teams/mobile-app", "DELETE")).error).toContain("Stop");
  for (const id of ["mobile-app.product-manager-1", "mobile-app.sde-1"]) await s.call(`/api/sessions/${id}`, "DELETE");
  for (let i = 0; i < 30 && (await s.call("/api/teams/mobile-app", "DELETE")).error; i++) await Bun.sleep(200);
  state = await s.call("/api/state");
  expect(state.teams.map((t: any) => t.id)).toEqual(["main"]);
  expect(state.personas.some((p: any) => p.teamId === "mobile-app")).toBe(false);
  expect(state.tasks.some((t: any) => t.metadata.team === "mobile-app")).toBe(false);
  expect((await s.call("/api/teams/main", "DELETE")).error).toContain("can't be deleted");
}, 30_000);

test("a new team can start from a copy of another team's personas", async () => {
  const s = await startServer(4794);
  const qa = (await s.call("/api/personas")).find((p: any) => p.id === "qa-engineer");
  await s.call("/api/personas/qa-engineer", "PUT", { ...qa, rules: ["Test on real devices"] });
  const copy = await s.call("/api/teams", "POST", { name: "Main copy", copyFrom: "main", workspaceDir: `${s.dir}/elsewhere` });
  expect(copy).toMatchObject({ id: "main-copy", workspaceDir: `${s.dir}/elsewhere` });
  const copied = (await s.call("/api/teams/main-copy/personas")).find((p: any) => p.id === "qa-engineer");
  expect(copied).toMatchObject({ teamId: "main-copy", rules: ["Test on real devices"] });
  // Same name again gets a unique id.
  expect((await s.call("/api/teams", "POST", { name: "Main copy" })).id).toBe("main-copy-2");
}, 20_000);

test("a new team can start from the marketing template, and resets back to it", async () => {
  const s = await startServer(4789);
  const team = await s.call("/api/teams", "POST", { name: "Marketing", template: "marketing" });
  expect(team).toMatchObject({ id: "marketing", template: "marketing" });
  const ids = () => s.call("/api/teams/marketing/personas").then((ps: any[]) => ps.map((p) => p.id));
  expect(await ids()).toEqual(MARKETING_PERSONAS.map((p) => p.id));
  const personas = await s.call("/api/teams/marketing/personas");
  expect(personas.find((p: any) => p.entry).id).toBe("marketing-lead");
  expect(personas.find((p: any) => p.id === "image-designer")).toMatchObject({ runtime: "claude", skills: [{ id: "image-generation" }] });
  // The main team keeps the engineering personas.
  expect((await s.call("/api/teams/main/personas")).map((p: any) => p.id)).toEqual(DEFAULT_PERSONAS.map((p) => p.id));

  await s.call("/api/teams/marketing/personas/copywriter", "DELETE");
  await s.call("/api/teams/marketing/personas/reset", "POST");
  expect(await ids()).toEqual(MARKETING_PERSONAS.map((p) => p.id));
  // A copy of a marketing team resets to marketing too.
  await s.call("/api/teams", "POST", { name: "Marketing EU", copyFrom: "marketing" });
  await s.call("/api/teams/marketing-eu/personas/reset", "POST");
  expect((await s.call("/api/teams/marketing-eu/personas")).map((p: any) => p.id)).toEqual(MARKETING_PERSONAS.map((p) => p.id));

  const devops = await s.call("/api/teams", "POST", { name: "DevOps", template: "devops" });
  expect(devops).toMatchObject({ id: "devops", template: "devops" });
  const ops = await s.call("/api/teams/devops/personas");
  expect(ops.map((p: any) => p.id)).toEqual(DEVOPS_PERSONAS.map((p) => p.id));
  expect(ops.filter((p: any) => p.entry).map((p: any) => p.id)).toEqual(["devops-lead"]);

  expect((await s.call("/api/teams", "POST", { name: "Sales", template: "sales" })).error).toContain("No team template");

  // Extra CLI arguments are saved, and a line that can't be split is refused.
  const ml = personas.find((p: any) => p.id === "marketing-lead");
  expect((await s.call("/api/teams/marketing/personas/marketing-lead", "PUT", { ...ml, args: "--verbose --name 'Lead'" })).args).toBe("--verbose --name 'Lead'");
  expect((await s.call("/api/teams/marketing/personas/marketing-lead", "PUT", { ...ml, args: '--name "Lead' })).error).toContain("Unclosed");
}, 20_000);

test("an install from before teams becomes the Main team, keeping its folder, personas and tasks", async () => {
  const s = await startServer(4793, (dir) => {
    // The pre-teams schema: personas keyed by id alone, one workspace in settings.
    mkdirSync(`${dir}/data`, { recursive: true });
    const db = new Database(`${dir}/data/agentic-os.sqlite`, { create: true });
    db.exec("CREATE TABLE personas (id TEXT PRIMARY KEY, data TEXT NOT NULL, position INTEGER NOT NULL)");
    db.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, context_id TEXT, data TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    DEFAULT_PERSONAS.forEach((p, i) => db.query("INSERT INTO personas VALUES (?, ?, ?)").run(p.id, JSON.stringify({ ...p, name: `Old ${p.name}` }), i));
    const task = { kind: "task", id: "task_old", contextId: "ctx", status: { state: "completed", timestamp: "" }, metadata: { title: "Old work", from: "user", to: "sde-1", toPersona: "sde", createdAt: 1, updatedAt: 1 } };
    db.query("INSERT INTO tasks VALUES (?, ?, ?, ?)").run("task_old", "ctx", JSON.stringify(task), 1);
    db.query("INSERT INTO settings VALUES ('workspaceDir', ?)").run(JSON.stringify(`${dir}/my-project`));
    db.close();
  });
  const state = await s.call("/api/state");
  expect(state.teams).toMatchObject([{ id: "main", name: "Main", workspaceDir: `${s.dir}/my-project` }]);
  expect(state.personas.map((p: any) => [p.teamId, p.name])).toContainEqual(["main", "Old Software Engineer"]);
  expect(state.tasks[0]).toMatchObject({ id: "task_old", metadata: { team: "main", title: "Old work" } });
}, 20_000);

test("one persona, several sessions: extra engineers only when an orchestrator asks, up to Max sessions", async () => {
  const s = await startServer(4792);
  await s.call("/api/request", "POST", { text: "Build the shop" }); // starts main.product-manager-1
  const pm = s.tokenOf("main.product-manager-1");
  const send = (newSession = false) => s.rpc("/a2a/sde", "message/send", { message: text("Build a feature"), metadata: { newSession } }, pm);

  // First message to the role starts its first session; the next one goes to that same busy session.
  expect((await send()).result.metadata.to).toBe("main.sde-1");
  expect((await send()).result.metadata.to).toBe("main.sde-1");

  // Asking for a new session (what spawn_agent / new_session do) starts parallel engineers...
  expect((await send(true)).result.metadata.to).toBe("main.sde-2");
  expect((await send(true)).result.metadata.to).toBe("main.sde-3");
  // ...until the persona's Max sessions (3 for the SDE); then the least busy existing one gets it.
  expect((await send(true)).result.metadata.to).toBe("main.sde-2");

  // Agents without spawn rights can't ask for extra sessions.
  const sdeToken = s.tokenOf("main.sde-1");
  const denied = await s.rpc("/a2a/qa-engineer", "message/send", { message: text("Test it") }, sdeToken);
  expect(denied.result.metadata.to).toBe("main.qa-engineer-1"); // a first session is always fine
  const more = await s.rpc("/a2a/qa-engineer", "message/send", { message: text("Test more"), metadata: { newSession: true } }, sdeToken);
  expect(more.error.message).toContain("may not start new sessions");
}, 20_000);

test("after a restart, tasks owed by agents that were running are failed and the requester is told", async () => {
  const first = await startServer(4791);
  const task = await first.call("/api/request", "POST", { text: "Build the shop" });
  expect(task.metadata.to).toBe("main.product-manager-1");
  await first.stop();

  const again = await startServer(4791, undefined, first.dir);
  const state = await again.call("/api/state");
  expect(state.sessions.find((x: any) => x.id === "main.product-manager-1").activity).toBe("exited");
  const t = await again.call(`/api/tasks/${task.id}`);
  expect(t.status.state).toBe("failed");
  expect(t.status.message.parts[0].text).toContain("ended when Lakshya restarted");
}, 20_000);
