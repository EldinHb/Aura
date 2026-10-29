/**
 * Global state. One zustand store: connection, sessions, per-session
 * transcripts (rebuilt from events), providers and UI state.
 */
import { create } from "zustand";
import type {
  PullRequest,
  ReviewConfig,
  SubmissionPreview,
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
} from "../gen";
import type { RpcClient, ConnectionState } from "../lib/rpc";
import { normalizeSession } from "../lib/pulls";
import { folderOf } from "../lib/sessionFolder";
import { planContent, type SessionPlan } from "../views/sessionPlans";
import { dropFeature, setFeature } from "./features";

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

export type FocusRegion = "sidebar" | "main" | "composer" | "inspector";

export type Dialog =
  | { kind: "review-settings"; pull: PullRequest; config?: ReviewConfig }
  | { kind: "review-submit"; preview: SubmissionPreview }
  | { kind: "none" }
  /** `featureOwner` starts on a feature owner. */
  | { kind: "new-session"; provider?: string; cwd?: string; featureOwner?: boolean }
  | { kind: "import" }
  | { kind: "settings"; tab?: "general" | "keymap" | "providers" | "prompts" | "orchestrators" | "specialists" | "groups" }
  | { kind: "search" }
  | { kind: "inbox" }
  | { kind: "diff"; sessionId: string; path?: string }
  | { kind: "rename"; sessionId: string }
  | { kind: "system-prompt"; sessionId: string }
  | { kind: "session-links"; sessionId: string }
  | { kind: "pr-watch"; repo: string; number: number }
  /** Clean up local branches of the repository at `cwd`, or of the one whose GitHub remote is `repo`. */
  | { kind: "git-cleanup"; cwd?: string; repo?: string }
  | { kind: "group"; sessionId: string }
  | { kind: "models"; sessionId: string }
  | { kind: "effort"; sessionId: string }
  | { kind: "permission"; sessionId: string }
  | { kind: "sandbox"; sessionId: string }
  | { kind: "slash"; sessionId: string }
  | { kind: "steps"; sessionId: string; groupId: string }
  | { kind: "confirm"; title: string; message: string; onConfirm: () => void; danger?: boolean }
  | { kind: "image"; caption: string; preview: string | null; load?: () => Promise<Blob> }
  | { kind: "help" };

export type Toast = { id: number; level: "info" | "warn" | "error"; message: string };

export type WhichKeyState = { prefix: string[]; candidates: { key: string; label: string }[] } | null;

export type AppState = {
  client: RpcClient | null;
  connection: ConnectionState;
  connectionError: string | null;
  daemonVersion: string | null;
  providers: ProviderInfo[];
  sessions: Record<string, Session>;
  sessionOrder: string[];
  selectedId: string | null;
  prSelection: PullRequest | null;
  reviewHistoryOpen: boolean;
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
  /** Orchestrators whose workers the sidebar hides. Saved across restarts. */
  collapsedOrchestras: string[];
  settings: UiSettings;
  // actions
  setClient: (c: RpcClient | null) => void;
  setConnection: (s: ConnectionState, err?: string | null) => void;
  setProviders: (p: ProviderInfo[]) => void;
  setSessions: (s: Session[]) => void;
  upsertSession: (s: Session) => void;
  removeSession: (id: string) => void;
  /** Move a session next to `targetId` in the sidebar, if both share a group and pin state. */
  moveSessionTo: (id: string, targetId: string) => void;
  /** Move a session one row up (-1) or down (1) within its group. */
  moveSessionBy: (id: string, delta: -1 | 1) => void;
  select: (id: string | null) => void;
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
  toast: (message: string, level?: Toast["level"]) => void;
  dismissToast: (id: number) => void;
  setInspectorOpen: (open: boolean) => void;
  setSidebarCollapsed: (c: boolean) => void;
  setSidebarFilter: (q: string) => void;
  setShowArchived: (v: boolean) => void;
  setCursorItem: (id: string | null) => void;
  setSidebarCursor: (id: string | null) => void;
  setOrchestraCollapsed: (id: string, collapsed: boolean) => void;
  setSettings: (patch: Partial<UiSettings>) => void;
  setTurnDiff: (sessionId: string, diff: string) => void;
};

export type UiSettings = {
  leader: string;
  keymapPreset: "default" | "vim";
  keymapOverrides: { keys: string; command: string; when?: string }[];
  theme: "dark" | "light" | "system";
  fontSize: number;
  notifications: boolean;
  confirmDelete: boolean;
  defaultProvider: string;
  defaultCwd: string;
  showReasoning: boolean;
  /** The message box formats markdown as you type; off, it is a plain markdown textbox. */
  composerRich: boolean;
  summonShortcut: string;
  /** Rules that hide matching pull requests from the sidebar; see `pullFilter`. */
  pullFilters: string[];
  /** Last chosen merge method; empty uses the repository's default. */
  mergeMethod: string;
  /** Last choice of deleting the head branch when merging. */
  deleteBranchAfterMerge: boolean;
  /** Kinds of pull request change (see `PULL_CHANGE_KINDS`) left out of the inbox and notifications. */
  pullChangesMuted: string[];
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
  pullFilters: ["author:dependabot"],
  mergeMethod: "",
  deleteBranchAfterMerge: true,
  pullChangesMuted: [],
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
const COLLAPSED_KEY = "aura.sidebar-collapsed.v1";

export const useStore = create<AppState>((set, get) => ({
  client: null,
  connection: "closed",
  connectionError: null,
  daemonVersion: null,
  providers: [],
  sessions: {},
  sessionOrder: loadOrder(),
  selectedId: null,
  prSelection: null,
  reviewHistoryOpen: false,
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
  collapsedOrchestras: loadCollapsed(),
  settings: loadSettings(),

  setClient: (client) => set({ client }),
  setConnection: (connection, err = null) => set({ connection, connectionError: err }),
  setProviders: (providers) => set({ providers }),
  setSessions: (list) => {
    const sessions: Record<string, Session> = {};
    for (const s of list) sessions[s.id] = normalizeSession(s);
    set({
      sessions,
      sessionOrder: saveOrder(mergeOrder(get().sessionOrder, list)),
      collapsedOrchestras: saveCollapsed(get().collapsedOrchestras.filter((c) => sessions[c])),
    });
  },
  upsertSession: (s) => {
    const sessions = { ...get().sessions, [s.id]: normalizeSession(s) };
    const order = get().sessionOrder;
    set(order.includes(s.id) ? { sessions } : { sessions, sessionOrder: saveOrder([...order, s.id]) });
  },
  removeSession: (id) => {
    const { [id]: _gone, ...sessions } = get().sessions;
    void _gone;
    const { [id]: _t, ...transcripts } = get().transcripts;
    void _t;
    const selectedId = get().selectedId === id ? null : get().selectedId;
    set({ sessions, transcripts, selectedId, sessionOrder: saveOrder(get().sessionOrder.filter((o) => o !== id)) });
  },
  moveSessionTo: (id, targetId) => {
    const st = get();
    const list = selectVisibleSessions(st);
    const from = list.findIndex((s) => s.id === id);
    const to = list.findIndex((s) => s.id === targetId);
    if (from < 0 || to < 0 || from === to || !canReorder(list[from], list[to])) return;
    const order = st.sessionOrder.filter((o) => o !== id);
    // Moving up lands above the target, moving down lands below it.
    order.splice(order.indexOf(targetId) + (to > from ? 1 : 0), 0, id);
    set({ sessionOrder: saveOrder(order) });
  },
  moveSessionBy: (id, delta) => {
    // Step over the rows it cannot swap with, such as the workers under an orchestrator.
    const list = selectVisibleSessions(get());
    const from = list.findIndex((s) => s.id === id);
    if (from < 0) return;
    for (let i = from + delta; i >= 0 && i < list.length; i += delta) {
      if (canReorder(list[from], list[i])) return get().moveSessionTo(id, list[i].id);
    }
  },
  // Selecting a worker of a collapsed orchestrator, from a report or a link, opens its group.
  select: (id) => set({ prSelection: null, reviewHistoryOpen: false, selectedId: id, cursorItemId: null, sidebarCursor: id, collapsedOrchestras: revealIn(get(), id) }),
  ensureTranscript: (id) => {
    if (!get().transcripts[id]) set({ transcripts: { ...get().transcripts, [id]: emptyTranscript() } });
  },
  loadTranscript: (id) => {
    const st = get();
    const t = st.transcripts[id];
    if (!st.client || t?.loaded || t?.loading) return;
    st.ensureTranscript(id);
    st.markLoading(id, true);
    st.client
      .history(id)
      .then((events) => get().loadHistory(id, events))
      .catch((e) => {
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
  toast: (message, level = "info") => {
    const id = toastId++;
    set({ toasts: [...get().toasts, { id, level, message }] });
    setTimeout(() => get().dismissToast(id), level === "error" ? 8000 : 4000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  setSidebarFilter: (sidebarFilter) => set({ sidebarFilter }),
  setShowArchived: (showArchived) => set({ showArchived }),
  setCursorItem: (cursorItemId) => set({ cursorItemId }),
  setSidebarCursor: (sidebarCursor) => set({ sidebarCursor }),
  setOrchestraCollapsed: (id, collapsed) => {
    const rest = get().collapsedOrchestras.filter((c) => c !== id);
    set({ collapsedOrchestras: saveCollapsed(collapsed ? [...rest, id] : rest) });
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
 * Sessions can only be reordered among their own section, pinned among pinned,
 * and workers among the workers of the same orchestrator.
 */
export function canReorder(a: Session, b: Session): boolean {
  const ownSection = (s: Session) => !!s.orchestrator && !s.group && !s.orchestrator_id;
  return (a.group ?? "") === (b.group ?? "") && a.pinned === b.pinned && (a.orchestrator_id ?? null) === (b.orchestrator_id ?? null) && ownSection(a) === ownSection(b);
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

function loadCollapsed(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function saveCollapsed(ids: string[]): string[] {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(ids));
  } catch {
    /* ignore */
  }
  return ids;
}

/** The collapsed orchestrators without the ones `id` is nested under. */
function revealIn(st: AppState, id: string | null): string[] {
  const ancestors = new Set<string>();
  for (let s = id ? st.sessions[id] : undefined; s?.orchestrator_id && !ancestors.has(s.orchestrator_id); s = st.sessions[s.orchestrator_id]) {
    ancestors.add(s.orchestrator_id);
  }
  const kept = st.collapsedOrchestras.filter((c) => !ancestors.has(c));
  return kept.length === st.collapsedOrchestras.length ? st.collapsedOrchestras : saveCollapsed(kept);
}

// Another window collapsed or expanded an orchestrator; follow it.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === COLLAPSED_KEY) useStore.setState({ collapsedOrchestras: loadCollapsed() });
  });
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

/**
 * The sidebar section of `s` among the `shown` sessions: a worker's is its
 * orchestrator's when they share a group, an orchestrator in no group has the
 * orchestrators section, and any other session its group.
 */
export function sectionOf(s: Session, shown: Map<string, Session>): string {
  let top = s;
  const seen = new Set([s.id]);
  for (let o = top.orchestrator_id ? shown.get(top.orchestrator_id) : undefined; o && !seen.has(o.id) && (o.group ?? "") === (top.group ?? ""); o = o.orchestrator_id ? shown.get(o.orchestrator_id) : undefined) {
    seen.add(o.id);
    top = o;
  }
  return top.orchestrator && !top.group ? ORCHESTRATORS_SECTION : top.group ?? "";
}

/**
 * The sidebar's sections, top to bottom: the orchestrators in no group, then
 * the other ungrouped sessions, then each group in the order its first session
 * appears. Within a section, pinned sessions come first, then the saved order.
 * Workers of a collapsed orchestrator are left out, unless `withCollapsed` or
 * a filter is set.
 */
export function selectSessionSections(st: AppState, withCollapsed = false): [string, Session[]][] {
  const q = st.sidebarFilter.trim().toLowerCase();
  const shown: Session[] = [];
  for (const id of st.sessionOrder) {
    const s = st.sessions[id];
    if (!s || (!st.showArchived && s.archived)) continue;
    if (q && !s.title.toLowerCase().includes(q) && !(folderOf(s) ?? "").toLowerCase().includes(q) && !(s.group ?? "").toLowerCase().includes(q)) continue;
    shown.push(s);
  }
  const byId = new Map(shown.map((s) => [s.id, s]));
  const sections = new Map<string, Session[]>([[ORCHESTRATORS_SECTION, []], ["", []]]);
  for (const s of shown) {
    const key = sectionOf(s, byId);
    if (!sections.has(key)) sections.set(key, []);
    sections.get(key)!.push(s);
  }
  return [...sections]
    .filter(([, list]) => list.length > 0)
    .map(([g, list]) => {
      const rows = nestWorkers([...list.filter((s) => s.pinned), ...list.filter((s) => !s.pinned)]);
      if (withCollapsed || q || st.collapsedOrchestras.length === 0) return [g, rows];
      const collapsed = new Set(st.collapsedOrchestras);
      return [g, rows.filter((s) => !orchestratorsOf(s, rows).some((o) => collapsed.has(o.id)))];
    });
}

/** Whether `s` is shown under its orchestrator: both in the same section. */
export function isNestedWorker(s: Session, list: Session[]): boolean {
  return !!s.orchestrator_id && list.some((o) => o.id === s.orchestrator_id);
}

/**
 * Workers follow their orchestrator, in their own order, and a worker that
 * orchestrates in turn is followed by its own workers.
 */
function nestWorkers(list: Session[]): Session[] {
  const out: Session[] = [];
  const placed = new Set<string>();
  const place = (s: Session) => {
    if (placed.has(s.id)) return;
    placed.add(s.id);
    out.push(s);
    for (const w of list) if (w.orchestrator_id === s.id) place(w);
  };
  for (const s of list) if (!isNestedWorker(s, list)) place(s);
  // Orchestrators that point at each other have no top; keep them, last.
  for (const s of list) place(s);
  return out;
}

/** The orchestrators `s` is nested under in `list`, nearest first. */
export function orchestratorsOf(s: Session, list: Session[]): Session[] {
  const out: Session[] = [];
  for (let o = list.find((l) => l.id === s.orchestrator_id); o && o !== s && !out.includes(o); o = list.find((l) => l.id === o!.orchestrator_id)) out.push(o);
  return out;
}

/**
 * The orchestra `id` belongs to as the sidebar shows it: its top orchestrator
 * and every visible worker under it. Null when `id` has no orchestra there,
 * which includes an orchestrator whose workers are collapsed.
 */
export function selectOrchestra(st: AppState, id: string): Session[] | null {
  for (const [, list] of selectSessionSections(st)) {
    const s = list.find((l) => l.id === id);
    if (!s) continue;
    const top = orchestratorsOf(s, list).at(-1) ?? s;
    const members = list.filter((l) => l === top || orchestratorsOf(l, list).includes(top));
    return members.length > 1 ? members : null;
  }
  return null;
}

/** Visible sessions in the order the sidebar shows them; ⌘1–9 index into this. */
export function selectVisibleSessions(st: AppState): Session[] {
  return selectSessionSections(st).flatMap(([, list]) => list);
}

export function selectPendingCount(st: AppState): number {
  let n = 0;
  for (const s of Object.values(st.sessions)) n += s.pending_count;
  return n;
}

export function selectSelected(st: AppState): Session | null {
  return st.prSelection || st.reviewHistoryOpen ? null : st.selectedId ? st.sessions[st.selectedId] ?? null : null;
}

export function selectTranscript(st: AppState, id: string | null): Transcript | null {
  return id ? st.transcripts[id] ?? null : null;
}

export type { ApprovalDecision };
