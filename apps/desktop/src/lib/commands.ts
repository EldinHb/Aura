/**
 * Command registry. Every user-facing action is a command: the palette lists
 * them, the keymap binds them, hint mode and menus invoke them. A UI element
 * must never do something that is not reachable through a command.
 */
export type CommandContext = {
  focus: string;
  inputFocused: boolean;
  terminalFocused: boolean;
  dialogOpen: boolean;
  /** A focused in-page widget (`[data-keynav]`) owns plain keys, like a dialog does. */
  widgetFocused: boolean;
  paletteOpen: boolean;
  hasSelection: boolean;
  /** The selected session works in a folder of the user's (see `folderOf`). */
  hasFolder: boolean;
  /** The selected session is an orchestrator. */
  orchestrator: boolean;
  mode: string | null; // structured | terminal
  provider: string | null;
  status: string | null;
  pending: number;
  running: boolean;
  isMac: boolean;
};

export type Command = {
  id: string;
  title: string;
  group: string;
  keywords?: string[];
  /** `when` expression; see evaluateWhen */
  when?: string;
  hidden?: boolean;
  run: (arg?: unknown) => void | Promise<void>;
};

const registry = new Map<string, Command>();
const listeners = new Set<() => void>();

export function registerCommand(cmd: Command): () => void {
  registry.set(cmd.id, cmd);
  for (const l of listeners) l();
  return () => {
    registry.delete(cmd.id);
    for (const l of listeners) l();
  };
}

export function registerCommands(cmds: Command[]): () => void {
  const offs = cmds.map(registerCommand);
  return () => offs.forEach((o) => o());
}

export function getCommand(id: string): Command | undefined {
  return registry.get(id);
}

export function allCommands(): Command[] {
  return [...registry.values()];
}

export function onCommandsChanged(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function listCommands(ctx: CommandContext): Command[] {
  return allCommands().filter((c) => !c.hidden && evaluateWhen(c.when, ctx));
}

export async function runCommand(id: string, arg?: unknown): Promise<boolean> {
  const c = registry.get(id);
  if (!c) {
    console.warn("unknown command", id);
    return false;
  }
  try {
    await c.run(arg);
    return true;
  } catch (e) {
    console.error("command failed", id, e);
    const msg = e instanceof Error ? e.message : String(e);
    errorHandler?.(msg);
    return false;
  }
}

let errorHandler: ((msg: string) => void) | null = null;
export function setCommandErrorHandler(h: (msg: string) => void) {
  errorHandler = h;
}

/**
 * `when` mini-language: comma separated terms, all must hold.
 *   focus:sidebar      ctx.focus === "sidebar"
 *   !inputFocused      boolean negation
 *   mode:terminal      ctx.mode === "terminal"
 *   provider:claude    ctx.provider === "claude"
 *   pending            ctx.pending > 0
 *   hasSelection, hasFolder, orchestrator, running, terminalFocused, inputFocused, dialogOpen, widgetFocused, paletteOpen
 *   focus:sidebar|main  alternatives with |
 */
export function evaluateWhen(expr: string | undefined, ctx: CommandContext): boolean {
  if (!expr) return true;
  return expr.split(",").every((raw) => {
    const term = raw.trim();
    if (!term) return true;
    const neg = term.startsWith("!");
    const t = neg ? term.slice(1) : term;
    let val: boolean;
    const [k, v] = t.split(":");
    if (v !== undefined) {
      const options = v.split("|");
      const actual = (ctx as unknown as Record<string, unknown>)[k];
      val = options.includes(String(actual));
    } else {
      const actual = (ctx as unknown as Record<string, unknown>)[t];
      val = typeof actual === "number" ? actual > 0 : Boolean(actual);
    }
    return neg ? !val : val;
  });
}

/** Simple fuzzy match used by the palette; returns a score or null. */
export function fuzzyScore(text: string, query: string): number | null {
  const t = text.toLowerCase();
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  let score = 0;
  let ti = 0;
  let last = -2;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx < 0) return null;
    score += 10;
    if (idx === last + 1) score += 15;
    if (idx === 0 || /[\s:._/-]/.test(t[idx - 1] ?? "")) score += 12;
    last = idx;
    ti = idx + 1;
  }
  if (t.startsWith(q)) score += 30;
  if (t.includes(q)) score += 20;
  return score - Math.floor(t.length / 8);
}
