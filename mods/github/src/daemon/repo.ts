// The GitHub repository a folder works against (former aura-git ops.rs `github_repo`).
import type { Git } from "@aura/mod-sdk/daemon";

/** `owner/repo` from a github.com remote URL in HTTPS, SSH or scp-like form. */
export function parseGithubRemote(url: string): string | null {
  const prefixes = ["https://github.com/", "http://github.com/", "ssh://git@github.com/", "git://github.com/", "git@github.com:"];
  let path: string | null = null;
  for (const prefix of prefixes) {
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
  if (path.endsWith(".git")) path = path.slice(0, -".git".length);
  const slash = path.indexOf("/");
  if (slash < 0) return null;
  const owner = path.slice(0, slash);
  const repo = path.slice(slash + 1);
  const valid = (s: string) => s !== "" && /^[A-Za-z0-9_.-]+$/.test(s);
  return valid(owner) && valid(repo) ? `${owner}/${repo}` : null;
}

/**
 * `owner/repo` of the GitHub repository whose issues and PRs `cwd` works against,
 * choosing remotes in the order `gh` does: `upstream`, `github`, then `origin`. Null
 * when `cwd` is not a repository or has no GitHub remote.
 */
export async function githubRepo(git: Pick<Git, "repoRoot" | "remotes">, cwd: string): Promise<string | null> {
  // SDK-GAP: `git.repoRoot` rejects both outside a repository and when git fails; the former
  // code told the two apart (None vs an error). Any rejection counts as "not a repository".
  try {
    await git.repoRoot(cwd);
  } catch {
    return null;
  }
  const remotes = await git.remotes(cwd);
  for (const name of ["upstream", "github", "origin"]) {
    const remote = remotes.find((r) => r.name === name);
    if (!remote) continue;
    const repo = parseGithubRemote(remote.url.trim());
    if (repo) return repo;
  }
  return null;
}
