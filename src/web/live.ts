import { useEffect, useState } from "react";
import type { A2AMessage, A2ATask, Persona, ServerEvent, SessionInfo, Settings } from "../shared/types";

export interface RuntimeInfo {
  id: string;
  name: string;
  path: string | null;
}

export interface LiveState {
  personas: Persona[];
  sessions: SessionInfo[];
  tasks: A2ATask[];
  messages: A2AMessage[];
  settings: Settings;
  runtimes: RuntimeInfo[];
  connected: boolean;
}

function upsert<T extends { id: string }>(list: T[], item: T) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

function apply(s: LiveState, e: ServerEvent): LiveState {
  switch (e.type) {
    case "personas":
      return { ...s, personas: e.personas };
    case "session":
      return { ...s, sessions: upsert(s.sessions, e.session) };
    case "task":
      return { ...s, tasks: upsert(s.tasks, e.task).sort((a, b) => b.metadata.updatedAt - a.metadata.updatedAt) };
    case "message":
      return { ...s, messages: [...s.messages.slice(-599), e.message] };
    case "settings":
      return { ...s, settings: e.settings };
    default:
      return s;
  }
}

/** Server state, kept current over the events WebSocket. Reconnects and resyncs on drop. */
export function useLive(): LiveState | null {
  const [state, setState] = useState<LiveState | null>(null);
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = async () => {
      try {
        const snap = await fetch("/api/state").then((r) => r.json());
        setState({ ...snap, connected: true });
      } catch {
        retry = setTimeout(connect, 1500);
        return;
      }
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/events`);
      ws.onmessage = (m) => setState((s) => (s ? apply(s, JSON.parse(m.data)) : s));
      ws.onclose = () => {
        setState((s) => (s ? { ...s, connected: false } : s));
        if (!closed) retry = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);
  return state;
}

export async function api<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export function timeAgo(ts: number) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}
