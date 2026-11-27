import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import clsx from "clsx";
import { useStore, selectRail, selectScheduledRail, type RailRow } from "../state/store";
import { ATTENTION, useViewedSessionId } from "../state/attention";
import { relTime } from "../lib/platform";
import { stateWord, statusClass } from "../lib/sessionStatus";
import { runCommand } from "../lib/commands";
import { focusRegionEl, setFocus } from "../commands/core";

/** Rows a rail block shows before "+ N more". */
const CAP = 5;
const SCHEDULED_CAP = 3;
/** The Elsewhere Idle block is folded by default; unfolding it is remembered here. */
const IDLE_OPEN_KEY = "aura.rail-idle-open.v1";

/** Move the keyboard into the rail, onto its first row. False when the rail has none. */
export function focusRail(): boolean {
  const first = document.querySelector<HTMLElement>("[data-rail-row]");
  first?.focus();
  return !!first;
}

/** A workspace name cut to fit the rail's suffix; the full name is in the tooltip. */
function shortName(name: string): string {
  return name.length > 12 ? `${name.slice(0, 11)}…` : name;
}

/** "· Tester needs you", "· 2 workers need you": why a leader that does not wait itself is here. */
function workerSuffix(row: RailRow): string | null {
  if (row.target === row.leader) return null;
  return row.waitingWorkers.length === 1 ? `${row.waitingWorkers[0].title} needs you` : `${row.waitingWorkers.length} workers need you`;
}

/**
 * Keeps `rows` in the order they had while `frozen`: new rows go last, so
 * nothing moves under the keyboard while the rail has focus.
 */
function useStableOrder(rows: RailRow[], frozen: boolean): RailRow[] {
  const last = useRef<string[]>([]);
  if (!frozen) {
    last.current = rows.map((r) => r.leader.id);
    return rows;
  }
  const at = new Map(last.current.map((id, i) => [id, i]));
  const out = [...rows].sort((a, b) => (at.get(a.leader.id) ?? Infinity) - (at.get(b.leader.id) ?? Infinity));
  last.current = out.map((r) => r.leader.id);
  return out;
}

function RailItem({ row, label, time, showWorkspace, onOpen }: { row: RailRow; label: string; time: string; showWorkspace: boolean; onOpen: () => void }) {
  const suffix = workerSuffix(row);
  const ws = row.workspace?.name ?? "";
  const state = suffix ?? stateWord(row.leader);
  return (
    <button
      type="button"
      className={clsx("session-row", "rail-row", row.attention && "unseen")}
      data-rail-row
      data-hint
      data-command="session.select"
      data-session-id-rail={row.leader.id}
      aria-label={[label, showWorkspace ? ws : null, state].filter(Boolean).join(", ")}
      title={[label, showWorkspace ? `in ${ws}` : null, state].filter(Boolean).join(" · ")}
      onClick={onOpen}
    >
      <span className={clsx("dot", statusClass(row.leader))} />
      <span className="title-line">
        <span className="title">{label}</span>
        {/* One suffix, which gives way before the title; the tooltip keeps all of it. */}
        {(showWorkspace && ws) || suffix ? <span className="dim rail-suffix">{[showWorkspace && ws ? shortName(ws) : null, suffix].filter(Boolean).map((t) => ` · ${t}`).join("")}</span> : null}
        {row.attention && <span className={clsx("attention", ATTENTION[row.attention].className)} role="img" aria-label={ATTENTION[row.attention].label} />}
        {row.pending > 0 && <span className="badge">{row.pending}</span>}
        <span className="age">{time}</span>
      </span>
    </button>
  );
}

/** "+ N more" and "Show less" under a capped block. */
function MoreToggle({ hidden, open, onToggle }: { hidden: number; open: boolean; onToggle: () => void }) {
  if (!open && hidden <= 0) return null;
  return (
    <button type="button" className="rail-more dim" data-rail-row data-hint aria-expanded={open} onClick={onToggle}>
      {open ? "Show less" : `+ ${hidden} more`}
    </button>
  );
}

/** Open what a rail row points at: its workspace, its tab, the session (or the worker that waits), with the keyboard in the main area. */
function openRow(row: RailRow) {
  useStore.getState().select(row.target.id);
  setFocus("main");
}

/**
 * The status rail, pinned under the session list: what needs the user and
 * what is idle in the other workspaces (Elsewhere, hidden while there is one
 * workspace), and the scheduled runs that work or wait, from every workspace.
 */
export function StatusRail() {
  const viewedId = useViewedSessionId();
  const sessions = useStore((s) => s.sessions);
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspace = useStore((s) => s.activeWorkspace);
  // Rows are built fresh on every change of what they are built from.
  const rail = useMemo(() => selectRail({ ...useStore.getState(), sessions, workspaces, activeWorkspace }, viewedId), [sessions, workspaces, activeWorkspace, viewedId]);
  const scheduled = useMemo(() => selectScheduledRail({ ...useStore.getState(), sessions, workspaces }, viewedId), [sessions, workspaces, viewedId]);
  const [focused, setFocused] = useState(false);
  const [needsOpen, setNeedsOpen] = useState(false);
  const [idleOpen, setIdleOpenState] = useState(() => {
    try {
      return localStorage.getItem(IDLE_OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [idleAll, setIdleAll] = useState(false);
  const setIdleOpen = (open: boolean) => {
    setIdleOpenState(open);
    try {
      localStorage.setItem(IDLE_OPEN_KEY, open ? "1" : "0");
    } catch {
      /* ignore */
    }
  };
  const needs = useStableOrder(rail?.needsYou ?? [], focused);
  const idle = useStableOrder(rail?.idle ?? [], focused);
  const runs = useStableOrder(scheduled, focused);
  if (!rail && runs.length === 0) return null;

  // Up and down move through the rail's rows; up from the first goes back to the list.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-rail-row]")];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const down = e.key === "ArrowDown" || e.key === "j";
    const up = e.key === "ArrowUp" || e.key === "k";
    if (e.key === "Escape") {
      focusRegionEl("sidebar");
    } else if (down) {
      items[Math.min(items.length - 1, i + 1)]?.focus();
    } else if (up) {
      if (i <= 0) {
        focusRegionEl("sidebar");
        void runCommand("sidebar.nav.last");
      } else items[i - 1]?.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const shownNeeds = needsOpen ? needs : needs.slice(0, CAP);
  const shownIdle = idleAll ? idle : idle.slice(0, CAP);
  return (
    <div
      className="status-rail"
      data-keynav
      data-own-escape
      onKeyDown={onKeyDown}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      {rail && (
        <div role="group" aria-label="Other workspaces" className="rail-block">
          <div className="section-title rail-heading">Elsewhere</div>
          <div className="rail-subheading">Needs you</div>
          {needs.length === 0 && <div className="dim rail-empty">Nothing needs you elsewhere.</div>}
          {shownNeeds.map((r) => (
            <RailItem key={r.leader.id} row={r} label={r.leader.title} time={relTime(r.leader.last_activity)} showWorkspace onOpen={() => openRow(r)} />
          ))}
          <MoreToggle hidden={needs.length - CAP} open={needsOpen} onToggle={() => setNeedsOpen(!needsOpen)} />
          {idle.length > 0 && (
            <div className={clsx("section-heading", "rail-idle", !idleOpen && "folded")}>
              <button
                type="button"
                className="section-title section-toggle"
                data-rail-row
                data-hint
                aria-expanded={idleOpen}
                aria-label={`Idle elsewhere, ${idle.length} ${idle.length === 1 ? "session" : "sessions"}. ${idleOpen ? "Hide" : "Show"} them`}
                onClick={() => setIdleOpen(!idleOpen)}
              >
                <span className="section-chevron" aria-hidden />
                <span className="section-label">Idle · {idle.length}</span>
              </button>
            </div>
          )}
          {idleOpen && shownIdle.map((r) => (
            <RailItem key={r.leader.id} row={r} label={r.leader.title} time={relTime(r.leader.last_activity)} showWorkspace onOpen={() => openRow(r)} />
          ))}
          {idleOpen && <MoreToggle hidden={idle.length - CAP} open={idleAll} onToggle={() => setIdleAll(!idleAll)} />}
        </div>
      )}
      {runs.length > 0 && (
        <div role="group" aria-label="Scheduled runs" className="rail-block rail-scheduled">
          <button type="button" className="section-title rail-heading" data-rail-row data-hint data-command="sidebar.tab.scheduled" title="Show the Scheduled tab" onClick={() => void runCommand("sidebar.tab.scheduled")}>
            Scheduled runs
          </button>
          {runs.slice(0, SCHEDULED_CAP).map((r) => (
            <RailItem
              key={r.leader.id}
              row={r}
              label={r.leader.scheduled_task_name ?? r.leader.title}
              time={relTime(r.leader.created_at)}
              showWorkspace={r.leader.workspace !== activeWorkspace && !!r.workspace}
              onOpen={() => openRow(r)}
            />
          ))}
          {runs.length > SCHEDULED_CAP && (
            <button type="button" className="rail-more dim" data-rail-row data-hint data-command="sidebar.tab.scheduled" onClick={() => void runCommand("sidebar.tab.scheduled")}>
              + {runs.length - SCHEDULED_CAP} more
            </button>
          )}
        </div>
      )}
    </div>
  );
}
