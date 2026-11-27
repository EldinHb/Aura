// The PR page: one GraphQL query for the conversation, commits and checks (then their remaining
// pages), the cards' status read for state, reviewers and merge facts, and the changed files
// from REST (paged, ETag-cached by the github mod's transport). Read-only.
import { has, list, messageOf, pages, s, show, u64, validateRepo, type Github } from "@aura/github-client";
import type { Label, LineComment, PageCheck, PageCommit, PageFile, PrPage, TimelineItem } from "../shared/page";
import { FAILED, PAGE, readStatuses, rest } from "./status";

const TIMELINE_TYPES = [
  "ISSUE_COMMENT", "PULL_REQUEST_REVIEW", "PULL_REQUEST_COMMIT", "HEAD_REF_FORCE_PUSHED_EVENT", "REVIEW_REQUESTED_EVENT",
  "LABELED_EVENT", "UNLABELED_EVENT", "MERGED_EVENT", "CLOSED_EVENT", "REOPENED_EVENT", "READY_FOR_REVIEW_EVENT", "CONVERT_TO_DRAFT_EVENT",
].join(",");

const TIMELINE_NODE =
  "__typename " +
  "... on IssueComment{author{login} body createdAt url} " +
  "... on PullRequestReview{author{login} state body submittedAt url comments(first:50){totalCount nodes{author{login} body createdAt url path line originalLine diffHunk}}} " +
  "... on PullRequestCommit{commit{oid abbreviatedOid messageHeadline committedDate url author{name user{login}}}} " +
  "... on HeadRefForcePushedEvent{actor{login} createdAt beforeCommit{abbreviatedOid} afterCommit{abbreviatedOid}} " +
  "... on ReviewRequestedEvent{actor{login} createdAt requestedReviewer{__typename ... on User{login} ... on Team{combinedSlug} ... on Bot{login}}} " +
  "... on LabeledEvent{actor{login} createdAt label{name color}} " +
  "... on UnlabeledEvent{actor{login} createdAt label{name color}} " +
  "... on MergedEvent{actor{login} createdAt commit{abbreviatedOid} mergeRefName} " +
  "... on ClosedEvent{actor{login} createdAt} ... on ReopenedEvent{actor{login} createdAt} " +
  "... on ReadyForReviewEvent{actor{login} createdAt} ... on ConvertToDraftEvent{actor{login} createdAt}";

const COMMIT_NODE = "commit{oid abbreviatedOid messageHeadline committedDate url author{name user{login}}}";
const CHECK_NODE =
  "__typename ... on CheckRun{name status conclusion startedAt completedAt detailsUrl checkSuite{workflowRun{workflow{name}}}} " +
  "... on StatusContext{context state targetUrl}";

export const PAGE_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){" +
  "number title url body createdAt author{login} baseRefName headRefName baseRefOid headRefOid headRepository{nameWithOwner} additions deletions changedFiles " +
  "assignees(first:20){nodes{login}} labels(first:50){nodes{name color}} milestone{title url} comments{totalCount} " +
  `commits(first:100){totalCount ${PAGE} nodes{${COMMIT_NODE}}} ` +
  `checks:commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){${PAGE} nodes{${CHECK_NODE}}}}}}} ` +
  `timelineItems(first:100,itemTypes:[${TIMELINE_TYPES}]){${PAGE} nodes{${TIMELINE_NODE}}}` +
  "}}}";

const prPage = (field: string, args: string, nodes: string) =>
  `query($owner:String!,$name:String!,$number:Int!,$after:String!){repository(owner:$owner,name:$name){pullRequest(number:$number){${field}(first:100,after:$after${args}){${PAGE} nodes{${nodes}}}}}}`;
const CHECKS_PAGE =
  `query($owner:String!,$name:String!,$oid:GitObjectID!,$after:String!){repository(owner:$owner,name:$name){object(oid:$oid){... on Commit{statusCheckRollup{contexts(first:100,after:$after){${PAGE} nodes{${CHECK_NODE}}}}}}}}`;

const login = (actor: any) => s(actor, "login") || "ghost";
const label = (l: any): Label => ({ name: s(l, "name"), color: /^[0-9a-f]{6}$/i.test(s(l, "color")) ? s(l, "color") : "888888" });

/** The last `n` lines of a review comment's hunk: the commented line and what leads up to it. */
export function snippet(diffHunk: string, n = 4): string[] {
  const lines = diffHunk.split("\n").filter((l) => !l.startsWith("@@"));
  return lines.slice(-n);
}

/** One timeline node as an item, or null for what the page does not show. */
export function timelineItem(n: any): TimelineItem | null {
  switch (n?.__typename) {
    case "IssueComment":
      return { kind: "comment", author: login(n.author), body: s(n, "body"), at: s(n, "createdAt"), url: s(n, "url") };
    case "PullRequestReview": {
      const state = s(n, "state");
      if (state === "PENDING") return null;
      const comments = list(n?.comments?.nodes).map((c): LineComment => ({
        author: login(c.author), body: s(c, "body"), at: s(c, "createdAt"), url: s(c, "url"), path: s(c, "path"),
        line: u64(c?.line) ?? u64(c?.originalLine), snippet: snippet(s(c, "diffHunk")),
      }));
      // A reply in a thread is a comment-only review with nothing of its own to show besides the reply.
      if (state === "COMMENTED" && !s(n, "body") && comments.length === 0) return null;
      const total = u64(n?.comments?.totalCount) ?? comments.length;
      return { kind: "review", state, author: login(n.author), body: s(n, "body"), at: s(n, "submittedAt"), url: s(n, "url"), comments, moreComments: Math.max(0, total - comments.length) };
    }
    case "PullRequestCommit": {
      const c = n.commit;
      return { kind: "commit", at: s(c, "committedDate"), author: s(c?.author?.user, "login") || s(c?.author, "name"), sha: s(c, "abbreviatedOid"), message: s(c, "messageHeadline"), url: s(c, "url") };
    }
    case "HeadRefForcePushedEvent":
      return { kind: "force_push", at: s(n, "createdAt"), actor: login(n.actor), before: s(n?.beforeCommit, "abbreviatedOid"), after: s(n?.afterCommit, "abbreviatedOid") };
    case "ReviewRequestedEvent": {
      const who = n?.requestedReviewer;
      return { kind: "review_requested", at: s(n, "createdAt"), actor: login(n.actor), reviewer: who?.__typename === "Team" ? s(who, "combinedSlug") : s(who, "login") || "someone" };
    }
    case "LabeledEvent":
    case "UnlabeledEvent":
      return { kind: n.__typename === "LabeledEvent" ? "labeled" : "unlabeled", at: s(n, "createdAt"), actor: login(n.actor), label: label(n.label) };
    case "MergedEvent":
      return { kind: "merged", at: s(n, "createdAt"), actor: login(n.actor), sha: s(n?.commit, "abbreviatedOid"), base: s(n, "mergeRefName") };
    case "ClosedEvent":
      return { kind: "closed", at: s(n, "createdAt"), actor: login(n.actor) };
    case "ReopenedEvent":
      return { kind: "reopened", at: s(n, "createdAt"), actor: login(n.actor) };
    case "ReadyForReviewEvent":
      return { kind: "ready_for_review", at: s(n, "createdAt"), actor: login(n.actor) };
    case "ConvertToDraftEvent":
      return { kind: "converted_to_draft", at: s(n, "createdAt"), actor: login(n.actor) };
    default:
      return null;
  }
}

export function pageCommit(n: any): PageCommit {
  const c = n?.commit;
  return { sha: s(c, "oid"), short: s(c, "abbreviatedOid"), message: s(c, "messageHeadline"), author: s(c?.author?.user, "login") || s(c?.author, "name"), at: s(c, "committedDate"), url: s(c, "url") };
}

const words = (x: string) => (x ? x.charAt(0) + x.slice(1).toLowerCase().replace(/_/g, " ") : "");

export function pageCheck(n: any): PageCheck | null {
  if (n?.__typename === "CheckRun") {
    const done = n.status === "COMPLETED";
    const conclusion = s(n, "conclusion");
    const state = !done ? "pending" : FAILED.includes(conclusion) ? "failing" : conclusion === "SKIPPED" || conclusion === "NEUTRAL" ? "skipped" : conclusion === "SUCCESS" ? "passing" : "pending";
    const start = Date.parse(s(n, "startedAt"));
    const end = Date.parse(s(n, "completedAt"));
    return {
      name: s(n, "name"), workflow: s(n?.checkSuite?.workflowRun?.workflow, "name"), state,
      label: done ? words(conclusion) : words(s(n, "status")),
      seconds: done && !Number.isNaN(start) && !Number.isNaN(end) ? Math.max(0, Math.round((end - start) / 1000)) : null,
      url: s(n, "detailsUrl") || null,
    };
  }
  if (n?.__typename === "StatusContext") {
    const st = s(n, "state");
    return { name: s(n, "context"), workflow: "", state: st === "SUCCESS" ? "passing" : FAILED.includes(st) ? "failing" : "pending", label: words(st), seconds: null, url: s(n, "targetUrl") || null };
  }
  return null;
}

const CHECK_ORDER = { failing: 0, pending: 1, passing: 2, skipped: 3 } as const;

/** The page from the answer to PAGE_QUERY (its lists completed), and the cards' status of the PR. */
export function toPage(repo: string, pr: any, status: PrPage["status"], complete: boolean, now: string, nextMs: number): PrPage {
  const timeline = list(pr?.timelineItems?.nodes).flatMap((n) => timelineItem(n) ?? []);
  const reviewComments = timeline.reduce((sum, t) => sum + (t.kind === "review" ? t.comments.length : 0), 0);
  const checks = list(pr?.checks?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes).flatMap((n) => pageCheck(n) ?? []);
  checks.sort((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state] || a.name.localeCompare(b.name));
  return {
    repo, number: u64(pr?.number) ?? 0, url: s(pr, "url"), title: s(pr, "title"), author: login(pr?.author), createdAt: s(pr, "createdAt"), body: s(pr, "body"),
    base: s(pr, "baseRefName"), head: s(pr, "headRefName"), headRepo: s(pr?.headRepository, "nameWithOwner") || repo,
    baseSha: s(pr, "baseRefOid"), headSha: s(pr, "headRefOid"),
    commitCount: u64(pr?.commits?.totalCount) ?? 0, changedFiles: u64(pr?.changedFiles) ?? 0, additions: u64(pr?.additions) ?? 0, deletions: u64(pr?.deletions) ?? 0,
    assignees: list(pr?.assignees?.nodes).map((a) => s(a, "login")).filter(Boolean),
    labels: list(pr?.labels?.nodes).map(label),
    milestone: pr?.milestone ? { title: s(pr.milestone, "title"), url: s(pr.milestone, "url") } : null,
    timeline,
    commits: list(pr?.commits?.nodes).map(pageCommit),
    checks,
    commentCount: (u64(pr?.comments?.totalCount) ?? 0) + reviewComments,
    status,
    complete: complete && !timeline.some((t) => t.kind === "review" && t.moreComments > 0),
    readAt: now, nextMs,
  };
}

/** Times the page is read again when a push lands between its two queries. */
export const SNAPSHOT_TRIES = 3;

/**
 * Read the page of `repo#number`: the page query and its remaining pages, then the cards'
 * status read. Both must show the same head commit (a push can land between them); they are
 * read again until they do, and it fails rather than offer a merge of a head the page does
 * not show.
 */
export async function readPage(gh: Github, repo: string, number: number): Promise<PrPage> {
  for (let tries = 1; ; tries++) {
    const page = await readOnce(gh, repo, number);
    if (page.headSha && page.headSha === page.status.merge.headSha) return page;
    if (tries >= SNAPSHOT_TRIES) throw new Error(`${repo}#${number} changed while it was read (new commits); refresh to see them`);
  }
}

async function readOnce(gh: Github, repo: string, number: number): Promise<PrPage> {
  validateRepo(repo);
  const [owner, name] = repo.split("/");
  const reply = await gh.request("POST", "graphql", { query: PAGE_QUERY, variables: { owner, name, number } });
  if (has(reply, "errors") && !reply?.data?.repository?.pullRequest) throw new Error(`Could not read ${repo}#${number}: ${show(reply.errors)}`);
  const pr = reply?.data?.repository?.pullRequest;
  if (!pr) throw new Error(`Could not read ${repo}#${number}: not found`);
  const vars = { owner, name, number };
  const done = (p: Promise<boolean>) => p.catch((e) => {
    console.warn(`PR status: could not read every page of ${repo}#${number}: ${messageOf(e)}`);
    return false;
  });
  const commit = pr?.checks?.nodes?.[0]?.commit;
  const complete = [
    await done(rest(gh, pr.timelineItems, prPage("timelineItems", `,itemTypes:[${TIMELINE_TYPES}]`, TIMELINE_NODE), vars, (d) => d?.repository?.pullRequest?.timelineItems)),
    await done(rest(gh, pr.commits, prPage("commits", "", COMMIT_NODE), vars, (d) => d?.repository?.pullRequest?.commits)),
    await done(rest(gh, commit?.statusCheckRollup?.contexts, CHECKS_PAGE, { owner, name, oid: s(commit, "oid") }, (d) => d?.repository?.object?.statusCheckRollup?.contexts)),
  ].every(Boolean);
  const [status] = await readStatuses(gh, [{ url: s(pr, "url"), repo, number }]);
  if (status instanceof Error) throw status;
  status.merge.account = await gh.account().catch(() => "");
  return toPage(repo, pr, status, complete, new Date().toISOString(), await gh.pace(60_000).catch(() => 60_000));
}

const STATUSES: PageFile["status"][] = ["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"];

export function pageFile(f: any): PageFile {
  const status = STATUSES.includes(f?.status) ? f.status : "modified";
  return {
    path: s(f, "filename"), previous: s(f, "previous_filename") || null, status,
    additions: u64(f?.additions) ?? 0, deletions: u64(f?.deletions) ?? 0,
    patch: typeof f?.patch === "string" ? f.patch : null,
  };
}

/** The changed files with their patches (REST, every page). */
export async function readFiles(gh: Github, repo: string, number: number): Promise<PageFile[]> {
  validateRepo(repo);
  return (await pages(gh, `repos/${repo}/pulls/${number}/files`)).map(pageFile);
}
