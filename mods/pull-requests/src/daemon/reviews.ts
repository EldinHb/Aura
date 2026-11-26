// The PR inbox and Aura's pre-reviews (former aura-review lib.rs ReviewService).
// State changes are applied in memory first, persisted, then announced with
// `reviews.changed`.
import type { Collection, DaemonApi, Json } from "@aura/mod-sdk";
import type {
  Github,
  PreReview,
  PullChange,
  PullRequest,
  ReviewAgent,
  ReviewConfig,
  ReviewInbox,
  ReviewResult,
  SubmissionPreview,
} from "@aura/github-client";
import * as changes from "./changes";
import * as diffs from "./diff";
import { wire, type Gh, type Lib, type ReadPull } from "./github";
import { Links } from "./links";
import { AgentRunner, DEFAULT_PROMPT, SEVERITIES, instructions, parseResult, validateResult, type ReviewRunner } from "./runner";
import { GitWorkspace, type ReviewWorkspace } from "./workspace";
import {
  Lock,
  Semaphore,
  Tasks,
  clone,
  eqi,
  fail,
  longerThan,
  loginOf,
  message,
  newId,
  nowIso,
  prNumber,
  required,
  timeout,
} from "./util";

/** A PR is read again after this long even when its search entry is unchanged (`activity::FULL_POLL`). */
export const FULL_POLL_MS = 5 * 60_000;
/** Slots for Aura's own pre-reviews running at once. */
const SLOTS = 2;
const JOB_TIMEOUT_MS = 15 * 60_000;

/** A PR as the inbox last read it, and its search entry's `updated_at` then. */
export interface InboxRead {
  /** Date.now() of the read. */
  at: number;
  /** The same moment as an ISO time, for notification checks. */
  time: string;
  listed: string;
  pull: ReadPull;
}
/** Due again regardless of its search entry: read a while ago, or checks and merge state still settling. */
function stale(r: InboxRead): boolean {
  return (
    Date.now() - r.at >= FULL_POLL_MS ||
    r.pull.checks === "PENDING" ||
    r.pull.checks === "EXPECTED" ||
    r.pull.merge_state === "" ||
    r.pull.merge_state === "UNKNOWN"
  );
}
export const readKey = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;
const idOf = ([repo, number]: [string, number]) => `${repo}#${number}`;
const sameIds = (a: [string, number], b: [string, number]) => a[0] === b[0] && a[1] === b[1];

/** Who changes a draft. */
export type Editor = "user" | "agent";

export interface ReviewDeps {
  aura: DaemonApi;
  gh: Github;
  lib: Lib;
  tasks: Tasks;
  links: Links;
  workspace?: ReviewWorkspace;
  runner?: ReviewRunner;
}

export function defaultInbox(): ReviewInbox {
  return {
    account: null,
    pulls: [],
    mine: [],
    reviewed: [],
    reviews: [],
    last_synced: null,
    error: null,
    blocked: null,
    defaults: { provider: "codex", model: null, effort: null, prompt_mode: "default", prompt: "" },
  };
}

export class ReviewService implements Gh {
  aura: DaemonApi;
  gh: Github;
  lib: Lib;
  tasks: Tasks;
  links: Links;
  workspace: ReviewWorkspace;
  runner: ReviewRunner;
  state: ReviewInbox = defaultInbox();
  gate = new Lock();
  /** Running or queued jobs; a cancelled one stops at its next step. */
  jobs = new Map<string, { cancelled: boolean }>();
  slots = new Semaphore(SLOTS);
  /** Bumped on every change made through Aura, so only the latest one schedules a resync. */
  changes = 0;
  /** PR id (lowercase) -> its last read, so an unchanged PR is not read every refresh. */
  reads = new Map<string, InboxRead>();
  private store: Collection<PreReview>;
  private saving = new Map<string, Promise<unknown>>();

  constructor(deps: ReviewDeps) {
    this.aura = deps.aura;
    this.gh = deps.gh;
    this.lib = deps.lib;
    this.tasks = deps.tasks;
    this.links = deps.links;
    this.workspace = deps.workspace ?? new GitWorkspace(deps.aura);
    this.runner = deps.runner ?? new AgentRunner(deps.aura);
    this.store = deps.aura.storage.collection<PreReview>("reviews");
  }

  /** Load the inbox and the drafts; jobs the daemon stopped in the middle of are marked. */
  async load(): Promise<void> {
    const saved = await this.aura.storage.kv.get<any>("reviews.inbox");
    const base = defaultInbox();
    if (saved && typeof saved === "object") {
      this.state = { ...base, ...saved, defaults: { ...base.defaults, ...(saved.defaults ?? {}) }, reviews: [] };
    }
    const reviews: PreReview[] = [];
    for (const [, r] of await this.store.all()) {
      if (!r || typeof r !== "object") continue;
      if (r.status === "running") {
        r.status = "failed";
        r.error = "Interrupted when the daemon stopped. Run again to retry.";
      }
      if (r.status === "submitting") {
        r.status = "uncertain";
        r.error = "Submission interrupted; reconcile before retrying.";
      }
      await this.store.put(r.id, r);
      reviews.push(r);
    }
    this.state.reviews = reviews;
  }

  /** Queue the drafts left queued and start the 60 s refresh loop (with backoff). */
  launch(): void {
    for (const r of this.state.reviews.filter((r) => r.status === "queued")) this.enqueue(r.id);
    let delay = 60;
    this.tasks.loop("pull request refresh", async () => {
      try {
        await this.refresh();
        delay = 60;
      } catch {
        delay = Math.min(delay * 2, 900);
      }
      return this.gh.pace(delay * 1000);
    });
  }

  shutdown(): void {
    for (const job of this.jobs.values()) job.cancelled = true;
    this.jobs.clear();
  }

  emit(): void {
    this.aura.emit("reviews.changed", {});
  }

  async persistInbox(): Promise<void> {
    await this.aura.storage.kv.set("reviews.inbox", { ...this.state, reviews: [] });
  }

  get(id: string): PreReview {
    const r = this.state.reviews.find((r) => r.id === id);
    if (!r) fail("Review not found", "not_found");
    return clone(r);
  }

  /** Save one draft; saves of the same draft keep their order. */
  private save(r: PreReview): Promise<void> {
    const before = this.saving.get(r.id) ?? Promise.resolve();
    const next = before.catch(() => {}).then(() => this.store.put(r.id, r));
    this.saving.set(r.id, next);
    return next;
  }

  /** Change a draft: `f` edits a copy, which replaces the draft and is saved and announced. */
  async change(id: string, f: (r: PreReview) => void): Promise<PreReview> {
    const i = this.state.reviews.findIndex((r) => r.id === id);
    if (i < 0) fail("Review not found", "not_found");
    const next = clone(this.state.reviews[i]);
    f(next);
    next.updated_at = nowIso();
    this.state.reviews[i] = next;
    await this.save(next);
    this.emit();
    return clone(next);
  }

  snapshot(): ReviewInbox {
    const s = clone(this.state);
    s.reviews = s.reviews
      .filter((r) => r.pull.account === s.account)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    // Diffs are fetched with the selected review, not broadcast for every inbox refresh.
    for (const r of s.reviews) r.diff = "";
    return s;
  }

  async ensureAccount(expected: string): Promise<void> {
    if ((await this.gh.account()) !== expected) {
      fail("GitHub account changed. Refresh and switch back to the draft's account.");
    }
  }

  refresh(): Promise<void> {
    return this.sync(false);
  }

  /**
   * Read the PR lists. A PR whose search entry is unchanged keeps its last read for a few
   * minutes, unless `force` or its checks or merge state are still settling.
   */
  sync(force: boolean): Promise<void> {
    return this.gate.run(async () => {
      const blocked = await this.gh.blocked();
      const was = this.state.blocked;
      this.state.blocked = blocked;
      if (blocked) {
        console.debug(`pull request refresh paused: ${blocked}`);
        if (was !== blocked) {
          await this.persistInbox();
          this.emit();
        }
        return;
      }
      let failure: unknown = null;
      try {
        await this.read(force);
      } catch (e) {
        failure = e;
        console.warn(`pull request refresh failed: ${message(e)}`);
        this.state.error = message(e);
      }
      await this.persistInbox();
      this.emit();
      if (failure) throw failure;
    });
  }

  private async read(force: boolean): Promise<void> {
    const { gh, lib } = this;
    const account = await gh.account();
    if (this.state.account !== account) {
      Object.assign(this.state, { pulls: [], mine: [], reviewed: [], last_synced: null, account });
      this.reads.clear();
      await this.publishInbox();
    }
    const [requestedList, reviewedList, mineList] = await Promise.all([lib.requested(gh), lib.reviewed(gh), lib.authored(gh)]);
    const listed = new Map<string, string>();
    for (const [[repo, number], updated] of [...requestedList, ...reviewedList, ...mineList]) listed.set(readKey(repo, number), updated);
    const requested = requestedList.map(([id]) => id);
    const mine = mineList.map(([id]) => id);
    // Asked again after reviewing: listed as a request only.
    const reviewed = reviewedList
      .map(([id]) => id)
      .filter((id) => !requested.some((x) => sameIds(x, id)) && !mine.some((x) => sameIds(x, id)));
    const ids: Array<[string, number]> = [];
    for (const id of [...requested, ...reviewed, ...mine]) if (!ids.some((x) => sameIds(x, id))) ids.push(id);
    // Read in the same queries, for the inbox only: PRs linked to a session, and PRs that
    // left the lists since the last refresh, to learn whether they were merged or closed.
    const snapshots = await changes.load(this.aura.storage, account);
    const linked = await this.linkedPulls();
    const leaving = snapshots ? changes.leavers(snapshots, [...ids, ...linked]) : [];
    const extra: Array<[string, number]> = [];
    for (const id of [...linked, ...leaving]) {
      if (![...ids, ...extra].some(([r, n]) => eqi(r, id[0]) && n === id[1])) extra.push(id);
    }
    const all = [...ids, ...extra];
    const notified = await gh.notified();
    const now = nowIso();
    const due = all.map(([repo, number], i) => {
      const read = force ? undefined : this.reads.get(readKey(repo, number));
      if (!read) return true;
      if (i < ids.length) return stale(read) || listed.get(readKey(repo, number)) !== read.listed;
      if (leaving.some((x) => sameIds(x, [repo, number]))) return true;
      // Linked PRs: open ones when notified; closed ones, which can be reopened, now
      // and then; merged ones no more.
      switch (read.pull.state) {
        case "open":
          return stale(read) || !notified || notified.changed(repo, number, read.time);
        case "closed":
          return lib.dueClosed(read.time, notified, repo, number, now);
        default:
          return false;
      }
    });
    const wanted = all.filter((_, i) => due[i]);
    const readNow = wanted.length > 0 ? await lib.pulls(gh, account, wanted) : [];
    let next = 0;
    const fetched: Array<ReadPull | Error> = [];
    for (const [i, [repo, number]] of all.entries()) {
      const key = readKey(repo, number);
      if (!due[i]) {
        const kept = this.reads.get(key)?.pull;
        fetched.push(kept ?? new Error("PR read lost"));
        continue;
      }
      if (next >= readNow.length) fail("GitHub returned too few PRs");
      const result = readNow[next++];
      if (!(result instanceof Error)) {
        this.reads.set(key, { at: Date.now(), time: nowIso(), listed: listed.get(key) ?? "", pull: result });
      }
      fetched.push(result);
    }
    console.debug(`pull requests refreshed: read ${wanted.length}, kept ${all.length - wanted.length}`);
    const followed = fetched.splice(ids.length);
    await this.ensureAccount(account);
    const hidden = await this.hiddenIds(account);
    // A PR GitHub could not return this time keeps its last copy rather than vanishing.
    const previous = new Map<string, PullRequest>();
    for (const p of [...this.state.pulls, ...this.state.reviewed, ...this.state.mine]) previous.set(p.id, p);
    const read = new Map<string, PullRequest>();
    const fresh: ReadPull[] = [];
    const failures: string[] = [];
    for (const [i, id] of ids.entries()) {
      const key = idOf(id);
      const result = fetched[i];
      if (result instanceof Error) {
        console.warn(result.message);
        failures.push(result.message);
        const p = previous.get(key);
        if (p) read.set(key, p);
      } else {
        const p = { ...result, hidden: hidden.has(result.id) };
        fresh.push(p);
        read.set(key, wire(p));
      }
    }
    const list = (of: Array<[string, number]>) => of.map((id) => read.get(idOf(id))).filter((p): p is PullRequest => !!p);
    this.state.pulls = list(requested);
    this.state.reviewed = list(reviewed);
    this.state.mine = list(mine);
    this.state.last_synced = nowIso();
    this.state.error = failures.length > 0 ? failures.join("\n") : null;
    for (const [i, [repo, number]] of extra.entries()) {
      const result = followed[i];
      if (result instanceof Error) console.debug(`reading ${repo}#${number} for the inbox failed: ${result.message}`);
      else if (result) fresh.push(result);
    }
    const has = (of: Array<[string, number]>, p: PullRequest) => of.some(([r, n]) => eqi(r, p.repo) && n === p.number);
    const lists = [requested, mine, reviewed, linked];
    const roles: Array<[ReadPull, string]> = fresh.map((p) => {
      const i = lists.findIndex((of) => has(of, p));
      return [p, i < 0 ? "" : changes.ROLES[i]];
    });
    // The PR lists are read either way; failing to record changes only costs those.
    try {
      const [snaps, found] = changes.detect(snapshots, roles, leaving, loginOf(account));
      await changes.save(this.aura.storage, account, snaps);
      const news = await changes.record(this.aura.storage, account, found);
      if (news.length > 0) {
        this.aura.emit("pulls.activity", { changes: news });
        this.aura.emit("pulls.changes.changed", {});
        await this.publishInbox();
      }
    } catch (e) {
      console.warn(`recording pull request changes failed: ${message(e)}`);
    }
  }

  private async hiddenIds(account: string): Promise<Set<string>> {
    const out = new Set<string>();
    for (const [id, v] of await this.aura.storage.collection<Json>(`hidden:${account}`).all()) {
      if (v === true || v === "true") out.add(id);
    }
    return out;
  }

  /** PRs linked to a session the user still has. */
  async linkedPulls(): Promise<Array<[string, number]>> {
    const out: Array<[string, number]> = [];
    for (const id of await this.links.unarchivedPrs()) if (!out.some((x) => sameIds(x, id))) out.push(id);
    return out;
  }

  /** Kinds of PR change the user muted (the `pullChangesMuted` setting the UI half writes). */
  muted(): string[] {
    let v: unknown;
    try {
      v = this.aura.settings.get("pullChangesMuted");
    } catch {
      return [];
    }
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
  }

  /**
   * Mirror the account's unread PR changes into Aura's inbox, leaving out muted kinds
   * (they stay in `pulls.changes`); an entry with nothing else left is not shown.
   */
  async publishInbox(): Promise<void> {
    const account = this.state.account;
    const list: PullChange[] = account ? await changes.entries(this.aura.storage, account) : [];
    const muted = this.muted();
    try {
      await this.aura.inbox.set(
        list
          .filter((c) => !c.read)
          .map((c) => [c, c.events.filter((e) => !muted.includes(e.kind))] as const)
          .filter(([, shown]) => shown.length > 0)
          .map(([c, shown]) => ({
            id: c.id,
            title: `${c.repo}#${c.number} ${c.title}`,
            detail: shown.map((e) => e.text || e.kind.replaceAll("_", " ")).join(" · "),
            at: c.created_at,
            unread: true,
            data: c as unknown as Json,
          })),
      );
    } catch (e) {
      console.debug(`updating the inbox failed: ${message(e)}`);
    }
  }

  /**
   * After Aura changes a PR on GitHub, show the change straight away instead of at the
   * next poll: re-read that PR, resync both lists, and resync once more after GitHub's
   * search index has caught up (it can keep listing a PR you just reviewed for a while).
   */
  changed(pr: PullRequest): void {
    const generation = ++this.changes;
    const { account, repo, number } = pr;
    this.tasks.spawn("resync after a change", async () => {
      try {
        await this.updatePull(account, repo, number);
      } catch (e) {
        console.debug(`re-reading ${repo}#${number} failed: ${message(e)}`);
      }
      await this.refresh().catch(() => {});
      await this.tasks.sleep(20_000);
      if (!this.tasks.stopped && this.changes === generation) await this.refresh().catch(() => {});
    });
  }

  /** Replace one PR in the lists with its live state; one that is no longer open is dropped. */
  async updatePull(account: string, repo: string, number: number): Promise<void> {
    await this.ensureAccount(account);
    const live = await this.lib.pull(this.gh, account, repo, number);
    // The next refresh keeps this copy rather than the one from before the change.
    const read = this.reads.get(readKey(repo, number));
    if (read) Object.assign(read, { at: Date.now(), time: nowIso(), pull: live });
    if (this.state.account !== account) return;
    for (const key of ["pulls", "reviewed", "mine"] as const) {
      const list = this.state[key];
      const i = list.findIndex((p) => p.id === live.id);
      if (i < 0) continue;
      if (live.state === "open") list[i] = { ...wire(live), hidden: list[i].hidden };
      else list.splice(i, 1);
    }
    await this.persistInbox();
    this.emit();
  }

  async lookup(p: any): Promise<PullRequest> {
    const repo = required(p, "repo");
    const number = prNumber(p?.number);
    if (number === null) fail("Invalid PR number", "invalid");
    const account = await this.gh.account();
    if (typeof p.account === "string" && p.account !== account) fail("GitHub account changed; refresh first");
    const result = wire(await this.lib.pull(this.gh, account, repo, number));
    const hidden = await this.aura.storage.collection<Json>(`hidden:${account}`).get(result.id);
    return { ...result, hidden: hidden === true || hidden === "true" };
  }

  /** Every RPC method of the inbox and the pre-reviews (former `ReviewService::handle`). */
  methods(): Record<string, (p: any) => Promise<unknown>> {
    const snapshot = async () => this.snapshot();
    const sameAccount = (r: PreReview, why: string) => {
      if (this.state.account !== r.pull.account) fail(why);
    };
    return {
      "github.status": snapshot,
      "pulls.list": snapshot,
      "reviews.list": snapshot,
      "pulls.changes": async () => (this.state.account ? changes.entries(this.aura.storage, this.state.account) : []),
      "pulls.changes.read": async (p) => {
        const account = this.state.account;
        let ids: string[] | null = null;
        if (p?.ids != null) {
          if (!Array.isArray(p.ids) || !p.ids.every((x: unknown) => typeof x === "string")) fail("Invalid ids", "invalid");
          ids = p.ids;
        }
        if (account && (await changes.markRead(this.aura.storage, account, ids))) {
          this.aura.emit("pulls.changes.changed", {});
          await this.publishInbox();
        }
        return true;
      },
      "reviews.defaults": async () => ({ instructions: DEFAULT_PROMPT, config: this.state.defaults }),
      "pulls.refresh": async () => {
        await this.sync(true);
        return this.snapshot();
      },
      "pulls.hide": async (p) => this.hide(required(p, "account"), required(p, "id"), true),
      "pulls.restore": async (p) => this.hide(required(p, "account"), required(p, "id"), false),
      "pulls.get": async (p) => {
        const pr = await this.lookup(p);
        const [timeline, projects] = await Promise.all([
          this.lib.timeline(this.gh, pr),
          this.lib.projects(this.gh, pr).then(
            (v) => [v, null] as [any[], string | null],
            (e) => [[], message(e)] as [any[], string | null],
          ),
        ]);
        // The REST-shaped lists are for apps up to 0.2.10, which read nothing else.
        const [comments, reviews, threads] = this.lib.legacyLists(timeline);
        const value = { pull: pr, timeline, comments, reviews, threads, projects: projects[0], project_error: projects[1] };
        await this.aura.storage.collection(`details:${pr.account}`).put(pr.id, value as unknown as Json);
        return value;
      },
      "pulls.cached": async (p) => {
        const account = required(p, "account");
        const id = required(p, "id");
        const v = await this.aura.storage.collection(`details:${account}`).get(id);
        if (v === undefined) fail("No cached PR detail", "not_found");
        return v;
      },
      "pulls.diff": async (p) => {
        const pr = await this.lookup(p);
        return { sha: pr.head_sha, diff: await this.gh.diff(pr.repo, pr.base_sha, pr.head_sha) };
      },
      "pulls.options": async (p) => {
        const pr = await this.lookup(p);
        return {
          labels: await this.lib.pages(this.gh, `repos/${pr.repo}/labels`),
          assignees: await this.lib.pages(this.gh, `repos/${pr.repo}/assignees`),
          milestones: await this.lib.pages(this.gh, `repos/${pr.repo}/milestones?state=open`),
        };
      },
      "pulls.update": async (p) => {
        const pr = await this.lookup(p);
        if (!pr.can_edit) fail("You cannot edit this pull request");
        const body: Record<string, unknown> = {};
        for (const key of ["title", "body", "labels", "assignees", "milestone"]) {
          if (p?.patch && typeof p.patch === "object" && key in p.patch) body[key] = p.patch[key];
        }
        await this.ensureAccount(pr.account);
        const v = await this.gh.requestFor(pr.account, "PATCH", `repos/${pr.repo}/issues/${pr.number}`, body);
        this.changed(pr);
        return v;
      },
      "pulls.addComment": async (p) => {
        const pr = await this.lookup(p);
        const body = required(p, "body");
        if (body.trim() === "") fail("Comment is empty", "invalid");
        await this.ensureAccount(pr.account);
        const v = await this.gh.requestFor(pr.account, "POST", `repos/${pr.repo}/issues/${pr.number}/comments`, { body });
        this.changed(pr);
        return v;
      },
      "pulls.merge": async (p) => {
        const pr = await this.lookup(p);
        const method = required(p, "method");
        if (!pr.merge_methods.includes(method)) fail(`This repository does not allow ${method} merges`);
        const blocker = mergeBlocker(pr);
        if (blocker) fail(blocker);
        // Merge what was on screen, not commits pushed since.
        if (required(p, "sha") !== pr.head_sha) {
          fail("New commits were pushed since you opened this pull request. Refresh and check them before merging.");
        }
        const remove = p.delete_branch === true && pr.can_delete_branch;
        try {
          await this.lib.merge(this.gh, pr.account, pr, method);
        } catch (e) {
          // A failed request may still have merged; resyncing is harmless either way.
          this.changed(pr);
          throw e;
        }
        let branchError: string | null = null;
        if (remove) {
          try {
            await this.lib.deleteBranch(this.gh, pr.account, pr);
          } catch (e) {
            branchError = `Merged, but the branch was not deleted: ${message(e)}`;
          }
        }
        this.changed(pr);
        return { branch_deleted: remove && branchError === null, branch_error: branchError };
      },
      "pulls.setField": async (p) => {
        const pr = await this.lookup(p);
        const projects = await this.lib.projects(this.gh, pr);
        const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
        const item = projects.find(
          (x: any) => same(x?.id, p.item_id) && same(x?.project?.id, p.project_id) && x?.project?.viewerCanUpdate === true,
        );
        if (!item) fail("Project item is not editable");
        const values: any[] = Array.isArray(item.fieldValues) ? item.fieldValues : [];
        if (!values.some((x) => same(x?.field?.id, p.field_id))) fail("Unknown project field");
        const clear = p.value == null;
        const query = clear
          ? "mutation($project:ID!,$item:ID!,$field:ID!){clearProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field}){projectV2Item{id}}}"
          : "mutation($project:ID!,$item:ID!,$field:ID!,$value:ProjectV2FieldValue!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:$value}){projectV2Item{id}}}";
        const variables: Record<string, unknown> = { project: p.project_id ?? null, item: p.item_id ?? null, field: p.field_id ?? null };
        if (!clear) variables.value = p.value;
        const v = await this.gh.requestFor(pr.account, "POST", "graphql", { query, variables });
        if (v && typeof v === "object" && "errors" in v) fail(JSON.stringify(v.errors));
        this.changed(pr);
        return v;
      },
      "reviews.start": async (p) => this.start(p, true),
      "reviews.get": async (p) => this.ownReview(required(p, "id")),
      "reviews.diff": async (p) => this.ownReview(required(p, "id")),
      "reviews.cancel": async (p) => this.close(required(p, "id"), false),
      "reviews.discard": async (p) => this.close(required(p, "id"), true),
      "reviews.ready": async (p) => {
        const id = required(p, "id");
        sameAccount(this.get(id), "Account changed");
        return this.markReady(id);
      },
      "reviews.save": async (p) => {
        const id = required(p, "id");
        sameAccount(this.get(id), "Account changed");
        const result = parseResult(p?.result);
        const revision = p?.revision;
        if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) {
          fail("This review changed since you opened it, in another window or by an orchestrator. Reload before saving.");
        }
        return this.saveDraft(id, revision, "user", (r) => {
          // Empty newly authored comments are allowed while drafting, but not in a submission.
          for (const c of result.comments) {
            const original = r.result.comments.find((x) => x.id === c.id);
            if (original) {
              c.user_authored = original.user_authored;
              c.rationale = original.rationale;
              c.edited =
                original.edited ||
                c.body !== original.body ||
                c.line !== original.line ||
                c.start_line !== original.start_line ||
                c.path !== original.path ||
                c.side !== original.side ||
                c.severity !== original.severity ||
                // Deleting or restoring one is the user's say too.
                c.deleted !== original.deleted;
            } else {
              c.user_authored = true;
              c.rationale = null;
              c.edited = true;
            }
          }
          return result;
        });
      },
      "reviews.preview": async (p) => this.gate.run(() => this.preview(required(p, "id"))),
      "reviews.submit": async (p) =>
        this.gate.run(async () => {
          const id = required(p, "id");
          try {
            return await this.submit(id, required(p, "token"));
          } finally {
            // Even a failed post may have reached GitHub; resyncing is harmless either way.
            const r = this.state.reviews.find((r) => r.id === id);
            if (r && r.status !== "ready") this.changed(r.pull);
          }
        }),
      "reviews.reconcile": async (p) =>
        this.gate.run(async () => {
          const r = await this.reconcile(required(p, "id"));
          this.changed(r.pull);
          return r;
        }),
    };
  }

  private ownReview(id: string): PreReview {
    const r = this.get(id);
    if (this.state.account !== r.pull.account) fail("Review belongs to another account");
    return r;
  }

  /**
   * Queue Aura's own pre-review of a PR, or return the one already queued or running.
   * `remember` keeps `config` as the defaults the user's next pre-review starts from.
   */
  start(p: any, remember: boolean): Promise<PreReview> {
    return this.gate.run(async () => {
      const pr = await this.lookup(p);
      if (pr.state !== "open") fail("This PR is no longer open");
      const running = this.state.reviews.find(
        (r) => r.pull.id === pr.id && r.pull.account === pr.account && (r.status === "queued" || r.status === "running"),
      );
      if (running) return clone(running);
      const config = parseConfig(p?.config);
      const kind = config.provider;
      if (kind !== "codex" && kind !== "claude") fail("Select a supported provider", "invalid");
      const providers = await this.aura.agents.providers();
      if (!providers.some((x) => x.kind === kind && x.available)) fail("Selected provider is unavailable", "unavailable");
      let models: any[] = [];
      if (config.effort != null) models = await this.aura.agents.models(kind);
      // Codex lists real model ids, so its default names the model that will run.
      else if (kind === "codex") models = await this.aura.agents.models(kind).catch(() => []);
      const model =
        models.find((m) => config.model != null && m?.id === config.model) ?? models.find((m) => m?.is_default === true);
      if (config.effort != null && !(model && Array.isArray(model.efforts) && model.efforts.includes(config.effort))) {
        fail("Effort is not supported by the selected model", "invalid");
      }
      const agent: ReviewAgent = {
        provider: kind === "codex" ? "Codex" : "Claude Code",
        model: config.model,
        model_id: kind === "codex" && model ? String(model.id) : null,
        effort: config.effort,
      };
      const ts = nowIso();
      const review: PreReview = {
        id: newId(),
        pull: pr,
        config,
        instructions: instructions(config),
        status: "queued",
        phase: "preparing",
        error: null,
        created_at: ts,
        updated_at: ts,
        revision: 0,
        reviewed_sha: "",
        merge_base: "",
        context_mode: "",
        context_note: null,
        diff: "",
        log_tail: [],
        result: { summary: "", verdict: "comment", risk: "medium", confidence: null, comments: [] },
        submitted_url: null,
        submission: null,
        agent,
        source: null,
      };
      await this.save(review);
      this.state.reviews.push(review);
      if (remember) this.state.defaults = config;
      await this.persistInbox();
      this.enqueue(review.id);
      this.emit();
      return clone(review);
    });
  }

  enqueue(id: string): void {
    const job = { cancelled: false };
    this.jobs.set(id, job);
    this.tasks.spawn(`pre-review ${id}`, async () => {
      let release: (() => void) | undefined;
      try {
        release = await this.slots.acquire();
        if (job.cancelled || this.get(id).status !== "queued") return;
        await this.change(id, (r) => {
          r.status = "running";
        });
        await timeout(this.execute(id, job), JOB_TIMEOUT_MS, "Review timed out after 15 minutes");
      } catch (e) {
        if (!job.cancelled) {
          await this.change(id, (r) => {
            if (r.status === "running" || r.status === "queued") {
              r.status = "failed";
              r.phase = "failed";
              r.error = message(e);
            }
          }).catch(() => {});
        }
      } finally {
        release?.();
        if (this.jobs.get(id) === job) this.jobs.delete(id);
      }
    });
  }

  /** Run a pre-review that is `running`: check the PR out, have the agent review it, keep its findings. */
  async execute(id: string, job: { cancelled: boolean } = { cancelled: false }): Promise<void> {
    const r = this.get(id);
    await this.ensureAccount(r.pull.account);
    const checkout = this.workspace.path();
    await this.change(id, (r) => {
      r.phase = "cloning";
    });
    let diff: string;
    let mergeBase: string;
    let mode: "worktree" | "diff-only";
    let note: string | null = null;
    let cwd = checkout;
    try {
      [diff, mergeBase] = await this.workspace.prepare(r.pull, checkout);
      mode = "worktree";
    } catch (e) {
      await this.workspace.remove(r.pull, checkout).catch(() => {});
      cwd = await this.workspace.empty();
      [diff, mergeBase] = await this.compare(r.pull, r.pull.head_sha);
      mode = "diff-only";
      note = `Checkout unavailable: ${message(e)}. Reviewed from the diff alone.`;
    }
    const cancelled = (r: PreReview) => {
      if (job.cancelled || r.status !== "running") fail("Review was cancelled");
    };
    try {
      if ([...diffs.positions(diff).values()].every(([a, b]) => a.size === 0 && b.size === 0)) {
        fail("This PR has no textual diff to review");
      }
      const truncated = longerThan(diff, 200_000);
      const files = diff.split("\n").filter((l) => l.startsWith("diff --git ")).length;
      const missingFiles = mode === "diff-only" && files < r.pull.changed_files;
      if (missingFiles) {
        note = `${note ?? ""} GitHub returned fewer files than the PR contains; this review is incomplete.`;
      }
      if (truncated) {
        note = `${note ?? ""} Inline diff is truncated; ${
          mode === "worktree" ? "full diff is available in .aura-pr.diff" : "some changes were not reviewed"
        }`;
      }
      if (mode === "worktree") {
        await this.workspace.writeDiff(cwd, diff).catch((e) => console.warn(`writing .aura-pr.diff failed: ${message(e)}`));
      }
      const running = await this.change(id, (r) => {
        cancelled(r);
        r.diff = diff;
        r.merge_base = mergeBase;
        r.reviewed_sha = r.pull.head_sha;
        r.context_mode = mode;
        r.context_note = note;
        r.phase = "running";
      });
      const progress = (line: string) => {
        if (job.cancelled) return;
        this.change(id, (r) => {
          if (r.status === "running") {
            r.log_tail.push(line);
            if (r.log_tail.length > 40) r.log_tail.shift();
          }
        }).catch(() => {});
      };
      // SDK-GAP: an agent run cannot be cancelled; a cancelled review's agent finishes
      // (or times out) unseen, and nothing it returns is kept.
      const { result, model_id } = await this.runner.run(running, cwd, progress);
      await this.change(id, (r) => {
        cancelled(r);
        r.phase = "validating";
      });
      validateResult(result);
      for (const c of result.comments) c.id = newId();
      diffs.validate(result.comments, running.diff, true);
      if ((truncated || missingFiles) && mode === "diff-only" && result.verdict === "approve") {
        result.verdict = "comment";
        result.summary += "\n\nOnly part of the diff was reviewed; this is not an approval of the full PR.";
      }
      await this.change(id, (r) => {
        cancelled(r);
        r.result = result;
        if (r.agent && model_id) r.agent.model_id = model_id;
        r.status = "ready";
        r.phase = "done";
      });
    } finally {
      if (mode === "worktree") await this.workspace.remove(r.pull, checkout).catch(() => {});
    }
  }

  /** The PR's diff from its base to `head` as GitHub has it, and their merge base. */
  async compare(pull: PullRequest, head: string): Promise<[string, string]> {
    const comparison = await this.gh.request("GET", `repos/${pull.repo}/compare/${pull.base_sha}...${head}`);
    const base = comparison?.merge_base_commit?.sha;
    if (typeof base !== "string") fail("GitHub did not return the comparison merge base");
    return [await this.gh.diff(pull.repo, pull.base_sha, head), base];
  }

  /**
   * Save a new version of an editable draft. The user's editor and the orchestrator tools
   * both save through here: `edit` turns the draft into its new result, which is checked
   * and anchored to the reviewed diff; the revision goes up and an earlier preview lapses.
   * `revision`, when given, must be the draft's current one.
   */
  saveDraft(id: string, revision: number | null, by: Editor, edit: (r: PreReview) => ReviewResult): Promise<PreReview> {
    return this.change(id, (r) => {
      const editable = by === "user" ? r.status === "ready" : r.status === "ready" || r.status === "drafting";
      if (!editable) fail("Review is not editable");
      if (revision !== null && revision !== r.revision) {
        if (by === "user") {
          fail("This review changed since you opened it, in another window or by an orchestrator. Reload before saving.");
        }
        fail(
          `The review is at revision ${r.revision} now, not ${revision}: it changed since you read it. Read it again before changing it.`,
        );
      }
      const result = edit(r);
      checkResult(result);
      diffs.validate(result.comments, r.diff, false);
      r.result = result;
      r.revision += 1;
      r.submission = null;
    });
  }

  /** Hand a draft an orchestrator is still writing to the user: it becomes ready to edit and submit. */
  markReady(id: string): Promise<PreReview> {
    return this.change(id, (r) => {
      if (r.status === "ready") return;
      if (r.status !== "drafting") fail("Only a draft that is being written can be made ready");
      r.status = "ready";
      r.phase = "done";
    });
  }

  /** Discard a draft, or cancel a pre-review that has not finished. Nothing goes to GitHub. */
  async close(id: string, discard: boolean): Promise<PreReview> {
    const r = this.get(id);
    await this.ensureAccount(r.pull.account);
    const updated = await this.change(id, (r) => {
      if (["submitted", "submitting", "uncertain"].includes(r.status)) fail("This review cannot be discarded or cancelled");
      r.status = discard ? "discarded" : "cancelled";
      r.phase = r.status;
    });
    const job = this.jobs.get(id);
    if (job) {
      job.cancelled = true;
      this.jobs.delete(id);
    }
    return updated;
  }

  /** Hide a PR from the inbox lists, or restore it. */
  hide(account: string, id: string, hidden: boolean): Promise<ReviewInbox> {
    return this.gate.run(async () => {
      await this.ensureAccount(account);
      await this.aura.storage.collection<Json>(`hidden:${account}`).put(id, hidden);
      for (const p of [...this.state.pulls, ...this.state.reviewed, ...this.state.mine]) {
        if (p.id === id && p.account === account) p.hidden = hidden;
      }
      await this.persistInbox();
      this.emit();
      return this.snapshot();
    });
  }

  async preview(id: string): Promise<SubmissionPreview> {
    const r = this.get(id);
    if (r.status !== "ready") fail("Only ready drafts can be submitted");
    await this.ensureAccount(r.pull.account);
    const live = await this.lib.pull(this.gh, r.pull.account, r.pull.repo, r.pull.number);
    if (live.state !== "open") fail("This PR is no longer open");
    const preview = buildPreview(r, live.head_sha);
    await this.change(id, (r) => {
      if (r.revision !== preview.revision || r.status !== "ready") fail("Draft changed; preview again");
      r.submission = preview;
    });
    return preview;
  }

  async submit(id: string, token: string): Promise<PreReview> {
    const r = this.get(id);
    if (r.status === "submitted") return r;
    if (r.status !== "ready") fail("Submission unavailable; reconcile uncertain submissions first");
    const preview = r.submission;
    if (!preview || preview.token !== token || preview.revision !== r.revision) {
      fail("Preview expired; preview the saved draft again");
    }
    await this.ensureAccount(r.pull.account);
    const live = await this.lib.pull(this.gh, r.pull.account, r.pull.repo, r.pull.number);
    if (live.state !== "open" || live.head_sha !== preview.head_sha) {
      fail("PR changed since preview. Preview again before posting.");
    }
    await this.change(id, (r) => {
      if (r.revision !== preview.revision || r.status !== "ready" || r.submission?.token !== token) {
        fail("Draft changed; preview again");
      }
      r.status = "submitting";
    });
    let v: any;
    try {
      v = await this.gh.requestFor(r.pull.account, "POST", `repos/${r.pull.repo}/pulls/${r.pull.number}/reviews`, payload(preview));
    } catch (e) {
      if (this.lib.rejected(e)) {
        await this.change(id, (r) => {
          r.status = "ready";
          r.submission = null;
          r.error = message(e);
        });
        throw e;
      }
      // Conservatively reconcile even transport errors: the server may have accepted the write.
      await this.change(id, (r) => {
        r.status = "uncertain";
        r.error = `Submission may have reached GitHub: ${message(e)}. Reconcile before retrying.`;
      });
      fail("Submission outcome uncertain. Use Reconcile to check GitHub before retrying.");
    }
    return this.change(id, (r) => {
      r.status = "submitted";
      r.submitted_url = typeof v?.html_url === "string" ? v.html_url : null;
      r.error = null;
    });
  }

  async reconcile(id: string): Promise<PreReview> {
    const r = this.get(id);
    if (r.status !== "uncertain") fail("No uncertain submission");
    await this.ensureAccount(r.pull.account);
    if (!r.submission) fail("No submission receipt to reconcile");
    const rows = await this.lib.pages(this.gh, `repos/${r.pull.repo}/pulls/${r.pull.number}/reviews`);
    const marker = `<!-- aura-review:${r.submission.token} -->`;
    const found = rows.find((v: any) => typeof v?.body === "string" && v.body.includes(marker));
    if (!found) {
      // Do not infer failure from eventual-consistency absence and automatically duplicate a review.
      fail(
        "No matching review is visible yet. Check the PR and reconcile again; automatic retry is disabled to prevent duplicate reviews.",
      );
    }
    return this.change(id, (r) => {
      r.status = "submitted";
      r.submitted_url = typeof found.html_url === "string" ? found.html_url : null;
      r.error = null;
    });
  }
}

/** A review config as serde read it. */
function parseConfig(v: any): ReviewConfig {
  if (!v || typeof v !== "object") fail("Invalid review config", "invalid");
  const opt = (x: unknown) => (typeof x === "string" ? x : null);
  if (typeof v.provider !== "string" || typeof v.prompt_mode !== "string" || typeof v.prompt !== "string") {
    fail("Invalid review config", "invalid");
  }
  return { provider: v.provider, model: opt(v.model), effort: opt(v.effort), prompt_mode: v.prompt_mode, prompt: v.prompt };
}

/** A draft's verdict, risk and findings as the editor and the orchestrator tools may save them. New findings get an id. */
export function checkResult(result: ReviewResult): void {
  if (
    !["approve", "comment", "request_changes"].includes(result.verdict) ||
    !["low", "medium", "high"].includes(result.risk) ||
    (result.confidence !== null && !(result.confidence >= 0 && result.confidence <= 1))
  ) {
    fail("Invalid verdict or risk", "invalid");
  }
  const ids = new Set<string>();
  for (const c of result.comments) {
    if (c.line === 0 || c.path === "" || (c.side !== "LEFT" && c.side !== "RIGHT") || !SEVERITIES.includes(c.severity)) {
      fail("Invalid finding location or severity", "invalid");
    }
    if (c.id === "") c.id = newId();
    if (ids.has(c.id)) fail("Duplicate finding ID", "invalid");
    ids.add(c.id);
  }
}

/** Why this PR cannot be merged from Aura yet, or null (former `PullRequest::merge_blocker`). */
export function mergeBlocker(p: PullRequest): string | null {
  if (p.state !== "open") return "This pull request is not open";
  if (!p.can_merge) return "You do not have permission to merge this pull request";
  if (p.draft || p.merge_state === "DRAFT") return "Draft pull requests cannot be merged";
  if (p.merge_methods.length === 0) return "The repository allows no merge method";
  if (p.checks === "FAILURE" || p.checks === "ERROR") return "Checks have failed";
  if (p.checks === "PENDING" || p.checks === "EXPECTED") return "Checks are still running";
  switch (p.merge_state) {
    case "CLEAN":
    case "HAS_HOOKS":
      return null;
    case "DIRTY":
      return "The branch has merge conflicts";
    case "BEHIND":
      return "The branch is out of date with the base branch";
    case "UNSTABLE":
      return "Some checks are not passing";
    case "BLOCKED":
      return p.review_decision === "CHANGES_REQUESTED"
        ? "Changes were requested"
        : p.review_decision === "REVIEW_REQUIRED"
          ? "A review is required"
          : "Blocked by the base branch's rules";
    default:
      return "GitHub is still checking whether this can be merged";
  }
}

/** `opus (claude-opus-5-5)`, `gpt-5.5-codex`, or `default model`. */
export function modelLabel(a: ReviewAgent): string {
  const chosen = a.model && a.model !== "default" ? a.model : null;
  if (chosen && a.model_id && chosen !== a.model_id) return `${chosen} (${a.model_id})`;
  if (a.model_id) return a.model_id;
  if (chosen) return chosen;
  return "default model";
}

/** `Claude Code · model opus (claude-opus-5-5) · effort high` */
export function signature(a: ReviewAgent): string {
  return `${a.provider} · model ${modelLabel(a)} · effort ${a.effort ?? "default"}`;
}

/** The agent behind a draft; older drafts did not record one, so it is rebuilt from their config. */
export function reviewAgent(r: PreReview): ReviewAgent {
  if (r.agent) return r.agent;
  const provider = r.config.provider === "claude" ? "Claude Code" : r.config.provider === "codex" ? "Codex" : r.config.provider;
  return { provider, model: r.config.model, model_id: null, effort: r.config.effort };
}

/** The AI footer of an inline comment the agent wrote, signed with `sig`. */
export const COMMENT_FOOTER = (sig: string) => `\n\n<sub>🤖 AI agent · ${sig}</sub>`;
/** The AI footer of a posted review's body, signed with `sig`. */
export const REVIEW_FOOTER = (sig: string) =>
  `\n\n---\n<sub>🤖 Drafted by an AI agent with Aura and reviewed by a person before posting · ${sig}</sub>`;

export function buildPreview(r: PreReview, head: string): SubmissionPreview {
  let comments = clone(r.result.comments.filter((c) => !c.deleted));
  if (comments.some((c) => c.body.trim() === "")) fail("Complete or delete empty comments before posting");
  diffs.validate(comments, r.diff, false);
  let body = r.result.summary;
  const unanchored = comments.filter((c) => !c.valid);
  if (unanchored.length > 0) {
    body += "\n\n---\n\n**Additional notes** (these refer to lines outside the diff):\n";
    for (const c of unanchored) body += `\n- **${c.path}:${c.line}** — ${c.body}`;
  }
  comments = comments.filter((c) => c.valid);
  const sig = signature(reviewAgent(r));
  for (const c of comments) {
    c.rationale = null;
    // Comments the user wrote themselves are theirs, not the agent's.
    if (!c.user_authored) c.body += COMMENT_FOOTER(sig);
  }
  if (body.trim() === "" && comments.length === 0) fail("There is nothing to post");
  body += REVIEW_FOOTER(sig);
  const token = newId();
  body += `\n\n<!-- aura-review:${token} -->`;
  return {
    token,
    review_id: r.id,
    revision: r.revision,
    account: r.pull.account,
    head_sha: head,
    reviewed_sha: r.reviewed_sha,
    event: r.result.verdict === "approve" ? "APPROVE" : r.result.verdict === "request_changes" ? "REQUEST_CHANGES" : "COMMENT",
    body,
    comments,
    stale: head !== r.reviewed_sha,
  };
}

/** What `POST /pulls/:n/reviews` gets for a preview. */
export function payload(p: SubmissionPreview): Record<string, unknown> {
  return {
    commit_id: p.reviewed_sha,
    event: p.event,
    body: p.body,
    comments: p.comments.map((c) => {
      const v: Record<string, unknown> = { path: c.path, line: c.line, side: c.side, body: c.body };
      if (c.start_line != null) {
        v.start_line = c.start_line;
        v.start_side = c.side;
      }
      return v;
    }),
  };
}
