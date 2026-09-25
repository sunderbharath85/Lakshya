#!/usr/bin/env bun
// Stand-in for the Codex CLI in tests. It takes Codex's flags, loads MCP servers from `-c mcp_servers.*`
// overrides (parsed as TOML, like Codex does), and acts like a minimal agent: whenever an [A2A] line is
// typed in, it calls check_inbox through the MCP bridge and completes every task assigned to it.
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (process.env.FAKE_CODEX_ARGV) writeFileSync(process.env.FAKE_CODEX_ARGV, JSON.stringify(argv));

const config: Record<string, any> = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "-c") continue;
  const kv = argv[++i]!;
  const eq = kv.indexOf("=");
  const path = kv.slice(0, eq).split(".");
  const value = (Bun.TOML.parse(`v = ${kv.slice(eq + 1)}`) as { v: unknown }).v;
  let node = config;
  for (const key of path.slice(0, -1)) node = node[key] ??= {};
  node[path.at(-1)!] = value;
}

const server = config.mcp_servers?.a2a;
if (!server) {
  console.log("fake codex: no a2a MCP server configured");
  process.exit(2);
}
const yolo = argv.includes("--dangerously-bypass-approvals-and-sandbox");
const input = console[Symbol.asyncIterator]();

// Like real Codex in an untrusted folder: a menu where typing the wrong thing quits.
if (process.env.FAKE_CODEX_TRUST) {
  console.log("  Trust this folder? Codex can read, edit, and run files here.");
  console.log("› 1. Trust and continue");
  console.log("  2. Quit");
  console.log("  enter continue · esc quit");
  const answer = (await input.next()).value as string;
  if (answer !== "") {
    console.log(`quit: typed ${JSON.stringify(answer)} into the trust menu`);
    process.exit(1);
  }
  process.stdout.write("\x1b[2J\x1b[H"); // the menu closes, as in real Codex
}
console.log(`fake codex ready (yolo=${yolo}, mcp=${server.command})`);

// ---- minimal MCP client over stdio ----
const mcp = Bun.spawn([server.command, ...server.args], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
let nextId = 0;
const pending = new Map<number, (r: any) => void>();
(async () => {
  let buf = "";
  for await (const chunk of mcp.stdout) {
    buf += new TextDecoder().decode(chunk);
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      pending.get(msg.id)?.(msg);
    }
  }
})();
function rpc(method: string, params: unknown = {}): Promise<any> {
  const id = ++nextId;
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  mcp.stdin.flush();
  return new Promise((resolve) => pending.set(id, resolve));
}
const tool = async (name: string, args: Record<string, unknown> = {}) =>
  (await rpc("tools/call", { name, arguments: args })).result.content[0].text as string;

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-codex", version: "0" } });
const tools = (await rpc("tools/list")).result.tools.map((t: any) => t.name);
console.log(`mcp tools: ${tools.join(",")}`);

// ---- the "agent" ----
for (let next = await input.next(); !next.done; next = await input.next()) {
  const line = next.value as string;
  console.log(`got: ${line}`);
  if (!line.includes("[A2A]")) continue;
  const inbox = await tool("check_inbox");
  for (const id of new Set(inbox.match(/TASK FOR YOU (task_\w+)/g)?.map((m) => m.split(" ").at(-1)!) ?? [])) {
    console.log(await tool("update_task", { task_id: id, state: "completed", message: `done by fake codex (yolo=${yolo})` }));
  }
}
