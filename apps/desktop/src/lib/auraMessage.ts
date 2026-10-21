import type { Item } from "../gen";

/** Ends the first line of every message Aura, not the user, sends an agent (`aura_core::prompts::AURA_MARK`). */
const MARK = "This message comes from Aura, not the user.";

export type AuraMessage = {
  /** "Worker report", "New review activity on your pull request". */
  title: string;
  /** The message without its first line. */
  body: string;
  /** A worker reporting to its orchestrator. */
  report: boolean;
};

/**
 * A message Aura sent the agent in the user's place: a worker report to an
 * orchestrator, review activity on a followed pull request. It is told apart by
 * its first line, so transcripts stored before Aura kept these out of the chat
 * are read the same way. Null for anything the user wrote.
 */
export function auraMessage(item: Item): AuraMessage | null {
  if (item.kind !== "user_message" || !item.text.startsWith("[Aura] ")) return null;
  const end = item.text.indexOf("\n");
  const first = end < 0 ? item.text : item.text.slice(0, end);
  if (!first.endsWith(MARK)) return null;
  const title = first.slice("[Aura] ".length, -MARK.length).trim().replace(/\.$/, "");
  return { title, body: end < 0 ? "" : item.text.slice(end + 1).trim(), report: title === "Worker report" };
}

/** The user's own message: a user message that is not from Aura. */
export const isUserMessage = (item: Item) => item.kind === "user_message" && !auraMessage(item);
