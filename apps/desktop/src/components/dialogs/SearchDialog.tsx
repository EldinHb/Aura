import { useEffect, useMemo, useRef, useState } from "react";
import { ModalC } from "../ModalC";
import { useStore } from "../../state/store";
import type { SearchHit } from "../../gen";
import { relTime } from "../../lib/platform";
import { folderOf } from "../../lib/sessionFolder";
import { setFocus } from "../../commands/core";
import clsx from "clsx";

type Row = { kind: "hit"; hit: SearchHit } | { kind: "session"; id: string };

export function highlightParts(text: string, query: string): { text: string; mark: boolean }[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}_-]/gu, ""))
    .filter((w) => w.length > 0);
  if (words.length === 0) return [{ text, mark: false }];
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  const out: { text: string; mark: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ text: text.slice(last, i), mark: false });
    out.push({ text: m[0], mark: true });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), mark: false });
  return out;
}

export function SearchDialog() {
  const client = useStore((s) => s.client);
  const sessions = useStore((s) => s.sessions);
  const select = useStore((s) => s.select);
  const setCursorItem = useStore((s) => s.setCursorItem);
  const closeDialog = useStore((s) => s.closeDialog);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [idx, setIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = query.trim();
    if (!q || !client) {
      setHits([]);
      return;
    }
    timer.current = setTimeout(() => {
      setBusy(true);
      client
        .search(q, 50)
        .then((h) => {
          setHits(h);
          setIdx(0);
        })
        .catch(() => setHits([]))
        .finally(() => setBusy(false));
    }, 150);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, client]);

  const sessionMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return Object.values(sessions)
      .filter((s) => s.title.toLowerCase().includes(q) || (folderOf(s) ?? "").toLowerCase().includes(q) || (s.group ?? "").toLowerCase().includes(q))
      .slice(0, 8);
  }, [query, sessions]);

  const groups = useMemo(() => {
    const m = new Map<string, SearchHit[]>();
    for (const h of hits) {
      if (!m.has(h.session_id)) m.set(h.session_id, []);
      m.get(h.session_id)!.push(h);
    }
    return [...m.entries()];
  }, [hits]);

  const rows: Row[] = useMemo(() => {
    const r: Row[] = sessionMatches.map((s) => ({ kind: "session", id: s.id }));
    for (const [, list] of groups) for (const h of list) r.push({ kind: "hit", hit: h });
    return r;
  }, [sessionMatches, groups]);

  useEffect(() => {
    document.querySelector<HTMLElement>(`[data-search-row="${idx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const activate = (row: Row | undefined) => {
    if (!row) return;
    const sid = row.kind === "session" ? row.id : row.hit.session_id;
    if (!sessions[sid]) return;
    select(sid);
    closeDialog();
    if (row.kind === "hit" && row.hit.item_id) setCursorItem(row.hit.item_id);
    setFocus("main");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const inInput = (e.target as HTMLElement).tagName === "INPUT";
    if (e.key === "ArrowDown" || (!inInput && e.key === "j") || (e.key === "n" && e.ctrlKey)) setIdx((i) => Math.min(rows.length - 1, i + 1));
    else if (e.key === "ArrowUp" || (!inInput && e.key === "k") || (e.key === "p" && e.ctrlKey)) setIdx((i) => Math.max(0, i - 1));
    else if (e.key === "Enter") activate(rows[idx]);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  let rowIndex = 0;
  return (
    <ModalC
      title={
        <>
          <span>Search</span>
          <span style={{ flex: 1 }} />
          <span className="dim" style={{ fontWeight: 400, color: "var(--fg-dim)", fontSize: 11 }}>
            {busy ? "searching…" : query.trim() ? `${hits.length} message${hits.length === 1 ? "" : "s"}${sessionMatches.length ? `, ${sessionMatches.length} session${sessionMatches.length === 1 ? "" : "s"}` : ""}` : ""}
          </span>
        </>
      }
      onKeyDown={onKeyDown}
      className="search-modal"
    >
      <input type="text" data-autofocus autoFocus placeholder="Search messages and sessions…" value={query} onChange={(e) => setQuery(e.target.value)} className="search-input" />
      <div className="list search-results">
        {sessionMatches.length > 0 && <div className="section-title">Sessions</div>}
        {sessionMatches.map((s) => {
          const i = rowIndex++;
          return (
            <button key={s.id} type="button" data-hint data-search-row={i} className={clsx("list-item", i === idx && "active")} onClick={() => activate({ kind: "session", id: s.id })}>
              <span className={clsx("chip", s.provider)}>{s.provider}</span>
              <span className="grow">{s.title}</span>
              <span className="dim">{folderOf(s) ?? "orchestrator"}</span>
            </button>
          );
        })}
        {groups.map(([sid, list]) => {
          const s = sessions[sid];
          return (
            <div key={sid}>
              <div className="section-title group-title">
                {s ? <span className={clsx("chip", s.provider)}>{s.provider}</span> : null}
                {s?.title ?? "unknown session"}
              </div>
              {list.map((h) => {
                const i = rowIndex++;
                return (
                  <button key={`${h.session_id}:${h.item_id ?? i}`} type="button" data-hint data-search-row={i} className={clsx("list-item search-hit", i === idx && "active")} onClick={() => activate({ kind: "hit", hit: h })}>
                    <span className="grow snippet">
                      {highlightParts(h.snippet, query).map((p, k) => (p.mark ? <mark key={k}>{p.text}</mark> : <span key={k}>{p.text}</span>))}
                    </span>
                    <span className="dim">{relTime(h.ts)}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
        {query.trim() && !busy && rows.length === 0 && <div className="empty" style={{ height: "auto", padding: 20 }}>No matches</div>}
      </div>
      <div className="dim search-hints">
        <kbd>↑↓</kbd> / <kbd>j k</kbd> move <kbd>↩</kbd> open <kbd>Esc</kbd> close
      </div>
    </ModalC>
  );
}
