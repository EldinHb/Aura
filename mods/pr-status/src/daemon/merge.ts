// "Squash and merge": the mod's one write to GitHub. It goes through the github mod's transport
// as the account whose permissions the card showed (`requestFor`), checks the PR once more right
// before the write (same head, still approved and clean), pins the merge to that head commit, and
// deletes the head branch after it only when asked and only in the PR's own repository.
import { errorData, has, list, messageOf, RateLimited, RejectedRequest, refPath, s, show, validateRepo, validateSha, type Github } from "@aura/github-client";
import type { MergeDefaults, MergeResult, PrStatus } from "../shared/types";
import { squashState } from "../shared/squash";
import type { Pinning } from "./ghcli";
import { readStatuses } from "./status";

/** Thrown to the UI half with a `code` and a message meant for people. */
export function mergeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export const REVIEW_AGAIN = "New commits were pushed — review again";

/** GitHub's own words and the HTTP status, from the transport's "<message> (HTTP <status>)". */
function said(e: unknown): { text: string; status: number | null } {
  const message = messageOf(e);
  const m = /^(.*) \(HTTP (\d{3})\)$/s.exec(message);
  return m ? { text: m[1], status: Number(m[2]) } : { text: message, status: null };
}

/** A failed merge as something to show in the card, GitHub's message kept. */
export function mergeFailure(e: unknown): Error {
  const { text, status } = said(e);
  // A rate limit comes as a 403 too: it is not a missing permission.
  const limited = e instanceof RateLimited ? e : errorData(e)?.kind === "rate_limited" ? (e as { waitMs?: number | null }) : null;
  if (limited) {
    const wait = typeof limited.waitMs === "number" ? Math.max(1, Math.ceil(limited.waitMs / 60_000)) : null;
    return mergeError("rate_limited", `GitHub's rate limit is reached; try again ${wait ? `in about ${wait} min` : "later"}. GitHub said: ${text}`);
  }
  if (/merge queue/i.test(text)) return mergeError("merge_queue", `This branch merges through a merge queue; add it to the queue on GitHub. GitHub said: ${text}`);
  switch (status) {
    case 405:
      return mergeError("not_mergeable", `GitHub refused the merge: ${text}`);
    case 409:
      return mergeError("head_moved", `${REVIEW_AGAIN}. GitHub said: ${text}`);
    case 403:
      return mergeError("forbidden", `You don't have permission to merge: ${text}`);
    case 404:
      return mergeError("not_found", `GitHub could not find the pull request, or you can't see it: ${text}`);
    case 422:
      return mergeError("invalid", `GitHub did not accept the merge: ${text}`);
  }
  // `requestFor` refuses before sending when gh is signed in to another account now.
  if (e instanceof RejectedRequest || errorData(e)?.kind === "rejected") {
    return mergeError("account", `Not merged: the account shown is not the one signed in now; review again. ${text}`);
  }
  return mergeError("failed", `The merge failed: ${text}`);
}

export interface MergeRequest {
  repo: string;
  number: number;
  /** The head commit the confirmation showed. */
  sha: string;
  /** "host:login" whose permissions the confirmation showed; the merge is made as this account only. */
  account: string;
  title: string;
  message: string;
  deleteBranch: boolean;
}

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
  const account = typeof p?.account === "string" ? p.account : "";
  if (!/^[^:\s]+:[^:\s]+$/.test(account)) throw invalid("account must be the host:login the confirmation showed");
  const title = typeof p?.title === "string" ? p.title.trim() : "";
  if (!title) throw invalid("The commit title is empty");
  const message = typeof p?.message === "string" ? p.message : "";
  return { repo, number, sha, account, title, message, deleteBranch: p?.deleteBranch === true };
}

/** `gh`, with every request sent as `account` (refused when gh is signed in to another one). */
function as(gh: Github, account: string): Github {
  return { ...gh, request: (method, path, body) => gh.requestFor(account, method, path, body) };
}

/** Squash-merge PRs, one merge per PR at a time. */
export class Merger {
  private running = new Set<string>();

  /** With `pinned` (GhCli), the whole merge runs on one token read for it; else every request checks the account. */
  constructor(private readonly gh: Github & Partial<Pinning>) {}

  /**
   * Merge as `req.account`, at `req.sha`. Whether that head is current is decided by a fresh read
   * as that account right before the write, never by what a card read earlier.
   */
  async merge(req: MergeRequest): Promise<MergeResult> {
    const key = `${req.repo}#${req.number}`.toLowerCase();
    if (this.running.has(key)) throw mergeError("busy", "This pull request is being merged already");
    this.running.add(key);
    try {
      if (this.gh.pinned) {
        try {
          return await this.gh.pinned(req.account, (pinned) => this.mergeAs(as(pinned, req.account), req));
        } catch (e) {
          throw (e as { code?: unknown }).code ? e : mergeFailure(e);
        }
      }
      return await this.mergeAs(as(this.gh, req.account), req);
    } finally {
      this.running.delete(key);
    }
  }

  /** The merge itself, every request through `gh` (as the account). */
  private async mergeAs(gh: Github, req: MergeRequest): Promise<MergeResult> {
    {
      const now = await this.check(gh, req);
      let reply: any;
      try {
        reply = await gh.request("PUT", `repos/${req.repo}/pulls/${req.number}/merge`, {
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
      if (req.deleteBranch) Object.assign(result, await this.deleteBranch(gh, req, now));
      return result;
    }
  }

  /** Read the PR again as the account, right before the write: still at `sha`, and still mergeable by these rules. */
  private async check(gh: Github, req: MergeRequest): Promise<PrStatus> {
    let read: PrStatus | Error;
    try {
      [read] = await readStatuses(gh, [{ url: `https://github.com/${req.repo}/pull/${req.number}`, repo: req.repo, number: req.number }]);
    } catch (e) {
      read = e instanceof Error ? e : new Error(messageOf(e));
    }
    if (read instanceof Error) throw mergeFailure(read);
    if (read.merge.headSha !== req.sha) throw mergeError("head_moved", REVIEW_AGAIN);
    const state = squashState(read);
    if (state?.kind !== "ready") {
      const why = !state ? "it is no longer open and approved" : state.kind === "disabled" ? state.reasons.join(", ") : state.reason;
      throw mergeError("not_eligible", `Not merged: ${why}`);
    }
    return read;
  }

  /** Delete the merged head branch as the account; never a fork's, and a branch already gone counts as deleted. */
  private async deleteBranch(gh: Github, req: MergeRequest, pr: PrStatus): Promise<Pick<MergeResult, "branchDeleted" | "branchError">> {
    if (!pr.merge.headRef) return { branchDeleted: false, branchError: "The head branch is not known; it was left alone" };
    if (!pr.merge.sameRepo) return { branchDeleted: false, branchError: "The branch is in a fork; it was left alone" };
    try {
      await gh.request("DELETE", `repos/${req.repo}/git/refs/heads/${refPath(pr.merge.headRef)}`);
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
