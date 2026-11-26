// The PRs sessions follow, from the `github` mod, which owns session links
// (former `Session.pulls`, `Manager::record_pull` and the `session.links.v1.*`
// settings that follow.rs read):
//   session.prs           {sessionId}       → string[]   PR URLs the session is linked to or opened from its branch
//   sessions.prs          {}                → Record<sessionId, string[]>
//   session.followsReviews {sessionId}      → boolean    false when the user turned follow-ups off for it
//   pulls.record          {sessionId, url}  → records the PR opened from the session's branch
import type { DaemonApi, Session } from "@aura/mod-sdk";
import { parsePrUrl } from "./github";
import { eqi, message } from "./util";

export type PrId = [string, number];

/** Parsed, deduplicated (case-insensitively) PR ids of `urls`. */
export function prIds(urls: unknown): PrId[] {
  const out: PrId[] = [];
  for (const url of Array.isArray(urls) ? urls : []) {
    if (typeof url !== "string") continue;
    const id = parsePrUrl(url);
    if (id && !out.some(([r, n]) => eqi(r, id[0]) && n === id[1])) out.push(id);
  }
  return out;
}

export class Links {
  constructor(private aura: DaemonApi) {}

  private call<T>(name: string, params: unknown): Promise<T> {
    return this.aura.mods.call<T>("github", name, params);
  }

  /** Session id -> PR URLs, for every session the github mod has links for. */
  async all(): Promise<Record<string, string[]>> {
    try {
      const v = await this.call<Record<string, string[]>>("sessions.prs", {});
      return v && typeof v === "object" ? v : {};
    } catch (e) {
      console.debug(`session links unavailable: ${message(e)}`);
      return {};
    }
  }

  /** The PRs of sessions the user still has (not archived), in session order. */
  async unarchivedPrs(sessions?: Session[]): Promise<PrId[]> {
    const list = sessions ?? (await this.aura.sessions.list());
    const links = await this.all();
    const out: PrId[] = [];
    for (const s of list.filter((s) => !s.archived)) {
      for (const id of prIds(links[s.id])) if (!out.some((x) => x[0] === id[0] && x[1] === id[1])) out.push(id);
    }
    return out;
  }

  /** Whether review activity may go to the session (the links dialog can turn it off). */
  async followsReviews(sessionId: string): Promise<boolean> {
    try {
      return (await this.call<boolean>("session.followsReviews", { sessionId })) !== false;
    } catch (e) {
      console.debug(`follow-up preference of ${sessionId} unavailable: ${message(e)}`);
      return true;
    }
  }

  /** Record the PR opened from the session's branch. */
  record(sessionId: string, url: string): Promise<unknown> {
    return this.call("pulls.record", { sessionId, url });
  }
}
