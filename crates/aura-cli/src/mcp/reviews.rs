//! An orchestrator's tools for Aura's pull request reviews: they read the user's
//! review inbox and record, change and discard pre-review drafts, which the user
//! then sees in Aura as if Aura's own pre-review had written them. Each calls the
//! daemon's `orchestrator.reviews.*`, which shares its code with the review editor.
//! Posting a review to GitHub stays the user's: no tool here does it.

use anyhow::Result;
use aura_core::{PreReview, PullRequest, ReviewInbox};
use serde_json::{json, Value};

/// Tool names, in the order `tools/list` shows them.
pub const NAMES: &[&str] = &[
    "list_pull_requests",
    "read_pull_review",
    "create_review",
    "update_review",
    "add_review_comment",
    "edit_review_comment",
    "delete_review_comment",
    "discard_review",
    "start_pre_review",
    "hide_pull_request",
];

/// The daemon method a tool calls, and its parameters: the tool's own
/// arguments, as given, for the orchestrator `o`.
pub fn request(tool: &str, o: &str, a: &Value) -> Option<(&'static str, Value)> {
    let method = match tool {
        "list_pull_requests" => "orchestrator.reviews.list",
        "read_pull_review" => "orchestrator.reviews.get",
        "create_review" => "orchestrator.reviews.create",
        "update_review" => "orchestrator.reviews.update",
        "add_review_comment" => "orchestrator.reviews.add_comment",
        "edit_review_comment" => "orchestrator.reviews.edit_comment",
        "delete_review_comment" => "orchestrator.reviews.delete_comment",
        "discard_review" => "orchestrator.reviews.discard",
        "start_pre_review" => "orchestrator.reviews.start",
        "hide_pull_request" => "orchestrator.reviews.hide",
        _ => return None,
    };
    let mut p = match a {
        Value::Object(m) => Value::Object(m.clone()),
        _ => json!({}),
    };
    p["orchestrator"] = json!(o);
    Some((method, p))
}

/// What the tool says back, from the daemon's reply.
pub fn reply(tool: &str, a: &Value, v: Value) -> Result<String> {
    let diff = a.get("include_diff").and_then(Value::as_bool) == Some(true);
    Ok(match tool {
        "list_pull_requests" => describe_inbox(
            &serde_json::from_value(v)?,
            a.get("include_hidden").and_then(Value::as_bool) == Some(true),
        ),
        "read_pull_review" if v.get("pull").is_some() && v.get("config").is_none() => {
            let pull: PullRequest = serde_json::from_value(v["pull"].clone())?;
            let reviews: Vec<PreReview> = serde_json::from_value(v["reviews"].clone())?;
            let mut out = format!("{}\n", pull_line(&pull));
            if reviews.is_empty() {
                out.push_str("\nNo pre-reviews of it yet. Record one with create_review.");
            } else {
                out.push_str(
                    "\nPre-reviews, latest first (read one with `review` for its findings and diff):\n",
                );
                for r in &reviews {
                    out.push_str(&format!(
                        "- `{}` {} · {} · {} findings · {}\n",
                        r.id,
                        r.status,
                        r.result.verdict,
                        r.result.comments.iter().filter(|c| !c.deleted).count(),
                        r.created_at
                    ));
                }
            }
            out
        }
        "read_pull_review" => describe_review(&serde_json::from_value(v)?, diff),
        "create_review" => {
            let r: PreReview = serde_json::from_value(v)?;
            format!(
                "Recorded pre-review `{}`.\n\n{}",
                r.id,
                describe_review(&r, false)
            )
        }
        "add_review_comment" => {
            let r: PreReview = serde_json::from_value(v["review"].clone())?;
            format!(
                "Added finding `{}`.\n\n{}",
                v["comment"].as_str().unwrap_or_default(),
                describe_review(&r, false)
            )
        }
        "update_review" | "edit_review_comment" | "delete_review_comment" => {
            describe_review(&serde_json::from_value(v)?, false)
        }
        "discard_review" => {
            let r: PreReview = serde_json::from_value(v)?;
            format!(
                "Discarded pre-review `{}` of {}; nothing was posted to GitHub.",
                r.id, r.pull.id
            )
        }
        "start_pre_review" => {
            let r: PreReview = serde_json::from_value(v)?;
            format!(
                "Aura's own pre-review `{}` of {} is {} with {}. It runs on its own; read_pull_review shows when it is ready.",
                r.id,
                r.pull.id,
                r.status,
                r.agent
                    .as_ref()
                    .map(|a| a.signature())
                    .unwrap_or_else(|| r.config.provider.clone())
            )
        }
        "hide_pull_request" => {
            let hidden = a.get("hidden").and_then(Value::as_bool) != Some(false);
            if hidden {
                "Hidden from the user's pull request list; they can show hidden PRs to see it again.".into()
            } else {
                "Restored to the user's pull request list.".into()
            }
        }
        _ => v.to_string(),
    })
}

/// What a draft's status means to the user and to the orchestrator.
fn status_meaning(status: &str) -> &'static str {
    match status {
        "ready" => "ready for the user: it shows in Aura's pull request list and they can edit it and post it to GitHub",
        "drafting" => "being written: the user sees it but cannot edit it until you set `ready`",
        "queued" | "running" => "Aura's own pre-review is running",
        "submitted" => "the user posted it to GitHub",
        "submitting" | "uncertain" => "the user is posting it to GitHub",
        "failed" => "Aura's pre-review failed",
        "cancelled" => "cancelled",
        "discarded" => "discarded",
        _ => "unknown",
    }
}

/// One line about a PR: who, where it stands, and why the user has it.
fn pull_line(p: &PullRequest) -> String {
    let mut facts = vec![format!("by {}", p.author)];
    if p.draft {
        facts.push("draft".into());
    }
    if p.state != "open" {
        facts.push(p.state.clone());
    }
    if !p.checks.is_empty() {
        facts.push(format!("checks {}", p.checks.to_lowercase()));
    }
    if !p.review_decision.is_empty() {
        facts.push(p.review_decision.to_lowercase().replace('_', " "));
    }
    if let Some(r) = &p.my_review {
        facts.push(format!(
            "the user {}",
            r.state.to_lowercase().replace('_', " ")
        ));
    }
    if p.hidden {
        facts.push("hidden".into());
    }
    format!("{} \"{}\" ({})", p.id, p.title, facts.join(", "))
}

pub fn describe_inbox(inbox: &ReviewInbox, include_hidden: bool) -> String {
    let Some(account) = &inbox.account else {
        return format!(
            "Aura has no GitHub login yet{}. The user signs in with `gh auth login`.",
            inbox
                .error
                .as_deref()
                .map(|e| format!(" ({e})"))
                .unwrap_or_default()
        );
    };
    let mut out = format!("The user's pull requests on GitHub as {account}");
    if let Some(at) = &inbox.last_synced {
        out.push_str(&format!(", read {at}"));
    }
    out.push_str(".\n");
    if let Some(why) = inbox.blocked.as_deref().or(inbox.error.as_deref()) {
        out.push_str(&format!("Note: {why}\n"));
    }
    let mut listed: Vec<&str> = vec![];
    for (title, pulls) in [
        ("Needs the user's review", &inbox.pulls),
        ("The user reviewed", &inbox.reviewed),
        ("The user's own", &inbox.mine),
    ] {
        let shown: Vec<&PullRequest> = pulls
            .iter()
            .filter(|p| include_hidden || !p.hidden)
            .collect();
        out.push_str(&format!("\n{title} ({}):\n", shown.len()));
        if shown.is_empty() {
            out.push_str("- none\n");
        }
        for p in shown {
            listed.push(&p.id);
            out.push_str(&format!("- {}", pull_line(p)));
            if let Some(r) = latest(inbox, &p.id) {
                out.push_str(&format!(" · pre-review `{}` {}", r.id, r.status));
            }
            out.push('\n');
        }
    }
    let others: Vec<&PreReview> = inbox
        .reviews
        .iter()
        .filter(|r| r.status != "discarded" && !listed.contains(&r.pull.id.as_str()))
        .collect();
    if !others.is_empty() {
        out.push_str("\nPre-reviews of PRs not on these lists:\n");
        for r in others {
            out.push_str(&format!(
                "- `{}` {} of {} \"{}\"\n",
                r.id, r.status, r.pull.id, r.pull.title
            ));
        }
    }
    out
}

/// The latest pre-review of a PR the user has not discarded, as the app shows it.
fn latest<'a>(inbox: &'a ReviewInbox, pull: &str) -> Option<&'a PreReview> {
    inbox
        .reviews
        .iter()
        .find(|r| r.pull.id == pull && r.status != "discarded")
}

/// Diffs longer than this are cut short in read_pull_review.
const DIFF_LIMIT: usize = 60_000;

pub fn describe_review(r: &PreReview, include_diff: bool) -> String {
    let mut out = format!(
        "Pre-review `{}` of {} \"{}\" at revision {}: {} ({}).\n",
        r.id,
        r.pull.id,
        r.pull.title,
        r.revision,
        r.status,
        status_meaning(&r.status)
    );
    if let Some(a) = &r.agent {
        out.push_str(&format!("Signed: {}\n", a.signature()));
    }
    if let Some(s) = &r.source {
        out.push_str(&format!(
            "Recorded by the orchestrator {} (`{}`){}\n",
            s.orchestrator_title,
            s.orchestrator,
            match (&s.worker_title, &s.worker) {
                (Some(t), Some(id)) => format!(", from the review by its worker {t} (`{id}`)"),
                _ => String::new(),
            }
        ));
    }
    if !r.reviewed_sha.is_empty() {
        out.push_str(&format!("Reviewed commit: {}", short(&r.reviewed_sha)));
        if r.reviewed_sha != r.pull.head_sha {
            out.push_str(&format!(
                " (the PR was at {} when Aura last read it)",
                short(&r.pull.head_sha)
            ));
        }
        out.push('\n');
    }
    if let Some(e) = &r.error {
        out.push_str(&format!("Error: {e}\n"));
    }
    if let Some(url) = &r.submitted_url {
        out.push_str(&format!("Posted: {url}\n"));
    }
    let res = &r.result;
    out.push_str(&format!("Verdict: {} · risk {}", res.verdict, res.risk));
    if let Some(c) = res.confidence {
        out.push_str(&format!(" · confidence {:.0}%", c * 100.0));
    }
    out.push_str("\n\nSummary:\n");
    out.push_str(if res.summary.trim().is_empty() {
        "(none)"
    } else {
        res.summary.trim()
    });
    out.push_str(&format!("\n\nFindings ({}):\n", res.comments.len()));
    if res.comments.is_empty() {
        out.push_str("- none\n");
    }
    for c in &res.comments {
        let lines = match c.start_line {
            Some(s) => format!("{s}-{}", c.line),
            None => c.line.to_string(),
        };
        let mut tags = vec![c.severity.clone()];
        if c.user_authored {
            tags.push("the user's".into());
        } else if c.edited {
            tags.push("edited by the user".into());
        }
        if c.deleted {
            tags.push("deleted".into());
        }
        out.push_str(&format!(
            "- `{}` {}:{} {} [{}]: {}\n",
            c.id,
            c.path,
            lines,
            c.side,
            tags.join(", "),
            c.body.trim()
        ));
        if let Some(note) = &c.position_note {
            out.push_str(&format!("  {note}\n"));
        }
        if let Some(why) = &c.rationale {
            out.push_str(&format!("  Rationale (never posted): {}\n", why.trim()));
        }
    }
    if include_diff && !r.diff.is_empty() {
        let cut = r
            .diff
            .char_indices()
            .nth(DIFF_LIMIT)
            .map_or(r.diff.len(), |(i, _)| i);
        out.push_str(&format!(
            "\nReviewed diff:\n```diff\n{}\n```\n",
            &r.diff[..cut]
        ));
        if cut < r.diff.len() {
            out.push_str(&format!("(cut short after {DIFF_LIMIT} characters)\n"));
        }
    }
    if matches!(r.status.as_str(), "ready" | "drafting") {
        out.push_str("\nPosting it to GitHub is the user's: they review and submit it in Aura.");
    }
    out
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(10)]
}

fn pull_arg() -> Value {
    json!({ "type": "string", "description": "The pull request as `owner/repo#number`, e.g. `wortell/vidara.portal#2730`, or its GitHub URL." })
}
fn review_arg() -> Value {
    json!({ "type": "string", "description": "The pre-review's id, from list_pull_requests, read_pull_review or create_review." })
}
fn revision_arg() -> Value {
    json!({ "type": "integer", "minimum": 0, "description": "The revision you last read. When given, the change is refused if the draft changed since, for example because the user edited it." })
}
fn finding_props() -> Value {
    json!({
        "path": { "type": "string", "description": "Repository-relative file path." },
        "line": { "type": "integer", "minimum": 1, "description": "The line in the diff: in the new file for RIGHT, in the old file for LEFT." },
        "start_line": { "type": ["integer", "null"], "minimum": 1, "description": "First line of a multi-line finding; null for one line." },
        "side": { "type": "string", "enum": ["RIGHT", "LEFT"], "description": "RIGHT (default) for added or unchanged lines, LEFT for deleted ones." },
        "severity": { "type": "string", "enum": ["blocker", "major", "minor", "nit", "praise"], "description": "Default minor." },
        "body": { "type": "string", "description": "The comment as it would be posted. Markdown." },
        "rationale": { "type": "string", "description": "Private reasoning the user sees but that is never posted." },
    })
}
/// A finding's properties, and `extra` ones.
fn finding_with(extra: &[(&str, Value)]) -> Value {
    let mut props = finding_props();
    for (key, value) in extra {
        props[*key] = value.clone();
    }
    props
}
fn findings_arg(what: &str) -> Value {
    json!({
        "type": "array",
        "description": what,
        "items": { "type": "object", "properties": finding_props(), "required": ["path", "line", "body"] },
    })
}

/// The tools' definitions for `tools/list`.
pub fn tools() -> Vec<Value> {
    vec![
        json!({
            "name": "list_pull_requests",
            "description": "List the user's pull requests as Aura's pull request list shows them: the ones that need the user's review, the ones they reviewed, and their own, each with the state of its latest pre-review. A pre-review is a review draft in Aura that the user edits and posts to GitHub.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "refresh": { "type": "boolean", "description": "Read GitHub again first, as the user's refresh button does. Default false: Aura's last read, at most a few minutes old." },
                    "include_hidden": { "type": "boolean", "description": "Include PRs the user hid. Default false." },
                },
            },
            "annotations": { "readOnlyHint": true },
        }),
        json!({
            "name": "read_pull_review",
            "description": "Read a pre-review: its status, revision, verdict, summary and findings with their ids, whether each finding falls inside the reviewed diff, and optionally the diff itself. Or give `pull` to see a PR and the ids of its pre-reviews.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "review": review_arg(),
                    "pull": pull_arg(),
                    "include_diff": { "type": "boolean", "description": "With `review`: include the reviewed diff, to place findings on its lines. Default false." },
                },
            },
            "annotations": { "readOnlyHint": true },
        }),
        json!({
            "name": "create_review",
            "description": "Record a review of a pull request, usually one a worker did, as a pre-review in Aura: it shows in the user's pull request list as ready, signed with the agent that did it, and the user edits and posts it to GitHub as they do Aura's own pre-reviews. You cannot post it. Findings must be on lines of the PR's diff to post inline; others go in the review body. Give everything at once, or set `ready` false while you add findings and true when done.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pull": pull_arg(),
                    "verdict": { "type": "string", "enum": ["approve", "comment", "request_changes"] },
                    "summary": { "type": "string", "description": "The review body: what the PR does and the overall judgement. Markdown." },
                    "risk": { "type": "string", "enum": ["low", "medium", "high"], "description": "Default medium." },
                    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
                    "comments": findings_arg("Inline findings."),
                    "worker": { "type": "string", "description": "The worker session that did the review (id, unique prefix or title); the review is signed with its agent, model and effort. Default: you." },
                    "agent": {
                        "type": "object",
                        "description": "Sign the review with this agent instead of the worker's or yours.",
                        "properties": {
                            "provider": { "type": "string", "description": "e.g. `Codex`, `Claude Code`." },
                            "model": { "type": "string" },
                            "model_id": { "type": "string", "description": "The exact model id, when known." },
                            "effort": { "type": "string" },
                        },
                        "required": ["provider"],
                    },
                    "commit": { "type": "string", "description": "The commit that was reviewed, when not the PR's current head." },
                    "ready": { "type": "boolean", "description": "Default true: ready for the user now. False keeps it as being written, which the user sees but cannot edit, until update_review sets ready." },
                },
                "required": ["pull", "verdict"],
            },
        }),
        json!({
            "name": "update_review",
            "description": "Change a pre-review that is ready or being written: summary, verdict, risk or confidence, replace your findings, or set it ready for the user. Findings the user wrote or edited are never changed or removed.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "review": review_arg(),
                    "revision": revision_arg(),
                    "summary": { "type": "string" },
                    "verdict": { "type": "string", "enum": ["approve", "comment", "request_changes"] },
                    "risk": { "type": "string", "enum": ["low", "medium", "high"] },
                    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
                    "comments": findings_arg("Replaces every finding that is not the user's."),
                    "ready": { "type": "boolean", "description": "True hands a draft being written to the user. A ready draft cannot go back." },
                },
                "required": ["review"],
            },
        }),
        json!({
            "name": "add_review_comment",
            "description": "Add an inline finding to a pre-review that is ready or being written.",
            "inputSchema": {
                "type": "object",
                "properties": finding_with(&[("review", review_arg()), ("revision", revision_arg())]),
                "required": ["review", "path", "line", "body"],
            },
        }),
        json!({
            "name": "edit_review_comment",
            "description": "Change a finding of a pre-review: its text, severity, line, side or file. Only the given fields change. Findings the user wrote or edited are theirs and cannot be changed.",
            "inputSchema": {
                "type": "object",
                "properties": finding_with(&[
                    ("review", review_arg()),
                    ("comment", json!({ "type": "string", "description": "The finding's id, from read_pull_review." })),
                    ("revision", revision_arg()),
                ]),
                "required": ["review", "comment"],
            },
        }),
        json!({
            "name": "delete_review_comment",
            "description": "Delete a finding from a pre-review, as the user's Delete button does: it is struck through and never posted, and `restore` brings it back. Findings the user wrote or edited cannot be deleted.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "review": review_arg(),
                    "comment": { "type": "string", "description": "The finding's id, from read_pull_review." },
                    "restore": { "type": "boolean", "description": "Bring a deleted finding back. Default false." },
                    "revision": revision_arg(),
                },
                "required": ["review", "comment"],
            },
        }),
        json!({
            "name": "discard_review",
            "description": "Discard a pre-review, as the user's Discard button does, or cancel one of Aura's own that is still running. Nothing is posted to GitHub. A review the user posted cannot be discarded.",
            "inputSchema": { "type": "object", "properties": { "review": review_arg() }, "required": ["review"] },
            "annotations": { "destructiveHint": true },
        }),
        json!({
            "name": "start_pre_review",
            "description": "Start Aura's own pre-review of a PR, as the user's Pre-review button does: Aura checks the PR out and has Claude Code or Codex review it read-only, then the draft is ready for the user. Use it instead of a worker when Aura's built-in review is enough.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pull": pull_arg(),
                    "agent": { "type": "string", "enum": ["codex", "claude"], "description": "Default: the user's last choice." },
                    "model": { "type": "string", "description": "Model id from list_agents. Default: the agent's default." },
                    "effort": { "type": "string", "description": "Reasoning effort from list_agents." },
                    "instructions": { "type": "string", "description": "What to look at, added to Aura's review instructions." },
                },
                "required": ["pull"],
            },
        }),
        json!({
            "name": "hide_pull_request",
            "description": "Hide a PR from the user's pull request list, as the × on it does, or restore it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pull": pull_arg(),
                    "hidden": { "type": "boolean", "description": "Default true; false restores it." },
                },
                "required": ["pull"],
            },
        }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use aura_core::{ReviewAgent, ReviewComment, ReviewResult, ReviewSource};

    fn review() -> PreReview {
        PreReview {
            id: "r1".into(),
            pull: PullRequest {
                id: "wortell/vidara.portal#2730".into(),
                title: "Signals".into(),
                head_sha: "b".repeat(40),
                ..Default::default()
            },
            config: Default::default(),
            instructions: String::new(),
            status: "ready".into(),
            phase: "done".into(),
            error: None,
            created_at: String::new(),
            updated_at: String::new(),
            revision: 3,
            reviewed_sha: "a".repeat(40),
            merge_base: String::new(),
            context_mode: "recorded".into(),
            context_note: None,
            diff: "diff --git a/x b/x\n".into(),
            log_tail: vec![],
            result: ReviewResult {
                summary: "Fine.".into(),
                verdict: "approve".into(),
                risk: "low".into(),
                confidence: Some(0.9),
                comments: vec![
                    ReviewComment {
                        id: "c1".into(),
                        path: "Tests.cs".into(),
                        line: 56,
                        side: "RIGHT".into(),
                        severity: "nit".into(),
                        body: "Rename".into(),
                        valid: true,
                        ..Default::default()
                    },
                    ReviewComment {
                        id: "c2".into(),
                        path: "Other.cs".into(),
                        line: 2,
                        start_line: Some(1),
                        side: "LEFT".into(),
                        severity: "minor".into(),
                        body: "Mine".into(),
                        user_authored: true,
                        deleted: true,
                        position_note: Some(
                            "Outside the reviewed diff; included in the review body.".into(),
                        ),
                        ..Default::default()
                    },
                ],
            },
            submitted_url: None,
            submission: None,
            agent: Some(ReviewAgent {
                provider: "Codex".into(),
                model: Some("gpt-5.5".into()),
                model_id: None,
                effort: Some("high".into()),
            }),
            source: Some(ReviewSource {
                orchestrator: "o1".into(),
                orchestrator_title: "Lead".into(),
                worker: Some("w1".into()),
                worker_title: Some("Review 2730".into()),
            }),
        }
    }

    #[test]
    fn every_tool_calls_its_own_method_for_this_orchestrator_with_its_arguments() {
        let all = tools();
        let names: Vec<&str> = all.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, NAMES);
        let mut methods = vec![];
        for name in NAMES {
            let (method, p) = request(
                name,
                "o1",
                &json!({"pull":"o/r#1","orchestrator":"someone else"}),
            )
            .unwrap();
            assert!(method.starts_with("orchestrator.reviews."));
            assert_eq!(p, json!({"pull":"o/r#1","orchestrator":"o1"}), "{name}");
            methods.push(method);
        }
        methods.dedup();
        assert_eq!(methods.len(), NAMES.len());
        assert!(request("submit_review", "o1", &json!({})).is_none());
        for t in tools() {
            assert!(
                !t["description"]
                    .as_str()
                    .unwrap()
                    .to_lowercase()
                    .contains("submits"),
                "no tool posts to GitHub"
            );
            for key in t["inputSchema"]["required"]
                .as_array()
                .into_iter()
                .flatten()
            {
                assert!(
                    t["inputSchema"]["properties"]
                        .get(key.as_str().unwrap())
                        .is_some(),
                    "{} requires {key} it does not describe",
                    t["name"]
                );
            }
        }
    }

    #[test]
    fn a_review_reads_with_its_ids_state_and_who_did_it() {
        let text = describe_review(&review(), true);
        for want in [
            "Pre-review `r1` of wortell/vidara.portal#2730 \"Signals\" at revision 3: ready (ready for the user",
            "Signed: Codex · model gpt-5.5 · effort high",
            "Recorded by the orchestrator Lead (`o1`), from the review by its worker Review 2730 (`w1`)",
            "Reviewed commit: aaaaaaaaaa (the PR was at bbbbbbbbbb when Aura last read it)",
            "Verdict: approve · risk low · confidence 90%",
            "- `c1` Tests.cs:56 RIGHT [nit]: Rename",
            "- `c2` Other.cs:1-2 LEFT [minor, the user's, deleted]: Mine",
            "  Outside the reviewed diff",
            "```diff\ndiff --git a/x b/x",
            "Posting it to GitHub is the user's",
        ] {
            assert!(text.contains(want), "missing {want:?} in\n{text}");
        }
        assert!(!describe_review(&review(), false).contains("```diff"));
    }

    #[test]
    fn the_inbox_reads_as_the_users_list_with_each_prs_latest_pre_review() {
        let pull = |n: u32, hidden: bool| PullRequest {
            id: format!("o/r#{n}"),
            title: format!("PR {n}"),
            author: "bob".into(),
            state: "open".into(),
            checks: "SUCCESS".into(),
            hidden,
            ..Default::default()
        };
        let mut r = review();
        r.pull = pull(1, false);
        let mut elsewhere = review();
        elsewhere.id = "r2".into();
        let inbox = ReviewInbox {
            account: Some("github.com:alice".into()),
            pulls: vec![pull(1, false), pull(2, true)],
            reviews: vec![r, elsewhere],
            ..Default::default()
        };
        let text = describe_inbox(&inbox, false);
        assert!(text.contains("Needs the user's review (1):\n- o/r#1 \"PR 1\" (by bob, checks success) · pre-review `r1` ready"), "{text}");
        assert!(!text.contains("o/r#2"));
        assert!(text.contains(
            "Pre-reviews of PRs not on these lists:\n- `r2` ready of wortell/vidara.portal#2730"
        ));
        assert!(describe_inbox(&inbox, true)
            .contains("o/r#2 \"PR 2\" (by bob, checks success, hidden)"));
        assert!(describe_inbox(&ReviewInbox::default(), false).contains("gh auth login"));
    }
}
