import { useState } from "react";
import { selectIsRemote, useStore } from "../../state/store";
import { computerName, useComputers } from "../../state/computers";
import { basename } from "../../lib/platform";
import type { SessionTemplate } from "../../gen";
import { describeTemplate, templates, useTemplates } from "./state";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Settings → Templates: rename and delete the templates saved from the new-session dialog. */
export function TemplatesTab() {
  const list = useTemplates((s) => s.templates);
  const loaded = useTemplates((s) => s.loaded);
  const error = useTemplates((s) => s.error);
  const toast = useStore((s) => s.toast);
  const openDialog = useStore((s) => s.openDialog);
  // Templates belong to the computer the window shows: a remote's name its folders.
  const remote = useStore(selectIsRemote);
  const computer = useStore((s) => s.computer);
  const shownComputer = useComputers((s) => computerName(computer, s.remotes));
  const where = remote ? <div className="dim" style={{ fontSize: 11, marginBottom: 8 }}>The templates of <strong>{shownComputer}</strong>, the computer this window shows.</div> : null;
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const rename = async (t: SessionTemplate, name: string) => {
    try {
      const { id: _id, created_at: _c, updated_at: _u, ...input } = t;
      await templates.update(t.id, { ...input, name });
      setRenaming(null);
    } catch (e) {
      toast(message(e), "error");
    }
  };
  const remove = async (t: SessionTemplate) => {
    try {
      await templates.remove(t.id);
      setConfirming(null);
      toast(`Deleted template ${t.name}`);
    } catch (e) {
      toast(message(e), "error");
    }
  };

  if (error) return <div className="err-text" style={{ padding: 12 }}>Could not load templates: {error}</div>;
  if (loaded && list.length === 0) {
    return (
      <div className="empty" style={{ height: "auto", padding: 20 }}>
        {where}
        No templates yet. Set up a new session the way you like it and pick <strong>Save as template…</strong> in the new-session dialog.{" "}
        <button data-hint type="button" className="linkish" onClick={() => openDialog({ kind: "new-session" })}>New session…</button>
      </div>
    );
  }
  return (
    <div>
      {where}
      <div className="dim" style={{ fontSize: 11, marginBottom: 8 }}>
        Templates fill the new-session dialog, here and on paired phones. Saving a template under a name that exists is refused; delete or rename the old one first.
      </div>
      {list.map((t, i) => (
        <div key={t.id} className="provider-card">
          <div className="provider-head">
            {renaming?.id === t.id ? (
              <input
                type="text"
                aria-label="Template name"
                value={renaming.name}
                maxLength={60}
                autoFocus
                onChange={(e) => setRenaming({ id: t.id, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); void rename(t, renaming.name); }
                  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setRenaming(null); }
                }}
                style={{ maxWidth: 280 }}
              />
            ) : <strong>{t.name}</strong>}
            <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              {renaming?.id === t.id ? (
                <>
                  <button data-hint type="button" className="btn small" disabled={!renaming.name.trim()} onClick={() => void rename(t, renaming.name)}>Save</button>
                  <button data-hint type="button" className="btn small" onClick={() => setRenaming(null)}>Cancel</button>
                </>
              ) : confirming === t.id ? (
                <>
                  <span className="dim">Delete?</span>
                  <button type="button" className="btn small danger" data-hint data-autofocus onClick={() => void remove(t)}>Delete</button>
                  <button type="button" className="btn small" data-hint onClick={() => setConfirming(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <button type="button" className="btn small" data-hint data-autofocus={i === 0 ? true : undefined} onClick={() => setRenaming({ id: t.id, name: t.name })}>Rename…</button>
                  <button type="button" className="btn small" data-hint onClick={() => setConfirming(t.id)}>Delete…</button>
                </>
              )}
            </span>
          </div>
          <div className="dim" style={{ fontSize: 12 }}>{describeTemplate(t, basename)}</div>
          {t.prompt && <div className="dim template-prompt" title={t.prompt}>“{t.prompt.length > 140 ? `${t.prompt.slice(0, 139)}…` : t.prompt}”</div>}
        </div>
      ))}
    </div>
  );
}
