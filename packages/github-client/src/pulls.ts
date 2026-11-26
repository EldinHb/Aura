// Pull request reads and writes (former aura-github lib.rs).
import { buffered, chunks, databaseId, has, list, s, sameText, show, u64, validateRepo, validateSha, type Github } from "./github";
import type { PullRequest, RequestedReviewer, SubmittedReview } from "./types";

/** A PR a search listed: [[`owner/repo`, number], updated_at]. */
export type Listed = [[string, number], string];

/**
 * Each reviewer's latest review and their latest approval or change request, as a GraphQL
 * selection on a pull request; read with `reviewsByOthers` (former `reviews_query!()`).
 */
export const REVIEWS_QUERY =
  "latestReviews(first:100){nodes{fullDatabaseId state submittedAt author{__typename login} commit{oid}}} latestOpinionatedReviews(first:100){nodes{state author{login}}}";

/** What a merge may do, read once per repository in a batch. */
export const REPO =
  "viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed viewerDefaultMergeMethod deleteBranchOnMerge";

/** A PR with your latest review, who reviewed and was asked to, open review threads, and who last pushed, commented, merged or closed it. */
export const PULL =
  "fragment pull on PullRequest{number title body url author{login} state isDraft baseRefName headRefName baseRefOid headRefOid createdAt updatedAt additions deletions changedFiles assignees(first:20){nodes{login}} labels(first:50){nodes{name}} milestone{number title} " +
  "viewerCanUpdate reviewDecision mergeStateStatus isCrossRepository mergedBy{login} commits(last:1){totalCount nodes{commit{statusCheckRollup{state} author{user{login}} committer{user{login}}}}} reviews(last:1,author:$login,states:[APPROVED,CHANGES_REQUESTED,COMMENTED,DISMISSED]){nodes{state submittedAt commit{oid}}} " +
  "timelineItems(last:50,itemTypes:[REVIEW_REQUESTED_EVENT]){nodes{... on ReviewRequestedEvent{createdAt requestedReviewer{__typename ... on User{login}}}}} " +
  "reviewRequests(first:20){nodes{requestedReviewer{__typename ... on User{login} ... on Team{combinedSlug} ... on Bot{login} ... on Mannequin{login}}}} " +
  "reviewThreads(first:100){nodes{isResolved comments(last:3){nodes{fullDatabaseId author{__typename login}}}}} " +
  "comments(last:20){nodes{fullDatabaseId author{__typename login}}} " +
  "stateEvents:timelineItems(last:1,itemTypes:[CLOSED_EVENT,REOPENED_EVENT]){nodes{... on ClosedEvent{actor{login}} ... on ReopenedEvent{actor{login}}}} " +
  REVIEWS_QUERY +
  "}";

/** PRs read per GraphQL query. */
export const BATCH = 20;

/** A comment, by GitHub's database id (former `Note`). */
export interface Note {
  id: number;
  author: string;
  bot: boolean;
}

/** Former `LatestReview`. */
export interface LatestReview {
  id: number;
  reviewer: string;
  bot: boolean;
  /** `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED` or `PENDING`. */
  state: string;
}

/** The latest activity on a pull request, as far as one read shows it (former `PullActivity`). */
export interface PullActivity {
  /** Commits on the PR. */
  commits: number;
  /** Logins of the head commit's author and committer, where GitHub knows them. */
  pushed_by: string[];
  /** The latest conversation comments, oldest first. */
  comments: Note[];
  /** The latest comments of each review thread. */
  thread_comments: Note[];
  /** Each reviewer's latest review as submitted, whatever their verdict stands at. */
  reviews: LatestReview[];
  /** Who merged it, or last closed or reopened it. */
  state_actor: string;
}

/**
 * Who did what lately on a PR `pulls` read. Like the former `#[serde(skip)] activity`
 * field it is not part of the PR's JSON: it rides on the object as a non-enumerable
 * property, so `JSON.stringify` and RPC leave it out. Undefined for a PR that did not
 * come from `pulls`/`pull` in this runtime.
 */
export function activityOf(p: PullRequest): PullActivity | undefined {
  return (p as { activity?: PullActivity }).activity;
}

/** Attach `activity` to `p` without making it part of its JSON. */
export function withActivity<T extends object>(p: T, activity: PullActivity): T {
  Object.defineProperty(p, "activity", { value: activity, enumerable: false, configurable: true, writable: true });
  return p;
}

/** A PullRequest with every field at its default, as `PullRequest::default()`. */
export function emptyPull(patch: Partial<PullRequest> = {}): PullRequest {
  return {
    id: "", account: "", repo: "", number: 0, title: "", body: "", url: "", author: "", state: "", draft: false,
    base_ref: "", head_ref: "", base_sha: "", head_sha: "", updated_at: "", created_at: "", additions: 0, deletions: 0,
    changed_files: 0, checks: "", review_decision: "", hidden: false, can_edit: false, assignees: [], labels: [],
    milestone: null, milestone_title: "", my_review: null, reviews: [], requested: [], unanswered_threads: 0,
    review_requested_at: null, merge_state: "", merge_methods: [], default_merge_method: "", can_merge: false,
    can_delete_branch: false, auto_delete_branch: false, merge_blocked_by: null, ...patch,
  };
}

/**
 * Why `p` cannot be merged from Aura yet, or null when GitHub reports it ready and no
 * check is failing or still running (former `PullRequest::merge_blocker`).
 */
export function mergeBlocker(p: PullRequest): string | null {
  if (p.state !== "open") return "This pull request is not open";
  if (!p.can_merge) return "You do not have permission to merge this pull request";
  if (p.draft || p.merge_state === "DRAFT") return "Draft pull requests cannot be merged";
  if (p.merge_methods.length === 0) return "The repository allows no merge method";
  switch (p.checks) {
    case "FAILURE":
    case "ERROR":
      return "Checks have failed";
    case "PENDING":
    case "EXPECTED":
      return "Checks are still running";
  }
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

/** One pull request, read like `pulls` reads many. */
export async function pull(gh: Github, account: string, repo: string, number: number): Promise<PullRequest> {
  const read = await pulls(gh, account, [[repo, number]]);
  const last = read.pop();
  if (last === undefined) throw new Error("GitHub returned no pull request");
  if (last instanceof Error) throw last;
  return last;
}

/**
 * Read PRs `ids` in order, a batch of 20 per GraphQL query. A PR GitHub cannot
 * return becomes an Error in its slot; a query that fails as a whole rejects.
 */
export async function pulls(gh: Github, account: string, ids: Array<[string, number]>): Promise<Array<PullRequest | Error>> {
  for (const [repo] of ids) validateRepo(repo);
  const colon = account.indexOf(":");
  const login = colon >= 0 ? account.slice(colon + 1) : account;
  const batches = await buffered(chunks(ids, BATCH), 3, async (chunk) => {
    const nodes = await batchNodes(gh, chunk, "($login:String!)", { login }, REPO, PULL);
    return chunk.map(([repo, number], i): PullRequest | Error => {
      const node = nodes[i];
      if (node instanceof Error) return node;
      const [r, d] = node;
      return fromGraphql(account, login, repo, number, r, d);
    });
  });
  return batches.flat();
}

function isPullAlias(seg: string): boolean {
  return /^pr\d+$/.test(seg);
}

/**
 * One query for `ids`: an aliased `repository` per repo (`r0`, `r1`, …) with `repoFields`,
 * holding an aliased `pullRequest` per PR (`pr0`, `pr1`, … by position in `ids`) read with
 * `fragment`, a fragment named `pull` (with any it uses). Each PR's [repository, node] in order;
 * a PR GitHub cannot return is an Error in its slot, a query that fails as a whole rejects.
 */
export async function batchNodes(
  gh: Github,
  ids: Array<[string, number]>,
  params: string,
  variables: unknown,
  repoFields: string,
  fragment: string,
): Promise<Array<[any, any] | Error>> {
  const repos: string[] = [];
  for (const [repo] of ids) {
    validateRepo(repo);
    if (!repos.some((r) => sameText(r, repo))) repos.push(repo);
  }
  const repoOf = (repo: string) => repos.findIndex((r) => sameText(r, repo));
  let query = `query${params}{`;
  repos.forEach((repo, i) => {
    // validateRepo allows no quotes or braces, so the names are safe to inline.
    const [owner, name] = repo.split("/");
    query += `r${i}:repository(owner:"${owner}",name:"${name}"){${repoFields}`;
    ids.forEach(([r, number], j) => {
      if (repoOf(r) === i) query += ` pr${j}:pullRequest(number:${number}){...pull}`;
    });
    query += "}";
  });
  query += " rateLimit{cost remaining}}";
  query += fragment;
  const q = await gh.request("POST", "graphql", { query, variables });
  const data = q?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`Unable to read pull requests: ${show(q?.errors)}`);
  }
  const errors = list(q?.errors);
  return ids.map(([repo, number], j): [any, any] | Error => {
    const r = `r${repoOf(repo)}`;
    const pr = `pr${j}`;
    // An error on the repository itself, or anywhere inside this PR, fails this PR; one
    // that names no place fails them all.
    const error = errors.find((e) => {
      const path = e?.path;
      if (!Array.isArray(path) || path.length === 0) return true;
      const seg = path[1];
      return path[0] === r && (typeof seg !== "string" || seg === pr || !isPullAlias(seg));
    });
    if (error) {
      const message = typeof error?.message === "string" ? error.message : "GitHub returned an error";
      return new Error(`Unable to read ${repo}#${number}: ${message}`);
    }
    const node = data[r]?.[pr];
    if (!node || typeof node !== "object" || Array.isArray(node)) return new Error(`Unable to read ${repo}#${number}: not found`);
    return [data[r], node];
  });
}

function names(conn: any, field: string): string[] {
  return list(conn?.nodes).flatMap((n) => (typeof n?.[field] === "string" ? [n[field]] : []));
}

/** Former `from_graphql`. */
export function fromGraphql(account: string, login: string, repo: string, number: number, r: any, d: any): PullRequest {
  const milestone = u64(d?.milestone?.number);
  const p = emptyPull({
    id: `${repo}#${number}`,
    account,
    repo,
    number,
    title: s(d, "title"),
    body: s(d, "body"),
    url: s(d, "url"),
    author: s(d?.author, "login"),
    state: s(d, "state").toLowerCase(),
    draft: d?.isDraft === true,
    base_ref: s(d, "baseRefName"),
    head_ref: s(d, "headRefName"),
    base_sha: s(d, "baseRefOid"),
    head_sha: s(d, "headRefOid"),
    created_at: s(d, "createdAt"),
    updated_at: s(d, "updatedAt"),
    additions: u64(d?.additions) ?? 0,
    deletions: u64(d?.deletions) ?? 0,
    changed_files: u64(d?.changedFiles) ?? 0,
    assignees: names(d?.assignees, "login"),
    labels: names(d?.labels, "name"),
    milestone,
    milestone_title: s(d?.milestone, "title"),
    can_edit: d?.viewerCanUpdate === true,
    review_decision: s(d, "reviewDecision"),
    checks: s(d?.commits?.nodes?.[0]?.commit?.statusCheckRollup, "state"),
  });
  const review = list(d?.reviews?.nodes)[0];
  p.my_review =
    typeof review?.submittedAt === "string"
      ? { reviewer: login, state: s(review, "state"), submitted_at: review.submittedAt, commit_sha: s(review?.commit, "oid"), bot: false }
      : null;
  p.reviews = reviewsByOthers(d, [p.author, login]);
  p.requested = requestedReviewers(d?.reviewRequests?.nodes);
  p.unanswered_threads = unansweredThreads(d?.reviewThreads?.nodes, login);
  p.review_requested_at = requestedAt(d?.timelineItems?.nodes, login);
  p.merge_state = s(d, "mergeStateStatus");
  p.merge_methods = (
    [
      ["merge", "mergeCommitAllowed"],
      ["squash", "squashMergeAllowed"],
      ["rebase", "rebaseMergeAllowed"],
    ] as const
  )
    .filter(([, allowed]) => r?.[allowed] === true)
    .map(([method]) => method);
  p.default_merge_method = s(r, "viewerDefaultMergeMethod").toLowerCase();
  p.can_merge = ["WRITE", "MAINTAIN", "ADMIN"].includes(r?.viewerPermission);
  p.can_delete_branch = p.can_merge && d?.isCrossRepository === false;
  p.auto_delete_branch = r?.deleteBranchOnMerge === true;
  p.merge_blocked_by = mergeBlocker(p);
  return withActivity(p, activity(d));
}

/** Who did what lately on the PR in `d`, to tell what changed since the previous read. */
export function activity(d: any): PullActivity {
  const nodes = (v: any) => list(v?.nodes);
  const note = (n: any): Note | null => {
    const author = s(n?.author, "login");
    const id = databaseId(n);
    if (id === null) return null;
    return { id, bot: n?.author?.__typename === "Bot" || author.endsWith("[bot]"), author };
  };
  const head = d?.commits?.nodes?.[0]?.commit;
  const stateActor = s(d, "state") === "MERGED" ? s(d?.mergedBy, "login") : s(d?.stateEvents?.nodes?.[0]?.actor, "login");
  return {
    commits: u64(d?.commits?.totalCount) ?? 0,
    pushed_by: [head?.author, head?.committer].map((who) => s(who?.user, "login")).filter((login) => login !== ""),
    comments: nodes(d?.comments).flatMap((n) => note(n) ?? []),
    thread_comments: nodes(d?.reviewThreads)
      .flatMap((t) => nodes(t?.comments))
      .flatMap((n) => note(n) ?? []),
    reviews: nodes(d?.latestReviews).flatMap((n) => {
      const x = note(n);
      return x ? [{ id: x.id, reviewer: x.author, bot: x.bot, state: s(n, "state") }] : [];
    }),
    state_actor: stateActor,
  };
}

/**
 * Merge `p` with `method` as `account`. GitHub refuses when the head moved past
 * `p.head_sha`, so only the commits that were shown are merged.
 */
export async function merge(gh: Github, account: string, p: PullRequest, method: string): Promise<any> {
  validateRepo(p.repo);
  validateSha(p.head_sha);
  return gh.requestFor(account, "PUT", `repos/${p.repo}/pulls/${p.number}/merge`, { merge_method: method, sha: p.head_sha });
}

/**
 * Delete the head branch of a merged `p`. A branch that is already gone, for
 * example because the repository deletes merged branches itself, counts as deleted.
 */
export async function deleteBranch(gh: Github, account: string, p: PullRequest): Promise<void> {
  validateRepo(p.repo);
  const path = `repos/${p.repo}/git/refs/heads/${refPath(p.head_ref)}`;
  try {
    await gh.requestFor(account, "DELETE", path);
  } catch (e) {
    if (e instanceof Error && e.message.includes("Reference does not exist")) return;
    throw e;
  }
}

/** A branch name as a REST path: each segment percent-encoded, `/` kept. */
export function refPath(branch: string): string {
  if (!branch || branch.split("/").some((seg) => !seg || seg === "." || seg === "..")) throw new Error("Invalid branch name");
  let out = "";
  for (const c of branch) {
    if (/^[A-Za-z0-9\-_.~/]$/.test(c)) {
      out += c;
      continue;
    }
    let encoded: string;
    try {
      // UTF-8 bytes as %XX; encodeURIComponent leaves !'()* alone, which are encoded too.
      encoded = encodeURIComponent(c);
    } catch {
      throw new Error("Invalid branch name");
    }
    out += encoded.replace(/[!'()*]/g, (x) => `%${x.charCodeAt(0).toString(16).toUpperCase()}`);
  }
  return out;
}

const RESPONSES = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"];

/**
 * Who has reviewed the PR in `pull` (GraphQL, queried with `REVIEWS_QUERY`), skipping `skip`
 * (the author, whose replies to threads are comment-only reviews too). A reviewer's verdict
 * is their latest approval or change request, else a comment.
 */
export function reviewsByOthers(pull: any, skip: string[]): SubmittedReview[] {
  const opinion = (login: string): string | null => {
    const n = list(pull?.latestOpinionatedReviews?.nodes).find(
      (n) => typeof n?.author?.login === "string" && sameText(n.author.login, login),
    );
    if (!n) return null;
    const state = s(n, "state");
    return RESPONSES.includes(state) ? state : null;
  };
  return list(pull?.latestReviews?.nodes)
    .filter((n) => RESPONSES.includes(typeof n?.state === "string" ? n.state : ""))
    .flatMap((n): SubmittedReview[] => {
      const reviewer = s(n?.author, "login");
      if (!reviewer || skip.some((l) => sameText(l, reviewer))) return [];
      return [
        {
          state: opinion(reviewer) ?? s(n, "state"),
          submitted_at: s(n, "submittedAt"),
          commit_sha: s(n?.commit, "oid"),
          bot: n?.author?.__typename === "Bot" || reviewer.endsWith("[bot]"),
          reviewer,
        },
      ];
    });
}

/** Pending review requests: users, teams as `org/team`, and bots. */
export function requestedReviewers(nodes: any): RequestedReviewer[] {
  return list(nodes).flatMap((n): RequestedReviewer[] => {
    const who = n?.requestedReviewer;
    const type = who?.__typename;
    if (typeof type !== "string") return [];
    const [name, kind] = type === "Team" ? [s(who, "combinedSlug"), "team"] : type === "Bot" ? [s(who, "login"), "bot"] : [s(who, "login"), "user"];
    return name ? [{ name, kind }] : [];
  });
}

/** Open review threads whose latest comment is a person's other than `login`; a bot's remark does not wait on you. */
export function unansweredThreads(threads: any, login: string): number {
  return list(threads)
    .filter((t) => t?.isResolved === false)
    .filter((t) => {
      const comments = t?.comments?.nodes;
      const last = Array.isArray(comments) && comments.length ? comments[comments.length - 1] : null;
      const author = last?.author;
      const l = author?.login;
      return author?.__typename !== "Bot" && typeof l === "string" && l !== "" && !sameText(l, login);
    }).length;
}

/** The latest request addressed to `login` or to a team. Team membership is not resolved, so a request to any team counts. */
export function requestedAt(events: any, login: string): string | null {
  let latest: string | null = null;
  for (const e of list(events)) {
    const who = e?.requestedReviewer;
    const addressed = who?.__typename === "Team" || (typeof who?.login === "string" && sameText(who.login, login));
    if (!addressed || typeof e?.createdAt !== "string") continue;
    if (latest === null || e.createdAt > latest) latest = e.createdAt;
  }
  return latest;
}

/** Open PRs that request the user's review. */
export async function requested(gh: Github): Promise<Listed[]> {
  return search(gh, "review-requested%3A%40me", "inbox");
}

/** Open PRs of others the user reviewed. */
export async function reviewed(gh: Github): Promise<Listed[]> {
  return search(gh, "reviewed-by%3A%40me%20-author%3A%40me", "list of reviewed pull requests");
}

/** Open PRs the user authored. */
export async function authored(gh: Github): Promise<Listed[]> {
  return search(gh, "author%3A%40me", "list of your pull requests");
}

async function search(gh: Github, filter: string, what: string): Promise<Listed[]> {
  const ids: Listed[] = [];
  for (let page = 1; page <= 10; page++) {
    const response = await gh.request(
      "GET",
      `search/issues?q=is%3Apr%20is%3Aopen%20archived%3Afalse%20${filter}&per_page=100&page=${page}`,
    );
    if (response?.incomplete_results === true || (u64(response?.total_count) ?? 0) > 1000) {
      throw new Error(`GitHub returned an incomplete ${what}; cached ${what} retained`);
    }
    const rows = response?.items;
    if (!Array.isArray(rows)) throw new Error("Invalid search response");
    for (const row of rows) {
      const url = s(row, "repository_url");
      const at = url.indexOf("/repos/");
      if (at < 0) throw new Error("Invalid repository URL");
      const repo = url.slice(at + "/repos/".length).split("/repos/")[0];
      const number = u64(row?.number);
      if (number === null) throw new Error("Missing PR number");
      ids.push([[repo, number], s(row, "updated_at")]);
    }
    if (rows.length < 100) break;
  }
  return ids;
}

const PROJECTS = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){projectItems(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id project{id title viewerCanUpdate} fieldValues(first:100){pageInfo{hasNextPage endCursor} nodes{...F}}}}}}}
fragment F on ProjectV2ItemFieldValue { ... on ProjectV2ItemFieldTextValue {text field{... on ProjectV2FieldCommon{id name dataType}}} ... on ProjectV2ItemFieldNumberValue{number field{... on ProjectV2FieldCommon{id name dataType}}} ... on ProjectV2ItemFieldDateValue{date field{... on ProjectV2FieldCommon{id name dataType}}} ... on ProjectV2ItemFieldSingleSelectValue{name optionId field{... on ProjectV2SingleSelectField{id name dataType options{id name}}}} ... on ProjectV2ItemFieldIterationValue{title iterationId field{... on ProjectV2IterationField{id name dataType configuration{iterations{id title} completedIterations{id title}}}}}}`;
const FIELD_PAGE = `query($id:ID!,$cursor:String){node(id:$id){... on ProjectV2Item{fieldValues(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{... on ProjectV2ItemFieldTextValue{text field{... on ProjectV2FieldCommon{id name dataType}}} ... on ProjectV2ItemFieldNumberValue{number field{... on ProjectV2FieldCommon{id name dataType}}} ... on ProjectV2ItemFieldDateValue{date field{... on ProjectV2FieldCommon{id name dataType}}} ... on ProjectV2ItemFieldSingleSelectValue{name optionId field{... on ProjectV2SingleSelectField{id name dataType options{id name}}}} ... on ProjectV2ItemFieldIterationValue{title iterationId field{... on ProjectV2IterationField{id name dataType configuration{iterations{id title} completedIterations{id title}}}}}}}}}}`;
const PROJECT_FIELDS = `query($id:ID!,$cursor:String){node(id:$id){... on ProjectV2{fields(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{... on ProjectV2Field{id name dataType} ... on ProjectV2SingleSelectField{id name dataType options{id name}} ... on ProjectV2IterationField{id name dataType configuration{iterations{id title} completedIterations{id title}}}}}}}}`;

/** ProjectV2 associations and fields of a PR. Project associations and fields are cursor-paginated separately from REST conversation lists. */
export async function projects(gh: Github, p: PullRequest): Promise<any[]> {
  const slash = p.repo.indexOf("/");
  if (slash < 0) throw new Error("Invalid repository");
  const owner = p.repo.slice(0, slash);
  const name = p.repo.slice(slash + 1);
  let cursor: unknown = null;
  const result: any[] = [];
  for (;;) {
    const data = await gh.request("POST", "graphql", { query: PROJECTS, variables: { owner, name, number: p.number, cursor } });
    if (has(data, "errors")) throw new Error(`Project fields unavailable: ${show(data.errors)}`);
    const conn = data?.data?.repository?.pullRequest?.projectItems;
    for (const raw of list(conn?.nodes)) {
      const item = JSON.parse(JSON.stringify(raw));
      const fields: any[] = list(item?.fieldValues?.nodes).slice();
      let page = item?.fieldValues?.pageInfo;
      while (page?.hasNextPage === true) {
        const r = await gh.request("POST", "graphql", { query: FIELD_PAGE, variables: { id: item?.id ?? null, cursor: page?.endCursor ?? null } });
        if (has(r, "errors")) throw new Error(`Project field pagination failed: ${show(r.errors)}`);
        const c = r?.data?.node?.fieldValues;
        fields.push(...list(c?.nodes));
        page = c?.pageInfo;
      }
      let definitionCursor: unknown = null;
      for (;;) {
        const definitions = await gh.request("POST", "graphql", {
          query: PROJECT_FIELDS,
          variables: { id: item?.project?.id ?? null, cursor: definitionCursor },
        });
        if (has(definitions, "errors")) throw new Error(`Project fields unavailable: ${show(definitions.errors)}`);
        const connection = definitions?.data?.node?.fields;
        for (const field of list(connection?.nodes)) {
          if (has(field, "id") && !fields.some((value) => value?.field?.id === field.id)) fields.push({ field });
        }
        if (connection?.pageInfo?.hasNextPage !== true) break;
        definitionCursor = connection?.pageInfo?.endCursor ?? null;
      }
      item.fieldValues = fields;
      result.push(item);
    }
    if (conn?.pageInfo?.hasNextPage !== true) break;
    cursor = conn?.pageInfo?.endCursor ?? null;
  }
  return result;
}
