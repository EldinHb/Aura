// The pull request opened from a branch, with its check and review state (former branch.rs).
import { has, list, s, sameText, show, u64, validateRepo, type Github } from "./github";
import { REVIEWS_QUERY, reviewsByOthers } from "./pulls";
import type { BranchPull } from "./types";

export const BRANCH_QUERY =
  "query($owner:String!,$name:String!,$head:String!){repository(owner:$owner,name:$name){pullRequests(headRefName:$head,first:20,orderBy:{field:CREATED_AT,direction:DESC}){nodes{number title url state isDraft reviewDecision headRefOid author{login} headRepository{nameWithOwner} commits(last:1){nodes{commit{statusCheckRollup{state}}}} " +
  REVIEWS_QUERY +
  "}}}}";

/** The PR into `repo` from `branch` of `headRepo`: the open one, else the most recently created. */
export async function branchPull(gh: Github, repo: string, headRepo: string, branch: string): Promise<BranchPull | null> {
  validateRepo(repo);
  validateRepo(headRepo);
  if (!branch) throw new Error("branch is required");
  const [owner, name] = repo.split("/");
  const data = await gh.request("POST", "graphql", { query: BRANCH_QUERY, variables: { owner, name, head: branch } });
  if (has(data, "errors")) throw new Error(`Pull requests unavailable: ${show(data.errors)}`);
  const nodes = list(data?.data?.repository?.pullRequests?.nodes);
  // Another fork can have a branch with the same name.
  const fromHead = nodes.filter((n) => typeof n?.headRepository?.nameWithOwner === "string" && sameText(n.headRepository.nameWithOwner, headRepo));
  const node = fromHead.find((n) => n?.state === "OPEN") ?? fromHead[0];
  return node ? toPull(repo, node) : null;
}

function toPull(repo: string, node: any): BranchPull | null {
  const number = u64(node?.number);
  if (number === null || number > 0xffffffff) return null;
  return {
    repo,
    number,
    title: s(node, "title"),
    url: s(node, "url"),
    state: s(node, "state").toLowerCase(),
    draft: node?.isDraft === true,
    checks: s(node?.commits?.nodes?.[0]?.commit?.statusCheckRollup, "state"),
    review_decision: s(node, "reviewDecision"),
    head_sha: s(node, "headRefOid"),
    reviews: reviewsByOthers(node, [s(node?.author, "login")]),
  };
}
