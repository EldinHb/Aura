// What the PR page (`pr` view) shows, as the daemon half's `page.get` and `page.files` send it.
import type { PrStatus } from "./types";

export interface Label {
  name: string;
  /** Hex, without "#". */
  color: string;
}

export interface CommentNote {
  author: string;
  body: string;
  at: string;
  url: string;
}

/** A review comment on a line: the file, the line and the diff lines above it. */
export interface LineComment extends CommentNote {
  path: string;
  line: number | null;
  /** The last lines of the hunk, ending at the commented line. */
  snippet: string[];
}

export type TimelineItem =
  | ({ kind: "comment" } & CommentNote)
  /** `moreComments`: line comments GitHub has beyond the ones read (shown as a link to GitHub). */
  | ({ kind: "review"; state: string; comments: LineComment[]; moreComments: number } & CommentNote)
  | { kind: "commit"; at: string; author: string; sha: string; message: string; url: string }
  | { kind: "force_push"; at: string; actor: string; before: string; after: string }
  | { kind: "review_requested"; at: string; actor: string; reviewer: string }
  | { kind: "labeled" | "unlabeled"; at: string; actor: string; label: Label }
  | { kind: "merged"; at: string; actor: string; sha: string; base: string }
  | { kind: "closed" | "reopened" | "ready_for_review" | "converted_to_draft"; at: string; actor: string };

export interface PageCommit {
  sha: string;
  short: string;
  message: string;
  author: string;
  at: string;
  url: string;
}

export interface PageCheck {
  name: string;
  /** The workflow of a check run, if any. */
  workflow: string;
  state: "passing" | "failing" | "pending" | "skipped";
  /** "Success", "Failure", "In progress", … as GitHub words it. */
  label: string;
  /** Seconds from start to end; null while running or for a status. */
  seconds: number | null;
  url: string | null;
}

export interface PrPage {
  repo: string;
  number: number;
  url: string;
  title: string;
  author: string;
  createdAt: string;
  body: string;
  base: string;
  head: string;
  /** The commits compared: the files and the merge box are for exactly these. */
  baseSha: string;
  headSha: string;
  /** `owner/repo` of the head branch; differs from `repo` for a fork. */
  headRepo: string;
  commitCount: number;
  changedFiles: number;
  additions: number;
  deletions: number;
  assignees: string[];
  labels: Label[];
  milestone: { title: string; url: string } | null;
  timeline: TimelineItem[];
  commits: PageCommit[];
  checks: PageCheck[];
  /** Comments and review comments, as GitHub counts them on the Conversation tab. */
  commentCount: number;
  /** State, reviewers, checks, readiness and merge facts: the same read the cards use. */
  status: PrStatus;
  /** False when a list had more than was read (timeline, commits, checks, a review's comments). */
  complete: boolean;
  readAt: string;
  /** When to read again, paced by the rate-limit budget. */
  nextMs: number;
}

export interface PageFile {
  path: string;
  /** The former path of a renamed file. */
  previous: string | null;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  /** The unified diff hunks, or null when GitHub sends none (binary, or too large). */
  patch: string | null;
}
