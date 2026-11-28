import { selectLocalClient, useStore } from "../state/store";

/**
 * Tell the daemon about a mod UI half's error, so it shows in `aura mods logs <id>`
 * next to the daemon half's lines: an agent working on a mod reads that log, not this window's console.
 */
export function reportModUiError(modId: string, what: string, error: unknown) {
  // A string is a message already located (see locateUiError).
  const e = error instanceof Error ? error : null;
  const message = e ? `${what}: ${e.message}${e.stack ? `\n${e.stack.split("\n").slice(0, 6).join("\n")}` : ""}` : `${what}: ${String(error)}`;
  // Reporting must never throw: it runs inside error boundaries and catch blocks.
  try {
    const client = selectLocalClient(useStore.getState());
    if (typeof client?.call !== "function") return;
    Promise.resolve(client.call("mods.ui_log", { id: modId, level: "error", message })).catch(() => {
      /* an older daemon, or not connected */
    });
  } catch {
    /* nothing to report to */
  }
}
