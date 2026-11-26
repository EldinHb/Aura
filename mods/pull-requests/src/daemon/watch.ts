// Review watches (former aura-review watch.rs): the daemon looks at the watched
// pull requests once a minute and reports every approval, change request and
// comment-only review by the watched reviewers. Plain GitHub reads, all
// watches in one GraphQL query, of the PRs that are due; no agent is involved.
import type { Collection, DaemonApi } from "@aura/mod-sdk";
import type { Github, LastRead, PrWatch, Since, WatchedReview } from "@aura/github-client";
import type { Gh, Lib } from "./github";
import { Lock, Tasks, context, databaseId, eqi, fail, loginOf, message, nowIso, prNumber, str, validRepo } from "./util";

export const NAMESPACE = "pr-watches";
export const POLL_INTERVAL_MS = 60_000;
/** Review states that mean a reviewer responded. PENDING is an unsubmitted draft and DISMISSED was withdrawn by someone else. */
const RESPONSES = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"];

export const watchId = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;

export class WatchService implements Gh {
  watches: PrWatch[] = [];
  /** Serializes polls so two passes cannot report the same review twice. */
  private pollGate = new Lock();
  /** Watch id -> when its PR was last read, and last updated then. */
  reads = new Map<string, LastRead>();
  private store: Collection<PrWatch>;

  constructor(
    private aura: DaemonApi,
    public gh: Github,
    public lib: Lib,
    private tasks: Tasks,
  ) {
    this.store = aura.storage.collection<PrWatch>(NAMESPACE);
  }

  async load(): Promise<void> {
    this.watches = (await this.store.all()).map(([, w]) => w).filter((w) => w && typeof w === "object");
  }

  launch(): void {
    this.tasks.spawn("review watches", async () => {
      while (!this.tasks.stopped) {
        await this.tasks.sleep(await this.gh.pace(POLL_INTERVAL_MS).catch(() => POLL_INTERVAL_MS));
        if (this.tasks.stopped) break;
        await this.poll(false).catch((e) => console.warn(`review watches: ${message(e)}`));
      }
    });
  }

  list(): PrWatch[] {
    return [...this.watches].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  }

  private changed(): void {
    this.aura.emit("watches.changed", {});
  }

  private async save(watch: PrWatch): Promise<void> {
    await this.store.put(watch.id, watch);
    this.watches = this.watches.filter((w) => w.id !== watch.id);
    this.watches.push(watch);
  }

  methods(): Record<string, (p: any) => Promise<unknown>> {
    return {
      "watches.list": async () => this.list(),
      "watches.candidates": async (p) => {
        const [repo, number] = target(p);
        return this.candidates(repo, number);
      },
      "watches.start": async (p) => {
        const [repo, number] = target(p);
        return this.start(repo, number, logins(p?.reviewers), logins(p?.request));
      },
      "watches.remove": async (p) => {
        const id = p?.id;
        if (typeof id !== "string") fail("Missing id", "invalid");
        await this.store.delete(id);
        this.watches = this.watches.filter((w) => w.id !== id);
        this.changed();
        return true;
      },
      "watches.check": async () => {
        await this.poll(true);
        return this.list();
      },
    };
  }

  /** Everything the watch dialog offers: who is requested, who already reviewed, and who could be requested. */
  async candidates(repo: string, number: number): Promise<unknown> {
    const base = `repos/${repo}/pulls/${number}`;
    const pull = await this.gh.request("GET", base);
    const author = str(pull?.user, "login");
    const requested = await this.gh.request("GET", `${base}/requested_reviewers`);
    const [reviews, assignees] = await Promise.allSettled([
      this.lib.pages(this.gh, `${base}/reviews`),
      this.lib.pages(this.gh, `repos/${repo}/assignees`),
    ]);
    if (reviews.status === "rejected") throw reviews.reason;
    const reviewed: Array<{ login: string; state: string }> = [];
    for (const review of [...reviews.value].reverse()) {
      const login = str(review?.user, "login");
      const state = str(review, "state");
      if (login === "" || eqi(login, author) || !RESPONSES.includes(state)) continue;
      if (!reviewed.some((r) => eqi(r.login, login))) reviewed.push({ login, state });
    }
    const [candidates, candidateError] =
      assignees.status === "fulfilled"
        ? [assignees.value.map((u: any) => str(u, "login")).filter((l: string) => l !== "" && !eqi(l, author)), null]
        : [[], message(assignees.reason)];
    const names = (key: string, field: string): string[] =>
      (Array.isArray(requested?.[key]) ? requested[key] : []).map((v: any) => str(v, field)).filter((v: string) => v !== "");
    return {
      title: str(pull, "title"),
      url: str(pull, "html_url"),
      author,
      state: pullState(pull),
      requested: names("users", "login"),
      teams: names("teams", "slug"),
      reviewed,
      candidates,
      candidate_error: candidateError,
      watch: this.watches.find((w) => w.id === watchId(repo, number)) ?? null,
    };
  }

  async start(repo: string, number: number, reviewers: string[], request: string[]): Promise<PrWatch> {
    const account = await this.gh.account();
    const base = `repos/${repo}/pulls/${number}`;
    const pull = await this.gh.request("GET", base);
    if (pullState(pull) !== "open") fail("This PR is no longer open");
    const author = str(pull?.user, "login");
    if (request.some((l) => l.endsWith("[bot]"))) fail("Bots cannot be requested as reviewers here", "invalid");
    if (request.some((l) => eqi(l, author))) fail("The PR author cannot be requested as a reviewer", "invalid");
    // The watch begins now: reviews that already exist are history, not news. Read before
    // requesting, so a review that lands right after the request still counts.
    const seen = (await this.lib.pages(this.gh, `${base}/reviews`))
      .map((r: any) => r?.id)
      .filter((id: unknown): id is number => typeof id === "number" && Number.isInteger(id) && id >= 0)
      .reduce((m: number, id: number) => Math.max(m, id), 0);
    if (request.length > 0) {
      try {
        await this.gh.requestFor(account, "POST", `${base}/requested_reviewers`, { reviewers: request });
      } catch (e) {
        throw context("Request reviewers", e);
      }
    }
    const watched: string[] = [];
    for (const login of [...reviewers, ...request]) if (!watched.some((w) => eqi(w, login))) watched.push(login);
    const ts = nowIso();
    const watch: PrWatch = {
      id: watchId(repo, number),
      account,
      repo,
      number,
      url: str(pull, "html_url"),
      title: str(pull, "title"),
      author,
      reviewers: watched,
      status: "watching",
      seen,
      reviews: [],
      created_at: ts,
      updated_at: ts,
      last_checked: ts,
      error: null,
    };
    // A running poll may be about to write the watch this one replaces.
    await this.pollGate.run(() => this.save(watch));
    this.changed();
    return watch;
  }

  /** One pass over the active watches that are due, or over all of them. */
  poll(all: boolean): Promise<void> {
    return this.pollGate.run(async () => {
      const active = this.watches.filter((w) => w.status === "watching");
      if (active.length === 0) return;
      const blocked = await this.gh.blocked();
      if (blocked) return console.debug(`review watches paused: ${blocked}`);
      const notified = all ? null : await this.gh.notified();
      const at = nowIso();
      const due = active.filter((w) => all || this.lib.due(this.reads.get(w.id) ?? null, notified, w.repo, w.number, at));
      if (due.length === 0) return;
      const prs: Array<[string, number, Since]> = due.map((w) => [w.repo, w.number, { reviews: w.seen, comments: null, conversation: null }]);
      let reads: Array<{ node: any; at: string } | Error>;
      try {
        reads = await this.lib.read(this.gh, prs);
      } catch (e) {
        const why = message(e);
        reads = due.map(() => new Error(why));
      }
      for (const [i, watch] of due.entries()) {
        const read = reads[i] ?? new Error("GitHub returned too few PRs");
        const next: PrWatch = { ...watch, reviews: [...watch.reviews], last_checked: nowIso() };
        let fresh: WatchedReview[] = [];
        if (read instanceof Error) {
          next.error = read.message;
        } else {
          const updated = str(read.node, "updatedAt");
          this.reads.set(watch.id, [read.at, updated && !Number.isNaN(Date.parse(updated)) ? updated : read.at]);
          const c = check(watch, read.node);
          next.error = null;
          if (c.title !== "") next.title = c.title;
          next.seen = Math.max(next.seen, c.seen);
          next.reviews.push(...c.fresh);
          if (complete(next)) next.status = "done";
          else if (c.state !== "open") next.status = "closed";
          fresh = c.fresh;
        }
        next.updated_at = nowIso();
        // The user may have removed or replaced the watch during the request.
        if (!this.watches.some((w) => w.id === watch.id && w.created_at === watch.created_at)) continue;
        try {
          await this.save(next);
        } catch (e) {
          console.warn(`saving review watch ${watch.id} failed: ${message(e)}`);
          continue;
        }
        for (const review of fresh) this.aura.emit("watches.review", { watch: next, review });
      }
      this.changed();
    });
  }
}

interface Check {
  title: string;
  state: string;
  seen: number;
  fresh: WatchedReview[];
}

/** The reviews in `pull` (read by `activity.read`) newer than the watch has seen. */
export function check(watch: PrWatch, pull: any): Check {
  const me = watch.account.includes(":") ? loginOf(watch.account) : "";
  let seen = watch.seen;
  const fresh: WatchedReview[] = [];
  for (const n of Array.isArray(pull?.reviews?.nodes) ? pull.reviews.nodes : []) {
    const id = databaseId(n);
    if (id === null) continue;
    seen = Math.max(seen, id);
    if (id <= watch.seen) continue;
    const reviewer = str(n?.author, "login");
    const state = str(n, "state");
    const bot = n?.author?.__typename === "Bot" || reviewer.endsWith("[bot]");
    if (!RESPONSES.includes(state) || !watchesReviewer(watch, reviewer, bot, me)) continue;
    fresh.push({ id, reviewer, state, body: str(n, "body"), url: str(n, "url"), submitted_at: str(n, "submittedAt") });
  }
  fresh.sort((a, b) => a.id - b.id);
  const state = str(pull, "state");
  return { title: str(pull, "title"), state: state === "MERGED" ? "merged" : state.toLowerCase(), seen, fresh };
}

function watchesReviewer(watch: PrWatch, reviewer: string, bot: boolean, me: string): boolean {
  if (reviewer === "" || eqi(reviewer, watch.author)) return false;
  // Automatic reviews (Copilot and the like) would end an open-ended watch before a
  // person looked. A bot counts only when chosen by name.
  if (watch.reviewers.length === 0) return !bot && !eqi(reviewer, me);
  return watch.reviewers.some((r) => eqi(r, reviewer));
}

/** Done once every watched reviewer has responded, or anyone has when no reviewer was named. */
export function complete(watch: PrWatch): boolean {
  if (watch.reviewers.length === 0) return watch.reviews.length > 0;
  return watch.reviewers.every((login) => watch.reviews.some((r) => eqi(r.reviewer, login)));
}

function pullState(pull: any): string {
  return pull?.merged === true || typeof pull?.merged_at === "string" ? "merged" : str(pull, "state");
}

function target(p: any): [string, number] {
  const repo = p?.repo;
  if (typeof repo !== "string") fail("Missing repo", "invalid");
  if (!validRepo(repo)) fail("Invalid repository", "invalid");
  const number = prNumber(p?.number);
  if (number === null) fail("Invalid PR number", "invalid");
  return [repo, number];
}

/** GitHub logins: alphanumerics and hyphens, at most 39 characters; apps add "[bot]". */
export function logins(v: unknown): string[] {
  const out: string[] = [];
  for (const login of Array.isArray(v) ? v : []) {
    if (typeof login !== "string") fail("Invalid reviewer", "invalid");
    const name = login.endsWith("[bot]") ? login.slice(0, -5) : login;
    if (name === "" || name.length > 39 || !/^[A-Za-z0-9-]+$/.test(name)) fail(`Invalid reviewer ${JSON.stringify(login)}`, "invalid");
    out.push(login);
  }
  return out;
}
