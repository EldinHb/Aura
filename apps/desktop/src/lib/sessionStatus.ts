import type { Session } from "../gen";

/** The tone of a session's status dot. */
export function statusClass(s: Session): string {
  switch (s.status) {
    case "running":
      return "info pulse";
    case "waiting_approval":
    case "waiting_input":
      return "warn pulse";
    case "error":
      return "err";
    case "exited":
      return "";
    default:
      return "ok";
  }
}

/**
 * A session's state as a word, so it is never shown by colour alone: waiting
 * on you, working, failed, finished, exited, archived or idle.
 */
export function stateWord(s: Session): string {
  if (s.archived) return "archived";
  if (s.pending_count > 0 || s.status === "waiting_approval" || s.status === "waiting_input" || s.attention === "waiting") return "waiting on you";
  if (s.status === "running") return "working";
  if (s.attention === "failed" || s.status === "error") return "failed";
  if (s.attention === "done") return "finished";
  if (s.status === "exited") return "exited";
  return "idle";
}
