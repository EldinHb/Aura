import { useMemo, useState } from "react";
import { Modal } from "../Modal";
import { useStore } from "../../state/store";

export function GroupDialog({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const sessions = useStore((s) => s.sessions);
  const client = useStore((s) => s.client);
  const closeDialog = useStore((s) => s.closeDialog);
  const toast = useStore((s) => s.toast);
  const [value, setValue] = useState(session?.group ?? "");
  const groups = useMemo(() => [...new Set(Object.values(sessions).map((s) => s.group).filter((g): g is string => !!g))].sort(), [sessions]);
  const save = async () => {
    if (!client) return;
    try {
      await client.setGroup(sessionId, value.trim() || null);
      closeDialog();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };
  return (
    <Modal
      title="Set group"
      width={460}
      footer={
        <>
          <button type="button" className="btn" data-command="dialog.cancel" onClick={closeDialog}>Cancel</button>
          <button type="button" className="btn primary" data-command="dialog.confirm" onClick={() => void save()}>Save <kbd>↩</kbd></button>
        </>
      }
    >
      <div className="field">
        <label>Group (empty removes it)</label>
        <input
          type="text"
          data-autofocus
          list="aura-groups"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            }
          }}
          placeholder="e.g. backend"
        />
        <datalist id="aura-groups">
          {groups.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
      </div>
      {groups.length > 0 && (
        <div className="chips">
          {groups.map((g) => (
            <button key={g} type="button" className="chip" data-hint data-command="group.pick" onClick={() => setValue(g)}>
              {g}
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
