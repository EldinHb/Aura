import { useEffect, useMemo, useState } from "react";
import { ModalC } from "../ModalC";
import { useStore } from "../../state/store";
import type { Approval, ApprovalOption, UserInputRequest } from "../../gen";
import { relTime } from "../../lib/platform";
import { setFocus } from "../../commands/core";
import clsx from "clsx";

type Row = { kind: "approval"; a: Approval } | { kind: "input"; r: UserInputRequest };

function rowId(r: Row): string {
  return r.kind === "approval" ? `a:${r.a.id}` : `i:${r.r.id}`;
}
function rowSession(r: Row): string {
  return r.kind === "approval" ? r.a.session_id : r.r.session_id;
}
function rowTime(r: Row): string {
  return r.kind === "approval" ? r.a.created_at : r.r.created_at;
}

export function InboxDialog() {
  const client = useStore((s) => s.client);
  const sessions = useStore((s) => s.sessions);
  const transcripts = useStore((s) => s.transcripts);
  const select = useStore((s) => s.select);
  const closeDialog = useStore((s) => s.closeDialog);
  const toast = useStore((s) => s.toast);
  const [fetched, setFetched] = useState<{ approvals: Approval[]; inputs: UserInputRequest[] }>({ approvals: [], inputs: [] });
  const [idx, setIdx] = useState(0);
  const [resolved, setResolved] = useState<Set<string>>(new Set());

  useEffect(() => {
    client
      ?.pending()
      .then(setFetched)
      .catch(() => {});
  }, [client]);

  const rows: Row[] = useMemo(() => {
    const m = new Map<string, Row>();
    for (const a of fetched.approvals) m.set(`a:${a.id}`, { kind: "approval", a });
    for (const r of fetched.inputs) m.set(`i:${r.id}`, { kind: "input", r });
    for (const t of Object.values(transcripts)) {
      for (const a of Object.values(t.approvals)) m.set(`a:${a.id}`, { kind: "approval", a });
      for (const r of Object.values(t.inputs)) m.set(`i:${r.id}`, { kind: "input", r });
    }
    // drop entries the live store says are gone
    const live = new Set<string>();
    for (const t of Object.values(transcripts)) {
      for (const a of Object.values(t.approvals)) live.add(`a:${a.id}`);
      for (const r of Object.values(t.inputs)) live.add(`i:${r.id}`);
    }
    return [...m.values()]
      .filter((r) => {
        const id = rowId(r);
        if (resolved.has(id)) return false;
        const sid = rowSession(r);
        // if we have a loaded transcript for the session, trust it as the source of truth
        if (transcripts[sid]?.loaded && !live.has(id)) return false;
        return true;
      })
      .sort((x, y) => rowTime(x).localeCompare(rowTime(y)));
  }, [fetched, transcripts, resolved]);

  useEffect(() => {
    if (idx >= rows.length) setIdx(Math.max(0, rows.length - 1));
  }, [rows.length, idx]);

  const respond = async (row: Row, option: ApprovalOption) => {
    if (!client || row.kind !== "approval") return;
    try {
      await client.respondApproval(row.a.session_id, row.a.id, { option, updated_input: null, message: null });
      setResolved((s) => new Set(s).add(rowId(row)));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const acceptAllInSession = async (row: Row) => {
    if (!client) return;
    const sid = rowSession(row);
    const list = rows.filter((r): r is Extract<Row, { kind: "approval" }> => r.kind === "approval" && r.a.session_id === sid && r.a.kind === "command");
    for (const r of list) await respond(r, "accept");
    toast(`Accepted ${list.length} command approval${list.length === 1 ? "" : "s"} in “${sessions[sid]?.title ?? sid}”`);
  };

  const jump = (row: Row) => {
    select(rowSession(row));
    closeDialog();
    setFocus("main");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const row = rows[idx];
    const k = e.key;
    if (k === "j" || k === "ArrowDown") setIdx((i) => Math.min(rows.length - 1, i + 1));
    else if (k === "k" || k === "ArrowUp") setIdx((i) => Math.max(0, i - 1));
    else if (k === "Enter" && row) jump(row);
    else if (k === "y" && row) void respond(row, "accept");
    else if (k === "Y" && row) void respond(row, "accept_for_session");
    else if (k === "n" && row) void respond(row, "decline");
    else if (k === "a" && row) void acceptAllInSession(row);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <ModalC
      title={
        <>
          <span>Inbox</span>
          <span style={{ flex: 1 }} />
          <span className="dim" style={{ fontWeight: 400, color: "var(--fg-dim)", fontSize: 11 }}>
            <kbd>y</kbd> accept <kbd>Y</kbd> for session <kbd>n</kbd> decline <kbd>a</kbd> accept all cmds <kbd>↩</kbd> go to session
          </span>
        </>
      }
      onKeyDown={onKeyDown}
    >
      <div className="list" data-autofocus tabIndex={0}>
        {rows.length === 0 && (
          <div className="empty" style={{ height: "auto", padding: 30 }}>
            <span style={{ fontSize: 28, color: "var(--ok)" }}>✓</span>
            <h2>Nothing is waiting for you</h2>
          </div>
        )}
        {rows.map((row, i) => {
          const s = sessions[rowSession(row)];
          const isApproval = row.kind === "approval";
          const payload = isApproval ? (row.a.payload as { command?: string }) : null;
          return (
            <button key={rowId(row)} type="button" data-hint className={clsx("list-item inbox-row", i === idx && "active")} onClick={() => setIdx(i)} onDoubleClick={() => jump(row)}>
              <span className={clsx("chip", s?.provider ?? "")}>{s?.provider ?? "?"}</span>
              <span className="inbox-kind chip">{isApproval ? row.a.kind.replace("_", " ") : "question"}</span>
              <span className="grow">
                <div className="inbox-title">{isApproval ? row.a.title : row.r.questions.map((q) => q.question).join(" · ")}</div>
                <div className="dim mono inbox-sub">{isApproval ? payload?.command ?? row.a.description ?? "" : `${row.r.questions.length} question${row.r.questions.length === 1 ? "" : "s"}`}</div>
                <div className="dim inbox-sub">{s?.title ?? rowSession(row)}</div>
              </span>
              <span className="dim">{relTime(rowTime(row))}</span>
            </button>
          );
        })}
      </div>
    </ModalC>
  );
}
