// A pull request's conversation, read as GitHub's Conversation tab shows it: one GraphQL
// query for the timeline and the review threads, paginated, instead of a REST list each.
import { has, list, s, show, u64, validateRepo, type Github } from "./github";
import type { PullRequest, PullTimeline, ReviewThread, TimelineItem } from "./types";

/** Pages read per connection before the read gives up, like `pages`. */
const MAX_PAGES = 50;

export const TIMELINE_QUERY = `query($owner:String!,$name:String!,$number:Int!,$items:String,$threads:String,$withItems:Boolean!,$withThreads:Boolean!){repository(owner:$owner,name:$name){pullRequest(number:$number){commits{totalCount}
timelineItems(first:100,after:$items,itemTypes:[ISSUE_COMMENT,PULL_REQUEST_REVIEW,PULL_REQUEST_COMMIT,HEAD_REF_FORCE_PUSHED_EVENT,REVIEW_REQUESTED_EVENT,REVIEW_REQUEST_REMOVED_EVENT,LABELED_EVENT,UNLABELED_EVENT,ASSIGNED_EVENT,UNASSIGNED_EVENT,READY_FOR_REVIEW_EVENT,CONVERT_TO_DRAFT_EVENT,MERGED_EVENT,CLOSED_EVENT,REOPENED_EVENT,HEAD_REF_DELETED_EVENT,HEAD_REF_RESTORED_EVENT,RENAMED_TITLE_EVENT,MILESTONED_EVENT,DEMILESTONED_EVENT,CROSS_REFERENCED_EVENT,REVIEW_DISMISSED_EVENT]) @include(if:$withItems){pageInfo{hasNextPage endCursor} nodes{__typename
... on IssueComment{id body createdAt url author{login}}
... on PullRequestReview{id databaseId body state submittedAt createdAt url author{login}}
... on PullRequestCommit{id url commit{oid messageHeadline committedDate author{name user{login}}}}
... on HeadRefForcePushedEvent{id createdAt actor{login} beforeCommit{oid} afterCommit{oid}}
... on ReviewRequestedEvent{id createdAt actor{login} requestedReviewer{...R}}
... on ReviewRequestRemovedEvent{id createdAt actor{login} requestedReviewer{...R}}
... on LabeledEvent{id createdAt actor{login} label{name color}}
... on UnlabeledEvent{id createdAt actor{login} label{name color}}
... on AssignedEvent{id createdAt actor{login} assignee{...A}}
... on UnassignedEvent{id createdAt actor{login} assignee{...A}}
... on ReadyForReviewEvent{id createdAt actor{login}}
... on ConvertToDraftEvent{id createdAt actor{login}}
... on MergedEvent{id createdAt actor{login} mergeRefName commit{oid}}
... on ClosedEvent{id createdAt actor{login}}
... on ReopenedEvent{id createdAt actor{login}}
... on HeadRefDeletedEvent{id createdAt actor{login} headRefName}
... on HeadRefRestoredEvent{id createdAt actor{login}}
... on RenamedTitleEvent{id createdAt actor{login} previousTitle currentTitle}
... on MilestonedEvent{id createdAt actor{login} milestoneTitle}
... on DemilestonedEvent{id createdAt actor{login} milestoneTitle}
... on CrossReferencedEvent{id createdAt actor{login} source{... on Issue{number title url repository{nameWithOwner}} ... on PullRequest{number title url repository{nameWithOwner}}}}
... on ReviewDismissedEvent{id createdAt actor{login} dismissalMessage review{author{login}}}}}
reviewThreads(first:100,after:$threads) @include(if:$withThreads){pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated path line originalLine resolvedBy{login}
comments(first:100){totalCount nodes{id body createdAt url diffHunk author{login} pullRequestReview{databaseId}}}}}}}}
fragment R on RequestedReviewer{... on User{login} ... on Team{combinedSlug} ... on Bot{login} ... on Mannequin{login}}
fragment A on Assignee{... on User{login} ... on Bot{login} ... on Mannequin{login}}`;

/** An empty item of `kind`, as `TimelineItem::default()` with the kind set. */
function emptyItem(kind: string): TimelineItem {
  return { kind, id: "", at: "", actor: "", body: "", url: "", state: "", review_id: null, subject: "", previous: "", color: "", sha: "", before: "" };
}

/**
 * Read the conversation of `p`. The timeline and the threads page on their own cursors; a
 * follow-up query asks only for the connection that still has pages.
 */
export async function timeline(gh: Github, p: PullRequest): Promise<PullTimeline> {
  validateRepo(p.repo);
  const [owner, name] = p.repo.split("/");
  const out: PullTimeline = { items: [], threads: [], commits: 0 };
  let items: unknown = null;
  let threads: unknown = null;
  let withItems = true;
  let withThreads = true;
  for (let i = 0; i < MAX_PAGES; i++) {
    const variables = { owner, name, number: p.number, items, threads, withItems, withThreads };
    const data = await gh.request("POST", "graphql", { query: TIMELINE_QUERY, variables });
    if (has(data, "errors")) throw new Error(`Conversation unavailable: ${show(data.errors)}`);
    const pr = data?.data?.repository?.pullRequest;
    if (!pr || typeof pr !== "object" || Array.isArray(pr)) throw new Error(`Unable to read ${p.repo}#${p.number}: not found`);
    out.commits = u64(pr?.commits?.totalCount) ?? 0;
    if (withItems) {
      const conn = pr.timelineItems;
      for (const n of list(conn?.nodes)) {
        const it = timelineItem(n);
        if (it) out.items.push(it);
      }
      withItems = conn?.pageInfo?.hasNextPage === true;
      items = conn?.pageInfo?.endCursor ?? null;
    }
    if (withThreads) {
      const conn = pr.reviewThreads;
      out.threads.push(...list(conn?.nodes).map(timelineThread));
      withThreads = conn?.pageInfo?.hasNextPage === true;
      threads = conn?.pageInfo?.endCursor ?? null;
    }
    if (!withItems && !withThreads) return out;
  }
  throw new Error("GitHub pagination limit exceeded; previous cache retained");
}

/** A deleted account reads as `ghost`, as on GitHub. */
function login(v: any): string {
  return typeof v?.login === "string" ? v.login : "ghost";
}

const KINDS: Record<string, string> = {
  IssueComment: "comment",
  PullRequestReview: "review",
  PullRequestCommit: "commit",
  HeadRefForcePushedEvent: "force_pushed",
  ReviewRequestedEvent: "review_requested",
  ReviewRequestRemovedEvent: "review_request_removed",
  LabeledEvent: "labeled",
  UnlabeledEvent: "unlabeled",
  AssignedEvent: "assigned",
  UnassignedEvent: "unassigned",
  ReadyForReviewEvent: "ready_for_review",
  ConvertToDraftEvent: "converted_to_draft",
  MergedEvent: "merged",
  ClosedEvent: "closed",
  ReopenedEvent: "reopened",
  HeadRefDeletedEvent: "head_ref_deleted",
  HeadRefRestoredEvent: "head_ref_restored",
  RenamedTitleEvent: "renamed",
  MilestonedEvent: "milestoned",
  DemilestonedEvent: "demilestoned",
  CrossReferencedEvent: "referenced",
  ReviewDismissedEvent: "review_dismissed",
};

/** One timeline node as an item; null for kinds Aura does not show or sources the token cannot see. */
export function timelineItem(n: any): TimelineItem | null {
  const type = n?.__typename;
  const kind = typeof type === "string" && Object.prototype.hasOwnProperty.call(KINDS, type) ? KINDS[type] : null;
  if (!kind) return null;
  const t = emptyItem(kind);
  t.id = s(n, "id");
  t.at = s(n, "createdAt");
  t.actor = login(n?.actor);
  t.url = s(n, "url");
  switch (kind) {
    case "comment":
      t.actor = login(n?.author);
      t.body = s(n, "body");
      break;
    case "review":
      t.actor = login(n?.author);
      t.body = s(n, "body");
      t.state = s(n, "state");
      t.review_id = u64(n?.databaseId);
      // A pending review has not been submitted yet.
      if (typeof n?.submittedAt === "string") t.at = n.submittedAt;
      break;
    case "commit": {
      const c = n?.commit;
      t.at = s(c, "committedDate");
      t.actor = typeof c?.author?.user?.login === "string" ? c.author.user.login : s(c?.author, "name");
      t.subject = s(c, "messageHeadline");
      t.sha = s(c, "oid");
      break;
    }
    case "force_pushed":
      t.before = s(n?.beforeCommit, "oid");
      t.sha = s(n?.afterCommit, "oid");
      break;
    case "review_requested":
    case "review_request_removed": {
      const r = n?.requestedReviewer;
      t.subject = typeof r?.login === "string" ? r.login : typeof r?.combinedSlug === "string" ? r.combinedSlug : "ghost";
      break;
    }
    case "labeled":
    case "unlabeled":
      t.subject = s(n?.label, "name");
      t.color = s(n?.label, "color");
      break;
    case "assigned":
    case "unassigned":
      t.subject = login(n?.assignee);
      break;
    case "merged":
      t.subject = s(n, "mergeRefName");
      t.sha = s(n?.commit, "oid");
      break;
    case "head_ref_deleted":
      t.subject = s(n, "headRefName");
      break;
    case "renamed":
      t.subject = s(n, "currentTitle");
      t.previous = s(n, "previousTitle");
      break;
    case "milestoned":
    case "demilestoned":
      t.subject = s(n, "milestoneTitle");
      break;
    case "referenced": {
      const src = n?.source;
      // Sources the token cannot see arrive empty.
      if (u64(src?.number) === null) return null;
      t.subject = `${s(src?.repository, "nameWithOwner")}#${show(src.number)} ${s(src, "title")}`;
      t.url = s(src, "url");
      break;
    }
    case "review_dismissed":
      t.body = s(n, "dismissalMessage");
      t.subject = login(n?.review?.author);
      break;
  }
  return t;
}

/** One review thread node as a thread. */
export function timelineThread(n: any): ReviewThread {
  const line = (key: string) => u64(n?.[key]);
  const nodes = list(n?.comments?.nodes);
  const first = nodes[0] ?? null;
  return {
    id: s(n, "id"),
    path: s(n, "path"),
    line: line("line"),
    original_line: line("originalLine"),
    resolved: n?.isResolved === true,
    outdated: n?.isOutdated === true,
    resolved_by: typeof n?.resolvedBy?.login === "string" ? n.resolvedBy.login : "",
    diff_hunk: s(first, "diffHunk"),
    review_id: u64(first?.pullRequestReview?.databaseId),
    more: Math.max(0, (u64(n?.comments?.totalCount) ?? 0) - nodes.length),
    comments: nodes.map((c) => ({ id: s(c, "id"), author: login(c?.author), at: s(c, "createdAt"), body: s(c, "body"), url: s(c, "url") })),
  };
}

/** The REST-shaped (comments, reviews, threads) lists the old UI used (former `legacy_lists`). */
export function legacyLists(t: PullTimeline): [any[], any[], any[]] {
  const of = (kind: string) => t.items.filter((i) => i.kind === kind);
  const comments = of("comment").map((i) => ({ id: i.id, body: i.body, html_url: i.url, created_at: i.at, user: { login: i.actor } }));
  const reviews = of("review").map((i) => ({ id: i.id, body: i.body, html_url: i.url, submitted_at: i.at, state: i.state, user: { login: i.actor } }));
  const threads = t.threads.flatMap((th) =>
    th.comments.map((c) => ({ id: c.id, body: c.body, html_url: c.url, created_at: c.at, path: th.path, line: th.line, user: { login: c.author } })),
  );
  return [comments, reviews, threads];
}
