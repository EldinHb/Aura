import type { Github } from "./github";
import type { RepoIssue } from "./types";

/** Open issues in `repo`, most recently updated, or matching `query`. `today` is YYYY-MM-DD (local). */
export async function openIssues(gh: Github, repo: string, query: string, today: string): Promise<RepoIssue[]> {
  throw new Error("not ported yet: openIssues");
}
