/**
 * The mod's `ctx`, set once by `activate` (see ../ui.tsx), and helpers over it. Modules
 * and stores read it when they act, never when they load, so a test can set a fake first.
 */
import type { UiApi } from "@aura/mod-sdk/ui";

let current: UiApi | null = null;

export function setCtx(ctx: UiApi | null) { current = ctx; }

export function ctx(): UiApi {
  if (!current) throw new Error("The pull-requests mod is not active");
  return current;
}

/** Call a method of this mod's daemon half; the method names are those of the former core daemon. */
export function rpc<T>(method: string, params: unknown = {}): Promise<T> {
  if (!current) return Promise.reject(new Error("Not connected to the daemon"));
  return current.rpc<T>(method, params);
}

export function report(error: unknown) { current?.toast(String(error), "error"); }

export function toast(message: string, level?: "info" | "warn" | "error") { current?.toast(message, level); }

/** An OS notification through Aura; a click with a target comes back through `ctx.onNotificationClick`. */
export function notify(title: string, body: string, target?: unknown) { current?.notify(title, body, target as never); }

/** A value kept in the mod's namespaced localStorage. */
export function stored<T>(key: string, fallback: T): T {
  try {
    const value = current?.storage.get<T>(key);
    return value === undefined || value === null ? fallback : value;
  } catch { return fallback; }
}

export function store(key: string, value: unknown) {
  try { current?.storage.set(key, value); } catch { /* storage full or unavailable: keep it for this session */ }
}

export function unstore(key: string) {
  try { current?.storage.delete(key); } catch { /* nothing to remove */ }
}

/** A detached single-session window: it neither announces nor owns notifications, as before. */
export const isSessionWindow = () => current?.window === "session";
