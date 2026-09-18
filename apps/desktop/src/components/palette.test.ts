import { describe, it, expect } from "vitest";
import { buildSections, flattenSections, filterItems, pushRecent } from "./palette";

const cmds = [
  { id: "session.new", title: "New session…", group: "Session" },
  { id: "session.rename", title: "Rename session…", group: "Session" },
  { id: "git.diff", title: "Diff", group: "Git", keywords: ["changes"] },
  { id: "palette.open", title: "Command palette", group: "Aura" },
];

describe("buildSections", () => {
  it("groups alphabetically with recent first when the query is empty", () => {
    const s = buildSections(cmds, "", ["git.diff", "missing"]);
    expect(s[0].label).toBe("Recent");
    expect(s[0].items.map((c) => c.id)).toEqual(["git.diff"]);
    expect(s.slice(1).map((x) => x.label)).toEqual(["Aura", "Git", "Session"]);
    expect(s[3].items.map((c) => c.title)).toEqual(["New session…", "Rename session…"]);
  });
  it("fuzzy filters and orders groups by best score", () => {
    const s = buildSections(cmds, "new");
    expect(s[0].label).toBe("Session");
    expect(s[0].items[0].id).toBe("session.new");
    expect(buildSections(cmds, "zzz")).toEqual([]);
  });
  it("matches keywords", () => {
    const s = buildSections(cmds, "changes");
    expect(s[0].items[0].id).toBe("git.diff");
  });
});

describe("flattenSections", () => {
  it("marks the first item of each section", () => {
    const flat = flattenSections(buildSections(cmds, "", []));
    expect(flat.filter((f) => f.first).length).toBe(3);
    expect(flat.length).toBe(4);
  });
});

describe("filterItems / pushRecent", () => {
  it("filters generically", () => {
    expect(filterItems(["alpha", "beta"], "al", (x) => x)).toEqual(["alpha"]);
    expect(filterItems(["alpha", "beta"], "", (x) => x)).toHaveLength(2);
  });
  it("keeps recents unique and bounded", () => {
    let r: string[] = [];
    for (let i = 0; i < 12; i++) r = pushRecent(`c${i}`, r);
    r = pushRecent("c11", r);
    expect(r.length).toBe(8);
    expect(r[0]).toBe("c11");
    expect(new Set(r).size).toBe(8);
  });
});
