/**
 * Keybinding engine.
 *
 * A binding maps a key sequence ("mod+k", "g g", "leader s n") to a command.
 * Chords use `+` between modifiers and key; sequences are space separated.
 * `mod` is cmd on macOS and ctrl elsewhere; `leader` is the configurable
 * leader chord. Pending sequences drive the which-key overlay.
 */
import { evaluateWhen, type CommandContext } from "./commands";

export type Binding = { keys: string; command: string; when?: string; arg?: unknown; label?: string };

export type KeyResult =
  | { kind: "none" }
  | { kind: "pending"; prefix: string[]; candidates: { key: string; label: string; command: string }[] }
  | { kind: "run"; command: string; arg?: unknown; binding: Binding };

const MOD_ORDER = ["ctrl", "alt", "shift", "cmd"];

export function normalizeChord(chord: string, isMac: boolean, leader: string): string {
  const raw = chord.trim().toLowerCase();
  if (raw === "leader") return normalizeChord(leader, isMac, "ctrl+space");
  const parts = raw.split("+").map((p) => p.trim()).filter(Boolean);
  const key = parts.pop() ?? "";
  const mods = new Set<string>();
  for (const p of parts) {
    if (p === "mod") mods.add(isMac ? "cmd" : "ctrl");
    else if (p === "meta" || p === "command" || p === "super") mods.add("cmd");
    else if (p === "control") mods.add("ctrl");
    else if (p === "option") mods.add("alt");
    else mods.add(p);
  }
  const ordered = MOD_ORDER.filter((m) => mods.has(m));
  return [...ordered, normalizeKeyName(key)].join("+");
}

function normalizeKeyName(k: string): string {
  const map: Record<string, string> = {
    " ": "space",
    spacebar: "space",
    esc: "escape",
    return: "enter",
    del: "delete",
    arrowup: "up",
    arrowdown: "down",
    arrowleft: "left",
    arrowright: "right",
    pageup: "pageup",
    pagedown: "pagedown",
    "\\": "backslash",
    "/": "slash",
    ",": "comma",
    ".": "period",
    "[": "bracketleft",
    "]": "bracketright",
    ";": "semicolon",
    "'": "quote",
    "`": "backquote",
    "-": "minus",
    "=": "equal",
    "?": "question",
  };
  return map[k] ?? k;
}

/** Translate a DOM KeyboardEvent to a normalized chord string. */
export function chordFromEvent(e: KeyboardEvent, _isMac: boolean): string | null {
  const key = e.key;
  if (["Shift", "Control", "Alt", "Meta", "CapsLock", "Dead", "Unidentified"].includes(key)) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.metaKey) mods.push("cmd");
  let k = key.length === 1 ? key : key.toLowerCase();
  // For letters, express shift explicitly and use the lowercase letter.
  if (key.length === 1 && /[a-zA-Z]/.test(key)) {
    if (e.shiftKey) mods.push("shift");
    k = key.toLowerCase();
  } else if (key.length === 1) {
    // symbols / digits: the produced character already encodes shift, unless
    // another modifier is held (then e.key can be odd on macOS; fall back to code)
    if (e.shiftKey && (e.ctrlKey || e.metaKey || e.altKey)) {
      mods.push("shift");
      k = codeToKey(e.code) ?? k;
    } else if (e.shiftKey && /[0-9]/.test(key)) {
      mods.push("shift");
    }
  } else if (e.shiftKey) {
    mods.push("shift");
  }
  if (e.altKey && key.length === 1 && !/[a-zA-Z0-9]/.test(key)) k = codeToKey(e.code) ?? k;
  const ordered = MOD_ORDER.filter((m) => mods.includes(m));
  return [...ordered, normalizeKeyName(k)].join("+");
}

function codeToKey(code: string): string | null {
  if (code.startsWith("Key")) return code.slice(3).toLowerCase();
  if (code.startsWith("Digit")) return code.slice(5);
  const map: Record<string, string> = {
    Space: "space",
    Comma: "comma",
    Period: "period",
    Slash: "slash",
    Backslash: "backslash",
    BracketLeft: "bracketleft",
    BracketRight: "bracketright",
    Semicolon: "semicolon",
    Quote: "quote",
    Backquote: "backquote",
    Minus: "minus",
    Equal: "equal",
  };
  return map[code] ?? null;
}

/**
 * Layout-independent key for a DOM event: letters and digits come from `code`,
 * everything else falls back to `key`. Option+1 is "¡" and Option+T is "†" on
 * macOS, so any shortcut reachable with Option must compare against this rather
 * than `e.key`. Only use it when a modifier is held — for plain typing `e.key`
 * is what the user actually meant on a non-US layout.
 */
export function physicalKey(e: { code?: string; key: string }): string {
  return codeToKey(e.code ?? "") ?? e.key;
}

export function hasModifier(chord: string): boolean {
  return /(^|\+)(ctrl|alt|cmd)\+/.test(chord);
}

export type Resolved = { binding: Binding; seq: string[] };

export class Keymap {
  private resolved: Resolved[] = [];
  private pending: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  leaderChord: string;

  /** Labels for sequence prefixes shown in which-key, keyed by normalized prefix ("ctrl+space s"). */
  groupLabels: Record<string, string> = {};

  constructor(bindings: Binding[], private isMac: boolean, private leader: string, private timeoutMs = 2500) {
    this.leaderChord = normalizeChord("leader", isMac, leader);
    this.setBindings(bindings);
  }

  setGroupLabels(labels: Record<string, string>) {
    this.groupLabels = {};
    for (const [k, v] of Object.entries(labels)) {
      this.groupLabels[k.split(/\s+/).map((c) => normalizeChord(c, this.isMac, this.leader)).join(" ")] = v;
    }
  }

  setBindings(bindings: Binding[]) {
    this.resolved = bindings.map((b) => ({
      binding: b,
      seq: b.keys.split(/\s+/).filter(Boolean).map((c) => normalizeChord(c, this.isMac, this.leader)),
    }));
  }

  get pendingPrefix(): string[] {
    return [...this.pending];
  }

  reset() {
    this.pending = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Bindings whose command matches, for display in the palette. */
  bindingsFor(command: string): string[] {
    return this.resolved.filter((r) => r.binding.command === command).map((r) => r.seq.join(" "));
  }

  /**
   * Whether a chord is allowed to fire while a text input / terminal has focus.
   * Inputs: modifier chords, escape and the leader. Terminals: only leader and
   * cmd-chords (mac) / ctrl+shift-chords (others) so the shell keeps ctrl keys.
   */
  eligibleInInput(firstChord: string, ctx: CommandContext, binding: Binding): boolean {
    if (firstChord === this.leaderChord) return true;
    if (ctx.terminalFocused) {
      if (this.isMac) return firstChord.includes("cmd+");
      return firstChord.startsWith("ctrl+shift+") || firstChord.includes("alt+");
    }
    if (ctx.inputFocused) {
      if (firstChord === "escape") return true;
      if (hasModifier(firstChord)) return true;
      // plain keys in inputs only when the binding explicitly opts in
      return binding.when?.includes("inputFocused") ?? false;
    }
    return true;
  }

  handle(chord: string, ctx: CommandContext, onTimeout?: () => void): KeyResult {
    const inPending = this.pending.length > 0;
    if (chord === "escape" && inPending) {
      this.reset();
      return { kind: "run", command: "keymap.cancel", binding: { keys: "escape", command: "keymap.cancel" } };
    }
    const seq = [...this.pending, chord];
    const candidates = this.resolved.filter((r) => {
      if (r.seq.length < seq.length) return false;
      for (let i = 0; i < seq.length; i++) if (r.seq[i] !== seq[i]) return false;
      if (!evaluateWhen(r.binding.when, ctx)) return false;
      if ((ctx.inputFocused || ctx.terminalFocused) && !this.eligibleInInput(r.seq[0], ctx, r.binding)) return false;
      return true;
    });
    // Exact matches win over longer sequences when both exist and we are not in a pending state
    // (a plain "g" with both "g" and "g g" bound would otherwise be unreachable): prefer the longer
    // only if pending already started.
    const exact = candidates.filter((r) => r.seq.length === seq.length);
    const longer = candidates.filter((r) => r.seq.length > seq.length);
    if (exact.length > 0 && (longer.length === 0 || inPending || seq.length > 1 || exact[0].seq.length > 1)) {
      this.reset();
      const b = exact[exact.length - 1].binding; // later bindings override earlier ones
      return { kind: "run", command: b.command, arg: b.arg, binding: b };
    }
    if (longer.length > 0) {
      this.pending = seq;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.reset();
        onTimeout?.();
      }, this.timeoutMs);
      const seen = new Map<string, { key: string; label: string; command: string }>();
      for (const r of longer) {
        const next = r.seq[seq.length];
        if (!seen.has(next)) {
          const isGroup = r.seq.length > seq.length + 1;
          const groupLabel = this.groupLabels[[...seq, next].join(" ")];
          seen.set(next, {
            key: next,
            label: isGroup ? `+${groupLabel ?? "more"}` : r.binding.label ?? r.binding.command,
            command: isGroup ? "" : r.binding.command,
          });
        }
      }
      return { kind: "pending", prefix: seq, candidates: [...seen.values()] };
    }
    if (exact.length > 0) {
      this.reset();
      const b = exact[exact.length - 1].binding;
      return { kind: "run", command: b.command, arg: b.arg, binding: b };
    }
    if (inPending) {
      this.reset();
      return { kind: "run", command: "keymap.cancel", binding: { keys: "", command: "keymap.cancel" } };
    }
    return { kind: "none" };
  }
}

/** Pretty label for a chord sequence, e.g. "⌘K" or "Ctrl+Space S N". */
export function formatKeys(seq: string, isMac: boolean): string {
  return seq
    .split(/\s+/)
    .map((chord) =>
      chord
        .split("+")
        .map((p) => {
          if (isMac) {
            const mac: Record<string, string> = { cmd: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧", enter: "↩", escape: "⎋", space: "␣", up: "↑", down: "↓", left: "←", right: "→", backspace: "⌫", tab: "⇥" };
            if (mac[p]) return mac[p];
          }
          const names: Record<string, string> = { cmd: "Cmd", ctrl: "Ctrl", alt: "Alt", shift: "Shift", enter: "Enter", escape: "Esc", space: "Space", slash: "/", comma: ",", period: ".", question: "?", bracketleft: "[", bracketright: "]", backslash: "\\", minus: "-", equal: "=" };
          return names[p] ?? (p.length === 1 ? p.toUpperCase() : p);
        })
        .join(isMac ? "" : "+"),
    )
    .join(" ");
}
