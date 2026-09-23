import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { Item, Turn } from "../gen";
import { useStore } from "../state/store";
import { sessionProviderLabel } from "../lib/acp";
import { setFocus } from "../commands/core";
import { registerTranscriptCommands, setTranscriptHandle } from "../commands/transcript";
import { ItemRow } from "./transcript/ItemRow";
import { ApprovalCard } from "./transcript/ApprovalCard";
import { UserInputCard } from "./transcript/UserInputCard";
import { durationMs, fmtDuration, fmtTokens, fmtUsd, isCardKind } from "./transcript/format";

let commandsRegistered: (() => void) | null = null;
let mounted = 0;

type Row =
  | { kind: "turn"; turn: Turn; key: string }
  | { kind: "item"; item: Item; key: string; nested: boolean }
  | { kind: "approval"; id: string; key: string }
  | { kind: "input"; id: string; key: string }
  | { kind: "notice"; key: string; level: string; message: string };

function TurnDivider({ turn }: { turn: Turn }) {
  const running = turn.status === "running";
  const dur = fmtDuration(durationMs(turn.started_at, turn.ended_at));
  return (
    <div className={clsx("turn-divider", turn.status)}>
      <span className={clsx("dot", running ? "info pulse" : turn.status === "completed" ? "ok" : turn.status === "failed" ? "err" : "warn")} />
      <span>{running ? "working…" : turn.status}</span>
      {dur && <span className="dim">{dur}</span>}
      {turn.usage && (
        <span className="dim">
          {fmtTokens(turn.usage.input_tokens)}↑ {fmtTokens(turn.usage.output_tokens)}↓ {fmtUsd(turn.usage.total_cost_usd)}
        </span>
      )}
      {turn.error && <span className="err-text">{turn.error}</span>}
    </div>
  );
}

export function Transcript({ sessionId }: { sessionId: string }) {
  const t = useStore((s) => s.transcripts[sessionId]);
  const session = useStore((s) => s.sessions[sessionId]);
  const providers = useStore((s) => s.providers);
  const cursorItemId = useStore((s) => s.cursorItemId);
  const setCursorItem = useStore((s) => s.setCursorItem);
  const showReasoning = useStore((s) => s.settings.showReasoning);
  const toast = useStore((s) => s.toast);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [atBottom, setAtBottom] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    mounted++;
    if (!commandsRegistered) commandsRegistered = registerTranscriptCommands();
    return () => {
      mounted--;
      if (mounted === 0 && commandsRegistered) {
        commandsRegistered();
        commandsRegistered = null;
      }
    };
  }, []);

  const rows = useMemo<Row[]>(() => {
    if (!t) return [];
    const out: Row[] = [];
    const items = t.order.map((id) => t.items[id]).filter((x): x is Item => !!x);
    const byParent = new Map<string, Item[]>();
    const top: Item[] = [];
    for (const it of items) {
      if (it.parent_id && t.items[it.parent_id]) {
        // flatten deeper nesting to the first subagent ancestor
        let p = it.parent_id;
        let guard = 0;
        while (t.items[p]?.parent_id && t.items[t.items[p].parent_id!] && guard++ < 8) p = t.items[p].parent_id!;
        if (!byParent.has(p)) byParent.set(p, []);
        byParent.get(p)!.push(it);
      } else top.push(it);
    }
    const turnsById = new Map(t.turns.map((x) => [x.id, x]));
    let lastTurn: string | null | undefined;
    const approvalsByItem = new Map<string, string[]>();
    const inputsByItem = new Map<string, string[]>();
    const pendingApprovals = Object.values(t.approvals).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const pendingInputs = Object.values(t.inputs).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const looseApprovals: string[] = [];
    const looseInputs: string[] = [];
    for (const a of pendingApprovals) {
      if (a.item_id && t.items[a.item_id]) (approvalsByItem.get(a.item_id) ?? approvalsByItem.set(a.item_id, []).get(a.item_id)!).push(a.id);
      else looseApprovals.push(a.id);
    }
    for (const r of pendingInputs) {
      if (r.item_id && t.items[r.item_id]) (inputsByItem.get(r.item_id) ?? inputsByItem.set(r.item_id, []).get(r.item_id)!).push(r.id);
      else looseInputs.push(r.id);
    }
    const pushItem = (it: Item, nested: boolean) => {
      if (it.kind === "reasoning" && !showReasoning) return;
      out.push({ kind: "item", item: it, key: it.id, nested });
      for (const id of approvalsByItem.get(it.id) ?? []) out.push({ kind: "approval", id, key: `approval:${id}` });
      for (const id of inputsByItem.get(it.id) ?? []) out.push({ kind: "input", id, key: `input:${id}` });
    };
    for (const it of top) {
      if (it.turn_id !== lastTurn) {
        lastTurn = it.turn_id;
        const turn = it.turn_id ? turnsById.get(it.turn_id) : undefined;
        if (turn && turn.status !== "running") out.push({ kind: "turn", turn, key: `turn:${turn.id}` });
      }
      pushItem(it, false);
      for (const child of byParent.get(it.id) ?? []) pushItem(child, true);
    }
    for (const id of looseApprovals) out.push({ kind: "approval", id, key: `approval:${id}` });
    for (const id of looseInputs) out.push({ kind: "input", id, key: `input:${id}` });
    const running = t.turns.find((x) => x.status === "running");
    if (running) out.push({ kind: "turn", turn: running, key: `turn:${running.id}` });
    for (const n of t.notices.slice(-5)) out.push({ kind: "notice", key: `notice:${n.id}`, level: n.level, message: n.message });
    return out;
  }, [t, showReasoning]);

  const navigable = useMemo(() => rows.filter((r) => r.kind === "item" || r.kind === "approval" || r.kind === "input").map((r) => r.key), [rows]);

  const toggle = useCallback(
    (id: string) => {
      const it = t?.items[id];
      const def = it ? (it.kind === "reasoning" ? false : isCardKind(it.kind) ? it.status !== "completed" : false) : false;
      setExpanded((e) => ({ ...e, [id]: !(e[id] ?? def) }));
    },
    [t],
  );

  const scrollToBottom = useCallback(() => {
    const el = rootRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    stickRef.current = true;
    setAtBottom(true);
  }, []);

  useEffect(() => {
    setTranscriptHandle({
      visibleIds: () => navigable,
      toggle,
      expand: (id) => setExpanded((e) => ({ ...e, [id]: true })),
      scrollBy: (frac) => {
        const el = rootRef.current;
        if (el) el.scrollBy({ top: el.clientHeight * frac, behavior: "smooth" });
      },
      scrollToBottom,
      copyCursor: async () => {
        const id = useStore.getState().cursorItemId;
        const it = id ? t?.items[id] : null;
        if (!it) return;
        const text = it.kind === "command_exec" ? `$ ${it.data.command ?? ""}\n${it.data.output ?? ""}` : it.text || JSON.stringify(it.data, null, 2);
        await navigator.clipboard.writeText(text);
        toast("Copied");
      },
    });
    return () => setTranscriptHandle(null);
  }, [navigable, toggle, scrollToBottom, t, toast]);

  // sticky bottom
  const count = rows.length;
  const lastText = t ? t.items[t.order[t.order.length - 1] ?? ""]?.text.length : 0;
  useLayoutEffect(() => {
    if (stickRef.current && rootRef.current) rootRef.current.scrollTop = rootRef.current.scrollHeight;
  }, [count, lastText, t?.turnDiff]);

  const onScroll = () => {
    const el = rootRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stickRef.current = near;
    setAtBottom(near);
  };

  // scroll cursor into view
  useEffect(() => {
    if (!cursorItemId) return;
    const sel = cursorItemId.startsWith("approval:") ? `[data-approval-id="${cursorItemId.slice(9)}"]` : cursorItemId.startsWith("input:") ? `[data-input-id="${cursorItemId.slice(6)}"]` : `[data-item-id="${cursorItemId}"]`;
    const el = rootRef.current?.querySelector<HTMLElement>(sel);
    if (el) {
      el.scrollIntoView({ block: "nearest" });
      if (cursorItemId.startsWith("input:")) el.focus();
    }
  }, [cursorItemId]);

  const onCursor = useCallback((id: string) => setCursorItem(id), [setCursorItem]);

  return (
    <div className="transcript-wrap">
      <div className="transcript" ref={rootRef} data-autofocus tabIndex={0} onFocus={() => setFocus("main")} onScroll={onScroll}>
        {t?.loading && <div className="dim transcript-loading">Loading history…</div>}
        {!t?.loading && rows.length === 0 && session && (
          <div className="empty">
            <h2>{sessionProviderLabel(session, providers)}</h2>
            <span className="mono">{session.cwd}</span>
            {session.status === "error" && session.last_error && <code className="err-text">{session.last_error}</code>}
            <div className="hint">
              <span><kbd>i</kbd> type a message</span>
              {session.provider !== "acp" && <span><kbd>⌘T</kbd> terminal mode</span>}
              <span><kbd>⌘K</kbd> commands</span>
            </div>
          </div>
        )}
        {rows.map((r) => {
          switch (r.kind) {
            case "turn":
              return <TurnDivider key={r.key} turn={r.turn} />;
            case "item":
              return (
                <ItemRow
                  key={r.key}
                  item={r.item}
                  nested={r.nested}
                  cursor={cursorItemId === r.item.id}
                  expanded={expanded[r.item.id]}
                  onToggle={toggle}
                  onCursor={onCursor}
                  showReasoning={showReasoning}
                />
              );
            case "approval": {
              const a = t!.approvals[r.id];
              return a ? <ApprovalCard key={r.key} approval={a} sessionId={sessionId} cursor={cursorItemId === r.key} /> : null;
            }
            case "input": {
              const q = t!.inputs[r.id];
              return q ? <UserInputCard key={r.key} request={q} sessionId={sessionId} cursor={cursorItemId === r.key} /> : null;
            }
            case "notice":
              return (
                <div key={r.key} className={clsx("notice", r.level)}>
                  <span className={clsx("dot", r.level === "error" ? "err" : r.level === "warn" ? "warn" : "info")} /> {r.message}
                </div>
              );
          }
        })}
      </div>
      {!atBottom && (
        <button className="btn small scroll-pill" data-command="transcript.scroll-bottom" onClick={scrollToBottom}>
          ↓ new output
        </button>
      )}
    </div>
  );
}
