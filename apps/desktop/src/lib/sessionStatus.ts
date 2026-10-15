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
