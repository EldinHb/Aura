/**
 * Toasts and OS notifications for what the daemon reports. A click on a notification sent
 * with a target opens it through `handleNotificationTarget`, which ../ui.tsx also hands to
 * `ctx.onNotificationClick`.
 */
import { useStore } from "./host";
import { notify, toast } from "./ctx";

export type NotifyTarget = Record<string, unknown>;

let clicked: ((target: NotifyTarget) => void) | null = null;

/** Where a click on one of this mod's notifications goes. */
export function setNotificationHandler(handler: ((target: NotifyTarget) => void) | null) { clicked = handler; }
export function handleNotificationTarget(target: unknown) {
  if (target && typeof target === "object") clicked?.(target as NotifyTarget);
}

/** An OS notification through Aura; a click on one with a target reaches `handleNotificationTarget`. */
export function desktopNotify(title: string, body: string, target?: NotifyTarget) {
  notify(title, body, target);
}

/** A toast, and an OS notification too while the window is in the background. */
export function tell(title: string, message: string, level: "info" | "warn" | "error" = "info", target?: NotifyTarget) {
  toast(message, level);
  if (useStore.getState().settings.notifications && !document.hasFocus()) desktopNotify(title, message, target);
}
