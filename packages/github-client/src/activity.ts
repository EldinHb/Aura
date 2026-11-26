// PR activity reads (former aura-github activity.rs). Times are ISO-8601 strings.
//
// Reviews, inline comments and conversation of many PRs, a batch per GraphQL query, for the
// loops that look for new activity: review follow-ups and review watches. Notifications tell
// which PRs changed, so the rest are read on a slower schedule.
import { buffered, chunks, databaseId, list, messageOf, show, type Github } from "./github";
import { batchNodes } from "./pulls";

/** A PR is read at least this often, whatever notifications say. */
export const FULL_POLL_MS = 5 * 60_000;
/** Without notifications, a PR updated within this long is read every pass, others every FULL_POLL. */
export const ACTIVE_MS = 60 * 60_000;
/** A closed PR, which can be reopened, is read this often unless a notification says it changed. */
export const CLOSED_POLL_MS = 30 * 60_000;
/** GitHub's API can show activity a little after its notification; a PR stays due this long after one. */
const SKEW_MS = 2 * 60_000;
/** How long one loop's read serves another loop. */
export const SHARED_FOR_MS = 30_000;
const BATCH = 20;

const REVIEW = " fragment review on PullRequestReview{fullDatabaseId state body url submittedAt author{__typename login}}";
const COMMENT = " fragment comment on IssueComment{fullDatabaseId body url author{__typename login}}";
const INLINE = " fragment inline on PullRequestReviewComment{fullDatabaseId body url path line originalLine author{__typename login}}";
const THREADS = "{pageInfo{hasNextPage endCursor} nodes{id comments(last:50){pageInfo{hasPreviousPage startCursor} nodes{...inline}}}}";

function fragment(): string {
  return (
    "fragment pull on PullRequest{id number title url state updatedAt author{login} " +
    "reviews(last:50){pageInfo{hasPreviousPage startCursor} nodes{...review}} " +
    "comments(last:50){pageInfo{hasPreviousPage startCursor} nodes{...comment}} " +
    `reviewThreads(first:50)${THREADS}}${REVIEW}${COMMENT}${INLINE}`
  );
}

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

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const ms = (iso: string) => Date.parse(iso);

/**
 * Read `prs` (`owner/repo`, number, what the reader saw), a batch per query. A PR GitHub
 * cannot return is an Error in its slot; a query that fails as a whole rejects.
 */
export async function read(gh: Github, prs: Array<[string, number, Since]>): Promise<Array<Read | Error>> {
  // Shared answers are the account's: another login may see other PRs.
  const memo = gh.memo();
  let account: string | null = null;
  if (memo) account = await gh.account().catch(() => null);
  const shared = memo && account !== null ? { memo, account } : null;
  const key = (account: string, repo: string, number: number) => `activity:${account}:${repo.toLowerCase()}#${number}`;
  const out: Array<Read | Error | undefined> = prs.map(([repo, number]) => {
    if (!shared) return undefined;
    const kept = shared.memo.recall(key(shared.account, repo, number), SHARED_FOR_MS);
    return kept ? { node: kept[0], at: kept[1] } : undefined;
  });
  const missing: Array<[string, number]> = prs.filter((_, i) => out[i] === undefined).map(([repo, number]) => [repo, number]);
  const frag = fragment();
  const batches = await buffered(chunks(missing, BATCH), 3, async (chunk) => {
    const at = new Date().toISOString();
    const nodes = await batchNodes(gh, chunk, "", {}, "", frag);
    return nodes.map((n): Read | Error => (n instanceof Error ? n : { node: n[1], at }));
  });
  const fetched = batches.flat()[Symbol.iterator]();
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== undefined) continue;
    const next = fetched.next();
    out[i] = next.done ? undefined : next.value;
  }
  const reads: Array<Read | Error> = [];
  for (let i = 0; i < prs.length; i++) {
    const [repo, number, since] = prs[i];
    const r = out[i];
    if (r === undefined) throw new Error("GitHub returned too few pull requests");
    if (r instanceof Error) {
      reads.push(r);
      continue;
    }
    try {
      await complete(gh, r.node, since);
      reads.push(r);
    } catch (e) {
      reads.push(new Error(`Unable to read ${repo}#${number}: ${messageOf(e)}`));
    }
  }
  // Kept only when the login did not change meanwhile.
  if (shared && (await gh.account().catch(() => null)) === shared.account) {
    prs.forEach(([repo, number], i) => {
      const r = reads[i];
      if (!(r instanceof Error)) shared.memo.keep(key(shared.account, repo, number), r.node, r.at);
    });
  }
  return reads;
}

/**
 * Fill in what the first page left out: older reviews and comments down to what the reader
 * saw, and every review thread, since any of them can get a reply.
 */
async function complete(gh: Github, node: any, since: Since): Promise<void> {
  for (const field of ["reviews", "comments", "reviewThreads"]) whole(node?.[field]);
  for (const thread of list(node?.reviewThreads?.nodes)) whole(thread?.comments);
  const id = node?.id;
  if (typeof id !== "string") throw new Error("Pull request without id");
  await older(gh, id, "PullRequest", "reviews", "...review", REVIEW, node.reviews, since.reviews);
  await older(gh, id, "PullRequest", "comments", "...comment", COMMENT, node.comments, since.conversation);
  while (node.reviewThreads?.pageInfo?.hasNextPage === true) {
    const cursor = node.reviewThreads.pageInfo.endCursor ?? null;
    const query = `query($id:ID!,$cursor:String){node(id:$id){... on PullRequest{reviewThreads(first:50,after:$cursor)${THREADS}}}}${INLINE}`;
    const p = await page(gh, query, id, cursor, "reviewThreads");
    append(node.reviewThreads, p, false);
  }
  for (const thread of list(node.reviewThreads?.nodes)) {
    const threadId = typeof thread?.id === "string" ? thread.id : "";
    await older(gh, threadId, "PullRequestReviewThread", "comments", "...inline", INLINE, thread.comments, since.comments);
  }
}

/** Prepend older pages of the connection `field` of node `id` while its oldest item is newer than `since`. */
async function older(
  gh: Github,
  id: string,
  on: string,
  field: string,
  spread: string,
  frag: string,
  conn: any,
  since: number | null,
): Promise<void> {
  if (since === null) return;
  while (conn?.pageInfo?.hasPreviousPage === true && oldest(conn) > since) {
    const cursor = conn.pageInfo.startCursor ?? null;
    const query = `query($id:ID!,$cursor:String){node(id:$id){... on ${on}{${field}(last:100,before:$cursor){pageInfo{hasPreviousPage startCursor} nodes{${spread}}}}}}${frag}`;
    const p = await page(gh, query, id, cursor, field);
    append(conn, p, true);
  }
}

function oldest(conn: any): number {
  let min = Number.MAX_SAFE_INTEGER;
  for (const n of list(conn?.nodes)) {
    const id = databaseId(n);
    if (id !== null && id < min) min = id;
  }
  return min;
}

async function page(gh: Github, query: string, id: string, cursor: unknown, field: string): Promise<any> {
  const r = await gh.request("POST", "graphql", { query, variables: { id, cursor } });
  const p = r?.data?.node?.[field];
  // A page with errors may lack items whose ids the watermarks would then pass.
  const errors = r?.errors;
  if (!p || typeof p !== "object" || Array.isArray(p) || (Array.isArray(errors) && errors.length > 0)) {
    throw new Error(`Unable to read more ${field}: ${show(errors)}`);
  }
  whole(p);
  if (field === "reviewThreads") for (const thread of list(p.nodes)) whole(thread?.comments);
  return p;
}

/** A connection GitHub answered in full: a list of nodes, none of them missing. */
function whole(conn: any): void {
  const nodes = conn?.nodes;
  if (!Array.isArray(nodes)) throw new Error("GitHub left out a list");
  if (nodes.some((n) => !n || typeof n !== "object" || Array.isArray(n))) throw new Error("GitHub left out part of a list");
}

/** Add `page` to `conn`, before its nodes when `before`, and take its page info. */
function append(conn: any, p: any, before: boolean): void {
  const nodes = list(p?.nodes);
  const had = list(conn?.nodes);
  conn.nodes = before ? [...nodes, ...had] : [...had, ...nodes];
  conn.pageInfo = p?.pageInfo ?? null;
}

/**
 * Whether a PR last read at `read` (and updated at `updated`) is read again now: after
 * FULL_POLL in any case, else when a notification says it changed, or without
 * notifications while it is active.
 */
export function due(read: LastRead | null, notified: Notified | null, repo: string, number: number, now: string): boolean {
  if (!read) return true;
  const [readAt, updated] = read;
  if (ms(now) - ms(readAt) >= FULL_POLL_MS) return true;
  if (notified) return notified.changed(repo, number, readAt);
  return ms(now) - ms(updated) < ACTIVE_MS;
}

/** Whether a closed PR last read at `read` is read again now, to notice it was reopened. */
export function dueClosed(read: string | null, notified: Notified | null, repo: string, number: number, now: string): boolean {
  if (!read) return true;
  return ms(now) - ms(read) >= CLOSED_POLL_MS || (!!notified && notified.changed(repo, number, read));
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
    if (!Array.isArray(rows)) return null;
    const pulls: Record<string, number> = {};
    let oldest: number | null = null;
    for (const row of rows) {
      const updated = row?.updated_at;
      if (typeof updated !== "string") return null;
      const at = Date.parse(updated);
      if (Number.isNaN(at)) return null;
      oldest = oldest === null ? at : Math.min(oldest, at);
      if (row?.subject?.type !== "PullRequest") continue;
      const url = row?.subject?.url;
      if (typeof url !== "string") continue;
      const cut = url.indexOf("/repos/");
      if (cut < 0) continue;
      const [owner, name, kind, number] = url.slice(cut + "/repos/".length).split("/");
      if (owner === undefined || name === undefined || kind === undefined || number === undefined || kind !== "pulls") continue;
      const id = `${owner}/${name}#${number}`.toLowerCase();
      pulls[id] = Math.max(pulls[id] ?? at, at);
    }
    const iso = (t: number) => new Date(t).toISOString();
    return new Notified(
      Object.fromEntries(Object.entries(pulls).map(([k, t]) => [k, iso(t)])),
      rows.length >= page && oldest !== null ? iso(oldest) : null,
    );
  }

  /** Whether the PR may have changed since `read`. */
  changed(repo: string, number: number, read: string): boolean {
    const since = ms(read) - SKEW_MS;
    if (this.completeSince !== null && since < ms(this.completeSince)) return true;
    const at = this.pulls[`${repo.toLowerCase()}#${number}`];
    return at !== undefined && ms(at) > since;
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

  /** The value kept under `key` and when it was read, while younger than `withinMs`. */
  recall(key: string, withinMs: number): [any, string] | null {
    const k = this.kept.get(key);
    if (!k || Date.now() - k.stored >= withinMs) return null;
    return [clone(k.value), k.at];
  }

  /**
   * Keep `value`, read at `at`. Its age counts from `at`, so a read kept again (filled in
   * further, or passed on) is shared for a while after GitHub gave it, not longer.
   */
  keep(key: string, value: unknown, at: string): void {
    const now = Date.now();
    const age = Math.max(0, now - ms(at)) || 0;
    for (const [k, v] of this.kept) if (now - v.stored >= SHARED_FOR_MS) this.kept.delete(k);
    this.kept.set(key, { value: clone(value), at, stored: now - age });
  }
}
