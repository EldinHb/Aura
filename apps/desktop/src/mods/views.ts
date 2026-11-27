/**
 * A mod's main-area view as a tab: the preview tab (replaced by the next preview, as a session
 * picked in the sidebar is), or with `{ preview: false }` a tab of its own that stays. Either
 * way the same view and props key shows the tab it already has (see state/tabs.ts).
 */
import { useStore } from "../state/store";

export function openModView(modId: string, viewId: string, props?: unknown, opts?: { preview?: boolean }): void {
  const st = useStore.getState();
  if (opts?.preview === false) st.openTab({ kind: "mod", modId, viewId, props }, { preview: false });
  else st.openModView({ modId, id: viewId, props });
}
