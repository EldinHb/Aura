import { describe, it, expect } from "vitest";
import { parseUnifiedDiff, pairHunk, filterWhitespace, countChanges, displayPath } from "./parse";

const sample = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 export {};
 // end
diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
`;

describe("parseUnifiedDiff", () => {
  it("parses files, hunks and line numbers", () => {
    const files = parseUnifiedDiff(sample);
    expect(files).toHaveLength(2);
    expect(displayPath(files[0])).toBe("src/a.ts");
    expect(files[0].hunks).toHaveLength(1);
    const lines = files[0].hunks[0].lines;
    expect(lines[0].kind).toBe("hunk");
    expect(lines[1]).toMatchObject({ kind: "ctx", oldNo: 1, newNo: 1 });
    expect(lines[2]).toMatchObject({ kind: "del", text: "const b = 2;", oldNo: 2, newNo: null });
    expect(lines[3]).toMatchObject({ kind: "add", text: "const b = 3;", oldNo: null, newNo: 2 });
    expect(lines[4]).toMatchObject({ kind: "add", newNo: 3 });
    expect(lines[5]).toMatchObject({ kind: "ctx", oldNo: 3, newNo: 4 });
    expect(files[1].isNew).toBe(true);
    expect(countChanges(files[1])).toEqual({ added: 2, deleted: 0 });
    expect(countChanges(files[0])).toEqual({ added: 2, deleted: 1 });
  });

  it("returns empty for empty input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});

describe("pairHunk", () => {
  it("pairs removed and added lines", () => {
    const [f] = parseUnifiedDiff(sample);
    const rows = pairHunk(f.hunks[0]);
    // ctx, (del,add), (null,add), ctx, ctx
    expect(rows).toHaveLength(5);
    expect(rows[0].left).toBe(rows[0].right);
    expect(rows[1].left?.kind).toBe("del");
    expect(rows[1].right?.kind).toBe("add");
    expect(rows[2].left).toBeNull();
    expect(rows[2].right?.text).toBe("const c = 4;");
  });

  it("flags whitespace-only changes", () => {
    const d = `--- a/x
+++ b/x
@@ -1,2 +1,2 @@
-foo(  a,b )
+foo(a, b)
-real
+change
`;
    const [f] = parseUnifiedDiff(d);
    const rows = pairHunk(f.hunks[0], true);
    expect(rows[0].wsOnly).toBe(true);
    expect(rows[1].wsOnly).toBe(false);
    const filtered = filterWhitespace(f.hunks[0]);
    expect(filtered.map((l) => l.kind)).toEqual(["hunk", "ctx", "del", "add"]);
  });
});
