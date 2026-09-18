import { useShallow } from "zustand/react/shallow";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, selectVisibleSessions } from "../state/store";
import { allCommands, listCommands, onCommandsChanged, runCommand, type Command } from "../lib/commands";
import { currentCommandContext } from "../hooks/useCommandContext";
import { getKeymap } from "../hooks/useKeyboard";
import { formatKeys } from "../lib/keymap";
import { isMac, basename, relTime } from "../lib/platform";
import { buildSections, flattenSections, filterItems, loadRecent, pushRecent } from "./palette";
import { useListNav, KeyList, type KeyListItem } from "./Modal";
import { setFocus } from "../commands/core";
import { HELP_TOPICS } from "./HelpOverlay";
import clsx from "clsx";

type Mode = "commands" | "sessions" | "help";

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const initialQuery = useStore((s) => s.paletteQuery);
  const setPalette = useStore((s) => s.setPalette);
  const sessions = useStore(useShallow(selectVisibleSessions));
  const [query, setQuery] = useState(initialQuery);
  const [tick, setTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => onCommandsChanged(() => setTick((t) => t + 1)), []);
  useEffect(() => {
    if (open) {
      setQuery(initialQuery);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, initialQuery]);

  const mode: Mode = query.startsWith("@") ? "sessions" : query.startsWith("?") ? "help" : "commands";
  const body = mode === "commands" ? query : query.slice(1);

  const commandRows = useMemo(() => {
    void tick;
    if (mode !== "commands") return [];
    const cmds = listCommands(currentCommandContext());
    return flattenSections(buildSections(cmds, body, loadRecent()));
  }, [mode, body, tick]);

  const sessionRows = useMemo(() => (mode === "sessions" ? filterItems(sessions, body, (s) => `${s.title} ${s.cwd} ${s.group ?? ""} ${s.provider}`) : []), [mode, body, sessions]);
  const helpRows = useMemo(() => (mode === "help" ? filterItems(HELP_TOPICS, body, (t) => `${t.title} ${t.body}`) : []), [mode, body]);

  const count = mode === "commands" ? commandRows.length : mode === "sessions" ? sessionRows.length : helpRows.length;
  const keymap = getKeymap();
  const byId = useMemo(() => {
    void tick;
    return new Map(allCommands().map((c) => [c.id, c]));
  }, [tick]);

  const activate = (i: number) => {
    if (mode === "commands") {
      const row = commandRows[i];
      if (!row) return;
      pushRecent(row.item.id);
      setPalette(false);
      void runCommand(row.item.id);
    } else if (mode === "sessions") {
      const s = sessionRows[i];
      if (!s) return;
      setPalette(false);
      useStore.getState().select(s.id);
      setFocus("main");
    } else {
      const t = helpRows[i];
      if (!t) return;
      setPalette(false);
      useStore.getState().openDialog({ kind: "help" });
    }
  };
  const nav = useListNav(count, activate);
  useEffect(() => nav.setIndex(0), [query]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  let items: KeyListItem[] = [];
  if (mode === "commands") {
    items = commandRows.map((r) => {
      const c: Command | undefined = byId.get(r.item.id);
      const keys = keymap?.bindingsFor(r.item.id) ?? [];
      return {
        id: r.item.id,
        header: r.first ? r.section : undefined,
        command: r.item.id,
        render: (
          <>
            <span className="grow">{c?.title ?? r.item.title}</span>
            <span className="dim">{r.item.group}</span>
            <span className="keys">
              {keys.slice(0, 2).map((k) => (
                <kbd key={k}>{formatKeys(k, isMac)}</kbd>
              ))}
            </span>
          </>
        ),
      };
    });
  } else if (mode === "sessions") {
    items = sessionRows.map((s) => ({
      id: s.id,
      command: "session.select",
      render: (
        <>
          <span className={clsx("dot", s.status === "running" ? "info" : s.pending_count ? "warn" : s.status === "error" ? "err" : "ok")} />
          <span className="grow">{s.title}</span>
          <span className={clsx("chip", s.provider)}>{s.provider}</span>
          <span className="dim">{basename(s.cwd)}</span>
          <span className="dim">{relTime(s.last_activity)}</span>
        </>
      ),
    }));
  } else {
    items = helpRows.map((t) => ({ id: t.id, command: "help.open", render: <span className="grow">{t.title}</span> }));
  }

  return (
    <div className="overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && setPalette(false)}>
      <div className="modal palette" role="dialog" aria-label="Command palette" onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setPalette(false);
          return;
        }
        nav.onKeyDown(e);
      }}>
        <div className="palette-input">
          <span className="palette-mode">{mode === "commands" ? ">" : mode === "sessions" ? "@" : "?"}</span>
          <input ref={inputRef} data-autofocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Type a command…  @ sessions  ? help" spellCheck={false} />
        </div>
        <div className="modal-body palette-body">
          <KeyList items={items} index={nav.index} onSelect={nav.setIndex} onActivate={activate} empty={mode === "commands" ? "No matching commands" : mode === "sessions" ? "No matching sessions" : "No help topics"} />
        </div>
        <div className="palette-foot">
          <span><kbd>↑↓</kbd> move</span>
          <span><kbd>↩</kbd> run</span>
          <span><kbd>⌥1–9</kbd> pick</span>
          <span><kbd>Esc</kbd> close</span>
          <span className="spacer" />
          <span>{count} {mode}</span>
        </div>
      </div>
    </div>
  );
}
