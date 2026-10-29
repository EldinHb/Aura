import type { Item } from "../gen";

/** Ends the first line of every message Aura, not the user, sends an agent (`aura_core::prompts::AURA_MARK`). */
const MARK = "This message comes from Aura, not the user.";

/**
 * What a message from Aura is about, by its title:
 * - `report`: workers reporting to their orchestrator.
 * - `decision`: the user's answer to a feature owner's question or checkpoint review.
 * - `suggestion`: what the user made of a feature owner's specialist suggestion.
 * - `meeting`: a meeting's agenda, or a live meeting's thread, for an attendee; every answer, or a live round, for its owner.
 * - `team`: a one-on-one between team members: a question, or its answer.
 * - `other`: anything else, such as review activity on a followed pull request.
 */
export type AuraMessageKind = "report" | "decision" | "suggestion" | "meeting" | "team" | "other";

export type AuraMessage = {
  /** "Worker report", "New review activity on your pull request". */
  title: string;
  /** The message without its first line. */
  body: string;
  /** A worker reporting to its orchestrator. */
  report: boolean;
  kind: AuraMessageKind;
};

function kindOf(title: string): AuraMessageKind {
  if (title === "Worker report") return "report";
  if (title === "Decision from the user" || title === "Checkpoint review from the user") return "decision";
  if (title.startsWith("Specialist suggestion ")) return "suggestion";
  if (title === "Meeting" || title.startsWith("Meeting notes") || title === "Live meeting" || title === "Live meeting notes") return "meeting";
  if (title === "Question from a teammate" || title.startsWith("Answer from ") || title === "No answer to your question") return "team";
  return "other";
}

/**
 * A message Aura sent the agent in the user's place: a worker report to an
 * orchestrator, the user's answer to a feature owner, review activity on a
 * followed pull request. It is told apart by its first line, so transcripts
 * stored before Aura kept these out of the chat are read the same way. Null
 * for anything the user wrote.
 */
export function auraMessage(item: Item): AuraMessage | null {
  if (item.kind !== "user_message" || !item.text.startsWith("[Aura] ")) return null;
  const end = item.text.indexOf("\n");
  const first = end < 0 ? item.text : item.text.slice(0, end);
  if (!first.endsWith(MARK)) return null;
  const title = first.slice("[Aura] ".length, -MARK.length).trim().replace(/\.$/, "");
  const kind = kindOf(title);
  return { title, body: end < 0 ? "" : item.text.slice(end + 1).trim(), report: kind === "report", kind };
}

/** The user's own message: a user message that is not from Aura. */
export const isUserMessage = (item: Item) => item.kind === "user_message" && !auraMessage(item);
