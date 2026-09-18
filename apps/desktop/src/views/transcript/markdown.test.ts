import { describe, it, expect } from "vitest";
import { parseMarkdown, parseInline } from "./markdown";

describe("parseInline", () => {
  it("parses code, bold, em and links", () => {
    expect(parseInline("a `b` **c** *d* [e](http://x) f")).toEqual([
      { t: "text", v: "a " },
      { t: "code", v: "b" },
      { t: "text", v: " " },
      { t: "bold", v: [{ t: "text", v: "c" }] },
      { t: "text", v: " " },
      { t: "em", v: [{ t: "text", v: "d" }] },
      { t: "text", v: " " },
      { t: "link", text: "e", url: "http://x" },
      { t: "text", v: " f" },
    ]);
  });
  it("leaves unbalanced markers as text", () => {
    expect(parseInline("2 * 3 = 6 and a_b")).toEqual([{ t: "text", v: "2 * 3 = 6 and a_b" }]);
    expect(parseInline("`open")).toEqual([{ t: "text", v: "`open" }]);
  });
  it("never produces html", () => {
    const out = parseInline("<script>alert(1)</script>");
    expect(out).toEqual([{ t: "text", v: "<script>alert(1)</script>" }]);
  });
});

describe("parseMarkdown", () => {
  it("parses fences, headings, lists and paragraphs", () => {
    const blocks = parseMarkdown("# Title\n\nHello **world**\n\n```ts\nconst a = 1;\n```\n- one\n- two\n  more\n1. x\n2) y\n\n---\ntail");
    expect(blocks).toEqual([
      { t: "heading", level: 1, v: [{ t: "text", v: "Title" }] },
      { t: "para", v: [{ t: "text", v: "Hello " }, { t: "bold", v: [{ t: "text", v: "world" }] }] },
      { t: "code", lang: "ts", v: "const a = 1;" },
      { t: "list", ordered: false, items: [[{ t: "text", v: "one" }], [{ t: "text", v: "two\nmore" }]] },
      { t: "list", ordered: true, items: [[{ t: "text", v: "x" }], [{ t: "text", v: "y" }]] },
      { t: "hr" },
      { t: "para", v: [{ t: "text", v: "tail" }] },
    ]);
  });
  it("handles an unterminated fence", () => {
    expect(parseMarkdown("```\nabc")).toEqual([{ t: "code", lang: "", v: "abc" }]);
  });
  it("keeps line breaks inside a paragraph", () => {
    expect(parseMarkdown("a\nb")).toEqual([{ t: "para", v: [{ t: "text", v: "a\nb" }] }]);
  });
});
