/**
 * Global state. One zustand store: connection, sessions, per-session
 * transcripts (rebuilt from events), providers and UI state.
 */
import { create } from "zustand";
import type {
  Approval,
  ApprovalDecision,
  Event,
  Item,
  ItemDelta,
  ProviderInfo,
  Session,
  StoredEvent,
  Turn,
  UserInputRequest,
  Workspace,
} from "../gen";
import type { RpcClient, ConnectionState } from "../lib/rpc";
/** Sessions from an older daemon may lack `attention`. */
const normalizeSession = (session: Session): Session => ({ ...session, attention: session.attention ?? null });
import { folderOf } from "../lib/sessionFolder";
import { categoryOf, forestOf, waitsOnUser, type SessionCategory } from "./forest";
import { planContent, type SessionPlan } from "../views/sessionPlans";
import { dropFeature, setFeature, setRoleSuggestions } from "./features";
import * as T from "./tabs";
import type { Tab, TabTarget } from "./tabs";

export type Notice = { id: string; level: "info" | "warn" | "error"; message: string; ts: number };

export type Transcript = {
  planSnapshots?: Record<string, SessionPlan>;
  loaded: boolean;
  loading: boolean;
  lastSeq: number;
  turns: Turn[];
  /** ordered item ids */
  order: string[];
  items: Record<string, Item>;
  approvals: Record<string, Approval>;
  inputs: Record<string, UserInputRequest>;
  notices: Notice[];
  providerInfo: Record<string, unknown>;
  /** latest diff pushed by the provider (Codex turn/diff/updated) */
  turnDiff?: string;
};

export type ModView = { modId: string; id: string; props?: unknown };

export type WaitingSound = "chime" | "bell" | "pop" | "soft" | "custom" | "none";

export type FocusRegion = "sidebar" | "main" | "composer" | "inspector";

/** The sidebar's two lists: sessions started by hand or by an orchestrator, and those scheduled tasks started. */
export type SidebarTab = "sessions" | "scheduled";

export type Dialog =
  /** A dialog a mod registered (`ctx.ui.dialog`). */
  | { kind: "mod"; modId: string; id: string; props?: unknown }
  | { kind: "none" }
  /** `featureOwner` starts on a feature owner. */
  | { kind: "new-session"; provider?: string; cwd?: string; featureOwner?: boolean }
  | { kind: "import" }
  | { kind: "settings"; tab?: "general" | "keymap" | "providers" | "prompts" | "orchestrators" | "specialists" | "groups" }
  | { kind: "search" }
  | { kind: "inbox" }
  /** Remote computers: the list, or pairing (`add`: a new one; `repair`: that one again). */
  | { kind: "computers"; add?: boolean; repair?: string }
  | { kind: "diff"; sessionId: string; path?: string }
  | { kind: "rename"; sessionId: string }
  | { kind: "system-prompt"; sessionId: string }
  | { kind: "schedules"; taskId?: string; create?: boolean }
  /** Clean up local branches of the repository at `cwd`, or of the one whose GitHub remote is `repo`. */
  | { kind: "git-cleanup"; cwd?: string; repo?: string }
  | { kind: "group"; sessionId: string }
  | { kind: "models"; sessionId: string }
  | { kind: "effort"; sessionId: string }
  | { kind: "permission"; sessionId: string }
  | { kind: "sandbox"; sessionId: string }
  | { kind: "slash"; sessionId: string }
  | { kind: "steps"; sessionId: string; groupId: string }
  /** `confirmLabel` names the confirm button ("Confirm" by default); `focusCancel` starts on Cancel. */
  | { kind: "confirm"; title: string; message: string; onConfirm: () => void; danger?: boolean; confirmLabel?: string; focusCancel?: boolean }
  /** Create a workspace, or rename `id`. `moveSessionId`: once created, move that session (and its workers) into it. */
  | { kind: "workspace-edit"; id?: string; moveSessionId?: string }
  /** Delete workspace `id`, moving what it holds to another. */
  | { kind: "workspace-delete"; id: string }
  /** Move session `sessionId` (and its workers) to another workspace. */
  | { kind: "workspace-move"; sessionId: string }
  /** Move sessions of other workspaces into the active one. */
  | { kind: "workspace-gather" }
  /** Delete worker sessions: of one orchestrator, or of the active workspace (`scope`). */
  | { kind: "workers-cleanup"; orchestratorId?: string; scope?: "workspace" | "all" }
  | { kind: "image"; caption: string; preview: string | null; load?: () => Promise<Blob> }
  | { kind: "help" };

/** A button on a toast; clicking it runs `run` and dismisses the toast. */
export type ToastAction = { label: string; run: () => void };
export type Toast = { id: number; level: "info" | "warn" | "error"; message: string; actions?: ToastAction[] };
export type ToastOptions = { actions?: ToastAction[] };

export type WhichKeyState = { prefix: string[]; candidates: { key: string; label: string }[] } | null;

/** The computer id of this computer (its own daemon); a remote computer's is its server id. */
export const LOCAL = "local";

export type AppState = {
  /** The daemon the window shows: this computer's, or a remote computer's (see `computer`). */
  client: RpcClient | null;
  /**
   * The computer the window shows: `LOCAL`, or a remote computer's id
   * (state/computers.ts). Sessions, transcripts, the inbox's actions and the
   * new-session dialog work on it; the app's own settings, mods and scheduled
   * tasks always on this computer (`localClient`).
   */
  computer: string;
  /** This computer's daemon, whichever computer is shown. */
  localClient: RpcClient | null;
  connection: ConnectionState;
  connectionError: string | null;
  daemonVersion: string | null;
  providers: ProviderInfo[];
  sessions: Record<string, Session>;
  sessionOrder: string[];
  /**
   * The session on screen: the active tab's when it is a session tab. Kept while a
   * mod tab is active (the last session shown), null when no tab is active.
   */
  selectedId: string | null;
  /** A mod's main-area view, shown instead of the selected session: the active tab's when it is a mod tab. */
  modView: ModView | null;
  /** The main area's tabs, left to right (see state/tabs.ts). Saved across restarts. */
  tabs: Tab[];
  /** Key of the tab shown, null when none is. */
  activeTab: string | null;
  /** Tab keys, least recently active first; the tab cap closes from the front. */
  recentTabs: string[];
  /** Tabs the user closed, the latest last, for `reopenClosedTab`. */
  closedTabs: Tab[];
  transcripts: Record<string, Transcript>;
  // ui
  focus: FocusRegion;
  paletteOpen: boolean;
  paletteQuery: string;
  whichKey: WhichKeyState;
  hintMode: boolean;
  dialog: Dialog;
  toasts: Toast[];
  inspectorOpen: boolean;
  sidebarCollapsed: boolean;
  sidebarFilter: string;
  showArchived: boolean;
  /** highlighted item in the transcript (keyboard navigation) */
  cursorItemId: string | null;
  /** highlighted session row in sidebar (may differ from selected) */
  sidebarCursor: string | null;
  /** Leaders whose workers the sidebar lists; the others show only the workers that wait on the user. Saved across restarts. */
  expandedOrchestras: string[];
  /** Orchestrators under a leader whose workers the sidebar hides; they open with their leader otherwise. Saved across restarts. */
  collapsedSubOrchestras: string[];
  /** Every workspace, in order. Empty against a daemon from before workspaces: nothing is scoped then. */
  workspaces: Workspace[];
  /** The workspace the sidebar shows. Per window, saved across restarts. */
  activeWorkspace: string | null;
  /** The session last selected in each workspace, to come back to on switching. Saved across restarts. */
  lastSelectedByWorkspace: Record<string, string>;
  /** The sidebar tab shown. Saved across restarts. */
  sidebarTab: SidebarTab;
  /** Sidebar sections folded to their heading, by `groupKey`. Saved across restarts. */
  collapsedGroups: string[];
  settings: UiSettings;
  // actions
  setClient: (c: RpcClient | null) => void;
  setLocalClient: (c: RpcClient | null) => void;
  setConnection: (s: ConnectionState, err?: string | null) => void;
  setProviders: (p: ProviderInfo[]) => void;
  setSessions: (s: Session[]) => void;
  upsertSession: (s: Session) => void;
  removeSession: (id: string) => void;
  /** Move a session next to `targetId` in the sidebar, if both share a group and pin state. */
  moveSessionTo: (id: string, targetId: string) => void;
  /** Move a session one row up (-1) or down (1) within its group. */
  moveSessionBy: (id: string, delta: -1 | 1) => void;
  /** Show session `id` in its tab, opened as a preview tab if it has none; null shows no tab. */
  select: (id: string | null) => void;
  /** Show `target` in its tab; a new one is a preview tab unless `preview` is false. */
  openTab: (target: TabTarget, opts?: { preview?: boolean }) => void;
  activateTab: (key: string) => void;
  /** Close the tab `key`, by default the active one. */
  closeTab: (key?: string) => void;
  /** Make the tab `key` (by default the active one) a normal tab rather than a preview. */
  keepTab: (key?: string) => void;
  reopenClosedTab: () => void;
  /** Activate the tab `delta` places right (left when negative), wrapping around. */
  cycleTab: (delta: number) => void;
  /** Activate tab `n`, counting from 1; 9 is the last. */
  goToTab: (n: number) => void;
  /** Move the tab `key` to position `index`. */
  moveTab: (key: string, index: number) => void;
  /** Close every tab of mod `modId` (it unloaded). */
  closeModTabs: (modId: string) => void;
  /** Put back the tabs saved at the last run (see `TABS_KEY`); done once sessions are loaded. */
  restoreTabs: () => void;
  applyEvent: (ev: Event) => void;
  loadHistory: (id: string, events: StoredEvent[]) => void;
  ensureTranscript: (id: string) => void;
  /** Load a session's history unless it is loaded or loading. */
  loadTranscript: (id: string) => void;
  markLoading: (id: string, loading: boolean) => void;
  setFocus: (f: FocusRegion) => void;
  setPalette: (open: boolean, query?: string) => void;
  setWhichKey: (w: WhichKeyState) => void;
  setHintMode: (on: boolean) => void;
  openDialog: (d: Dialog) => void;
  closeDialog: () => void;
  openModView: (v: ModView) => void;
  closeModView: () => void;
  toast: (message: string, level?: Toast["level"], opts?: ToastOptions) => void;
  dismissToast: (id: number) => void;
  setInspectorOpen: (open: boolean) => void;
  setSidebarCollapsed: (c: boolean) => void;
  setSidebarFilter: (q: string) => void;
  setShowArchived: (v: boolean) => void;
  setCursorItem: (id: string | null) => void;
  setSidebarCursor: (id: string | null) => void;
  /** Open or close the nested list of a leader, or of an orchestrator under one. */
  setOrchestraExpanded: (id: string, expanded: boolean) => void;
  setWorkspaces: (list: Workspace[]) => void;
  /** Show workspace `id`: back to the session last selected there, the filter cleared. */
  switchWorkspace: (id: string) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  /** Fold or unfold the section `section` of `tab` (see `groupKey`). */
  setGroupCollapsed: (tab: SidebarTab, section: string, collapsed: boolean) => void;
  setSettings: (patch: Partial<UiSettings>) => void;
  setTurnDiff: (sessionId: string, diff: string) => void;
};

export type UiSettings = {
  leader: string;
  keymapPreset: "default" | "vim";
  keymapOverrides: { keys: string; command: string; when?: string }[];
  /** "dark", "light", "system", or the id of a user theme (state/themes.ts). */
  theme: string;
  fontSize: number;
  notifications: boolean;
  confirmDelete: boolean;
  defaultProvider: string;
  defaultCwd: string;
  showReasoning: boolean;
  /** The message box formats markdown as you type; off, it is a plain markdown textbox. */
  composerRich: boolean;
  summonShortcut: string;
  /** Played when a session goes from working to waiting for you; "custom" plays `waitingSoundFile`. */
  waitingSound: WaitingSound;
  /** 0 to 1. */
  waitingSoundVolume: number;
  /** A data: URL of the user's own sound. */
  waitingSoundFile: string | null;
  /** Also while Aura is in front and the session is the one on screen. */
  waitingSoundWhenViewing: boolean;
  /** Check for a new version at startup and every 6 hours (release builds). */
  autoCheckUpdates: boolean;
};

export const defaultSettings: UiSettings = {
  leader: "ctrl+space",
  keymapPreset: "default",
  keymapOverrides: [],
  theme: "dark",
  fontSize: 13,
  notifications: true,
  confirmDelete: true,
  defaultProvider: "claude",
  defaultCwd: "",
  showReasoning: true,
  composerRich: true,
  summonShortcut: "CmdOrCtrl+Shift+A",
  waitingSound: "chime",
  waitingSoundVolume: 0.6,
  waitingSoundFile: null,
  waitingSoundWhenViewing: false,
  autoCheckUpdates: true,
};

export function emptyTranscript(): Transcript {
  return {
    loaded: false,
    loading: false,
    lastSeq: 0,
    turns: [],
    order: [],
    items: {},
    approvals: {},
    inputs: {},
    notices: [],
    providerInfo: {},
  };
}

let toastId = 1;
let noticeId = 1;

function applyDelta(item: Item, delta: ItemDelta): Item {
  if (delta.kind === "text") return { ...item, text: item.text + delta.text };
  if (delta.kind === "output") {
    const prev = (item.data as { output?: string }).output ?? "";
    return { ...item, data: { ...item.data, output: prev + delta.text } };
  }
  return { ...item, data: { ...item.data, ...delta.data } };
}

/** Claude Code's "API retry n/m: …" warnings (see aura-provider-claude). */
export function isRetryNotice(n: Notice): boolean {
  return n.message.startsWith("API retry ");
}

function applyToTranscript(t: Transcript, ev: Event): Transcript {
  // Retain plans delivered outside regular items, including resolved approvals.
  const source = ev.type === "provider_info" && ev.info.kind === "plan" ? ev.info
    : ev.type === "approval_requested" ? ev.approval.payload : null;
  const content = source ? planContent(source) : null;
  if (content) {
    const id = ev.type === "approval_requested" ? `approval:${ev.approval.id}` : `plan:${String(source?.turn_id ?? "current")}`;
    t = { ...t, planSnapshots: { ...t.planSnapshots, [id]: { id, title: "Agent plan", ...content, position: t.order.length * 2 + 1 } } };
  }
  switch (ev.type) {
    case "turn_started": {
      const turns = t.turns.filter((x) => x.id !== ev.turn.id).concat(ev.turn);
      return { ...t, turns };
    }
    case "turn_completed": {
      const turns = t.turns.map((x) => (x.id === ev.turn.id ? ev.turn : x));
      if (!turns.some((x) => x.id === ev.turn.id)) turns.push(ev.turn);
      // An API retry that was followed by a completed turn succeeded; the warning is stale.
      if (ev.turn.status === "completed" && t.notices.some(isRetryNotice)) t = { ...t, notices: t.notices.filter((n) => !isRetryNotice(n)) };
      return { ...t, turns };
    }
    case "item_started": {
      const exists = ev.item.id in t.items;
      const existing = t.items[ev.item.id];
      // keep already streamed text if the started event arrives late
      const merged = existing ? { ...ev.item, text: existing.text || ev.item.text, data: { ...ev.item.data, ...existing.data } } : ev.item;
      return { ...t, items: { ...t.items, [ev.item.id]: merged }, order: exists ? t.order : [...t.order, ev.item.id] };
    }
    case "item_delta": {
      const cur = t.items[ev.item_id];
      if (!cur) return t;
      return { ...t, items: { ...t.items, [ev.item_id]: applyDelta(cur, ev.delta) } };
    }
    case "item_completed": {
      const exists = ev.item.id in t.items;
      return { ...t, items: { ...t.items, [ev.item.id]: ev.item }, order: exists ? t.order : [...t.order, ev.item.id] };
    }
    case "approval_requested":
      return { ...t, approvals: { ...t.approvals, [ev.approval.id]: ev.approval } };
    case "approval_resolved": {
      const { [ev.approval_id]: _gone, ...rest } = t.approvals;
      void _gone;
      return { ...t, approvals: rest };
    }
    case "user_input_requested":
      return { ...t, inputs: { ...t.inputs, [ev.request.id]: ev.request } };
    case "user_input_resolved": {
      const { [ev.request_id]: _gone, ...rest } = t.inputs;
      void _gone;
      return { ...t, inputs: rest };
    }
    case "notices_cleared":
      return { ...t, notices: [] };
    case "notice": {
      const n: Notice = { id: String(noticeId++), level: ev.level, message: ev.message, ts: Date.now() };
      return { ...t, notices: [...t.notices.slice(-49), n] };
    }
    case "provider_info": {
      const info = ev.info as Record<string, unknown>;
      const kind = typeof info.kind === "string" ? (info.kind as string) : "init";
      if (kind === "turn_diff" && typeof info.diff === "string") return { ...t, turnDiff: info.diff, providerInfo: { ...t.providerInfo, [kind]: info } };
      return { ...t, providerInfo: { ...t.providerInfo, [kind]: info } };
    }
    case "process_exited": {
      // Anything still in progress is over.
      const items = { ...t.items };
      for (const id of t.order) {
        const it = items[id];
        if (it && it.status === "in_progress") items[id] = { ...it, status: ev.message ? "failed" : "completed" };
      }
      const turns = t.turns.map((x) => (x.status === "running" ? { ...x, status: ev.message ? ("failed" as const) : ("interrupted" as const) } : x));
      return { ...t, items, turns, approvals: {}, inputs: {} };
    }
    default:
      return t;
  }
}

const ORDER_KEY = "aura.session-order.v1";
const SETTINGS_KEY = "aura.settings.v1";
/** Before leaders-only: the orchestrators collapsed. Dropped, so every leader starts collapsed. */
const OLD_COLLAPSED_KEY = "aura.sidebar-collapsed.v1";
const EXPANDED_KEY = "aura.sidebar-expanded.v1";
const SUB_COLLAPSED_KEY = "aura.sidebar-collapsed-sub.v1";
const WORKSPACE_KEY = "aura.workspace";
const LAST_SELECTED_KEY = "aura.workspace-last-selected.v1";
const TAB_KEY = "aura.sidebar-tab.v1";
const GROUPS_KEY = "aura.sidebar-collapsed-groups.v1";

/**
 * Whether what the sidebar keeps across restarts (order, open orchestrators,
 * workspace, tabs) is saved: only while this computer is shown. A remote
 * computer's is kept in memory (state/computers.ts), so showing one never
 * overwrites this computer's.
 */
let persistLocal = true;
export function setPersistLocal(on: boolean) {
  persistLocal = on;
}

/** A detached single-session window (`?window=session`): one tab, never saved, so it leaves the main window's tabs alone. */
const detachedWindow = typeof location !== "undefined" && new URLSearchParams(location.search).get("window") === "session";
/** The saved tabs come back once, when the sessions first load; until then nothing overwrites them. */
let tabsRestorePending = !detachedWindow;

function tabsOf(st: AppState): T.TabsState {
  return { tabs: st.tabs, activeTab: st.activeTab, recentTabs: st.recentTabs, closedTabs: st.closedTabs };
}

/**
 * The store fields for tabs `next`. When the tab shown changes, `selectedId` /
 * `modView` follow it: a session tab selects its session, a mod tab opens its view
 * (the last session stays selected underneath), no tab selects nothing.
 */
function tabsPatch(st: AppState, next: T.TabsState): Partial<AppState> {
  if (detachedWindow) next = { ...next, tabs: next.tabs.filter((t) => t.key === next.activeTab), recentTabs: [], closedTabs: [] };
  const patch: Partial<AppState> = { tabs: next.tabs, activeTab: next.activeTab, recentTabs: next.recentTabs, closedTabs: next.closedTabs };
  const before = st.tabs.find((t) => t.key === st.activeTab);
  const after = next.tabs.find((t) => t.key === next.activeTab);
  if (before !== after) {
    if (!after) Object.assign(patch, { selectedId: null, modView: null });
    else if (after.kind === "session") Object.assign(patch, { selectedId: after.sessionId, modView: null, sidebarCursor: after.sessionId });
    else Object.assign(patch, { modView: { modId: after.modId, id: after.viewId, props: after.props } });
    if (before?.key !== after?.key) patch.cursorItemId = null;
  }
  if (!detachedWindow && !tabsRestorePending && persistLocal && (next.tabs !== st.tabs || next.activeTab !== st.activeTab)) T.saveTabs(next);
  return patch;
}

export const useStore = create<AppState>((set, get) => ({
  client: null,
  computer: LOCAL,
  localClient: null,
  connection: "closed",
  connectionError: null,
  daemonVersion: null,
  providers: [],
  sessions: {},
  sessionOrder: loadOrder(),
  selectedId: null,
  modView: null,
  tabs: [],
  activeTab: null,
  recentTabs: [],
  closedTabs: [],
  transcripts: {},
  focus: "sidebar",
  paletteOpen: false,
  paletteQuery: "",
  whichKey: null,
  hintMode: false,
  dialog: { kind: "none" },
  toasts: [],
  inspectorOpen: true,
  sidebarCollapsed: false,
  sidebarFilter: "",
  showArchived: false,
  cursorItemId: null,
  sidebarCursor: null,
  expandedOrchestras: loadExpanded(),
  collapsedSubOrchestras: loadIds(SUB_COLLAPSED_KEY),
  workspaces: [],
  activeWorkspace: loadWorkspace(),
  lastSelectedByWorkspace: loadLastSelected(),
  sidebarTab: loadTab(),
  collapsedGroups: loadIds(GROUPS_KEY),
  settings: loadSettings(),

  setClient: (client) => set({ client }),
  setLocalClient: (localClient) => set({ localClient }),
  setConnection: (connection, err = null) => set({ connection, connectionError: err }),
  setProviders: (providers) => set({ providers }),
  setSessions: (list) => {
    const sessions: Record<string, Session> = {};
    for (const s of list) sessions[s.id] = normalizeSession(s);
    set({
      sessions,
      sessionOrder: saveOrder(mergeOrder(get().sessionOrder, list)),
      expandedOrchestras: saveIds(EXPANDED_KEY, get().expandedOrchestras.filter((c) => sessions[c])),
      collapsedSubOrchestras: saveIds(SUB_COLLAPSED_KEY, get().collapsedSubOrchestras.filter((c) => sessions[c])),
    });
    if (tabsRestorePending && persistLocal) get().restoreTabs();
    // Tabs of sessions deleted while Aura was away close.
    const st = get();
    const cur = tabsOf(st);
    const next = T.dropTabs(cur, (t) => t.kind === "session" && !sessions[t.sessionId]);
    if (next !== cur) set(tabsPatch(st, next));
  },
  upsertSession: (s) => {
    const prev = get().sessions[s.id];
    const sessions = { ...get().sessions, [s.id]: normalizeSession(s) };
    const order = get().sessionOrder;
    set(order.includes(s.id) ? { sessions } : { sessions, sessionOrder: saveOrder([...order, s.id]) });
    // Archiving a session closes its tab.
    if (prev && !prev.archived && s.archived) {
      const st = get();
      set(tabsPatch(st, T.dropTabs(tabsOf(st), (t) => t.kind === "session" && t.sessionId === s.id)));
    }
  },
  removeSession: (id) => {
    const st = get();
    const { [id]: _gone, ...sessions } = st.sessions;
    void _gone;
    const { [id]: _t, ...transcripts } = st.transcripts;
    void _t;
    // Its tab closes, and the tab next to it shows.
    const tabs = tabsPatch(st, T.dropTabs(tabsOf(st), (t) => t.kind === "session" && t.sessionId === id));
    const selectedId = "selectedId" in tabs ? tabs.selectedId : st.selectedId === id ? null : st.selectedId;
    set({ ...tabs, sessions, transcripts, selectedId, sessionOrder: saveOrder(st.sessionOrder.filter((o) => o !== id)) });
  },
  moveSessionTo: (id, targetId) => {
    const st = get();
    const list = selectVisibleSessions(st);
    const from = list.findIndex((s) => s.id === id);
    const to = list.findIndex((s) => s.id === targetId);
    if (from < 0 || to < 0 || from === to || !canReorder(list[from], list[to], st.sessions)) return;
    const order = st.sessionOrder.filter((o) => o !== id);
    // Moving up lands above the target, moving down lands below it.
    order.splice(order.indexOf(targetId) + (to > from ? 1 : 0), 0, id);
    set({ sessionOrder: saveOrder(order) });
  },
  moveSessionBy: (id, delta) => {
    // Step over the rows it cannot swap with, such as pinned sessions.
    const list = selectVisibleSessions(get());
    const from = list.findIndex((s) => s.id === id);
    if (from < 0) return;
    for (let i = from + delta; i >= 0 && i < list.length; i += delta) {
      if (canReorder(list[from], list[i], get().sessions)) return get().moveSessionTo(id, list[i].id);
    }
  },
  // Selecting a worker of a collapsed leader, from a report or a link, opens its leader;
  // a session in another workspace, on the other tab, or in a folded section, from ⌘K or a
  // notification, shows its workspace, tab and section.
  select: (id) => {
    let st = get();
    const s = id ? st.sessions[id] : undefined;
    if (s && st.workspaces.some((w) => w.id === s.workspace) && s.workspace !== activeWorkspaceOf(st)) {
      enterWorkspace(s.workspace);
      st = get();
    }
    const tab = s ? tabOf(s, st.sessions) : st.sidebarTab;
    const key = s ? groupKey(tab, sectionIn(s, st)) : null;
    const groups = key && st.collapsedGroups.includes(key) ? saveIds(GROUPS_KEY, st.collapsedGroups.filter((g) => g !== key)) : st.collapsedGroups;
    // Its tab shows, opened as a preview tab when it has none (see state/tabs.ts).
    const tabs = id ? T.openTab(tabsOf(st), { kind: "session", sessionId: id }, true) : T.activateTab(tabsOf(st), null);
    const ws = s && st.workspaces.length ? s.workspace : null;
    set({
      ...tabsPatch(st, tabs),
      modView: null, selectedId: id, cursorItemId: null, sidebarCursor: id,
      ...revealIn(st, id), collapsedGroups: groups, sidebarTab: tab === st.sidebarTab ? tab : saveTab(tab),
      ...(ws && id && st.lastSelectedByWorkspace[ws] !== id ? { lastSelectedByWorkspace: saveLastSelected({ ...st.lastSelectedByWorkspace, [ws]: id }) } : {}),
    });
  },
  openTab: (target, opts) => {
    if (target.kind === "session" && opts?.preview !== false) return get().select(target.sessionId);
    const st = get();
    set(tabsPatch(st, T.openTab(tabsOf(st), target, opts?.preview ?? true)));
    if (target.kind === "session") get().select(target.sessionId);
  },
  activateTab: (key) => {
    const st = get();
    const tab = st.tabs.find((t) => t.key === key);
    // A session tab shows the way `select` shows it, unfolding its place in the sidebar.
    if (tab?.kind === "session") return get().select(tab.sessionId);
    set(tabsPatch(st, T.activateTab(tabsOf(st), key)));
  },
  closeTab: (key) => {
    const st = get();
    set(tabsPatch(st, T.closeTab(tabsOf(st), key ?? st.activeTab)));
  },
  keepTab: (key) => {
    const st = get();
    set(tabsPatch(st, T.keepTab(tabsOf(st), key ?? st.activeTab)));
  },
  reopenClosedTab: () => {
    const st = get();
    set(tabsPatch(st, T.reopenTab(tabsOf(st), (t) => t.kind !== "session" || !!st.sessions[t.sessionId])));
  },
  cycleTab: (delta) => {
    const next = T.cycleTab(tabsOf(get()), delta);
    if (next.activeTab) get().activateTab(next.activeTab);
  },
  goToTab: (n) => {
    const next = T.nthTab(tabsOf(get()), n);
    if (next.activeTab) get().activateTab(next.activeTab);
  },
  moveTab: (key, index) => {
    const st = get();
    set(tabsPatch(st, T.moveTab(tabsOf(st), key, index)));
  },
  closeModTabs: (modId) => {
    const st = get();
    set(tabsPatch(st, T.dropTabs(tabsOf(st), (t) => t.kind === "mod" && t.modId === modId)));
  },
  restoreTabs: () => {
    if (detachedWindow || !persistLocal) return;
    tabsRestorePending = false;
    const saved = T.loadSavedTabs();
    const st = get();
    if (saved) set(tabsPatch(st, T.restoreTabs(tabsOf(st), saved, (id) => !!st.sessions[id])));
  },
  ensureTranscript: (id) => {
    if (!get().transcripts[id]) set({ transcripts: { ...get().transcripts, [id]: emptyTranscript() } });
  },
  loadTranscript: (id) => {
    const st = get();
    const t = st.transcripts[id];
    const client = st.client;
    if (!client || t?.loaded || t?.loading) return;
    st.ensureTranscript(id);
    st.markLoading(id, true);
    // An answer that comes after the window moved to another computer (or daemon) is the old one's: dropped.
    client
      .history(id)
      .then((events) => {
        if (get().client === client) get().loadHistory(id, events);
      })
      .catch((e) => {
        if (get().client !== client) return;
        get().markLoading(id, false);
        get().toast(`history: ${e instanceof Error ? e.message : e}`, "error");
      });
  },
  markLoading: (id, loading) => {
    const t = get().transcripts[id] ?? emptyTranscript();
    set({ transcripts: { ...get().transcripts, [id]: { ...t, loading } } });
  },
  applyEvent: (ev) => {
    const st = get();
    if (ev.type === "session_created" || ev.type === "session_updated") {
      st.upsertSession(ev.session);
      return;
    }
    if (ev.type === "session_removed") {
      st.removeSession(ev.session_id);
      dropFeature(ev.session_id);
      return;
    }
    if (ev.type === "feature_updated") {
      setFeature(ev.feature);
      return;
    }
    if (ev.type === "specialist_suggestions_updated") {
      setRoleSuggestions(ev.suggestions);
      return;
    }
    // Belongs to no session.
    if (ev.type === "workspaces_changed") {
      st.setWorkspaces(ev.workspaces);
      return;
    }
    const sid = ev.session_id;
    const t = st.transcripts[sid] ?? emptyTranscript();
    set({ transcripts: { ...st.transcripts, [sid]: applyToTranscript(t, ev) } });
  },
  loadHistory: (id, events) => {
    let t = emptyTranscript();
    for (const e of events) {
      t = applyToTranscript(t, e.event);
      t.lastSeq = Math.max(t.lastSeq, e.seq);
    }
    // events that arrived live while loading are already in the current transcript; merge them
    const live = get().transcripts[id];
    if (live) {
      for (const itemId of live.order) if (!(itemId in t.items)) t = { ...t, items: { ...t.items, [itemId]: live.items[itemId] }, order: [...t.order, itemId] };
      t = { ...t, approvals: { ...t.approvals, ...live.approvals }, inputs: { ...t.inputs, ...live.inputs } };
    }
    t.loaded = true;
    t.loading = false;
    set({ transcripts: { ...get().transcripts, [id]: t } });
  },
  setFocus: (focus) => set({ focus }),
  setPalette: (paletteOpen, paletteQuery = "") => set({ paletteOpen, paletteQuery }),
  setWhichKey: (whichKey) => set({ whichKey }),
  setHintMode: (hintMode) => set({ hintMode }),
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: { kind: "none" } }),
  // A mod's view opens in its own tab (a preview tab when new); the same view with the same props finds its tab.
  openModView: (v) => {
    const st = get();
    set({ ...tabsPatch(st, T.openTab(tabsOf(st), { kind: "mod", modId: v.modId, viewId: v.id, props: v.props }, true)), modView: v });
  },
  // Closes the mod tab shown.
  closeModView: () => {
    const st = get();
    const active = st.tabs.find((t) => t.key === st.activeTab);
    if (active?.kind === "mod") set(tabsPatch(st, T.closeTab(tabsOf(st), active.key)));
    else set({ modView: null });
  },
  toast: (message, level = "info", opts) => {
    const id = toastId++;
    const actions = opts?.actions?.length ? opts.actions : undefined;
    set({ toasts: [...get().toasts, { id, level, message, ...(actions ? { actions } : {}) }] });
    // One with a button stays long enough to reach it.
    setTimeout(() => get().dismissToast(id), actions ? 15000 : level === "error" ? 8000 : 4000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  setSidebarFilter: (sidebarFilter) => set({ sidebarFilter }),
  setShowArchived: (showArchived) => set({ showArchived }),
  setCursorItem: (cursorItemId) => set({ cursorItemId }),
  setSidebarCursor: (sidebarCursor) => set({ sidebarCursor }),
  setOrchestraExpanded: (id, expanded) => {
    const st = get();
    const s = st.sessions[id];
    // A leader is listed open; an orchestrator under one is open unless closed.
    if (!s || leaderOf(s, st.sessions) === s) {
      const rest = st.expandedOrchestras.filter((c) => c !== id);
      set({ expandedOrchestras: saveIds(EXPANDED_KEY, expanded ? [...rest, id] : rest) });
    } else {
      const rest = st.collapsedSubOrchestras.filter((c) => c !== id);
      set({ collapsedSubOrchestras: saveIds(SUB_COLLAPSED_KEY, expanded ? rest : [...rest, id]) });
    }
  },
  setWorkspaces: (workspaces) => {
    const st = get();
    const active = workspaces.some((w) => w.id === st.activeWorkspace) ? st.activeWorkspace : workspaces[0]?.id ?? null;
    set({ workspaces, activeWorkspace: active === st.activeWorkspace ? active : saveWorkspace(active) });
  },
  switchWorkspace: (id) => {
    const st = get();
    if (!st.workspaces.some((w) => w.id === id)) return;
    enterWorkspace(id);
    const after = get();
    const last = after.lastSelectedByWorkspace[id];
    const back = last && after.sessions[last]?.workspace === id ? last : null;
    const first = back ?? selectVisibleSessions(after)[0]?.id ?? null;
    // An empty workspace shows its empty state; the tabs open stay as they are.
    if (first) after.select(first);
  },
  setSidebarTab: (tab) => {
    if (tab !== get().sidebarTab) set({ sidebarTab: saveTab(tab), sidebarCursor: null });
  },
  setGroupCollapsed: (tab, section, collapsed) => {
    const key = groupKey(tab, section);
    const rest = get().collapsedGroups.filter((g) => g !== key);
    set({ collapsedGroups: saveIds(GROUPS_KEY, collapsed ? [...rest, key] : rest) });
  },
  setSettings: (patch) => {
    const settings = { ...get().settings, ...patch };
    saveSettings(settings);
    set({ settings });
  },
  setTurnDiff: (sessionId, diff) => {
    const t = get().transcripts[sessionId] ?? emptyTranscript();
    set({ transcripts: { ...get().transcripts, [sessionId]: { ...t, turnDiff: diff } } });
  },
}));

/**
 * Keeps the saved order and appends sessions it has not seen yet, oldest
 * first, so a new session never pushes existing ones (and their ⌘-numbers) down.
 */
export function mergeOrder(order: string[], list: Session[]): string[] {
  const ids = new Set(list.map((s) => s.id));
  const kept = order.filter((id) => ids.has(id));
  const known = new Set(kept);
  const added = list
    .filter((s) => !known.has(s.id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    .map((s) => s.id);
  return [...kept, ...added];
}

/**
 * Sessions can only be reordered among their own section and pinned among
 * pinned. Only leaders are reordered; workers keep their orchestrator's order.
 */
export function canReorder(a: Session, b: Session, sessions: Record<string, Session>): boolean {
  return leaderOf(a, sessions) === a && leaderOf(b, sessions) === b && rollupOf(a, sessions) === rollupOf(b, sessions) && a.pinned === b.pinned;
}

function loadOrder(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function saveOrder(order: string[]): string[] {
  if (!persistLocal) return order;
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  } catch {
    /* ignore */
  }
  return order;
}

// Another window reordered the sessions; follow it.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== ORDER_KEY) return;
    const st = useStore.getState();
    useStore.setState({ sessionOrder: mergeOrder(loadOrder(), Object.values(st.sessions)) });
  });
}

function loadExpanded(): string[] {
  try {
    localStorage.removeItem(OLD_COLLAPSED_KEY);
  } catch {
    /* ignore */
  }
  return loadIds(EXPANDED_KEY);
}

/** The fold state that shows `id`: its leader expanded, the orchestrators between them open. */
function revealIn(st: AppState, id: string | null): Pick<AppState, "expandedOrchestras" | "collapsedSubOrchestras"> {
  const s = id ? st.sessions[id] : undefined;
  const leader = s ? leaderOf(s, st.sessions) : undefined;
  if (!s || !leader || leader === s) return { expandedOrchestras: st.expandedOrchestras, collapsedSubOrchestras: st.collapsedSubOrchestras };
  const forest = forestOf(st.sessions);
  const between = new Set<string>();
  for (let o = forest.parentOf(s.id); o && o !== leader; o = forest.parentOf(o.id)) between.add(o.id);
  const sub = st.collapsedSubOrchestras.filter((c) => !between.has(c));
  return {
    expandedOrchestras: st.expandedOrchestras.includes(leader.id) ? st.expandedOrchestras : saveIds(EXPANDED_KEY, [...st.expandedOrchestras, leader.id]),
    collapsedSubOrchestras: sub.length === st.collapsedSubOrchestras.length ? st.collapsedSubOrchestras : saveIds(SUB_COLLAPSED_KEY, sub),
  };
}

/** The active workspace as the sidebar uses it: null (nothing scoped) against a daemon without workspaces. */
function activeWorkspaceOf(st: AppState): string | null {
  return st.workspaces.length ? st.activeWorkspace : null;
}

/** The workspace new sessions go into: the active one, or null against a daemon without workspaces. */
export function activeWorkspaceId(st: AppState): string | null {
  return activeWorkspaceOf(st);
}

/** Make `id` the active workspace, tell the daemon, and clear the filter; the selection is the caller's. */
function enterWorkspace(id: string) {
  const st = useStore.getState();
  if (st.activeWorkspace !== id) useStore.setState({ activeWorkspace: saveWorkspace(id), sidebarFilter: "", sidebarCursor: null });
  // A remote computer keeps no active workspace for a paired device (`workspace.touch` is this computer's).
  if (st.computer !== LOCAL) return;
  st.client?.touchWorkspace(id).catch((error: unknown) => console.warn(`Could not tell the daemon about workspace ${id}:`, error));
}

function loadWorkspace(): string | null {
  try {
    return localStorage.getItem(WORKSPACE_KEY);
  } catch {
    return null;
  }
}

function saveWorkspace(id: string | null): string | null {
  if (!persistLocal) return id;
  try {
    if (id) localStorage.setItem(WORKSPACE_KEY, id);
  } catch {
    /* ignore */
  }
  return id;
}

function loadLastSelected(): Record<string, string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(LAST_SELECTED_KEY) ?? "{}");
    return saved && typeof saved === "object" && !Array.isArray(saved)
      ? Object.fromEntries(Object.entries(saved).filter((e): e is [string, string] => typeof e[1] === "string"))
      : {};
  } catch {
    return {};
  }
}

function saveLastSelected(map: Record<string, string>): Record<string, string> {
  if (!persistLocal) return map;
  try {
    localStorage.setItem(LAST_SELECTED_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
  return map;
}

// Another window expanded or collapsed an orchestrator or a section, or switched tabs; follow it.
// The active workspace is per window, so it is not followed.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    // Other windows show this computer; a remote shown here keeps its own.
    if (!persistLocal && e.key !== GROUPS_KEY && e.key !== TAB_KEY) return;
    if (e.key === EXPANDED_KEY) useStore.setState({ expandedOrchestras: loadIds(EXPANDED_KEY) });
    if (e.key === SUB_COLLAPSED_KEY) useStore.setState({ collapsedSubOrchestras: loadIds(SUB_COLLAPSED_KEY) });
    if (e.key === GROUPS_KEY) useStore.setState({ collapsedGroups: loadIds(GROUPS_KEY) });
    if (e.key === TAB_KEY) useStore.setState({ sidebarTab: loadTab() });
  });
}

function loadIds(key: string): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function saveIds(key: string, ids: string[]): string[] {
  // Which orchestrators are open is this computer's; a section folded is the same everywhere.
  if (!persistLocal && key !== GROUPS_KEY) return ids;
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    /* ignore */
  }
  return ids;
}

function loadTab(): SidebarTab {
  try {
    return localStorage.getItem(TAB_KEY) === "scheduled" ? "scheduled" : "sessions";
  } catch {
    return "sessions";
  }
}

function saveTab(tab: SidebarTab): SidebarTab {
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    /* ignore */
  }
  return tab;
}

function loadSettings(): UiSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    // Saved by any version: a setting whose type has changed since falls back to the default.
    const saved: unknown = raw ? JSON.parse(raw) : null;
    if (saved && typeof saved === "object") {
      const kept = Object.entries(saved).filter(([key, value]) => {
        const fallback: unknown = defaultSettings[key as keyof UiSettings];
        return fallback === undefined || (Array.isArray(fallback) ? Array.isArray(value) : typeof value === typeof fallback);
      });
      return { ...defaultSettings, ...Object.fromEntries(kept) };
    }
  } catch {
    /* ignore */
  }
  return defaultSettings;
}

function saveSettings(s: UiSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

// ---- selectors --------------------------------------------------------------

/** Key of the sidebar section of the orchestrators that are in no group, with their workers. */
export const ORCHESTRATORS_SECTION = "\u0000orchestrators";
/** Start of the key of a section of the Scheduled tab: the sessions one task started. */
export const TASK_SECTION = "\u0000task:";
/** Start of the key of a section of the Sessions tab: the sessions in one state (see `categoryOf`). */
export const STATE_SECTION = "\u0000state:";

/**
 * Where a session stands for the user, which sorts the Sessions tab:
 * - `waiting`: it needs the user — a question or approval is open, or its work
 *   finished (or failed) and the user has not looked since;
 * - `working`: its agent is busy (a worker under an orchestrator counts on its own);
 * - `idle`: nothing is going on and nothing is new.
 */
export type { SessionCategory };
export { categoryOf, waitsOnUser };
export const CATEGORIES: SessionCategory[] = ["waiting", "working", "idle"];
export const CATEGORY_LABEL: Record<SessionCategory, string> = { waiting: "Waiting for you", working: "Working", idle: "Idle" };

/** The key a folded section is saved under: the tab, then the section. */
export function groupKey(tab: SidebarTab, section: string): string {
  return `${tab}:${section}`;
}

/**
 * The scheduled task `s` is a run of, or a worker of a run of: workers of a
 * scheduled orchestrator go with it to the Scheduled tab. Its own provenance
 * first, so a worker stays a scheduled run after its orchestrator is deleted;
 * then its orchestrators'.
 */
export function scheduledTaskOf(s: Session, sessions: Record<string, Session>): string | null {
  return forestOf(sessions).scheduledTaskOf(s);
}

/** The sidebar tab `s` is listed on. */
export function tabOf(s: Session, sessions: Record<string, Session>): SidebarTab {
  return scheduledTaskOf(s, sessions) ? "scheduled" : "sessions";
}

/** The section of `s` on its own tab: its leader's. */
function sectionIn(s: Session, st: AppState): string {
  const task = scheduledTaskOf(s, st.sessions);
  if (task) return TASK_SECTION + task;
  return STATE_SECTION + rollupOf(leaderOf(s, st.sessions), st.sessions);
}

/**
 * Whether a section has a heading, and so can be folded: every section but
 * the ungrouped sessions at the top when no orchestrators section is above them.
 */
export function hasHeading(section: string, sections: string[]): boolean {
  return section !== "" || sections.includes(ORCHESTRATORS_SECTION);
}

/**
 * The leader of `s`: the top of its `orchestrator_id` chain, or `s` itself
 * when it has no orchestrator. A worker whose orchestrator is gone leads;
 * orchestrators that point at each other are led by the oldest of them.
 */
export function leaderOf(s: Session, sessions: Record<string, Session>): Session {
  return forestOf(sessions).leaderOf(s);
}

/** Whether `s` is a leader: it heads its own row in the sidebar. */
export function isLeader(s: Session, sessions: Record<string, Session>): boolean {
  return leaderOf(s, sessions) === s;
}

/** The workers under `id` the sidebar counts: every one at any depth, archived ones left out (their own workers kept). */
export function treeOf(id: string, sessions: Record<string, Session>): Session[] {
  return forestOf(sessions).liveDescendantsOf(id);
}

/**
 * The state a leader's row is sectioned by, for its whole tree: it needs the
 * user if it does itself, or a worker waits on the user (a finished or failed
 * worker reports to its orchestrator, not to the user); it works while anyone
 * in the tree does; it is idle otherwise. Archived workers do not count.
 */
export function rollupOf(leader: Session, sessions: Record<string, Session>): SessionCategory {
  return forestOf(sessions).rollupOf(leader);
}

/** How urgently a session needs the user, lowest first: an open question or approval, waiting, failed, finished; null when it does not. */
export function urgencyOf(s: Session): number | null {
  if (s.pending_count > 0 || s.status === "waiting_approval" || s.status === "waiting_input") return 0;
  if (s.attention === "waiting") return 1;
  if (s.attention === "failed") return 2;
  if (s.attention === "done") return 3;
  return null;
}

/** Whether `s` is in the workspace the sidebar shows; everything is against a daemon without workspaces. */
export function inActiveWorkspace(st: AppState, s: Session): boolean {
  const active = activeWorkspaceOf(st);
  return active === null || s.workspace === active;
}

/** Whether `s` or a worker in its tree matches the sidebar filter `q` (lowercase). */
function matchesFilter(s: Session, q: string): boolean {
  return s.title.toLowerCase().includes(q) || (folderOf(s) ?? "").toLowerCase().includes(q) || (s.group ?? "").toLowerCase().includes(q) || (s.scheduled_task_name ?? "").toLowerCase().includes(q);
}

/**
 * The leaders of a sidebar tab, by section, top to bottom. On the Sessions
 * tab: waiting for you, working, idle, by each leader's roll-up (see
 * `rollupOf`); within a section, pinned leaders come first, then the saved
 * order. On the Scheduled tab: a section per task, the one that ran last
 * first, each with its newest run first. Workers have no rows here (see
 * `selectNestedRows`). Only the active workspace's leaders are listed. A
 * leader matches the filter when it or one of its workers does. The rows of a
 * folded section are left out, unless `withCollapsed` or a filter is set; a
 * folded section is then left out whole. `tab` null lists both tabs,
 * Sessions first.
 */
export function selectSessionSections(st: AppState, withCollapsed = false, tab: SidebarTab | null = st.sidebarTab): [string, Session[]][] {
  return sectionsOf(st, withCollapsed, tab, true);
}

/**
 * Remembers the last result per key while its inputs are the same objects, so
 * a selector run on an unrelated change (a transcript growing, say) costs
 * nothing and returns what it returned before.
 */
function memo<T>(key: string, deps: unknown[], compute: () => T): T {
  const hit = memos.get(key);
  if (hit && hit.deps.length === deps.length && hit.deps.every((d, i) => d === deps[i])) return hit.value as T;
  const value = compute();
  memos.set(key, { deps, value });
  return value;
}
const memos = new Map<string, { deps: unknown[]; value: unknown }>();

/** What the sidebar's lists are built from; nothing else changes them. */
const listInputs = (st: AppState) => [st.sessions, st.sessionOrder, st.sidebarFilter, st.showArchived, st.collapsedGroups, st.workspaces, st.activeWorkspace];

function sectionsOf(st: AppState, withCollapsed: boolean, tab: SidebarTab | null, scoped: boolean): [string, Session[]][] {
  return memo(`sections:${withCollapsed}:${tab}:${scoped}`, listInputs(st), () => buildSections(st, withCollapsed, tab, scoped));
}

function buildSections(st: AppState, withCollapsed: boolean, tab: SidebarTab | null, scoped: boolean): [string, Session[]][] {
  if (tab === null) return [...sectionsOf(st, withCollapsed, "sessions", scoped), ...sectionsOf(st, withCollapsed, "scheduled", scoped)];
  const q = scoped ? st.sidebarFilter.trim().toLowerCase() : "";
  const forest = forestOf(st.sessions);
  const shown: Session[] = [];
  for (const id of st.sessionOrder) {
    const s = st.sessions[id];
    if (!s || (!st.showArchived && s.archived)) continue;
    if (forest.leaderOf(s) !== s || (forest.scheduledTaskOf(s) ? "scheduled" : "sessions") !== tab) continue;
    if (scoped && !inActiveWorkspace(st, s)) continue;
    if (q && !matchesFilter(s, q) && !forest.descendantsOf(s.id).some((w) => (st.showArchived || !w.archived) && matchesFilter(w, q))) continue;
    shown.push(s);
  }
  const sections = new Map<string, Session[]>();
  if (tab === "scheduled") {
    // Newest first: the order the tasks started them in, not the saved order.
    shown.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
    for (const s of shown) {
      const key = TASK_SECTION + forest.scheduledTaskOf(s);
      if (!sections.has(key)) sections.set(key, []);
      sections.get(key)!.push(s);
    }
  } else {
    // By the state of the leader's whole tree: what waits on the user, what works, what is idle.
    for (const c of CATEGORIES) sections.set(STATE_SECTION + c, []);
    for (const s of shown) sections.get(STATE_SECTION + forest.rollupOf(s))!.push(s);
  }
  const keys = [...sections].filter(([, list]) => list.length > 0).map(([g]) => g);
  const folded = new Set(withCollapsed || q ? [] : st.collapsedGroups);
  return [...sections]
    .filter(([g, list]) => list.length > 0 && !(hasHeading(g, keys) && folded.has(groupKey(tab, g))))
    .map(([g, list]) => [g, [...list.filter((s) => s.pinned), ...list.filter((s) => !s.pinned)]]);
}

/** The nested list stops at this many rows; past it, a row opens the workers panel. */
export const NESTED_CAP = 8;

/** A row of a leader's nested list: a worker at `depth` (1 under the leader). */
export type NestedRow = { session: Session; depth: number };

/**
 * The workers listed under leader `leaderId`. Expanded: its whole tree in
 * worker order, depth first (an orchestrator under it shows its own workers
 * unless closed), at most `NESTED_CAP` rows with `overflow` set past that;
 * the selected worker and the orchestrators above it are listed whatever the
 * cap. Collapsed: the peek, the workers that wait on the user (and, while
 * filtering, those that match), with `more` the workers left out. Archived
 * workers are listed only with `showArchived`; the workers under a hidden
 * one take its place.
 */
export function selectNestedRows(st: AppState, leaderId: string): { rows: NestedRow[]; expanded: boolean; more: number; overflow: boolean; total: number } {
  const forest = forestOf(st.sessions);
  const shown = (w: Session) => st.showArchived || !w.archived;
  const all = forest.descendantsOf(leaderId).filter(shown);
  const total = all.length;
  const expanded = st.expandedOrchestras.includes(leaderId);
  if (!expanded) {
    const q = st.sidebarFilter.trim().toLowerCase();
    const rows = all.filter((w) => waitsOnUser(w) || (q && matchesFilter(w, q))).map((session) => ({ session, depth: 1 }));
    return { rows, expanded, more: total - rows.length, overflow: false, total };
  }
  const order = memo("order", [st.sessionOrder], () => new Map(st.sessionOrder.map((id, i) => [id, i])));
  const rank = (s: Session) => order.get(s.id) ?? Number.MAX_SAFE_INTEGER;
  const rows: NestedRow[] = [];
  const place = (parent: string, depth: number) => {
    const under = [...forest.childrenOf(parent)].sort((a, b) => Number(b.pinned) - Number(a.pinned) || rank(a) - rank(b));
    for (const w of under) {
      if (!shown(w)) {
        place(w.id, depth);
        continue;
      }
      rows.push({ session: w, depth });
      if (!st.collapsedSubOrchestras.includes(w.id)) place(w.id, depth + 1);
    }
  };
  place(leaderId, 1);
  const overflow = rows.length > NESTED_CAP;
  if (!overflow) return { rows, expanded, more: 0, overflow, total };
  // Past the cap, the selected worker (from ⌘K, the inbox, the rail) and its orchestrators stay.
  const keep = new Set(rows.slice(0, NESTED_CAP).map((r) => r.session.id));
  for (const id of [st.selectedId, st.sidebarCursor]) {
    for (let s = id ? st.sessions[id] : undefined; s && s.id !== leaderId; s = forest.parentOf(s.id) ?? undefined) keep.add(s.id);
  }
  return { rows: rows.filter((r) => keep.has(r.session.id)), expanded, more: 0, overflow, total };
}

/** Leaders in the order the sidebar shows them; ⌘1–9 and ⌘[ / ⌘] index into this. */
export function selectVisibleSessions(st: AppState): Session[] {
  const sections = selectSessionSections(st);
  return memo(`visible:${st.sidebarTab}`, [sections], () => sections.flatMap(([, list]) => list));
}

/**
 * Every session, in every workspace, on both tabs, folded away or not: each
 * leader in sidebar order followed by its workers, each session once. What
 * ⌘K picks from; picking one shows it (see `select`).
 */
export function selectListedSessions(st: AppState): Session[] {
  const sections = sectionsOf(st, true, null, false);
  return memo("listed", [sections, st.sessions, st.showArchived], () => {
    const forest = forestOf(st.sessions);
    return sections.flatMap(([, list]) => list.flatMap((s) => [s, ...forest.descendantsOf(s.id).filter((w) => st.showArchived || !w.archived)]));
  });
}

/**
 * What the sessions on `tab` in the active workspace need from the user, for
 * the tab's badge: their pending approvals and questions, and the most urgent
 * attention marker.
 */
export function selectTabActivity(st: AppState, tab: SidebarTab, viewedId: string | null = null): { count: number; pending: number; working: number; attention: Session["attention"] } {
  let count = 0, pending = 0, working = 0;
  let attention: Session["attention"] = null;
  for (const s of Object.values(st.sessions)) {
    if (s.archived || tabOf(s, st.sessions) !== tab || !inActiveWorkspace(st, s)) continue;
    count++;
    pending += s.pending_count;
    if (s.status === "running") working++;
    const a = s.id === viewedId ? null : s.attention;
    if (rankAttention(a) > rankAttention(attention)) attention = a;
  }
  return { count, pending, working, attention };
}

const rankAttention = (a: Session["attention"]) => (a === "waiting" ? 3 : a === "failed" ? 2 : a ? 1 : 0);

/** What a workspace holds, scheduled runs left out: its leaders, how many work, what waits on the user. */
export type WorkspaceActivity = { sessions: number; working: number; pending: number; attention: Session["attention"] };

/** The activity of every workspace, by id, for the switcher. */
export function selectWorkspaceActivity(st: AppState, viewedId: string | null = null): Record<string, WorkspaceActivity> {
  const out: Record<string, WorkspaceActivity> = {};
  for (const w of st.workspaces) out[w.id] = { sessions: 0, working: 0, pending: 0, attention: null };
  for (const s of Object.values(st.sessions)) {
    const a = out[s.workspace];
    if (!a || s.archived || scheduledTaskOf(s, st.sessions)) continue;
    a.pending += s.pending_count;
    const att = s.id === viewedId ? null : s.attention;
    if (rankAttention(att) > rankAttention(a.attention)) a.attention = att;
    if (!isLeader(s, st.sessions)) continue;
    a.sessions++;
    if (rollupOf(s, st.sessions) === "working") a.working++;
  }
  return out;
}

/** A leader in the status rail. `target` is what opening the row selects: the leader, or the worker that waits on the user. */
export type RailRow = {
  leader: Session;
  target: Session;
  workspace: Workspace | null;
  /** Pending approvals and questions over the whole tree. */
  pending: number;
  attention: Session["attention"];
  urgency: number;
  /** The workers that wait on the user. */
  waitingWorkers: Session[];
};

function railRow(st: AppState, leader: Session, viewedId: string | null): RailRow {
  const tree = treeOf(leader.id, st.sessions);
  const waitingWorkers = tree.filter(waitsOnUser).sort((a, b) => (urgencyOf(a) ?? 9) - (urgencyOf(b) ?? 9) || b.last_activity.localeCompare(a.last_activity));
  const own = categoryOf(leader) === "waiting" ? urgencyOf(leader) : null;
  const first = waitingWorkers[0];
  const target = own === null && first ? first : leader;
  let attention: Session["attention"] = null;
  for (const s of [leader, ...tree]) {
    const a = s.id === viewedId ? null : s.attention;
    if (rankAttention(a) > rankAttention(attention)) attention = a;
  }
  return {
    leader, target, waitingWorkers, attention,
    workspace: st.workspaces.find((w) => w.id === leader.workspace) ?? null,
    pending: leader.pending_count + tree.reduce((n, w) => n + w.pending_count, 0),
    urgency: Math.min(own ?? 9, first ? urgencyOf(first) ?? 9 : 9),
  };
}

/**
 * The status rail's Elsewhere block: leaders in the other workspaces that
 * need the user, by urgency then latest activity, and those whose whole tree
 * is idle, latest first. Scheduled runs and archived sessions are left out.
 * Null while there is only one workspace.
 */
export function selectRail(st: AppState, viewedId: string | null = null): { needsYou: RailRow[]; idle: RailRow[] } | null {
  if (st.workspaces.length < 2) return null;
  const needsYou: RailRow[] = [];
  const idle: RailRow[] = [];
  for (const s of Object.values(st.sessions)) {
    if (s.archived || s.workspace === st.activeWorkspace || !isLeader(s, st.sessions) || scheduledTaskOf(s, st.sessions)) continue;
    const state = rollupOf(s, st.sessions);
    if (state === "waiting") needsYou.push(railRow(st, s, viewedId));
    else if (state === "idle") idle.push(railRow(st, s, viewedId));
  }
  needsYou.sort((a, b) => a.urgency - b.urgency || b.leader.last_activity.localeCompare(a.leader.last_activity) || a.leader.id.localeCompare(b.leader.id));
  idle.sort((a, b) => b.leader.last_activity.localeCompare(a.leader.last_activity) || a.leader.id.localeCompare(b.leader.id));
  return { needsYou, idle };
}

/**
 * The status rail's Scheduled runs block: top-level runs in every workspace
 * that need the user (by urgency) or work (newest first). Idle runs are on the
 * Scheduled tab only.
 */
export function selectScheduledRail(st: AppState, viewedId: string | null = null): RailRow[] {
  const rows: { row: RailRow; state: SessionCategory }[] = [];
  for (const s of Object.values(st.sessions)) {
    if (s.archived || !isLeader(s, st.sessions) || !scheduledTaskOf(s, st.sessions)) continue;
    const state = rollupOf(s, st.sessions);
    if (state !== "idle") rows.push({ row: railRow(st, s, viewedId), state });
  }
  rows.sort((a, b) => (a.state === b.state ? 0 : a.state === "waiting" ? -1 : 1)
    || (a.state === "waiting" ? a.row.urgency - b.row.urgency : 0)
    || b.row.leader.created_at.localeCompare(a.row.leader.created_at)
    || a.row.leader.id.localeCompare(b.row.leader.id));
  return rows.map((r) => r.row);
}

export function selectPendingCount(st: AppState): number {
  let n = 0;
  for (const s of Object.values(st.sessions)) n += s.pending_count;
  return n;
}

/** This computer's daemon. Before the link sets it (and in tests), the client when this computer is shown. */
export function selectLocalClient(st: AppState): RpcClient | null {
  return st.localClient ?? (st.computer === LOCAL ? st.client : null);
}

/** Whether the window shows a remote computer. */
export function selectIsRemote(st: AppState): boolean {
  return st.computer !== LOCAL;
}

export function selectSelected(st: AppState): Session | null {
  return st.modView ? null : st.selectedId ? st.sessions[st.selectedId] ?? null : null;
}

export function selectTranscript(st: AppState, id: string | null): Transcript | null {
  return id ? st.transcripts[id] ?? null : null;
}

export type { ApprovalDecision };
