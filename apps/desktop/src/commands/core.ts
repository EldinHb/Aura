/** Core commands: sessions, navigation, focus, approvals. Registered once from App. */
import { registerCommands, type Command } from "../lib/commands";
import { useStore, selectVisibleSessions, selectSelected } from "../state/store";
import type { ApprovalOption, SessionMode } from "../gen";
import { isTauri } from "../lib/connection";
import { setPlanView, usePlanViews } from "../state/planView";

function st() {
  return useStore.getState();
}
function client() {
  const c = st().client;
  if (!c) throw new Error("not connected to the daemon");
  return c;
}
function selected() {
  const s = selectSelected(st());
  if (!s) throw new Error("no session selected");
  return s;
}

export function focusRegionEl(region: string) {
  const el = document.querySelector<HTMLElement>(`[data-region="${region}"]`);
  if (!el) return;
  const target = el.querySelector<HTMLElement>("[data-autofocus]") ?? el;
  if (region === "main" && st().sessions[st().selectedId ?? ""]?.mode === "terminal") {
    const xt = el.querySelector<HTMLElement>(".xterm-helper-textarea");
    if (xt) {
      xt.focus();
      return;
    }
  }
  target.focus({ preventScroll: false });
}

export function setFocus(region: "sidebar" | "main" | "composer" | "inspector") {
  st().setFocus(region);
  requestAnimationFrame(() => focusRegionEl(region));
}

async function respondOldest(option: ApprovalOption) {
  const s = selected();
  const t = st().transcripts[s.id];
  const approvals = Object.values(t?.approvals ?? {}).sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (approvals.length === 0) {
    // maybe another session has one
    const all = await client().pending();
    const first = all.approvals[0];
    if (!first) throw new Error("nothing pending");
    st().select(first.session_id);
    await client().respondApproval(first.session_id, first.id, { option, updated_input: null, message: null });
    return;
  }
  const a = approvals[0];
  if (option === "edit_input") {
    st().openDialog({ kind: "confirm", title: "Edit input", message: "Use the approval card to edit the input (press e on the card).", onConfirm: () => {} });
    return;
  }
  await client().respondApproval(s.id, a.id, { option, updated_input: null, message: null });
}

function visible() {
  return selectVisibleSessions(st());
}

function moveSession(delta: number) {
  const list = visible();
  if (list.length === 0) return;
  const cur = list.findIndex((s) => s.id === st().selectedId);
  const next = cur < 0 ? 0 : (cur + delta + list.length) % list.length;
  st().select(list[next].id);
}

export const coreCommands: Command[] = [
  { id: "palette.open", title: "Command palette", group: "Aura", run: () => st().setPalette(true) },
  { id: "help.open", title: "Keyboard shortcuts help", group: "Aura", run: () => st().openDialog({ kind: "help" }) },
  { id: "settings.open", title: "Settings", group: "Aura", run: () => st().openDialog({ kind: "settings" }) },
  { id: "settings.groups", title: "Manage groups…", group: "Aura", keywords: ["delete group"], run: () => st().openDialog({ kind: "settings", tab: "groups" }) },
  { id: "settings.prompts", title: "System prompts…", group: "Aura", keywords: ["global prompt", "agent prompt", "instructions"], run: () => st().openDialog({ kind: "settings", tab: "prompts" }) },
  { id: "search.open", title: "Search across sessions", group: "Aura", run: () => st().openDialog({ kind: "search" }) },
  { id: "inbox.open", title: "Approvals inbox", group: "Aura", run: () => st().openDialog({ kind: "inbox" }) },
  { id: "import.open", title: "Import existing CLI sessions", group: "Session", run: () => st().openDialog({ kind: "import" }) },
  { id: "hints.enter", title: "Show hint labels (click anything by keyboard)", group: "Aura", run: () => st().setHintMode(true) },
  {
    id: "ui.escape",
    title: "Escape / back",
    group: "Aura",
    hidden: true,
    run: () => {
      const s = st();
      if (s.hintMode) return s.setHintMode(false);
      if (s.paletteOpen) return s.setPalette(false);
      if (s.dialog.kind !== "none") return s.closeDialog();
      if (s.whichKey) return s.setWhichKey(null);
      // from composer -> main; from main -> sidebar stays
      if (s.focus === "composer") setFocus("main");
      else if (document.activeElement instanceof HTMLElement && !document.activeElement.closest(".terminal-wrap")) {
        document.activeElement.blur();
        focusRegionEl(s.focus);
      }
    },
  },
  { id: "sidebar.toggle", title: "Toggle sidebar", group: "View", run: () => st().setSidebarCollapsed(!st().sidebarCollapsed) },
  { id: "inspector.toggle", title: "Toggle inspector", group: "View", run: () => st().setInspectorOpen(!st().inspectorOpen) },
  { id: "sidebar.filter", title: "Filter sessions", group: "View", run: () => { st().setSidebarCollapsed(false); setFocus("sidebar"); requestAnimationFrame(() => document.querySelector<HTMLInputElement>("[data-sidebar-filter]")?.focus()); } },
  { id: "focus.sidebar", title: "Focus sidebar", group: "Focus", run: () => { st().setSidebarCollapsed(false); setFocus("sidebar"); } },
  { id: "focus.main", title: "Focus transcript / terminal", group: "Focus", run: () => setFocus("main") },
  { id: "focus.composer", title: "Focus composer", group: "Focus", when: "hasSelection", run: () => setFocus(st().sessions[st().selectedId!]?.mode === "terminal" ? "main" : "composer") },
  { id: "focus.inspector", title: "Focus inspector", group: "Focus", run: () => { st().setInspectorOpen(true); setFocus("inspector"); } },
  {
    id: "focus.left",
    title: "Focus region to the left",
    group: "Focus",
    hidden: true,
    run: () => {
      const f = st().focus;
      if (f === "inspector") setFocus("main");
      else if (f === "main" || f === "composer") setFocus("sidebar");
    },
  },
  {
    id: "focus.right",
    title: "Focus region to the right",
    group: "Focus",
    hidden: true,
    run: () => {
      const f = st().focus;
      if (f === "sidebar") setFocus("main");
      else if ((f === "main" || f === "composer") && st().inspectorOpen) setFocus("inspector");
    },
  },
  // sessions
  { id: "session.new", title: "New session…", group: "Session", run: () => st().openDialog({ kind: "new-session" }) },
  { id: "session.new-worktree", title: "New session in git worktree…", group: "Session", run: () => st().openDialog({ kind: "new-session", provider: "worktree" }) },
  {
    id: "session.new-terminal",
    title: "New terminal here",
    group: "Session",
    run: async () => {
      const cwd = selectSelected(st())?.cwd || st().settings.defaultCwd || (await client().home()) || "/";
      const s = await client().createSession({ provider: "terminal", cwd });
      st().select(s.id);
      setFocus("main");
    },
  },
  { id: "session.next", title: "Next session", group: "Session", run: () => moveSession(1) },
  { id: "session.prev", title: "Previous session", group: "Session", run: () => moveSession(-1) },
  {
    id: "session.select-nth",
    title: "Select session by number",
    group: "Session",
    hidden: true,
    run: (n) => {
      const list = visible();
      const idx = Number(n) - 1;
      if (list[idx]) st().select(list[idx].id);
    },
  },
  { id: "session.move-up", title: "Move session up", group: "Session", when: "hasSelection", run: () => st().moveSessionBy(selected().id, -1) },
  { id: "session.move-down", title: "Move session down", group: "Session", when: "hasSelection", run: () => st().moveSessionBy(selected().id, 1) },
  { id: "session.clear-notices", title: "Clear warnings in this session", group: "Session", when: "hasSelection", run: async () => { await client().clearNotices(selected().id); } },
  { id: "session.clear-all-notices", title: "Clear warnings in all sessions", group: "Session", run: async () => { await client().clearNotices(); st().toast("Cleared warnings in all sessions"); } },
  { id: "session.fork", title: "Fork session", group: "Session", when: "hasSelection", run: async () => { const s = await client().fork(selected().id); st().select(s.id); } },
  { id: "session.rename", title: "Rename session…", group: "Session", when: "hasSelection", run: () => st().openDialog({ kind: "rename", sessionId: selected().id }) },
  { id: "session.system-prompt", title: "Session system prompt…", group: "Session", keywords: ["instructions"], when: "hasSelection", run: () => st().openDialog({ kind: "system-prompt", sessionId: selected().id }) },
  { id: "session.links", title: "Edit issue & PR…", keywords: ["GitHub", "pull request", "links"], group: "Session", when: "hasSelection", run: () => st().openDialog({ kind: "session-links", sessionId: selected().id }) },
  { id: "session.plan.toggle", title: "Show / hide session plan", group: "Session", when: "hasSelection", run: () => {
    const id = selected().id;
    const open = !st().inspectorOpen || !(usePlanViews.getState().views[id]?.open ?? true);
    setPlanView(id, { open });
    st().setInspectorOpen(true);
  } },
  { id: "session.group", title: "Set session group…", group: "Session", when: "hasSelection", run: () => st().openDialog({ kind: "group", sessionId: selected().id }) },
  { id: "session.pin", title: "Pin / unpin session", group: "Session", when: "hasSelection", run: async () => { const s = selected(); await client().setPinned(s.id, !s.pinned); } },
  {
    id: "session.archive",
    title: "Archive / unarchive session",
    group: "Session",
    when: "hasSelection",
    run: async () => {
      const s = selected();
      await client().setArchived(s.id, !s.archived);
      if (!s.archived) st().toast(`Archived “${s.title}”`);
    },
  },
  { id: "session.stop", title: "Stop session process (keep resumable)", group: "Session", when: "hasSelection", run: async () => { await client().stop(selected().id); } },
  { id: "session.restart", title: "Restart terminal session", group: "Session", when: "hasSelection,mode:terminal", run: async () => { await client().restart(selected().id); setFocus("main"); } },
  {
    id: "session.delete",
    title: "Delete session…",
    group: "Session",
    when: "hasSelection",
    run: () => {
      const s = selected();
      const doIt = async () => {
        await client().deleteSession(s.id, false);
        st().toast(`Deleted “${s.title}”`);
      };
      if (!st().settings.confirmDelete) return doIt();
      st().openDialog({ kind: "confirm", title: "Delete session", message: `Delete “${s.title}” and its history? The provider's own transcript is kept.`, danger: true, onConfirm: () => void doIt() });
    },
  },
  {
    id: "session.toggle-mode",
    title: "Toggle terminal / structured mode",
    group: "Session",
    when: "hasSelection,provider:claude|codex",
    run: async () => {
      const s = selected();
      const mode: SessionMode = s.mode === "terminal" ? "structured" : "terminal";
      await client().switchMode(s.id, mode);
      setFocus("main");
    },
  },
  { id: "session.mode-terminal", title: "Switch to terminal mode", group: "Session", when: "hasSelection,mode:structured,provider:claude|codex", run: async () => { await client().switchMode(selected().id, "terminal"); setFocus("main"); } },
  { id: "session.mode-structured", title: "Switch to structured mode", group: "Session", when: "hasSelection,mode:terminal,provider:claude|codex", run: async () => { await client().switchMode(selected().id, "structured"); setFocus("main"); } },
  { id: "session.interrupt", title: "Interrupt running turn", group: "Session", when: "hasSelection", run: async () => { await client().interrupt(selected().id); } },
  { id: "session.compact", title: "Compact context", group: "Session", when: "hasSelection,mode:structured,provider:claude|codex", run: async () => { await client().action(selected().id, "compact"); st().toast("Compaction requested"); } },
  { id: "session.review", title: "Start code review (Codex)", group: "Session", when: "hasSelection,provider:codex", run: async () => { await client().action(selected().id, "review"); } },
  { id: "session.pick-model", title: "Change model…", group: "Session", when: "hasSelection,mode:structured", run: () => st().openDialog({ kind: "models", sessionId: selected().id }) },
  { id: "session.pick-effort", title: "Change effort…", group: "Session", when: "hasSelection,mode:structured", run: () => st().openDialog({ kind: "effort", sessionId: selected().id }) },
  { id: "session.pick-permission", title: "Change permission mode…", group: "Session", when: "hasSelection,mode:structured", run: () => st().openDialog({ kind: "permission", sessionId: selected().id }) },
  { id: "session.pick-sandbox", title: "Change sandbox mode…", group: "Session", when: "hasSelection,provider:codex", run: () => st().openDialog({ kind: "sandbox", sessionId: selected().id }) },
  {
    id: "session.open-window",
    title: "Open session in new window",
    group: "Session",
    when: "hasSelection",
    run: async () => {
      const s = selected();
      if (isTauri()) {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("open_session_window", { sessionId: s.id });
      } else {
        window.open(`${location.pathname}?session=${s.id}&window=session`, "_blank");
      }
    },
  },
  { id: "session.copy-id", title: "Copy session id", group: "Session", when: "hasSelection", run: async () => { await navigator.clipboard.writeText(selected().id); st().toast("Session id copied"); } },
  { id: "session.copy-cwd", title: "Copy working directory", group: "Session", when: "hasSelection", run: async () => { await navigator.clipboard.writeText(selected().cwd); st().toast("Path copied"); } },
  // approvals
  { id: "approval.accept-oldest", title: "Accept oldest pending approval", group: "Approvals", when: "pending", run: () => respondOldest("accept") },
  { id: "approval.accept-session-oldest", title: "Accept oldest approval for the session", group: "Approvals", when: "pending", run: () => respondOldest("accept_for_session") },
  { id: "approval.decline-oldest", title: "Decline oldest pending approval", group: "Approvals", when: "pending", run: () => respondOldest("decline") },
  { id: "approval.edit-oldest", title: "Edit oldest pending approval", group: "Approvals", when: "pending", hidden: true, run: () => respondOldest("edit_input") },
  // daemon
  {
    id: "daemon.restart",
    title: "Restart daemon (sessions are resumed)",
    group: "Aura",
    run: async () => {
      if (!isTauri()) throw new Error("only available in the desktop app");
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("restart_daemon");
      location.reload();
    },
  },
  { id: "app.reload", title: "Reload UI", group: "Aura", run: () => location.reload() },
];

export function registerCoreCommands() {
  return registerCommands(coreCommands);
}
