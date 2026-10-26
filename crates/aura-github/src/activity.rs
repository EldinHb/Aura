//! Reviews, inline comments and conversation of many PRs, a batch per GraphQL query, for the
//! loops that look for new activity: review follow-ups and review watches. Notifications tell
//! which PRs changed, so the rest are read on a slower schedule.
use crate::{batch_nodes, database_id, Github};
use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use futures::{stream, StreamExt, TryStreamExt};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

/// A PR is read at least this often, whatever notifications say.
pub const FULL_POLL: Duration = Duration::from_secs(5 * 60);
/// Without notifications, a PR updated within this long is read every pass, others every [`FULL_POLL`].
pub const ACTIVE: Duration = Duration::from_secs(60 * 60);
/// GitHub's API can show activity a little after its notification; a PR stays due this long after one.
const SKEW: Duration = Duration::from_secs(2 * 60);
/// How long one loop's read serves another loop.
const SHARED_FOR: Duration = Duration::from_secs(30);
const BATCH: usize = 20;

const REVIEW: &str = " fragment review on PullRequestReview{fullDatabaseId state body url submittedAt author{__typename login}}";
const COMMENT: &str =
    " fragment comment on IssueComment{fullDatabaseId body url author{__typename login}}";
const INLINE: &str = " fragment inline on PullRequestReviewComment{fullDatabaseId body url path line originalLine author{__typename login}}";
const THREADS: &str = "{pageInfo{hasNextPage endCursor} nodes{id comments(last:50){pageInfo{hasPreviousPage startCursor} nodes{...inline}}}}";

fn fragment() -> String {
    format!(
        "fragment pull on PullRequest{{id number title url state updatedAt author{{login}} \
         reviews(last:50){{pageInfo{{hasPreviousPage startCursor}} nodes{{...review}}}} \
         comments(last:50){{pageInfo{{hasPreviousPage startCursor}} nodes{{...comment}}}} \
         reviewThreads(first:50){THREADS}}}{REVIEW}{COMMENT}{INLINE}"
    )
}

/// The highest ids a reader saw of a PR, per kind. None for a first look, which only records
/// where things stand and so reads the newest page alone.
#[derive(Debug, Clone, Copy, Default)]
pub struct Since {
    pub reviews: Option<u64>,
    pub comments: Option<u64>,
    pub conversation: Option<u64>,
}

/// A PR as read: its node, with `reviews`, `comments` and every `reviewThreads` complete back to
/// what the reader saw, and when it was read.
#[derive(Debug, Clone)]
pub struct Read {
    pub node: Value,
    pub at: DateTime<Utc>,
}

/// Read `prs` (`owner/repo`, number, what the reader saw), a batch per query. A PR GitHub
/// cannot return fails on its own; a query that fails as a whole fails the read.
pub async fn read(gh: &dyn Github, prs: &[(String, u32, Since)]) -> Result<Vec<Result<Read>>> {
    let key = |repo: &str, number: u32| format!("activity:{}#{number}", repo.to_lowercase());
    let mut out: Vec<Option<Result<Read>>> = prs
        .iter()
        .map(|(repo, number, _)| {
            let memo = gh.memo()?;
            let (node, at) = memo.recall(&key(repo, *number), SHARED_FOR)?;
            Some(Ok(Read { node, at }))
        })
        .collect();
    let missing: Vec<(String, u32)> = prs
        .iter()
        .zip(&out)
        .filter(|(_, read)| read.is_none())
        .map(|((repo, number, _), _)| (repo.clone(), *number))
        .collect();
    let fragment = fragment();
    let fragment = fragment.as_str();
    let batches: Vec<_> = stream::iter(missing.chunks(BATCH).map(<[_]>::to_vec))
        .map(|chunk| async move {
            let at = Utc::now();
            let nodes = batch_nodes(gh, &chunk, "", json!({}), "", fragment).await?;
            Ok::<_, anyhow::Error>(
                nodes
                    .into_iter()
                    .map(move |n| n.map(|(_, node)| Read { node, at })),
            )
        })
        .buffered(3)
        .try_collect()
        .await?;
    let mut fetched = batches.into_iter().flatten();
    for slot in out.iter_mut().filter(|r| r.is_none()) {
        *slot = fetched.next();
    }
    let mut reads = vec![];
    for ((repo, number, since), read) in prs.iter().zip(out) {
        let read = match read.context("GitHub returned too few pull requests")? {
            Ok(mut read) => match complete(gh, &mut read.node, since).await {
                Ok(()) => {
                    if let Some(memo) = gh.memo() {
                        memo.keep(&key(repo, *number), &read.node, read.at);
                    }
                    Ok(read)
                }
                Err(e) => Err(e.context(format!("Unable to read {repo}#{number}"))),
            },
            Err(e) => Err(e),
        };
        reads.push(read);
    }
    Ok(reads)
}

/// Fill in what the first page left out: older reviews and comments down to what the reader
/// saw, and every review thread, since any of them can get a reply.
async fn complete(gh: &dyn Github, node: &mut Value, since: &Since) -> Result<()> {
    let id = node["id"]
        .as_str()
        .context("Pull request without id")?
        .to_string();
    older(
        gh,
        &id,
        "PullRequest",
        "reviews",
        "...review",
        REVIEW,
        &mut node["reviews"],
        since.reviews,
    )
    .await?;
    older(
        gh,
        &id,
        "PullRequest",
        "comments",
        "...comment",
        COMMENT,
        &mut node["comments"],
        since.conversation,
    )
    .await?;
    while node["reviewThreads"]["pageInfo"]["hasNextPage"] == true {
        let cursor = node["reviewThreads"]["pageInfo"]["endCursor"].clone();
        let query = format!(
            "query($id:ID!,$cursor:String){{node(id:$id){{... on PullRequest{{reviewThreads(first:50,after:$cursor){THREADS}}}}}}}{INLINE}"
        );
        let page = page(gh, &query, &id, cursor, "reviewThreads").await?;
        append(&mut node["reviewThreads"], page, false);
    }
    if let Some(threads) = node["reviewThreads"]["nodes"].as_array_mut() {
        for thread in threads {
            let thread_id = thread["id"].as_str().unwrap_or_default().to_string();
            older(
                gh,
                &thread_id,
                "PullRequestReviewThread",
                "comments",
                "...inline",
                INLINE,
                &mut thread["comments"],
                since.comments,
            )
            .await?;
        }
    }
    Ok(())
}

/// Prepend older pages of the connection `field` of node `id` while its oldest item is newer
/// than `since`.
#[allow(clippy::too_many_arguments)]
async fn older(
    gh: &dyn Github,
    id: &str,
    on: &str,
    field: &str,
    spread: &str,
    fragment: &str,
    conn: &mut Value,
    since: Option<u64>,
) -> Result<()> {
    let Some(seen) = since else { return Ok(()) };
    while conn["pageInfo"]["hasPreviousPage"] == true && oldest(conn) > seen {
        let cursor = conn["pageInfo"]["startCursor"].clone();
        let query = format!(
            "query($id:ID!,$cursor:String){{node(id:$id){{... on {on}{{{field}(last:100,before:$cursor){{pageInfo{{hasPreviousPage startCursor}} nodes{{{spread}}}}}}}}}}}{fragment}"
        );
        let page = page(gh, &query, id, cursor, field).await?;
        append(conn, page, true);
    }
    Ok(())
}

fn oldest(conn: &Value) -> u64 {
    conn["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(database_id)
        .min()
        .unwrap_or(u64::MAX)
}

async fn page(gh: &dyn Github, query: &str, id: &str, cursor: Value, field: &str) -> Result<Value> {
    let r = gh
        .request(
            "POST",
            "graphql",
            Some(json!({"query": query, "variables": {"id": id, "cursor": cursor}})),
        )
        .await?;
    let page = &r["data"]["node"][field];
    if !page.is_object() {
        bail!("Unable to read more {field}: {}", r["errors"]);
    }
    Ok(page.clone())
}

/// Add `page` to `conn`, before its nodes when `before`, and take its page info.
fn append(conn: &mut Value, page: Value, before: bool) {
    let mut nodes = page["nodes"].as_array().cloned().unwrap_or_default();
    let had = conn["nodes"].as_array().cloned().unwrap_or_default();
    if before {
        nodes.extend(had);
    } else {
        nodes.splice(0..0, had);
    }
    conn["nodes"] = json!(nodes);
    conn["pageInfo"] = page["pageInfo"].clone();
}

/// When a PR was last read, and when it was last updated as of that read.
pub type LastRead = (DateTime<Utc>, DateTime<Utc>);

/// Whether a PR last read at `read` (and updated at `updated`) is read again now: after
/// [`FULL_POLL`] in any case, else when a notification says it changed, or without
/// notifications while it is active.
pub fn due(
    read: Option<LastRead>,
    notified: Option<&Notified>,
    repo: &str,
    number: u32,
    now: DateTime<Utc>,
) -> bool {
    let Some((read, updated)) = read else {
        return true;
    };
    if now - read >= chrono::Duration::from_std(FULL_POLL).unwrap() {
        return true;
    }
    match notified {
        Some(n) => n.changed(repo, number, read),
        None => now - updated < chrono::Duration::from_std(ACTIVE).unwrap(),
    }
}

/// Recent notification threads of PRs: `owner/repo#number` (lowercase) -> its latest activity.
#[derive(Debug, Clone, Default)]
pub struct Notified {
    pulls: HashMap<String, DateTime<Utc>>,
    /// The list holds one page: before this, threads may be missing from it.
    complete_since: Option<DateTime<Utc>>,
}

impl Notified {
    /// Read a page of `GET /notifications` that asked for `page` threads.
    pub fn parse(rows: &Value, page: usize) -> Option<Self> {
        let rows = rows.as_array()?;
        let mut pulls: HashMap<String, DateTime<Utc>> = HashMap::new();
        let mut oldest: Option<DateTime<Utc>> = None;
        for row in rows {
            let at = DateTime::parse_from_rfc3339(row["updated_at"].as_str()?)
                .ok()?
                .with_timezone(&Utc);
            oldest = Some(oldest.map_or(at, |o| o.min(at)));
            if row["subject"]["type"] != "PullRequest" {
                continue;
            }
            let Some(id) = row["subject"]["url"]
                .as_str()
                .and_then(|url| url.split_once("/repos/"))
                .and_then(|(_, path)| {
                    let mut parts = path.split('/');
                    let (owner, name, kind, number) =
                        (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
                    (kind == "pulls").then(|| format!("{owner}/{name}#{number}").to_lowercase())
                })
            else {
                continue;
            };
            let latest = pulls.entry(id).or_insert(at);
            *latest = (*latest).max(at);
        }
        Some(Self {
            pulls,
            complete_since: (rows.len() >= page).then_some(oldest).flatten(),
        })
    }

    /// Whether the PR may have changed since `read`.
    pub fn changed(&self, repo: &str, number: u32, read: DateTime<Utc>) -> bool {
        let since = read - chrono::Duration::from_std(SKEW).unwrap();
        if self.complete_since.is_some_and(|c| since < c) {
            return true;
        }
        self.pulls
            .get(&format!("{}#{number}", repo.to_lowercase()))
            .is_some_and(|at| *at > since)
    }
}

/// An answer: when it was kept, when it was read, and the answer.
type Kept = (Instant, DateTime<Utc>, Value);

/// Answers one loop read moments ago, for another loop that wants the same.
#[derive(Default)]
pub struct Memo(Mutex<HashMap<String, Kept>>);

impl Memo {
    pub fn recall(&self, key: &str, within: Duration) -> Option<(Value, DateTime<Utc>)> {
        let memo = self.0.lock();
        let (kept, at, value) = memo.get(key)?;
        (kept.elapsed() < within).then(|| (value.clone(), *at))
    }

    pub fn keep(&self, key: &str, value: &Value, at: DateTime<Utc>) {
        let mut memo = self.0.lock();
        memo.retain(|_, (kept, _, _)| kept.elapsed() < SHARED_FOR);
        memo.insert(key.into(), (Instant::now(), at, value.clone()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn time(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }
    fn thread(kind: &str, url: &str, at: &str) -> Value {
        json!({"updated_at": at, "subject": {"type": kind, "url": url}})
    }

    #[test]
    fn notifications_tell_which_prs_changed() {
        let rows = json!([
            thread(
                "PullRequest",
                "https://api.github.com/repos/O/R/pulls/1",
                "2026-10-26T10:10:00Z"
            ),
            thread(
                "Issue",
                "https://api.github.com/repos/o/r/issues/2",
                "2026-10-26T10:05:00Z"
            ),
            thread(
                "PullRequest",
                "https://git.example.com/api/v3/repos/o/r/pulls/3",
                "2026-10-26T09:00:00Z"
            ),
        ]);
        let n = Notified::parse(&rows, 50).unwrap();
        assert!(n.changed("o/r", 1, time("2026-10-26T10:00:00Z")));
        assert!(
            n.changed("o/r", 1, time("2026-10-26T10:11:00Z")),
            "GitHub may not show it yet"
        );
        assert!(!n.changed("o/r", 1, time("2026-10-26T10:30:00Z")));
        assert!(
            !n.changed("o/r", 2, time("2026-10-26T09:00:00Z")),
            "issues are not PRs"
        );
        assert!(n.changed("o/r", 3, time("2026-10-26T08:00:00Z")));
        assert!(
            !n.changed("o/r", 4, time("2026-01-01T00:00:00Z")),
            "a short list is complete"
        );

        let full = Notified::parse(&rows, 3).unwrap();
        assert!(
            full.changed("o/r", 4, time("2026-10-26T08:00:00Z")),
            "a full page may have left older threads out"
        );
        assert!(!full.changed("o/r", 4, time("2026-10-26T10:00:00Z")));
    }

    #[test]
    fn a_pr_is_due_when_notified_active_or_unread_for_a_while() {
        let now = time("2026-10-26T12:00:00Z");
        let minutes = |m: i64| now - chrono::Duration::minutes(m);
        let quiet = Notified::default();
        assert!(due(None, Some(&quiet), "o/r", 1, now), "never read");
        assert!(!due(
            Some((minutes(1), minutes(1))),
            Some(&quiet),
            "o/r",
            1,
            now
        ));
        assert!(due(
            Some((minutes(5), minutes(500))),
            Some(&quiet),
            "o/r",
            1,
            now
        ));
        let rows = json!([thread(
            "PullRequest",
            "https://api.github.com/repos/o/r/pulls/1",
            "2026-10-26T11:59:30Z"
        )]);
        let notified = Notified::parse(&rows, 50).unwrap();
        assert!(due(
            Some((minutes(1), minutes(500))),
            Some(&notified),
            "o/r",
            1,
            now
        ));
        assert!(
            due(Some((minutes(1), minutes(10))), None, "o/r", 1, now),
            "without notifications an active PR is read every pass"
        );
        assert!(!due(Some((minutes(1), minutes(120))), None, "o/r", 1, now));
    }

    /// Answers the batch query and the page queries for one PR (`o/r#1`).
    struct Paged {
        queries: Mutex<Vec<String>>,
    }
    #[async_trait::async_trait]
    impl Github for Paged {
        fn host(&self) -> &str {
            "github.com"
        }
        async fn diff(&self, _: &str, _: &str, _: &str) -> Result<String> {
            unreachable!()
        }
        async fn request(&self, _: &str, _: &str, body: Option<Value>) -> Result<Value> {
            let body = body.unwrap();
            let query = body["query"].as_str().unwrap().to_string();
            self.queries.lock().push(query.clone());
            let ids = |from: u64, to: u64| -> Vec<Value> {
                (from..=to)
                    .map(|id| json!({"fullDatabaseId": id.to_string()}))
                    .collect()
            };
            let conn = |nodes: Vec<Value>, more: bool| json!({"pageInfo": {"hasPreviousPage": more, "startCursor": "c", "hasNextPage": more, "endCursor": "c"}, "nodes": nodes});
            if query.contains("pr0:pullRequest") {
                return Ok(json!({"data": {"r0": {"pr0": {
                    "id": "PR1", "state": "OPEN",
                    "reviews": conn(ids(151, 200), true),
                    "comments": conn(ids(1, 3), false),
                    "reviewThreads": {"pageInfo": {"hasNextPage": true, "endCursor": "t"}, "nodes": [
                        {"id": "T1", "comments": conn(ids(10, 11), false)}]},
                }}}}));
            }
            if query.contains("reviews(last:100,before:$cursor)") {
                return Ok(json!({"data": {"node": {"reviews": conn(ids(51, 150), true)}}}));
            }
            if query.contains("reviewThreads(first:50,after:$cursor)") {
                return Ok(
                    json!({"data": {"node": {"reviewThreads": {"pageInfo": {"hasNextPage": false}, "nodes": [
                    {"id": "T2", "comments": conn(ids(20, 21), false)}]}}}}),
                );
            }
            bail!("unexpected query {query}")
        }
    }

    #[tokio::test]
    async fn reads_older_pages_down_to_what_was_seen_and_every_thread() {
        let gh = Paged {
            queries: Mutex::new(vec![]),
        };
        let first = read(&gh, &[("o/r".into(), 1, Since::default())])
            .await
            .unwrap();
        let node = &first[0].as_ref().unwrap().node;
        assert_eq!(
            node["reviews"]["nodes"].as_array().unwrap().len(),
            50,
            "a first look takes the newest page"
        );
        assert_eq!(
            node["reviewThreads"]["nodes"].as_array().unwrap().len(),
            2,
            "every thread"
        );

        gh.queries.lock().clear();
        let since = Since {
            reviews: Some(120),
            ..Default::default()
        };
        let next = read(&gh, &[("o/r".into(), 1, since)]).await.unwrap();
        let node = &next[0].as_ref().unwrap().node;
        let reviews: Vec<u64> = node["reviews"]["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(database_id)
            .collect();
        assert_eq!(
            (reviews[0], reviews.len()),
            (51, 150),
            "older pages come first"
        );
        assert_eq!(
            gh.queries.lock().len(),
            3,
            "the batch, one older page of reviews and one more page of threads"
        );
    }
}
