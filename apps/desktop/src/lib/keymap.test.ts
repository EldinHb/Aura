import { describe, it, expect, beforeEach } from "vitest";
import { Keymap, normalizeChord, chordFromEvent, formatKeys, physicalKey } from "./keymap";
import type { CommandContext } from "./commands";
import { evaluateWhen, fuzzyScore } from "./commands";

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
