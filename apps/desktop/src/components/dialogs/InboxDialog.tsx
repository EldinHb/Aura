import { useEffect, useMemo, useState } from "react";
import { ModalC } from "../ModalC";
import { useStore } from "../../state/store";
import type { Approval, ApprovalOption, UserInputRequest } from "../../gen";
import { relTime } from "../../lib/platform";
import { setFocus } from "../../commands/core";
import { useModInbox } from "../../mods/inbox";
import { slots, useSlot, type InboxItem } from "../../mods/registry";
import { ModPiece } from "../../mods/Slots";
import clsx from "clsx";
import type { Session } from "../../gen";
import { clientOf, computerName, pendingElsewhere, switchComputer, useComputers, useOtherComputersPending } from "../../state/computers";

/** `computer`: the computer the row waits on (state/computers.ts): answered there, whatever is shown by then. */
type SessionRow = ({ kind: "approval"; a: Approval } | { kind: "input"; r: UserInputRequest }) & { computer: string };
/** What a mod put in the inbox (`aura.inbox.set`). */
type Row = SessionRow | { kind: "mod"; modId: string; item: InboxItem };

function rowId(r: Row): string {
  return r.kind === "approval" ? `a:${r.a.id}` : r.kind === "input" ? `i:${r.r.id}` : `m:${r.modId}:${r.item.id}`;
}
/** Ids are unique per computer only. */
function rowKey(r: Row): string {
  return r.kind !== "mod" ? `${r.computer}:${rowId(r)}` : rowId(r);
}
function rowSession(r: SessionRow): string {
  return r.kind === "approval" ? r.a.session_id : r.r.session_id;
}
function rowTime(r: SessionRow): string {
  return r.kind === "approval" ? r.a.created_at : r.r.created_at;
}

export function InboxDialog() {
  const client = useStore((s) => s.client);
  const sessions = useStore((s) => s.sessions);
  // Each row says which workspace its session is in, once there is more than one.
  const workspaces = useStore((s) => s.workspaces);
  const workspaceNames = useMemo(() => new Map(workspaces.map((w) => [w.id, w.name])), [workspaces]);
  const transcripts = useStore((s) => s.transcripts);
  const select = useStore((s) => s.select);
  const closeDialog = useStore((s) => s.closeDialog);
  const toast = useStore((s) => s.toast);
  const modItems = useModInbox((s) => s.items);
  const renderers = useSlot(slots.inboxRenderer);
  // Stamped with the computer it came from: one fetched before a switch is not the shown computer's.
  const [fetched, setFetched] = useState<{ computer: string | null; approvals: Approval[]; inputs: UserInputRequest[] }>({ computer: null, approvals: [], inputs: [] });
  const [idx, setIdx] = useState(0);
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  // What waits on the other connected computers, labelled with their names.
  const shown = useStore((s) => s.computer);
  const remotes = useComputers((s) => s.remotes);
  const elsewhereCount = useOtherComputersPending();
  const [elsewhere, setElsewhere] = useState<Awaited<ReturnType<typeof pendingElsewhere>>>([]);
  const otherSessions = useMemo(() => new Map(elsewhere.map((e) => [e.computer, e.sessions] as [string, Record<string, Session>])), [elsewhere]);

  useEffect(() => {
    let live = true;
    const from = useStore.getState().computer;
    client
      ?.pending()
      .then((p) => {
        // Dropped if the dialog moved on to another client or computer meanwhile.
        if (live && useStore.getState().client === client && useStore.getState().computer === from) setFetched({ computer: from, ...p });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [client]);

  useEffect(() => {
    let live = true;
    void pendingElsewhere(shown).then((list) => live && setElsewhere(list));
    return () => {
      live = false;
    };
  }, [shown, elsewhereCount]);

  const rows: Row[] = useMemo(() => {
    const m = new Map<string, SessionRow>();
    if (fetched.computer === shown) {
      for (const a of fetched.approvals) m.set(`a:${a.id}`, { kind: "approval", a, computer: shown });
      for (const r of fetched.inputs) m.set(`i:${r.id}`, { kind: "input", r, computer: shown });
    }
    // The transcripts are the shown computer's (they are emptied on switching).
    for (const t of Object.values(transcripts)) {
      for (const a of Object.values(t.approvals)) m.set(`a:${a.id}`, { kind: "approval", a, computer: shown });
      for (const r of Object.values(t.inputs)) m.set(`i:${r.id}`, { kind: "input", r, computer: shown });
    }
    // drop entries the live store says are gone
    const live = new Set<string>();
    for (const t of Object.values(transcripts)) {
      for (const a of Object.values(t.approvals)) live.add(`a:${a.id}`);
      for (const r of Object.values(t.inputs)) live.add(`i:${r.id}`);
    }
    const waiting: Row[] = [...m.values()]
      .filter((r) => {
        const id = rowId(r);
        if (resolved.has(rowKey(r))) return false;
        const sid = rowSession(r);
        // if we have a loaded transcript for the session, trust it as the source of truth
        if (transcripts[sid]?.loaded && !live.has(id)) return false;
        return true;
      })
      .sort((x, y) => rowTime(x).localeCompare(rowTime(y)));
    // What waits on you first, then what mods report (unread), the latest first.
    const fromMods: Row[] = modItems
      .flatMap(({ modId, items }) => items.filter((i) => i.unread).map((item): Row => ({ kind: "mod", modId, item })))
      .sort((x, y) => (x.kind === "mod" && y.kind === "mod" ? y.item.at.localeCompare(x.item.at) : 0));
    const others: Row[] = elsewhere
      .flatMap((e): SessionRow[] => [
        ...e.approvals.map((a): SessionRow => ({ kind: "approval", a, computer: e.computer })),
        ...e.inputs.map((r): SessionRow => ({ kind: "input", r, computer: e.computer })),
      ])
      .filter((e) => e.computer !== shown)
      .filter((r) => !resolved.has(rowKey(r)))
      .sort((x, y) => rowTime(x as SessionRow).localeCompare(rowTime(y as SessionRow)));
    return [...waiting, ...others, ...fromMods];
  }, [fetched, transcripts, resolved, modItems, elsewhere, shown]);
  // Rows say which computer they are on once more than one has any.
  const labelled = elsewhere.some((e) => e.approvals.length + e.inputs.length > 0);
  const sessionOf = (row: SessionRow): Session | undefined => (row.computer !== shown ? otherSessions.get(row.computer)?.[rowSession(row)] : sessions[rowSession(row)]);

  useEffect(() => {
    if (idx >= rows.length) setIdx(Math.max(0, rows.length - 1));
  }, [rows.length, idx]);

  const respond = async (row: Row, option: ApprovalOption) => {
    if (row.kind === "mod") return;
    // On the computer the row is from.
    const on = clientOf(row.computer);
    if (!on) {
      toast(`${computerName(row.computer, remotes)} is not connected`, "error");
      return;
    }
    // A question is answered on its card; from here it can only be dismissed.
    if (row.kind === "input" && option !== "decline") return;
    try {
      if (row.kind === "input") await on.respondInput(row.r.session_id, { request_id: row.r.id, answers: {}, declined: true });
      else await on.respondApproval(row.a.session_id, row.a.id, { option, updated_input: null, message: null });
      setResolved((s) => new Set(s).add(rowKey(row)));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const acceptAllInSession = async (row: Row) => {
    if (!client || row.kind === "mod") return;
    const sid = rowSession(row);
    const list = rows.filter((r): r is Extract<Row, { kind: "approval" }> => r.kind === "approval" && r.computer === row.computer && r.a.session_id === sid && r.a.kind === "command");
    for (const r of list) await respond(r, "accept");
    toast(`Accepted ${list.length} command approval${list.length === 1 ? "" : "s"} in “${sessionOf(row)?.title ?? sid}”`);
  };

  const jump = (row: Row) => {
    closeDialog();
    if (row.kind === "mod") renderers.find((r) => r.modId === row.modId)?.open?.(row.item);
    else if (row.computer !== useStore.getState().computer) {
      // On another computer: show it, then the session.
      const sid = rowSession(row);
      void switchComputer(row.computer).then(
        () => useStore.getState().select(sid),
        (e: unknown) => toast(e instanceof Error ? e.message : String(e), "error"),
      );
    } else select(rowSession(row));
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
            <kbd>y</kbd> accept <kbd>Y</kbd> for session <kbd>n</kbd> decline / dismiss question <kbd>a</kbd> accept all cmds <kbd>↩</kbd> open
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
          if (row.kind === "mod") {
            const renderer = renderers.find((r) => r.modId === row.modId);
            return (
              <button key={rowId(row)} type="button" data-hint className={clsx("list-item inbox-row", i === idx && "active")} onClick={() => jump(row)}>
                {renderer ? (
                  <ModPiece entry={renderer}>
                    <renderer.component item={row.item} />
                  </ModPiece>
                ) : (
                  <>
                    <span className="chip">{row.modId}</span>
                    <span className="grow">
                      <div className="inbox-title">{row.item.title}</div>
                      {row.item.detail && <div className="dim inbox-sub">{row.item.detail}</div>}
                    </span>
                  </>
                )}
                <span className="dim">{relTime(row.item.at)}</span>
              </button>
            );
          }
          const s = sessionOf(row);
          const isApproval = row.kind === "approval";
          const payload = isApproval ? (row.a.payload as { command?: string }) : null;
          return (
            <button key={rowKey(row)} type="button" data-hint className={clsx("list-item inbox-row", i === idx && "active")} onClick={() => setIdx(i)} onDoubleClick={() => jump(row)}>
              {labelled && <span className="chip inbox-computer" title="The computer it waits on">{computerName(row.computer, remotes)}</span>}
              <span className={clsx("chip", s?.provider ?? "")}>{s?.provider ?? "?"}</span>
              <span className="inbox-kind chip">{isApproval ? row.a.kind.replace("_", " ") : "question"}</span>
              <span className="grow">
                <div className="inbox-title">{isApproval ? row.a.title : row.r.questions.map((q) => q.question).join(" · ")}</div>
                <div className="dim mono inbox-sub">{isApproval ? payload?.command ?? row.a.description ?? "" : `${row.r.questions.length} question${row.r.questions.length === 1 ? "" : "s"}`}</div>
                <div className="dim inbox-sub">{s?.title ?? rowSession(row)}{s && row.computer === shown && workspaceNames.size > 1 && workspaceNames.has(s.workspace) ? ` · ${workspaceNames.get(s.workspace)}` : ""}</div>
              </span>
              <span className="dim">{relTime(rowTime(row))}</span>
            </button>
          );
        })}
      </div>
    </ModalC>
  );
}
