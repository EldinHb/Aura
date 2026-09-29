import { isTauri } from "./connection";

/** OS notification through the Tauri plugin, or the web API in a browser. */
export async function desktopNotify(title: string, body: string) {
  if (isTauri()) {
    try {
      const n = await import("@tauri-apps/plugin-notification");
      let ok = await n.isPermissionGranted();
      if (!ok) ok = (await n.requestPermission()) === "granted";
      if (ok) n.sendNotification({ title, body });
    } catch {
      /* ignore */
    }
  } else if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body });
  }
}
