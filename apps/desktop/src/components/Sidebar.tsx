import { SessionRowModChips, SidebarModSections } from "../mods/Slots";
import { ScheduleSidebar } from "../features/schedules/ScheduleSidebar";
import { openSchedules, useSchedules } from "../features/schedules/state";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useStore, selectVisibleSessions, selectSessionSections, selectNestedRows, selectTabActivity, canReorder, groupKey, hasHeading, leaderOf, rollupOf, treeOf, waitsOnUser, inActiveWorkspace, isLeader, tabOf, ORCHESTRATORS_SECTION, TASK_SECTION, STATE_SECTION, CATEGORY_LABEL, type AppState, type NestedRow, type SessionCategory, type SidebarTab } from "../state/store";
import { folderOf } from "../lib/sessionFolder";
import type { Session } from "../gen";
import { basename, relTime } from "../lib/platform";
import { registerCommands, runCommand } from "../lib/commands";
import { setFocus } from "../commands/core";
import clsx from "clsx";
import { useShallow } from "zustand/react/shallow";
import { useSessionBranch } from "../state/branchStatus";
import { GitCounts, branchName } from "./BranchStatus";
import { stateWord, statusClass } from "../lib/sessionStatus";
import { ATTENTION, hiddenAttention, useViewedSessionId } from "../state/attention";
import { useFeature } from "../state/features";
import { openQuestions } from "../lib/features";
import { openWorkerThread } from "../state/workerThreads";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { StatusRail, focusRail } from "./StatusRail";

/** Every leader row of the tab shown, those of folded sections included. */
const selectAllRows = (st: AppState) => selectSessionSections(st, true).flatMap(([, list]) => list);
/** The section of each of those rows. */
const selectRowSections = (st: AppState) => selectSessionSections(st, true).flatMap(([g, list]) => list.map(() => g));

/** The id the sidebar keyboard is on, when its section is folded: the section's heading stands in for it. */
function foldedSectionOf(st: AppState, id: string | null): string | null {
  if (!id || st.sidebarFilter.trim() || !st.sessions[id]) return null;
  const leader = leaderOf(st.sessions[id], st.sessions);
  const sections = selectSessionSections(st, true);
  const keys = sections.map(([g]) => g);
  const section = sections.find(([, list]) => list.includes(leader))?.[0];
  return section !== undefined && hasHeading(section, keys) && st.collapsedGroups.includes(groupKey(st.sidebarTab, section)) ? section : null;
}

/** The section heading the keyboard focus is on, if any. */
function focusedHeading(): { tab: SidebarTab; section: string } | null {
  const el = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>("[data-group-section]") : null;
  return el ? { tab: el.dataset.groupTab as SidebarTab, section: el.dataset.groupSection ?? "" } : null;
}

/**
 * The rows the sidebar keyboard moves through from `current`: every leader,
 * and the nested rows of `current`'s leader only. Workers are reached from
 * their leader.
 */
function navRows(st: AppState, current: Session | undefined): Session[] {
  const leader = current ? leaderOf(current, st.sessions) : undefined;
  return selectVisibleSessions(st).flatMap((l) => (l === leader ? [l, ...selectNestedRows(st, l.id).rows.map((r) => r.session)] : [l]));
}

/** The session the sidebar keyboard acts on: the row it is on, or the leader showing it when it is collapsed away. */
function sidebarCurrent(st: AppState): Session | undefined {
  const id = st.sidebarCursor ?? st.selectedId;
  const s = id ? st.sessions[id] : undefined;
  if (!s || !inActiveWorkspace(st, s)) return undefined;
  const leader = leaderOf(s, st.sessions);
  if (!selectVisibleSessions(st).includes(leader)) return undefined;
  return leader === s || selectNestedRows(st, leader.id).rows.some((r) => r.session === s) ? s : leader;
}

/**
 * The quiet second line: agent, orchestrator mark, a leader's workers chip,
 * then folder or worktree, branch state, terminal mode and model with its
 * effort, which give way first. An orchestrator without a folder has none of
 * the folder's. Then the session's issues and PRs.
 */
function SessionRowDetails({ session: s, selected, workers }: { session: Session; selected: boolean; workers: React.ReactNode }) {
  const { git } = useSessionBranch(s, selected);
  const branch = (git && branchName(git)) ?? s.worktree?.branch;
  const agent = s.agent ?? s.provider;
  const runs = s.model ? [s.model, s.effort].filter(Boolean).join(" · ") : s.effort ? `effort ${s.effort}` : "";
  return (
    <>
      <div className="sub">
        <span className={clsx("agent", s.provider)} title={`Agent: ${agent}`}>{agent}</span>
        {s.feature_owner ? (
          <span className="feature-owner-mark" role="img" aria-label="Feature owner" title="Feature owner: owns a feature and directs the specialists under it" />
        ) : (
          s.orchestrator && <span className="orchestrator-mark" role="img" aria-label="Orchestrator" title="Orchestrator: starts and directs the sessions under it" />
        )}
        {s.feature_owner && <FeatureChip ownerId={s.id} />}
        {s.specialist_name && s.specialist_name !== s.title && <span className="chip specialist" title={`Hired as ${s.specialist_name}`}>{s.specialist_name}</span>}
        {workers}
        {s.group && <span className="chip group" title={`Group: ${s.group}`}>{s.group}</span>}
        <span className="where">
          {!s.worktree && folderOf(s) !== null && basename(s.cwd)}
          {branch && `${s.worktree || folderOf(s) === null ? "" : " · "}⎇ ${branch}`}
          {git && <GitCounts git={git} />}
          {s.mode === "terminal" && s.provider !== "terminal" ? " · tui" : ""}
          {runs ? `${folderOf(s) === null && !branch ? "" : " · "}${runs}` : ""}
        </span>
      </div>
      {/* Mods' chips: the branch's pull request, linked issues, … */}
      <div className="links"><SessionRowModChips session={s} selected={selected} /></div>
    </>
  );
}

function FeatureChip({ ownerId }: { ownerId: string }) {
  const feature = useFeature(ownerId);
  const open = openQuestions(feature).length;
  if (open > 0) return <span className="chip warn feature-state" title="The feature owner waits on your decision">{open === 1 ? "decision for you" : `${open} decisions for you`}</span>;
  if (feature?.status === "delivered") return <span className="chip ok feature-state" title="The feature owner delivered its report">delivered</span>;
  return null;
}

/** What a leader's workers do, in a few words: "N workers", then the most urgent clause. */
export function workersSummary(tree: Session[]): { text: string; needs: number; working: number } {
  const needs = tree.filter(waitsOnUser).length;
  const working = tree.filter((w) => w.status === "running").length;
  const head = `${tree.length} ${tree.length === 1 ? "worker" : "workers"}`;
  return { text: needs ? `${head} · ${needs} ${needs === 1 ? "needs" : "need"} you` : working ? `${head} · ${working} working` : head, needs, working };
}

/**
 * A leader's workers chip: how many workers it has and the most urgent of
 * what they do, marked when one waits on the user or has news. Clicking it
 * opens or closes the nested list.
 */
function WorkersChip({ leader, tree, expanded, onToggle }: { leader: Session; tree: Session[]; expanded: boolean; onToggle: () => void }) {
  const attention = hiddenAttention(tree);
  const { text, needs, working } = workersSummary(tree);
  const lines = tree.map((w) => `${w.title} · ${stateWord(w)}`);
  return (
    <button
      type="button"
      className={clsx("chip", "workers", needs > 0 && "warn")}
      title={lines.join("\n")}
      data-hint
      aria-expanded={expanded}
      aria-label={`${text}. ${expanded ? "Hide" : "Show"} the workers of ${leader.title}`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {text}
      {!needs && working > 0 && <span className="dot ok pulse" aria-hidden />}
      {attention && <span className={clsx("attention", ATTENTION[attention].className)} role="img" aria-label={`Workers: ${ATTENTION[attention].label.toLowerCase()}`} />}
    </button>
  );
}

/** "2 waiting on you: 1 here, 1 in Tester": where a leader's pending approvals and questions are. */
function pendingTitle(leader: Session, tree: Session[]): string {
  const total = leader.pending_count + tree.reduce((n, w) => n + w.pending_count, 0);
  const parts = [leader.pending_count > 0 && `${leader.pending_count} here`, ...tree.filter((w) => w.pending_count > 0).map((w) => `${w.pending_count} in ${w.title}`)].filter(Boolean);
  return `${total} waiting on you: ${parts.join(", ")}`;
}

const TABS: { tab: SidebarTab; label: string; command: string }[] = [
  { tab: "sessions", label: "Sessions", command: "sidebar.tab.sessions" },
  { tab: "scheduled", label: "Scheduled", command: "sidebar.tab.scheduled" },
];

/**
 * Sessions and Scheduled, above the list. A tab shows what its sessions need
 * from the user (approvals and questions, the attention marker) while the
 * other is shown; Scheduled also how many it lists and whether any works.
 */
function SidebarTabs() {
  const tab = useStore((s) => s.sidebarTab);
  const setTab = useStore((s) => s.setSidebarTab);
  const viewedId = useViewedSessionId();
  const sessions = useStore(useShallow((st) => selectTabActivity(st, "sessions", viewedId)));
  const scheduled = useStore(useShallow((st) => selectTabActivity(st, "scheduled", viewedId)));
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const activity = { sessions, scheduled };
  return (
    <div
      className="tabs inline sidebar-tabs"
      role="tablist"
      aria-label="Session lists"
      data-keynav
      onKeyDown={(e) => {
        // The tab pattern: arrows and Home / End move between the tabs and show them.
        const i = TABS.findIndex((t) => t.tab === tab);
        const next = e.key === "ArrowRight" ? (i + 1) % TABS.length : e.key === "ArrowLeft" ? (i - 1 + TABS.length) % TABS.length : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
        if (next < 0) return;
        e.preventDefault();
        setTab(TABS[next].tab);
        refs.current[TABS[next].tab]?.focus();
      }}
    >
      {TABS.map((t) => {
        const a = activity[t.tab];
        const on = t.tab === tab;
        const needs = [
          a.pending > 0 && `${a.pending} waiting on you`,
          a.attention && ATTENTION[a.attention].label.toLowerCase(),
          t.tab === "scheduled" && a.working > 0 && `${a.working} working`,
        ].filter(Boolean);
        return (
          <button
            key={t.tab}
            ref={(el) => { refs.current[t.tab] = el; }}
            type="button"
            role="tab"
            id={`sidebar-tab-${t.tab}`}
            aria-selected={on}
            aria-controls="sidebar-session-list"
            tabIndex={on ? 0 : -1}
            data-hint
            data-command={t.command}
            className={clsx("tab", on && "active")}
            title={[`${t.label}: ${t.tab === "scheduled" ? "sessions scheduled tasks started" : "sessions you or your orchestrators started"}`, ...needs].join("\n")}
            onClick={() => setTab(t.tab)}
          >
            {t.label}
            {t.tab === "scheduled" && a.count > 0 && <span className="dim tab-count">{a.count}</span>}
            {t.tab === "scheduled" && a.working > 0 && <span className="dot ok pulse tab-working" role="img" aria-label={`${a.working} working`} />}
            {!on && a.attention && <span className={clsx("attention", ATTENTION[a.attention].className)} role="img" aria-label={ATTENTION[a.attention].label} />}
            {!on && a.pending > 0 && <span className="badge" aria-label={`${a.pending} waiting on you`}>{a.pending}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A section's heading. Clicking it, or Enter / Space on it, folds the
 * section to the heading, which then shows how many leaders it holds and
 * whether one of their trees works or waits on the user.
 */
function SectionHeading({ tab, section, label, list, folded, current, viewedId, children }: {
  tab: SidebarTab; section: string; label: string; list: Session[]; folded: boolean; current: boolean; viewedId: string | null; children?: React.ReactNode;
}) {
  const setGroupCollapsed = useStore((s) => s.setGroupCollapsed);
  const sessions = useStore((s) => s.sessions);
  const trees = list.map((s) => [s, ...treeOf(s.id, sessions)]);
  const working = list.filter((s) => rollupOf(s, sessions) === "working").length;
  const pending = trees.flat().reduce((n, s) => n + s.pending_count, 0);
  const attention = hiddenAttention(trees.flat().map((s) => (s.id === viewedId ? { ...s, attention: null } : s)));
  const what = [`${list.length} ${list.length === 1 ? "session" : "sessions"}`, working > 0 && `${working} working`, pending > 0 && `${pending} waiting on you`, attention && ATTENTION[attention].label.toLowerCase()].filter(Boolean).join(", ");
  return (
    <div className={clsx("section-heading", folded && "folded", current && "cursor")}>
      <button
        type="button"
        className="section-title section-toggle"
        data-group-tab={tab}
        data-group-section={section}
        data-hint
        data-command="sidebar.section.toggle"
        aria-expanded={!folded}
        aria-label={`${label}, ${what}. ${folded ? "Show" : "Hide"} its sessions`}
        title={`${folded ? "Show" : "Hide"} ${label} (${what})`}
        onClick={() => setGroupCollapsed(tab, section, !folded)}
      >
        <span className="section-chevron" aria-hidden />
        <span className="section-label">{label}</span>
        {folded && <span className="chip section-count">{list.length}</span>}
        {folded && working > 0 && <span className="dot ok pulse" role="img" aria-label={`${working} working`} />}
        {folded && attention && <span className={clsx("attention", ATTENTION[attention].className)} role="img" aria-label={ATTENTION[attention].label} />}
        {folded && pending > 0 && <span className="badge">{pending}</span>}
      </button>
      {children}
    </div>
  );
}

/** Leaders in other workspaces that match the filter: the sidebar points at ⌘K for them. */
function useMatchesElsewhere(filter: string): number {
  return useStore((st) => {
    const q = filter.trim().toLowerCase();
    if (!q || !st.workspaces.length) return 0;
    const match = (s: Session) => s.title.toLowerCase().includes(q) || (folderOf(s) ?? "").toLowerCase().includes(q) || (s.group ?? "").toLowerCase().includes(q);
    return Object.values(st.sessions).filter((s) => !s.archived && !inActiveWorkspace(st, s) && isLeader(s, st.sessions) && tabOf(s, st.sessions) === st.sidebarTab && (match(s) || treeOf(s.id, st.sessions).some(match))).length;
  });
}

/** What an empty list says: per tab, per workspace, and when a filter matches nothing here. */
function EmptyList({ tab, filter }: { tab: SidebarTab; filter: string }) {
  const workspace = useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspace) ?? null);
  const elsewhere = useMatchesElsewhere(filter);
  const where = workspace ? ` in ${workspace.name}` : "";
  if (tab === "scheduled" && !filter) {
    return (
      <div className="empty" style={{ height: "auto", padding: 20 }}>
        <span>No sessions from scheduled tasks yet{where}.</span>
        <span>Each run of a scheduled task is listed here, by task.</span>
        <button type="button" className="btn small" data-command="schedules.open" onClick={() => openSchedules()}>Scheduled tasks…</button>
      </div>
    );
  }
  if (filter) {
    return (
      <div className="empty" style={{ height: "auto", padding: 20 }}>
        <span>No {tab === "scheduled" ? "scheduled " : ""}sessions match.</span>
        {elsewhere > 0 && <span className="dim">{elsewhere} match in other workspaces — <kbd>⌘K</kbd> to search all.</span>}
      </div>
    );
  }
  return (
    <div className="empty" style={{ height: "auto", padding: 20 }}>
      <span>{workspace ? `No sessions in ${workspace.name} yet.` : "No sessions."}</span>
      <span>Press <kbd>⌘N</kbd> to {workspace ? "start one here" : "create one"}.</span>
      {workspace && (
        <button type="button" className="btn small" data-hint data-command="workspace.gather" onClick={() => void runCommand("workspace.gather")}>Move sessions here…</button>
      )}
    </div>
  );
}

export function Sidebar() {
  const sessions = useStore(useShallow(selectVisibleSessions));
  const rows = useStore(useShallow(selectAllRows));
  const rowSections = useStore(useShallow(selectRowSections));
  const tab = useStore((s) => s.sidebarTab);
  const collapsedGroups = useStore((s) => s.collapsedGroups);
  const tasks = useSchedules((s) => s.tasks);
  const allSessions = useStore((s) => s.sessions);
  const nestedState = useStore(useShallow((s) => [s.expandedOrchestras, s.collapsedSubOrchestras, s.sidebarFilter, s.showArchived, s.sessionOrder]));
  const collapsedSub = useStore((s) => s.collapsedSubOrchestras);
  const setOrchestraExpanded = useStore((s) => s.setOrchestraExpanded);
  const selectedId = useStore((s) => s.modView ? null : s.selectedId);
  const cursor = useStore((s) => s.sidebarCursor);
  const filter = useStore((s) => s.sidebarFilter);
  const setFilter = useStore((s) => s.setSidebarFilter);
  const showArchived = useStore((s) => s.showArchived);
  const select = useStore((s) => s.select);
  const setCursor = useStore((s) => s.setSidebarCursor);
  const focus = useStore((s) => s.focus);
  // Opening a session clears its marker (see useMarkViewedSeen); until the daemon has, it is not shown.
  const viewedId = useViewedSessionId();
  const listRef = useRef<HTMLDivElement>(null);

  // Sections in ⌘1–9 order, with the rows of folded sections in to count them.
  const groups = useMemo(() => {
    const m = new Map<string, Session[]>();
    rows.forEach((s, i) => {
      const g = rowSections[i] ?? "";
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(s);
    });
    return [...m.entries()];
  }, [rows, rowSections]);
  const keys = useMemo(() => groups.map(([g]) => g), [groups]);
  const visibleIds = useMemo(() => new Set(sessions.map((s) => s.id)), [sessions]);
  const taskNames = useMemo(() => new Map(tasks.map((t) => [t.id, t.name])), [tasks]);
  // Each leader's nested rows: its tree while expanded, the workers that wait on the user while collapsed.
  const nested = useMemo(() => {
    void nestedState;
    const st = useStore.getState();
    return new Map(sessions.map((s) => [s.id, selectNestedRows(st, s.id)]));
  }, [sessions, allSessions, nestedState]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drag a leader onto another leader of the same section to reorder.
  const drag = useRef<{ id: string; startY: number; active: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; below: boolean } | null>(null);
  useEffect(() => {
    const targetAt = (e: PointerEvent) => {
      const d = drag.current;
      const id = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-session-id]")?.dataset.sessionId;
      if (!d || !id || id === d.id) return null;
      const st = useStore.getState();
      const list = selectVisibleSessions(st);
      const from = list.findIndex((s) => s.id === d.id);
      const to = list.findIndex((s) => s.id === id);
      return from >= 0 && to >= 0 && canReorder(list[from], list[to], st.sessions) ? { id, below: to > from } : null;
    };
    const end = () => {
      drag.current = null;
      setDragging(null);
      setDropTarget(null);
    };
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || (!d.active && Math.abs(e.clientY - d.startY) < 5)) return;
      d.active = true;
      setDragging(d.id);
      setDropTarget(targetAt(e));
    };
    const onUp = (e: PointerEvent) => {
      const d = drag.current;
      if (d?.active) {
        const target = targetAt(e);
        if (target) useStore.getState().moveSessionTo(d.id, target.id);
        // The click that follows a drag must not select the row.
        suppressClick.current = true;
        setTimeout(() => (suppressClick.current = false));
      }
      end();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", end);
    };
  }, []);

  // navigation commands scoped to the sidebar
  useEffect(() => {
    const go = (id: string) => { setCursor(id); select(id); };
    const move = (delta: number) => {
      const st = useStore.getState();
      if (st.focus !== "sidebar") return false;
      const current = sidebarCurrent(st);
      // Up and down move between leaders and walk the nested list of the current one;
      // other leaders' workers are reached from their leader. First and last go to the
      // first and last leader.
      const sessions = Math.abs(delta) > 1 ? selectVisibleSessions(st) : navRows(st, current);
      const count = sessions.length;
      if (!count) {
        if (delta === 1) focusRail();
        return true;
      }
      let cur = current ? sessions.indexOf(current) : -1;
      const id = st.sidebarCursor ?? st.selectedId;
      if (cur < 0 && foldedSectionOf(st, id) !== null) {
        // On a folded section's heading: step to the rows around it.
        const full = selectSessionSections(st, true).flatMap(([, list]) => list);
        const leader = st.sessions[id!] ? leaderOf(st.sessions[id!], st.sessions) : undefined;
        const above = full.slice(0, leader ? full.indexOf(leader) : 0).filter((s) => sessions.includes(s)).length;
        if (delta < 0 && above === 0 && Math.abs(delta) === 1) return true;
        cur = delta > 0 ? above - 1 : above;
      }
      // Down past the last row goes on into the status rail.
      if (delta === 1 && cur === count - 1 && focusRail()) return true;
      const next = Math.max(0, Math.min(count - 1, cur < 0 && !(delta > 0 && foldedSectionOf(st, id) !== null) ? 0 : cur + delta));
      // Mods' sidebar sections (pull requests, …) keep their own keys while focused.
      go(sessions[next].id);
      return true;
    };
    // Tree keys: right opens a leader, then steps to its first worker; left closes it,
    // or steps from a worker up to its orchestrator. An orchestrator under a leader opens
    // and closes the same way. On a section's heading, or a leader at the top of a
    // section, they fold and unfold the section.
    const tree = (dir: -1 | 1) => {
      const st = useStore.getState();
      if (st.focus !== "sidebar") return;
      const heading = focusedHeading();
      if (heading) {
        st.setGroupCollapsed(heading.tab, heading.section, dir < 0);
        return;
      }
      if (st.modView) return;
      const folded = foldedSectionOf(st, st.sidebarCursor ?? st.selectedId);
      if (folded !== null) {
        if (dir > 0) st.setGroupCollapsed(st.sidebarTab, folded, false);
        return;
      }
      const current = sidebarCurrent(st);
      if (!current) return;
      const leader = leaderOf(current, st.sessions);
      const nestedRows = selectNestedRows(st, leader.id);
      const rows = nestedRows.rows.map((r) => r.session);
      if (current === leader) {
        const all = selectSessionSections(st, true);
        const entry = all.find(([, list]) => list.includes(current));
        const foldable = !!entry && hasHeading(entry[0], all.map(([g]) => g)) && !st.sidebarFilter.trim();
        if (dir > 0) {
          if (nestedRows.total && !nestedRows.expanded) st.setOrchestraExpanded(leader.id, true);
          else if (nestedRows.expanded && rows.length) go(rows[0].id);
        } else if (nestedRows.total && nestedRows.expanded) {
          st.setOrchestraExpanded(leader.id, false);
          go(leader.id);
        } else if (foldable && entry) {
          // The cursor stays on the row; the heading shows it while the section is folded.
          st.setSidebarCursor(current.id);
          st.setGroupCollapsed(st.sidebarTab, entry[0], true);
        }
        return;
      }
      const children = treeOf(current.id, st.sessions).filter((w) => w.orchestrator_id === current.id);
      const open = nestedRows.expanded && !st.collapsedSubOrchestras.includes(current.id);
      if (dir > 0) {
        if (!children.length || !nestedRows.expanded) return;
        if (!open) st.setOrchestraExpanded(current.id, true);
        else {
          const first = rows.find((r) => r.orchestrator_id === current.id);
          if (first) go(first.id);
        }
      } else if (children.length && open) {
        st.setOrchestraExpanded(current.id, false);
      } else {
        const parent = current.orchestrator_id ? st.sessions[current.orchestrator_id] : undefined;
        go(parent && rows.includes(parent) ? parent.id : leader.id);
      }
    };
    const showTab = (tab: SidebarTab) => {
      useStore.getState().setSidebarTab(tab);
      useStore.getState().setFocus("sidebar");
    };
    return registerCommands([
      { id: "sidebar.nav.down", title: "Sidebar: next", group: "Navigation", hidden: true, run: () => void move(1) },
      { id: "sidebar.nav.up", title: "Sidebar: previous", group: "Navigation", hidden: true, run: () => void move(-1) },
      { id: "sidebar.nav.first", title: "Sidebar: first", group: "Navigation", hidden: true, run: () => void move(-1e9) },
      { id: "sidebar.nav.last", title: "Sidebar: last", group: "Navigation", hidden: true, run: () => void move(1e9) },
      { id: "sidebar.nav.collapse", title: "Sidebar: collapse leader or section / go to orchestrator", group: "Navigation", hidden: true, run: () => tree(-1) },
      { id: "sidebar.nav.expand", title: "Sidebar: expand leader or section / go to first worker", group: "Navigation", hidden: true, run: () => tree(1) },
      { id: "sidebar.tab.sessions", title: "Sidebar: Sessions tab", group: "View", keywords: ["sessions", "list"], run: () => showTab("sessions") },
      { id: "sidebar.tab.scheduled", title: "Sidebar: Scheduled tab (sessions scheduled tasks started)", group: "View", keywords: ["scheduled", "cron", "runs"], run: () => showTab("scheduled") },
      { id: "sidebar.tab.next", title: "Sidebar: switch between Sessions and Scheduled", group: "View", run: () => showTab(useStore.getState().sidebarTab === "sessions" ? "scheduled" : "sessions") },
      { id: "sidebar.toggle-archived", title: "Show / hide archived sessions", group: "View", run: () => useStore.getState().setShowArchived(!useStore.getState().showArchived) },
    ]);
  }, [select, setCursor]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-session-id="${cursor ?? selectedId}"]`) ?? listRef.current?.querySelector<HTMLElement>(".session-row.cursor, .section-heading.cursor");
    el?.scrollIntoView?.({ block: "nearest" });
  }, [cursor, selectedId, collapsedGroups, tab]);

  const marked = cursor ?? selectedId;
  const markedLeader = marked && allSessions[marked] ? leaderOf(allSessions[marked], allSessions).id : null;
  const label = (group: string, list: Session[]) => {
    if (group.startsWith(STATE_SECTION)) return CATEGORY_LABEL[group.slice(STATE_SECTION.length) as SessionCategory] ?? group;
    if (group === ORCHESTRATORS_SECTION) return "Orchestrators";
    if (group.startsWith(TASK_SECTION)) {
      const id = group.slice(TASK_SECTION.length);
      return taskNames.get(id) ?? list.find((s) => s.scheduled_task_id === id)?.scheduled_task_name ?? "Deleted task";
    }
    return group || "Sessions";
  };
  const open = (id: string) => {
    if (suppressClick.current) return;
    select(id);
    setFocus("main");
  };

  /** A worker's row in its leader's nested list: no ⌘-digit, not draggable. */
  const workerRow = ({ session: s, depth }: NestedRow, leader: Session, peek: boolean, task: string | null) => {
    const children = treeOf(s.id, allSessions).filter((w) => w.orchestrator_id === s.id);
    const subOpen = !peek && !collapsedSub.includes(s.id);
    const attention = s.id !== viewedId ? s.attention : null;
    return (
      <div
        key={s.id}
        className={clsx("session-row", "worker", peek && waitsOnUser(s) && "needs-you", s.id === selectedId && "selected", s.id === cursor && cursor !== selectedId && "cursor", s.archived && "archived", attention && "unseen")}
        data-session-id={s.id}
        data-leader-id={leader.id}
        style={{ "--depth": depth } as CSSProperties}
        data-hint
        data-command="session.select"
        onClick={() => open(s.id)}
        title={folderOf(s) ?? "Orchestrator: belongs to no folder"}
      >
        <span className={clsx("dot", statusClass(s))} />
        <div className="session-row-body">
          <div className="title-line">
            {!peek && children.length > 0 && (
              <button
                className={clsx("orchestra-toggle", !subOpen && "collapsed")}
                data-hint
                aria-expanded={subOpen}
                aria-label={`${subOpen ? "Hide" : "Show"} the workers of ${s.title}`}
                title={subOpen ? "Hide workers" : "Show workers"}
                onClick={(e) => {
                  e.stopPropagation();
                  setOrchestraExpanded(s.id, !subOpen);
                }}
              />
            )}
            <span className="title" title={s.title}>{task && s.scheduled_task_name && s.title.startsWith(`${s.scheduled_task_name} · `) ? s.title.slice(s.scheduled_task_name.length + 3) : s.title}</span>
            {attention && <span className={clsx("attention", ATTENTION[attention].className)} role="img" aria-label={ATTENTION[attention].label} title={ATTENTION[attention].label} />}
            {s.archived && <span className="chip">archived</span>}
            {s.pending_count > 0 && <span className="badge">{s.pending_count}</span>}
            <span className="age">{relTime(s.last_activity)}</span>
          </div>
          <SessionRowDetails session={s} selected={s.id === selectedId} workers={null} />
        </div>
      </div>
    );
  };

  return (
    <div className={clsx("region sidebar", focus === "sidebar" && "focused")} data-region="sidebar" tabIndex={0} onFocus={() => useStore.getState().setFocus("sidebar")}>
      <WorkspaceSwitcher />
      <div className="sidebar-head">
        <input
          data-sidebar-filter
          placeholder="Filter sessions  /"
          aria-label="Filter sessions"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" || e.key === "Enter") {
              (e.target as HTMLInputElement).blur();
              (e.currentTarget.closest("[data-region]") as HTMLElement | null)?.focus();
              e.stopPropagation();
            }
          }}
        />
        <button className="btn small" data-command="session.new" title="New session" aria-label="New session" onClick={() => void runCommand("session.new")}>
          +
        </button>
      </div>
      <SidebarTabs />
      <div className={clsx("session-list", dragging && "dragging")} ref={listRef} id="sidebar-session-list" role="tabpanel" aria-labelledby={`sidebar-tab-${tab}`}>
        {groups.length === 0 && <EmptyList tab={tab} filter={filter} />}
        {groups.map(([group, list]) => {
          const name = label(group, list);
          const folded = !filter && collapsedGroups.includes(groupKey(tab, group));
          const task = group.startsWith(TASK_SECTION) ? group.slice(TASK_SECTION.length) : null;
          return (
          <div key={group || "__none"} role="group" className={group.startsWith(STATE_SECTION) ? `state-section ${group.slice(STATE_SECTION.length)}` : undefined} aria-label={hasHeading(group, keys) ? name : undefined}>
            {/* Below the orchestrators, the other ungrouped sessions need a heading of their own. */}
            {hasHeading(group, keys) && (
              <SectionHeading tab={tab} section={group} label={name} list={list} folded={folded} current={folded && list.some((s) => s.id === markedLeader)} viewedId={viewedId}>
                {task && taskNames.has(task) && (
                  <button type="button" className="section-action" data-hint data-command="schedules.open-task" title={`Edit the scheduled task “${name}”`} aria-label={`Edit the scheduled task ${name}`} onClick={() => openSchedules(task)}>
                    Edit task
                  </button>
                )}
              </SectionHeading>
            )}
            {list.map((s) => {
              if (!visibleIds.has(s.id)) return null;
              const idx = sessions.indexOf(s);
              const tree = treeOf(s.id, allSessions);
              const shownTree = tree.map((w) => (w.id === viewedId ? { ...w, attention: null } : w));
              const n = nested.get(s.id) ?? { rows: [], expanded: false, more: 0, overflow: false, total: 0 };
              const expanded = n.expanded && tree.length > 0;
              const toggle = () => setOrchestraExpanded(s.id, !n.expanded);
              const ownAttention = s.id !== viewedId ? s.attention : null;
              const attention = hiddenAttention([{ ...s, attention: ownAttention }, ...shownTree]);
              const pending = s.pending_count + tree.reduce((sum, w) => sum + w.pending_count, 0);
              const inside = !n.rows.some((r) => r.session.id === marked) && markedLeader === s.id && marked !== s.id;
              const summary = tree.length ? workersSummary(tree) : null;
              const a11y = `${s.title}, ${stateWord(s)}.${summary ? ` ${summary.text.replace(" · ", ": ")}. ${expanded ? "Expanded" : "Collapsed"}.` : ""}`;
              return (
                <div key={s.id} className="leader" data-leader={s.id}>
                  <div
                    className={clsx(
                      "session-row",
                      s.id === selectedId && "selected",
                      s.id === cursor && cursor !== selectedId && "cursor",
                      s.archived && "archived",
                      ownAttention && "unseen",
                      inside && "cursor",
                      s.id === dragging && "drag-source",
                      dropTarget?.id === s.id && (dropTarget.below ? "drop-below" : "drop-above"),
                    )}
                    data-session-id={s.id}
                    aria-label={a11y}
                    data-hint
                    data-command="session.select"
                    onPointerDown={(e) => {
                      if (e.button === 0) drag.current = { id: s.id, startY: e.clientY, active: false };
                    }}
                    onClick={() => open(s.id)}
                    title={folderOf(s) ?? "Orchestrator: belongs to no folder"}
                  >
                    <span className={clsx("dot", statusClass(s))} />
                    <div className="session-row-body">
                      <div className="title-line">
                        {tree.length > 0 && (
                          <button
                            className={clsx("orchestra-toggle", !expanded && "collapsed")}
                            data-hint
                            aria-expanded={expanded}
                            aria-label={`${expanded ? "Hide" : "Show"} the workers of ${s.title}`}
                            title={expanded ? "Hide workers" : "Show workers"}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggle();
                            }}
                          />
                        )}
                        {s.pinned && <span className="pin" title="pinned">📌</span>}
                        <span className="title" title={s.title}>{task && s.scheduled_task_name && s.title.startsWith(`${s.scheduled_task_name} · `) ? s.title.slice(s.scheduled_task_name.length + 3) : s.title}</span>
                        {attention && <span className={clsx("attention", ATTENTION[attention].className)} role="img" aria-label={ATTENTION[attention].label} title={ATTENTION[attention].label} />}
                        {s.archived && <span className="chip">archived</span>}
                        {pending > 0 && <span className="badge" title={pendingTitle(s, tree)}>{pending}</span>}
                        {s.orchestrator && tree.length > 0 && (
                          <button
                            type="button"
                            className="row-action"
                            data-hint
                            data-command="workers.cleanup-orchestrator"
                            title={`Clean up the workers of ${s.title}`}
                            aria-label={`Clean up the workers of ${s.title}`}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              useStore.getState().openDialog({ kind: "workers-cleanup", orchestratorId: s.id });
                            }}
                          >
                            Clean up
                          </button>
                        )}
                        {idx < 9 && <kbd>{idx + 1}</kbd>}
                        <span className="age">{relTime(s.last_activity)}</span>
                      </div>
                      <SessionRowDetails session={s} selected={s.id === selectedId} workers={tree.length > 0 && <WorkersChip leader={s} tree={shownTree} expanded={expanded} onToggle={toggle} />} />
                    </div>
                  </div>
                  {n.rows.map((r) => workerRow(r, s, !n.expanded, task))}
                  {!n.expanded && n.rows.length > 0 && n.more > 0 && (
                    <button type="button" className="nested-more dim" data-hint onClick={toggle} aria-label={`Show all ${n.total} workers of ${s.title}`}>
                      +{n.more} more {n.more === 1 ? "worker" : "workers"}
                    </button>
                  )}
                  {n.overflow && (
                    <button type="button" className="nested-more dim" data-hint data-command="orchestrator.workers" onClick={() => openWorkerThread(s.id)}>
                      Open workers panel
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          );
        })}
        {showArchived && <div className="section-title">showing archived</div>}
      </div>
      <StatusRail />
      <ScheduleSidebar />
      <SidebarModSections focused={focus === "sidebar"} />
    </div>
  );
}

