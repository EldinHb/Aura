import { useEffect, useState } from "react";
import { Modal } from "../Modal";
import { useStore } from "../../state/store";

/** One session's own system prompt, and the full prompt its agent starts with. */
export function SystemPromptDialog({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const client = useStore((s) => s.client);
  const closeDialog = useStore((s) => s.closeDialog);
  const openDialog = useStore((s) => s.openDialog);
  const toast = useStore((s) => s.toast);
  const [value, setValue] = useState(session?.system_prompt ?? "");
  const [effective, setEffective] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!client) return;
    client.effectivePrompt(sessionId).then(setEffective, () => setEffective(undefined));
  }, [client, sessionId]);

  const save = async () => {
    if (!client) return;
    try {
      await client.setSystemPrompt(sessionId, value.trim() ? value : null);
      toast(session?.status === "idle" ? "System prompt saved; the agent picks it up with your next message" : "System prompt saved; the agent picks it up the next time it starts");
      closeDialog();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  return (
    <Modal
      title={`System prompt · ${session?.title ?? ""}`}
      width={760}
      onSubmit={() => void save()}
      footer={
        <>
          <button type="button" className="btn" data-hint onClick={() => openDialog({ kind: "settings", tab: "prompts" })}>Global and agent prompts…</button>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" data-command="dialog.cancel" onClick={closeDialog}>Cancel</button>
          <button type="button" className="btn primary" data-command="dialog.confirm" onClick={() => void save()}>Save <kbd>⌘↩</kbd></button>
        </>
      }
    >
      <div className="field">
        <label>This session</label>
        <textarea
          className="prompt-input"
          data-autofocus
          rows={8}
          placeholder="Instructions for this session only, added after the global and agent prompts"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <span className="dim prompt-help">
          <span className="mono">{"{{agent}}"}</span>, <span className="mono">{"{{model}}"}</span> and <span className="mono">{"{{effort}}"}</span> are filled in when the agent starts. An idle agent restarts with the new prompt on your next message; a working one keeps its prompt until it next starts.
        </span>
      </div>
      {effective !== undefined && (
        <details className="prompt-effective">
          <summary>What the agent currently starts with</summary>
          <pre>{effective ?? "No system prompt"}</pre>
        </details>
      )}
    </Modal>
  );
}
