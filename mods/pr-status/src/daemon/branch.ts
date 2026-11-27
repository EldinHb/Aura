// The pull request of a session folder's branch, found with git and the GitHub CLI through
// `aura.process`: the branch and its upstream from `git status`, the repositories from
// `git remote -v`, and the PR from `gh pr list --head`.
import type { DaemonApi } from "@aura/mod-sdk";

type Run = DaemonApi["process"]["run"];

/** What `git status --porcelain=v2 --branch` says of the branch. */
export interface GitBranch {
  /** The checked-out branch; null when detached. */
  branch: string | null;
  head: string | null;
  /** The tracked branch as `remote/branch`, if any. */
  upstream: string | null;
  ahead: number;
}

export function parseStatus(stdout: string): GitBranch {
  const out: GitBranch = { branch: null, head: null, upstream: null, ahead: 0 };
  for (const line of stdout.split("\n")) {
    const [hash, key, ...rest] = line.trim().split(" ");
    if (hash !== "#") continue;
    const value = rest.join(" ");
    if (key === "branch.head") out.branch = value === "(detached)" ? null : value;
    else if (key === "branch.oid") out.head = value === "(initial)" ? null : value;
    else if (key === "branch.upstream") out.upstream = value;
    else if (key === "branch.ab") out.ahead = Number(/\+(\d+)/.exec(value)?.[1] ?? 0);
  }
  return out;
}

/** `owner/repo` of a github.com remote URL (https or ssh), else null. */
export function githubRepo(url: string): string | null {
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Remote name → `owner/repo`, for the github.com remotes of `git remote -v`. */
export function parseRemotes(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const [name, url] = line.trim().split(/\s+/);
    const repo = name && url ? githubRepo(url) : null;
    if (name && repo && !(name in out)) out[name] = repo;
  }
  return out;
}

/** Where to look: the PR's repository (`upstream`, else `origin`, else any), the head branch and its owner. */
export interface BranchQuestion {
  repo: string;
  branch: string;
  headOwner: string;
  /** Changes when the branch, its upstream or its head does: then the answer may change. */
  stamp: string;
}

export function branchQuestion(git: GitBranch, remotes: Record<string, string>): BranchQuestion | null {
  if (!git.branch) return null;
  const repo = remotes.upstream ?? remotes.origin ?? Object.values(remotes)[0];
  if (!repo) return null;
  // `origin/feature`: the branch as the remote has it, and whose repository that is.
  const slash = git.upstream ? git.upstream.indexOf("/") : -1;
  const remote = slash > 0 ? git.upstream!.slice(0, slash) : "origin";
  const branch = slash > 0 ? git.upstream!.slice(slash + 1) : git.branch;
  const headOwner = (remotes[remote] ?? remotes.origin ?? repo).split("/")[0];
  return { repo, branch, headOwner, stamp: `${repo}|${headOwner}:${branch}|${git.head ?? ""}|${git.ahead}` };
}

/** The folder's branch, as git says (local, no GitHub call). Null outside a git repository. */
export async function readBranch(run: Run, cwd: string): Promise<GitBranch | null> {
  const out = await run("git", ["-C", cwd, "status", "--porcelain=v2", "--branch", "--untracked-files=no"], { timeoutMs: 15_000 });
  return out.code === 0 ? parseStatus(out.stdout) : null;
}

export async function readRemotes(run: Run, cwd: string): Promise<Record<string, string>> {
  const out = await run("git", ["-C", cwd, "remote", "-v"], { timeoutMs: 15_000 });
  return out.code === 0 ? parseRemotes(out.stdout) : {};
}

export const PR_LIST_FIELDS = "url,state,headRepositoryOwner";

/** The URL of the PR from `q.branch` of `q.headOwner` into `q.repo`: the open one, else the newest. */
export async function branchPull(run: Run, q: BranchQuestion): Promise<string | null> {
  const out = await run("gh", ["pr", "list", "--repo", q.repo, "--head", q.branch, "--state", "all", "--limit", "20", "--json", PR_LIST_FIELDS], { timeoutMs: 60_000 });
  if (out.code !== 0) throw new Error(out.stderr.trim() || "gh pr list failed");
  const list: Array<{ url?: string; state?: string; headRepositoryOwner?: { login?: string } }> = JSON.parse(out.stdout || "[]");
  // Another fork can have a branch of the same name.
  const own = list.filter((p) => p.headRepositoryOwner?.login?.toLowerCase() === q.headOwner.toLowerCase());
  const pick = own.find((p) => p.state === "OPEN") ?? own[0];
  return typeof pick?.url === "string" ? pick.url : null;
}
