// Revision-pinned worktrees backed by a shared partial mirror (former
// aura-git review.rs). Everything lives in the mod's data dir:
//   <dataDir>/mirrors/<account>/<owner>/<repo>.git   one partial mirror per repository
//   <dataDir>/workspaces/review-<id>                  a detached worktree per pre-review
//   <dataDir>/workspaces/empty                        where a diff-only review runs
import type { DaemonApi } from "@aura/mod-sdk";
import type { PullRequest } from "@aura/github-client";
import { Fail, Lock, fail, message, newId, validRepo, validSha } from "./util";

export interface ReviewWorkspace {
  /** A new, not yet existing directory for a review's checkout. */
  path(): string;
  /** Check `pull` out at its head in a detached worktree at `cwd`: [diff from the merge base, merge base]. */
  prepare(pull: PullRequest, cwd: string): Promise<[string, string]>;
  /** Put the full diff next to the checkout for the agent to read. */
  writeDiff(cwd: string, diff: string): Promise<void>;
  /** An empty directory for a review from the diff alone. */
  empty(): Promise<string>;
  /** Remove a checkout made by `prepare`, also a half-made one. */
  remove(pull: PullRequest, cwd: string): Promise<void>;
}

/** Git options every run uses: no hooks, no fsmonitor, paths as they are. */
const SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false"];
const ENV = { GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" };

export class GitWorkspace implements ReviewWorkspace {
  private locks = new Map<string, Lock>();
  private sep: string;
  constructor(private aura: DaemonApi) {
    this.sep = aura.mod.platform === "windows" && !aura.mod.dataDir.includes("/") ? "\\" : "/";
  }

  private join(...parts: string[]): string {
    const root = this.aura.mod.dataDir.replace(/[\\/]+$/, "");
    return [root, ...parts].join(this.sep);
  }

  path(): string {
    return this.join("workspaces", `review-${newId()}`);
  }

  private mirror(p: PullRequest): string {
    const [owner, name] = p.repo.split("/");
    const account = p.account.replace(/[^A-Za-z0-9._-]/g, "_");
    return this.join("mirrors", account, owner, `${name}.git`);
  }

  private git(cwd: string, args: string[]): Promise<string> {
    return this.aura.git.run(cwd, [...SAFE, ...args], { timeoutMs: 10 * 60_000 }).then((out) => out.replace(/\s+$/, ""));
  }

  private async exists(gitDir: string): Promise<boolean> {
    try {
      await this.aura.git.run(this.aura.mod.dataDir, ["--git-dir", gitDir, "rev-parse", "--git-dir"]);
      return true;
    } catch {
      return false;
    }
  }

  async prepare(p: PullRequest, cwd: string): Promise<[string, string]> {
    if (!validRepo(p.repo)) fail("Invalid repository");
    for (const sha of [p.base_sha, p.head_sha]) if (!validSha(sha)) fail("Invalid commit SHA");
    const mirror = this.mirror(p);
    const lock = this.locks.get(mirror) ?? new Lock();
    this.locks.set(mirror, lock);
    return lock.run(async () => {
      if (!(await this.exists(mirror))) {
        // SDK-GAP: no file system API, so no staging directory renamed into place: gh
        // clones straight to the mirror path (git removes what it made when a clone fails).
        const out = await this.aura.process.run(
          "gh",
          ["repo", "clone", `https://github.com/${p.repo}`, mirror, "--", "--mirror", "--filter=blob:none"],
          { cwd: this.aura.mod.dataDir, env: ENV, timeoutMs: 30 * 60_000 },
        );
        if (out.code !== 0) throw new Fail(out.stderr.trim() || `gh repo clone exited with ${out.code}`);
      }
      // SDK-GAP: aura.git.run takes no env; GIT_TERMINAL_PROMPT=0 is left to the host.
      await this.git(mirror, ["fetch", "origin", `+refs/pull/${p.number}/head:refs/aura/pr-${p.number}`, p.base_sha, p.head_sha]);
      // A checkout removed without git (a crash, a cleared folder) leaves its registration
      // behind; prune it before reuse, leaving live concurrent worktrees intact.
      await this.git(mirror, ["worktree", "prune", "--expire", "now"]);
      await this.git(mirror, ["worktree", "add", "--detach", cwd, p.head_sha]);
      const base = await this.git(cwd, ["merge-base", p.base_sha, p.head_sha]);
      const diff = await this.git(cwd, ["diff", "--no-ext-diff", "--no-textconv", base, p.head_sha, "--"]);
      return [diff, base] as [string, string];
    });
  }

  async writeDiff(cwd: string, diff: string): Promise<void> {
    // SDK-GAP: no file writes. `git apply` of a patch that adds the file writes it
    // into the worktree (and not into the index).
    const body = diff === "" ? [] : diff.replace(/\n$/, "").split("\n");
    const patch = [
      "diff --git a/.aura-pr.diff b/.aura-pr.diff",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/.aura-pr.diff",
      `@@ -0,0 +1,${body.length} @@`,
      ...body.map((l) => `+${l}`),
      ...(diff.endsWith("\n") || diff === "" ? [] : ["\\ No newline at end of file"]),
      "",
    ].join("\n");
    if (body.length === 0) return;
    const out = await this.aura.process.run("git", [...SAFE, "apply", "--whitespace=nowarn", "-"], {
      cwd,
      env: ENV,
      stdin: patch,
    });
    if (out.code !== 0) throw new Fail(out.stderr.trim() || "git apply failed");
  }

  async empty(): Promise<string> {
    const dir = this.join("workspaces", "empty");
    // SDK-GAP: no mkdir; an empty repository makes the directory (and holds nothing else).
    if (!(await this.exists(`${dir}${this.sep}.git`))) await this.aura.git.run(this.aura.mod.dataDir, ["init", "-q", dir]);
    return dir;
  }

  async remove(p: PullRequest, cwd: string): Promise<void> {
    const mirror = this.mirror(p);
    try {
      await this.git(mirror, ["worktree", "remove", "--force", cwd]);
    } catch (e) {
      console.debug(`removing review checkout ${cwd}: ${message(e)}`);
      await this.git(mirror, ["worktree", "prune", "--expire", "now"]).catch(() => {});
    }
  }
}
