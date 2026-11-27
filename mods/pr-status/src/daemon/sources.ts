// Which PRs each session works on, as far as this mod knows by itself: the PR URLs seen in the
// session's conversation, the ones the user linked, and the ones the user unlinked (hidden). Kept
// per session in the mod's own storage, so they survive a daemon restart.
import type { DaemonApi } from "@aura/mod-sdk";
import { parsePr, prKey } from "./collect";

/** Detected PRs kept per session (the latest). */
export const MAX_DETECTED = 50;
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

export class Sources {
  private docs = new Map<string, SessionDoc>();
  private readonly store;

  constructor(aura: DaemonApi) {
    this.store = aura.storage.collection<SessionDoc>("sessions");
  }

  /** Read what was kept; forget sessions that no longer exist. */
  async load(existing: Set<string>): Promise<void> {
    for (const [id, doc] of await this.store.all()) {
      if (existing.has(id)) this.docs.set(id, { detected: doc.detected ?? [], linked: doc.linked ?? [], hidden: doc.hidden ?? [] });
      else await this.store.delete(id);
    }
  }

  private doc(id: string): SessionDoc {
    return this.docs.get(id) ?? { detected: [], linked: [], hidden: [] };
  }

  private async save(id: string, doc: SessionDoc): Promise<void> {
    this.docs.set(id, doc);
    await this.store.put(id, doc);
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
  async detect(id: string, text: string): Promise<boolean> {
    const found = prUrlsIn(text);
    if (found.length === 0) return false;
    const doc = this.doc(id);
    const fresh = found.filter((u) => !has(doc.detected, u));
    if (fresh.length === 0) return false;
    await this.save(id, { ...doc, detected: [...doc.detected, ...fresh].slice(-MAX_DETECTED) });
    return true;
  }

  /** Link `url` to the session (shown again if it was unlinked). */
  async link(id: string, url: string): Promise<string> {
    const pr = parsePr(url);
    if (!pr) throw Object.assign(new Error("Not a GitHub pull request URL"), { code: "invalid" });
    const doc = this.doc(id);
    await this.save(id, { ...doc, linked: has(doc.linked, pr.url) ? doc.linked : [...doc.linked, pr.url], hidden: without(doc.hidden, pr.url) });
    return pr.url;
  }

  /** Unlink `url` from the session: no longer linked, and hidden however it is found. */
  async unlink(id: string, url: string): Promise<void> {
    const pr = parsePr(url);
    if (!pr) throw Object.assign(new Error("Not a GitHub pull request URL"), { code: "invalid" });
    const doc = this.doc(id);
    await this.save(id, { ...doc, linked: without(doc.linked, pr.url), hidden: has(doc.hidden, pr.url) ? doc.hidden : [...doc.hidden, pr.url] });
  }

  /** Sessions that link or mention `url` (not hiding it). */
  sessionsOf(url: string): string[] {
    return [...this.docs.keys()].filter((id) => this.linkedOf(id).some((u) => prKey(u) === prKey(url)));
  }

  async forget(id: string): Promise<void> {
    this.docs.delete(id);
    await this.store.delete(id);
  }
}
