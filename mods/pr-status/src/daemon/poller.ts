// Keeps the PRs someone is looking at up to date. The UI half `watch`es the session its
// Inspector shows; each tick reads only the watched PRs that are due, in one batched query,
// then looks up a few branch PRs from its discovery queue.
import type { DaemonApi, Session } from "@aura/mod-sdk";
import { messageOf, type Github, type Notified } from "@aura/github-client";
import type { PrEntry, PrRef, PrStatus, SessionView } from "../shared/types";
import { branchPull, branchQuestion, readBranch, readRemotes, type BranchQuestion } from "./branch";
import { collectPulls, prKey, sessionTree, type SessionPrs } from "./collect";
import type { Sources } from "./sources";
import { readStatuses } from "./status";

export const TICK_MS = 5_000;
/** A viewer that has not renewed its watch for this long has gone away. */
export const LEASE_MS = 90_000;
export const POLL_MS = 60_000;
/** While checks run or GitHub is still computing mergeability. */
export const FAST_POLL_MS = 20_000;
/** A closed PR can be reopened; without a notification it is looked at this often. */
export const CLOSED_POLL_MS = 15 * 60_000;
export const MAX_BACKOFF_MS = 15 * 60_000;
/** A session tree's PRs are collected again after this long, or at once on a change. */
export const COLLECT_TTL_MS = 60_000;
/** A branch's PR is looked up again after this long, or at once when the branch moves. */
export const BRANCH_TTL_MS = 5 * 60_000;
/** A branch lookup that failed is tried again after this long. */
export const BRANCH_RETRY_MS = 60_000;
/** Branch lookups per round, at most. */
export const DISCOVERY_PER_TICK = 2;
/** Rounds with lookups are this far apart at least, stretched by `api.pace`, whoever runs the round. */
export const DISCOVERY_GAP_MS = 5_000;
/** What no watched tree holds and nobody looked at for this long is forgotten; each cache keeps at most MAX_CACHED of those. */
export const RETAIN_MS = 10 * 60_000;
export const MAX_CACHED = 200;
/** Notifications are dated by GitHub's clock; one this much older than a read may still be news to it. */
const NOTIFY_SKEW_MS = 2 * 60_000;

/** How often a PR is read: fast while something is about to change, slowly once closed, never once merged. */
export function baseDelay(status: PrStatus | null): number {
  if (!status) return POLL_MS;
  if (status.state === "merged") return Infinity;
  if (status.state === "closed") return CLOSED_POLL_MS;
  if (status.checks.state === "pending" || status.readiness?.reasons.includes("unknown")) return FAST_POLL_MS;
  return POLL_MS;
}

/** The wait before the next read: the paced one, and after failures at least a doubling back-off (up to MAX_BACKOFF_MS). */
export function nextDelay(base: number, paced: number, failures: number): number {
  if (failures <= 0) return paced;
  return Math.max(paced, Math.min(base * 2 ** failures, MAX_BACKOFF_MS));
}

interface Entry {
  ref: PrRef;
  status: PrStatus | null;
  readAt: number | null;
  error: string | null;
  failures: number;
  nextAt: number;
  /** Merged when last read: not read again unless asked to. */
  final: boolean;
  /** The latest notification (its time) this PR was read after; a newer one reads it again. */
  noted: string | null;
  /** When a watched tree last held it. */
  seen: number;
}

/** Where to look for a session folder's branch PR. */
interface BranchTarget {
  cwd: string;
  question: BranchQuestion;
  /** Branch, upstream and head: a lookup for another stamp answers another question. */
  stamp: string;
  /** The folder's epoch when queued; a folder dropped from the queue meanwhile has a newer one. */
  epoch: number;
}

/** A collected tree: its PRs, and its sessions' folders (for the branch caches it keeps in use). */
interface Tree {
  refs: PrRef[];
  folders: string[];
}

interface BranchFound {
  branch: string;
  stamp: string;
  url: string | null;
  at: number;
  failed: boolean;
  used: number;
}

/** PR statuses kept in storage for instant cards after a restart, at most this many (latest seen). */
export const MAX_STORED = 300;

/** A PR's last status as kept in storage. */
interface StoredPull {
  ref: PrRef;
  status: PrStatus;
  readAt: number;
  seen: number;
}

export interface PollerDeps {
  aura: DaemonApi;
  gh: Github;
  /** The sessions' detected, linked and hidden PRs. */
  sources: Sources;
  now?: () => number;
}

export class PrPoller {
  private readonly aura: DaemonApi;
  private readonly gh: Github;
  private readonly sources: Sources;
  private readonly now: () => number;
  /** Branch PRs and PR statuses read back from storage: rounds and views wait for it. */
  private readonly ready: Promise<void>;
  private readonly storedBranches;
  private readonly storedPulls;
  /**
   * Who looks at which session: the Inspector of a selected session (polled), or, in the
   * background, a session open in a tab (kept, not polled: read again when shown).
   */
  private viewers = new Map<string, { sessionId: string; until: number; background: boolean }>();
  /** Bumped whenever a viewer starts, stops or switches sessions: a round that collected for older watches starts over. */
  private watchRevision = 0;
  private entries = new Map<string, Entry>();
  private trees = new Map<string, Tree & { at: number }>();
  /** Bumped by every invalidation: a collection started before one is not kept. */
  private generation = 0;
  private collecting = new Map<string, { generation: number; tree: Promise<Tree> }>();
  private branches = new Map<string, BranchFound>();
  /** `git remote -v` of each folder (its github.com repositories by remote name). */
  private repos = new Map<string, { remotes: Record<string, string>; at: number; used: number }>();
  /** Branch lookups waiting, by folder; the latest target of a folder wins. */
  private discovery = new Map<string, BranchTarget>();
  private discoverAt = 0;
  /** Bumped when a folder leaves the discovery queue unanswered: its lookup running then is obsolete. */
  private epochs = new Map<string, number>();
  /** Folders of the sessions in watched trees, so a removed session's caches can go. */
  private folders = new Map<string, string>();
  private forced = new Set<string>();
  /** Sessions whose last reply was scanned for PR URLs since the daemon started. */
  private scanned = new Set<string>();
  /** Stored statuses, by when they were last seen (for MAX_STORED). */
  private storedSeen = new Map<string, number>();
  private blocked: string | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(deps: PollerDeps) {
    this.aura = deps.aura;
    this.gh = deps.gh;
    this.sources = deps.sources;
    this.now = deps.now ?? Date.now;
    this.storedBranches = this.aura.storage.collection<BranchFound>("branches");
    this.storedPulls = this.aura.storage.collection<StoredPull>("pulls");
    this.ready = this.restore().catch((e) => console.warn(`PR status: could not read what was kept: ${messageOf(e)}`));
  }

  /**
   * `viewer` shows `sessionId`; with `refresh` (the section just became visible) its PRs are
   * read now. A `background` viewer (the session is open in a tab, not shown) only keeps what
   * is known of the session from being forgotten; nothing is read for it, and nothing returned.
   */
  async watch(viewer: string, sessionId: string, refresh: boolean, background = false): Promise<SessionView | null> {
    const before = this.viewers.get(viewer);
    if (before?.sessionId !== sessionId || before.background !== background) this.watchRevision++;
    this.viewers.set(viewer, { sessionId, until: this.now() + LEASE_MS, background });
    if (background) return null;
    if (refresh) {
      const refs = await this.refsOf(sessionId);
      // A PR read moments ago (another viewer, the previous tick) is fresh enough; a closed one
      // is looked at again, as it may have been reopened.
      for (const ref of refs) {
        const e = this.entries.get(prKey(ref.url));
        if (!e?.final && !(e?.readAt && this.now() - e.readAt < TICK_MS * 2)) this.forced.add(prKey(ref.url));
      }
    }
    await this.tick();
    return this.view(sessionId);
  }

  unwatch(viewer: string): void {
    if (this.viewers.delete(viewer)) this.watchRevision++;
  }

  /** Collect the session's PRs again and read every one of them now, merged ones too. */
  async refresh(sessionId: string): Promise<SessionView> {
    this.invalidate();
    for (const ref of await this.refsOf(sessionId)) this.forced.add(prKey(ref.url));
    await this.tick();
    return this.view(sessionId);
  }

  /** Sessions or links changed: collections running now are dropped, and the watched trees collected again. */
  invalidate(): void {
    this.generation++;
    this.trees.clear();
  }

  /** A session is gone: forget its tree, its watches and its folder's branch caches. */
  forgetSession(sessionId: string): void {
    this.invalidate();
    for (const [viewer, w] of this.viewers) if (w.sessionId === sessionId) this.unwatch(viewer);
    const cwd = this.folders.get(sessionId);
    this.folders.delete(sessionId);
    if (cwd && ![...this.folders.values()].includes(cwd)) {
      this.branches.delete(cwd);
      this.repos.delete(cwd);
      this.dropTarget(cwd);
    }
    void this.cleanStored().catch((e) => console.warn(`PR status: ${messageOf(e)}`));
  }

  /** Read back the branch PRs and PR statuses kept from before a restart; forget folders no session uses. */
  private async restore(): Promise<void> {
    const now = this.now();
    await this.sources.ready;
    for (const [key, p] of await this.storedPulls.all()) {
      this.entries.set(key, { ref: p.ref, status: p.status, readAt: p.readAt, error: null, failures: 0, nextAt: 0, final: p.status.state === "merged", noted: null, seen: now });
      this.storedSeen.set(key, p.seen);
    }
    for (const [cwd, found] of await this.storedBranches.all()) this.branches.set(cwd, { ...found, used: now });
    await this.cleanStored();
    await this.trimStored();
  }

  /** Stored branch PRs of folders no session works in any more. */
  private async cleanStored(): Promise<void> {
    const cwds = new Set((await this.aura.sessions.list()).map((s) => s.cwd));
    for (const [cwd] of await this.storedBranches.all()) {
      if (cwds.has(cwd)) continue;
      this.branches.delete(cwd);
      await this.storedBranches.delete(cwd);
    }
  }

  /** Keep the stored statuses within MAX_STORED, the least recently seen going first. */
  private async trimStored(): Promise<void> {
    const over = this.storedSeen.size - MAX_STORED;
    if (over <= 0) return;
    for (const [key] of [...this.storedSeen].sort(([, a], [, b]) => a - b).slice(0, over)) {
      this.storedSeen.delete(key);
      await this.storedPulls.delete(key);
    }
  }

  /** What is known of the session's PRs, without reading GitHub. */
  async view(sessionId: string): Promise<SessionView> {
    await this.ready;
    const refs = await this.refsOf(sessionId);
    const pulls = refs.map((ref): PrEntry => {
      const e = this.entries.get(prKey(ref.url));
      return { ref, status: e?.status ?? null, readAt: e?.readAt ? new Date(e.readAt).toISOString() : null, error: e?.error ?? null };
    });
    return { sessionId, pulls, blocked: this.blocked };
  }

  /** One round, after any running one: read the watched PRs that are due, then a few branch lookups. */
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

  /** How many PRs, branch lookups and folders are remembered; for tests. */
  cached() {
    return {
      entries: this.entries.size, branches: this.branches.size, repos: this.repos.size, trees: this.trees.size,
      queued: this.discovery.size, folders: this.folders.size,
    };
  }

  private async round(): Promise<void> {
    await this.ready;
    const now = this.now();
    let watched: string[];
    let changed: Set<string>;
    let trees: Map<string, PrRef[]>;
    let folders: Set<string>;
    let kept: Set<string>;
    // Collecting waits on other mods; a selection that changes meanwhile must not be pruned
    // with the folders of the watches before it, so the collection starts over.
    for (;;) {
      for (const [viewer, w] of this.viewers) if (w.until <= now) this.unwatch(viewer);
      const revision = this.watchRevision;
      const viewers = [...this.viewers.values()];
      watched = [...new Set(viewers.filter((w) => !w.background).map((w) => w.sessionId))];
      kept = new Set(viewers.map((w) => w.sessionId));
      for (const id of this.trees.keys()) if (!kept.has(id)) this.trees.delete(id);
      changed = new Set<string>();
      trees = new Map<string, PrRef[]>();
      folders = new Set<string>();
      for (const id of watched) {
        const before = this.trees.get(id)?.refs;
        const tree = await this.treeOf(id);
        trees.set(id, tree.refs);
        tree.folders.forEach((f) => folders.add(f));
        if (!sameRefs(before, tree.refs)) changed.add(id);
      }
      if (revision === this.watchRevision) break;
    }
    // What the watched trees hold is in use, GitHub blocked or not; only the rest may be forgotten.
    // So is what is known of sessions open in the background, as last collected (not collected again).
    const active = new Set<string>();
    for (const refs of trees.values()) for (const ref of refs) active.add(prKey(ref.url));
    for (const id of kept) {
      const tree = trees.has(id) ? null : this.trees.get(id);
      tree?.refs.forEach((ref) => active.add(prKey(ref.url)));
      tree?.folders.forEach((f) => folders.add(f));
    }
    for (const key of active) {
      const e = this.entries.get(key);
      if (e) e.seen = now;
    }
    this.prune(folders);
    this.evict(now, active, folders);
    if (watched.length === 0) return;

    // Without a PR on screen no PR is read, and no notification or gh check asked for; only a
    // watched session's branch may still be looked up (its PR is what would show).
    const visible = new Map<string, PrRef>();
    for (const refs of trees.values()) for (const ref of refs) visible.set(prKey(ref.url), ref);
    if (visible.size === 0) {
      this.announce(changed);
      return this.discover();
    }

    const blocked = await this.gh.blocked().catch((e) => messageOf(e));
    if (blocked !== this.blocked) {
      this.blocked = blocked;
      watched.forEach((id) => changed.add(id));
    }
    if (blocked) return this.announce(changed);

    const notified = await this.gh.notified().catch(() => null);
    const due = [...visible.entries()].filter(([key, ref]) => this.isDue(key, ref, notified, now)).map(([, ref]) => ref);
    for (const ref of due) this.forced.delete(prKey(ref.url));

    if (due.length) {
      // Whose permissions the read shows; a merge is later made as this account only.
      const account = await this.gh.account().catch(() => "");
      const read = await readStatuses(this.gh, due);
      for (const r of read) if (!(r instanceof Error)) r.merge.account = account;
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
        const entry: Entry = {
          ref, status: old?.status ?? null, readAt: old?.readAt ?? null, error: null, failures: 0, nextAt: 0, final: false,
          // This read covers every notification known now, failed or not: a failed read is retried on its schedule.
          noted: notified?.pulls[notifyKey(ref)] ?? old?.noted ?? null,
          seen: at,
        };
        if (result instanceof Error) {
          entry.error = result.message;
          entry.failures = (old?.failures ?? 0) + 1;
        } else {
          entry.status = result;
          entry.readAt = at;
          entry.final = result.state === "merged";
        }
        const base = baseDelay(entry.error ? null : entry.status);
        entry.nextAt = at + nextDelay(base, await pace(base), entry.failures);
        this.entries.set(key, entry);
        if (entry.status && entry.readAt === at) {
          this.storedSeen.set(key, at);
          await this.storedPulls.put(key, { ref, status: entry.status, readAt: at, seen: at });
        }
      }
      await this.trimStored();
      const keys = new Set(due.map((r) => prKey(r.url)));
      for (const [id, refs] of trees) if (refs.some((r) => keys.has(prKey(r.url)))) changed.add(id);
    }
    this.announce(changed);
    await this.discover();
  }

  private isDue(key: string, ref: PrRef, notified: Notified | null, now: number): boolean {
    if (this.forced.has(key)) return true;
    const e = this.entries.get(key);
    if (!e) return true;
    if (e.final) return false;
    if (now >= e.nextAt) return true;
    // After a failure the retry waits for its back-off, notification or not.
    if (e.failures > 0) return false;
    // Each notification reads the PR once: one already handled, or older than the last read, does not.
    const at = notified?.pulls[notifyKey(ref)];
    if (!at || at === e.noted) return false;
    return e.readAt === null || Date.parse(at) > e.readAt - NOTIFY_SKEW_MS;
  }

  private announce(sessionIds: Set<string>): void {
    if (sessionIds.size) this.aura.emit("changed", { sessionIds: [...sessionIds] });
  }

  /** The session tree's PRs. */
  private async refsOf(sessionId: string): Promise<PrRef[]> {
    return (await this.treeOf(sessionId)).refs;
  }

  /**
   * The session tree: collected again once COLLECT_TTL_MS old or invalidated, one collection
   * at a time. Every caller, also one joining a running collection, gets a tree collected
   * after the latest invalidation: a collection that started before one is run again.
   */
  private treeOf(sessionId: string): Promise<Tree> {
    const saved = this.trees.get(sessionId);
    if (saved && this.now() - saved.at < COLLECT_TTL_MS) return Promise.resolve(saved);
    const running = this.collecting.get(sessionId);
    if (running && running.generation === this.generation) return running.tree;
    const generation = this.generation;
    const tree: Promise<Tree> = this.collect(sessionId)
      .then((found) => {
        // Invalidated meanwhile: these links may be older than the change.
        if (generation !== this.generation) return this.treeOf(sessionId);
        this.trees.set(sessionId, { ...found, at: this.now() });
        return found;
      })
      .finally(() => {
        if (this.collecting.get(sessionId)?.tree === tree) this.collecting.delete(sessionId);
      });
    this.collecting.set(sessionId, { generation, tree });
    return tree;
  }

  /** The tree's PRs from what is known now: its links, and the branch PRs found so far (others are queued). */
  private async collect(sessionId: string): Promise<Tree> {
    const tree = sessionTree(await this.aura.sessions.list(), sessionId);
    if (tree.length === 0) return { refs: [], folders: [] };
    // A session first seen since the daemon started: its last reply may name a PR from before.
    for (const { session } of tree) {
      if (this.scanned.has(session.id)) continue;
      this.scanned.add(session.id);
      const reply = await this.aura.sessions.lastReply(session.id).catch(() => null);
      if (reply) await this.sources.detect(session.id, reply);
    }
    const branch = new Map<string, string | null>();
    for (const { session } of tree) {
      const url = await this.knownBranchPull(session);
      branch.set(session.id, url && !this.sources.isHidden(session.id, url) ? url : null);
    }
    const prsOf = (id: string): SessionPrs => ({ linked: this.sources.linkedOf(id), pulls: [], branch: branch.get(id) ?? null });
    const folders = tree.flatMap(({ session }) => (session.folderless || !session.cwd ? [] : [session.cwd]));
    return { refs: collectPulls(tree, prsOf), folders };
  }

  /** The PR known for the session's current branch; queues a lookup when there is none yet or it is old. */
  private async knownBranchPull(session: Session): Promise<string | null> {
    if (session.folderless || !session.cwd) return null;
    const cwd = session.cwd;
    this.folders.set(session.id, cwd);
    let question: BranchQuestion | null;
    try {
      const git = await readBranch(this.aura.process.run, cwd);
      question = git ? branchQuestion(git, await this.remotesOf(cwd)) : null;
    } catch (e) {
      return warn(`the branch of ${cwd}`, e, null);
    }
    if (!question) return null;
    const { branch, stamp } = question;
    const found = this.branches.get(cwd);
    const now = this.now();
    if (found) found.used = now;
    const fresh = found && found.stamp === stamp && now - found.at < (found.failed ? BRANCH_RETRY_MS : BRANCH_TTL_MS);
    // The same question already queued (or being looked up) stays as it is.
    if (!fresh && this.discovery.get(cwd)?.stamp !== stamp) {
      this.discovery.set(cwd, { cwd, question, stamp, epoch: this.epochs.get(cwd) ?? 0 });
    }
    // Until the lookup answers, the PR found for the same branch still stands.
    return found && found.branch === branch ? found.url : null;
  }

  /** Look up a few queued branch PRs, paced; a new answer has the trees collected again. */
  private async discover(): Promise<void> {
    if (this.discovery.size === 0 || this.blocked || this.now() < this.discoverAt) return;
    const batch = [...this.discovery.values()].slice(0, DISCOVERY_PER_TICK);
    let found = false;
    for (const target of batch) {
      const before = this.branches.get(target.cwd);
      const answer = await this.lookUp(target);
      const branch = target.question.branch;
      // The branch moved meanwhile (another stamp queued), or the folder left the queue: obsolete.
      const queued = this.discovery.get(target.cwd);
      if (!queued || queued.stamp !== target.stamp || (this.epochs.get(target.cwd) ?? 0) !== target.epoch) continue;
      this.discovery.delete(target.cwd);
      const result = { ...answer, branch, stamp: target.stamp, at: this.now(), used: this.now() };
      this.branches.set(target.cwd, result);
      await this.storedBranches.put(target.cwd, result);
      if (answer.url !== (before?.branch === branch ? before.url : null)) found = true;
    }
    this.discoverAt = this.now() + (await this.gh.pace(DISCOVERY_GAP_MS).catch(() => DISCOVERY_GAP_MS));
    if (found) this.invalidate();
  }

  private async lookUp(target: BranchTarget): Promise<{ url: string | null; failed: boolean }> {
    const previous = this.branches.get(target.cwd);
    const keep = previous && previous.branch === target.question.branch ? previous.url : null;
    try {
      return { url: await branchPull(this.gh, target.question), failed: false };
    } catch (e) {
      return { url: warn(`the branch PR of ${target.cwd}`, e, keep), failed: true };
    }
  }

  /** The folder's github.com remotes, read again after BRANCH_TTL_MS. */
  private async remotesOf(cwd: string): Promise<Record<string, string>> {
    const now = this.now();
    const saved = this.repos.get(cwd);
    if (saved && now - saved.at < BRANCH_TTL_MS) {
      saved.used = now;
      return saved.remotes;
    }
    const remotes = await readRemotes(this.aura.process.run, cwd);
    this.repos.set(cwd, { remotes, at: now, used: now });
    return remotes;
  }

  /** Sessions working on `url`: linking or mentioning it, or with it as their branch's PR. */
  async sessionsOf(url: string): Promise<string[]> {
    await this.ready;
    const ids = new Set(this.sources.sessionsOf(url));
    for (const s of await this.aura.sessions.list()) {
      const found = s.cwd ? this.branches.get(s.cwd) : undefined;
      if (found?.url && prKey(found.url) === prKey(url) && !this.sources.isHidden(s.id, url)) ids.add(s.id);
    }
    return [...ids];
  }

  /** Drop a folder's queued lookup; one running for it now is not kept. */
  private dropTarget(cwd: string): void {
    if (!this.discovery.delete(cwd)) return;
    this.epochs.set(cwd, (this.epochs.get(cwd) ?? 0) + 1);
  }

  /** Only folders of watched trees are looked up and remembered as a session's. */
  private prune(folders: Set<string>): void {
    for (const cwd of [...this.discovery.keys()]) if (!folders.has(cwd)) this.dropTarget(cwd);
    for (const [id, cwd] of this.folders) if (!folders.has(cwd)) this.folders.delete(id);
    for (const cwd of [...this.epochs.keys()]) if (!folders.has(cwd)) this.epochs.delete(cwd);
  }

  /**
   * Forget what no watched tree holds (`active` PRs, `folders`) once unused for RETAIN_MS, and
   * the oldest of it beyond MAX_CACHED. What is in use stays, however much there is.
   */
  private evict(now: number, active: Set<string>, folders: Set<string>): void {
    const keep = <V>(map: Map<string, V>, inUse: Set<string>, used: (v: V) => number, drop?: (key: string) => void) => {
      const idle = [...map].filter(([key]) => !inUse.has(key));
      const gone = idle.filter(([, v]) => now - used(v) >= RETAIN_MS);
      const left = idle.filter(([, v]) => now - used(v) < RETAIN_MS).sort(([, a], [, b]) => used(a) - used(b));
      for (const [key] of [...gone, ...left.slice(0, Math.max(0, left.length - MAX_CACHED))]) {
        map.delete(key);
        drop?.(key);
      }
    };
    keep(this.entries, active, (e) => e.seen, (key) => this.forced.delete(key));
    keep(this.branches, folders, (b) => b.used);
    keep(this.repos, folders, (r) => r.used);
  }
}

const notifyKey = (ref: Pick<PrRef, "repo" | "number">) => `${ref.repo.toLowerCase()}#${ref.number}`;

function warn<T>(what: string, e: unknown, fallback: T): T {
  console.warn(`PR status: could not read ${what}: ${messageOf(e)}`);
  return fallback;
}


function sameRefs(a: PrRef[] | undefined, b: PrRef[]): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b);
}
