import { useState } from "react";
import { useStore } from "../../state/store";
import type { FileStatus } from "../../gen";

/**
 * Commit form shown inside DiffDialog (`c`). Cmd/Ctrl+Enter commits, Escape cancels.
 * Exported as `CommitDialog` too for standalone use in the overlay switch.
 */
export function CommitForm({ cwd, statuses, onDone, onCancel }: { cwd: string; statuses: FileStatus[]; onDone: (sha: string | null) => void; onCancel: () => void }) {
  const client = useStore((s) => s.client);
  const toast = useStore((s) => s.toast);
  const [message, setMessage] = useState("");
  const [stageAll, setStageAll] = useState(true);
  const [busy, setBusy] = useState(false);

  const commit = async () => {
    if (!client || !message.trim() || busy) return;
    setBusy(true);
    try {
      const sha = await client.gitCommit(cwd, message.trim(), stageAll);
      onDone(sha);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
      setBusy(false);
    }
  };

  const staged = statuses.filter((s) => s.staged !== " " && s.staged !== "?").length;
  const unstaged = statuses.filter((s) => s.unstaged !== " " || s.staged === "?").length;

  return (
    <div
      className="commit-form"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.stopPropagation();
          void commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="field">
        <label>Commit message</label>
        <textarea data-autofocus autoFocus rows={5} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Summary line, then details…" />
      </div>
      <label className="check-row">
        <input type="checkbox" checked={stageAll} onChange={(e) => setStageAll(e.target.checked)} /> Stage all changes first ({unstaged} unstaged, {staged} staged)
      </label>
      <div className="modal-foot" style={{ borderTop: "none", padding: "10px 0 0" }}>
        <button type="button" className="btn" data-hint onClick={onCancel}>
          Cancel <kbd>Esc</kbd>
        </button>
        <button type="button" className="btn primary" data-hint disabled={!message.trim() || busy} onClick={() => void commit()}>
          {busy ? "Committing…" : "Commit"} <kbd>⌘↩</kbd>
        </button>
      </div>
    </div>
  );
}

export function CommitDialog({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const closeDialog = useStore((s) => s.closeDialog);
  const toast = useStore((s) => s.toast);
  if (!session) return null;
  return (
    <div className="overlay">
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-head">Commit · {session.title}</div>
        <div className="modal-body">
          <CommitForm
            cwd={session.cwd}
            statuses={[]}
            onDone={(sha) => {
              if (sha) toast(`Committed ${sha.slice(0, 8)}`);
              closeDialog();
            }}
            onCancel={closeDialog}
          />
        </div>
      </div>
    </div>
  );
}
