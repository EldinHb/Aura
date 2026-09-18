import { useState } from "react";
import { Modal } from "../Modal";
import { useStore } from "../../state/store";

export function RenameDialog({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const client = useStore((s) => s.client);
  const closeDialog = useStore((s) => s.closeDialog);
  const toast = useStore((s) => s.toast);
  const [value, setValue] = useState(session?.title ?? "");
  const save = async () => {
    const title = value.trim();
    if (!title || !client) return;
    try {
      await client.rename(sessionId, title);
      closeDialog();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };
  return (
    <Modal
      title="Rename session"
      width={460}
      footer={
        <>
          <button type="button" className="btn" data-command="dialog.cancel" onClick={closeDialog}>Cancel</button>
          <button type="button" className="btn primary" data-command="dialog.confirm" onClick={() => void save()}>Save <kbd>↩</kbd></button>
        </>
      }
    >
      <div className="field">
        <label>Title</label>
        <input
          type="text"
          data-autofocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            }
          }}
        />
      </div>
    </Modal>
  );
}
