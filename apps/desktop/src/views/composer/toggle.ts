import { useStore } from "../../state/store";

/** Switches the message box between formatting as you type and plain markdown; the draft stays as it is. */
export function toggleRichComposer(refocus: boolean) {
  const { settings, setSettings } = useStore.getState();
  setSettings({ composerRich: !settings.composerRich });
  // The box of the tab shown: the other tabs' boxes stay mounted, hidden.
  if (refocus) requestAnimationFrame(() => [...document.querySelectorAll<HTMLElement>('[data-region="composer"] [data-autofocus]')].find((el) => !el.closest("[data-tab-pane][hidden]"))?.focus());
}
