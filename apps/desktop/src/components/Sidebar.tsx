import { openPull, useReviews, visiblePulls } from "../features/reviews/state";
import { ReviewSidebar } from "../features/reviews/ReviewSidebar";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, selectVisibleSessions, canReorder } from "../state/store";
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
import { BranchPullChip, GitCounts, branchName } from "./BranchStatus";

function statusClass(s: Session): string {
  switch (s.status) {
    case "running":
      return "info pulse";
    case "waiting_approval":
    case "waiting_input":
      return "warn pulse";
    case "error":
      return "err";
    case "exited":
      return "";
    default:
      return "ok";
  }
}

/** Folder or worktree, branch state, agent mode and model, then the session's issues and PRs. */
function SessionRowDetails({ session: s, selected }: { session: Session; selected: boolean }) {
  const { git, pull } = useSessionBranch(s, selected);
  const branch = (git && branchName(git)) ?? s.worktree?.branch;
  return (
    <>
      <div className="sub">
        {!s.worktree && basename(s.cwd)}
        {branch && `${s.worktree ? "" : " · "}⎇ ${branch}`}
        {git && <GitCounts git={git} />}
        {s.mode === "terminal" && s.provider !== "terminal" ? " · tui" : ""}
        {s.model ? ` · ${s.model}` : ""}
      </div>
      <SessionRowLinks session={s} branchPull={pull} />
    </>
  );
}

/**
 * The issue and PR numbers linked to a session, as the Inspector shows them,
 * and the pull request of its branch with its status.
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
  if (shown.length === 0 && !branchPull) return null;
  return (
    <div className="links">
      {shown.map((link) => (
        <span key={link.url} className="session-row-link" title={link.url}>{link.kind} #{link.number}</span>
      ))}
      {branchPull && <BranchPullChip pull={branchPull} />}
    </div>
  );
}

export function Sidebar() {
  const sessions = useStore(useShallow(selectVisibleSessions));
  const selectedId = useStore((s) => s.prSelection || s.reviewHistoryOpen ? null : s.selectedId);
  const cursor = useStore((s) => s.sidebarCursor);
  const filter = useStore((s) => s.sidebarFilter);
  const setFilter = useStore((s) => s.setSidebarFilter);
  const showArchived = useStore((s) => s.showArchived);
  const select = useStore((s) => s.select);
  const setCursor = useStore((s) => s.setSidebarCursor);
  const focus = useStore((s) => s.focus);
  const listRef = useRef<HTMLDivElement>(null);
  useSidebarLinks(useMemo(() => sessions.map((s) => s.id), [sessions]));

  // Visible sessions are already in section order; split them without re-sorting
  // so the rows read top to bottom in ⌘1–9 order.
  const groups = useMemo(() => {
    const m = new Map<string, Session[]>();
    for (const s of sessions) {
      const g = s.group ?? "";
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(s);
    }
    return [...m.entries()];
  }, [sessions]);

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
    const move = (delta: number) => {
      const st = useStore.getState();
      if (st.focus !== "sidebar") return false;
      const sessions = selectVisibleSessions(st);
      const { review, mine } = visiblePulls(useReviews.getState());
      const pulls = [...review, ...mine];
      const count = sessions.length + pulls.length;
      if (!count) return true;
      const cur = st.prSelection ? sessions.length + pulls.findIndex((p) => p.id === st.prSelection?.id) : sessions.findIndex((s) => s.id === (st.sidebarCursor ?? st.selectedId));
      const next = Math.max(0, Math.min(count - 1, cur < 0 ? 0 : cur + delta));
      if (next < sessions.length) { setCursor(sessions[next].id); select(sessions[next].id); }
      else { openPull(pulls[next - sessions.length]); useStore.getState().setFocus("sidebar"); }
      return true;
    };
    return registerCommands([
      { id: "sidebar.nav.down", title: "Sidebar: next", group: "Navigation", hidden: true, run: () => void move(1) },
      { id: "sidebar.nav.up", title: "Sidebar: previous", group: "Navigation", hidden: true, run: () => void move(-1) },
      { id: "sidebar.nav.first", title: "Sidebar: first", group: "Navigation", hidden: true, run: () => void move(-1e9) },
      { id: "sidebar.nav.last", title: "Sidebar: last", group: "Navigation", hidden: true, run: () => void move(1e9) },
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
              const idx = sessions.indexOf(s);
              return (
                <div
                  key={s.id}
                  className={clsx(
                    "session-row",
                    s.id === selectedId && "selected",
                    s.id === cursor && cursor !== selectedId && "cursor",
                    s.archived && "archived",
                    s.id === dragging && "drag-source",
                    dropTarget?.id === s.id && (dropTarget.below ? "drop-below" : "drop-above"),
                  )}
                  data-session-id={s.id}
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
                  <div style={{ minWidth: 0 }}>
                    <div className="title">
                      {s.pinned && <span title="pinned">📌 </span>}
                      {s.title}
                      {s.archived && <span className="chip" style={{ marginLeft: 6 }}>archived</span>}
                    </div>
                    <SessionRowDetails session={s} selected={s.id === selectedId} />
                  </div>
                  <div className="meta">
                    {s.pending_count > 0 && <span className="badge">{s.pending_count}</span>}
                    <span className={clsx("chip", s.provider)}>{s.agent ?? s.provider}</span>
                    {idx < 9 && <kbd>{idx + 1}</kbd>}
                    <span>{relTime(s.last_activity)}</span>
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
