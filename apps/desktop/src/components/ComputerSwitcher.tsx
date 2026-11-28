import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import clsx from "clsx";
import { create } from "zustand";
import { useStore } from "../state/store";
import { LOCAL, localName, switchComputer, useComputers } from "../state/computers";
import { describeState, needsPairing, type RemoteComputer } from "../lib/remoteComputers";
import { runCommand } from "../lib/commands";
import { useShortcut } from "../hooks/useKeyboard";
import { StateDot } from "./dialogs/ComputersDialog";

/** Whether the computer list is open (`computer.switch`). */
export const useComputerMenu = create<{ open: boolean }>(() => ({ open: false }));

export function openComputerMenu() {
  useStore.getState().setSidebarCollapsed(false);
  useComputerMenu.setState({ open: true });
}

type Entry = { id: string; name: string; remote: RemoteComputer | null; pending: number };

function useEntries(): Entry[] {
  const remotes = useComputers((s) => s.remotes);
  const sessions = useComputers((s) => s.sessions);
  const shown = useStore((s) => s.computer);
  const shownPending = useStore((s) => Object.values(s.sessions).reduce((n, x) => n + x.pending_count, 0));
  const pendingOf = (id: string) => (id === shown ? shownPending : Object.values(sessions[id] ?? {}).reduce((n, x) => n + x.pending_count, 0));
  return [{ id: LOCAL, name: localName(), remote: null, pending: pendingOf(LOCAL) }, ...remotes.map((r) => ({ id: r.id, name: r.name, remote: r, pending: pendingOf(r.id) }))];
}

function LocalDot() {
  const connection = useStore((s) => (s.computer === LOCAL ? s.connection : s.localClient?.state ?? "closed"));
  return <span className={clsx("dot", connection === "open" ? "ok" : connection === "connecting" ? "warn pulse" : "err")} role="img" aria-label={`This computer's daemon: ${connection}`} />;
}

/** The list: ↑/↓ and Enter, Esc to close; ends with "Add remote computer…" and "Manage remote computers…". */
function Menu({ onClose }: { onClose: () => void }) {
  const entries = useEntries();
  const shown = useStore((s) => s.computer);
  const toast = useStore((s) => s.toast);
  const extra = [
    { command: "computer.add", label: "Add remote computer…" },
    { command: "computer.manage", label: "Manage remote computers…" },
  ];
  const count = entries.length + extra.length;
  const [index, setIndex] = useState(() => Math.max(0, entries.findIndex((e) => e.id === shown)));
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => listRef.current?.focus(), []);
  const pick = (i: number) => {
    onClose();
    if (i >= entries.length) return void runCommand(extra[i - entries.length].command);
    const e = entries[i];
    // A remote that needs pairing again opens where that is done.
    if (e.remote && needsPairing(e.remote.state)) return void runCommand("computer.manage");
    void switchComputer(e.id).catch((err: unknown) => toast(err instanceof Error ? err.message : String(err), "error"));
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "j") setIndex((i) => Math.min(count - 1, i + 1));
    else if (e.key === "ArrowUp" || e.key === "k") setIndex((i) => Math.max(0, i - 1));
    else if (e.key === "Home") setIndex(0);
    else if (e.key === "End") setIndex(count - 1);
    else if (e.key === "Enter") pick(index);
    else if (e.key === "Escape") onClose();
    else if (/^[1-9]$/.test(e.key) && Number(e.key) <= entries.length) pick(Number(e.key) - 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <div className="workspace-menu computer-menu" role="dialog" aria-label="Switch computer" data-keynav data-own-escape onKeyDown={onKeyDown}>
      <div className="workspace-options" role="listbox" aria-label="Computers" tabIndex={0} ref={listRef} aria-activedescendant={`computer-option-${index}`}>
        {entries.map((e, i) => (
          <div
            key={e.id}
            id={`computer-option-${i}`}
            role="option"
            aria-selected={e.id === shown}
            className={clsx("workspace-option", i === index && "active", e.id === shown && "current")}
            data-hint
            data-command="computer.switch"
            title={e.remote ? `${e.remote.host}:${e.remote.port} · ${describeState(e.remote.state)}` : "This computer's own Aura"}
            onMouseEnter={() => setIndex(i)}
            onMouseDown={(ev) => ev.preventDefault()}
            onClick={() => pick(i)}
          >
            <span className="check" aria-hidden>{e.id === shown ? "✓" : ""}</span>
            {e.remote ? <StateDot remote={e.remote} /> : <LocalDot />}
            <span className="grow name">{e.name}</span>
            {e.remote && e.remote.state.kind !== "online" && <span className={clsx("dim computer-state", needsPairing(e.remote.state) && "err-text")}>{e.remote.state.kind === "cert_mismatch" ? "certificate changed" : e.remote.state.kind === "revoked" ? "pair again" : e.remote.state.kind === "retrying" ? "unreachable" : e.remote.state.kind === "connecting" ? "connecting" : ""}</span>}
            {e.pending > 0 && <span className="badge" aria-label={`${e.pending} waiting on you`}>{e.pending}</span>}
            {i < 9 && <kbd>{i + 1}</kbd>}
          </div>
        ))}
        <div className="workspace-divider" role="separator" />
        {extra.map((x, j) => {
          const i = entries.length + j;
          return (
            <div
              key={x.command}
              id={`computer-option-${i}`}
              role="option"
              aria-selected={false}
              className={clsx("workspace-option", index === i && "active")}
              data-hint
              data-command={x.command}
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={() => pick(i)}
            >
              <span className="check" aria-hidden>{j === 0 ? "+" : ""}</span>
              <span className="grow">{x.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The top of the sidebar: which computer the window shows (this one, or a
 * paired remote), opening the list to switch; what waits on the user on the
 * other computers. Only in the desktop app.
 */
export function ComputerSwitcher() {
  const open = useComputerMenu((s) => s.open);
  const shown = useStore((s) => s.computer);
  const entries = useEntries();
  const keys = useShortcut("computer.switch");
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = () => {
    useComputerMenu.setState({ open: false });
    button.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) useComputerMenu.setState({ open: false });
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  const current = entries.find((e) => e.id === shown) ?? entries[0];
  const elsewhere = entries.filter((e) => e.id !== shown).reduce((n, e) => n + e.pending, 0);
  return (
    <div className={clsx("workspace-switcher computer-switcher", shown !== LOCAL && "remote")} ref={root}>
      <button
        ref={button}
        type="button"
        className="workspace-name computer-name"
        data-hint
        data-command="computer.switch"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Computer: ${current.name}. Switch computer`}
        title={`Computer: ${current.name}${keys ? ` (${keys})` : ""}`}
        onClick={() => useComputerMenu.setState({ open: !open })}
      >
        <span className="computer-icon" aria-hidden>⌂</span>
        {current.remote ? <StateDot remote={current.remote} /> : null}
        <span className="name">{current.name}</span>
        <span className="section-chevron" aria-hidden />
      </button>
      {elsewhere > 0 && (
        <span className="workspace-others" title={`Other computers: ${elsewhere} waiting on you`}>
          <span className="badge" aria-label={`${elsewhere} waiting on you on other computers`}>{elsewhere}</span>
        </span>
      )}
      {open && <Menu onClose={close} />}
    </div>
  );
}
