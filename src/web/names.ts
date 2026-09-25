import { useMemo } from "react";
import type { A2ATask, Activity, Persona } from "../shared/types";
import { TERMINAL_STATES } from "../shared/types";
import type { LiveState } from "./live";

/** "main.sde-2" → "sde-2": inside a team, the team prefix is noise. */
export const shortId = (id: string) => (id.includes(".") ? id.slice(id.indexOf(".") + 1) : id);

export function useNames(s: LiveState) {
  return useMemo(() => {
    const persona = new Map(s.personas.map((p) => [`${p.teamId}/${p.id}`, p]));
    const session = new Map(s.sessions.map((x) => [x.id, x]));
    const who = (key: string) => {
      if (key === "user") return "You";
      if (key === "external") return "External client";
      if (key === "autopilot") return "Autopilot";
      return session.has(key) ? shortId(key) : key;
    };
    const personaOfSession = (id: string) => {
      const x = session.get(id);
      return x ? persona.get(`${x.teamId}/${x.personaId}`) : undefined;
    };
    const color = (key: string) => personaOfSession(key)?.color ?? "#9a9a9a";
    return { persona, session, who, color, personaOfSession };
  }, [s.personas, s.sessions]);
}
export type Names = ReturnType<typeof useNames>;

/** The same state, narrowed to one team: what every pane but the team switcher works with. */
export function forTeam(s: LiveState, team: string): LiveState {
  return {
    ...s,
    personas: s.personas.filter((p) => p.teamId === team),
    sessions: s.sessions.filter((x) => x.teamId === team),
    tasks: s.tasks.filter((t) => t.metadata.team === team),
  };
}

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

/** How many things in a team are waiting on a person: questions, stuck tasks, prompts on screen. */
export function waitingOn(s: LiveState, team: string) {
  return (
    s.tasks.filter((t) => t.metadata.team === team && needsUser(t)).length +
    s.sessions.filter((x) => x.teamId === team && x.activity === "attention").length
  );
}
