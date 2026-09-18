import { describe, it, expect } from "vitest";
import { filterSlashCommands, mergeSlashCommands, slashQuery, mentionQuery } from "./slash";

describe("slash commands", () => {
  const entries = mergeSlashCommands("claude", [
    { name: "code-review", description: "Review a PR", source: "plugin" },
    { name: "model", description: "provider model", source: "cli" },
  ]);
  it("merges builtins without duplicates, provider wins", () => {
    expect(entries.filter((e) => e.name === "model")).toHaveLength(1);
    expect(entries.find((e) => e.name === "model")?.source).toBe("cli");
    expect(entries.some((e) => e.name === "compact")).toBe(true);
  });
  it("filters fuzzily and ranks name matches first", () => {
    const r = filterSlashCommands(entries, "mod");
    expect(r[0].name).toBe("model");
    expect(filterSlashCommands(entries, "zzz")).toEqual([]);
    expect(filterSlashCommands(entries, "").length).toBe(entries.length);
  });
  it("detects slash and mention triggers", () => {
    expect(slashQuery("/mo")).toBe("mo");
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/model x")).toBeNull();
    expect(slashQuery("hi /model")).toBeNull();
    expect(mentionQuery("see @src/ma", 10)).toEqual({ start: 4, query: "src/m" });
    expect(mentionQuery("see @src/ma", 11)).toEqual({ start: 4, query: "src/ma" });
    expect(mentionQuery("mail a@b", 8)).toBeNull();
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
  });
});
