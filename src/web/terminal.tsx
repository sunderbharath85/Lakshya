import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";

const THEME = {
  background: "#121212",
  foreground: "#e6e6e6",
  cursor: "#e6e6e6",
  cursorAccent: "#121212",
  selectionBackground: "#3a3f4b",
  black: "#121212",
  brightBlack: "#6b6b6b",
};

/**
 * A live view of one agent's PTY. Both modes fit the PTY to the view (the agent redraws at that size):
 * `focus` takes keyboard input; `tile` is a smaller, read-only view for the all-sessions grid.
 */
export function TerminalView({ sessionId, mode }: { sessionId: string; mode: "focus" | "tile" }) {
  const host = useRef<HTMLDivElement>(null);
  const focus = mode === "focus";

  useEffect(() => {
    const el = host.current!;
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
      fontSize: !focus ? 11 : window.innerWidth < 720 ? 11 : 14,
      lineHeight: 1.15,
      theme: THEME,
      cursorBlink: focus,
      disableStdin: !focus,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Login flows print URLs to open; make them clickable.
    term.loadAddon(new WebLinksAddon());
    term.open(el);

    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/term/${sessionId}`);
    ws.binaryType = "arraybuffer";
    const sendResize = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        fit.fit();
      } catch {}
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        const msg = JSON.parse(ev.data);
        if (msg.type === "snapshot") {
          term.reset();
          // Replay at the size the screen was drawn at, then fit; the agent redraws on the resize.
          if (msg.cols) term.resize(msg.cols, msg.rows);
          term.write(msg.data, sendResize);
        }
      } else {
        term.write(new Uint8Array(ev.data));
      }
    };
    ws.onopen = () => setTimeout(sendResize, 50);
    const input = term.onData((data) => focus && ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "input", data })));
    const ro = new ResizeObserver(() => sendResize());
    ro.observe(el);
    if (focus) term.focus();

    return () => {
      ro.disconnect();
      input.dispose();
      ws.close();
      term.dispose();
    };
  }, [sessionId, focus]);

  return <div ref={host} className={focus ? "min-h-0 flex-1 overflow-hidden bg-terminal pt-2 pl-3" : "min-h-0 overflow-hidden bg-terminal pt-1 pl-2"} />;
}
