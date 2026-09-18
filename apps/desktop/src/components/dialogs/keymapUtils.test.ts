import { describe, it, expect } from "vitest";
import { findConflicts, isConflicting } from "./keymapUtils";

describe("findConflicts", () => {
  it("detects identical keys+when with different commands", () => {
    const bindings = [
      { keys: "mod+k", command: "palette" },
      { keys: "cmd+k", command: "other" },
      { keys: "j", command: "down", when: "!inputFocused" },
      { keys: "j", command: "down2", when: "focus:main" },
      { keys: "leader s n", command: "new" },
      { keys: "ctrl+space s n", command: "new" },
      { keys: "x", command: "" },
    ];
    const c = findConflicts(bindings, true, "ctrl+space");
    expect(c).toHaveLength(1);
    expect(c[0].keys).toBe("cmd+k");
    expect(c[0].commands).toEqual(["other", "palette"]);
    expect(isConflicting({ keys: "mod+k", command: "palette" }, c, true, "ctrl+space")).toBe(true);
    expect(isConflicting({ keys: "j", command: "down", when: "!inputFocused" }, c, true, "ctrl+space")).toBe(false);
  });
});
