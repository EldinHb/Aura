import { useStore } from "../../state/store";

/** Switches the message box between formatting as you type and plain markdown; the draft stays as it is. */
export function toggleRichComposer(refocus: boolean) {
  const { settings, setSettings } = useStore.getState();
  setSettings({ composerRich: !settings.composerRich });
  if (refocus) requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-region="composer"] [data-autofocus]')?.focus());
}
