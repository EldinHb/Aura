/**
 * The main area's tabs, browser style: each open session and mod view keeps its
 * own tab. Pure functions over `TabsState`; the store (state/store.ts) holds the
 * state and projects the active tab onto `selectedId` / `modView`.
 *
 * A preview tab (VS Code style) is what `select()` and `openModView()` open: it
 * is replaced by the next preview, so walking the sidebar does not pile up tabs.
 * It becomes a normal tab when kept (a message sent in it, a double click, Enter
 * on its sidebar row, `tab.keep`). At most one preview tab exists.
 */

export type SessionTab = { key: string; kind: "session"; sessionId: string; preview: boolean };
export type ModTab = { key: string; kind: "mod"; modId: string; viewId: string; props?: unknown; title?: string; preview: boolean };
export type Tab = SessionTab | ModTab;

/** What a tab shows, before it has a key. */
export type TabTarget =
  | { kind: "session"; sessionId: string }
  | { kind: "mod"; modId: string; viewId: string; props?: unknown; title?: string };

export type TabsState = {
  tabs: Tab[];
  activeTab: string | null;
  /** Tab keys, least recently active first. */
  recentTabs: string[];
  /** Tabs the user closed, the latest last, for `tab.reopen`. */
  closedTabs: Tab[];
};

/** At most this many tabs stay open; beyond it the least recently used normal tab closes. */
export const MAX_TABS = 20;
const MAX_CLOSED = 20;

export const emptyTabs = (): TabsState => ({ tabs: [], activeTab: null, recentTabs: [], closedTabs: [] });

export function sessionTabKey(sessionId: string): string {
  return `s:${sessionId}`;
}

/** JSON with object keys sorted, so equal props give equal keys whatever order they were built in. */
export function stableJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (!v || typeof v !== "object") return v;
    if (seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = walk((v as Record<string, unknown>)[k]);
    return out;
  };
  try {
    return JSON.stringify(walk(value)) ?? "";
  } catch {
    return "";
  }
}

/** FNV-1a, as 8 hex digits: keeps keys of large props short. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * `m:<modId>:<viewId>:<identity>`. The identity is `props.key` when a mod passes a
 * string one (so a changing object, a refreshed pull request say, still finds its
 * tab), else a hash of the props' stable JSON.
 */
export function modTabKey(modId: string, viewId: string, props?: unknown): string {
  const own = props && typeof props === "object" && typeof (props as { key?: unknown }).key === "string" ? (props as { key: string }).key : null;
  return `m:${modId}:${viewId}:${own ?? hash(stableJson(props ?? null))}`;
}

export function tabKeyOf(target: TabTarget): string {
  return target.kind === "session" ? sessionTabKey(target.sessionId) : modTabKey(target.modId, target.viewId, target.props);
}

export function makeTab(target: TabTarget, preview: boolean): Tab {
  const key = tabKeyOf(target);
  if (target.kind === "session") return { key, kind: "session", sessionId: target.sessionId, preview };
  const title = target.title ?? (target.props && typeof (target.props as { title?: unknown }).title === "string" ? (target.props as { title: string }).title : undefined);
  return { key, kind: "mod", modId: target.modId, viewId: target.viewId, props: target.props, ...(title !== undefined ? { title } : {}), preview };
}

function touch(recent: string[], key: string): string[] {
  return [...recent.filter((k) => k !== key), key];
}

function insertAfterActive(tabs: Tab[], active: string | null, tab: Tab): Tab[] {
  const at = tabs.findIndex((t) => t.key === active);
  return at < 0 ? [...tabs, tab] : [...tabs.slice(0, at + 1), tab, ...tabs.slice(at + 1)];
}

/** Close the least recently used normal tabs that are not active until at most `MAX_TABS` remain. */
function cap(s: TabsState): TabsState {
  let next = s;
  while (next.tabs.length > MAX_TABS) {
    const rank = (t: Tab) => next.recentTabs.indexOf(t.key);
    const victim = next.tabs.filter((t) => t.key !== next.activeTab && !t.preview).sort((a, b) => rank(a) - rank(b))[0];
    if (!victim) break;
    next = { ...next, tabs: next.tabs.filter((t) => t !== victim), recentTabs: next.recentTabs.filter((k) => k !== victim.key) };
  }
  return next;
}

/**
 * Show `target`: its tab when one is open (a preview open of a normal tab leaves it
 * normal; a normal open of a preview keeps it), else a new tab right of the active
 * one. A new preview takes the place of the old preview tab.
 */
export function openTab(s: TabsState, target: TabTarget, preview: boolean): TabsState {
  const fresh = makeTab(target, preview);
  const existing = s.tabs.find((t) => t.key === fresh.key);
  if (existing) {
    // Same view: keep its tab with the latest props and title, a normal tab if either open was.
    const updated: Tab =
      fresh.kind === "session" && existing.preview === (existing.preview && preview)
        ? existing
        : { ...existing, ...(fresh.kind === "mod" ? { props: fresh.props, ...(fresh.title !== undefined ? { title: fresh.title } : {}) } : {}), preview: existing.preview && preview };
    if (updated === existing && s.activeTab === existing.key) return s;
    return { ...s, tabs: s.tabs.map((t) => (t === existing ? updated : t)), activeTab: existing.key, recentTabs: touch(s.recentTabs, existing.key) };
  }
  let tabs: Tab[];
  let recentTabs = s.recentTabs;
  const oldPreview = preview ? s.tabs.find((t) => t.preview) : undefined;
  if (oldPreview) {
    tabs = s.tabs.map((t) => (t === oldPreview ? fresh : t));
    recentTabs = recentTabs.filter((k) => k !== oldPreview.key);
  } else tabs = insertAfterActive(s.tabs, s.activeTab, fresh);
  return cap({ ...s, tabs, activeTab: fresh.key, recentTabs: touch(recentTabs, fresh.key) });
}

export function activateTab(s: TabsState, key: string | null): TabsState {
  if (key === null) return s.activeTab === null ? s : { ...s, activeTab: null };
  if (!s.tabs.some((t) => t.key === key) || s.activeTab === key) return s;
  return { ...s, activeTab: key, recentTabs: touch(s.recentTabs, key) };
}

/** Make a preview tab a normal one. */
export function keepTab(s: TabsState, key: string | null = s.activeTab): TabsState {
  const tab = s.tabs.find((t) => t.key === key);
  if (!tab?.preview) return s;
  return { ...s, tabs: s.tabs.map((t) => (t === tab ? { ...t, preview: false } : t)) };
}

/**
 * Close the tab `key`. Closing the active tab activates the one to its right, else
 * the one to its left. `remember` puts it on the stack `tab.reopen` takes from.
 */
export function closeTab(s: TabsState, key: string | null = s.activeTab, remember = true): TabsState {
  const at = s.tabs.findIndex((t) => t.key === key);
  if (at < 0) return s;
  const tab = s.tabs[at];
  const tabs = s.tabs.filter((_, i) => i !== at);
  const activeTab = s.activeTab !== tab.key ? s.activeTab : (tabs[at] ?? tabs[at - 1])?.key ?? null;
  const recentTabs = s.recentTabs.filter((k) => k !== tab.key);
  const closedTabs = remember ? [...s.closedTabs.filter((t) => t.key !== tab.key), { ...tab, preview: false }].slice(-MAX_CLOSED) : s.closedTabs;
  return { ...s, tabs, activeTab, recentTabs: activeTab && activeTab !== s.activeTab ? touch(recentTabs, activeTab) : recentTabs, closedTabs };
}

/** Close every tab `drop` picks, without remembering them (their session or mod went away). */
export function dropTabs(s: TabsState, drop: (t: Tab) => boolean): TabsState {
  let next = { ...s, closedTabs: s.closedTabs.filter((t) => !drop(t)) };
  for (const t of s.tabs) if (drop(t)) next = closeTab(next, t.key, false);
  return next.tabs.length === s.tabs.length && next.closedTabs.length === s.closedTabs.length ? s : next;
}

/** Reopen the most recently closed tab, as a normal tab; `exists` skips tabs whose session is gone. */
export function reopenTab(s: TabsState, exists: (t: Tab) => boolean = () => true): TabsState {
  const closed = [...s.closedTabs];
  while (closed.length > 0) {
    const tab = closed.pop()!;
    if (!exists(tab) || s.tabs.some((t) => t.key === tab.key)) continue;
    const tabs = insertAfterActive(s.tabs, s.activeTab, { ...tab, preview: false });
    return cap({ ...s, tabs, activeTab: tab.key, recentTabs: touch(s.recentTabs, tab.key), closedTabs: closed });
  }
  return closed.length === s.closedTabs.length ? s : { ...s, closedTabs: closed };
}

/** The tab `delta` places right (left when negative) of the active one, wrapping around. */
export function cycleTab(s: TabsState, delta: number): TabsState {
  if (s.tabs.length === 0) return s;
  const at = s.tabs.findIndex((t) => t.key === s.activeTab);
  const n = s.tabs.length;
  const next = at < 0 ? (delta > 0 ? 0 : n - 1) : (((at + delta) % n) + n) % n;
  return activateTab(s, s.tabs[next].key);
}

/** Tab `n`, counting from 1; 9 is the last tab, as in browsers. */
export function nthTab(s: TabsState, n: number): TabsState {
  const tab = n >= 9 ? s.tabs[s.tabs.length - 1] : s.tabs[n - 1];
  return tab ? activateTab(s, tab.key) : s;
}

/** Move the tab `key` to position `to` in the strip. */
export function moveTab(s: TabsState, key: string, to: number): TabsState {
  const from = s.tabs.findIndex((t) => t.key === key);
  if (from < 0) return s;
  const target = Math.max(0, Math.min(s.tabs.length - 1, to));
  if (target === from) return s;
  const tabs = s.tabs.filter((_, i) => i !== from);
  tabs.splice(target, 0, s.tabs[from]);
  return { ...s, tabs };
}

// ---- persistence -------------------------------------------------------------

export const TABS_KEY = "aura.main-tabs.v1";

export type SavedTabs = { tabs: Tab[]; active: string | null };

function isTab(v: unknown): v is Tab {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  if (typeof t.key !== "string") return false;
  if (t.kind === "session") return typeof t.sessionId === "string";
  return t.kind === "mod" && typeof t.modId === "string" && typeof t.viewId === "string";
}

export function loadSavedTabs(): SavedTabs | null {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { tabs?: unknown; active?: unknown };
    const tabs = Array.isArray(saved.tabs) ? saved.tabs.filter(isTab).map((t) => ({ ...t, preview: !!t.preview })) : [];
    return { tabs, active: typeof saved.active === "string" ? saved.active : null };
  } catch {
    return null;
  }
}

export function saveTabs(s: Pick<TabsState, "tabs" | "activeTab">) {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify({ tabs: s.tabs, active: s.activeTab } satisfies SavedTabs));
  } catch {
    /* storage full or unavailable */
  }
}

/**
 * The saved tabs put back in front of `s` (tabs opened since start stay, after
 * them), without the session tabs whose session is gone. The saved active tab
 * wins unless it is gone too.
 */
export function restoreTabs(s: TabsState, saved: SavedTabs, sessionExists: (id: string) => boolean): TabsState {
  const keys = new Set(s.tabs.map((t) => t.key));
  const restored: Tab[] = [];
  let preview = s.tabs.some((t) => t.preview);
  for (const t of saved.tabs) {
    if (keys.has(t.key) || (t.kind === "session" && !sessionExists(t.sessionId))) continue;
    // At most one preview tab: one opened since start wins over a saved one.
    restored.push(t.preview && preview ? { ...t, preview: false } : t);
    preview ||= t.preview;
    keys.add(t.key);
  }
  const tabs = [...restored, ...s.tabs];
  const activeTab = s.activeTab ?? (saved.active && tabs.some((t) => t.key === saved.active) ? saved.active : (tabs[0]?.key ?? null));
  return cap({ ...s, tabs, activeTab, recentTabs: [...restored.map((t) => t.key).filter((k) => k !== activeTab), ...s.recentTabs.filter((k) => k !== activeTab), ...(activeTab ? [activeTab] : [])] });
}
