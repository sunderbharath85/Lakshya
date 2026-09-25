import type { ServerEvent } from "../shared/types";

type Publisher = (topic: string, data: string | Uint8Array) => void;
let publisher: Publisher = () => {};

export function setPublisher(p: Publisher) {
  publisher = p;
}

export const EVENTS_TOPIC = "events";
export const termTopic = (sessionId: string) => `term:${sessionId}`;

export function emit(event: ServerEvent) {
  publisher(EVENTS_TOPIC, JSON.stringify(event));
}

export function publishTerminal(sessionId: string, data: Uint8Array) {
  publisher(termTopic(sessionId), data);
}

/** In-process listeners, used for long-polls and A2A streaming. */
type Listener = (event: ServerEvent) => void;
const listeners = new Set<Listener>();
export function onEvent(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function emitLocal(event: ServerEvent) {
  emit(event);
  for (const l of listeners) l(event);
}
