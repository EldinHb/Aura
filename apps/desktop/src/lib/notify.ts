import { isTauri } from "./connection";

/** What a click on a notification opens; handled by the listener given to `onNotificationClick`. */
export type NotifyTarget = Record<string, unknown>;

let clicked: ((target: NotifyTarget) => void) | null = null;

/** Handle clicks on notifications sent with a target. One handler; a later call replaces it. */
export function onNotificationClick(handler: (target: NotifyTarget) => void): () => void {
  clicked = handler;
  return () => { if (clicked === handler) clicked = null; };
}

if (isTauri()) {
  // The shell shows the main window and reports the click with the notification's target.
  import("@tauri-apps/api/event").then(({ listen }) => listen<NotifyTarget>("aura://notification-clicked", (e) => clicked?.(e.payload))).catch(() => {});
}

/**
 * OS notification through the Tauri plugin, or the web API in a browser. With a `target`,
 * clicking it opens that target (see `onNotificationClick`): the shell shows it natively,
 * since the plugin does not report clicks on desktop.
 */
export async function desktopNotify(title: string, body: string, target?: NotifyTarget) {
  if (isTauri()) {
    try {
      const n = await import("@tauri-apps/plugin-notification");
      let ok = await n.isPermissionGranted();
      if (!ok) ok = (await n.requestPermission()) === "granted";
      if (!ok) return;
      if (target) {
        const { invoke } = await import("@tauri-apps/api/core");
        try { await invoke("notify_with_target", { title, body, target }); return; } catch { /* show it without the click */ }
      }
      n.sendNotification({ title, body });
    } catch {
      /* ignore */
    }
  } else if ("Notification" in window && Notification.permission === "granted") {
    const n = new Notification(title, { body });
    if (target) n.onclick = () => { window.focus(); clicked?.(target); };
  }
}
