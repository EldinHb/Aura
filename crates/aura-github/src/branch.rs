//! The pull request opened from a branch, with its check and review state.
use crate::{reviews_by_others, s, validate_repo, Github};
use anyhow::{bail, Context, Result};
use aura_core::BranchPull;
use serde_json::{json, Value};

const QUERY: &str = concat!(
    r#"query($owner:String!,$name:String!,$head:String!){repository(owner:$owner,name:$name){pullRequests(headRefName:$head,first:20,orderBy:{field:CREATED_AT,direction:DESC}){nodes{number title url state isDraft reviewDecision headRefOid author{login} headRepository{nameWithOwner} commits(last:1){nodes{commit{statusCheckRollup{state}}}} "#,
    reviews_query!(),
    "}}}}"
);

/// The pull request into `repo` from `branch` of `head_repo`: the open one, or
/// else the most recently created. None when the branch has no pull request.
pub async fn branch_pull(
    gh: &dyn Github,
    repo: &str,
    head_repo: &str,
    branch: &str,
) -> Result<Option<BranchPull>> {
    validate_repo(repo)?;
    validate_repo(head_repo)?;
    if branch.is_empty() {
        bail!("branch is required");
    }
    let (owner, name) = repo.split_once('/').context("Invalid repository")?;
    let data = gh.request("POST", "graphql", Some(json!({"query": QUERY, "variables": {"owner": owner, "name": name, "head": branch}}))).await?;
    if data.get("errors").is_some() {
        bail!("Pull requests unavailable: {}", data["errors"]);
    }
    let nodes = data["data"]["repository"]["pullRequests"]["nodes"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    // Another fork can have a branch with the same name.
    let from_head: Vec<&Value> = nodes
        .iter()
        .filter(|n| {
            n["headRepository"]["nameWithOwner"]
                .as_str()
                .is_some_and(|r| r.eq_ignore_ascii_case(head_repo))
        })
        .collect();
    let node = from_head
        .iter()
        .find(|n| n["state"] == "OPEN")
        .or(from_head.first());
    Ok(node.and_then(|n| pull(repo, n)))
}

fn pull(repo: &str, node: &Value) -> Option<BranchPull> {
    Some(BranchPull {
        repo: repo.to_string(),
        number: u32::try_from(node["number"].as_u64()?).ok()?,
        title: s(node, "title"),
        url: s(node, "url"),
        state: s(node, "state").to_lowercase(),
        draft: node["isDraft"].as_bool().unwrap_or(false),
        checks: s(
            &node["commits"]["nodes"][0]["commit"]["statusCheckRollup"],
            "state",
        ),
        review_decision: s(node, "reviewDecision"),
        head_sha: s(node, "headRefOid"),
        reviews: reviews_by_others(node, &[&s(&node["author"], "login")]),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;

    struct Fake {
        response: Value,
        bodies: Mutex<Vec<Value>>,
    }
    #[async_trait]
    impl Github for Fake {
        fn host(&self) -> &str {
            "github.com"
        }
        async fn diff(&self, _: &str, _: &str, _: &str) -> Result<String> {
            unreachable!()
        }
        async fn request(&self, _: &str, _: &str, body: Option<Value>) -> Result<Value> {
            self.bodies.lock().unwrap().push(body.unwrap_or_default());
            Ok(self.response.clone())
        }
    }
    fn node(number: u32, state: &str, head_repo: &str) -> Value {
        json!({"number": number, "title": format!("PR {number}"), "url": format!("https://github.com/owner/repo/pull/{number}"),
            "state": state, "isDraft": false, "reviewDecision": "APPROVED", "headRefOid": "abc",
            "author": {"login": "me"}, "headRepository": {"nameWithOwner": head_repo},
            "commits": {"nodes": [{"commit": {"statusCheckRollup": {"state": "SUCCESS"}}}]}})
    }
    fn fake(nodes: Vec<Value>) -> Fake {
        Fake {
            response: json!({"data": {"repository": {"pullRequests": {"nodes": nodes}}}}),
            bodies: Mutex::new(vec![]),
        }
    }

    #[tokio::test]
    async fn prefers_the_open_pull_request_of_the_branch() {
        let gh = fake(vec![
            node(3, "MERGED", "owner/repo"),
            node(2, "OPEN", "owner/repo"),
            node(1, "CLOSED", "owner/repo"),
        ]);
        let pull = branch_pull(&gh, "owner/repo", "owner/repo", "feature")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            (
                pull.number,
                pull.state.as_str(),
                pull.checks.as_str(),
                pull.review_decision.as_str()
            ),
            (2, "open", "SUCCESS", "APPROVED")
        );
        let body = &gh.bodies.lock().unwrap()[0];
        assert_eq!(
            body["variables"],
            json!({"owner": "owner", "name": "repo", "head": "feature"})
        );
    }

    #[tokio::test]
    async fn reports_comment_only_reviews_by_others() {
        let mut open = node(2, "OPEN", "owner/repo");
        open["reviewDecision"] = json!("REVIEW_REQUIRED");
        open["latestReviews"] = json!({"nodes": [
            {"state": "COMMENTED", "submittedAt": "2026-10-05T10:00:00Z", "author": {"__typename": "User", "login": "alice"}, "commit": {"oid": "abc"}},
            {"state": "COMMENTED", "submittedAt": "2026-10-05T11:00:00Z", "author": {"__typename": "User", "login": "me"}, "commit": {"oid": "abc"}},
        ]});
        let pull = branch_pull(&fake(vec![open]), "owner/repo", "owner/repo", "feature")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            pull.reviews
                .iter()
                .map(|r| (r.reviewer.as_str(), r.state.as_str()))
                .collect::<Vec<_>>(),
            vec![("alice", "COMMENTED")]
        );
    }

    #[tokio::test]
    async fn falls_back_to_the_latest_merged_or_closed_pull_request() {
        let gh = fake(vec![
            node(3, "MERGED", "owner/repo"),
            node(1, "CLOSED", "owner/repo"),
        ]);
        let pull = branch_pull(&gh, "owner/repo", "owner/repo", "feature")
            .await
            .unwrap()
            .unwrap();
        assert_eq!((pull.number, pull.state.as_str()), (3, "merged"));
    }

    #[tokio::test]
    async fn ignores_branches_with_the_same_name_in_other_forks() {
        let gh = fake(vec![
            node(5, "OPEN", "someone/repo"),
            node(4, "OPEN", "Me/Repo"),
        ]);
        assert_eq!(
            branch_pull(&gh, "owner/repo", "me/repo", "main")
                .await
                .unwrap()
                .map(|p| p.number),
            Some(4)
        );
        let gh = fake(vec![node(5, "OPEN", "someone/repo")]);
        assert_eq!(
            branch_pull(&gh, "owner/repo", "me/repo", "main")
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn rejects_unsafe_repositories() {
        let gh = fake(vec![]);
        assert!(branch_pull(&gh, "owner/../repo", "owner/repo", "feature")
            .await
            .is_err());
        assert!(branch_pull(&gh, "owner/repo", "owner/repo", "")
            .await
            .is_err());
    }
}
