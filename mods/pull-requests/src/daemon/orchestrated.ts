// Pre-reviews an orchestrator records and changes through its tools
// (`orchestrator.reviews.*`, former aura-review orchestrated.rs), on the same
// drafts, checks and events as the user's review editor. A recorded draft is
// ready for the user as soon as it is complete; posting it to GitHub stays the
// user's.
//
// The orchestrator never changes what the user wrote or edited: findings the
// user authored or edited are theirs.
import type { Session } from "@aura/mod-sdk";
import type { PreReview, PullRequest, ReviewAgent, ReviewComment, ReviewConfig, ReviewResult } from "@aura/github-client";
import * as diffs from "./diff";
import { checkResult, type ReviewService } from "./reviews";
import { comment } from "./runner";
import { clone, eqi, fail, newId, nowIso, prNumber, required } from "./util";

/** A finding as an orchestrator writes it; missing fields take the editor's defaults. */
function finding(v: any): ReviewComment {
  if (!v || typeof v !== "object" || typeof v.path !== "string" || typeof v.body !== "string" || prNumber(v.line) === null) {
    fail("A finding needs `path`, `line` and `body`", "invalid");
  }
  if (v.start_line != null && prNumber(v.start_line) === null) fail("`start_line` must be a line number", "invalid");
  if (v.body.trim() === "") fail(`A finding at ${v.path}:${v.line} has no text`, "invalid");
  return comment({
    path: v.path.trim(),
    line: v.line,
    start_line: v.start_line ?? null,
    side: side(optStr(v, "side")),
    severity: severity(optStr(v, "severity")),
    body: v.body,
    rationale: typeof v.rationale === "string" && v.rationale.trim() !== "" ? v.rationale : null,
  });
}

export function side(v: string | null): string {
  const s = v === null ? "" : v.trim().toUpperCase();
  if (s === "" || s === "RIGHT") return "RIGHT";
  if (s === "LEFT") return "LEFT";
  fail(`Unknown side \`${s}\`: use RIGHT (added or unchanged lines) or LEFT (deleted lines)`, "invalid");
}

export function severity(v: string | null): string {
  const s = (v ?? "minor").trim().toLowerCase();
  if (!["blocker", "major", "minor", "nit", "praise"].includes(s)) {
    fail(`Unknown severity \`${s}\`: use blocker, major, minor, nit or praise`, "invalid");
  }
  return s;
}

/** `approve`, `comment` or `request_changes`, also as GitHub spells them. */
export function verdict(v: string): string {
  const s = v.trim().toLowerCase().replace(/[ -]/g, "_");
  if (s === "approve" || s === "approved") return "approve";
  if (s === "comment" || s === "commented") return "comment";
  if (s === "request_changes" || s === "changes_requested") return "request_changes";
  fail(`Unknown verdict \`${s}\`: use approve, comment or request_changes`, "invalid");
}

function risk(v: string): string {
  const s = v.trim().toLowerCase();
  if (!["low", "medium", "high"].includes(s)) fail(`Unknown risk \`${s}\`: use low, medium or high`, "invalid");
  return s;
}

function optStr(p: any, key: string): string | null {
  const v = p?.[key];
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function findings(v: unknown): ReviewComment[] {
  if (!Array.isArray(v)) fail("`comments` must be a list of findings", "invalid");
  return v.map(finding);
}

/** The finding is the user's: they wrote or edited it. */
const users = (c: ReviewComment) => c.user_authored || c.edited;

function revision(p: any): number | null {
  const v = p?.revision;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

function confidence(v: unknown): number {
  if (typeof v !== "number") fail("`confidence` must be a number from 0 to 1", "invalid");
  return v;
}

/** `pull` as `owner/repo#123` or a GitHub PR URL, or `repo` and `number`. */
export function pullArg(p: any): [string, number] {
  const given = optStr(p, "pull");
  if (given !== null) {
    const pull = given.trim().replace(/\/+$/, "");
    let parsed: [string, string] | null = null;
    const hash = pull.lastIndexOf("#");
    if (hash >= 0) parsed = [pull.slice(0, hash), pull.slice(hash + 1)];
    else {
      const at = pull.indexOf("github.com/");
      if (at >= 0) {
        const rest = pull.slice(at + "github.com/".length);
        const i = rest.indexOf("/pull/");
        if (i >= 0) parsed = [rest.slice(0, i), rest.slice(i + "/pull/".length).split(/[/?#]/)[0]];
      }
    }
    const n = parsed && /^\d+$/.test(parsed[1]) ? Number(parsed[1]) : 0;
    if (!parsed || !(n > 0 && n <= 4294967295) || parsed[0].split("/").length !== 2) {
      fail(`\`pull\` must be \`owner/repo#number\` or the PR's URL, not \`${pull}\``, "invalid");
    }
    return [parsed[0], n];
  }
  const repo = typeof p?.repo === "string" && p.repo !== "" ? (p.repo as string) : null;
  const number = prNumber(p?.number);
  if (repo === null || number === null) fail("Give `pull` as `owner/repo#number`", "invalid");
  return [repo, number];
}

const short = (id: string) => id.slice(0, 8);

/** The orchestrator session `id`. */
async function orchestrator(svc: ReviewService, id: string): Promise<Session> {
  const s = await svc.aura.sessions.get(id);
  if (!s) fail(`session ${short(id)} not found`, "not_found");
  if (!s.orchestrator) fail(`session ${short(id)} is not an orchestrator`, "permission_denied");
  return s;
}

/** The orchestrator's worker matching `key`: an id, a title or an id prefix. */
async function worker(svc: ReviewService, orchestratorId: string, given: string): Promise<Session> {
  const key = given.trim();
  const workers = (await svc.aura.sessions.list())
    .filter((s) => s.orchestrator_id === orchestratorId)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  const byId = workers.find((s) => s.id === key);
  if (byId) return byId;
  const titled = workers.filter((s) => s.title === key);
  if (titled.length === 1) return titled[0];
  if (titled.length > 1) {
    fail(
      `${titled.length} workers are titled \`${key}\`; use the id of the one you mean: ${titled.map((s) => `\`${s.id}\``).join(", ")}`,
      "invalid",
    );
  }
  const matches = workers.filter((s) => key !== "" && s.id.startsWith(key));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) fail(`no worker of this orchestrator matches \`${key}\`; list_sessions shows them`, "not_found");
  fail(`\`${key}\` matches several workers; use the full id`, "invalid");
}

/** The agent a session runs, as a review is signed with it, and as its configuration. */
function attribution(s: Session): [ReviewAgent, ReviewConfig] {
  // SDK-GAP: core lists no ACP agents' display names to a mod; an ACP agent signs with its id.
  const name =
    s.provider === "acp" && s.agent ? s.agent : s.provider === "claude" ? "Claude Code" : s.provider === "codex" ? "Codex" : s.provider;
  const model = s.model ? s.model : null;
  const effort = s.effort ? s.effort : null;
  return [
    { provider: name, model, model_id: null, effort },
    {
      provider: s.provider === "acp" && s.agent ? s.agent : s.provider,
      model,
      effort,
      prompt_mode: "default",
      prompt: "",
    },
  ];
}

/** A pre-review of the account the inbox shows. */
function own(svc: ReviewService, id: string): PreReview {
  const r = svc.state.reviews.find((r) => r.id === id);
  if (!r) fail(`No pre-review \`${id}\`; list_pull_requests shows them`, "not_found");
  if (svc.state.account !== r.pull.account) {
    fail(`Pre-review \`${id}\` belongs to another GitHub account than the one Aura is signed in with`, "permission_denied");
  }
  return clone(r);
}

/** Every `orchestrator.reviews.*` method, as RPC methods taking `orchestrator`. */
export function orchestratorMethods(svc: ReviewService): Record<string, (p: any) => Promise<unknown>> {
  const m = (fn: (s: Session, p: any) => Promise<unknown>) => async (p: any) => fn(await orchestrator(svc, required(p, "orchestrator")), p);
  return {
    "orchestrator.reviews.list": m(async (_, p) => {
      if (p.refresh === true) await svc.sync(true);
      return svc.snapshot();
    }),
    "orchestrator.reviews.get": m(async (_, p) => {
      const id = optStr(p, "review");
      if (id !== null) return own(svc, id);
      const [repo, number] = pullArg(p);
      const inbox = svc.snapshot();
      const listed = [...inbox.pulls, ...inbox.reviewed, ...inbox.mine].find((x) => eqi(x.repo, repo) && x.number === number);
      const pull: PullRequest = listed ?? (await svc.lookup({ repo, number }));
      return { pull, reviews: inbox.reviews.filter((r) => eqi(r.pull.id, pull.id)) };
    }),
    "orchestrator.reviews.create": m((s, p) => record(svc, s, p)),
    "orchestrator.reviews.update": m(async (_, p) => {
      const id = required(p, "review");
      const current = own(svc, id);
      if (p.ready === false && current.status !== "drafting") {
        fail(`Only a new draft can be kept from the user; this one is ${current.status} already`);
      }
      let r: PreReview | null = null;
      const changes = ["summary", "verdict", "risk", "confidence", "comments"].some((k) => p[k] != null);
      if (changes) {
        const summary = typeof p.summary === "string" ? p.summary : null;
        const v = optStr(p, "verdict");
        const newVerdict = v === null ? null : verdict(v);
        const k = optStr(p, "risk");
        const newRisk = k === null ? null : risk(k);
        const comments = p.comments != null ? findings(p.comments) : null;
        r = await svc.saveDraft(id, revision(p), "agent", (r) => {
          const result: ReviewResult = clone(r.result);
          if (summary !== null) result.summary = summary;
          if (newVerdict !== null) result.verdict = newVerdict;
          if (newRisk !== null) result.risk = newRisk;
          if (p.confidence != null) result.confidence = confidence(p.confidence);
          if (comments !== null) result.comments = [...result.comments.filter(users), ...comments];
          return result;
        });
      }
      if (p.ready === true) return svc.markReady(id);
      if (p.ready === false && r === null) return current;
      if (r) return r;
      fail("Nothing to change: give summary, verdict, risk, confidence, comments or ready", "invalid");
    }),
    "orchestrator.reviews.add_comment": m(async (_, p) => {
      const id = required(p, "review");
      own(svc, id);
      const c = finding(p);
      c.id = newId();
      const r = await svc.saveDraft(id, revision(p), "agent", (r) => {
        const result = clone(r.result);
        result.comments.push(c);
        return result;
      });
      return { review: r, comment: c.id };
    }),
    "orchestrator.reviews.edit_comment": m(async (_, p) => editComment(svc, p, false)),
    "orchestrator.reviews.delete_comment": m(async (_, p) => editComment(svc, p, true)),
    "orchestrator.reviews.discard": m(async (_, p) => {
      const id = required(p, "review");
      own(svc, id);
      return svc.close(id, true);
    }),
    "orchestrator.reviews.start": m(async (_, p) => {
      const [repo, number] = pullArg(p);
      const defaults = svc.state.defaults;
      const instructions = optStr(p, "instructions");
      const config: ReviewConfig = {
        provider: optStr(p, "agent") ?? defaults.provider,
        model: optStr(p, "model"),
        effort: optStr(p, "effort"),
        prompt_mode: instructions !== null ? "append" : "default",
        prompt: instructions ?? "",
      };
      return svc.start({ repo, number, config }, false);
    }),
    "orchestrator.reviews.hide": m(async (_, p) => {
      const [repo, number] = pullArg(p);
      const account = await svc.gh.account();
      const given = `${repo}#${number}`;
      // Hidden PRs are keyed by the id as GitHub spells it.
      const inbox = svc.snapshot();
      const id = [...inbox.pulls, ...inbox.reviewed, ...inbox.mine].find((x) => eqi(x.id, given))?.id ?? given;
      return svc.hide(account, id, p.hidden !== false);
    }),
  };
}

function editComment(svc: ReviewService, p: any, remove: boolean): Promise<PreReview> {
  const id = required(p, "review");
  const commentId = required(p, "comment");
  own(svc, id);
  return svc.saveDraft(id, revision(p), "agent", (r) => {
    const result = clone(r.result);
    const c = result.comments.find((c) => c.id === commentId);
    if (!c) fail(`The review has no finding \`${commentId}\``, "not_found");
    if (users(c)) fail(`The user wrote or edited finding \`${commentId}\`; leave it to them`, "permission_denied");
    if (remove) {
      c.deleted = p.restore !== true;
      return result;
    }
    const path = optStr(p, "path");
    if (path !== null) c.path = path.trim();
    if (typeof p.line === "number" && Number.isInteger(p.line) && p.line >= 0) c.line = p.line;
    if ("start_line" in p) {
      if (p.start_line === null) c.start_line = null;
      else if (typeof p.start_line === "number" && Number.isInteger(p.start_line) && p.start_line >= 0) c.start_line = p.start_line;
      else fail("`start_line` must be a line number", "invalid");
    }
    if ("side" in p) c.side = side(optStr(p, "side"));
    if ("severity" in p) c.severity = severity(optStr(p, "severity"));
    if (typeof p.body === "string") {
      if (p.body.trim() === "") fail("`body` is empty: use delete_review_comment to remove a finding", "invalid");
      c.body = p.body;
    }
    if (typeof p.rationale === "string") c.rationale = p.rationale.trim() !== "" ? p.rationale : null;
    return result;
  });
}

/**
 * Record a review an agent did as a pre-review draft, against the PR's diff at the
 * reviewed commit. It is ready for the user unless `ready` is false.
 */
async function record(svc: ReviewService, o: Session, p: any): Promise<PreReview> {
  const [repo, number] = pullArg(p);
  const w = optStr(p, "worker");
  const by = w === null ? null : await worker(svc, o.id, w);
  const result: ReviewResult = {
    summary: typeof p.summary === "string" ? p.summary : "",
    verdict: verdict(required(p, "verdict")),
    risk: optStr(p, "risk") !== null ? risk(p.risk) : "medium",
    confidence: p.confidence != null ? confidence(p.confidence) : null,
    comments: p.comments != null ? findings(p.comments) : [],
  };
  if (result.summary.trim() === "" && result.comments.length === 0) {
    fail("Give the review a `summary` or at least one finding", "invalid");
  }
  checkResult(result);
  let agent: ReviewAgent;
  let config: ReviewConfig;
  if (p.agent == null) {
    [agent, config] = attribution(by ?? o);
  } else {
    const a = p.agent;
    const opt = (x: unknown) => (typeof x === "string" ? x : null);
    if (!a || typeof a !== "object" || typeof a.provider !== "string") {
      fail("`agent` needs `provider`, and may have `model`, `model_id` and `effort`", "invalid");
    }
    if (a.provider.trim() === "") fail("`agent.provider` is empty", "invalid");
    agent = { provider: a.provider, model: opt(a.model), model_id: opt(a.model_id), effort: opt(a.effort) };
    config = { provider: a.provider.toLowerCase(), model: agent.model, effort: agent.effort, prompt_mode: "default", prompt: "" };
  }
  return svc.gate.run(async () => {
    const pull = await svc.lookup({ repo, number });
    if (pull.state !== "open") fail(`${pull.id} is no longer open`);
    const commit = optStr(p, "commit") ?? pull.head_sha;
    const [diff, mergeBase] = await svc.compare(pull, commit);
    if ([...diffs.positions(diff).values()].every(([a, b]) => a.size === 0 && b.size === 0)) {
      fail(`${pull.id} has no textual diff to review`);
    }
    diffs.validate(result.comments, diff, false);
    const ready = p.ready !== false;
    const ts = nowIso();
    const review: PreReview = {
      id: newId(),
      pull,
      config,
      instructions: `Recorded with Aura's review tools by the orchestrator ${o.title}${
        by ? `, from the review by its worker ${by.title}` : ""
      }.`,
      status: ready ? "ready" : "drafting",
      phase: ready ? "done" : "drafting",
      error: null,
      created_at: ts,
      updated_at: ts,
      revision: 0,
      reviewed_sha: commit,
      merge_base: mergeBase,
      context_mode: "recorded",
      context_note: null,
      diff,
      log_tail: [],
      result,
      submitted_url: null,
      submission: null,
      agent,
      source: { orchestrator: o.id, orchestrator_title: o.title, worker: by?.id ?? null, worker_title: by?.title ?? null },
    };
    await svc.aura.storage.collection<PreReview>("reviews").put(review.id, review);
    svc.state.reviews.push(review);
    svc.emit();
    return clone(review);
  });
}
