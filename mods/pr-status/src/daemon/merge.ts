// "Squash and merge": the mod's one write to GitHub. It goes through the github mod's transport
// (`api.request`), pinned to the head commit the card showed, and deletes the head branch after
// it only when asked and only in the PR's own repository.
import { has, list, messageOf, refPath, s, show, validateRepo, validateSha, type Github } from "@aura/github-client";
import type { MergeDefaults, MergeResult } from "../shared/types";

/** Thrown to the UI half with a `code` and a message meant for people. */
export function mergeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** GitHub's own words and the HTTP status, from the transport's "<message> (HTTP <status>)". */
function said(e: unknown): { text: string; status: number | null } {
  const message = messageOf(e);
  const m = /^(.*) \(HTTP (\d{3})\)$/s.exec(message);
  return m ? { text: m[1], status: Number(m[2]) } : { text: message, status: null };
}

/** A failed merge as something to show in the card, GitHub's message kept. */
export function mergeFailure(e: unknown): Error {
  const { text, status } = said(e);
  if (/merge queue/i.test(text)) return mergeError("merge_queue", `This branch merges through a merge queue; add it to the queue on GitHub. GitHub said: ${text}`);
  switch (status) {
    case 405:
      return mergeError("not_mergeable", `GitHub refused the merge: ${text}`);
    case 409:
      return mergeError("head_moved", `New commits arrived since this card was read; refresh and look at them first. GitHub said: ${text}`);
    case 403:
      return mergeError("forbidden", `You don't have permission to merge: ${text}`);
    case 404:
      return mergeError("not_found", `GitHub could not find the pull request, or you can't see it: ${text}`);
    case 422:
      return mergeError("invalid", `GitHub did not accept the merge: ${text}`);
    default:
      return mergeError("failed", `The merge failed: ${text}`);
  }
}

export interface MergeRequest {
  repo: string;
  number: number;
  /** The head commit the card showed. */
  sha: string;
  title: string;
  message: string;
  deleteBranch: boolean;
}

/** The PR's head branch as this daemon last read it, for deleting it; null when it was not read. */
export type HeadBranch = { headRef: string; sameRepo: boolean } | null;

/** The parameters of the `merge` RPC, checked. */
export function mergeRequest(p: any): MergeRequest {
  const invalid = (what: string) => mergeError("invalid", what);
  const repo = typeof p?.repo === "string" ? p.repo : "";
  try {
    validateRepo(repo);
  } catch {
    throw invalid("repo must be owner/name");
  }
  const number = p?.number;
  if (!Number.isSafeInteger(number) || number <= 0) throw invalid("number must be a pull request number");
  const sha = typeof p?.sha === "string" ? p.sha : "";
  try {
    validateSha(sha);
  } catch {
    throw invalid("sha must be the 40-character head commit");
  }
  const title = typeof p?.title === "string" ? p.title.trim() : "";
  if (!title) throw invalid("The commit title is empty");
  const message = typeof p?.message === "string" ? p.message : "";
  return {
    repo, number, sha, title, message,
    deleteBranch: p?.deleteBranch === true,
  };
}

/** Squash-merge PRs, one merge per PR at a time. */
export class Merger {
  private running = new Set<string>();

  constructor(private readonly gh: Github) {}

  async merge(req: MergeRequest, head: HeadBranch): Promise<MergeResult> {
    const key = `${req.repo}#${req.number}`.toLowerCase();
    if (this.running.has(key)) throw mergeError("busy", "This pull request is being merged already");
    this.running.add(key);
    try {
      let reply: any;
      try {
        reply = await this.gh.request("PUT", `repos/${req.repo}/pulls/${req.number}/merge`, {
          merge_method: "squash",
          commit_title: req.title,
          commit_message: req.message,
          sha: req.sha,
        });
      } catch (e) {
        throw mergeFailure(e);
      }
      if (reply?.merged !== true) throw mergeError("not_mergeable", `GitHub did not merge: ${s(reply, "message") || "no reason given"}`);
      const result: MergeResult = { merged: true, sha: s(reply, "sha"), branchDeleted: false, branchError: null };
      if (req.deleteBranch) Object.assign(result, await this.deleteBranch(req, head));
      return result;
    } finally {
      this.running.delete(key);
    }
  }

  /** Delete the merged head branch; never a fork's, and a branch already gone counts as deleted. */
  private async deleteBranch(req: MergeRequest, head: HeadBranch): Promise<Pick<MergeResult, "branchDeleted" | "branchError">> {
    if (!head?.headRef) return { branchDeleted: false, branchError: "The head branch is not known; it was left alone" };
    if (!head.sameRepo) return { branchDeleted: false, branchError: "The branch is in a fork; it was left alone" };
    try {
      await this.gh.request("DELETE", `repos/${req.repo}/git/refs/heads/${refPath(head.headRef)}`);
      return { branchDeleted: true, branchError: null };
    } catch (e) {
      if (messageOf(e).includes("Reference does not exist")) return { branchDeleted: true, branchError: null };
      return { branchDeleted: false, branchError: said(e).text };
    }
  }
}

export const DEFAULTS_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){squashMergeCommitMessage " +
  "pullRequest(number:$number){title body commits(first:100){totalCount nodes{commit{message}}}}}}";

/**
 * The squash commit GitHub would suggest: the title "<PR title> (#n)", and the message the
 * repository asks for (`squashMergeCommitMessage`): the PR's body, nothing, or (GitHub's
 * default) its commits: one commit's body, or every commit as a "* " item. Up to 100 commits.
 */
export function mergeDefaults(repository: any, number: number): MergeDefaults {
  const pr = repository?.pullRequest;
  const title = `${s(pr, "title")} (#${number})`;
  const setting = s(repository, "squashMergeCommitMessage");
  if (setting === "PR_BODY") return { title, message: s(pr, "body") };
  if (setting === "BLANK") return { title, message: "" };
  const messages = list(pr?.commits?.nodes).map((n) => s(n?.commit, "message").trim()).filter(Boolean);
  if (messages.length === 1) return { title, message: messages[0].split("\n").slice(1).join("\n").trim() };
  return { title, message: messages.map((m) => `* ${m}`).join("\n\n") };
}

export async function readMergeDefaults(gh: Github, repo: string, number: number): Promise<MergeDefaults> {
  validateRepo(repo);
  const [owner, name] = repo.split("/");
  const reply = await gh.request("POST", "graphql", { query: DEFAULTS_QUERY, variables: { owner, name, number } });
  if (has(reply, "errors")) throw new Error(show(reply.errors));
  return mergeDefaults(reply?.data?.repository, number);
}
