// Type into a session's terminal: bun scripts/type.ts <session-id> <text>   (use \\r for Enter, \\e for Esc)
const [id, text = ""] = process.argv.slice(2);
const ws = new WebSocket(`ws://127.0.0.1:${process.env.AOS_PORT ?? 4777}/ws/term/${id}`);
ws.onopen = () => {
  ws.send(JSON.stringify({ type: "input", data: text.replaceAll("\\r", "\r").replaceAll("\\e", "\x1b") }));
  setTimeout(() => process.exit(0), 300);
};
