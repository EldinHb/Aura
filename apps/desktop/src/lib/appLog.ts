/**
 * Write to the app's log file (aura-desktop.log in the data directory): the
 * webview's console is kept nowhere. Outside the app it only goes to the console.
 */
import { isTauri } from "./connection";

export type LogLevel = "info" | "warn" | "error";

/** A thrown value in words, with its stack when it has one. */
export function describe(error: unknown): string {
  if (error instanceof Error) return error.stack && !error.stack.includes(error.message) ? `${error.message}\n${error.stack}` : (error.stack ?? error.message);
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

let core: Promise<typeof import("@tauri-apps/api/core")> | null = null;

export function appLog(level: LogLevel, message: string) {
  if (!isTauri()) return;
  core ??= import("@tauri-apps/api/core");
  // Never let logging fail anything, or log its own failure.
  void core.then(({ invoke }) => invoke("webview_log", { level, message })).catch(() => {});
}

let installed = false;

/** Log what nothing else catches: errors and rejected promises without a handler. */
export function logUncaughtErrors(target: Pick<Window, "addEventListener"> = window) {
  if (installed) return;
  installed = true;
  target.addEventListener("error", (e) => {
    const ev = e as ErrorEvent;
    appLog("error", `uncaught error: ${describe(ev.error ?? ev.message)}${ev.filename ? ` (${ev.filename}:${ev.lineno})` : ""}`);
  });
  target.addEventListener("unhandledrejection", (e) => {
    appLog("error", `unhandled rejection: ${describe((e as PromiseRejectionEvent).reason)}`);
  });
}

/** For tests. */
export function resetAppLog() {
  installed = false;
}
