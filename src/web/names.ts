import { useMemo } from "react";
import type { A2ATask, Activity, Persona } from "../shared/types";
import { TERMINAL_STATES } from "../shared/types";
import type { LiveState } from "./live";

export function useNames(s: LiveState) {
  return useMemo(() => {
    const persona = new Map(s.personas.map((p) => [p.id, p]));
    const session = new Map(s.sessions.map((x) => [x.id, x]));
    const who = (key: string) => {
      if (key === "user") return "You";
      if (key === "external") return "External client";
      if (key === "autopilot") return "Autopilot";
      return session.get(key)?.id ?? persona.get(key)?.name ?? key;
    };
    const personaOfKey = (key: string) => persona.get(session.get(key)?.personaId ?? key);
    const color = (key: string) => personaOfKey(key)?.color ?? "#000";
    return { persona, session, who, color, personaOfKey };
  }, [s.personas, s.sessions]);
}
export type Names = ReturnType<typeof useNames>;

export function shortOf(p: Persona) {
  return p.short?.trim() || p.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 3).toUpperCase();
}

export const ACTIVITY: Record<Activity, string> = {
  starting: "Starting",
  idle: "Idle",
  working: "Working",
  attention: "Needs you",
  exited: "Stopped",
};

export const STATE: Record<string, string> = {
  submitted: "Queued",
  working: "Working",
  "input-required": "Waiting for answer",
  completed: "Done",
  failed: "Failed",
  canceled: "Canceled",
  rejected: "Rejected",
};

export const isOpen = (t: A2ATask) => !TERMINAL_STATES.includes(t.status.state);

export function needsUser(t: A2ATask) {
  if (!isOpen(t)) return false;
  return t.metadata.to === "user" || (t.metadata.from === "user" && t.status.state === "input-required");
}
