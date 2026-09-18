import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { Approval, ApprovalOption } from "../../gen";
import { useStore } from "../../state/store";
import { DiffText } from "./Diff";
import { prettyJson } from "./format";

type Change = { path?: string; kind?: string; diff?: string };

const LABEL: Record<ApprovalOption, { text: string; key: string; cls?: string }> = {
  accept: { text: "Accept", key: "y", cls: "primary" },
  accept_for_session: { text: "Accept for session", key: "Y" },
  edit_input: { text: "Edit", key: "e" },
  decline: { text: "Decline", key: "n", cls: "danger" },
  cancel: { text: "Cancel", key: "Esc" },
};

const ORDER: ApprovalOption[] = ["accept", "accept_for_session", "edit_input", "decline", "cancel"];

/** Module-level channel so a global command can open the editor of a card. */
const editRequests = new Set<(approvalId: string) => void>();
export function requestEditApproval(approvalId: string) {
  for (const l of editRequests) l(approvalId);
}

export function ApprovalCard({ approval, sessionId, cursor }: { approval: Approval; sessionId: string; cursor: boolean }) {
  const client = useStore((s) => s.client);
  const toast = useStore((s) => s.toast);
  const [mode, setMode] = useState<"idle" | "edit" | "decline">("idle");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const p = approval.payload as Record<string, unknown>;
  const isCommand = approval.kind === "command";

  const respond = async (option: ApprovalOption, updated_input: Record<string, unknown> | null = null, message: string | null = null) => {
    if (!client || busy) return;
    setBusy(true);
    try {
      await client.respondApproval(sessionId, approval.id, { option, updated_input, message });
    } catch (e) {
      toast(`approval: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const openEdit = () => {
    const initial = isCommand ? String(p.command ?? "") : prettyJson(p.input ?? p);
    setDraft(initial);
    setMode("edit");
  };

  useEffect(() => {
    const l = (id: string) => {
      if (id === approval.id) openEdit();
    };
    editRequests.add(l);
    return () => {
      editRequests.delete(l);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approval.id]);

  useEffect(() => {
    if (mode !== "idle") taRef.current?.focus();
  }, [mode]);

  const submitEdit = () => {
    let updated: Record<string, unknown>;
    if (isCommand) {
      const base = (p.input as Record<string, unknown> | undefined) ?? {};
      updated = { ...base, command: draft };
    } else {
      try {
        updated = JSON.parse(draft) as Record<string, unknown>;
      } catch (e) {
        toast(`invalid JSON: ${e instanceof Error ? e.message : e}`, "error");
        return;
      }
    }
    setMode("idle");
    void respond("edit_input", updated);
  };

  const options = ORDER.filter((o) => approval.options.includes(o));
  const changes = Array.isArray(p.changes) ? (p.changes as Change[]) : [];

  return (
    <div className={clsx("card approval", cursor && "cursor")} data-approval-id={approval.id} tabIndex={-1}>
      <div className="card-head">
        <span className="dot warn pulse" />
        <span className="chip">{approval.kind.replace("_", " ")}</span>
        <span>{approval.title}</span>
        <span className="spacer" />
        <span className="dim">approval needed</span>
      </div>
      {approval.description && <div className="card-desc">{approval.description}</div>}
      {isCommand && (
        <pre className="item-cmd">
          {p.cwd ? <span className="dim">{String(p.cwd)} </span> : null}
          <span className="dim">$ </span>
          {String(p.command ?? "")}
        </pre>
      )}
      {changes.map((c, i) => (
        <div key={i} className="item-change">
          <div className="item-change-head">
            <span className="chip">{c.kind ?? "modify"}</span> <span className="mono">{c.path}</span>
          </div>
          {c.diff && <DiffText diff={c.diff} maxLines={200} />}
        </div>
      ))}
      {!isCommand && changes.length === 0 && (p.input !== undefined || p.plan !== undefined) && (
        <pre>{prettyJson(p.input ?? p.plan)}</pre>
      )}
      {mode === "edit" && (
        <div className="card-edit">
          <textarea
            ref={taRef}
            value={draft}
            rows={isCommand ? 2 : 8}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") setMode("idle");
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey || (isCommand && !e.shiftKey))) {
                e.preventDefault();
                submitEdit();
              }
            }}
          />
          <div className="actions">
            <button className="btn small primary" data-command="approval.edit-submit" onClick={submitEdit}>Send edited <kbd>{isCommand ? "Enter" : "⌘Enter"}</kbd></button>
            <button className="btn small" data-hint onClick={() => setMode("idle")}>Back <kbd>Esc</kbd></button>
          </div>
        </div>
      )}
      {mode === "decline" && (
        <div className="card-edit">
          <textarea
            ref={taRef}
            value={draft}
            rows={2}
            placeholder="Optional message to the agent (why declined)…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") setMode("idle");
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                setMode("idle");
                void respond("decline", null, draft.trim() || null);
              }
            }}
          />
          <div className="actions">
            <button className="btn small danger" data-command="approval.decline-submit" onClick={() => { setMode("idle"); void respond("decline", null, draft.trim() || null); }}>Decline <kbd>Enter</kbd></button>
            <button className="btn small" data-hint onClick={() => setMode("idle")}>Back <kbd>Esc</kbd></button>
          </div>
        </div>
      )}
      {mode === "idle" && (
        <div className="actions">
          {options.map((o) => {
            const l = LABEL[o];
            const onClick = () => {
              if (o === "edit_input") return openEdit();
              if (o === "decline") {
                setDraft("");
                setMode("decline");
                return;
              }
              void respond(o);
            };
            return (
              <button key={o} className={clsx("btn small", l.cls)} disabled={busy} data-command={`approval.${o}`} onClick={onClick}>
                {l.text} <kbd>{l.key}</kbd>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
