// Which PRs each session works on, as far as this mod knows by itself: the PR URLs seen in the
// session's conversation, the ones the user linked, and the ones the user unlinked (hidden). Kept
// per session in the mod's own storage, so they survive a daemon restart.
import type { DaemonApi } from "@aura/mod-sdk";
import { parsePr, prKey } from "./collect";

/** Detected PRs kept per session (the latest). */
export const MAX_DETECTED = 50;
/** Linked, and unlinked (hidden), PRs per session, at most. */
export const MAX_LIST = 100;
/** A PR URL longer than this is not taken, typed or seen. */
export const MAX_URL = 300;
/** A session's stored document, at most (JSON characters). */
export const MAX_DOC = 16_000;
/** Characters of one transcript item that are scanned for PR URLs. */
const SCAN_LIMIT = 200_000;

export interface SessionDoc {
  /** Seen in the conversation, oldest first. */
  detected: string[];
  /** Linked by the user. */
  linked: string[];
  /** Unlinked by the user: not shown, whatever finds them. */
  hidden: string[];
}

const PR_URL = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/gi;

/** The canonical PR URLs in `text`, in order, once each. */
export function prUrlsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.slice(0, SCAN_LIMIT).matchAll(PR_URL)) {
    if (m[0].length > MAX_URL) continue;
    const pr = parsePr(m[0]);
    if (pr && !out.some((u) => prKey(u) === prKey(pr.url))) out.push(pr.url);
  }
  return out;
}

/** The text of a transcript item worth scanning: its text, and its data (a command's output, a tool's result). */
export function itemText(item: { text?: string | null; data?: unknown }): string {
  let data = "";
  try {
    data = item.data === undefined || item.data === null ? "" : JSON.stringify(item.data);
  } catch {
    // not serialisable: the text alone
  }
  return `${item.text ?? ""}\n${data}`;
}

const has = (list: string[], url: string) => list.some((u) => prKey(u) === prKey(url));
const without = (list: string[], url: string) => list.filter((u) => prKey(u) !== prKey(url));

const refuse = (message: string) => Object.assign(new Error(message), { code: "invalid" });

/** A PR URL a user typed, canonical; refused when it is not one, or too long. */
function userPr(url: string): string {
  const pr = url.length <= MAX_URL ? parsePr(url) : null;
  if (!pr) throw refuse(url.length > MAX_URL ? `A URL of at most ${MAX_URL} characters, please` : "Not a GitHub pull request URL");
  return pr.url;
}

export class Sources {
  private docs = new Map<string, SessionDoc>();
  private readonly store;
  private readonly aura: DaemonApi;
  /** What was kept, read once: every operation waits for it, so none is lost to a later read. */
  readonly ready: Promise<void>;
  /** Each session's changes, one after another. */
  private chains = new Map<string, Promise<unknown>>();

  constructor(aura: DaemonApi) {
    this.aura = aura;
    this.store = aura.storage.collection<SessionDoc>("sessions");
    this.ready = this.load().catch((e) => console.warn(`PR status: could not read the sessions' PRs: ${e instanceof Error ? e.message : String(e)}`));
  }

  /** Read what was kept; forget sessions that no longer exist. */
  private async load(): Promise<void> {
    const existing = new Set((await this.aura.sessions.list()).map((s) => s.id));
    for (const [id, doc] of await this.store.all()) {
      if (existing.has(id)) this.docs.set(id, { detected: doc.detected ?? [], linked: doc.linked ?? [], hidden: doc.hidden ?? [] });
      else await this.store.delete(id);
    }
  }

  /** Run `fn` after what was kept is read, and after the session's earlier changes. */
  private change<T>(id: string, fn: () => Promise<T>): Promise<T> {
    // The session's change before this one, taken now: the chain is about to hold this one.
    const before = this.chains.get(id);
    const next = Promise.all([this.ready, before]).catch(() => {}).then(fn);
    const settled = next.catch(() => {});
    this.chains.set(id, settled);
    void settled.then(() => {
      if (this.chains.get(id) === settled) this.chains.delete(id);
    });
    return next;
  }

  private doc(id: string): SessionDoc {
    return this.docs.get(id) ?? { detected: [], linked: [], hidden: [] };
  }

  /** Store the session's document; null when it would be larger than MAX_DOC. */
  private async save(id: string, doc: SessionDoc): Promise<SessionDoc | null> {
    if (JSON.stringify(doc).length > MAX_DOC) return null;
    this.docs.set(id, doc);
    await this.store.put(id, doc);
    return doc;
  }

  /** The PRs linked to the session: the user's and the detected ones, without the hidden. */
  linkedOf(id: string): string[] {
    const doc = this.doc(id);
    return [...doc.linked, ...doc.detected].filter((u, i, all) => !has(doc.hidden, u) && all.findIndex((x) => prKey(x) === prKey(u)) === i);
  }

  isHidden(id: string, url: string): boolean {
    return has(this.doc(id).hidden, url);
  }

  /** Remember the PR URLs in `text` for the session; true when one is new. */
  detect(id: string, text: string): Promise<boolean> {
    const found = prUrlsIn(text);
    if (found.length === 0) return Promise.resolve(false);
    return this.change(id, async () => {
      const doc = this.doc(id);
      const fresh = found.filter((u) => !has(doc.detected, u));
      if (fresh.length === 0) return false;
      // The newest are kept: the oldest go until the document fits.
      let detected = [...doc.detected, ...fresh].slice(-MAX_DETECTED);
      while (detected.length && !(await this.save(id, { ...doc, detected }))) detected = detected.slice(1);
      return true;
    });
  }

  /** Link `url` to the session (shown again if it was unlinked). */
  async link(id: string, url: string): Promise<string> {
    const pr = userPr(url);
    return this.change(id, async () => {
      const doc = this.doc(id);
      if (has(doc.linked, pr) && !has(doc.hidden, pr)) return pr;
      if (!has(doc.linked, pr) && doc.linked.length >= MAX_LIST) throw refuse(`At most ${MAX_LIST} pull requests can be linked to a session`);
      const saved = await this.save(id, { ...doc, linked: has(doc.linked, pr) ? doc.linked : [...doc.linked, pr], hidden: without(doc.hidden, pr) });
      if (!saved) throw refuse("This session keeps too many pull requests to link another");
      return pr;
    });
  }

  /** Unlink `url` from the session: no longer linked, and hidden however it is found. */
  async unlink(id: string, url: string): Promise<void> {
    const pr = userPr(url);
    return this.change(id, async () => {
      const doc = this.doc(id);
      if (!has(doc.hidden, pr) && doc.hidden.length >= MAX_LIST) throw refuse(`At most ${MAX_LIST} pull requests can be unlinked from a session`);
      const saved = await this.save(id, { ...doc, linked: without(doc.linked, pr), hidden: has(doc.hidden, pr) ? doc.hidden : [...doc.hidden, pr] });
      if (!saved) throw refuse("This session keeps too many pull requests to unlink another");
    });
  }

  /** Sessions that link or mention `url` (not hiding it). */
  sessionsOf(url: string): string[] {
    return [...this.docs.keys()].filter((id) => this.linkedOf(id).some((u) => prKey(u) === prKey(url)));
  }

  forget(id: string): Promise<void> {
    return this.change(id, async () => {
      this.docs.delete(id);
      await this.store.delete(id);
    });
  }
}
