// Issue and PR links of sessions, kept as this mod's per-session data. Replaces core's
// `Session.pulls` / `session.record_pull` and the settings `session.links.v1.<sid>` and
// `session.links.detected.v1.<sid>`; the values keep those shapes, so a migration copies
// them as they are:
//   links     {issues?: string[], prs?: string[], reviews?: false}  (or the older {issue, pr})
//   detected  string[]  issue and PR URLs found in the conversation
//   pulls     string[]  PR URLs opened from the session's branch
import type { DaemonApi } from "@aura/mod-sdk/daemon";
import { decodeDetected, decodePreferences, followsReviews, linkedPrs, prUrl, pullOfUrl, samePr, sessionPrs, type StoredLinks } from "../shared/links";

export const LINKS = "links";
export const DETECTED = "detected";
export const PULLS = "pulls";
/** Notification sent whenever a session's links, detected links or pulls change. */
export const CHANGED = "links.changed";

type Handle = (name: string, fn: (params: any) => unknown) => void;

/** An error the caller can tell apart: `code` survives RPC. */
export function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function sessionIdOf(params: any): string {
  const id = params?.sessionId;
  if (typeof id !== "string" || !id) throw coded("invalid", "sessionId is required");
  return id;
}

function urls(value: unknown): string[] {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? v.filter((u): u is string => typeof u === "string") : [];
}

export function registerLinks(aura: DaemonApi, handle: Handle) {
  const data = (id: string) => aura.sessions.data(id);

  const entry = async (id: string): Promise<StoredLinks> => {
    const all = await data(id).all();
    return { links: all[LINKS] ?? null, detected: all[DETECTED] ?? null, pulls: urls(all[PULLS]) };
  };

  const changed = async (id: string) => aura.emit(CHANGED, { sessionId: id, ...(await entry(id)) });

  /** Every session with any links data, with its data. */
  const everything = async (): Promise<Record<string, StoredLinks>> => {
    const out: Record<string, StoredLinks> = {};
    const at = (id: string) => (out[id] ??= { links: null, detected: null, pulls: [] });
    for (const [id, v] of await aura.sessions.withData(LINKS)) at(id).links = v;
    for (const [id, v] of await aura.sessions.withData(DETECTED)) at(id).detected = v;
    for (const [id, v] of await aura.sessions.withData(PULLS)) at(id).pulls = urls(v);
    return out;
  };

  const prsOf = (e: StoredLinks, following: boolean) => (following ? linkedPrs(e.links, e.detected) : sessionPrs(e.links, e.detected)).map(prUrl);

  handle("links.get", async (p) => entry(sessionIdOf(p)));

  handle("links.all", async () => everything());

  handle("links.set", async (p) => {
    const id = sessionIdOf(p);
    let links;
    try {
      links = decodePreferences(p?.links ?? {});
    } catch (e) {
      throw coded("invalid", e instanceof Error ? e.message : String(e));
    }
    await data(id).set(LINKS, links);
    await changed(id);
    return links;
  });


  handle("detected.set", async (p) => {
    const id = sessionIdOf(p);
    let list: string[];
    try {
      list = decodeDetected(Array.isArray(p?.urls) ? p.urls : []).map((link) => link.url);
    } catch (e) {
      throw coded("invalid", e instanceof Error ? e.message : String(e));
    }
    const before = urls((await data(id).get(DETECTED)) ?? null);
    if (before.length === list.length && before.every((u, i) => u === list[i])) return list;
    await data(id).set(DETECTED, list);
    await changed(id);
    return list;
  });

  handle("pulls.record", async (p) => {
    const id = sessionIdOf(p);
    const url = typeof p?.url === "string" ? p.url.trim() : "";
    if (!url.startsWith("https://") || !url.includes("/pull/") || url.length > 512) throw coded("invalid", `not a pull request URL: ${url}`);
    if (!(await aura.sessions.get(id))) throw coded("not_found", `no session ${id}`);
    const pulls = urls((await data(id).get(PULLS)) ?? null);
    if (pulls.some((other) => other.toLowerCase() === url.toLowerCase())) return pulls;
    pulls.push(url);
    await data(id).set(PULLS, pulls);
    await changed(id);
    return pulls;
  });

  handle("session.pulls", async (p) => (await entry(sessionIdOf(p))).pulls);

  handle("session.prs", async (p) => prsOf(await entry(sessionIdOf(p)), p?.following === true));

  handle("sessions.prs", async (p) => {
    const out: Record<string, string[]> = {};
    for (const [id, e] of Object.entries(await everything())) {
      const prs = prsOf(e, p?.following === true);
      if (prs.length) out[id] = prs;
    }
    return out;
  });

  handle("session.followsReviews", async (p) => followsReviews((await data(sessionIdOf(p)).get(LINKS)) ?? null));

  handle("pulls.sessions", async (p) => {
    const pr = typeof p?.url === "string" ? pullOfUrl(p.url) : null;
    if (!pr) throw coded("invalid", "url must be a pull request URL");
    const ids: string[] = [];
    for (const [id, e] of Object.entries(await everything())) {
      const linked = sessionPrs(e.links, e.detected).some((other) => samePr(other, pr));
      const branch = e.pulls.some((u) => {
        const other = pullOfUrl(u);
        return !!other && samePr(other, pr);
      });
      if (linked || branch) ids.push(id);
    }
    return ids;
  });
}


