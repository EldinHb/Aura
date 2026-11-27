// Keeps the PRs someone is looking at up to date. The UI half `watch`es the session its
// Inspector shows; each tick reads only the watched PRs that are due, in one batched query.
import type { BranchStatus, DaemonApi, Session } from "@aura/mod-sdk";
import { messageOf, type Github, type Notified } from "@aura/github-client";
import type { PrEntry, PrRef, PrStatus, SessionView } from "../shared/types";
import { collectPulls, prKey, sessionTree, type SessionPrs } from "./collect";
import { readStatuses } from "./status";

export const TICK_MS = 5_000;
/** A viewer that has not renewed its watch for this long has gone away. */
export const LEASE_MS = 90_000;
export const POLL_MS = 60_000;
/** While checks run or GitHub is still computing mergeability. */
export const FAST_POLL_MS = 20_000;
export const MAX_BACKOFF_MS = 15 * 60_000;
/** A session tree's PRs are collected again after this long, or at once on a change. */
export const COLLECT_TTL_MS = 60_000;
/** A branch's PR is looked up again after this long, or at once when the branch moves. */
export const BRANCH_TTL_MS = 5 * 60_000;

/** How often a PR is read: fast while something is about to change, never once merged or closed. */
export function baseDelay(status: PrStatus | null): number {
  if (!status) return POLL_MS;
  if (status.state === "merged" || status.state === "closed") return Infinity;
  if (status.checks.state === "pending" || status.readiness?.reasons.includes("unknown")) return FAST_POLL_MS;
  return POLL_MS;
}

/** The wait before the next read: the paced one, or after failures a doubling back-off up to MAX_BACKOFF_MS. */
export function nextDelay(base: number, paced: number, failures: number): number {
  if (failures <= 0) return paced;
  return Math.min(Math.max(paced, base * 2 ** failures), MAX_BACKOFF_MS);
}

interface Entry {
  ref: PrRef;
  status: PrStatus | null;
  readAt: number | null;
  error: string | null;
  failures: number;
  nextAt: number;
  /** Merged or closed when last read: not read again unless asked to. */
  final: boolean;
}

export type GithubCall = (name: string, params?: unknown) => Promise<any>;

export interface PollerDeps {
  aura: DaemonApi;
  gh: Github;
  /** Calls the github mod. */
  github: GithubCall;
  now?: () => number;
}

export class PrPoller {
  private readonly aura: DaemonApi;
  private readonly gh: Github;
  private readonly github: GithubCall;
  private readonly now: () => number;
  private viewers = new Map<string, { sessionId: string; until: number }>();
  private entries = new Map<string, Entry>();
  private trees = new Map<string, { refs: PrRef[]; at: number }>();
  private branches = new Map<string, { stamp: string; url: string | null; at: number }>();
  private repos = new Map<string, string | null>();
  private forced = new Set<string>();
  private blocked: string | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(deps: PollerDeps) {
    this.aura = deps.aura;
    this.gh = deps.gh;
    this.github = deps.github;
    this.now = deps.now ?? Date.now;
  }

  /** `viewer` shows `sessionId`; with `refresh` (the section just became visible) its PRs are read now. */
  async watch(viewer: string, sessionId: string, refresh: boolean): Promise<SessionView> {
    this.viewers.set(viewer, { sessionId, until: this.now() + LEASE_MS });
    if (refresh) {
      const refs = await this.refsOf(sessionId);
      // A PR read moments ago (another viewer, the previous tick) is fresh enough.
      for (const ref of refs) {
        const e = this.entries.get(prKey(ref.url));
        if (!e?.final && !(e?.readAt && this.now() - e.readAt < TICK_MS * 2)) this.forced.add(prKey(ref.url));
      }
    }
    await this.tick();
    return this.view(sessionId);
  }

  unwatch(viewer: string): void {
    this.viewers.delete(viewer);
  }

  /** Collect the session's PRs again and read every one of them now, merged and closed ones too. */
  async refresh(sessionId: string): Promise<SessionView> {
    this.trees.delete(sessionId);
    for (const ref of await this.refsOf(sessionId)) this.forced.add(prKey(ref.url));
    await this.tick();
    return this.view(sessionId);
  }

  /** Sessions or links changed: collect the watched trees again on the next tick. */
  invalidate(): void {
    this.trees.clear();
  }

  /** What is known of the session's PRs, without reading GitHub. */
  async view(sessionId: string): Promise<SessionView> {
    const refs = await this.refsOf(sessionId);
    const pulls = refs.map((ref): PrEntry => {
      const e = this.entries.get(prKey(ref.url));
      return { ref, status: e?.status ?? null, readAt: e?.readAt ? new Date(e.readAt).toISOString() : null, error: e?.error ?? null };
    });
    return { sessionId, pulls, blocked: this.blocked };
  }

  /** One round, after any running one: read the watched PRs that are due. */
  tick(): Promise<void> {
    const run = this.queue.then(() => this.round());
    this.queue = run.catch(() => {});
    return run;
  }

  /** Tick every TICK_MS until the returned function is called. */
  launch(): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      if (stopped) return;
      await this.tick().catch((e) => console.warn(`PR status: ${messageOf(e)}`));
      if (!stopped) timer = setTimeout(loop, TICK_MS);
    };
    timer = setTimeout(loop, TICK_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }

  private async round(): Promise<void> {
    const now = this.now();
    for (const [viewer, w] of this.viewers) if (w.until <= now) this.viewers.delete(viewer);
    const watched = [...new Set([...this.viewers.values()].map((w) => w.sessionId))];
    if (watched.length === 0) return;

    const changed = new Set<string>();
    const before = new Map(watched.map((id) => [id, this.trees.get(id)?.refs]));
    const trees = new Map<string, PrRef[]>();
    for (const id of watched) {
      trees.set(id, await this.refsOf(id));
      if (!sameRefs(before.get(id), trees.get(id)!)) changed.add(id);
    }

    const blocked = await this.gh.blocked().catch((e) => messageOf(e));
    if (blocked !== this.blocked) {
      this.blocked = blocked;
      watched.forEach((id) => changed.add(id));
    }
    if (blocked) return this.announce(changed);

    const visible = new Map<string, PrRef>();
    for (const refs of trees.values()) for (const ref of refs) visible.set(prKey(ref.url), ref);
    const notified = await this.gh.notified().catch(() => null);
    const due = [...visible.entries()].filter(([key, ref]) => this.isDue(key, ref, notified, now)).map(([, ref]) => ref);
    for (const ref of due) this.forced.delete(prKey(ref.url));

    if (due.length) {
      const read = await readStatuses(this.gh, due);
      const paced = new Map<number, number>();
      const pace = async (base: number) => {
        if (!Number.isFinite(base)) return base;
        if (!paced.has(base)) paced.set(base, await this.gh.pace(base).catch(() => base));
        return paced.get(base)!;
      };
      const at = this.now();
      for (const [i, ref] of due.entries()) {
        const key = prKey(ref.url);
        const old = this.entries.get(key);
        const result = read[i];
        const entry: Entry = { ref, status: old?.status ?? null, readAt: old?.readAt ?? null, error: null, failures: 0, nextAt: 0, final: false };
        if (result instanceof Error) {
          entry.error = result.message;
          entry.failures = (old?.failures ?? 0) + 1;
        } else {
          entry.status = result;
          entry.readAt = at;
          entry.final = result.state === "merged" || result.state === "closed";
        }
        const base = baseDelay(entry.error ? null : entry.status);
        entry.nextAt = at + nextDelay(base, await pace(base), entry.failures);
        this.entries.set(key, entry);
      }
      const keys = new Set(due.map((r) => prKey(r.url)));
      for (const [id, refs] of trees) if (refs.some((r) => keys.has(prKey(r.url)))) changed.add(id);
    }
    this.announce(changed);
  }

  private isDue(key: string, ref: PrRef, notified: Notified | null, now: number): boolean {
    if (this.forced.has(key)) return true;
    const e = this.entries.get(key);
    if (!e) return true;
    if (e.final) return false;
    if (now >= e.nextAt) return true;
    return !!notified && e.readAt !== null && notified.changed(ref.repo, ref.number, new Date(e.readAt).toISOString());
  }

  private announce(sessionIds: Set<string>): void {
    if (sessionIds.size) this.aura.emit("changed", { sessionIds: [...sessionIds] });
  }

  /** The session tree's PRs, collected again once COLLECT_TTL_MS old or invalidated. */
  private async refsOf(sessionId: string): Promise<PrRef[]> {
    const saved = this.trees.get(sessionId);
    if (saved && this.now() - saved.at < COLLECT_TTL_MS) return saved.refs;
    const refs = await this.collect(sessionId);
    this.trees.set(sessionId, { refs, at: this.now() });
    return refs;
  }

  private async collect(sessionId: string): Promise<PrRef[]> {
    const tree = sessionTree(await this.aura.sessions.list(), sessionId);
    if (tree.length === 0) return [];
    const [linked, links] = await Promise.all([
      this.github("sessions.prs", {}).catch((e) => warn("linked PRs", e, {})),
      this.github("links.all", {}).catch((e) => warn("session links", e, {})),
    ]);
    const branch = new Map<string, string | null>();
    // Branch lookups are GitHub reads; while GitHub is blocked the ones known stay.
    for (const { session } of tree) branch.set(session.id, await this.branchPull(session));
    const prsOf = (id: string): SessionPrs => ({
      linked: strings(linked?.[id]),
      pulls: strings(links?.[id]?.pulls),
      branch: branch.get(id) ?? null,
    });
    return collectPulls(tree, prsOf);
  }

  /** The URL of the PR opened from the session's current branch, if any. */
  private async branchPull(session: Session): Promise<string | null> {
    if (session.folderless || !session.cwd) return null;
    const cwd = session.cwd;
    try {
      const git = (await this.aura.git.branchStatus(cwd)) as BranchStatus | null;
      const branch = git?.upstream_branch ?? git?.branch;
      if (!branch) return null;
      const stamp = `${branch}|${git?.upstream_repo ?? ""}|${git?.head ?? ""}|${git?.ahead ?? 0}`;
      const saved = this.branches.get(cwd);
      if (saved && saved.stamp === stamp && this.now() - saved.at < BRANCH_TTL_MS) return saved.url;
      if (this.blocked) return saved?.url ?? null;
      if (!this.repos.has(cwd)) this.repos.set(cwd, (await this.github("repo", { cwd })) ?? null);
      const repo = this.repos.get(cwd);
      if (!repo) return null;
      const pull = await this.github("branch_pull", { repo, head_repo: git?.upstream_repo ?? repo, branch });
      const url = typeof pull?.url === "string" ? pull.url : null;
      this.branches.set(cwd, { stamp, url, at: this.now() });
      return url;
    } catch (e) {
      return warn(`the branch PR of ${cwd}`, e, this.branches.get(cwd)?.url ?? null);
    }
  }
}

function warn<T>(what: string, e: unknown, fallback: T): T {
  console.warn(`PR status: could not read ${what}: ${messageOf(e)}`);
  return fallback;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function sameRefs(a: PrRef[] | undefined, b: PrRef[]): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b);
}
