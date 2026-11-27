import { describe, it, expect, beforeEach } from "vitest";
import { Keymap, normalizeChord, chordFromEvent, formatKeys, physicalKey } from "./keymap";
import type { CommandContext } from "./commands";
import { evaluateWhen, fuzzyScore } from "./commands";
import { defaultBindings, vimExtraBindings, workspaceDigitBindings, workspaceDigitKeys } from "../keymap/default";

const ctx: CommandContext = {
  focus: "sidebar",
  inputFocused: false,
  terminalFocused: false,
  dialogOpen: false,
  widgetFocused: false,
  paletteOpen: false,
  hasSelection: true,
  hasFolder: true,
  orchestrator: false,
  featureOwner: false,
  worker: false, hasWorkers: false,
  modeLocked: false,
  mode: "structured",
  provider: "claude",
  status: "idle",
  pending: 0,
  running: false,
  isMac: true,
};

describe("normalizeChord", () => {
  it("maps mod and orders modifiers", () => {
    expect(normalizeChord("shift+mod+K", true, "ctrl+space")).toBe("shift+cmd+k");
    expect(normalizeChord("mod+k", false, "ctrl+space")).toBe("ctrl+k");
    expect(normalizeChord("leader", true, "ctrl+space")).toBe("ctrl+space");
    expect(normalizeChord("Esc", true, "x")).toBe("escape");
  });
});

describe("chordFromEvent", () => {
  it("normalizes letters, shift and modifiers", () => {
    const e = new KeyboardEvent("keydown", { key: "K", code: "KeyK", metaKey: true, shiftKey: true });
    expect(chordFromEvent(e, true)).toBe("shift+cmd+k");
    expect(chordFromEvent(new KeyboardEvent("keydown", { key: "j" }), true)).toBe("j");
    expect(chordFromEvent(new KeyboardEvent("keydown", { key: "?", shiftKey: true }), true)).toBe("question");
    expect(chordFromEvent(new KeyboardEvent("keydown", { key: " ", ctrlKey: true, code: "Space" }), true)).toBe("ctrl+space");
    expect(chordFromEvent(new KeyboardEvent("keydown", { key: "Shift" }), true)).toBeNull();
  });
});

describe("physicalKey", () => {
  it("recovers the digit or letter macOS hides behind Option", () => {
    // ⌥1 and ⌥T produce "¡" / "†" in e.key; the shortcuts are defined on 1 and t.
    expect(physicalKey({ key: "\u00a1", code: "Digit1" })).toBe("1");
    expect(physicalKey({ key: "\u2020", code: "KeyT" })).toBe("t");
    expect(physicalKey({ key: "Enter", code: "Enter" })).toBe("Enter");
    expect(physicalKey({ key: "ArrowDown", code: "ArrowDown" })).toBe("ArrowDown");
  });
});

describe("Keymap", () => {
  const km = new Keymap(
    [
      { keys: "mod+k", command: "palette" },
      { keys: "leader s n", command: "new", label: "New session" },
      { keys: "leader s w", command: "new-worktree", label: "New in worktree" },
      { keys: "leader a", command: "inbox" },
      { keys: "g g", command: "first" },
      { keys: "j", command: "down", when: "!inputFocused" },
      { keys: "mod+1", command: "select", arg: 1 },
    ],
    true,
    "ctrl+space",
  );
  km.setGroupLabels({ "leader s": "Session" });
  beforeEach(() => km.reset());

  it("runs direct chords", () => {
    expect(km.handle("cmd+k", ctx)).toMatchObject({ kind: "run", command: "palette" });
    expect(km.handle("cmd+1", ctx)).toMatchObject({ kind: "run", command: "select", arg: 1 });
  });

  it("walks sequences with which-key candidates", () => {
    const r1 = km.handle("ctrl+space", ctx);
    expect(r1.kind).toBe("pending");
    if (r1.kind === "pending") {
      expect(r1.candidates.map((c) => c.key).sort()).toEqual(["a", "s"]);
      expect(r1.candidates.find((c) => c.key === "s")?.label).toBe("+Session");
    }
    const r2 = km.handle("s", ctx);
    expect(r2.kind).toBe("pending");
    if (r2.kind === "pending") expect(r2.candidates.find((c) => c.key === "n")?.label).toBe("New session");
    expect(km.handle("n", ctx)).toMatchObject({ kind: "run", command: "new" });
    expect(km.pendingPrefix).toEqual([]);
  });

  it("cancels on escape and unknown keys", () => {
    km.handle("ctrl+space", ctx);
    expect(km.handle("escape", ctx)).toMatchObject({ kind: "run", command: "keymap.cancel" });
    km.handle("ctrl+space", ctx);
    expect(km.handle("z", ctx)).toMatchObject({ kind: "run", command: "keymap.cancel" });
  });

  it("respects when and input focus", () => {
    expect(km.handle("j", ctx)).toMatchObject({ kind: "run", command: "down" });
    expect(km.handle("j", { ...ctx, inputFocused: true })).toEqual({ kind: "none" });
    // modifier chords still work in inputs, leader too
    expect(km.handle("cmd+k", { ...ctx, inputFocused: true })).toMatchObject({ kind: "run" });
    expect(km.handle("ctrl+space", { ...ctx, inputFocused: true }).kind).toBe("pending");
    km.reset();
    // in a terminal only cmd chords and the leader
    expect(km.handle("g", { ...ctx, terminalFocused: true })).toEqual({ kind: "none" });
    expect(km.handle("cmd+k", { ...ctx, terminalFocused: true })).toMatchObject({ kind: "run" });
  });

  it("evaluates widgetFocused in when clauses", () => {
    expect(evaluateWhen("!widgetFocused", ctx)).toBe(true);
    expect(evaluateWhen("!widgetFocused", { ...ctx, widgetFocused: true })).toBe(false);
  });

  it("handles multi-key plain sequences", () => {
    expect(km.handle("g", ctx).kind).toBe("pending");
    expect(km.handle("g", ctx)).toMatchObject({ kind: "run", command: "first" });
  });

  it("lists bindings for commands and formats keys", () => {
    expect(km.bindingsFor("new")).toEqual(["ctrl+space s n"]);
    expect(formatKeys("cmd+k", true)).toBe("⌘K");
    expect(formatKeys("ctrl+space s n", false)).toBe("Ctrl+Space S N");
  });
});

describe("evaluateWhen", () => {
  it("evaluates terms", () => {
    expect(evaluateWhen("focus:sidebar", ctx)).toBe(true);
    expect(evaluateWhen("focus:main|sidebar", ctx)).toBe(true);
    expect(evaluateWhen("!inputFocused, hasSelection", ctx)).toBe(true);
    expect(evaluateWhen("pending", ctx)).toBe(false);
    expect(evaluateWhen("mode:terminal", ctx)).toBe(false);
  });
});

describe("fuzzyScore", () => {
  it("prefers prefixes and contiguous matches", () => {
    expect(fuzzyScore("New session", "new")! > fuzzyScore("Rename session", "new")!).toBe(true);
    expect(fuzzyScore("Open diff", "xyz")).toBeNull();
  });
});

describe("workspace 1–9 by number", () => {
  // The default and vim bindings as each platform gets them, whatever platform runs the test.
  const bindingsOn = (mac: boolean) => [...defaultBindings, ...vimExtraBindings].filter((b) => b.command !== "workspace.go-nth").concat(workspaceDigitBindings(mac));
  const run = (mac: boolean, chord: string, over: Partial<CommandContext> = {}) => {
    const r = new Keymap(bindingsOn(mac), mac, "ctrl+space").handle(chord, { ...ctx, isMac: mac, ...over });
    return r.kind === "run" ? [r.command, r.arg] : r.kind;
  };

  it("is ⌃digit on macOS and alt+shift+digit on Windows and Linux, next to sessions and tabs", () => {
    expect(run(true, "ctrl+2")).toEqual(["workspace.go-nth", 2]);
    expect(run(true, "cmd+2")).toEqual(["session.select-nth", 2]);
    expect(run(true, "alt+2")).toEqual(["tab.go-nth", 2]);
    expect(run(false, "alt+shift+2")).toEqual(["workspace.go-nth", 2]);
    // Ctrl is mod there: Ctrl+digit stays "select session", Alt+digit "go to tab".
    expect(run(false, "ctrl+2")).toEqual(["session.select-nth", 2]);
    expect(run(false, "alt+2")).toEqual(["tab.go-nth", 2]);
    // Dialogs and focused widgets keep their own alt+digit keys.
    expect(run(false, "alt+shift+2", { dialogOpen: true })).toBe("none");
    expect(formatKeys(workspaceDigitKeys(3, false), false)).toBe("Alt+Shift+3");
    expect(formatKeys(workspaceDigitKeys(3, true), true)).toBe("⌃3");
  });

  it("switches workspace from a focused terminal on both platforms; a shell keeps its other ctrl keys", () => {
    const inTerminal = { terminalFocused: true, focus: "main" };
    expect(run(true, "ctrl+4", inTerminal)).toEqual(["workspace.go-nth", 4]);
    expect(run(false, "alt+shift+4", inTerminal)).toEqual(["workspace.go-nth", 4]);
    // Ctrl+K stays the shell's on macOS, as before.
    expect(run(true, "ctrl+k", inTerminal)).toBe("none");
  });

  it("collides with no other default binding", () => {
    for (const mac of [true, false]) {
      const chords = new Set(workspaceDigitBindings(mac).map((b) => normalizeChord(b.keys, mac, "ctrl+space")));
      const others = bindingsOn(mac).filter((b) => b.command !== "workspace.go-nth" && chords.has(b.keys.split(/\s+/).map((c) => normalizeChord(c, mac, "ctrl+space")).join(" ")));
      expect(others, mac ? "macOS" : "Windows / Linux").toEqual([]);
    }
  });

  it("matches alt+shift+digit by the physical key, whatever character the layout gives", () => {
    const chord = (key: string, code: string) => chordFromEvent(new KeyboardEvent("keydown", { key, code, altKey: true, shiftKey: true }), false);
    expect(chord("!", "Digit1")).toBe("alt+shift+1"); // US
    expect(chord("1", "Digit1")).toBe("alt+shift+1"); // AZERTY: shift gives the digit
    expect(chord("Dead", "Digit6")).toBe("alt+shift+6"); // a dead key on some layouts
    expect(chord("Unidentified", "Digit9")).toBe("alt+shift+9");
    // Only digits with a modifier: a dead key alone is still nothing.
    expect(chordFromEvent(new KeyboardEvent("keydown", { key: "Dead", code: "Digit6" }), false)).toBeNull();
    expect(chordFromEvent(new KeyboardEvent("keydown", { key: "Dead", code: "BracketLeft", altKey: true }), false)).toBeNull();
  });
});
