//! Pull request changes for the inbox. Each refresh of the review inbox compares the
//! PRs the user follows (authored, asked to review, reviewed, or linked to a session)
//! with the previous refresh and records what changed as one inbox entry per PR.
//!
//! What was last seen of each PR is kept per account, so a restart does not report
//! anything twice. The first refresh of an account only records where things stand.
//! The user's own actions are never reported; neither are comments by bots (CI and
//! coverage reports). Reviews by bots are, marked as such.
use anyhow::Result;
use aura_core::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// What was last seen of an account's PRs; one setting per account.
const SNAPSHOT_KEY: &str = "pulls.snapshots.v1.";
/// Inbox entries, one record each, per account.
const ENTRIES: &str = "pull-changes:";
/// Entries kept per account; the oldest read ones go first.
const KEEP: usize = 300;
/// Read entries are dropped after this many days.
const KEEP_READ_DAYS: i64 = 30;
/// A PR no refresh has listed for this many days is forgotten.
const FORGET_DAYS: i64 = 30;
/// Review states that mean a reviewer responded.
const RESPONSES: [&str; 3] = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"];

/// Why the user follows a PR, in order of precedence.
pub const ROLES: [&str; 4] = ["requested", "authored", "reviewed", "linked"];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Snapshots {
    /// When the account's first refresh ran; review requests from before then are history.
    #[serde(default)]
    pub since: String,
    /// By [`PullRequest::id`].
    #[serde(default)]
    pub pulls: BTreeMap<String, Snapshot>,
}

/// What was last seen of one PR.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    #[serde(default)]
    pub repo: String,
    #[serde(default)]
    pub number: u32,
    #[serde(default)]
    pub role: String,
    /// open | closed | merged
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub head_sha: String,
    #[serde(default)]
    pub commits: u32,
    #[serde(default)]
    pub checks: String,
    /// The latest check rollup that had finished: SUCCESS, FAILURE or ERROR.
    #[serde(default)]
    pub finished_checks: String,
    /// The latest merge state GitHub had worked out; never UNKNOWN.
    #[serde(default)]
    pub merge_state: String,
    #[serde(default)]
    pub review_requested_at: Option<String>,
    /// Highest GitHub ids already seen.
    #[serde(default)]
    pub seen_review: u64,
    #[serde(default)]
    pub seen_comment: u64,
    #[serde(default)]
    pub seen_thread: u64,
    /// Listed by the latest refresh. A PR that leaves the lists is read once more, to
    /// learn whether it was merged or closed.
    #[serde(default)]
    pub tracked: bool,
    /// When a refresh last listed it.
    #[serde(default)]
    pub seen_at: String,
}

/// What was last seen of `account`'s PRs; None before its first refresh. Unreadable
/// counts as none: the next refresh takes a new baseline rather than failing for good.
pub fn load(store: &dyn Store, account: &str) -> Option<Snapshots> {
    let raw = match store.get_setting(&format!("{SNAPSHOT_KEY}{account}")) {
        Ok(raw) => raw?,
        Err(e) => {
            tracing::warn!("reading pull request snapshots failed: {e:#}");
            return None;
        }
    };
    serde_json::from_str(&raw)
        .inspect_err(|e| {
            tracing::warn!("pull request snapshots unreadable, taking a new baseline: {e:#}")
        })
        .ok()
}

pub fn save(store: &dyn Store, account: &str, snapshots: &Snapshots) -> Result<()> {
    store.set_setting(
        &format!("{SNAPSHOT_KEY}{account}"),
        &serde_json::to_string(snapshots)?,
    )
}

/// Open PRs the previous refresh followed and this one does not (`listed`): read once more.
pub fn leavers(snapshots: &Snapshots, listed: &[(String, u32)]) -> Vec<(String, u32)> {
    snapshots
        .pulls
        .values()
        .filter(|s| s.tracked && s.state == "open")
        .filter(|s| {
            !listed
                .iter()
                .any(|(r, n)| r.eq_ignore_ascii_case(&s.repo) && *n == s.number)
        })
        .map(|s| (s.repo.clone(), s.number))
        .collect()
}

fn finished(checks: &str) -> bool {
    matches!(checks, "SUCCESS" | "FAILURE" | "ERROR")
}
fn failing(checks: &str) -> bool {
    matches!(checks, "FAILURE" | "ERROR")
}

/// `pull` as seen now, keeping from `before` what this read does not tell.
pub fn snapshot(pull: &PullRequest, role: &str, before: Option<&Snapshot>) -> Snapshot {
    let before = before.cloned().unwrap_or_default();
    let a = &pull.activity;
    let max = |seen: u64, ids: &mut dyn Iterator<Item = u64>| ids.fold(seen, u64::max);
    Snapshot {
        repo: pull.repo.clone(),
        number: pull.number,
        role: role.into(),
        state: pull.state.clone(),
        head_sha: pull.head_sha.clone(),
        commits: a.commits,
        checks: pull.checks.clone(),
        finished_checks: if finished(&pull.checks) {
            pull.checks.clone()
        } else {
            before.finished_checks
        },
        merge_state: match pull.merge_state.as_str() {
            "" | "UNKNOWN" => before.merge_state,
            known => known.into(),
        },
        review_requested_at: pull
            .review_requested_at
            .clone()
            .max(before.review_requested_at),
        seen_review: max(before.seen_review, &mut a.reviews.iter().map(|r| r.id)),
        seen_comment: max(before.seen_comment, &mut a.comments.iter().map(|c| c.id)),
        seen_thread: max(
            before.seen_thread,
            &mut a.thread_comments.iter().map(|c| c.id),
        ),
        tracked: true,
        seen_at: now().to_rfc3339(),
    }
}

/// What changed on `pull` since `before`, leaving out what `me` did. Checks and
/// mergeability are reported only on PRs the user authored or linked to a session.
pub fn diff(before: &Snapshot, pull: &PullRequest, role: &str, me: &str) -> Vec<PullEvent> {
    let is_me = |login: &str| !login.is_empty() && login.eq_ignore_ascii_case(me);
    let a = &pull.activity;
    let open = pull.state == "open";
    let mut events = vec![];
    let event = |kind: &str, actor: &str, detail: &str| PullEvent {
        kind: kind.into(),
        actor: actor.into(),
        detail: detail.into(),
        count: 1,
        ..Default::default()
    };
    if !before.state.is_empty() && pull.state != before.state && !is_me(&a.state_actor) {
        let detail = if open {
            "reopened"
        } else {
            pull.state.as_str()
        };
        events.push(event("state", &a.state_actor, detail));
    }
    if open
        && !before.head_sha.is_empty()
        && pull.head_sha != before.head_sha
        && !a.pushed_by.iter().any(|l| is_me(l))
    {
        let mut e = event("commits", a.pushed_by.first().map_or("", |l| l), "");
        e.count = a.commits.saturating_sub(before.commits).max(1);
        events.push(e);
    }
    let mut reviewers = vec![];
    for r in &a.reviews {
        if r.id <= before.seen_review
            || is_me(&r.reviewer)
            || r.reviewer.eq_ignore_ascii_case(&pull.author)
            || !RESPONSES.contains(&r.state.as_str())
        {
            continue;
        }
        reviewers.push(r.reviewer.to_lowercase());
        events.push(PullEvent {
            bot: r.bot,
            review_id: r.id,
            ..event("review", &r.reviewer, &r.state)
        });
    }
    // Inline comments that come with a review are part of it.
    let fresh =
        a.comments
            .iter()
            .filter(|c| c.id > before.seen_comment)
            .chain(a.thread_comments.iter().filter(|c| {
                c.id > before.seen_thread && !reviewers.contains(&c.author.to_lowercase())
            }))
            .filter(|c| !c.bot && !c.author.is_empty() && !is_me(&c.author));
    let mut commenters: Vec<PullEvent> = vec![];
    for c in fresh {
        match commenters
            .iter_mut()
            .find(|e| e.actor.eq_ignore_ascii_case(&c.author))
        {
            Some(e) => e.count += 1,
            None => commenters.push(event("comment", &c.author, "")),
        }
    }
    events.extend(commenters);
    if open
        && role == "requested"
        && pull.review_requested_at.is_some()
        && pull.review_requested_at > before.review_requested_at
    {
        events.push(event("review_requested", "", ""));
    }
    if open && matches!(role, "authored" | "linked") {
        if failing(&pull.checks) && (!failing(&before.checks) || pull.head_sha != before.head_sha) {
            events.push(event("checks", "", &pull.checks));
        } else if pull.checks == "SUCCESS" && failing(&before.finished_checks) {
            events.push(event("checks", "", "SUCCESS"));
        }
        let (was, is) = (before.merge_state.as_str(), pull.merge_state.as_str());
        if is == "DIRTY" && !matches!(was, "" | "DIRTY") {
            events.push(event("mergeable", "", "conflicts"));
        } else if matches!(is, "CLEAN" | "HAS_HOOKS")
            && matches!(was, "DIRTY" | "BLOCKED" | "BEHIND")
        {
            events.push(event("mergeable", "", "clean"));
        }
    }
    events
}

/// A PR the user had not followed before. Only a request for their review is news:
/// a PR they opened, reviewed or linked was their own doing.
pub fn arrived(pull: &PullRequest, role: &str, since: &str) -> Vec<PullEvent> {
    let requested_after = pull
        .review_requested_at
        .as_deref()
        .is_some_and(|at| at > since);
    if role == "requested" && pull.state == "open" && requested_after {
        vec![PullEvent {
            kind: "review_requested".into(),
            count: 1,
            ..Default::default()
        }]
    } else {
        vec![]
    }
}

fn plural(n: u32, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {many}")
    }
}

/// The events in a line: `bob pushed 2 commits · alice approved · checks failed`.
pub fn summary(events: &[PullEvent]) -> String {
    events.iter().map(describe).collect::<Vec<_>>().join(" · ")
}

/// Put each event in words.
fn label(events: &mut [PullEvent]) {
    for e in events {
        e.text = describe(e);
    }
}

fn describe(e: &PullEvent) -> String {
    let who = if e.bot {
        format!("{} (bot)", e.actor)
    } else {
        e.actor.clone()
    };
    let by = |text: String| {
        if e.actor.is_empty() {
            text
        } else {
            format!("{text} by {who}")
        }
    };
    match e.kind.as_str() {
        "commits" if e.actor.is_empty() => plural(e.count, "new commit", "new commits"),
        "commits" => format!("{who} pushed {}", plural(e.count, "commit", "commits")),
        "review" => format!(
            "{who} {}",
            match e.detail.as_str() {
                "APPROVED" => "approved",
                "CHANGES_REQUESTED" => "requested changes",
                _ => "reviewed",
            }
        ),
        "comment" if e.count > 1 => format!("{who} left {} comments", e.count),
        "comment" => format!("{who} commented"),
        "review_requested" => "your review was requested".into(),
        "checks" if e.detail == "SUCCESS" => "checks pass again".into(),
        "checks" => "checks failed".into(),
        "state" => by(e.detail.clone()),
        "mergeable" if e.detail == "conflicts" => "has merge conflicts".into(),
        "mergeable" => "ready to merge".into(),
        other => other.replace('_', " "),
    }
}

/// Add `fresh` to `events`: counts of pushes and comments add up, and a later review,
/// check result, state or mergeability replaces the earlier one.
fn merge(events: &mut Vec<PullEvent>, fresh: &[PullEvent]) {
    for e in fresh {
        let same = |x: &PullEvent| {
            x.kind == e.kind
                && match e.kind.as_str() {
                    "commits" | "comment" | "review" => x.actor.eq_ignore_ascii_case(&e.actor),
                    _ => true,
                }
        };
        match events.iter_mut().find(|x| same(x)) {
            Some(x) if matches!(e.kind.as_str(), "commits" | "comment") => {
                x.count += e.count;
            }
            Some(x) => *x = e.clone(),
            None => events.push(e.clone()),
        }
    }
}

pub fn entries(store: &dyn Store, account: &str) -> Result<Vec<PullChange>> {
    let mut list = store
        .feature_records(&format!("{ENTRIES}{account}"))?
        .into_iter()
        .filter_map(|(_, raw)| serde_json::from_str::<PullChange>(&raw).ok())
        .collect::<Vec<_>>();
    list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(list)
}

fn put(store: &dyn Store, entry: &PullChange) -> Result<()> {
    store.save_feature_record(
        &format!("{ENTRIES}{}", entry.account),
        &entry.id,
        &serde_json::to_string(entry)?,
    )
}

/// Record the changes found on one refresh: into the PR's unread entry if it has one,
/// else a new entry. Returns each entry as the user should hear of it now: its id with
/// only the events just found.
pub fn record(store: &dyn Store, account: &str, found: Vec<PullChange>) -> Result<Vec<PullChange>> {
    if found.is_empty() {
        return Ok(vec![]);
    }
    let mut existing = entries(store, account)?;
    let mut news = vec![];
    for mut change in found {
        let fresh = change.events.clone();
        let entry = match existing
            .iter_mut()
            .find(|e| !e.read && e.pull_id == change.pull_id)
        {
            Some(entry) => {
                merge(&mut entry.events, &fresh);
                label(&mut entry.events);
                entry.title = change.title.clone();
                entry.role = change.role.clone();
                entry.created_at = change.created_at.clone();
                entry.summary = summary(&entry.events);
                entry.clone()
            }
            None => {
                change.summary = summary(&change.events);
                existing.push(change.clone());
                change.clone()
            }
        };
        put(store, &entry)?;
        change.id = entry.id;
        change.summary = summary(&fresh);
        news.push(change);
    }
    prune(store, account, existing)?;
    Ok(news)
}

fn prune(store: &dyn Store, account: &str, mut list: Vec<PullChange>) -> Result<()> {
    let cutoff = (now() - chrono::Duration::days(KEEP_READ_DAYS)).to_rfc3339();
    // Unread first, then the latest.
    list.sort_by(|a, b| a.read.cmp(&b.read).then(b.created_at.cmp(&a.created_at)));
    for (i, e) in list.iter().enumerate() {
        if i >= KEEP || (e.read && e.created_at < cutoff) {
            store.delete_feature_record(&format!("{ENTRIES}{account}"), &e.id)?;
        }
    }
    Ok(())
}

/// Mark the entries `ids` read, or every entry when `ids` is None. Returns whether any changed.
pub fn mark_read(store: &dyn Store, account: &str, ids: Option<&[String]>) -> Result<bool> {
    let mut changed = false;
    for mut e in entries(store, account)? {
        if !e.read && ids.is_none_or(|ids| ids.contains(&e.id)) {
            e.read = true;
            put(store, &e)?;
            changed = true;
        }
    }
    Ok(changed)
}

/// One refresh's worth of PRs, as read: `(pull, role)` for each PR GitHub returned.
/// Updates `snapshots` and returns the changes to record. The first refresh of an
/// account (`snapshots` None) only takes the baseline.
pub fn detect(
    snapshots: Option<Snapshots>,
    read: &[(&PullRequest, &str)],
    leaving: &[(String, u32)],
    me: &str,
) -> (Snapshots, Vec<PullChange>) {
    let baseline = snapshots.is_none();
    let mut snapshots = snapshots.unwrap_or_else(|| Snapshots {
        since: now().to_rfc3339(),
        ..Default::default()
    });
    let ts = now().to_rfc3339();
    let mut found = vec![];
    for (pull, role) in read {
        let before = snapshots.pulls.get(&pull.id).cloned();
        // A PR that left the lists keeps the reason it was followed for.
        let role = before
            .as_ref()
            .filter(|_| role.is_empty())
            .map_or(*role, |b| b.role.as_str())
            .to_string();
        let mut events = match (&before, baseline) {
            (_, true) => vec![],
            (Some(before), false) => diff(before, pull, &role, me),
            (None, false) => arrived(pull, &role, &snapshots.since),
        };
        let mut next = snapshot(pull, &role, before.as_ref());
        if leaving
            .iter()
            .any(|(r, n)| r.eq_ignore_ascii_case(&pull.repo) && *n == pull.number)
        {
            next.tracked = false;
            next.seen_at = before.map(|b| b.seen_at).unwrap_or(next.seen_at);
        }
        snapshots.pulls.insert(pull.id.clone(), next);
        label(&mut events);
        if !events.is_empty() {
            found.push(PullChange {
                id: new_id(),
                account: pull.account.clone(),
                pull_id: pull.id.clone(),
                repo: pull.repo.clone(),
                number: pull.number,
                title: pull.title.clone(),
                url: pull.url.clone(),
                role,
                summary: summary(&events),
                events,
                created_at: ts.clone(),
                read: false,
            });
        }
    }
    // Leavers GitHub could not read stop being read too.
    for (repo, number) in leaving {
        if let Some(s) = snapshots
            .pulls
            .values_mut()
            .find(|s| s.repo.eq_ignore_ascii_case(repo) && s.number == *number && s.tracked)
        {
            if !read
                .iter()
                .any(|(p, _)| p.id == format!("{}#{}", s.repo, s.number))
            {
                s.tracked = false;
            }
        }
    }
    let forget = (now() - chrono::Duration::days(FORGET_DAYS)).to_rfc3339();
    snapshots.pulls.retain(|_, s| s.seen_at >= forget);
    (snapshots, found)
}

#[cfg(test)]
mod tests;
