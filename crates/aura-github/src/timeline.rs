//! A pull request's conversation, read as GitHub's Conversation tab shows it: one GraphQL
//! query for the timeline and the review threads, paginated, instead of a REST list each.
use crate::{s, validate_repo, Github};
use anyhow::{bail, Context, Result};
use aura_core::{PullRequest, PullTimeline, ReviewThread, ThreadComment, TimelineItem};
use serde_json::{json, Value};

/// Pages read per connection before the read gives up, like [`crate::pages`].
const MAX_PAGES: usize = 50;

const QUERY: &str = r#"query($owner:String!,$name:String!,$number:Int!,$items:String,$threads:String,$withItems:Boolean!,$withThreads:Boolean!){repository(owner:$owner,name:$name){pullRequest(number:$number){commits{totalCount}
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
fragment A on Assignee{... on User{login} ... on Bot{login} ... on Mannequin{login}}"#;

/// Read the conversation of `p`. The timeline and the threads page on their own cursors; a
/// follow-up query asks only for the connection that still has pages.
pub async fn timeline(gh: &dyn Github, p: &PullRequest) -> Result<PullTimeline> {
    validate_repo(&p.repo)?;
    let (owner, name) = p.repo.split_once('/').context("Invalid repository")?;
    let mut out = PullTimeline::default();
    let (mut items, mut threads) = (Value::Null, Value::Null);
    let (mut with_items, mut with_threads) = (true, true);
    for _ in 0..MAX_PAGES {
        let vars = json!({"owner": owner, "name": name, "number": p.number, "items": items, "threads": threads, "withItems": with_items, "withThreads": with_threads});
        let data = gh.request("POST", "graphql", Some(json!({"query": QUERY, "variables": vars}))).await?;
        if data.get("errors").is_some() {
            bail!("Conversation unavailable: {}", data["errors"]);
        }
        let pr = &data["data"]["repository"]["pullRequest"];
        if !pr.is_object() {
            bail!("Unable to read {}#{}: not found", p.repo, p.number);
        }
        out.commits = pr["commits"]["totalCount"].as_u64().unwrap_or(0) as u32;
        if with_items {
            let conn = &pr["timelineItems"];
            out.items.extend(conn["nodes"].as_array().into_iter().flatten().filter_map(item));
            with_items = conn["pageInfo"]["hasNextPage"] == true;
            items = conn["pageInfo"]["endCursor"].clone();
        }
        if with_threads {
            let conn = &pr["reviewThreads"];
            out.threads.extend(conn["nodes"].as_array().into_iter().flatten().map(thread));
            with_threads = conn["pageInfo"]["hasNextPage"] == true;
            threads = conn["pageInfo"]["endCursor"].clone();
        }
        if !with_items && !with_threads {
            return Ok(out);
        }
    }
    bail!("GitHub pagination limit exceeded; previous cache retained")
}

/// A deleted account reads as `ghost`, as on GitHub.
fn login(v: &Value) -> String {
    v["login"].as_str().unwrap_or("ghost").to_string()
}

fn item(n: &Value) -> Option<TimelineItem> {
    let kind = match n["__typename"].as_str()? {
        "IssueComment" => "comment",
        "PullRequestReview" => "review",
        "PullRequestCommit" => "commit",
        "HeadRefForcePushedEvent" => "force_pushed",
        "ReviewRequestedEvent" => "review_requested",
        "ReviewRequestRemovedEvent" => "review_request_removed",
        "LabeledEvent" => "labeled",
        "UnlabeledEvent" => "unlabeled",
        "AssignedEvent" => "assigned",
        "UnassignedEvent" => "unassigned",
        "ReadyForReviewEvent" => "ready_for_review",
        "ConvertToDraftEvent" => "converted_to_draft",
        "MergedEvent" => "merged",
        "ClosedEvent" => "closed",
        "ReopenedEvent" => "reopened",
        "HeadRefDeletedEvent" => "head_ref_deleted",
        "HeadRefRestoredEvent" => "head_ref_restored",
        "RenamedTitleEvent" => "renamed",
        "MilestonedEvent" => "milestoned",
        "DemilestonedEvent" => "demilestoned",
        "CrossReferencedEvent" => "referenced",
        "ReviewDismissedEvent" => "review_dismissed",
        _ => return None,
    };
    let mut t = TimelineItem { kind: kind.into(), id: s(n, "id"), at: s(n, "createdAt"), actor: login(&n["actor"]), url: s(n, "url"), ..Default::default() };
    match kind {
        "comment" => {
            t.actor = login(&n["author"]);
            t.body = s(n, "body");
        }
        "review" => {
            t.actor = login(&n["author"]);
            t.body = s(n, "body");
            t.state = s(n, "state");
            t.review_id = n["databaseId"].as_u64();
            // A pending review has not been submitted yet.
            if let Some(at) = n["submittedAt"].as_str() {
                t.at = at.into();
            }
        }
        "commit" => {
            let c = &n["commit"];
            t.at = s(c, "committedDate");
            t.actor = c["author"]["user"]["login"].as_str().map_or_else(|| s(&c["author"], "name"), String::from);
            t.subject = s(c, "messageHeadline");
            t.sha = s(c, "oid");
        }
        "force_pushed" => {
            t.before = s(&n["beforeCommit"], "oid");
            t.sha = s(&n["afterCommit"], "oid");
        }
        "review_requested" | "review_request_removed" => {
            let r = &n["requestedReviewer"];
            t.subject = r["login"].as_str().or(r["combinedSlug"].as_str()).unwrap_or("ghost").into();
        }
        "labeled" | "unlabeled" => {
            t.subject = s(&n["label"], "name");
            t.color = s(&n["label"], "color");
        }
        "assigned" | "unassigned" => t.subject = login(&n["assignee"]),
        "merged" => {
            t.subject = s(n, "mergeRefName");
            t.sha = s(&n["commit"], "oid");
        }
        "head_ref_deleted" => t.subject = s(n, "headRefName"),
        "renamed" => {
            t.subject = s(n, "currentTitle");
            t.previous = s(n, "previousTitle");
        }
        "milestoned" | "demilestoned" => t.subject = s(n, "milestoneTitle"),
        "referenced" => {
            let src = &n["source"];
            // Sources the token cannot see arrive empty.
            src["number"].as_u64()?;
            t.subject = format!("{}#{} {}", s(&src["repository"], "nameWithOwner"), src["number"], s(src, "title"));
            t.url = s(src, "url");
        }
        "review_dismissed" => {
            t.body = s(n, "dismissalMessage");
            t.subject = login(&n["review"]["author"]);
        }
        _ => {}
    }
    Some(t)
}

fn thread(n: &Value) -> ReviewThread {
    let line = |key: &str| n[key].as_u64().map(|l| l as u32);
    let nodes: Vec<&Value> = n["comments"]["nodes"].as_array().into_iter().flatten().collect();
    let first = nodes.first().copied().unwrap_or(&Value::Null);
    ReviewThread {
        id: s(n, "id"),
        path: s(n, "path"),
        line: line("line"),
        original_line: line("originalLine"),
        resolved: n["isResolved"] == true,
        outdated: n["isOutdated"] == true,
        resolved_by: n["resolvedBy"]["login"].as_str().unwrap_or_default().into(),
        diff_hunk: s(first, "diffHunk"),
        review_id: first["pullRequestReview"]["databaseId"].as_u64(),
        more: (n["comments"]["totalCount"].as_u64().unwrap_or(0) as usize).saturating_sub(nodes.len()) as u32,
        comments: nodes
            .iter()
            .map(|c| ThreadComment { id: s(c, "id"), author: login(&c["author"]), at: s(c, "createdAt"), body: s(c, "body"), url: s(c, "url") })
            .collect(),
    }
}

/// The `comments`, `reviews` and `threads` lists of a `pulls.get` reply, in the REST shape
/// apps up to 0.2.10 read, so they keep working against this daemon.
pub fn legacy_lists(t: &PullTimeline) -> (Vec<Value>, Vec<Value>, Vec<Value>) {
    let of = |kind: &'static str| t.items.iter().filter(move |i| i.kind == kind);
    let comments = of("comment")
        .map(|i| json!({"id": i.id, "body": i.body, "html_url": i.url, "created_at": i.at, "user": {"login": i.actor}}))
        .collect();
    let reviews = of("review")
        .map(|i| json!({"id": i.id, "body": i.body, "html_url": i.url, "submitted_at": i.at, "state": i.state, "user": {"login": i.actor}}))
        .collect();
    let threads = t
        .threads
        .iter()
        .flat_map(|th| {
            th.comments.iter().map(move |c| json!({"id": c.id, "body": c.body, "html_url": c.url, "created_at": c.at, "path": th.path, "line": th.line, "user": {"login": c.author}}))
        })
        .collect();
    (comments, reviews, threads)
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;

    /// Answers each query with the next page and records the variables it was sent.
    struct Pages {
        pages: Mutex<Vec<Value>>,
        sent: Mutex<Vec<Value>>,
    }
    #[async_trait]
    impl Github for Pages {
        fn host(&self) -> &str {
            "github.com"
        }
        async fn diff(&self, _: &str, _: &str, _: &str) -> Result<String> {
            unreachable!()
        }
        async fn request(&self, _: &str, path: &str, body: Option<Value>) -> Result<Value> {
            assert_eq!(path, "graphql");
            self.sent.lock().unwrap().push(body.unwrap()["variables"].clone());
            Ok(self.pages.lock().unwrap().remove(0))
        }
    }
    fn pull() -> PullRequest {
        PullRequest { repo: "o/r".into(), number: 7, ..Default::default() }
    }
    fn page(items: Option<(Vec<Value>, Option<&str>)>, threads: Option<(Vec<Value>, Option<&str>)>) -> Value {
        let conn = |(nodes, next): (Vec<Value>, Option<&str>)| json!({"pageInfo": {"hasNextPage": next.is_some(), "endCursor": next}, "nodes": nodes});
        let mut pr = json!({"commits": {"totalCount": 3}});
        if let Some(c) = items {
            pr["timelineItems"] = conn(c);
        }
        if let Some(c) = threads {
            pr["reviewThreads"] = conn(c);
        }
        json!({"data": {"repository": {"pullRequest": pr}}})
    }

    #[tokio::test]
    async fn pages_each_connection_on_its_own_cursor() {
        let comment = |id: &str| json!({"__typename": "IssueComment", "id": id, "body": "hi", "createdAt": "2026-10-01T10:00:00Z", "url": "u", "author": {"login": "ann"}});
        let gh = Pages {
            pages: Mutex::new(vec![
                page(Some((vec![comment("c1")], Some("i1"))), Some((vec![json!({"id": "t1", "comments": {"totalCount": 0, "nodes": []}})], None))),
                page(Some((vec![comment("c2")], None)), None),
            ]),
            sent: Mutex::default(),
        };
        let t = timeline(&gh, &pull()).await.unwrap();
        assert_eq!(t.items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["c1", "c2"]);
        assert_eq!(t.threads.len(), 1);
        assert_eq!(t.commits, 3);
        let sent = gh.sent.lock().unwrap();
        assert_eq!(sent[1]["items"], "i1");
        assert_eq!((sent[1]["withItems"].clone(), sent[1]["withThreads"].clone()), (json!(true), json!(false)), "threads were complete");
    }

    #[tokio::test]
    async fn errors_fail_the_read() {
        let gh = Pages { pages: Mutex::new(vec![json!({"errors": [{"message": "nope"}]})]), sent: Mutex::default() };
        assert!(timeline(&gh, &pull()).await.is_err());
    }

    #[test]
    fn reads_reviews_events_and_threads() {
        let review = item(&json!({"__typename": "PullRequestReview", "id": "R1", "databaseId": 42, "body": "", "state": "CHANGES_REQUESTED", "createdAt": "2026-10-01T09:00:00Z", "submittedAt": "2026-10-01T09:05:00Z", "url": "u", "author": null})).unwrap();
        assert_eq!((review.kind.as_str(), review.at.as_str(), review.actor.as_str(), review.review_id), ("review", "2026-10-01T09:05:00Z", "ghost", Some(42)));
        let commit = item(&json!({"__typename": "PullRequestCommit", "id": "C", "url": "u", "commit": {"oid": "abc", "messageHeadline": "Fix it", "committedDate": "2026-10-01T08:00:00Z", "author": {"name": "Ann", "user": null}}})).unwrap();
        assert_eq!((commit.actor.as_str(), commit.subject.as_str(), commit.sha.as_str()), ("Ann", "Fix it", "abc"));
        let team = item(&json!({"__typename": "ReviewRequestedEvent", "id": "E", "createdAt": "x", "actor": {"login": "ann"}, "requestedReviewer": {"combinedSlug": "o/core"}})).unwrap();
        assert_eq!(team.subject, "o/core");
        let hidden = json!({"__typename": "CrossReferencedEvent", "id": "X", "createdAt": "x", "actor": {"login": "ann"}, "source": {}});
        assert!(item(&hidden).is_none(), "a reference the token cannot see is left out");
        assert!(item(&json!({"__typename": "SomethingNew"})).is_none());

        let th = thread(&json!({"id": "T", "isResolved": true, "isOutdated": false, "path": "a.rs", "line": 9, "originalLine": 8, "resolvedBy": {"login": "bob"},
            "comments": {"totalCount": 3, "nodes": [
                {"id": "c1", "body": "first", "createdAt": "t1", "url": "u1", "diffHunk": "@@ -1 +1 @@", "author": {"login": "ann"}, "pullRequestReview": {"databaseId": 42}},
                {"id": "c2", "body": "reply", "createdAt": "t2", "url": "u2", "diffHunk": "@@ -1 +1 @@", "author": {"login": "bob"}, "pullRequestReview": {"databaseId": 43}}]}}));
        assert_eq!((th.review_id, th.line, th.resolved, th.more, th.diff_hunk.as_str()), (Some(42), Some(9), true, 1, "@@ -1 +1 @@"));
    }

    #[test]
    fn legacy_lists_keep_the_rest_shape() {
        let t = PullTimeline {
            items: vec![
                TimelineItem { kind: "comment".into(), id: "c".into(), body: "hi".into(), actor: "ann".into(), ..Default::default() },
                TimelineItem { kind: "review".into(), id: "r".into(), state: "APPROVED".into(), actor: "bob".into(), ..Default::default() },
                TimelineItem { kind: "labeled".into(), ..Default::default() },
            ],
            threads: vec![ReviewThread { path: "a.rs".into(), line: None, comments: vec![ThreadComment { id: "t".into(), author: "ann".into(), ..Default::default() }; 2], ..Default::default() }],
            commits: 1,
        };
        let (comments, reviews, threads) = legacy_lists(&t);
        assert_eq!(comments, [json!({"id": "c", "body": "hi", "html_url": "", "created_at": "", "user": {"login": "ann"}})]);
        assert_eq!(reviews[0]["state"], "APPROVED");
        assert_eq!(threads.len(), 2);
        assert_eq!((threads[0]["path"].clone(), threads[0]["line"].clone()), (json!("a.rs"), Value::Null));
    }
}
