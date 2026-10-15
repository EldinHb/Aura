use super::*;

const ME: &str = "me";

fn note(id: u64, author: &str) -> Note {
    Note {
        id,
        author: author.into(),
        bot: author.ends_with("[bot]"),
    }
}
fn latest(id: u64, reviewer: &str, state: &str) -> LatestReview {
    LatestReview {
        id,
        reviewer: reviewer.into(),
        bot: reviewer.ends_with("[bot]"),
        state: state.into(),
    }
}
/// An open PR by `author`, quiet so far: one commit, checks passing, mergeable.
fn pr(number: u32, author: &str) -> PullRequest {
    PullRequest {
        id: format!("o/r#{number}"),
        account: "github.com:me".into(),
        repo: "o/r".into(),
        number,
        title: format!("PR {number}"),
        author: author.into(),
        state: "open".into(),
        head_sha: "h1".into(),
        checks: "SUCCESS".into(),
        merge_state: "CLEAN".into(),
        activity: PullActivity {
            commits: 1,
            pushed_by: vec![author.into()],
            comments: vec![note(10, "alice")],
            thread_comments: vec![note(20, "alice")],
            reviews: vec![latest(30, "alice", "COMMENTED")],
            ..Default::default()
        },
        ..Default::default()
    }
}
fn kinds(events: &[PullEvent]) -> Vec<(String, String, String, u32)> {
    events
        .iter()
        .map(|e| (e.kind.clone(), e.actor.clone(), e.detail.clone(), e.count))
        .collect()
}
fn ev(kind: &str, actor: &str, detail: &str, count: u32) -> (String, String, String, u32) {
    (kind.into(), actor.into(), detail.into(), count)
}
/// The events between `before` and `after`, for a PR followed as `role`.
fn between(
    before: &PullRequest,
    after: &PullRequest,
    role: &str,
) -> Vec<(String, String, String, u32)> {
    let snap = snapshot(before, role, None);
    kinds(&diff(&snap, after, role, ME))
}

#[test]
fn new_commits_by_others_count_and_your_own_pushes_do_not() {
    let before = pr(1, "me");
    let mut after = before.clone();
    after.head_sha = "h2".into();
    after.activity.commits = 3;
    after.activity.pushed_by = vec!["bob".into()];
    assert_eq!(
        between(&before, &after, "authored"),
        vec![ev("commits", "bob", "", 2)]
    );
    after.activity.pushed_by = vec!["bob".into(), "Me".into()];
    assert!(
        between(&before, &after, "authored").is_empty(),
        "a commit you authored or committed is yours"
    );
    after.activity.pushed_by = vec![];
    after.activity.commits = 1;
    assert_eq!(
        between(&before, &after, "reviewed"),
        vec![ev("commits", "", "", 1)],
        "a force-push still counts once"
    );
}

#[test]
fn submitted_reviews_by_others_count_with_bots_marked() {
    let before = pr(1, "me");
    let mut after = before.clone();
    after.activity.reviews = vec![
        latest(31, "bob", "APPROVED"),
        latest(32, "carol", "CHANGES_REQUESTED"),
        latest(33, "copilot[bot]", "COMMENTED"),
        latest(34, "me", "COMMENTED"),
        latest(35, "dave", "PENDING"),
        latest(36, "erin", "DISMISSED"),
        latest(30, "alice", "COMMENTED"),
    ];
    let events = diff(&snapshot(&before, "authored", None), &after, "authored", ME);
    assert_eq!(
        kinds(&events),
        vec![
            ev("review", "bob", "APPROVED", 1),
            ev("review", "carol", "CHANGES_REQUESTED", 1),
            ev("review", "copilot[bot]", "COMMENTED", 1)
        ],
        "your own review, drafts, dismissed and already seen reviews are left out"
    );
    assert_eq!((events[2].bot, events[2].review_id), (true, 33));
    assert_eq!(
        summary(&events),
        "bob approved · carol requested changes · copilot[bot] (bot) reviewed"
    );
}

#[test]
fn the_authors_replies_to_your_review_are_comments_not_reviews() {
    let before = pr(1, "bob");
    let mut after = before.clone();
    after.activity.reviews.push(latest(31, "bob", "COMMENTED"));
    after.activity.thread_comments.push(note(21, "bob"));
    assert_eq!(
        between(&before, &after, "reviewed"),
        vec![ev("comment", "bob", "", 1)]
    );
}

#[test]
fn comments_and_thread_replies_by_others_count_per_person() {
    let before = pr(1, "me");
    let mut after = before.clone();
    after.activity.comments.extend([
        note(11, "bob"),
        note(12, "ci[bot]"),
        note(13, "me"),
        note(14, "bob"),
    ]);
    after
        .activity
        .thread_comments
        .extend([note(21, "carol"), note(22, "me")]);
    assert_eq!(
        between(&before, &after, "authored"),
        vec![ev("comment", "bob", "", 2), ev("comment", "carol", "", 1)],
        "bots' conversation comments and your own are left out"
    );
    // The inline comments of a new review are part of that review.
    after
        .activity
        .reviews
        .push(latest(31, "carol", "COMMENTED"));
    assert_eq!(
        between(&before, &after, "authored"),
        vec![
            ev("review", "carol", "COMMENTED", 1),
            ev("comment", "bob", "", 2)
        ]
    );
}

#[test]
fn a_new_request_for_your_review_counts() {
    let mut before = pr(1, "bob");
    before.review_requested_at = Some("2026-10-01T10:00:00Z".into());
    let mut after = before.clone();
    assert!(between(&before, &after, "requested").is_empty());
    after.review_requested_at = Some("2026-10-02T10:00:00Z".into());
    assert_eq!(
        between(&before, &after, "requested"),
        vec![ev("review_requested", "", "", 1)]
    );
    assert!(
        between(&before, &after, "reviewed").is_empty(),
        "a request for someone else's review in a team you are not asked as"
    );
}

#[test]
fn finished_checks_count_when_they_fail_or_pass_after_failing() {
    let mut before = pr(1, "me");
    before.checks = "PENDING".into();
    let mut after = before.clone();
    after.checks = "FAILURE".into();
    assert_eq!(
        between(&before, &after, "authored"),
        vec![ev("checks", "", "FAILURE", 1)]
    );
    assert!(
        between(&before, &after, "reviewed").is_empty(),
        "checks are news on your own PRs and linked ones"
    );
    assert_eq!(
        between(&before, &after, "linked"),
        vec![ev("checks", "", "FAILURE", 1)]
    );

    // Failed, then fixed: missing the run in between does not matter.
    let failed = snapshot(&after, "authored", None);
    let mut fixed = after.clone();
    fixed.head_sha = "h2".into();
    fixed.activity.pushed_by = vec!["me".into()];
    fixed.checks = "PENDING".into();
    assert!(
        diff(&failed, &fixed, "authored", ME).is_empty(),
        "your own push is not news"
    );
    let running = snapshot(&fixed, "authored", Some(&failed));
    fixed.checks = "SUCCESS".into();
    assert_eq!(
        kinds(&diff(&running, &fixed, "authored", ME)),
        vec![ev("checks", "", "SUCCESS", 1)]
    );
    let passed = snapshot(&fixed, "authored", Some(&running));
    assert!(diff(&passed, &fixed, "authored", ME).is_empty());

    // Passing all along is not news; failing again on a new head is.
    let mut quiet = pr(1, "me");
    quiet.checks = "PENDING".into();
    let mut ok = quiet.clone();
    ok.checks = "SUCCESS".into();
    assert!(between(&quiet, &ok, "authored").is_empty());
    let mut again = after.clone();
    again.head_sha = "h3".into();
    again.activity.pushed_by = vec!["me".into()];
    assert_eq!(
        kinds(&diff(&failed, &again, "authored", ME)),
        vec![ev("checks", "", "FAILURE", 1)]
    );
}

#[test]
fn merged_closed_and_reopened_count_unless_you_did_it() {
    let before = pr(1, "me");
    for (state, actor, expected) in [("merged", "bob", "merged"), ("closed", "carol", "closed")] {
        let mut after = before.clone();
        after.state = state.into();
        after.activity.state_actor = actor.into();
        assert_eq!(
            between(&before, &after, "authored"),
            vec![ev("state", actor, expected, 1)]
        );
        after.activity.state_actor = "ME".into();
        assert!(between(&before, &after, "authored").is_empty());
    }
    let mut closed = before.clone();
    closed.state = "closed".into();
    let mut reopened = before.clone();
    reopened.activity.state_actor = "bob".into();
    assert_eq!(
        between(&closed, &reopened, "reviewed"),
        vec![ev("state", "bob", "reopened", 1)]
    );
    let mut merged = before.clone();
    merged.state = "merged".into();
    merged.activity.state_actor = "bob".into();
    merged.checks = "FAILURE".into();
    merged.merge_state = "DIRTY".into();
    assert_eq!(
        between(&before, &merged, "authored"),
        vec![ev("state", "bob", "merged", 1)],
        "a merged PR has no checks or conflicts to report"
    );
    assert_eq!(
        summary(&diff(
            &snapshot(&before, "authored", None),
            &merged,
            "authored",
            ME
        )),
        "merged by bob"
    );
}

#[test]
fn conflicts_and_becoming_mergeable_count() {
    let before = pr(1, "me");
    let mut after = before.clone();
    after.merge_state = "DIRTY".into();
    assert_eq!(
        between(&before, &after, "authored"),
        vec![ev("mergeable", "", "conflicts", 1)]
    );
    let mut unknown = after.clone();
    unknown.merge_state = "UNKNOWN".into();
    let dirty = snapshot(&after, "authored", None);
    let still = snapshot(&unknown, "authored", Some(&dirty));
    assert_eq!(
        still.merge_state, "DIRTY",
        "GitHub still working it out tells nothing"
    );
    let mut clean = after.clone();
    clean.merge_state = "CLEAN".into();
    assert_eq!(
        kinds(&diff(&still, &clean, "authored", ME)),
        vec![ev("mergeable", "", "clean", 1)]
    );
    let mut blocked = before.clone();
    blocked.merge_state = "BLOCKED".into();
    assert_eq!(
        between(&blocked, &before, "authored"),
        vec![ev("mergeable", "", "clean", 1)],
        "an approval unblocked it"
    );
    let mut unstable = before.clone();
    unstable.merge_state = "UNSTABLE".into();
    assert!(
        between(&unstable, &before, "authored").is_empty(),
        "checks finishing is reported as checks"
    );
    assert!(
        between(&before, &after, "requested").is_empty(),
        "mergeability is news on your own PRs"
    );
}

#[test]
fn the_first_refresh_is_a_baseline_and_a_restart_reports_nothing_twice() {
    let store = MemoryStore::default();
    let a = pr(1, "me");
    let mut b = pr(2, "bob");
    b.review_requested_at = Some("2020-01-01T00:00:00Z".into());
    let (snaps, found) = detect(
        load(&store, "github.com:me"),
        &[(&a, "authored"), (&b, "requested")],
        &[],
        ME,
    );
    assert!(
        found.is_empty(),
        "everything before the first refresh is history"
    );
    save(&store, "github.com:me", &snaps).unwrap();

    let mut pushed = a.clone();
    pushed.head_sha = "h2".into();
    pushed.activity.pushed_by = vec!["bob".into()];
    let read = [(&pushed, "authored"), (&b, "requested")];
    let (snaps, found) = detect(load(&store, "github.com:me"), &read, &[], ME);
    assert_eq!(found.len(), 1);
    save(&store, "github.com:me", &snaps).unwrap();
    // The daemon restarts: the snapshot is read back and the same PRs show nothing new.
    let (_, found) = detect(load(&store, "github.com:me"), &read, &[], ME);
    assert!(found.is_empty());
    assert!(
        load(&store, "github.com:other").is_none(),
        "each account has its own baseline"
    );
    store
        .set_setting("pulls.snapshots.v1.github.com:other", "{broken")
        .unwrap();
    assert!(
        load(&store, "github.com:other").is_none(),
        "unreadable: a new baseline"
    );
}

#[test]
fn a_pr_that_arrives_is_news_only_when_your_review_was_requested_since() {
    let store = MemoryStore::default();
    let (snaps, _) = detect(None, &[], &[], ME);
    save(&store, "github.com:me", &snaps).unwrap();
    let mut asked = pr(2, "bob");
    asked.review_requested_at = Some(now().to_rfc3339());
    let mut old = pr(3, "bob");
    old.review_requested_at = Some("2020-01-01T00:00:00Z".into());
    let mine = pr(4, "me");
    let linked = pr(5, "carol");
    let read = [
        (&asked, "requested"),
        (&old, "requested"),
        (&mine, "authored"),
        (&linked, "linked"),
    ];
    let (_, found) = detect(load(&store, "github.com:me"), &read, &[], ME);
    assert_eq!(
        found
            .iter()
            .map(|c| (c.pull_id.as_str(), c.summary.as_str()))
            .collect::<Vec<_>>(),
        vec![("o/r#2", "your review was requested")]
    );
}

#[test]
fn a_pr_that_leaves_the_lists_is_read_once_more_to_see_it_merged() {
    let a = pr(1, "me");
    let (snaps, _) = detect(None, &[(&a, "authored")], &[], ME);
    let listed: Vec<(String, u32)> = vec![];
    let leaving = leavers(&snaps, &listed);
    assert_eq!(leaving, vec![("o/r".to_string(), 1)]);
    let mut merged = a.clone();
    merged.state = "merged".into();
    merged.activity.state_actor = "bob".into();
    let (snaps, found) = detect(Some(snaps), &[(&merged, "")], &leaving, ME);
    assert_eq!(found.len(), 1);
    assert_eq!(
        (found[0].role.as_str(), found[0].summary.as_str()),
        ("authored", "merged by bob"),
        "it keeps the reason it was followed for"
    );
    assert!(
        leavers(&snaps, &listed).is_empty(),
        "read once, not every refresh"
    );
    // GitHub could not read it: it is not tried again either.
    let (snaps, _) = detect(None, &[(&a, "authored")], &[], ME);
    let leaving = leavers(&snaps, &listed);
    let (snaps, _) = detect(Some(snaps), &[], &leaving, ME);
    assert!(leavers(&snaps, &listed).is_empty());
}

#[test]
fn a_burst_in_one_refresh_is_one_entry_and_later_ones_join_it_until_read() {
    let store = MemoryStore::default();
    let before = pr(1, "me");
    let mut after = before.clone();
    after.head_sha = "h2".into();
    after.activity.pushed_by = vec!["bob".into()];
    after.activity.commits = 2;
    after
        .activity
        .comments
        .extend([note(11, "carol"), note(12, "carol"), note(13, "dave")]);
    let (snaps, _) = detect(None, &[(&before, "authored")], &[], ME);
    let (snaps, found) = detect(Some(snaps), &[(&after, "authored")], &[], ME);
    assert_eq!(found.len(), 1, "one entry per PR");
    assert_eq!(
        found[0].summary,
        "bob pushed 1 commit · carol left 2 comments · dave commented"
    );
    let news = record(&store, "github.com:me", found).unwrap();
    let list = entries(&store, "github.com:me").unwrap();
    assert_eq!((list.len(), news[0].id.clone()), (1, list[0].id.clone()));

    let mut later = after.clone();
    later.activity.comments.push(note(14, "carol"));
    later.activity.reviews.push(latest(31, "dave", "APPROVED"));
    let (snaps, found) = detect(Some(snaps), &[(&later, "authored")], &[], ME);
    let news = record(&store, "github.com:me", found).unwrap();
    assert_eq!(
        news[0].summary, "dave approved · carol commented",
        "the user hears only what is new"
    );
    let list = entries(&store, "github.com:me").unwrap();
    assert_eq!(list.len(), 1, "joins the unread entry");
    assert_eq!(
        list[0].summary,
        "bob pushed 1 commit · carol left 3 comments · dave commented · dave approved"
    );

    assert!(mark_read(&store, "github.com:me", Some(&[list[0].id.clone()])).unwrap());
    assert!(
        !mark_read(&store, "github.com:me", None).unwrap(),
        "nothing left unread"
    );
    let mut again = later.clone();
    again.activity.comments.push(note(15, "erin"));
    let (_, found) = detect(Some(snaps), &[(&again, "authored")], &[], ME);
    record(&store, "github.com:me", found).unwrap();
    let list = entries(&store, "github.com:me").unwrap();
    assert_eq!(
        list.iter()
            .map(|e| (e.summary.as_str(), e.read))
            .collect::<Vec<_>>(),
        vec![
            ("erin commented", false),
            (
                "bob pushed 1 commit · carol left 3 comments · dave commented · dave approved",
                true
            )
        ]
    );
}

#[test]
fn entries_from_an_older_or_newer_daemon_still_read() {
    let store = MemoryStore::default();
    store
        .save_feature_record(
            "pull-changes:github.com:me",
            "x",
            r#"{"id":"x","future":1}"#,
        )
        .unwrap();
    store
        .save_feature_record("pull-changes:github.com:me", "y", "not json")
        .unwrap();
    let list = entries(&store, "github.com:me").unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, "x");
    let snaps: Snapshots = serde_json::from_str(r#"{"pulls":{"o/r#1":{"state":"open"}}}"#).unwrap();
    assert_eq!(snaps.pulls["o/r#1"].state, "open");
}
