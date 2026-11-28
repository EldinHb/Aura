/**
 * What works when the app shows a remote computer (another Aura installation
 * it paired with). The remote's daemon allows a paired device only the
 * methods in `REMOTE_ALLOWED_METHODS` (crates/aura-rpc/src/remote.rs, the
 * single source of truth; a test keeps this copy equal to it). Everything
 * else is refused there with -32003; here it is hidden, or refused before it
 * leaves the app with a message that says so.
 */
import type { CreateSessionOpts } from "../gen";

/** The daemon methods a paired device may call. Kept equal to the daemon's list by remoteCapabilities.test.ts. */
export const REMOTE_ALLOWED_METHODS: readonly string[] = [
  "daemon.ping",
  "daemon.info",
  "provider.list",
  "provider.models",
  "orchestrator.projects",
  "workspace.list",
  "workspace.create",
  "workspace.rename",
  "session.set_workspace",
  "session.list",
  "session.get",
  "session.history",
  "session.pending",
  "session.attachment",
  "session.send",
  "session.interrupt",
  "session.stop",
  "session.respond_approval",
  "session.respond_input",
  "session.mark_seen",
  "session.create",
  "feature.list",
  "feature.get",
  "feature.answer",
];

const allowed = new Set(REMOTE_ALLOWED_METHODS);

export function remoteAllows(method: string): boolean {
  return allowed.has(method);
}

/** The hint shown wherever something is hidden or refused on a remote computer. */
export const NOT_ON_REMOTE = "Not available on remote computers";

/** What the user tried, in words, for the refusal. */
const METHOD_WHAT: Record<string, string> = {
  "pty.": "Terminals",
  "fs.": "Browsing files",
  "git.": "Git actions",
  "settings.": "Settings",
  "mods.": "Mods",
  "schedules.": "Scheduled tasks",
  "search": "Search",
  "session.delete": "Deleting sessions",
  "session.rename": "Renaming sessions",
  "session.set": "Changing the model, effort or modes",
  "session.fork": "Forking sessions",
};

/** "Terminals are not available on remote computers", or the method's name when there are no better words. */
export function refusalMessage(method: string): string {
  const key = Object.keys(METHOD_WHAT).find((k) => (k.endsWith(".") ? method.startsWith(k) : method === k));
  return `${key ? METHOD_WHAT[key] : `\`${method}\``}: ${NOT_ON_REMOTE.toLowerCase()}`;
}

/**
 * Commands that need methods a remote refuses: hidden from the palette and
 * menus while a remote computer is shown, and refused with a hint when a key
 * runs one. The app's own (settings, updates, help, tabs) always refer to this
 * computer and stay.
 */
const LOCAL_ONLY_COMMANDS = new Set([
  "session.new-terminal",
  "session.clear-notices",
  "session.clear-all-notices",
  "session.fork",
  "session.rename",
  "session.system-prompt",
  "session.toggle-orchestrator",
  "session.group",
  "session.pin",
  "session.archive",
  "session.restart",
  "session.delete",
  "session.toggle-mode",
  "session.mode-terminal",
  "session.mode-structured",
  "session.compact",
  "session.review",
  "session.pick-model",
  "session.pick-effort",
  "session.pick-permission",
  "session.pick-sandbox",
  "session.open-window",
  "import.open",
  "specialists.suggest",
  "search.open",
  "workspace.delete",
  "workers.cleanup",
  "workers.cleanup-orchestrator",
]);
const LOCAL_ONLY_PREFIXES = ["git.", "schedules."];

/** Whether command `id` works while a remote computer is shown. */
export function commandWorksRemotely(id: string): boolean {
  return !LOCAL_ONLY_COMMANDS.has(id) && !LOCAL_ONLY_PREFIXES.some((p) => id.startsWith(p));
}

/** The keys `session.create` takes from a remote device (anything else is refused, even null). */
const CREATE_KEYS = new Set([
  "provider",
  "agent",
  "cwd",
  "title",
  "group",
  "workspace",
  "model",
  "effort",
  "permission_mode",
  "sandbox_mode",
  "system_prompt",
  "mode",
  "initial_prompt",
  "worktree",
  "orchestrator",
  "feature_owner",
  "feature_goal",
  "autonomy",
]);

/**
 * `session.create`'s params as a remote takes them: only its keys, nulls left
 * out, a worktree as `{branch, base?}`. Says what cannot be done remotely.
 */
export function remoteCreateParams(opts: Partial<CreateSessionOpts> & Record<string, unknown>): Record<string, unknown> {
  if (opts.provider === "terminal" || opts.mode === "terminal") throw new Error(`Terminal sessions: ${NOT_ON_REMOTE.toLowerCase()}`);
  if (opts.command) throw new Error(`Custom commands: ${NOT_ON_REMOTE.toLowerCase()}`);
  if (opts.orchestrator_id) throw new Error(`Starting a worker of another session: ${NOT_ON_REMOTE.toLowerCase()}`);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(opts)) {
    if (!CREATE_KEYS.has(k) || v === null || v === undefined) continue;
    if (k === "worktree") {
      const w = v as { branch: string; base?: string | null };
      out.worktree = w.base ? { branch: w.branch, base: w.base } : { branch: w.branch };
    } else out[k] = v;
  }
  return out;
}
