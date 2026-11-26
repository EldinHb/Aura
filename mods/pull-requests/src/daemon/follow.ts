// Review follow-ups (former aura-review follow.rs): new review activity on a
// session's pull requests goes to that session's agent, and the user hears
// about it twice: when it arrives, and when the agent's turn on it ends.
//
// Once a minute the daemon looks at the PRs each session follows (the `github`
// mod's session links: the ones it is linked to and the ones opened from its
// branch; for a worktree the daemon looks its branch's PR up itself). For each
// open PR the user authored it collects reviews, inline review comments and
// conversation comments newer than the last look, all PRs in one GraphQL query.
// A PR is read when a notification says it changed, and otherwise every few
// minutes (see `activity.due`). The first look only records where things stand.
//
// Activity by the user's own account is skipped: agents post as the user, so
// their own replies would otherwise wake them again. Conversation comments by
// bots are skipped too (CI and coverage reports); reviews by bots count.
import type { Collection, CoreEvent, DaemonApi, Session } from "@aura/mod-sdk";
import type { Github, LastRead, Since } from "@aura/github-client";
import { parseGithubRemote, type Gh, type Lib } from "./github";
import { Links, prIds, type PrId } from "./links";
import { Lock, Tasks, databaseId, eqi, loginOf, message, nowIso, str } from "./util";

export const NAMESPACE = "pr-follows";
/** Activity found but not yet handed over, per session. Kept across restarts, since the PR's baseline has moved past it. */
export const PENDING_NAMESPACE = "pr-follow-pending";
/** A hand-over whose turn has not started by then is given up on. */
const START_TIMEOUT_MS = 120_000;
/** A worktree whose branch has no PR yet is looked up again after this long. */
const BRANCH_LOOKUP_INTERVAL_MS = 10 * 60_000;
/** Longest review or comment body handed to an agent (in UTF-8 bytes, as Rust counted). */
const BODY_LIMIT = 4000;
/** Review states that mean a reviewer responded. */
const RESPONSES = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"];
const POLL_INTERVAL_MS = 60_000;
/** This mod's per-session data key: the session's branch PR was looked up and recorded. */
const BRANCH_PULL_KEY = "branchPull";
/**
 * Ends the first line of every message Aura, not the user, sends an agent. The desktop
 * app keeps such messages out of the user's chat by this line, so it must not change
 * (former `prompts::AURA_MARK`).
 */
export const AURA_MARK = "This message comes from Aura, not the user.";
/** The first line of a message from Aura titled `title`, newline included (former `prompts::aura_header`). */
export const auraHeader = (title: string) => `[Aura] ${title}. ${AURA_MARK}\n`;

/** Where the daemon stands on one pull request. */
export interface Followed {
  id: string;
  repo: string;
  number: number;
  author: string;
  /** False once merged or closed. A closed PR is looked at now and then, in case it is reopened; a merged one is not looked at again. */
  open: boolean;
  merged: boolean;
  /** Highest ids already looked at, per kind of activity. */
  seen_review: number;
  seen_comment: number;
  seen_conversation: number;
}

export interface Activity {
  /** review | comment (inline, on the diff) | conversation */
  kind: string;
  id: number;
  author: string;
  /** The review state; empty for comments. */
  state: string;
  body: string;
  url: string;
  path: string | null;
  line: number | null;
}

/** An approval without words asks nothing of the agent. */
export const actionable = (a: Activity) => !(a.kind === "review" && a.state === "APPROVED" && a.body.trim() === "");

export interface PrActivity {
  repo: string;
  number: number;
  title: string;
  url: string;
  items: Activity[];
}

export const prId = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;
const idOfPr = (p: PrActivity) => prId(p.repo, p.number);

/** A session handed activity, until its turn on it ends. */
interface Handling {
  started: boolean;
  /** Date.now() when the message went out (or was claimed). */
  since: number;
  prs: PrActivity[];
  /** The turn ended before the send resolved: tell the user once it has. */
  done?: { status: string; reply: string | null };
}

/** Take what was handed over out of a session's queue, item by item: more may have been added to the same PR while sending. */
export function removeItems(queue: PrActivity[], sent: PrActivity[]): PrActivity[] {
  return queue
    .map((pr) => {
      const done = sent.find((s) => idOfPr(s) === idOfPr(pr));
      return done ? { ...pr, items: pr.items.filter((i) => !done.items.some((d) => d.kind === i.kind && d.id === i.id)) } : pr;
    })
    .filter((pr) => pr.items.length > 0);
}

const prSummary = (p: PrActivity) => ({ repo: p.repo, number: p.number, title: p.title, url: p.url });

export class FollowService implements Gh {
  follows = new Map<string, Followed>();
  /** Session id -> activity waiting until the session is free. */
  pending = new Map<string, PrActivity[]>();
  handling = new Map<string, Handling>();
  /** Sessions a hand-over is being sent to (`send` with `whenFree` resolves once delivered). */
  sending = new Set<string>();
  private pollGate = new Lock();
  /** Session id -> Date.now() when its worktree branch was last looked up without a PR found. */
  branchLookups = new Map<string, number>();
  /** PR id -> when it was last read, and last updated then. */
  reads = new Map<string, LastRead>();
  private store: Collection<Followed>;
  private pendingStore: Collection<PrActivity[]>;
  private saving = new Map<string, Promise<unknown>>();

  constructor(
    private aura: DaemonApi,
    public gh: Github,
    public lib: Lib,
    private links: Links,
    private tasks: Tasks,
  ) {
    this.store = aura.storage.collection<Followed>(NAMESPACE);
    this.pendingStore = aura.storage.collection<PrActivity[]>(PENDING_NAMESPACE);
  }

  async load(): Promise<void> {
    for (const [id, f] of await this.store.all()) if (f && typeof f === "object") this.follows.set(id, { ...f, merged: f.merged === true });
    for (const [sid, q] of await this.pendingStore.all()) if (Array.isArray(q)) this.pending.set(sid, q);
  }

  /** Start the 60 s loop and follow session events; returns the event subscriptions' disposers. */
  launch(): Array<() => void> {
    this.tasks.spawn("review follow-ups", async () => {
      while (!this.tasks.stopped) {
        await this.poll().catch((e) => console.warn(`review follow-ups: ${message(e)}`));
        await this.tasks.sleep(await this.gh.pace(POLL_INTERVAL_MS).catch(() => POLL_INTERVAL_MS));
      }
    });
    return this.listen();
  }

  /** Follow session events (see `onEvent`). */
  listen(): Array<() => void> {
    const on = (type: CoreEvent["type"]) => this.aura.events.on(type, (e) => void this.onEvent(e as CoreEvent));
    return [on("turn_started"), on("turn_completed"), on("process_exited"), on("approval_resolved"), on("user_input_resolved")];
  }

  /** Follow the turns of sessions handed activity, and hand over what waits once a session is free. */
  async onEvent(ev: CoreEvent): Promise<void> {
    if (!("session_id" in ev)) return;
    const sid = ev.session_id;
    switch (ev.type) {
      case "turn_started": {
        const h = this.handling.get(sid);
        if (h) h.started = true;
        break;
      }
      case "turn_completed": {
        const h = this.handling.get(sid);
        if (h && h.started) {
          // While the send is still resolving the hand-over stays claimed, and the user
          // hears of the end after hearing of the start.
          const sending = this.sending.has(sid);
          if (!sending) this.handling.delete(sid);
          const status = ev.turn.status === "completed" ? "completed" : ev.turn.status === "interrupted" ? "interrupted" : "failed";
          const reply =
            ev.turn.status === "completed" ? await this.lastReply(sid) : (ev.turn.error ?? (await this.lastReply(sid)));
          if (sending && this.sending.has(sid)) h.done = { status, reply };
          else {
            if (this.handling.get(sid) === h) this.handling.delete(sid);
            await this.handled(sid, h.prs, status, reply);
          }
        }
        // Right after the user interrupted it, the session would only be set going
        // again; the next poll hands the rest over.
        if (ev.turn.status !== "interrupted") await this.flush(sid);
        break;
      }
      case "process_exited": {
        const h = this.handling.get(sid);
        if (h) {
          this.handling.delete(sid);
          await this.handled(sid, h.prs, ev.message != null ? "failed" : "stopped", ev.message);
        }
        break;
      }
      case "approval_resolved":
      case "user_input_resolved":
        await this.flush(sid);
        break;
    }
  }

  private async lastReply(sid: string): Promise<string | null> {
    return this.aura.sessions.lastReply(sid).catch(() => null);
  }

  async handled(sid: string, prs: PrActivity[], status: string, reply: string | null): Promise<void> {
    const title = (await this.aura.sessions.get(sid).catch(() => null))?.title ?? "";
    this.aura.emit("follows.handled", { session: { id: sid, title }, prs: prs.map(prSummary), status, reply });
  }

  /** Change a session's queue and save it. */
  editPending(sid: string, edit: (queue: PrActivity[]) => PrActivity[]): Promise<void> {
    const queue = edit([...(this.pending.get(sid) ?? [])]);
    if (queue.length === 0) this.pending.delete(sid);
    else this.pending.set(sid, queue);
    const before = this.saving.get(sid) ?? Promise.resolve();
    const saved = before
      .catch(() => {})
      .then(() => (queue.length === 0 ? this.pendingStore.delete(sid) : this.pendingStore.put(sid, queue)))
      .catch((e) => console.warn(`saving review follow-ups for ${sid} failed: ${message(e)}`));
    this.saving.set(sid, saved);
    return saved;
  }

  /** Hand a session the activity waiting for it, if it is free to take it. */
  async flush(sid: string): Promise<void> {
    const waiting = this.pending.get(sid);
    if (!waiting || waiting.length === 0) return;
    const session = await this.aura.sessions.get(sid).catch(() => null);
    if (!session) {
      await this.editPending(sid, () => []);
      return;
    }
    // One hand-over per session at a time; claimed before sending so the turn's start is not missed.
    if (this.handling.has(sid) || this.sending.has(sid)) return;
    const batch = structuredCloneish(this.pending.get(sid) ?? []);
    if (batch.length === 0) return;
    const h: Handling = { started: false, since: Date.now(), prs: batch };
    this.handling.set(sid, h);
    this.sending.add(sid);
    const text = handOverMessage(batch, session.orchestrator);
    try {
      // SDK-GAP: `send` with `whenFree` waits for the session to be free instead of
      // answering "not now" (former `send_when_free` returning false); the hand-over
      // stays claimed meanwhile, so nothing is sent twice.
      await this.aura.sessions.send(sid, text, { whenFree: true });
    } catch (e) {
      this.sending.delete(sid);
      this.handling.delete(sid);
      await this.editPending(sid, (q) => removeItems(q, batch));
      await this.handled(sid, batch, "failed", `Could not send it the review activity: ${message(e)}`);
      return;
    }
    this.sending.delete(sid);
    h.since = Date.now();
    await this.editPending(sid, (q) => removeItems(q, batch));
    this.aura.emit("follows.started", { session: { id: sid, title: session.title }, prs: batch.map(prSummary) });
    if (h.done) {
      if (this.handling.get(sid) === h) this.handling.delete(sid);
      await this.handled(sid, h.prs, h.done.status, h.done.reply);
      await this.flush(sid);
    }
  }

  /** One pass: find new activity on every linked PR and hand it over. */
  poll(): Promise<void> {
    return this.pollGate.run(async () => {
      const blocked = await this.gh.blocked();
      if (blocked) return console.debug(`review follow-ups paused: ${blocked}`);
      let me: string;
      try {
        me = loginOf(await this.gh.account());
      } catch (e) {
        return console.debug(`review follow-ups skipped: ${message(e)}`);
      }
      const sessions = (await this.aura.sessions.list()).filter((s) => !s.archived && s.mode === "structured" && s.provider !== "terminal");
      // Drop what waits for sessions that are gone or archived.
      const live = new Set(sessions.map((s) => s.id));
      for (const sid of [...this.pending.keys()]) if (!live.has(sid)) await this.editPending(sid, () => []);
      // A hand-over whose turn never started would block the session for good.
      for (const [sid, h] of [...this.handling]) {
        if (!h.started && !this.sending.has(sid) && Date.now() - h.since >= START_TIMEOUT_MS) this.handling.delete(sid);
      }
      const links = await this.links.all();
      const followed = new Map<string, PrId[]>();
      for (const s of sessions) {
        const ids = (await this.links.followsReviews(s.id)) ? prIds(links[s.id]) : [];
        const branch = await this.findBranchPull(s, ids);
        if (branch && !ids.some(([r, n]) => eqi(r, branch[0]) && n === branch[1])) ids.push(branch);
        followed.set(s.id, ids);
      }
      const linked = new Map<string, { repo: string; number: number; linking: Session[] }>();
      for (const s of sessions) {
        for (const [repo, number] of followed.get(s.id) ?? []) {
          const id = prId(repo, number);
          const entry = linked.get(id) ?? { repo, number, linking: [] };
          entry.linking.push(s);
          linked.set(id, entry);
        }
      }
      const notified = await this.gh.notified();
      const now = nowIso();
      const due: Array<{ id: string; repo: string; number: number; known: Followed | null; linking: Session[] }> = [];
      for (const id of [...linked.keys()].sort()) {
        const { repo, number, linking } = linked.get(id)!;
        const known = this.follows.get(id) ?? null;
        if (known && (known.merged || !eqi(known.author, me))) continue;
        const read = this.reads.get(id) ?? null;
        const readNow =
          known && !known.open
            ? this.lib.dueClosed(read ? read[0] : null, notified, repo, number, now)
            : this.lib.due(read, notified, repo, number, now);
        if (readNow) due.push({ id, repo, number, known, linking });
      }
      if (due.length > 0) {
        try {
          const checked = await this.check(
            due.map((d) => [d.repo, d.number, d.known]),
            me,
          );
          for (const [i, d] of due.entries()) {
            const result = checked[i];
            if (result instanceof Error) {
              console.warn(`review follow-up for ${d.id} failed: ${result.message}`);
              // A PR GitHub cannot return (one deleted, an issue's link) is tried again with the quiet ones.
              this.reads.set(d.id, [now, new Date(0).toISOString()]);
            } else if (result) {
              await this.found(d.id, d.linking, result);
            }
          }
        } catch (e) {
          console.warn(`review follow-ups failed: ${message(e)}`);
        }
      }
      for (const sid of [...this.pending.keys()]) await this.flush(sid);
    });
  }

  /**
   * The PR of a worktree session's branch, recorded with the github mod when found.
   * Looked up once per session (marked in this mod's session data); a branch without
   * a PR is asked about again after BRANCH_LOOKUP_INTERVAL.
   */
  async findBranchPull(s: Session, followed: PrId[]): Promise<PrId | null> {
    const worktree = s.worktree;
    if (!worktree) return null;
    const data = this.aura.sessions.data(s.id);
    const recorded = await data.get<string>(BRANCH_PULL_KEY).catch(() => undefined);
    if (typeof recorded === "string") return null;
    if (!(await this.links.followsReviews(s.id))) return null;
    const last = this.branchLookups.get(s.id);
    if (last !== undefined && Date.now() - last < BRANCH_LOOKUP_INTERVAL_MS) return null;
    this.branchLookups.set(s.id, Date.now());
    // As the app: the folder's GitHub repository, and its upstream's for a fork.
    let repo: string | null = null;
    let head: string | null = null;
    try {
      const remotes = await this.aura.git.remotes(s.cwd);
      for (const name of ["upstream", "github", "origin"]) {
        const r = remotes.find((x) => x.name === name);
        const parsed = r ? parseGithubRemote(r.url.trim()) : null;
        if (parsed) {
          repo = parsed;
          break;
        }
      }
      if (!repo) return null;
      const status: any = await this.aura.git.branchStatus(s.cwd).catch(() => null);
      head = typeof status?.upstream_repo === "string" && status.upstream_repo ? status.upstream_repo : repo;
    } catch (e) {
      console.debug(`branch of session ${s.id}: ${message(e)}`);
      return null;
    }
    try {
      const pull = await this.lib.branchPull(this.gh, repo, head ?? repo, worktree.branch);
      if (!pull) return null;
      await this.links.record(s.id, pull.url);
      await data.set(BRANCH_PULL_KEY, pull.url);
      this.branchLookups.delete(s.id);
      const id: PrId = [pull.repo || repo, pull.number];
      return followed.some(([r, n]) => eqi(r, id[0]) && n === id[1]) ? null : id;
    } catch (e) {
      console.debug(`PR of ${worktree.branch} in ${repo}: ${message(e)}`);
      return null;
    }
  }

  /** Tell the user about new activity, and queue it for the session that takes it. */
  async found(id: string, linking: Session[], activity: PrActivity): Promise<void> {
    const to = activity.items.some(actionable) ? target(linking) : null;
    this.aura.emit("follows.activity", {
      pr: prSummary(activity),
      items: activity.items,
      session: to ? { id: to.id, title: to.title } : null,
    });
    if (to) {
      await this.editPending(to.id, (queue) => {
        const i = queue.findIndex((p) => idOfPr(p) === id);
        if (i < 0) return [...queue, activity];
        queue[i] = { ...queue[i], items: [...queue[i].items, ...activity.items] };
        return queue;
      });
    }
  }

  /** New activity on `prs` (`owner/repo`, number, where the daemon stood) since the last look, read in one go, recording the look. */
  async check(prs: Array<[string, number, Followed | null]>, me: string): Promise<Array<PrActivity | null | Error>> {
    const since: Array<[string, number, Since]> = prs.map(([repo, number, known]) => [
      repo,
      number,
      known
        ? { reviews: known.seen_review, comments: known.seen_comment, conversation: known.seen_conversation }
        : { reviews: null, comments: null, conversation: null },
    ]);
    const reads = await this.lib.read(this.gh, since);
    const out: Array<PrActivity | null | Error> = [];
    for (const [i, [repo, number, known]] of prs.entries()) {
      const read = reads[i];
      if (read === undefined) out.push(new Error("GitHub returned too few PRs"));
      else if (read instanceof Error) out.push(read);
      else {
        try {
          out.push(await this.record(repo, number, known, me, read));
        } catch (e) {
          out.push(e instanceof Error ? e : new Error(message(e)));
        }
      }
    }
    return out;
  }

  /** The activity in `read` newer than the last look at the PR, recording this look. */
  async record(repo: string, number: number, known: Followed | null, me: string, read: { node: any; at: string }): Promise<PrActivity | null> {
    const pull = read.node;
    const author = str(pull?.author, "login");
    const state = str(pull, "state");
    const open = state === "OPEN";
    const next: Followed = known
      ? { ...known }
      : { id: prId(repo, number), repo, number, author, open, merged: false, seen_review: 0, seen_comment: 0, seen_conversation: 0 };
    next.author = author;
    next.open = open;
    next.merged = state === "MERGED";
    const items: Activity[] = [];
    if (open && eqi(next.author, me)) {
      // The first look only records where things stand.
      const looked = known !== null;
      // Threads list comments by thread, not by id: each is held against where the last
      // look stood, and the new watermarks are taken after.
      const seen = [next.seen_review, next.seen_comment, next.seen_conversation];
      const byMe = (n: any) => eqi(str(n?.author, "login"), me);
      for (const n of nodes(pull?.reviews)) {
        const id = databaseId(n) ?? 0;
        const s = str(n, "state");
        // A comment-only review without words holds inline comments, which come separately.
        if (looked && id > seen[0] && !byMe(n) && RESPONSES.includes(s) && !(s === "COMMENTED" && str(n, "body").trim() === "")) {
          items.push(activity("review", n, s));
        }
        next.seen_review = Math.max(next.seen_review, id);
      }
      for (const n of nodes(pull?.reviewThreads).flatMap((t) => nodes(t?.comments))) {
        const id = databaseId(n) ?? 0;
        if (looked && id > seen[1] && !byMe(n)) {
          const item = activity("comment", n, "");
          item.path = typeof n?.path === "string" ? n.path : null;
          item.line = lineOf(n?.line) ?? lineOf(n?.originalLine);
          items.push(item);
        }
        next.seen_comment = Math.max(next.seen_comment, id);
      }
      for (const n of nodes(pull?.comments)) {
        const id = databaseId(n) ?? 0;
        const bot = n?.author?.__typename === "Bot" || str(n?.author, "login").endsWith("[bot]");
        if (looked && id > seen[2] && !byMe(n) && !bot) items.push(activity("conversation", n, ""));
        next.seen_conversation = Math.max(next.seen_conversation, id);
      }
    }
    await this.store.put(next.id, next);
    const updated = str(pull, "updatedAt");
    this.reads.set(next.id, [read.at, updated && !Number.isNaN(Date.parse(updated)) ? updated : read.at]);
    this.follows.set(next.id, next);
    if (items.length === 0) return null;
    items.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id - b.id));
    return { repo, number, title: str(pull, "title"), url: str(pull, "url"), items };
  }
}

function structuredCloneish<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function nodes(conn: any): any[] {
  return Array.isArray(conn?.nodes) ? conn.nodes : [];
}

function lineOf(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

export function activity(kind: string, n: any, state: string): Activity {
  return {
    kind,
    id: databaseId(n) ?? 0,
    author: str(n?.author, "login"),
    state,
    body: str(n, "body"),
    url: str(n, "url"),
    path: null,
    line: null,
  };
}

/**
 * The session that takes a PR's activity, so it goes to one session only: of the
 * sessions that follow it (linked to it or on its branch alike, all unarchived), skip
 * workers whose orchestrator follows it too (the orchestrator decides), then take the
 * one active last.
 */
export function target(linking: Session[]): Session | null {
  const ids = new Set(linking.map((s) => s.id));
  let best: Session | null = null;
  for (const s of linking) {
    if (s.orchestrator_id && ids.has(s.orchestrator_id)) continue;
    if (!best || Date.parse(s.last_activity) >= Date.parse(best.last_activity)) best = s;
  }
  return best;
}

/** The cut-off end of a long body is marked so the agent knows to look. */
function clip(body: string): string {
  const trimmed = body.trim();
  const bytes = new TextEncoder().encode(trimmed);
  if (bytes.length <= BODY_LIMIT) return trimmed;
  let end = BODY_LIMIT;
  // Back to a character boundary (not a UTF-8 continuation byte).
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return `${new TextDecoder().decode(bytes.slice(0, end))}… (cut; read the rest on GitHub)`;
}

/** The message a session gets about new review activity on its PRs. */
export function handOverMessage(prs: PrActivity[], orchestrator: boolean): string {
  let out = auraHeader("New review activity on your pull request");
  for (const pr of prs) {
    out += `\n## ${pr.repo}#${pr.number} ${pr.title}\n${pr.url}\n`;
    for (const item of pr.items) {
      let what: string;
      if (item.kind === "review") {
        what = item.state === "APPROVED" ? "approved" : item.state === "CHANGES_REQUESTED" ? "requested changes" : "reviewed";
      } else if (item.kind === "comment") {
        what =
          item.path !== null && item.line !== null
            ? `commented on \`${item.path}\` line ${item.line}`
            : item.path !== null
              ? `commented on \`${item.path}\``
              : "commented on the diff";
      } else what = "commented";
      out += `\n### ${item.author} ${what}\n${item.url}\n`;
      const body = clip(item.body);
      if (body !== "") out += `${body}\n`;
    }
  }
  out +=
    "\nGo through each point. Where a change is needed, make it, commit it and push it to the PR's branch. " +
    "Where you disagree, or a point needs the user's decision, leave the code alone and say why. " +
    "Do not post on GitHub unless the user asked you to. " +
    "End with a short summary for the user: what you changed, and what is left for them.";
  if (orchestrator) out += " If one of your workers owns this PR, you can hand the work to it.";
  return out;
}
