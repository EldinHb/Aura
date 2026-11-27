// A pull request's state, reviewers, checks and merge readiness, read in one GraphQL query
// for many PRs (the client's `batchNodes`), and the pure mapping from GitHub's answer.
import { BATCH, batchNodes, chunks, list, messageOf, REVIEWS_QUERY, requestedReviewers, reviewsByOthers, s, sameText, type Github } from "@aura/github-client";
import type { Blocker, Check, Checks, ChecksState, PrRef, PrState, PrStatus, Readiness, Reviewer, Reviewers, ReviewState } from "../shared/types";

export const STATUS_FRAGMENT =
  "fragment pull on PullRequest{number title url state isDraft mergeable mergeStateStatus reviewDecision author{login} " +
  "reviewRequests(first:50){nodes{requestedReviewer{__typename ... on User{login} ... on Team{combinedSlug} ... on Bot{login} ... on Mannequin{login}}}} " +
  "commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:100){totalCount nodes{__typename " +
  "... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{context state targetUrl}}}}}}} " +
  REVIEWS_QUERY +
  "}";

const REVIEW_STATES: ReviewState[] = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"];
const REVIEW_ORDER: Record<ReviewState, number> = { CHANGES_REQUESTED: 0, APPROVED: 1, COMMENTED: 2, PENDING: 3 };
const KIND_ORDER = { user: 0, bot: 1, team: 2 } as const;

/**
 * Who reviewed and who is still to review. A requested reviewer is pending, also when
 * re-requested after a review (that review is kept as `previous`); everyone else who
 * reviewed shows their latest verdict. The author's own replies are left out.
 */
export function reviewerGroups(node: any): Reviewers {
  const author = s(node?.author, "login");
  const reviews = reviewsByOthers(node, author ? [author] : []);
  const requested = requestedReviewers(node?.reviewRequests?.nodes);
  const pending: Reviewer[] = requested.map((r) => {
    const before = reviews.find((v) => sameText(v.reviewer, r.name));
    const kind = r.kind === "team" || r.kind === "bot" ? r.kind : "user";
    return { name: r.name, kind, state: "PENDING", previous: before ? (before.state as ReviewState) : null };
  });
  const reviewed: Reviewer[] = reviews
    .filter((v) => REVIEW_STATES.includes(v.state as ReviewState) && !requested.some((r) => sameText(r.name, v.reviewer)))
    .map((v) => ({ name: v.reviewer, kind: v.bot ? "bot" : "user", state: v.state as ReviewState, previous: null }));
  const byName = (a: Reviewer, b: Reviewer) => a.name.localeCompare(b.name);
  return {
    reviewed: reviewed.sort((a, b) => REVIEW_ORDER[a.state] - REVIEW_ORDER[b.state] || byName(a, b)),
    pending: pending.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || byName(a, b)),
  };
}

const FAILED = ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"];
const PASSED = ["SUCCESS", "NEUTRAL", "SKIPPED"];

function checkOf(n: any): Check | null {
  if (n?.__typename === "CheckRun") {
    const name = s(n, "name");
    const url = s(n, "detailsUrl") || null;
    if (n.status !== "COMPLETED") return { name, url, state: "pending" };
    const conclusion = s(n, "conclusion");
    return { name, url, state: FAILED.includes(conclusion) ? "failing" : PASSED.includes(conclusion) ? "passing" : "pending" };
  }
  if (n?.__typename === "StatusContext") {
    const state = s(n, "state");
    return { name: s(n, "context"), url: s(n, "targetUrl") || null, state: state === "SUCCESS" ? "passing" : FAILED.includes(state) ? "failing" : "pending" };
  }
  return null;
}

/** The head commit's checks: counts, an overall state, and the failing and pending ones by name. */
export function checksRollup(rollup: any): Checks {
  const all = list(rollup?.contexts?.nodes).flatMap((n) => checkOf(n) ?? []);
  const count = (state: Check["state"]) => all.filter((c) => c.state === state).length;
  const passing = count("passing");
  const failing = count("failing");
  const pending = count("pending");
  const total = Math.max(typeof rollup?.contexts?.totalCount === "number" ? rollup.contexts.totalCount : 0, all.length);
  // Without the contexts themselves, GitHub's own rollup still tells the state.
  const fallback: Record<string, ChecksState> = { SUCCESS: "passing", FAILURE: "failing", ERROR: "failing", PENDING: "pending", EXPECTED: "pending" };
  const state: ChecksState = failing ? "failing" : pending ? "pending" : passing ? "passing" : fallback[s(rollup, "state")] ?? "none";
  const byName = (a: Check, b: Check) => a.name.localeCompare(b.name);
  const open = [...all.filter((c) => c.state === "failing").sort(byName), ...all.filter((c) => c.state === "pending").sort(byName)];
  return { state, passing, failing, pending, total, open };
}

/** Why an open PR cannot be merged yet, from GitHub's `mergeable`, `mergeStateStatus` and `reviewDecision`; null when not open. */
export function mergeReadiness(p: {
  state: PrState;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string;
  checks: ChecksState;
}): Readiness | null {
  if (p.state === "merged" || p.state === "closed") return null;
  const reasons: Blocker[] = [];
  if (p.state === "draft" || p.mergeStateStatus === "DRAFT") reasons.push("draft");
  if (p.reviewDecision === "CHANGES_REQUESTED") reasons.push("changes_requested");
  else if (p.reviewDecision === "REVIEW_REQUIRED") reasons.push("review_required");
  if (p.checks === "failing") reasons.push("checks_failing");
  else if (p.checks === "pending") reasons.push("checks_pending");
  if (p.mergeable === "CONFLICTING" || p.mergeStateStatus === "DIRTY") reasons.push("conflicts");
  if (p.mergeStateStatus === "BEHIND") reasons.push("behind");
  // Branch protection blocks for a reason not listed above (a rule, a required signature, …).
  if (p.mergeStateStatus === "BLOCKED" && reasons.length === 0) reasons.push("blocked");
  if (reasons.length === 0 && (p.mergeable === "UNKNOWN" || p.mergeStateStatus === "UNKNOWN" || !p.mergeStateStatus)) reasons.push("unknown");
  return { ready: reasons.length === 0, reasons };
}

function stateOf(node: any): PrState {
  const state = s(node, "state");
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return node?.isDraft === true ? "draft" : "open";
}

/** A PR node read with `STATUS_FRAGMENT`. */
export function toStatus(ref: Pick<PrRef, "url" | "repo" | "number">, node: any): PrStatus {
  const state = stateOf(node);
  const checks = checksRollup(node?.commits?.nodes?.[0]?.commit?.statusCheckRollup);
  return {
    url: s(node, "url") || ref.url,
    repo: ref.repo,
    number: ref.number,
    title: s(node, "title"),
    author: s(node?.author, "login"),
    state,
    reviewers: reviewerGroups(node),
    checks,
    readiness: mergeReadiness({
      state,
      mergeable: s(node, "mergeable"),
      mergeStateStatus: s(node, "mergeStateStatus"),
      reviewDecision: s(node, "reviewDecision"),
      checks: checks.state,
    }),
  };
}

/** The status of each PR in `refs`, in order; a PR GitHub could not return is an Error in its slot. */
export async function readStatuses(gh: Github, refs: Array<Pick<PrRef, "url" | "repo" | "number">>): Promise<Array<PrStatus | Error>> {
  const out: Array<PrStatus | Error> = [];
  for (const part of chunks(refs, BATCH)) {
    try {
      const nodes = await batchNodes(gh, part.map((r) => [r.repo, r.number]), "", {}, "", STATUS_FRAGMENT);
      nodes.forEach((n, i) => out.push(n instanceof Error ? n : toStatus(part[i], n[1])));
    } catch (e) {
      const error = e instanceof Error ? e : new Error(messageOf(e));
      out.push(...part.map(() => error));
    }
  }
  return out;
}
