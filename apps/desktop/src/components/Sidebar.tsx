import { openPull, useReviews } from "../features/reviews/state";
import { ReviewSidebar } from "../features/reviews/ReviewSidebar";
import { useEffect, useMemo, useRef } from "react";
import { useStore, selectVisibleSessions } from "../state/store";
import type { Session } from "../gen";
import { basename, relTime } from "../lib/platform";
import { registerCommands } from "../lib/commands";
import { setFocus } from "../commands/core";
import clsx from "clsx";
import { useShallow } from "zustand/react/shallow";

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

  const groups = useMemo(() => {
    const m = new Map<string, Session[]>();
    for (const s of sessions) {
      const g = s.group ?? "";
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(s);
    }
    return [...m.entries()].sort((a, b) => (a[0] === "" ? -1 : b[0] === "" ? 1 : a[0].localeCompare(b[0])));
  }, [sessions]);

  // navigation commands scoped to the sidebar
  useEffect(() => {
    const move = (delta: number) => {
      const st = useStore.getState();
      if (st.focus !== "sidebar") return false;
      const sessions = selectVisibleSessions(st);
      const prs = useReviews.getState();
      const pulls = prs.hidden || prs.collapsed ? [] : (prs.inbox?.pulls ?? []).filter((p) => prs.showHidden || !p.hidden);
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
      <div className="session-list" ref={listRef}>
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
                  className={clsx("session-row", s.id === selectedId && "selected", s.id === cursor && cursor !== selectedId && "cursor", s.archived && "archived")}
                  data-session-id={s.id}
                  data-hint
                  data-command="session.select"
                  onClick={() => {
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
                    <div className="sub">
                      {s.worktree ? `⎇ ${s.worktree.branch}` : basename(s.cwd)}
                      {s.mode === "terminal" && s.provider !== "terminal" ? " · tui" : ""}
                      {s.model ? ` · ${s.model}` : ""}
                    </div>
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
