import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import clsx from "clsx";
import { create } from "zustand";
import { useStore, selectWorkspaceActivity, type WorkspaceActivity } from "../state/store";
import { ATTENTION, useViewedSessionId } from "../state/attention";
import { runCommand } from "../lib/commands";
import { isMac } from "../lib/platform";
import { formatKeys } from "../lib/keymap";
import { workspaceDigitKeys } from "../keymap/default";
import type { Session } from "../gen";

/** Which of the switcher's popovers is open: the workspace list, or the workspace actions. */
export const useWorkspaceMenu = create<{ open: "switch" | "actions" | null }>(() => ({ open: null }));

/** Open the workspace list (`workspace.switch`). */
export function openWorkspaceMenu() {
  useStore.getState().setSidebarCollapsed(false);
  useWorkspaceMenu.setState({ open: "switch" });
}

const rank = (a: Session["attention"]) => (a === "waiting" ? 3 : a === "failed" ? 2 : a ? 1 : 0);

function useActivity(): Record<string, WorkspaceActivity> {
  const viewedId = useViewedSessionId();
  const sessions = useStore((s) => s.sessions);
  const workspaces = useStore((s) => s.workspaces);
  return useMemo(() => selectWorkspaceActivity({ ...useStore.getState(), sessions, workspaces }, viewedId), [sessions, workspaces, viewedId]);
}

/** A workspace's activity as the menu and the summary show it: working dot, attention marker, pending badge. */
function ActivityMarks({ a, working = true }: { a: WorkspaceActivity; working?: boolean }) {
  return (
    <>
      {working && a.working > 0 && <span className="dot ok pulse" role="img" aria-label={`${a.working} working`} />}
      {a.attention && <span className={clsx("attention", ATTENTION[a.attention].className)} role="img" aria-label={ATTENTION[a.attention].label} />}
      {a.pending > 0 && <span className="badge" aria-label={`${a.pending} waiting on you`}>{a.pending}</span>}
    </>
  );
}

/** The workspace list: switch with ↑/↓ and Enter, type to filter, Esc to close. Ends with "New workspace…". */
function SwitchMenu({ onClose }: { onClose: () => void }) {
  const workspaces = useStore((s) => s.workspaces);
  const active = useStore((s) => s.activeWorkspace);
  const activity = useActivity();
  const [q, setQ] = useState("");
  const shown = useMemo(() => workspaces.filter((w) => w.name.toLowerCase().includes(q.trim().toLowerCase())), [workspaces, q]);
  // The last entry is "New workspace…".
  const count = shown.length + 1;
  const [index, setIndex] = useState(() => Math.max(0, shown.findIndex((w) => w.id === active)));
  useEffect(() => setIndex((i) => Math.min(i, count - 1)), [count]);
  const pick = (i: number) => {
    onClose();
    if (i >= shown.length) void runCommand("workspace.new");
    else useStore.getState().switchWorkspace(shown[i].id);
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") setIndex((i) => Math.min(count - 1, i + 1));
    else if (e.key === "ArrowUp") setIndex((i) => Math.max(0, i - 1));
    else if (e.key === "Home") setIndex(0);
    else if (e.key === "End") setIndex(count - 1);
    else if (e.key === "Enter") pick(index);
    else if (e.key === "Escape") onClose();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <div className="workspace-menu" role="dialog" aria-label="Switch workspace" data-keynav data-own-escape onKeyDown={onKeyDown}>
      <input
        type="text"
        autoFocus
        value={q}
        placeholder="Filter workspaces…"
        aria-label="Filter workspaces"
        aria-controls="workspace-listbox"
        aria-activedescendant={`workspace-option-${index}`}
        onChange={(e) => { setQ(e.target.value); setIndex(0); }}
      />
      <div className="workspace-options" role="listbox" id="workspace-listbox" aria-label="Workspaces">
        {shown.map((w, i) => {
          const a = activity[w.id] ?? { sessions: 0, working: 0, pending: 0, attention: null };
          const n = workspaces.indexOf(w);
          return (
            <div
              key={w.id}
              id={`workspace-option-${i}`}
              role="option"
              aria-selected={w.id === active}
              className={clsx("workspace-option", i === index && "active", w.id === active && "current")}
              data-hint
              data-command="workspace.switch"
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(i)}
              title={w.name}
            >
              <span className="check" aria-hidden>{w.id === active ? "✓" : ""}</span>
              <span className="grow name">{w.name}</span>
              <span className="dim count" aria-label={`${a.sessions} sessions`}>{a.sessions}</span>
              <ActivityMarks a={a} />
              {n < 9 && <kbd>{formatKeys(workspaceDigitKeys(n + 1, isMac), isMac)}</kbd>}
            </div>
          );
        })}
        {shown.length === 0 && <div className="dim workspace-none">No workspace matches.</div>}
        <div className="workspace-divider" role="separator" />
        <div
          id={`workspace-option-${shown.length}`}
          role="option"
          aria-selected={false}
          className={clsx("workspace-option", index === shown.length && "active")}
          data-hint
          data-command="workspace.new"
          onMouseEnter={() => setIndex(shown.length)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => pick(shown.length)}
        >
          <span className="check" aria-hidden>+</span>
          <span className="grow">New workspace…</span>
        </div>
      </div>
    </div>
  );
}

const ACTIONS: { command: string; label: string }[] = [
  { command: "workspace.rename", label: "Rename workspace…" },
  { command: "workspace.delete", label: "Delete workspace…" },
  { command: "workers.cleanup", label: "Clean up worker sessions…" },
  { command: "workspace.new", label: "New workspace…" },
];

/** The ⋯ menu: rename, delete, clean up workers, new workspace. */
function ActionsMenu({ onClose }: { onClose: () => void }) {
  const only = useStore((s) => s.workspaces.length < 2);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => refs.current.find((b) => b && !b.disabled)?.focus(), []);
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const items = refs.current.filter((b): b is HTMLButtonElement => !!b && !b.disabled);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") items[(i + 1) % items.length]?.focus();
    else if (e.key === "ArrowUp") items[(i - 1 + items.length) % items.length]?.focus();
    else if (e.key === "Escape") onClose();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <div className="workspace-menu workspace-actions" role="menu" aria-label="Workspace actions" data-keynav data-own-escape onKeyDown={onKeyDown}>
      {ACTIONS.map((a, i) => {
        const disabled = a.command === "workspace.delete" && only;
        return (
          <button
            key={a.command}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="menuitem"
            className="workspace-option"
            disabled={disabled}
            title={disabled ? "Aura needs at least one workspace" : undefined}
            data-hint
            data-command={a.command}
            onClick={() => {
              onClose();
              void runCommand(a.command);
            }}
          >
            {a.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The top of the sidebar: the active workspace's name, which opens the
 * workspace list; what waits on the user in the other workspaces; and the ⋯
 * actions. Hidden against a daemon without workspaces.
 */
export function WorkspaceSwitcher() {
  const workspaces = useStore((s) => s.workspaces);
  const activeId = useStore((s) => s.activeWorkspace);
  const open = useWorkspaceMenu((s) => s.open);
  const activity = useActivity();
  const root = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const close = (refocus = true) => {
    const was = useWorkspaceMenu.getState().open;
    useWorkspaceMenu.setState({ open: null });
    if (refocus) (was === "actions" ? moreRef : nameRef).current?.focus();
  };
  // A click outside closes the menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) useWorkspaceMenu.setState({ open: null });
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  const active = workspaces.find((w) => w.id === activeId);
  if (!active) return null;

  // Other workspaces' approvals, questions and the most urgent marker; scheduled runs are not counted.
  let pending = 0;
  let attention: Session["attention"] = null;
  for (const w of workspaces) {
    const a = activity[w.id];
    if (w.id === activeId || !a) continue;
    pending += a.pending;
    if (rank(a.attention) > rank(attention)) attention = a.attention;
  }
  const others = { sessions: 0, working: 0, pending, attention };
  return (
    <div className="workspace-switcher" ref={root}>
      <button
        ref={nameRef}
        type="button"
        className="workspace-name"
        data-hint
        data-command="workspace.switch"
        aria-haspopup="listbox"
        aria-expanded={open === "switch"}
        aria-label={`Workspace: ${active.name}. Switch workspace`}
        title={active.name}
        onClick={() => useWorkspaceMenu.setState({ open: open === "switch" ? null : "switch" })}
      >
        <span className="section-chevron" aria-hidden />
        <span className="name">{active.name}</span>
      </button>
      {(pending > 0 || attention) && (
        <span className="workspace-others" title={`Other workspaces: ${pending > 0 ? `${pending} waiting on you` : ATTENTION[attention!].label.toLowerCase()}`}>
          <ActivityMarks a={others} working={false} />
        </span>
      )}
      <button
        ref={moreRef}
        type="button"
        className="workspace-more"
        data-hint
        aria-haspopup="menu"
        aria-expanded={open === "actions"}
        aria-label="Workspace actions"
        title="Workspace actions"
        onClick={() => useWorkspaceMenu.setState({ open: open === "actions" ? null : "actions" })}
      >
        ⋯
      </button>
      {open === "switch" && <SwitchMenu onClose={close} />}
      {open === "actions" && <ActionsMenu onClose={close} />}
    </div>
  );
}
