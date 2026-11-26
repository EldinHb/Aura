import type { Github } from "./github";
import type { PullRequest, PullTimeline } from "./types";

export async function timeline(gh: Github, p: PullRequest): Promise<PullTimeline> {
  throw new Error("not ported yet: timeline");
}

/** The REST-shaped (reviews, comments, events) lists the old UI used. */
export function legacyLists(t: PullTimeline): [any[], any[], any[]] {
  throw new Error("not ported yet: legacyLists");
}
