import { APP_NAME } from "../shared/brand";
import type { Persona } from "../shared/types";
import { listPersonas } from "./store";

export function canTalk(from: Persona, toPersonaId: string) {
  return from.canTalkTo.includes("*") || from.canTalkTo.includes(toPersonaId);
}

export function buildSystemPrompt(persona: Persona, sessionId: string, cwd: string) {
  const team = listPersonas().filter((p) => p.id !== persona.id);
  const reachable = team.filter((p) => canTalk(persona, p.id));
  const lines = [
    `# ${APP_NAME}: you are ${persona.name}`,
    `Session id: ${sessionId}. Role: ${persona.title}.`,
    `Shared workspace (your working directory): ${cwd}`,
    "",
    "## Your role",
    persona.instructions.trim(),
    "",
    "## Rules",
    ...(persona.rules.length ? persona.rules.map((r) => `- ${r}`) : ["- None beyond the team protocol."]),
    "",
    "## Your team",
    ...reachable.map((p) => `- ${p.id}: ${p.name}, ${p.title}. ${p.description}`),
    "- user: the human who runs this portal. Message them when you need a decision only they can make.",
    ...(reachable.length < team.length
      ? [`You may not open tasks with: ${team.filter((p) => !reachable.includes(p)).map((p) => p.id).join(", ")}. Route through someone who can.`]
      : []),
    "",
    "## Team protocol (A2A)",
    "You talk to teammates only through the `a2a` MCP tools, which speak the Agent2Agent protocol. Every request is a task with a state.",
    '- A line starting with "[A2A]" typed into your prompt means you have new messages. Call check_inbox right away and act on them.',
    "- To ask a teammate for work or information, call send_message with a persona id (a session starts for it if none is running) or a session id. It returns a task id.",
    "- To wait for an answer, call wait_for_task. Do not poll in a tight loop.",
    "- Every task you receive must end with update_task: completed (with the result), failed (with the reason), or input-required (with your question).",
    "- Put files you produce in the shared workspace and mention their paths in your messages. Keep messages short and concrete.",
    "- Work in a loop: check every result you receive against its definition of done. If it falls short, send it back on the same task with specifics and wait again. Stop only when it is done, or when you need a decision only the user can make.",
    "- Never leave a task you own without a final update_task. If you get an Autopilot reminder, continue the task or report why you are blocked.",
    "- When you have no tasks, stop and wait. New work arrives as an [A2A] line.",
  ];
  if (persona.canSpawn) {
    lines.push("- You may start extra sessions with spawn_agent when parallel work helps, and stop them with stop_agent when done.");
  }
  if (persona.orchestrator) {
    lines.push("- You are the orchestrator: use list_tasks to see every open task on the team and keep work moving.");
  }
  return lines.join("\n");
}
