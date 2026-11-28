/**
 * The one place a mod or a theme's CSS is approved: a modal <dialog> in the
 * browser's top layer, attached to <body> and styled only by the protected
 * layer of protected.css, so no theme or mod stylesheet can hide, move or
 * relabel it. `aura mods approve` / `aura themes approve` (and the buttons in
 * Settings) only open it; a click on its Approve button grants.
 */
import { useEffect, useRef, useState } from "react";
import { isTauri } from "../lib/connection";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { selectLocalClient, useStore } from "../state/store";
import { refreshThemes, useThemes } from "../state/themes";
import { modsApi, syncMods, useMods } from "./loader";
import { describePermissions } from "./permissions";

export type ApprovalPrompt = { kind: "mod" | "theme"; id: string };

export const useApproval = create<{ prompt: ApprovalPrompt | null }>(() => ({ prompt: null }));

export function openApprovalPrompt(kind: ApprovalPrompt["kind"], id: string) {
  useApproval.setState({ prompt: { kind, id } });
  if (kind === "mod") void syncMods();
  else void refreshThemes();
}

const close = () => useApproval.setState({ prompt: null });

export function ApprovalDialog() {
  const prompt = useApproval((s) => s.prompt);
  const mod = useMods((s) => (prompt?.kind === "mod" ? s.mods.find((m) => m.id === prompt.id && !m.broken) : undefined));
  const theme = useThemes((s) => (prompt?.kind === "theme" ? s.themes.find((t) => t.id === prompt.id) : undefined));
  const toast = useStore((s) => s.toast);
  const ref = useRef<HTMLDialogElement>(null);
  const show = !!prompt && (!!mod || !!theme);
  // Whether this window may grant: it must have presented the window secret
  // its desktop shell gave the daemon (see lib/connection.ts). Not so when the
  // daemon was started by `aura` or by an earlier run of the app.
  const [isWindow, setIsWindow] = useState<boolean | null>(null);
  const [restarting, setRestarting] = useState(false);
  useEffect(() => {
    if (!show) return;
    setIsWindow(null);
    selectLocalClient(useStore.getState())
      ?.call<{ window: boolean }>("daemon.window_status", {})
      .then((s) => setIsWindow(!!s?.window))
      .catch(() => setIsWindow(false));
  }, [show, prompt?.kind, prompt?.id]);

  const restartService = async () => {
    setRestarting(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("restart_daemon");
      location.reload();
    } catch (e) {
      setRestarting(false);
      toast(String((e as Error)?.message ?? e), "error");
    }
  };

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (show && !d.open) {
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
    } else if (!show && d.open) {
      if (typeof d.close === "function") d.close();
      else d.removeAttribute("open");
    }
  }, [show]);

  const approve = async () => {
    if (!prompt) return;
    try {
      if (prompt.kind === "mod") {
        await modsApi.approve(prompt.id);
        await syncMods();
      } else {
        await selectLocalClient(useStore.getState())?.call("themes.approve", { id: prompt.id });
        await refreshThemes();
      }
      close();
    } catch (e) {
      toast(String((e as Error)?.message ?? e), "error");
    }
  };

  let body: React.ReactNode = null;
  if (show && mod) {
    body = (
      <>
        <h2>Approve the mod {mod.name}?</h2>
        <p>
          <strong>{mod.name}</strong> {mod.version}, from <code>{mod.dir}</code>, asks to:
        </p>
        <ul>
          {describePermissions(mod.permissions ?? {}).map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        {mod.hasUi && (
          <p>
            Its interface part runs inside Aura's window with Aura's own rights: it can see and change anything this window can. Approve only mods from
            people you trust.
          </p>
        )}
      </>
    );
  } else if (show && theme) {
    body = (
      <>
        <h2>Approve the CSS of the theme {theme.name}?</h2>
        <p>
          <code>{theme.path.replace(/\.json$/, ".css")}</code> ({theme.cssBytes ?? 0} bytes) can restyle every screen in Aura, including the cards where you
          approve what agents run: it can hide, move or reword what you see. Only Aura's approval prompts for mods and themes, like this
          one, stay out of its reach.
        </p>
        <p>Its colour tokens apply without approval. If the CSS changes, Aura asks again.</p>
      </>
    );
  }

  return createPortal(
    <dialog
      ref={ref}
      className="aura-protected"
      aria-modal="true"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {body}
      {body && isWindow === false && (
        <p className="aura-protected-cannot">
          This window can't approve: Aura's background service was not started by this app (the <code>aura</code> command started it, or Aura was
          restarted since). {isTauri() ? "Restart the background service to approve; running agents stop, and your sessions resume afterwards." : "Start Aura's app to approve."}
        </p>
      )}
      {body && (
        <div className="aura-protected-actions">
          <button type="button" data-hint onClick={close}>
            Cancel
          </button>
          {isWindow === false ? (
            isTauri() && (
              <button type="button" data-hint className="aura-protected-approve" disabled={restarting} onClick={() => void restartService()}>
                {restarting ? "Restarting…" : "Restart background service"}
              </button>
            )
          ) : (
            <button type="button" data-hint className="aura-protected-approve" disabled={isWindow === null} onClick={() => void approve()}>
              {prompt?.kind === "mod" ? "Approve and start" : "Approve CSS"}
            </button>
          )}
        </div>
      )}
    </dialog>,
    document.body,
  );
}
