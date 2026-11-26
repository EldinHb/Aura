// Open issues of a repository, marked with the project iteration (sprint) each one is in today (former issues.rs).
import { has, list, sameText, show, u64, validateRepo, type Github } from "./github";
import type { RepoIssue } from "./types";

/** Pages of 100 most recently updated open issues read without a search query. */
export const MAX_ISSUE_PAGES = 3;
const SEARCH_LIMIT = 50;

const ISSUE_FIELDS = `fragment I on Issue { number title url updatedAt repository{nameWithOwner} assignees(first:10){nodes{login}} projectItems(first:10){nodes{fieldValues(first:30){nodes{... on ProjectV2ItemFieldIterationValue{title startDate duration field{... on ProjectV2IterationField{name}}}}}}} }`;

/** Open issues in `repo`, most recently updated, or matching `query`. `today` is YYYY-MM-DD (local). */
export async function openIssues(gh: Github, repo: string, query: string, today: string): Promise<RepoIssue[]> {
  validateRepo(repo);
  const [owner, name] = repo.split("/");
  const nodes: any[] = [];
  if (!query.trim()) {
    let cursor: unknown = null;
    for (let i = 0; i < MAX_ISSUE_PAGES; i++) {
      const q = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){issues(states:OPEN,first:100,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor} nodes{...I}}}}\n${ISSUE_FIELDS}`;
      const data = await gh.request("POST", "graphql", { query: q, variables: { owner, name, cursor } });
      if (has(data, "errors")) throw new Error(`Issues unavailable: ${show(data.errors)}`);
      const conn = data?.data?.repository?.issues;
      nodes.push(...list(conn?.nodes));
      if (conn?.pageInfo?.hasNextPage !== true) break;
      cursor = conn?.pageInfo?.endCursor ?? null;
    }
  } else {
    const q = `query($q:String!){search(type:ISSUE,query:$q,first:${SEARCH_LIMIT}){nodes{...I}}}\n${ISSUE_FIELDS}`;
    const search = `repo:${repo} is:issue is:open ${query.trim()}`;
    const data = await gh.request("POST", "graphql", { query: q, variables: { q: search } });
    if (has(data, "errors")) throw new Error(`Issue search failed: ${show(data.errors)}`);
    nodes.push(...list(data?.data?.search?.nodes));
  }
  const day = parseDay(today);
  return (
    nodes
      // A query may name other repositories (`repo:` qualifiers are ORed).
      .filter((n) => typeof n?.repository?.nameWithOwner === "string" && sameText(n.repository.nameWithOwner, repo))
      .flatMap((n) => {
        const i = issue(n, day);
        return i ? [i] : [];
      })
  );
}

/** Days since the epoch of a YYYY-MM-DD date, or null. */
function parseDay(date: string): number | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(date);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const back = new Date(ms);
  // Reject dates that roll over (2026-02-31).
  if (back.getUTCMonth() !== Number(m[2]) - 1 || back.getUTCDate() !== Number(m[3])) return null;
  return Math.round(ms / 86_400_000);
}

function issue(node: any, today: number | null): RepoIssue | null {
  const number = u64(node?.number);
  if (number === null || number > 0xffffffff) return null;
  if (typeof node?.title !== "string" || typeof node?.url !== "string") return null;
  return {
    number,
    title: node.title,
    url: node.url,
    assignees: list(node?.assignees?.nodes).flatMap((a) => (typeof a?.login === "string" ? [a.login] : [])),
    sprint: currentSprint(node, today),
    updated_at: typeof node?.updatedAt === "string" ? node.updatedAt : "",
  };
}

/** The iteration running today. With several iteration fields (say "Iteration" and "Quarter"), one named like a sprint wins. */
function currentSprint(node: any, today: number | null): string | null {
  if (today === null) return null;
  const current: Array<[string, string]> = [];
  for (const item of list(node?.projectItems?.nodes)) {
    for (const value of list(item?.fieldValues?.nodes)) {
      const title = value?.title;
      const startDate = value?.startDate;
      const duration = u64(value?.duration);
      if (typeof title !== "string" || typeof startDate !== "string" || duration === null) continue;
      const start = parseDay(startDate);
      if (start === null) continue;
      const end = start + duration;
      if (start <= today && today < end) current.push([typeof value?.field?.name === "string" ? value.field.name : "", title]);
    }
  }
  const sprintLike = (field: string) => {
    const f = field.toLowerCase();
    return f.includes("sprint") || f.includes("iteration");
  };
  const found = current.find(([field]) => sprintLike(field)) ?? current[0];
  return found ? found[1] : null;
}
