/** Helpers exported to mods through "@aura/host" that have no other home. */
import { isTauri } from "../lib/connection";

/** Open a URL in the user's browser (the system one in the desktop app). */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      return;
    } catch {
      /* fall back to the webview */
    }
  }
  window.open(url, "_blank", "noopener");
}
