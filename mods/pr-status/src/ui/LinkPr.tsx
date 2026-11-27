// Linking a pull request to a session by hand, and unlinking one: inline in the section, or in
// a small dialog (from the command palette, also when the section shows no PRs yet).
import { useId, useState } from "react";
import type { DialogProps } from "@aura/mod-sdk/ui";
import { Modal } from "@aura/host";
import type { PrRef } from "../shared/types";
import { getCtx } from "./ctx";

export const LINK_DIALOG = "link";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A URL field and Link / Cancel; `done` after a link was saved (or on Cancel). */
export function LinkForm({ sessionId, done }: { sessionId: string; done: (linked: boolean) => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useId();
  const submit = async () => {
    const ctx = getCtx();
    if (!ctx || busy || !url.trim()) return;
    setBusy(true);
    try {
      await ctx.rpc("links.add", { sessionId, url: url.trim() });
      done(true);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  return (
    <form className="prs-link-form" data-own-escape aria-label="Link a pull request"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          done(false);
        }
      }}>
      <label htmlFor={field}>Pull request URL</label>
      <input id={field} value={url} placeholder="https://github.com/owner/repo/pull/123" disabled={busy} autoFocus
        onChange={(e) => {
          setUrl(e.target.value);
          setError(null);
        }} />
      {error && <p className="err-text prs-wrap" role="alert">{error}</p>}
      <div className="prs-confirm-actions">
        <button type="button" className="btn small" disabled={busy} onClick={() => done(false)}>Cancel</button>
        <button type="submit" className="btn small primary" disabled={busy || !url.trim()}>{busy ? "Linking…" : "Link"}</button>
      </div>
    </form>
  );
}

/** The dialog form of it, for the selected session. */
export function LinkDialog({ props, close }: DialogProps<{ sessionId: string }>) {
  return (
    <Modal title="Link a pull request" width={480} onClose={close}>
      <LinkForm sessionId={props.sessionId} done={() => close()} />
    </Modal>
  );
}

/** Unlink a PR from the sessions it came from: no longer linked, and not shown however it is found. */
export async function unlink(ref: PrRef): Promise<void> {
  const ctx = getCtx();
  if (!ctx) return;
  for (const s of ref.sources) await ctx.rpc("links.remove", { sessionId: s.sessionId, url: ref.url });
}
