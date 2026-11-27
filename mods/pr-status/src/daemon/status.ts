// A pull request's state, reviewers, checks and merge readiness, read in one GraphQL query
// for many PRs (the client's `batchNodes`), the follow-up pages of the long lists, and the
// pure mapping from GitHub's answer.
import { BATCH, batchNodes, chunks, has, list, messageOf, requestedReviewers, s, sameText, show, type Github } from "@aura/github-client";
import type { Blocker, Check, Checks, ChecksState, PrRef, PrState, PrStatus, Readiness, Reviewer, Reviewers, ReviewState } from "../shared/types";

export const PAGE = "pageInfo{hasNextPage endCursor}";
const CONTEXT = "__typename ... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{context state targetUrl}";
const REVIEW = "state author{__typename login}";
const OPINION = "state author{login}";

export const STATUS_FRAGMENT =
  "fragment pull on PullRequest{number title url state isDraft mergeable mergeStateStatus reviewDecision updatedAt author{login} " +
  "headRefOid headRefName isCrossRepository " +
  `reviewRequests(first:100){${PAGE} nodes{requestedReviewer{__typename ... on User{login} ... on Team{combinedSlug} ... on Bot{login} ... on Mannequin{login}}}} ` +
  `commits(last:1){nodes{commit{oid statusCheckRollup{state contexts(first:100){totalCount ${PAGE} nodes{${CONTEXT}}}}}}} ` +
  `latestReviews(first:100){${PAGE} nodes{${REVIEW}}} ` +
  `latestOpinionatedReviews(first:100){${PAGE} nodes{${OPINION}}}` +
  "}";

/** What the batch reads of each repository: whether it squashes, and what the viewer may do. */
export const REPO_FIELDS = "squashMergeAllowed viewerPermission";
const WRITERS = ["ADMIN", "MAINTAIN", "WRITE"];

/** Pages read of one list, the first included; past this the list is marked incomplete. */
export const MAX_PAGES = 10;

const SHOWN: ReviewState[] = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"];
const OPINIONS: ReviewState[] = ["APPROVED", "CHANGES_REQUESTED"];
const REVIEW_ORDER: Record<ReviewState, number> = { CHANGES_REQUESTED: 0, APPROVED: 1, COMMENTED: 2, DISMISSED: 3, PENDING: 4 };
const KIND_ORDER = { user: 0, bot: 1, team: 2 } as const;

const more = (conn: any) => conn?.pageInfo?.hasNextPage === true;

/**
 * Each reviewer's verdict: their latest approval or change request, else their latest review
 * (a comment, or one that was dismissed). The author's own replies are left out.
 */
function verdicts(node: any): Array<{ name: string; bot: boolean; state: ReviewState }> {
  const author = s(node?.author, "login");
  const opinion = (login: string) => {
    const n = list(node?.latestOpinionatedReviews?.nodes).find((o) => typeof o?.author?.login === "string" && sameText(o.author.login, login));
    const state = s(n, "state") as ReviewState;
    return OPINIONS.includes(state) ? state : null;
  };
  const latest = list(node?.latestReviews?.nodes).flatMap((n) => {
    const name = s(n?.author, "login");
    if (!name || (author && sameText(name, author))) return [];
    const latest = s(n, "state") as ReviewState;
    const state = opinion(name) ?? (SHOWN.includes(latest) ? latest : null);
    return state ? [{ name, bot: n?.author?.__typename === "Bot" || name.endsWith("[bot]"), state }] : [];
  });
  // A re-requested reviewer drops out of latestReviews (cli#13899), but their approval or change
  // request stays in latestOpinionatedReviews, and still decides the PR.
  const opinionOnly = list(node?.latestOpinionatedReviews?.nodes).flatMap((n) => {
    const name = s(n?.author, "login");
    const state = s(n, "state") as ReviewState;
    if (!name || !OPINIONS.includes(state) || (author && sameText(name, author)) || latest.some((v) => sameText(v.name, name))) return [];
    return [{ name, bot: name.endsWith("[bot]"), state }];
  });
  return [...latest, ...opinionOnly];
}

/**
 * Who reviewed and who is still to review. A requested reviewer is pending, also when
 * re-requested after a review (that review is kept as `previous`); everyone else who
 * reviewed shows their verdict, a dismissed review as `DISMISSED`.
 */
export function reviewerGroups(node: any, complete = true): Reviewers {
  const reviews = verdicts(node);
  const requested = requestedReviewers(node?.reviewRequests?.nodes);
  const pending: Reviewer[] = requested.map((r) => {
    const before = reviews.find((v) => sameText(v.name, r.name));
    const kind = r.kind === "team" || r.kind === "bot" ? r.kind : "user";
    return { name: r.name, kind, state: "PENDING", previous: before?.state ?? null };
  });
  const reviewed: Reviewer[] = reviews
    .filter((v) => !requested.some((r) => sameText(r.name, v.name)))
    .map((v) => ({ name: v.name, kind: v.bot ? "bot" : "user", state: v.state, previous: null }));
  const byName = (a: Reviewer, b: Reviewer) => a.name.localeCompare(b.name);
  return {
    reviewed: reviewed.sort((a, b) => REVIEW_ORDER[a.state] - REVIEW_ORDER[b.state] || byName(a, b)),
    pending: pending.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || byName(a, b)),
    complete: complete && !more(node?.reviewRequests) && !more(node?.latestReviews) && !more(node?.latestOpinionatedReviews),
  };
}

export const FAILED = ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"];
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

const ROLLUP: Record<string, ChecksState> = { SUCCESS: "passing", FAILURE: "failing", ERROR: "failing", PENDING: "pending", EXPECTED: "pending" };

/**
 * The head commit's checks: counts, an overall state, and the failing and pending ones by
 * name. When not every check was read (more than `totalCount` says, or pages left), the
 * overall state is GitHub's own rollup, which covers them all.
 */
export function checksRollup(rollup: any, allRead = true): Checks {
  const nodes = list(rollup?.contexts?.nodes);
  const all = nodes.flatMap((n) => checkOf(n) ?? []);
  const count = (state: Check["state"]) => all.filter((c) => c.state === state).length;
  const passing = count("passing");
  const failing = count("failing");
  const pending = count("pending");
  const totalCount = typeof rollup?.contexts?.totalCount === "number" ? rollup.contexts.totalCount : 0;
  const total = Math.max(totalCount, all.length);
  const complete = allRead && !more(rollup?.contexts) && nodes.length >= totalCount;
  const counted: ChecksState = failing ? "failing" : pending ? "pending" : passing ? "passing" : "none";
  const aggregate = ROLLUP[s(rollup, "state")];
  const state: ChecksState = complete ? (counted === "none" ? aggregate ?? "none" : counted) : aggregate ?? counted;
  const byName = (a: Check, b: Check) => a.name.localeCompare(b.name);
  const open = [...all.filter((c) => c.state === "failing").sort(byName), ...all.filter((c) => c.state === "pending").sort(byName)];
  return { state, passing, failing, pending, total, open, complete };
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
  // GitHub knows of checks or statuses that are not passing, whatever the ones read say.
  else if (p.mergeStateStatus === "UNSTABLE") reasons.push("unstable");
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

/** Which follow-up pages could not be read (MAX_PAGES reached, or a page failed). */
export interface Truncated {
  checks?: boolean;
  reviewers?: boolean;
}

/** A PR node read with `STATUS_FRAGMENT` (and its lists completed by `completeLists`). */
export function toStatus(ref: Pick<PrRef, "url" | "repo" | "number">, node: any, truncated: Truncated = {}, repo: any = null): PrStatus {
  const state = stateOf(node);
  const checks = checksRollup(node?.commits?.nodes?.[0]?.commit?.statusCheckRollup, !truncated.checks);
  return {
    url: s(node, "url") || ref.url,
    repo: ref.repo,
    number: ref.number,
    title: s(node, "title"),
    author: s(node?.author, "login"),
    updatedAt: s(node, "updatedAt"),
    state,
    reviewers: reviewerGroups(node, !truncated.reviewers),
    checks,
    readiness: mergeReadiness({
      state,
      mergeable: s(node, "mergeable"),
      mergeStateStatus: s(node, "mergeStateStatus"),
      reviewDecision: s(node, "reviewDecision"),
      checks: checks.state,
    }),
    merge: {
      reviewDecision: s(node, "reviewDecision"),
      mergeable: s(node, "mergeable"),
      mergeStateStatus: s(node, "mergeStateStatus"),
      headSha: s(node, "headRefOid"),
      headRef: s(node, "headRefName"),
      sameRepo: node?.isCrossRepository === false,
      // Unknown (an older answer) is not "not allowed": GitHub decides when asked.
      squashAllowed: repo?.squashMergeAllowed !== false,
      canMerge: WRITERS.includes(s(repo, "viewerPermission")),
      // Set by the reader: who read it, and so whose permissions `canMerge` are.
      account: "",
    },
  };
}

/**
 * Read the rest of a connection `conn` (as the batch returned it), page by page, appending
 * to its `nodes` and leaving its `pageInfo` at the last page read. False when pages are left.
 */
export async function rest(gh: Github, conn: any, query: string, variables: Record<string, unknown>, pick: (data: any) => any): Promise<boolean> {
  for (let page = 1; more(conn); page++) {
    if (page >= MAX_PAGES) return false;
    const reply = await gh.request("POST", "graphql", { query, variables: { ...variables, after: conn.pageInfo.endCursor } });
    if (has(reply, "errors")) throw new Error(show(reply.errors));
    const next = pick(reply?.data);
    if (!next || !Array.isArray(next.nodes)) throw new Error("GitHub returned no page");
    conn.nodes = [...list(conn.nodes), ...next.nodes];
    conn.pageInfo = next.pageInfo;
  }
  return true;
}

const PR_PAGE = (field: string, nodes: string) =>
  `query($owner:String!,$name:String!,$number:Int!,$after:String!){repository(owner:$owner,name:$name){pullRequest(number:$number){${field}(first:100,after:$after){${PAGE} nodes{${nodes}}}}}}`;
const CHECKS_PAGE =
  `query($owner:String!,$name:String!,$oid:GitObjectID!,$after:String!){repository(owner:$owner,name:$name){object(oid:$oid){... on Commit{statusCheckRollup{contexts(first:100,after:$after){${PAGE} nodes{${CONTEXT}}}}}}}}`;

/** Read the pages the batch left of the PR's checks and reviews; what stays unread is reported. */
export async function completeLists(gh: Github, ref: Pick<PrRef, "repo" | "number">, node: any): Promise<Truncated> {
  const [owner, name] = ref.repo.split("/");
  const read = (p: Promise<boolean>) => p.then((done) => !done, (e) => {
    console.warn(`PR status: could not read every page of ${ref.repo}#${ref.number}: ${messageOf(e)}`);
    return true;
  });
  const commit = node?.commits?.nodes?.[0]?.commit;
  const checks = await read(rest(gh, commit?.statusCheckRollup?.contexts, CHECKS_PAGE, { owner, name, oid: s(commit, "oid") },
    (d) => d?.repository?.object?.statusCheckRollup?.contexts));
  const pr = { owner, name, number: ref.number };
  const reviews = await read(rest(gh, node?.latestReviews, PR_PAGE("latestReviews", REVIEW), pr, (d) => d?.repository?.pullRequest?.latestReviews));
  const opinions = await read(rest(gh, node?.latestOpinionatedReviews, PR_PAGE("latestOpinionatedReviews", OPINION), pr,
    (d) => d?.repository?.pullRequest?.latestOpinionatedReviews));
  return { checks, reviewers: reviews || opinions };
}

/** The status of each PR in `refs`, in order; a PR GitHub could not return is an Error in its slot. */
export async function readStatuses(gh: Github, refs: Array<Pick<PrRef, "url" | "repo" | "number">>): Promise<Array<PrStatus | Error>> {
  const out: Array<PrStatus | Error> = [];
  for (const part of chunks(refs, BATCH)) {
    try {
      const nodes = await batchNodes(gh, part.map((r) => [r.repo, r.number]), "", {}, REPO_FIELDS, STATUS_FRAGMENT);
      for (const [i, n] of nodes.entries()) {
        if (n instanceof Error) out.push(n);
        else out.push(toStatus(part[i], n[1], await completeLists(gh, part[i], n[1]), n[0]));
      }
    } catch (e) {
      const error = e instanceof Error ? e : new Error(messageOf(e));
      out.push(...part.map(() => error));
    }
  }
  return out;
}
