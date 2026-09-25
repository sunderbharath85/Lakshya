import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { api, apiUrl } from "./live";

const THEME = {
  background: "#121212",
  foreground: "#e6e6e6",
  cursor: "#e6e6e6",
  cursorAccent: "#121212",
  selectionBackground: "#3a3f4b",
  black: "#121212",
  brightBlack: "#6b6b6b",
};

/** live: WebSocket stream. polling: the WebSocket can't get through, so the screen is fetched every second. */
type Link = "connecting" | "live" | "reconnecting" | "polling";

/**
 * A live view of one agent's PTY. Both modes fit the PTY to the view (the agent redraws at that size):
 * `focus` takes keyboard input; `tile` is a smaller, read-only view for the all-sessions grid.
 *
 * The screen streams over a WebSocket. If that can't connect (some proxies, networks or browser setups
 * block it), the view falls back to fetching the screen over plain HTTP each second and sending keys
 * over HTTP, and keeps retrying the WebSocket in the background.
 */
export function TerminalView({ sessionId, mode }: { sessionId: string; mode: "focus" | "tile" }) {
  const host = useRef<HTMLDivElement>(null);
  const focus = mode === "focus";
  const [link, setLink] = useState<Link>("connecting");

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

    let ws: WebSocket | null = null;
    let disposed = false;
    let failures = 0;
    let polling = false;
    let lastScreen = "";
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const isLive = () => ws?.readyState === WebSocket.OPEN;

    const sendResize = () => {
      try {
        fit.fit();
      } catch {}
      const size = { cols: term.cols, rows: term.rows };
      if (isLive()) ws!.send(JSON.stringify({ type: "resize", ...size }));
      else if (polling) api(`/api/sessions/${sessionId}/resize`, "POST", size).catch(() => {});
    };
    const showScreen = (data: string, cols: number, rows: number, after?: () => void) => {
      term.reset();
      // Replay at the size the screen was drawn at, then fit; the agent redraws on the resize.
      if (cols) term.resize(cols, rows);
      term.write(data, after);
    };

    const poll = async () => {
      if (!polling || disposed) return;
      try {
        const res = await fetch(apiUrl(`/api/sessions/${sessionId}/screen?scrollback=200`));
        if (res.ok) {
          const snap = (await res.json()) as { data: string; cols: number; rows: number };
          if (snap.data !== lastScreen) {
            lastScreen = snap.data;
            showScreen(snap.data, snap.cols, snap.rows);
          }
        }
      } catch {}
      pollTimer = setTimeout(poll, 1000);
    };
    const startPolling = () => {
      if (polling || disposed) return;
      polling = true;
      setLink("polling");
      sendResize();
      poll();
    };
    const stopPolling = () => {
      polling = false;
      clearTimeout(pollTimer);
    };

    const connect = () => {
      if (disposed) return;
      const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/term/${sessionId}`);
      socket.binaryType = "arraybuffer";
      ws = socket;
      socket.onopen = () => {
        failures = 0;
        stopPolling();
        setLink("live");
        setTimeout(sendResize, 50);
      };
      socket.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          const msg = JSON.parse(ev.data);
          if (msg.type === "snapshot") showScreen(msg.data, msg.cols, msg.rows, sendResize);
        } else {
          term.write(new Uint8Array(ev.data));
        }
      };
      socket.onclose = (ev) => {
        if (disposed || ws !== socket) return;
        failures++;
        console.warn(`[lakshya] terminal connection for ${sessionId} closed (code ${ev.code}); attempt ${failures}`);
        if (failures >= 2) startPolling();
        else setLink("reconnecting");
        // Keep trying the live stream; slowly once the HTTP fallback is showing the screen.
        retryTimer = setTimeout(connect, polling ? 10_000 : 1000);
      };
    };
    connect();

    const input = term.onData((data) => {
      if (!focus) return;
      if (isLive()) ws!.send(JSON.stringify({ type: "input", data }));
      else api(`/api/sessions/${sessionId}/input`, "POST", { data }).catch(() => {});
    });
    const ro = new ResizeObserver(() => sendResize());
    ro.observe(el);
    if (focus) term.focus();

    return () => {
      disposed = true;
      stopPolling();
      clearTimeout(retryTimer);
      ro.disconnect();
      input.dispose();
      ws?.close();
      term.dispose();
    };
  }, [sessionId, focus]);

  const label = { connecting: "", live: "", reconnecting: "Reconnecting…", polling: "Live connection blocked, updating every second" }[link];
  return (
    <div className={focus ? "relative flex min-h-0 flex-1 flex-col" : "relative min-h-0"}>
      <div ref={host} className={focus ? "min-h-0 flex-1 overflow-hidden bg-terminal pt-2 pl-3" : "h-full min-h-0 overflow-hidden bg-terminal pt-1 pl-2"} />
      {label && (
        <span
          role="status"
          title="The terminal's WebSocket can't connect through this network or proxy, so the screen is fetched over HTTPS instead. Everything still works, a little less smoothly."
          className="pointer-events-auto absolute top-2 right-3 z-10 bg-secondary px-2 py-0.5 text-xs text-muted-foreground"
        >
          {label}
        </span>
      )}
    </div>
  );
}
