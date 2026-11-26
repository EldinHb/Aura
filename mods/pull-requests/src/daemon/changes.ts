// Pull request changes for the inbox (former aura-review changes.rs). Each
// refresh of the review inbox compares the PRs the user follows (authored, asked
// to review, reviewed, or linked to a session) with the previous refresh and
// records what changed as one inbox entry per PR.
//
// What was last seen of each PR is kept per account, so a restart does not
// report anything twice. The first refresh of an account only records where
// things stand. The user's own actions are never reported; neither are comments
// by bots (CI and coverage reports). Reviews by bots are, marked as such.
import type { Storage } from "@aura/mod-sdk";
import type { PullChange, PullEvent, PullRequest } from "@aura/github-client";
import { activityOf, type ReadPull } from "./github";
import { eqi, newId, nowIso } from "./util";

/** What was last seen of an account's PRs; one kv key per account. */
export const SNAPSHOT_KEY = "pulls.snapshots.v1.";
/** Inbox entries, one document each, per account (a collection). */
export const ENTRIES = "pull-changes:";
/** Entries kept per account; the oldest read ones go first. */
const KEEP = 300;
/** Read entries are dropped after this many days. */
const KEEP_READ_DAYS = 30;
/** A PR no refresh has listed for this many days is forgotten. */
const FORGET_DAYS = 30;
/** Review states that mean a reviewer responded. */
const RESPONSES = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"];
const DAY = 24 * 60 * 60 * 1000;

/** Why the user follows a PR, in order of precedence. */
export const ROLES = ["requested", "authored", "reviewed", "linked"] as const;

export interface Snapshots {
  /** When the account's first refresh ran; review requests from before then are history. */
  since: string;
  /** By `PullRequest.id`. */
  pulls: Record<string, Snapshot>;
}

/** What was last seen of one PR. */
export interface Snapshot {
  repo: string;
  number: number;
  role: string;
  /** open | closed | merged */
  state: string;
  head_sha: string;
  commits: number;
  checks: string;
  /** The latest check rollup that had finished: SUCCESS, FAILURE or ERROR. */
  finished_checks: string;
  /** The latest merge state GitHub had worked out; never UNKNOWN. */
  merge_state: string;
  review_requested_at: string | null;
  /** Highest GitHub ids already seen. */
  seen_review: number;
  seen_comment: number;
  seen_thread: number;
  /** Listed by the latest refresh. A PR that leaves the lists is read once more, to learn whether it was merged or closed. */
  tracked: boolean;
  /** When a refresh last listed it. */
  seen_at: string;
}

const emptySnapshot = (): Snapshot => ({
  repo: "",
  number: 0,
  role: "",
  state: "",
  head_sha: "",
  commits: 0,
  checks: "",
  finished_checks: "",
  merge_state: "",
  review_requested_at: null,
  seen_review: 0,
  seen_comment: 0,
  seen_thread: 0,
  tracked: false,
  seen_at: "",
});

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** Fields of `raw` that have `base`'s type, over `base` (serde's `#[serde(default)]`). */
function defaults<T extends object>(base: T, raw: unknown): T {
  const out: any = { ...base };
  if (!isObject(raw)) return out;
  for (const [k, v] of Object.entries(base)) {
    const given = raw[k];
    if (given === undefined) continue;
    if (v === null ? given === null || typeof given === "string" : typeof given === typeof v) out[k] = given;
  }
  return out;
}

/** What was last seen of `account`'s PRs; null before its first refresh, or when unreadable. */
export async function load(storage: Storage, account: string): Promise<Snapshots | null> {
  let raw: unknown;
  try {
    raw = await storage.kv.get(`${SNAPSHOT_KEY}${account}`);
  } catch (e) {
    console.warn(`reading pull request snapshots failed: ${e}`);
    return null;
  }
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw) || (raw.pulls !== undefined && !isObject(raw.pulls))) {
    console.warn("pull request snapshots unreadable, taking a new baseline");
    return null;
  }
  const pulls: Record<string, Snapshot> = {};
  for (const [id, s] of Object.entries(raw.pulls ?? {})) pulls[id] = defaults(emptySnapshot(), s);
  return { since: typeof raw.since === "string" ? raw.since : "", pulls };
}

export async function save(storage: Storage, account: string, snapshots: Snapshots): Promise<void> {
  await storage.kv.set(`${SNAPSHOT_KEY}${account}`, snapshots);
}

const sameId = (list: Array<[string, number]>, repo: string, number: number) =>
  list.some(([r, n]) => eqi(r, repo) && n === number);

/** Open PRs the previous refresh followed and this one does not (`listed`): read once more. */
export function leavers(snapshots: Snapshots, listed: Array<[string, number]>): Array<[string, number]> {
  return Object.keys(snapshots.pulls)
    .sort()
    .map((k) => snapshots.pulls[k])
    .filter((s) => s.tracked && s.state === "open" && !sameId(listed, s.repo, s.number))
    .map((s) => [s.repo, s.number] as [string, number]);
}

const finished = (checks: string) => checks === "SUCCESS" || checks === "FAILURE" || checks === "ERROR";
const failing = (checks: string) => checks === "FAILURE" || checks === "ERROR";
const optMax = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : a > b ? a : b);
/** `a > b` with None below every Some, as Rust orders `Option`. */
const optGt = (a: string | null, b: string | null) => a !== null && (b === null || a > b);

/** `pull` as seen now, keeping from `before` what this read does not tell. */
export function snapshot(pull: ReadPull, role: string, before: Snapshot | null): Snapshot {
  const b = before ?? emptySnapshot();
  const a = activityOf(pull);
  const max = (seen: number, ids: number[]) => ids.reduce((m, id) => Math.max(m, id), seen);
  return {
    repo: pull.repo,
    number: pull.number,
    role,
    state: pull.state,
    head_sha: pull.head_sha,
    commits: a.commits,
    checks: pull.checks,
    finished_checks: finished(pull.checks) ? pull.checks : b.finished_checks,
    merge_state: pull.merge_state === "" || pull.merge_state === "UNKNOWN" ? b.merge_state : pull.merge_state,
    review_requested_at: optMax(pull.review_requested_at ?? null, b.review_requested_at),
    seen_review: max(
      b.seen_review,
      a.reviews.map((r) => r.id),
    ),
    seen_comment: max(
      b.seen_comment,
      a.comments.map((c) => c.id),
    ),
    seen_thread: max(
      b.seen_thread,
      a.thread_comments.map((c) => c.id),
    ),
    tracked: true,
    seen_at: nowIso(),
  };
}

function event(kind: string, actor: string, detail: string): PullEvent {
  return { kind, actor, bot: false, detail, count: 1, review_id: 0, text: "" };
}

/**
 * What changed on `pull` since `before`, leaving out what `me` did. Checks and
 * mergeability are reported only on PRs the user authored or linked to a session.
 */
export function diff(before: Snapshot, pull: ReadPull, role: string, me: string): PullEvent[] {
  const isMe = (login: string) => login !== "" && eqi(login, me);
  const a = activityOf(pull);
  const open = pull.state === "open";
  const events: PullEvent[] = [];
  if (before.state !== "" && pull.state !== before.state && !isMe(a.state_actor)) {
    events.push(event("state", a.state_actor, open ? "reopened" : pull.state));
  }
  if (open && before.head_sha !== "" && pull.head_sha !== before.head_sha && !a.pushed_by.some(isMe)) {
    const e = event("commits", a.pushed_by[0] ?? "", "");
    e.count = Math.max(a.commits - before.commits, 0, 1);
    events.push(e);
  }
  const reviewers: string[] = [];
  for (const r of a.reviews) {
    if (r.id <= before.seen_review || isMe(r.reviewer) || eqi(r.reviewer, pull.author) || !RESPONSES.includes(r.state)) {
      continue;
    }
    reviewers.push(r.reviewer.toLowerCase());
    events.push({ ...event("review", r.reviewer, r.state), bot: r.bot, review_id: r.id });
  }
  // Inline comments that come with a review are part of it.
  const fresh = [
    ...a.comments.filter((c) => c.id > before.seen_comment),
    ...a.thread_comments.filter((c) => c.id > before.seen_thread && !reviewers.includes(c.author.toLowerCase())),
  ].filter((c) => !c.bot && c.author !== "" && !isMe(c.author));
  const commenters: PullEvent[] = [];
  for (const c of fresh) {
    const e = commenters.find((e) => eqi(e.actor, c.author));
    if (e) e.count += 1;
    else commenters.push(event("comment", c.author, ""));
  }
  events.push(...commenters);
  const requestedAt = pull.review_requested_at ?? null;
  if (open && role === "requested" && requestedAt !== null && optGt(requestedAt, before.review_requested_at)) {
    events.push(event("review_requested", "", ""));
  }
  if (open && (role === "authored" || role === "linked")) {
    if (failing(pull.checks) && (!failing(before.checks) || pull.head_sha !== before.head_sha)) {
      events.push(event("checks", "", pull.checks));
    } else if (pull.checks === "SUCCESS" && failing(before.finished_checks)) {
      events.push(event("checks", "", "SUCCESS"));
    }
    const [was, is] = [before.merge_state, pull.merge_state];
    if (is === "DIRTY" && was !== "" && was !== "DIRTY") {
      events.push(event("mergeable", "", "conflicts"));
    } else if ((is === "CLEAN" || is === "HAS_HOOKS") && ["DIRTY", "BLOCKED", "BEHIND"].includes(was)) {
      events.push(event("mergeable", "", "clean"));
    }
  }
  return events;
}

/**
 * A PR the user had not followed before. Only a request for their review is news:
 * a PR they opened, reviewed or linked was their own doing.
 */
export function arrived(pull: PullRequest, role: string, since: string): PullEvent[] {
  const at = pull.review_requested_at;
  const requestedAfter = at != null && at > since;
  return role === "requested" && pull.state === "open" && requestedAfter ? [{ ...event("review_requested", "", "") }] : [];
}

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/** The events in a line: `bob pushed 2 commits · alice approved · checks failed`. */
export function summary(events: PullEvent[]): string {
  return events.map(describe).join(" · ");
}

/** Put each event in words. */
function label(events: PullEvent[]): void {
  for (const e of events) e.text = describe(e);
}

function describe(e: PullEvent): string {
  const who = e.bot ? `${e.actor} (bot)` : e.actor;
  const by = (text: string) => (e.actor === "" ? text : `${text} by ${who}`);
  switch (e.kind) {
    case "commits":
      return e.actor === "" ? plural(e.count, "new commit", "new commits") : `${who} pushed ${plural(e.count, "commit", "commits")}`;
    case "review":
      return `${who} ${e.detail === "APPROVED" ? "approved" : e.detail === "CHANGES_REQUESTED" ? "requested changes" : "reviewed"}`;
    case "comment":
      return e.count > 1 ? `${who} left ${e.count} comments` : `${who} commented`;
    case "review_requested":
      return "your review was requested";
    case "checks":
      return e.detail === "SUCCESS" ? "checks pass again" : "checks failed";
    case "state":
      return by(e.detail);
    case "mergeable":
      return e.detail === "conflicts" ? "has merge conflicts" : "ready to merge";
    default:
      return e.kind.replaceAll("_", " ");
  }
}

/**
 * Add `fresh` to `events`: counts of pushes and comments add up, and a later review,
 * check result, state or mergeability replaces the earlier one.
 */
function merge(events: PullEvent[], fresh: PullEvent[]): void {
  for (const e of fresh) {
    const i = events.findIndex(
      (x) => x.kind === e.kind && (["commits", "comment", "review"].includes(e.kind) ? eqi(x.actor, e.actor) : true),
    );
    if (i < 0) events.push({ ...e });
    else if (e.kind === "commits" || e.kind === "comment") events[i].count += e.count;
    else events[i] = { ...e };
  }
}

const emptyChange = (): PullChange => ({
  id: "",
  account: "",
  pull_id: "",
  repo: "",
  number: 0,
  title: "",
  url: "",
  role: "",
  events: [],
  summary: "",
  created_at: "",
  read: false,
});
const emptyEvent = (): PullEvent => event("", "", "");

/** A stored entry, read the way serde reads one from an older or newer daemon. */
function readChange(raw: unknown): PullChange | null {
  if (!isObject(raw)) return null;
  const c = defaults(emptyChange(), raw);
  c.events = (Array.isArray(raw.events) ? raw.events : []).filter(isObject).map((e) => defaults(emptyEvent(), e));
  return c;
}

const entriesOf = (storage: Storage, account: string) => storage.collection<PullChange>(`${ENTRIES}${account}`);

/** An account's entries, latest first. */
export async function entries(storage: Storage, account: string): Promise<PullChange[]> {
  const list = (await entriesOf(storage, account).all())
    .map(([, raw]) => readChange(raw))
    .filter((c): c is PullChange => c !== null);
  return list.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
}

const put = (storage: Storage, entry: PullChange) => entriesOf(storage, entry.account).put(entry.id, entry);

/**
 * Record the changes found on one refresh: into the PR's unread entry if it has one,
 * else a new entry. Returns each entry as the user should hear of it now: its id with
 * only the events just found.
 */
export async function record(storage: Storage, account: string, found: PullChange[]): Promise<PullChange[]> {
  if (found.length === 0) return [];
  const existing = await entries(storage, account);
  const news: PullChange[] = [];
  for (const change of found) {
    const fresh = change.events.map((e) => ({ ...e }));
    let entry = existing.find((e) => !e.read && e.pull_id === change.pull_id);
    if (entry) {
      merge(entry.events, fresh);
      label(entry.events);
      entry.title = change.title;
      entry.role = change.role;
      entry.created_at = change.created_at;
      entry.summary = summary(entry.events);
    } else {
      change.summary = summary(change.events);
      entry = { ...change, events: change.events.map((e) => ({ ...e })) };
      existing.push(entry);
    }
    await put(storage, entry);
    news.push({ ...change, id: entry.id, summary: summary(fresh) });
  }
  await prune(storage, account, existing);
  return news;
}

async function prune(storage: Storage, account: string, list: PullChange[]): Promise<void> {
  const cutoff = new Date(Date.now() - KEEP_READ_DAYS * DAY).toISOString();
  // Unread first, then the latest.
  const sorted = [...list].sort(
    (a, b) => Number(a.read) - Number(b.read) || (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0),
  );
  for (const [i, e] of sorted.entries()) {
    if (i >= KEEP || (e.read && e.created_at < cutoff)) await entriesOf(storage, account).delete(e.id);
  }
}

/** Mark the entries `ids` read, or every entry when `ids` is null. Returns whether any changed. */
export async function markRead(storage: Storage, account: string, ids: string[] | null): Promise<boolean> {
  let changed = false;
  for (const e of await entries(storage, account)) {
    if (!e.read && (ids === null || ids.includes(e.id))) {
      e.read = true;
      await put(storage, e);
      changed = true;
    }
  }
  return changed;
}

/**
 * One refresh's worth of PRs, as read: `[pull, role]` for each PR GitHub returned.
 * Returns the updated snapshots and the changes to record. The first refresh of an
 * account (`snapshots` null) only takes the baseline.
 */
export function detect(
  snapshots: Snapshots | null,
  read: Array<[ReadPull, string]>,
  leaving: Array<[string, number]>,
  me: string,
): [Snapshots, PullChange[]] {
  const baseline = snapshots === null;
  const snaps: Snapshots = snapshots
    ? { since: snapshots.since, pulls: { ...snapshots.pulls } }
    : { since: nowIso(), pulls: {} };
  const ts = nowIso();
  const found: PullChange[] = [];
  for (const [pull, given] of read) {
    const before = snaps.pulls[pull.id] ?? null;
    // A PR that left the lists keeps the reason it was followed for.
    const role = before && given === "" ? before.role : given;
    const events = baseline ? [] : before ? diff(before, pull, role, me) : arrived(pull, role, snaps.since);
    const next = snapshot(pull, role, before);
    if (sameId(leaving, pull.repo, pull.number)) {
      next.tracked = false;
      next.seen_at = before ? before.seen_at : next.seen_at;
    }
    snaps.pulls[pull.id] = next;
    label(events);
    if (events.length > 0) {
      found.push({
        id: newId(),
        account: pull.account,
        pull_id: pull.id,
        repo: pull.repo,
        number: pull.number,
        title: pull.title,
        url: pull.url,
        role,
        summary: summary(events),
        events,
        created_at: ts,
        read: false,
      });
    }
  }
  // Leavers GitHub could not read stop being read too.
  for (const [repo, number] of leaving) {
    const key = Object.keys(snaps.pulls)
      .sort()
      .find((k) => {
        const s = snaps.pulls[k];
        return eqi(s.repo, repo) && s.number === number && s.tracked;
      });
    if (key === undefined) continue;
    const s = snaps.pulls[key];
    if (!read.some(([p]) => p.id === `${s.repo}#${s.number}`)) snaps.pulls[key] = { ...s, tracked: false };
  }
  const forget = new Date(Date.now() - FORGET_DAYS * DAY).toISOString();
  for (const [k, s] of Object.entries(snaps.pulls)) if (!(s.seen_at >= forget)) delete snaps.pulls[k];
  return [snaps, found];
}
