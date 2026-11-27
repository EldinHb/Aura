// Whether "Squash and merge" shows on a card, and whether it can be used now.
import type { PrStatus } from "../shared/types";

export type SquashState =
  | { kind: "ready" }
  /** Shown, but not usable now; the reasons are said next to it. */
  | { kind: "disabled"; reasons: string[] }
  /** The repository does not squash: said instead of the button. */
  | { kind: "unavailable"; reason: string };

/**
 * Only an open, approved PR (not a draft) offers it. It is usable when GitHub reports it
 * mergeable and clean (or clean but for hooks), and the account may merge.
 */
export function squashState(status: PrStatus): SquashState | null {
  const m = status.merge;
  if (status.state !== "open" || m.reviewDecision !== "APPROVED") return null;
  if (!m.squashAllowed) return { kind: "unavailable", reason: "This repository does not allow squash merging" };
  if (!m.canMerge) return { kind: "disabled", reasons: ["You don't have permission to merge"] };
  if (m.mergeable === "MERGEABLE" && (m.mergeStateStatus === "CLEAN" || m.mergeStateStatus === "HAS_HOOKS")) return { kind: "ready" };
  const reasons: string[] = [];
  if (m.mergeable === "CONFLICTING" || m.mergeStateStatus === "DIRTY") reasons.push("Merge conflicts");
  if (m.mergeStateStatus === "BEHIND") reasons.push("Behind base branch");
  if (status.checks.state === "failing" || (m.mergeStateStatus === "UNSTABLE" && status.checks.state !== "pending")) reasons.push("Checks failing");
  else if (status.checks.state === "pending") reasons.push("Checks pending");
  if (m.mergeStateStatus === "BLOCKED" && reasons.length === 0) reasons.push("Blocked by branch protection");
  if (reasons.length === 0) reasons.push("GitHub is still checking mergeability");
  return { kind: "disabled", reasons };
}
