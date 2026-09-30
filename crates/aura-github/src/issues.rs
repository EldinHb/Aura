//! Open issues of a repository, marked with the project iteration (sprint)
//! each one is in today.
use crate::{validate_repo, Github};
use anyhow::{bail, Context, Result};
use aura_core::RepoIssue;
use chrono::{Days, NaiveDate};
use serde_json::{json, Value};

/// Pages of 100 most recently updated open issues read without a search query.
const MAX_PAGES: usize = 3;
const SEARCH_LIMIT: u32 = 50;

const ISSUE_FIELDS: &str = r#"fragment I on Issue { number title url updatedAt repository{nameWithOwner} assignees(first:10){nodes{login}} projectItems(first:10){nodes{fieldValues(first:30){nodes{... on ProjectV2ItemFieldIterationValue{title startDate duration field{... on ProjectV2IterationField{name}}}}}}} }"#;

/// Open issues in `repo`: the most recently updated ones, or those matching
/// `query` (GitHub search syntax) when it is not empty.
pub async fn open_issues(gh: &dyn Github, repo: &str, query: &str, today: NaiveDate) -> Result<Vec<RepoIssue>> {
    validate_repo(repo)?;
    let (owner, name) = repo.split_once('/').context("Invalid repository")?;
    let mut nodes = vec![];
    if query.trim().is_empty() {
        let mut cursor = Value::Null;
        for _ in 0..MAX_PAGES {
            let q = format!("query($owner:String!,$name:String!,$cursor:String){{repository(owner:$owner,name:$name){{issues(states:OPEN,first:100,after:$cursor,orderBy:{{field:UPDATED_AT,direction:DESC}}){{pageInfo{{hasNextPage endCursor}} nodes{{...I}}}}}}}}\n{ISSUE_FIELDS}");
            let data = gh.request("POST", "graphql", Some(json!({"query": q, "variables": {"owner": owner, "name": name, "cursor": cursor}}))).await?;
            if data.get("errors").is_some() {
                bail!("Issues unavailable: {}", data["errors"]);
            }
            let conn = &data["data"]["repository"]["issues"];
            nodes.extend(conn["nodes"].as_array().cloned().unwrap_or_default());
            if conn["pageInfo"]["hasNextPage"] != true {
                break;
            }
            cursor = conn["pageInfo"]["endCursor"].clone();
        }
    } else {
        let q = format!("query($q:String!){{search(type:ISSUE,query:$q,first:{SEARCH_LIMIT}){{nodes{{...I}}}}}}\n{ISSUE_FIELDS}");
        let search = format!("repo:{repo} is:issue is:open {}", query.trim());
        let data = gh.request("POST", "graphql", Some(json!({"query": q, "variables": {"q": search}}))).await?;
        if data.get("errors").is_some() {
            bail!("Issue search failed: {}", data["errors"]);
        }
        nodes.extend(data["data"]["search"]["nodes"].as_array().cloned().unwrap_or_default());
    }
    Ok(nodes
        .iter()
        // A query may name other repositories (`repo:` qualifiers are ORed).
        .filter(|n| n["repository"]["nameWithOwner"].as_str().is_some_and(|r| r.eq_ignore_ascii_case(repo)))
        .filter_map(|n| issue(n, today))
        .collect())
}

fn issue(node: &Value, today: NaiveDate) -> Option<RepoIssue> {
    Some(RepoIssue {
        number: u32::try_from(node["number"].as_u64()?).ok()?,
        title: node["title"].as_str()?.to_string(),
        url: node["url"].as_str()?.to_string(),
        assignees: node["assignees"]["nodes"].as_array().into_iter().flatten().filter_map(|a| a["login"].as_str().map(String::from)).collect(),
        sprint: current_sprint(node, today),
        updated_at: node["updatedAt"].as_str().unwrap_or_default().to_string(),
    })
}

/// The iteration running today. With several iteration fields (say
/// "Iteration" and "Quarter"), one named like a sprint wins.
fn current_sprint(node: &Value, today: NaiveDate) -> Option<String> {
    let mut current: Vec<(&str, &str)> = vec![];
    for item in node["projectItems"]["nodes"].as_array().into_iter().flatten() {
        for value in item["fieldValues"]["nodes"].as_array().into_iter().flatten() {
            let (Some(title), Some(start), Some(duration)) = (value["title"].as_str(), value["startDate"].as_str(), value["duration"].as_u64()) else { continue };
            let Ok(start) = NaiveDate::parse_from_str(start, "%Y-%m-%d") else { continue };
            let Some(end) = start.checked_add_days(Days::new(duration)) else { continue };
            if start <= today && today < end {
                current.push((value["field"]["name"].as_str().unwrap_or_default(), title));
            }
        }
    }
    let sprint_like = |field: &str| {
        let field = field.to_lowercase();
        field.contains("sprint") || field.contains("iteration")
    };
    current.iter().find(|(field, _)| sprint_like(field)).or(current.first()).map(|(_, title)| title.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;

    struct Fake {
        responses: Mutex<Vec<Value>>,
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
            Ok(self.responses.lock().unwrap().remove(0))
        }
    }
    fn fake(responses: Vec<Value>) -> Fake {
        Fake { responses: Mutex::new(responses), bodies: Mutex::new(vec![]) }
    }
    fn node(number: u32, repo: &str, iterations: Value) -> Value {
        json!({"number": number, "title": format!("Issue {number}"), "url": format!("https://github.com/{repo}/issues/{number}"),
            "updatedAt": "2026-09-30T00:00:00Z", "repository": {"nameWithOwner": repo},
            "assignees": {"nodes": [{"login": "eldin"}]},
            "projectItems": {"nodes": [{"fieldValues": {"nodes": iterations}}]}})
    }
    fn page(nodes: Vec<Value>, next: bool) -> Value {
        json!({"data": {"repository": {"issues": {"pageInfo": {"hasNextPage": next, "endCursor": "c"}, "nodes": nodes}}}})
    }
    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 9, 30).unwrap()
    }

    #[tokio::test]
    async fn marks_issues_in_the_running_iteration() {
        let gh = fake(vec![page(vec![
            node(1, "o/r", json!([{"title": "Sprint 3", "startDate": "2026-09-27", "duration": 14, "field": {"name": "Sprint"}}])),
            node(2, "o/r", json!([{"title": "Sprint 2", "startDate": "2026-09-13", "duration": 14, "field": {"name": "Sprint"}}])),
            node(3, "o/r", json!([{}, {"title": "Sprint 4", "startDate": "2026-10-11", "duration": 14, "field": {"name": "Sprint"}}])),
            node(4, "o/r", json!([
                {"title": "Q3", "startDate": "2026-07-01", "duration": 92, "field": {"name": "Quarter"}},
                {"title": "Iteration 9", "startDate": "2026-09-30", "duration": 7, "field": {"name": "Iteration"}},
            ])),
        ], false)]);
        let issues = open_issues(&gh, "o/r", "", today()).await.unwrap();
        let sprints: Vec<_> = issues.iter().map(|i| (i.number, i.sprint.as_deref())).collect();
        assert_eq!(sprints, [(1, Some("Sprint 3")), (2, None), (3, None), (4, Some("Iteration 9"))]);
        assert_eq!(issues[0].assignees, ["eldin"]);
    }

    #[tokio::test]
    async fn reads_a_bounded_number_of_pages() {
        let gh = fake((0..MAX_PAGES + 1).map(|i| page(vec![node(i as u32 + 1, "o/r", json!([]))], true)).collect());
        assert_eq!(open_issues(&gh, "o/r", "", today()).await.unwrap().len(), MAX_PAGES);
        assert_eq!(gh.bodies.lock().unwrap().len(), MAX_PAGES);
    }

    #[tokio::test]
    async fn searches_only_the_repository() {
        let gh = fake(vec![json!({"data": {"search": {"nodes": [node(5, "o/r", json!([])), node(6, "evil/r", json!([])), {}]}}})]);
        let issues = open_issues(&gh, "o/r", "login repo:evil/r", today()).await.unwrap();
        assert_eq!(issues.iter().map(|i| i.number).collect::<Vec<_>>(), [5]);
        assert_eq!(gh.bodies.lock().unwrap()[0]["variables"]["q"], "repo:o/r is:issue is:open login repo:evil/r");
    }

    #[tokio::test]
    async fn reports_graphql_errors_and_rejects_bad_repositories() {
        let gh = fake(vec![json!({"errors": [{"message": "nope"}]})]);
        assert!(open_issues(&gh, "o/r", "", today()).await.is_err());
        assert!(open_issues(&gh, "../r", "", today()).await.is_err());
    }
}
