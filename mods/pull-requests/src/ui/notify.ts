/**
 * Toasts and OS notifications for what the daemon reports. A click on a notification sent
 * with a target opens it through `handleNotificationTarget`, which ../ui.tsx also hands to
 * `ctx.onNotificationClick`.
 */
import { useStore } from "./host";
import { toast } from "./ctx";

export type NotifyTarget = Record<string, unknown>;

let clicked: ((target: NotifyTarget) => void) | null = null;

/** Where a click on one of this mod's notifications goes. */
export function setNotificationHandler(handler: ((target: NotifyTarget) => void) | null) { clicked = handler; }
export function handleNotificationTarget(target: unknown) {
  if (target && typeof target === "object") clicked?.(target as NotifyTarget);
}

/**
 * An OS notification.
 * SDK-GAP: UiApi has no desktop notification (core's `desktopNotify`, whose Tauri path
 * reports clicks through `notify_with_target`). Only the web Notification API is reachable
 * from here; inside the Tauri shell the daemon half's `aura.notify` is the reliable way.
 */
export function desktopNotify(title: string, body: string, target?: NotifyTarget) {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const n = new Notification(title, { body });
    if (target) n.onclick = () => { window.focus(); handleNotificationTarget(target); };
  } catch { /* notifications unavailable */ }
}

/** A toast, and an OS notification too while the window is in the background. */
export function tell(title: string, message: string, level: "info" | "warn" | "error" = "info", target?: NotifyTarget) {
  toast(message, level);
  if (useStore.getState().settings.notifications && !document.hasFocus()) desktopNotify(title, message, target);
}
