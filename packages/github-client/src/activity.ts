// PR activity reads (former aura-github activity.rs). Times are ISO-8601 strings.
import type { Github } from "./github";

/** The highest ids a reader saw of a PR, per kind. All null for a first look. */
export interface Since {
  reviews: number | null;
  comments: number | null;
  conversation: number | null;
}

/** A PR as read: its node, complete back to what the reader saw, and when it was read. */
export interface Read {
  node: any;
  at: string;
}

/** [read at, updated at] of a PR's last read (former `LastRead`). */
export type LastRead = [string, string];

export async function read(gh: Github, prs: Array<[string, number, Since]>): Promise<Array<Read | Error>> {
  throw new Error("not ported yet: read");
}

export function due(read: LastRead | null, notified: Notified | null, repo: string, number: number, now: string): boolean {
  throw new Error("not ported yet: due");
}

export function dueClosed(read: string | null, notified: Notified | null, repo: string, number: number, now: string): boolean {
  throw new Error("not ported yet: dueClosed");
}

/** Recent notification threads of PRs. Crosses RPC as `toJSON()` / `Notified.fromJSON`. */
export class Notified {
  constructor(
    /** "owner/repo#number" (lowercase) -> latest activity (ISO). */
    public pulls: Record<string, string> = {},
    /** The list holds one page: before this, threads may be missing. */
    public completeSince: string | null = null,
  ) {}

  /** Read a page of `GET /notifications` that asked for `page` threads. */
  static parse(rows: unknown, page: number): Notified | null {
    throw new Error("not ported yet: Notified.parse");
  }

  changed(repo: string, number: number, read: string): boolean {
    throw new Error("not ported yet: Notified.changed");
  }

  toJSON() {
    return { pulls: this.pulls, completeSince: this.completeSince };
  }

  static fromJSON(v: { pulls: Record<string, string>; completeSince: string | null } | null): Notified | null {
    return v ? new Notified(v.pulls, v.completeSince) : null;
  }
}

/** Answers shared between loops that read the same PRs. */
export class Memo {
  private kept = new Map<string, { value: unknown; at: string; stored: number }>();

  recall(key: string, withinMs: number): [any, string] | null {
    throw new Error("not ported yet: Memo.recall");
  }

  keep(key: string, value: unknown, at: string): void {
    throw new Error("not ported yet: Memo.keep");
  }
}
