import { openPull, useReviews, visiblePulls } from "../features/reviews/state";
import { ReviewSidebar } from "../features/reviews/ReviewSidebar";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { useStore, selectVisibleSessions, selectSessionSections, selectOrchestra, canReorder, isNestedWorker, orchestratorsOf, type AppState } from "../state/store";
import type { BranchPull, Session } from "../gen";
import { basename, relTime } from "../lib/platform";
import { registerCommands } from "../lib/commands";
import { setFocus } from "../commands/core";
import clsx from "clsx";
import { useShallow } from "zustand/react/shallow";
import { useDetectedLinksStore, useLinkPreferencesStore, useSidebarLinks } from "../state/sessionLinkPreferences";
import { selectedSessionLinks, sessionLinks } from "../views/issueLinks";
import { useGithubRepo } from "../state/githubRepos";
import { useSessionBranch } from "../state/branchStatus";
import { BranchPullChip, GitCounts, branchName, describeBranchPull } from "./BranchStatus";
import { statusClass } from "../lib/sessionStatus";
import { useRecordBranchPull } from "../state/pullSessions";
import { ATTENTION, hiddenAttention, useViewedSessionId } from "../state/attention";

/** Every session row in sidebar order, the workers of collapsed orchestrators included. */
const selectAllRows = (st: AppState) => selectSessionSections(st, true).flatMap(([, list]) => list);

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
 * and model, which give way first. Then the session's issues and PRs.
 */
function SessionRowDetails({ session: s, selected, hidden }: { session: Session; selected: boolean; hidden: Session[] }) {
  const { git, pull } = useSessionBranch(s, selected);
  useRecordBranchPull(s, pull);
  const branch = (git && branchName(git)) ?? s.worktree?.branch;
  const agent = s.agent ?? s.provider;
  return (
    <>
      <div className="sub">
        <span className={clsx("agent", s.provider)} title={`Agent: ${agent}`}>{agent}</span>
        {s.orchestrator && <span className="orchestrator-mark" role="img" aria-label="Orchestrator" title="Orchestrator: starts and directs the sessions under it" />}
        {hidden.length > 0 && <HiddenWorkers hidden={hidden} />}
        <span className="where">
          {!s.worktree && basename(s.cwd)}
          {branch && `${s.worktree ? "" : " · "}⎇ ${branch}`}
          {git && <GitCounts git={git} />}
          {s.mode === "terminal" && s.provider !== "terminal" ? " · tui" : ""}
          {s.model ? ` · ${s.model}` : ""}
        </span>
      </div>
      <SessionRowLinks session={s} branchPull={pull} />
    </>
  );
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

/**
 * How many of the chips in `ref` fit on its one line whole, leaving room for
 * the "+N" chip after them when some do not. Chips past that stay laid out,
 * out of sight, so they can be measured again when the sidebar widens.
 */
function useFittingChips(ref: RefObject<HTMLDivElement | null>, key: string) {
  const [fit, setFit] = useState(Infinity);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const widths = [...el.querySelectorAll<HTMLElement>(":scope > .link-slot")].map((c) => c.offsetWidth);
      const more = el.querySelector<HTMLElement>(":scope > .links-more")?.offsetWidth ?? 0;
      const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
      const width = (n: number) => widths.slice(0, n).reduce((sum, w) => sum + w, 0) + gap * Math.max(0, n - 1);
      let n = widths.length;
      if (width(n) > el.clientWidth) do n--; while (n > 0 && width(n) + gap + more > el.clientWidth);
      setFit(n);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, key]);
  return fit;
}

/**
 * The pull request of the session's branch with its status, then the issue and
 * PR numbers linked to the session as the Inspector shows them. As many whole
 * chips as fit, then "+N" with the rest in its tooltip.
 */
function SessionRowLinks({ session, branchPull }: { session: Session; branchPull: BranchPull | null }) {
  const transcript = useStore((s) => s.transcripts[session.id]);
  const preferences = useLinkPreferencesStore((s) => s.entries[session.id]?.preferences);
  const detected = useDetectedLinksStore((s) => s.links[session.id]);
  const repo = useGithubRepo(session.cwd);
  const links = useMemo(() => {
    const automatic = transcript?.loaded ? sessionLinks(transcript.items, session.title, repo) : detected ?? sessionLinks({}, session.title, repo);
    return selectedSessionLinks(automatic, preferences);
  }, [transcript?.loaded, transcript?.items, session.title, repo, detected, preferences]);
  // The branch's pull request replaces the same PR linked from the transcript.
  const shown = branchPull ? links.filter((l) => !(l.kind === "PR" && Number(l.number) === branchPull.number && l.repo.toLowerCase() === branchPull.repo.toLowerCase())) : links;
  const chips = [
    ...(branchPull ? [{ key: branchPull.url, tip: describeBranchPull(branchPull), chip: <BranchPullChip pull={branchPull} /> }] : []),
    ...shown.map((link) => ({ key: link.url, tip: link.url, chip: <span className="session-row-link" title={link.url}>{link.kind} #{link.number}</span> })),
  ];
  const ref = useRef<HTMLDivElement>(null);
  // The branch PR's labels change its width, so they are part of what is measured.
  const fit = useFittingChips(ref, chips.map((c) => c.key).join(" ") + (branchPull ? describeBranchPull(branchPull) : ""));
  if (chips.length === 0) return null;
  const rest = chips.slice(fit);
  return (
    <div className="links" ref={ref}>
      {chips.map((c, i) => <span key={c.key} className={clsx("link-slot", i >= fit && "overflow")} aria-hidden={i >= fit || undefined}>{c.chip}</span>)}
      {/* Measured even while every chip fits, at its widest. */}
      <span className={clsx("chip", "links-more", rest.length === 0 && "overflow")} aria-hidden={rest.length === 0 || undefined} title={rest.map((c) => c.tip).join("\n")}>
        +{rest.length || chips.length}
      </span>
    </div>
  );
}

export function Sidebar() {
  const sessions = useStore(useShallow(selectVisibleSessions));
  const rows = useStore(useShallow(selectAllRows));
  const collapsedOrchestras = useStore((s) => s.collapsedOrchestras);
  const setOrchestraCollapsed = useStore((s) => s.setOrchestraCollapsed);
  const selectedId = useStore((s) => s.prSelection || s.reviewHistoryOpen ? null : s.selectedId);
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
  useSidebarLinks(useMemo(() => sessions.map((s) => s.id), [sessions]));

  // Rows are already in section order; split them without re-sorting so they
  // read top to bottom in ⌘1–9 order. Collapsed workers stay in to count them.
  const groups = useMemo(() => {
    const m = new Map<string, Session[]>();
    for (const s of rows) {
      const g = s.group ?? "";
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(s);
    }
    return [...m.entries()];
  }, [rows]);
  const visibleIds = useMemo(() => new Set(sessions.map((s) => s.id)), [sessions]);

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
      const current = st.prSelection ? undefined : sidebarCurrent(st, all);
      // Up and down step over the workers of other orchestras; they are reached from
      // their orchestrator. First and last still go to the ends of the sidebar.
      const orchestra = current && selectOrchestra(st, current.id);
      const sessions = Math.abs(delta) > 1 ? all : selectSessionSections(st).flatMap(([, list]) => list.filter((s) => orchestra?.includes(s) || orchestratorsOf(s, list).length === 0));
      const { review, mine } = visiblePulls(useReviews.getState());
      const pulls = [...review, ...mine];
      const count = sessions.length + pulls.length;
      if (!count) return true;
      const cur = st.prSelection ? sessions.length + pulls.findIndex((p) => p.id === st.prSelection?.id) : current ? sessions.indexOf(current) : -1;
      const next = Math.max(0, Math.min(count - 1, cur < 0 ? 0 : cur + delta));
      if (next < sessions.length) go(sessions[next].id);
      else { openPull(pulls[next - sessions.length]); useStore.getState().setFocus("sidebar"); }
      return true;
    };
    // Tree keys: right opens an orchestrator, then steps to its first worker;
    // left closes it, or steps from a worker up to its orchestrator.
    const tree = (dir: -1 | 1) => {
      const st = useStore.getState();
      if (st.focus !== "sidebar" || st.prSelection) return;
      const current = sidebarCurrent(st, selectVisibleSessions(st));
      const section = current && selectSessionSections(st, true).find(([, list]) => list.includes(current))?.[1];
      if (!current || !section) return;
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
      }
    };
    return registerCommands([
      { id: "sidebar.nav.down", title: "Sidebar: next", group: "Navigation", hidden: true, run: () => void move(1) },
      { id: "sidebar.nav.up", title: "Sidebar: previous", group: "Navigation", hidden: true, run: () => void move(-1) },
      { id: "sidebar.nav.first", title: "Sidebar: first", group: "Navigation", hidden: true, run: () => void move(-1e9) },
      { id: "sidebar.nav.last", title: "Sidebar: last", group: "Navigation", hidden: true, run: () => void move(1e9) },
      { id: "sidebar.nav.collapse", title: "Sidebar: collapse orchestrator / go to orchestrator", group: "Navigation", hidden: true, run: () => tree(-1) },
      { id: "sidebar.nav.expand", title: "Sidebar: expand orchestrator / go to first worker", group: "Navigation", hidden: true, run: () => tree(1) },
      { id: "sidebar.toggle-archived", title: "Show / hide archived sessions", group: "View", run: () => useStore.getState().setShowArchived(!useStore.getState().showArchived) },
    ]);
  }, [select, setCursor]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-session-id="${cursor ?? selectedId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor, selectedId]);

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
      <div className={clsx("session-list", dragging && "dragging")} ref={listRef}>
        {sessions.length === 0 && (
          <div className="empty" style={{ height: "auto", padding: 20 }}>
            <span>No sessions{filter ? " match" : ""}.</span>
            {!filter && <span>Press <kbd>⌘N</kbd> to create one.</span>}
          </div>
        )}
        {groups.map(([group, list]) => (
          <div key={group || "__none"}>
            {group && <div className="section-title group-title">{group}</div>}
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
                  title={s.cwd}
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
                      <span className="title">{s.title}</span>
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
        ))}
        {showArchived && <div className="section-title">showing archived</div>}
      </div>
      <ReviewSidebar />
    </div>
  );
}
