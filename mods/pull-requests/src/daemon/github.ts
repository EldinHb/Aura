// What the daemon half uses of @aura/github-client, in one object so tests can
// stand in for it (as the Rust tests faked the `Github` trait), plus the PR
// activity the client reads along with a pull request.
import * as client from "@aura/github-client";
import type { Github, PullRequest } from "@aura/github-client";
import { validRepo } from "./util";

export interface Lib {
  pull: typeof client.pull;
  pulls: typeof client.pulls;
  requested: typeof client.requested;
  reviewed: typeof client.reviewed;
  authored: typeof client.authored;
  timeline: typeof client.timeline;
  legacyLists: typeof client.legacyLists;
  projects: typeof client.projects;
  merge: typeof client.merge;
  deleteBranch: typeof client.deleteBranch;
  pages: typeof client.pages;
  branchPull: typeof client.branchPull;
  /** activity.read */
  read: typeof client.read;
  due: typeof client.due;
  dueClosed: typeof client.dueClosed;
  rejected: typeof client.rejected;
}

export const realLib: Lib = {
  pull: client.pull,
  pulls: client.pulls,
  requested: client.requested,
  reviewed: client.reviewed,
  authored: client.authored,
  timeline: client.timeline,
  legacyLists: client.legacyLists,
  projects: client.projects,
  merge: client.merge,
  deleteBranch: client.deleteBranch,
  pages: client.pages,
  branchPull: client.branchPull,
  read: client.read,
  due: client.due,
  dueClosed: client.dueClosed,
  rejected: client.rejected,
};

/** The transport and the functions over it. */
export interface Gh {
  gh: Github;
  lib: Lib;
}

/** A comment, by GitHub's database id. */
export interface Note {
  id: number;
  author: string;
  bot: boolean;
}
export interface LatestReview {
  id: number;
  reviewer: string;
  bot: boolean;
  /** APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED or PENDING. */
  state: string;
}
/**
 * Who did what lately on a PR, read with it to tell what changed between refreshes
 * (former `PullActivity`, daemon-only: it is never stored or sent).
 */
export interface PullActivity {
  commits: number;
  pushed_by: string[];
  comments: Note[];
  thread_comments: Note[];
  reviews: LatestReview[];
  state_actor: string;
}
/** A PR as `pull`/`pulls` read it: the wire shape plus its activity. */
export type ReadPull = PullRequest & { activity?: Partial<PullActivity> & Record<string, any> };

/** A PR's activity, whichever spelling the client used; empty when it read none. */
export function activityOf(p: ReadPull): PullActivity {
  const a: any = p.activity ?? {};
  const list = (v: any) => (Array.isArray(v) ? v : []);
  return {
    commits: Number(a.commits ?? 0) || 0,
    pushed_by: list(a.pushed_by ?? a.pushedBy),
    comments: list(a.comments),
    thread_comments: list(a.thread_comments ?? a.threadComments),
    reviews: list(a.reviews),
    state_actor: String(a.state_actor ?? a.stateActor ?? ""),
  };
}

/** The PR as it is stored and sent: without its activity (serde-skipped in Rust). */
export function wire<T extends ReadPull>(p: T): PullRequest {
  if (!p || !("activity" in p)) return p;
  const { activity: _, ...rest } = p;
  return rest as PullRequest;
}

/** `owner/repo` and number of a `https://github.com/<owner>/<repo>/pull/<n>` URL. */
export function parsePrUrl(url: string): [string, number] | null {
  const trimmed = url.trim();
  const prefix = "https://github.com/";
  if (!trimmed.startsWith(prefix)) return null;
  const parts = trimmed.slice(prefix.length).split("/");
  if (parts.length < 4) return null;
  const [owner, name, kind, num] = parts;
  if (kind !== "pull") return null;
  const repo = `${owner}/${name}`;
  if (!validRepo(repo)) return null;
  if (!/^\d+$/.test(num)) return null;
  const n = Number(num);
  if (!(n > 0 && n <= 4294967295)) return null;
  return [repo, n];
}

/** `owner/repo` of a github.com remote URL in HTTPS, SSH or scp-like form (former `parse_github_remote`). */
export function parseGithubRemote(url: string): string | null {
  let path: string | null = null;
  for (const prefix of ["https://github.com/", "http://github.com/", "ssh://git@github.com/", "git://github.com/", "git@github.com:"]) {
    if (url.startsWith(prefix)) {
      path = url.slice(prefix.length);
      break;
    }
  }
  if (path === null && url.startsWith("https://")) {
    // https://user@github.com/owner/repo
    const rest = url.slice("https://".length);
    const at = rest.indexOf("@");
    if (at >= 0 && !rest.slice(0, at).includes("/") && rest.slice(at + 1).startsWith("github.com/")) {
      path = rest.slice(at + 1 + "github.com/".length);
    }
  }
  if (path === null) return null;
  path = path.replace(/\/+$/, "");
  if (path.endsWith(".git")) path = path.slice(0, -4);
  const slash = path.indexOf("/");
  if (slash < 0) return null;
  const [owner, repo] = [path.slice(0, slash), path.slice(slash + 1)];
  const valid = (s: string) => /^[A-Za-z0-9._-]+$/.test(s);
  return valid(owner) && valid(repo) ? `${owner}/${repo}` : null;
}
