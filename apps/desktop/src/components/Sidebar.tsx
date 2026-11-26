import { SessionRowModChips, SidebarModSections } from "../mods/Slots";
import { ScheduleSidebar } from "../features/schedules/ScheduleSidebar";
import { openSchedules, useSchedules } from "../features/schedules/state";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useStore, selectVisibleSessions, selectSessionSections, selectOrchestra, selectTabActivity, canReorder, groupKey, hasHeading, isNestedWorker, orchestratorsOf, ORCHESTRATORS_SECTION, TASK_SECTION, type AppState, type SidebarTab } from "../state/store";
import { folderOf } from "../lib/sessionFolder";
import type { Session } from "../gen";
import { basename, relTime } from "../lib/platform";
import { registerCommands } from "../lib/commands";
import { setFocus } from "../commands/core";
import clsx from "clsx";
import { useShallow } from "zustand/react/shallow";
import { useSessionBranch } from "../state/branchStatus";
import { GitCounts, branchName } from "./BranchStatus";
import { statusClass } from "../lib/sessionStatus";
import { ATTENTION, hiddenAttention, useViewedSessionId } from "../state/attention";
import { useFeature } from "../state/features";
import { openQuestions } from "../lib/features";

/** Every row of the tab shown, those of folded sections and the workers of collapsed orchestrators included. */
const selectAllRows = (st: AppState) => selectSessionSections(st, true).flatMap(([, list]) => list);
/** The section of each of those rows. */
const selectRowSections = (st: AppState) => selectSessionSections(st, true).flatMap(([g, list]) => list.map(() => g));

/** The id the sidebar keyboard is on, when its section is folded: the section's heading stands in for it. */
function foldedSectionOf(st: AppState, id: string | null): string | null {
  if (!id || st.sidebarFilter.trim()) return null;
  const sections = selectSessionSections(st, true);
  const keys = sections.map(([g]) => g);
  const section = sections.find(([, list]) => list.some((s) => s.id === id))?.[0];
  return section !== undefined && hasHeading(section, keys) && st.collapsedGroups.includes(groupKey(st.sidebarTab, section)) ? section : null;
}

/** The section heading the keyboard focus is on, if any. */
function focusedHeading(): { tab: SidebarTab; section: string } | null {
  const el = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>("[data-group-section]") : null;
  return el ? { tab: el.dataset.groupTab as SidebarTab, section: el.dataset.groupSection ?? "" } : null;
}

/** The session the sidebar keyboard acts on, or the orchestrator showing it when it is collapsed away. */
function sidebarCurrent(st: AppState, sessions: Session[]): Session | undefined {
  const id = st.sidebarCursor ?? st.selectedId;
  const s = sessions.find((v) => v.id === id);
  if (s || !id || !st.sessions[id]) return s;
  const section = selectSessionSections(st, true).find(([, list]) => list.some((l) => l.id === id))?.[1] ?? [];
  return orchestratorsOf(st.sessions[id], section).find((o) => sessions.includes(o));
}

/**
 * The quiet second line: agent, orchestrator mark, workers hidden under a
 * collapsed orchestrator, then folder or worktree, branch state, terminal mode
 * and model with its effort, which give way first. An orchestrator without a folder has none
 * of the folder's. Then the session's issues and PRs.
 */
function SessionRowDetails({ session: s, selected, hidden }: { session: Session; selected: boolean; hidden: Session[] }) {
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
        {hidden.length > 0 && <HiddenWorkers hidden={hidden} />}
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

/** A feature owner's state when it is news: decisions waiting on the user, or the feature delivered. */
function FeatureChip({ ownerId }: { ownerId: string }) {
  const feature = useFeature(ownerId);
  const open = openQuestions(feature).length;
  if (open > 0) return <span className="chip warn feature-state" title="The feature owner waits on your decision">{open === 1 ? "decision for you" : `${open} decisions for you`}</span>;
  if (feature?.status === "delivered") return <span className="chip ok feature-state" title="The feature owner delivered its report">delivered</span>;
  return null;
}

/** The "+N" chip of a collapsed orchestrator, marked when a worker under it waits on the user or has news. */
function HiddenWorkers({ hidden }: { hidden: Session[] }) {
  const attention = hiddenAttention(hidden);
  const lines = hidden.map((w) => (w.attention ? `${w.title} · ${ATTENTION[w.attention].label.toLowerCase()}` : w.title));
  return (
    <span className={clsx("chip", "workers", hidden.some((w) => w.pending_count > 0) && "warn")} title={lines.join("\n")}>
      +{hidden.length}
      {attention && <span className={clsx("attention", ATTENTION[attention].className)} role="img" aria-label={`Hidden workers: ${ATTENTION[attention].label.toLowerCase()}`} />}
    </span>
  );
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
 * section to the heading, which then shows how many sessions it holds and
 * whether one of them works or waits on the user.
 */
function SectionHeading({ tab, section, label, list, folded, current, viewedId, children }: {
  tab: SidebarTab; section: string; label: string; list: Session[]; folded: boolean; current: boolean; viewedId: string | null; children?: React.ReactNode;
}) {
  const setGroupCollapsed = useStore((s) => s.setGroupCollapsed);
  const working = list.filter((s) => s.status === "running").length;
  const pending = list.reduce((n, s) => n + s.pending_count, 0);
  const attention = hiddenAttention(list.map((s) => (s.id === viewedId ? { ...s, attention: null } : s)));
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

export function Sidebar() {
  const sessions = useStore(useShallow(selectVisibleSessions));
  const rows = useStore(useShallow(selectAllRows));
  const rowSections = useStore(useShallow(selectRowSections));
  const tab = useStore((s) => s.sidebarTab);
  const collapsedGroups = useStore((s) => s.collapsedGroups);
  const tasks = useSchedules((s) => s.tasks);
  const collapsedOrchestras = useStore((s) => s.collapsedOrchestras);
  const setOrchestraCollapsed = useStore((s) => s.setOrchestraCollapsed);
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

  // Sections in ⌘1–9 order, with the rows of folded sections and collapsed
  // workers in to count them.
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

  // Drag a row onto another row of the same group to reorder.
  const drag = useRef<{ id: string; startY: number; active: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; below: boolean } | null>(null);
  useEffect(() => {
    const targetAt = (e: PointerEvent) => {
      const d = drag.current;
      const id = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-session-id]")?.dataset.sessionId;
      if (!d || !id || id === d.id) return null;
      const list = selectVisibleSessions(useStore.getState());
      const from = list.findIndex((s) => s.id === d.id);
      const to = list.findIndex((s) => s.id === id);
      return from >= 0 && to >= 0 && canReorder(list[from], list[to]) ? { id, below: to > from } : null;
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
      const all = selectVisibleSessions(st);
      const current = sidebarCurrent(st, all);
      // Up and down step over the workers of other orchestras; they are reached from
      // their orchestrator. First and last still go to the ends of the sidebar.
      const orchestra = current && selectOrchestra(st, current.id);
      const sessions = Math.abs(delta) > 1 ? all : selectSessionSections(st).flatMap(([, list]) => list.filter((s) => orchestra?.includes(s) || orchestratorsOf(s, list).length === 0));
      const count = sessions.length;
      if (!count) return true;
      let cur = current ? sessions.indexOf(current) : -1;
      const id = st.sidebarCursor ?? st.selectedId;
      if (cur < 0 && foldedSectionOf(st, id) !== null) {
        // On a folded section's heading: step to the rows around it.
        const full = selectSessionSections(st, true).flatMap(([, list]) => list);
        const above = full.slice(0, full.findIndex((s) => s.id === id)).filter((s) => sessions.includes(s)).length;
        if (delta < 0 && above === 0 && Math.abs(delta) === 1) return true;
        cur = delta > 0 ? above - 1 : above;
      }
      const next = Math.max(0, Math.min(count - 1, cur < 0 && !(delta > 0 && foldedSectionOf(st, id) !== null) ? 0 : cur + delta));
      // Mods' sidebar sections (pull requests, …) keep their own keys while focused.
      go(sessions[next].id);
      return true;
    };
    // Tree keys: right opens an orchestrator, then steps to its first worker;
    // left closes it, or steps from a worker up to its orchestrator.
    // On a section's heading, or a row at the top of a section, they fold and unfold the section.
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
      const current = sidebarCurrent(st, selectVisibleSessions(st));
      const all = selectSessionSections(st, true);
      const entry = current && all.find(([, list]) => list.includes(current));
      const section = entry?.[1];
      if (!current || !section) return;
      const foldable = hasHeading(entry[0], all.map(([g]) => g)) && !st.sidebarFilter.trim();
      const workers = section.filter((w) => w.orchestrator_id === current.id && w !== current);
      const collapsed = st.collapsedOrchestras.includes(current.id);
      if (dir > 0) {
        if (workers.length && collapsed) st.setOrchestraCollapsed(current.id, false);
        else if (workers.length) go(workers[0].id);
      } else if (workers.length && !collapsed) {
        st.setOrchestraCollapsed(current.id, true);
        go(current.id);
      } else {
        const parent = orchestratorsOf(current, section)[0];
        if (parent) go(parent.id);
        // The cursor stays on the row; the heading shows it while the section is folded.
        else if (foldable) {
          st.setSidebarCursor(current.id);
          st.setGroupCollapsed(st.sidebarTab, entry[0], true);
        }
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
      { id: "sidebar.nav.collapse", title: "Sidebar: collapse orchestrator or section / go to orchestrator", group: "Navigation", hidden: true, run: () => tree(-1) },
      { id: "sidebar.nav.expand", title: "Sidebar: expand orchestrator or section / go to first worker", group: "Navigation", hidden: true, run: () => tree(1) },
      { id: "sidebar.tab.sessions", title: "Sidebar: Sessions tab", group: "View", keywords: ["sessions", "list"], run: () => showTab("sessions") },
      { id: "sidebar.tab.scheduled", title: "Sidebar: Scheduled tab (sessions scheduled tasks started)", group: "View", keywords: ["scheduled", "cron", "runs"], run: () => showTab("scheduled") },
      { id: "sidebar.tab.next", title: "Sidebar: switch between Sessions and Scheduled", group: "View", run: () => showTab(useStore.getState().sidebarTab === "sessions" ? "scheduled" : "sessions") },
      { id: "sidebar.toggle-archived", title: "Show / hide archived sessions", group: "View", run: () => useStore.getState().setShowArchived(!useStore.getState().showArchived) },
    ]);
  }, [select, setCursor]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-session-id="${cursor ?? selectedId}"]`) ?? listRef.current?.querySelector<HTMLElement>(".section-heading.cursor");
    el?.scrollIntoView?.({ block: "nearest" });
  }, [cursor, selectedId, collapsedGroups, tab]);

  const marked = cursor ?? selectedId;
  const label = (group: string, list: Session[]) => {
    if (group === ORCHESTRATORS_SECTION) return "Orchestrators";
    if (group.startsWith(TASK_SECTION)) {
      const id = group.slice(TASK_SECTION.length);
      return taskNames.get(id) ?? list.find((s) => s.scheduled_task_id === id)?.scheduled_task_name ?? "Deleted task";
    }
    return group || "Sessions";
  };

  return (
    <div className={clsx("region sidebar", focus === "sidebar" && "focused")} data-region="sidebar" tabIndex={0} onFocus={() => useStore.getState().setFocus("sidebar")}>
      <div className="sidebar-head">
        <input
          data-sidebar-filter
          placeholder="Filter sessions  /"
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
        <button className="btn small" data-command="session.new" title="New session" onClick={() => void import("../lib/commands").then((m) => m.runCommand("session.new"))}>
          +
        </button>
      </div>
      <SidebarTabs />
      <div className={clsx("session-list", dragging && "dragging")} ref={listRef} id="sidebar-session-list" role="tabpanel" aria-labelledby={`sidebar-tab-${tab}`}>
        {groups.length === 0 && (tab === "scheduled" && !filter ? (
          <div className="empty" style={{ height: "auto", padding: 20 }}>
            <span>No sessions from scheduled tasks yet.</span>
            <span>Each run of a scheduled task is listed here, by task.</span>
            <button type="button" className="btn small" data-command="schedules.open" onClick={() => openSchedules()}>Scheduled tasks…</button>
          </div>
        ) : (
          <div className="empty" style={{ height: "auto", padding: 20 }}>
            <span>No {tab === "scheduled" ? "scheduled " : ""}sessions{filter ? " match" : ""}.</span>
            {!filter && tab === "sessions" && <span>Press <kbd>⌘N</kbd> to create one.</span>}
          </div>
        ))}
        {groups.map(([group, list]) => {
          const name = label(group, list);
          const folded = !filter && collapsedGroups.includes(groupKey(tab, group));
          const task = group.startsWith(TASK_SECTION) ? group.slice(TASK_SECTION.length) : null;
          return (
          <div key={group || "__none"} role="group" aria-label={hasHeading(group, keys) ? name : undefined}>
            {/* Below the orchestrators, the other ungrouped sessions need a heading of their own. */}
            {hasHeading(group, keys) && (
              <SectionHeading tab={tab} section={group} label={name} list={list} folded={folded} current={folded && list.some((s) => s.id === marked)} viewedId={viewedId}>
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
              const depth = orchestratorsOf(s, list).length;
              const workers = list.filter((w) => w.orchestrator_id === s.id && w !== s);
              const collapsed = workers.length > 0 && collapsedOrchestras.includes(s.id);
              const hidden = collapsed ? list.filter((l) => !visibleIds.has(l.id) && orchestratorsOf(l, list).includes(s)) : [];
              const attention = s.id !== viewedId ? s.attention : null;
              return (
                <div
                  key={s.id}
                  className={clsx(
                    "session-row",
                    s.id === selectedId && "selected",
                    s.id === cursor && cursor !== selectedId && "cursor",
                    s.archived && "archived",
                    attention && "unseen",
                    isNestedWorker(s, list) && "worker",
                    hidden.some((w) => w.id === selectedId || w.id === cursor) && "cursor",
                    s.id === dragging && "drag-source",
                    dropTarget?.id === s.id && (dropTarget.below ? "drop-below" : "drop-above"),
                  )}
                  data-session-id={s.id}
                  style={depth > 1 ? ({ "--depth": depth } as CSSProperties) : undefined}
                  data-hint
                  data-command="session.select"
                  onPointerDown={(e) => {
                    if (e.button === 0) drag.current = { id: s.id, startY: e.clientY, active: false };
                  }}
                  onClick={() => {
                    if (suppressClick.current) return;
                    select(s.id);
                    setFocus("main");
                  }}
                  title={folderOf(s) ?? "Orchestrator: belongs to no folder"}
                >
                  <span className={clsx("dot", statusClass(s))} />
                  <div className="session-row-body">
                    <div className="title-line">
                      {workers.length > 0 && (
                        <button
                          className={clsx("orchestra-toggle", collapsed && "collapsed")}
                          data-hint
                          aria-expanded={!collapsed}
                          aria-label={`${collapsed ? "Show" : "Hide"} the workers of ${s.title}`}
                          title={collapsed ? "Show workers" : "Hide workers"}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            setOrchestraCollapsed(s.id, !collapsed);
                          }}
                        />
                      )}
                      {s.pinned && <span className="pin" title="pinned">📌</span>}
                      <span className="title" title={s.title}>{task && s.scheduled_task_name && s.title.startsWith(`${s.scheduled_task_name} · `) ? s.title.slice(s.scheduled_task_name.length + 3) : s.title}</span>
                      {attention && <span className={clsx("attention", ATTENTION[attention].className)} role="img" aria-label={ATTENTION[attention].label} title={ATTENTION[attention].label} />}
                      {s.archived && <span className="chip">archived</span>}
                      {s.pending_count > 0 && <span className="badge">{s.pending_count}</span>}
                      {idx < 9 && <kbd>{idx + 1}</kbd>}
                      <span className="age">{relTime(s.last_activity)}</span>
                    </div>
                    <SessionRowDetails session={s} selected={s.id === selectedId} hidden={hidden} />
                  </div>
                </div>
              );
            })}
          </div>
          );
        })}
        {showArchived && <div className="section-title">showing archived</div>}
      </div>
      <ScheduleSidebar />
      <SidebarModSections focused={focus === "sidebar"} />
    </div>
  );
}
