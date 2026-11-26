// Pull request reads and writes (former aura-github lib.rs).
import type { Github } from "./github";
import type { PullRequest, SubmittedReview } from "./types";

/** A PR a search listed: [[`owner/repo`, number], updated_at]. */
export type Listed = [[string, number], string];

/** One pull request, read like `pulls` reads many. */
export async function pull(gh: Github, account: string, repo: string, number: number): Promise<PullRequest> {
  throw new Error("not ported yet: pull");
}

/**
 * Read PRs `ids` in order, a batch of 20 per GraphQL query. A PR GitHub cannot
 * return becomes an Error in its slot; a query that fails as a whole rejects.
 */
export async function pulls(gh: Github, account: string, ids: Array<[string, number]>): Promise<Array<PullRequest | Error>> {
  throw new Error("not ported yet: pulls");
}

export async function merge(gh: Github, account: string, p: PullRequest, method: string): Promise<any> {
  throw new Error("not ported yet: merge");
}

export async function deleteBranch(gh: Github, account: string, p: PullRequest): Promise<void> {
  throw new Error("not ported yet: deleteBranch");
}

export function reviewsByOthers(pull: any, skip: string[]): SubmittedReview[] {
  throw new Error("not ported yet: reviewsByOthers");
}

/** Open PRs that request the user's review. */
export async function requested(gh: Github): Promise<Listed[]> {
  throw new Error("not ported yet: requested");
}

/** Open PRs of others the user reviewed. */
export async function reviewed(gh: Github): Promise<Listed[]> {
  throw new Error("not ported yet: reviewed");
}

/** Open PRs the user authored. */
export async function authored(gh: Github): Promise<Listed[]> {
  throw new Error("not ported yet: authored");
}

/** ProjectV2 associations and fields of a PR. */
export async function projects(gh: Github, p: PullRequest): Promise<any[]> {
  throw new Error("not ported yet: projects");
}
