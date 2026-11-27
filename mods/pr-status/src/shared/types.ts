// What the daemon half sends the UI half (`view`, `watch`, `refresh`).

/** A session a PR came from: the selected one, or one of its workers at any depth. */
export interface PrSource {
  sessionId: string;
  title: string;
  worker: boolean;
}

/** A pull request found in a session tree, deduplicated by URL. */
export interface PrRef {
  /** `https://github.com/<owner>/<repo>/pull/<n>` */
  url: string;
  repo: string;
  number: number;
  sources: PrSource[];
}

export type PrState = "draft" | "open" | "merged" | "closed";

/**
 * A reviewer's latest review, or `PENDING` while their review is requested. `DISMISSED`
 * counts as neither an approval nor a change request.
 */
export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";

export interface Reviewer {
  /** A login, or `org/team` for a team. */
  name: string;
  kind: "user" | "team" | "bot";
  state: ReviewState;
  /** A re-requested reviewer's review before the new request. */
  previous: ReviewState | null;
}

export interface Reviewers {
  reviewed: Reviewer[];
  /** Requested and not reviewed since, re-requests included. */
  pending: Reviewer[];
  /** False when GitHub had more reviews or requests than were read. */
  complete: boolean;
}

export type ChecksState = "passing" | "failing" | "pending" | "none";

export interface Check {
  name: string;
  url: string | null;
  state: "passing" | "failing" | "pending";
}

export interface Checks {
  state: ChecksState;
  passing: number;
  failing: number;
  pending: number;
  /** GitHub's count; above the sum when the head commit has more than were read. */
  total: number;
  /** The failing checks, then the pending ones. */
  open: Check[];
  /** False when not every check was read; `state` is then GitHub's own rollup. */
  complete: boolean;
}

/** Why an open PR cannot be merged yet. `unknown`: GitHub is still computing mergeability. */
export type Blocker =
  | "draft"
  | "changes_requested"
  | "review_required"
  | "checks_failing"
  | "checks_pending"
  | "conflicts"
  | "behind"
  | "blocked"
  | "unstable"
  | "unknown";

export interface Readiness {
  ready: boolean;
  reasons: Blocker[];
}

export interface PrStatus {
  url: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  state: PrState;
  reviewers: Reviewers;
  checks: Checks;
  /** Null for a merged or closed PR. */
  readiness: Readiness | null;
}

export interface PrEntry {
  ref: PrRef;
  /** The last status read; kept when a later read fails. */
  status: PrStatus | null;
  /** When `status` was read (ISO). */
  readAt: string | null;
  /** Why the last read failed, if it did. */
  error: string | null;
}

export interface SessionView {
  sessionId: string;
  pulls: PrEntry[];
  /** Why GitHub is left alone now (no gh, expired login, rate-limit pause). */
  blocked: string | null;
}
