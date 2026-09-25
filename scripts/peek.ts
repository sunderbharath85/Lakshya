// Print the current screen of a session as plain text: bun scripts/peek.ts <session-id>
import { Terminal } from "@xterm/headless";
const id = process.argv[2];
const port = process.env.AOS_PORT ?? 4777;
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/term/${id}`);
ws.onmessage = (ev) => {
  if (typeof ev.data !== "string") return;
  const msg = JSON.parse(ev.data);
  const t = new Terminal({ cols: msg.cols || 120, rows: msg.rows || 36, allowProposedApi: true });
  t.write(msg.data, () => {
    const b = t.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? "");
    console.log(lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd());
    process.exit(0);
  });
};
