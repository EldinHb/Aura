import type { Github } from "./github";
import type { BranchPull } from "./types";

/** The PR into `repo` from `branch` of `headRepo`: the open one, else the most recently created. */
export async function branchPull(gh: Github, repo: string, headRepo: string, branch: string): Promise<BranchPull | null> {
  throw new Error("not ported yet: branchPull");
}
