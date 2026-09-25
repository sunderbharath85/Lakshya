import { TERMINAL_STATES } from "../shared/types";
import { autopilotNote } from "./a2a";
import { notify, runningSessions } from "./sessions";
import { getSettings, listTasks, unreadFor } from "./store";

const MAX_NUDGES = 3;
const nudges = new Map<string, { count: number; at: number }>();

/**
 * The autopilot loop. Agents are CLIs that stop at their prompt when they think they are done, so
 * every few seconds this looks for agents sitting idle while they still owe work, and re-prompts them.
 * After MAX_NUDGES reminders on one task, the requester is told the task has stalled.
 */
export function sweep(now = Date.now()) {
  const settings = getSettings();
  if (!settings.autopilot) return;
  const wait = settings.nudgeAfterSec * 1000;
  const open = listTasks().filter((t) => !TERMINAL_STATES.includes(t.status.state));

  for (const s of runningSessions()) {
    if (s.activity !== "idle" || !s.idleSince || now - s.idleSince < wait || s.pendingDeliveries > 0) continue;

    // A notice can be lost (typed into a dialog, or cleared by the user): deliver it again.
    const unread = unreadFor(s.id);
    if (unread.length) {
      notify(s.id, `[A2A] You have ${unread.length} unread message${unread.length > 1 ? "s" : ""}. Call check_inbox.`);
      continue;
    }

    const owed = open.find((t) => t.metadata.to === s.id && (t.status.state === "submitted" || t.status.state === "working"));
    if (!owed) continue;
    const n = nudges.get(owed.id) ?? { count: 0, at: 0 };
    if (now - n.at < wait) continue;
    if (n.count >= MAX_NUDGES) {
      if (n.count === MAX_NUDGES) {
        autopilotNote(owed.id, `Autopilot: ${s.id} has gone quiet on this task after ${MAX_NUDGES} reminders. Check its terminal, reassign the work, or cancel the task.`);
        nudges.set(owed.id, { count: n.count + 1, at: now });
      }
      continue;
    }
    nudges.set(owed.id, { count: n.count + 1, at: now });
    notify(
      s.id,
      `[A2A] Autopilot reminder ${n.count + 1}/${MAX_NUDGES}: task ${owed.id} ("${owed.metadata.title}") is still open. Keep working until it meets its definition of done, then call update_task. If you are blocked, set it to input-required with your question.`,
    );
  }
}

export function startSupervisor() {
  setInterval(() => sweep(), Number(process.env.AOS_SWEEP_MS ?? 10_000));
}
