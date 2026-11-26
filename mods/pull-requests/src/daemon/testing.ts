// Test stand-ins for @aura/github-client, whose functions the daemon reaches
// through `Lib`. The pure ones (`due`, `dueClosed`, `rejected`, `Notified.changed`)
// follow the former aura-github exactly; the network ones answer from a test's
// own fake. Only tests import this file.
import type { Session } from "@aura/mod-sdk";
import { Notified, type Github, type LastRead, type PullRequest } from "@aura/github-client";
import type { Lib } from "./github";

const FULL_POLL = 5 * 60_000;
const ACTIVE = 60 * 60_000;
const CLOSED_POLL = 30 * 60_000;
const SKEW = 2 * 60_000;

/** `Notified` with aura-github's `changed`. */
export class TestNotified extends Notified {
  changed(repo: string, number: number, read: string): boolean {
    const since = Date.parse(read) - SKEW;
    if (this.completeSince !== null && since < Date.parse(this.completeSince)) return true;
    const at = this.pulls[`${repo.toLowerCase()}#${number}`];
    return at !== undefined && Date.parse(at) > since;
  }
}

export function due(read: LastRead | null, notified: Notified | null, repo: string, number: number, now: string): boolean {
  if (!read) return true;
  const [at, updated] = read;
  if (Date.parse(now) - Date.parse(at) >= FULL_POLL) return true;
  if (notified) return notified.changed(repo, number, at);
  return Date.parse(now) - Date.parse(updated) < ACTIVE;
}

export function dueClosed(read: string | null, notified: Notified | null, repo: string, number: number, now: string): boolean {
  if (read === null) return true;
  return Date.parse(now) - Date.parse(read) >= CLOSED_POLL || (!!notified && notified.changed(repo, number, read));
}

export function rejected(e: unknown): boolean {
  const x = e as { rejected?: boolean; rateLimited?: boolean } | null;
  return !!x && (x.rejected === true || x.rateLimited === true);
}

/** GitHub refused a request (as `RejectedRequest` does). */
export function refusal(message: string): Error {
  return Object.assign(new Error(message), { rejected: true });
}

const unexpected = (name: string) => async () => {
  throw new Error(`unexpected ${name}`);
};

/** A `Lib` whose network functions fail unless `over` gives them. */
export function testLib(over: Partial<Lib> = {}): Lib {
  return {
    pull: unexpected("pull"),
    pulls: unexpected("pulls"),
    requested: async () => [],
    reviewed: async () => [],
    authored: async () => [],
    timeline: unexpected("timeline"),
    legacyLists: () => [[], [], []],
    projects: async () => [],
    merge: unexpected("merge"),
    deleteBranch: unexpected("deleteBranch"),
    pages: async (gh: Github, path: string) => {
      const sep = path.includes("?") ? "&" : "?";
      const rows = await gh.request("GET", `${path}${sep}per_page=100&page=1`);
      if (!Array.isArray(rows)) throw new Error("Expected a GitHub list");
      return rows;
    },
    branchPull: async () => null,
    read: unexpected("read"),
    due,
    dueClosed,
    rejected,
    ...over,
  };
}

/** A transport that answers `request` with `answer` and the rest from fields a test sets. */
export class TestGithub implements Github {
  login = "me";
  blockedBy: string | null = null;
  notifiedNow: Notified | null = null;
  requests = 0;
  constructor(public answer: (method: string, path: string, body?: unknown) => any = () => undefined) {}
  async request(method: string, path: string, body?: unknown): Promise<any> {
    this.requests++;
    if (method === "GET" && path === "user") return { login: this.login };
    const v = await this.answer(method, path, body);
    if (v === undefined) throw new Error(`Unexpected request ${method} ${path}`);
    return v;
  }
  requestFor(_account: string, method: string, path: string, body?: unknown): Promise<any> {
    return this.request(method, path, body);
  }
  async diff(): Promise<string> {
    throw new Error("unexpected diff");
  }
  host(): string {
    return "github.com";
  }
  async account(): Promise<string> {
    this.requests++;
    return `github.com:${this.login}`;
  }
  async blocked(): Promise<string | null> {
    return this.blockedBy;
  }
  async pace(baseMs: number): Promise<number> {
    return baseMs;
  }
  async notified(): Promise<Notified | null> {
    return this.notifiedNow;
  }
  memo() {
    return null;
  }
}

export const LOGIN_EXPIRED = "GitHub login expired. Run `gh auth login` to sign in again.";

/** A pull request with every field, empty unless `over` sets it. */
export function pullRequest(over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: "",
    account: "",
    repo: "",
    number: 0,
    title: "",
    body: "",
    url: "",
    author: "",
    state: "",
    draft: false,
    base_ref: "",
    head_ref: "",
    base_sha: "",
    head_sha: "",
    updated_at: "",
    created_at: "",
    additions: 0,
    deletions: 0,
    changed_files: 0,
    checks: "",
    review_decision: "",
    hidden: false,
    can_edit: false,
    assignees: [],
    labels: [],
    milestone: null,
    milestone_title: "",
    my_review: null,
    reviews: [],
    requested: [],
    unanswered_threads: 0,
    review_requested_at: null,
    merge_state: "",
    merge_methods: [],
    default_merge_method: "",
    can_merge: false,
    can_delete_branch: false,
    auto_delete_branch: false,
    merge_blocked_by: null,
    ...over,
  };
}

/** A structured Claude session, idle, last active `minutes` after a fixed start. */
export function session(id: string, over: Partial<Session> = {}, minutes = 0): Session {
  const at = new Date(Date.UTC(2026, 9, 1, 10, minutes)).toISOString();
  return {
    id,
    provider: "claude",
    agent: null,
    native_id: null,
    cwd: "/tmp",
    worktree: null,
    title: id,
    group: null,
    status: "idle",
    mode: "structured",
    model: null,
    effort: null,
    permission_mode: null,
    sandbox_mode: null,
    command: null,
    created_at: at,
    last_activity: at,
    archived: false,
    pinned: false,
    usage: {},
    last_error: null,
    pending_count: 0,
    exit_code: null,
    system_prompt: null,
    orchestrator: false,
    orchestrator_id: null,
    feature_owner: false,
    specialist_id: null,
    specialist_name: null,
    folderless: false,
    pulls: [],
    attention: null,
    scheduled_task_id: null,
    scheduled_task_name: null,
    ...over,
  } as unknown as Session;
}

/** The github mod's session links, as a test sets them. */
export class TestLinks {
  prs: Record<string, string[]> = {};
  muted = new Set<string>();
  recorded: Array<{ sessionId: string; url: string }> = [];
  serve = (name: string, p: any): unknown => {
    switch (name) {
      case "sessions.prs":
        return this.prs;
      case "session.prs":
        return this.prs[p.sessionId] ?? [];
      case "session.followsReviews":
        return !this.muted.has(p.sessionId);
      case "pulls.record":
        this.recorded.push(p);
        this.prs[p.sessionId] = [...(this.prs[p.sessionId] ?? []), p.url];
        return true;
      default:
        throw new Error(`unexpected github mod call ${name}`);
    }
  };
}
