import { getSchema } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { composerExtensions } from "./extensions";
import { docToMarkdown, markdownToDoc } from "./markdownDoc";

const schema = getSchema(composerExtensions(() => ""));
const load = (md: string) => schema.nodeFromJSON(markdownToDoc(md));
const roundTrip = (md: string) => docToMarkdown(load(md));

describe("markdown round trip", () => {
  it.each([
    ["plain prose with markdown characters", "2 * 3 * 4 = 24, snake_case_name, #hashtag, 50% off_ and a_b_c"],
    ["escapes and entities", "Not \\*italic\\*, a \\_b\\_, &amp; &copy; and \\# no heading"],
    ["lines typed one under the other", "first line\nsecond line\n\nafter a blank line\n\n\n\ntwo more"],
    ["leading and trailing blank lines", "\n\nhello\n\n"],
    ["indented text", "  two spaces\n   three"],
    ["headings", "# One\n## Two **bold**\n###### Six"],
    ["emphasis in both styles", "**bold** __bold__ *em* _em_ ~~gone~~ ***both***"],
    ["inline code", "use `a_b` and ``a ` b`` and `` `x` ``"],
    ["links", "[docs](https://example.com/docs) and [t](https://e.com \"Title\") and <https://auto.link> and https://bare.example"],
    ["fenced code", "```ts title=x\nconst a = 1;\n\n  // *not* markdown\n```\n\n~~~~\n```\nnested\n```\n~~~~"],
    ["empty code block", "```\n```"],
    ["bullet lists", "- a\n- b\n  - nested\n    - deeper\n- c"],
    ["other bullets", "* star\n* again\n\n+ plus"],
    ["loose list", "- a\n\n- b"],
    ["ordered lists", "1. one\n2. two\n\n3) three\n4) four"],
    ["task lists", "- [ ] todo\n- [x] done"],
    ["list items with more lines", "- first\n  continued\n\n  second paragraph\n- next"],
    ["code in a list", "1. step\n   ```sh\n   pnpm test\n   ```\n2. done"],
    ["blockquotes", "> quoted **text**\n> more\n>\n> - list in quote"],
    ["horizontal rules", "a\n\n---\n\n***\n___"],
    ["tables stay as written", "| a | b |\n|:--|--:|\n| *1* | `2` |"],
    ["HTML stays as written", "<details>\n<summary>x</summary>\n\nbody\n</details>"],
    ["images and references stay as written", "![shot](./a.png \"t\") and [ref][r]\n\n[r]: https://example.com"],
    ["setext headings stay as written", "Title\n=====\n\nSub\n---"],
    ["indented code stays as written", "para\n\n    indented code\n    more"],
    ["hard breaks", "two spaces  \nbackslash\\\nend"],
    ["bold across lines", "**bold\nacross** lines"],
    ["unicode and emoji", "Grüße 👋 — “quotes” ‘single’ …"],
    ["a slash command", "/review the last commit"],
    ["trailing spaces", "/review \n# Heading  \ntext\t"],
    ["mentions", "look at @src/views/Composer.tsx and @README.md"],
  ])("keeps %s", (_, md) => {
    expect(roundTrip(md)).toBe(md);
  });

  it("normalises Windows line endings only", () => {
    expect(roundTrip("a\r\nb")).toBe("a\nb");
  });

  it("keeps a list that mixes tasks and items as written", () => {
    expect(load("- a\n- [x] b").firstChild!.type.name).toBe("paragraph");
    expect(roundTrip("- a\n- [x] b")).toBe("- a\n- [x] b");
  });

  it("formats what it understands", () => {
    const doc = load("# Title\n\n- **a**\n- b\n\n```js\nx\n```\n\n> q");
    expect(doc.child(0).type.name).toBe("heading");
    expect(doc.child(2).type.name).toBe("bulletList");
    expect(doc.child(2).firstChild!.firstChild!.firstChild!.marks.map((m) => m.type.name)).toEqual(["bold"]);
    expect(doc.child(4).type.name).toBe("codeBlock");
    expect(doc.child(4).attrs.language).toBe("js");
    expect(doc.child(6).type.name).toBe("blockquote");
  });
});

describe("markdown from the rich editor", () => {
  const p = (...content: object[]) => ({ type: "paragraph", content });
  const t = (text: string, ...marks: string[]) => ({ type: "text", text, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });
  const md = (...content: object[]) => docToMarkdown(schema.nodeFromJSON({ type: "doc", content }));

  it("never escapes typed text", () => {
    expect(md(p(t("2 * 3 _ 4 # [x] `tick` <b>")))).toBe("2 * 3 _ 4 # [x] `tick` <b>");
  });

  it("keeps delimiters next to the words they format", () => {
    expect(md(p(t("say "), t("bold ", "bold"), t("then "), t(" em", "italic")))).toBe("say **bold** then  *em*");
  });

  it("nests and closes marks in order", () => {
    const out = md(p(t("a", "bold"), t("b", "bold", "italic"), t("c", "italic")));
    const back = load(out).firstChild!;
    expect(back.childCount).toBe(3);
    expect([0, 1, 2].map((i) => back.child(i).marks.map((m) => m.type.name).join("+"))).toEqual(["bold", "bold+italic", "italic"]);
  });

  it("fences inline code that contains backticks", () => {
    expect(md(p(t("a`b", "code")), p(t("`x", "code")))).toBe("``a`b``\n`` `x ``");
  });

  it("lengthens a code fence the code contains", () => {
    expect(md({ type: "codeBlock", content: [t("```\ninner\n```")] })).toBe("````\n```\ninner\n```\n````");
  });

  it("puts a blank line where markdown would otherwise join or change blocks", () => {
    const list = { type: "bulletList", content: [{ type: "listItem", content: [p(t("item"))] }] };
    expect(md(list, p(t("after")))).toBe("- item\n\nafter");
    expect(md(p(t("Title")), { type: "horizontalRule" })).toBe("Title\n\n---");
    expect(md(p(t("text")), { type: "orderedList", attrs: { start: 3 }, content: [{ type: "listItem", content: [p(t("x"))] }] })).toBe("text\n\n3. x");
  });

  it("writes links with destinations that need brackets", () => {
    expect(md(p({ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "a b.md" } }] }))).toBe("[x](<a b.md>)");
  });
});
