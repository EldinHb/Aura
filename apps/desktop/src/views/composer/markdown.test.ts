import { afterEach, describe, expect, it } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { composerExtensions, lineText } from "./extensions";
import { fromMarkdown, toMarkdown } from "./markdown";

let editor: Editor;
afterEach(() => editor?.destroy());
const make = () => (editor = new Editor({ extensions: composerExtensions(() => "") }));
/** The editor's text per block, as the user sees it. */
const texts = () => editor.state.doc.children.map((b) => b.textBetween(0, b.content.size, "\n", lineText));
const paragraphs = (...lines: string[]): JSONContent => ({ type: "doc", content: lines.map((text) => (text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" })) });

describe("composer markdown", () => {
  it("sends typed text as typed: paths, arrows, operators", () => {
    make().commands.setContent(paragraphs("src/foo_bar.ts:42 -> 2 * 3 * 4 < 5 && x > 1, use *args and **kwargs, 50% [x] #12"));
    expect(toMarkdown(editor)).toBe("src/foo_bar.ts:42 -> 2 * 3 * 4 < 5 && x > 1, use *args and **kwargs, 50% [x] #12");
  });

  it("escapes only what would read back as something else, and only in that block", () => {
    make().commands.setContent(paragraphs("*not em*", "foo_bar", "a \\* b, <b>tag</b> &amp; c"));
    const md = toMarkdown(editor);
    expect(md).toBe("\\*not em\\*\n\nfoo_bar\n\na \\\\* b, \\<b>tag\\</b> \\&amp; c");
    editor.commands.setContent(md, { contentType: "markdown" });
    expect(texts()).toEqual(["*not em*", "foo_bar", "a \\* b, <b>tag</b> &amp; c"]);
  });

  it("keeps formatting, links, bare addresses and code", () => {
    const md = "## Plan\n\n**bold** *em* ~~gone~~ `a_b*c` [docs](https://x.y/a_b) https://bare.url/x_y\n\n```sh\necho \\* *x*\n```";
    make().commands.setContent(md, { contentType: "markdown" });
    expect(toMarkdown(editor)).toBe(md);
  });

  it("keeps lists, task lists, quotes, tables and image references", () => {
    const md = "- one\n- two\n\n1. first\n2. second\n\n- [ ] todo\n- [x] done\n\n> quoted\n\n| a   | b   |\n| --- | --- |\n| 1   | 2   |\n\nsee ![shot](./a_b.png)";
    make().commands.setContent(md, { contentType: "markdown" });
    expect(editor.view.dom.querySelector(".composer-image-ref")?.textContent).toBe("![shot](./a_b.png)");
    const out = toMarkdown(editor);
    editor.commands.setContent(out, { contentType: "markdown" });
    expect(toMarkdown(editor)).toBe(out);
    expect(out).toContain("- [ ] todo\n- [x] done");
    expect(out).toContain("| 1   | 2   |");
    expect(out).toContain("see ![shot](./a_b.png)");
  });

  it("keeps HTML as the source it was written as", () => {
    const md = '<div class="x">hello</div>\n\n<script>const x = 1;</script>\n\n<!-- note -->\n\ntext with <b>inline</b> html and <span title="a &amp; b">x</span>';
    make().commands.setContent(md, { contentType: "markdown" });
    expect(texts()).toEqual(['<div class="x">hello</div>', "<script>const x = 1;</script>", "<!-- note -->", 'text with <b>inline</b> html and <span title="a &amp; b">x</span>']);
    expect(toMarkdown(editor)).toBe(md);
  });

  it("fences code with more backticks than the code holds", () => {
    const md = "````md\nan example:\n```js\nx()\n```\n````";
    make().commands.setContent(md, { contentType: "markdown" });
    expect(editor.state.doc.childCount).toBe(1);
    expect(toMarkdown(editor)).toBe(md);
    editor.commands.setContent({ type: "doc", content: [{ type: "codeBlock", content: [{ type: "text", text: "a ``` b ````` c" }] }] });
    expect(toMarkdown(editor)).toBe("``````\na ``` b ````` c\n``````");
  });

  it("writes link and image destinations and titles that read back", () => {
    const md = '[go](<https://example.com/a b>) [t](https://x.y "say \\"hi\\" \\\\ ok") [p](https://x.y/a_(b)_c) [u](<https://x.y/a)b>)\n\nsee ![my shot](<./my shots/a.png> "the \\"title\\"")';
    make().commands.setContent(md, { contentType: "markdown" });
    const links = () => editor.state.doc.firstChild!.content.content.map((n) => n.marks[0]?.attrs).filter(Boolean);
    expect(links().map((a) => a!.href)).toEqual(["https://example.com/a b", "https://x.y", "https://x.y/a_(b)_c", "https://x.y/a)b"]);
    expect(links()[1]!.title).toBe('say "hi" \\ ok');
    expect(editor.state.doc.child(1).child(1).attrs).toMatchObject({ src: "./my shots/a.png", title: 'the "title"' });
    expect(toMarkdown(editor)).toBe(md);
  });

  it("escapes text that would start a block, at the start of each line", () => {
    const md = "\\# literal\n\n\\- foo\n\n1\\. foo\n\n\\> not quoted\n\nfirst\n\\- not a list\n2020\\. was a year\n\\---";
    make().commands.setContent(md, { contentType: "markdown" });
    expect(texts()).toEqual(["# literal", "- foo", "1. foo", "> not quoted", "first\n- not a list\n2020. was a year\n---"]);
    expect(toMarkdown(editor)).toBe(md);
    // The same text, with Tiptap's escaping for the rest of a block that needs it.
    editor.commands.setContent(paragraphs("# *not em*"));
    expect(toMarkdown(editor)).toBe("\\# \\*not em\\*");
  });

  it("reads a newline in a paragraph as a line break, and writes one as a newline", () => {
    make().commands.setContent("one\ntwo **bold\nstill**\n\nnext", { contentType: "markdown" });
    const first = editor.state.doc.firstChild!;
    expect(first.content.content.map((n) => n.type.name)).toEqual(["text", "hardBreak", "text", "text", "hardBreak", "text"]);
    // Tiptap closes a mark before a line break and opens it again after.
    expect(toMarkdown(editor)).toBe("one\ntwo **bold**\n**still**\n\nnext");
  });

  it("reads and writes a line break in a table cell as <br>, and keeps <br> elsewhere as text", () => {
    make().commands.setContent("| a |\n| --- |\n| one<br>next |\n\nkeep <br> as text", { contentType: "markdown" });
    const cell = editor.state.doc.firstChild!.child(1).child(0).child(0);
    expect(cell.content.content.map((n) => n.type.name)).toEqual(["text", "hardBreak", "text"]);
    expect(texts()[1]).toBe("keep <br> as text");
    const md = toMarkdown(editor);
    expect(md).toContain("| one<br>next |");
    expect(md).toContain("keep <br> as text");
    // Typed: Shift+Enter in a cell, and back again after a round trip.
    editor.commands.setContent("| a_b |\n| --- |\n| one |", { contentType: "markdown" });
    let end = 0;
    editor.state.doc.descendants((n, pos) => { if (n.isText && n.text === "one") end = pos + 3; });
    editor.commands.setTextSelection(end);
    editor.commands.keyboardShortcut("Shift-Enter");
    editor.commands.insertContent("next");
    // One line of the table: a line break in the cell's paragraph, as it reads back, so the text needs no escaping.
    const typedCell = editor.state.doc.firstChild!.child(1).child(0);
    expect(typedCell.childCount).toBe(1);
    expect(typedCell.firstChild!.content.content.map((n) => n.type.name)).toEqual(["text", "hardBreak", "text"]);
    const typed = toMarkdown(editor);
    expect(typed).toContain("| one<br>next |");
    expect(typed).toContain("| a_b ");
    editor.commands.setContent(typed, { contentType: "markdown" });
    expect(editor.state.doc.firstChild!.child(1).child(0).textBetween(0, editor.state.doc.firstChild!.child(1).child(0).content.size, "\n", lineText)).toBe("one\nnext");
    expect(toMarkdown(editor)).toBe(typed);
  });

  it("is empty for an empty box, and keeps blank lines between paragraphs", () => {
    make();
    expect(toMarkdown(editor)).toBe("");
    editor.commands.setContent(paragraphs("a", "", "b"));
    expect(toMarkdown(editor)).toBe("a\n\n\n\nb");
    expect(editor.schema.nodeFromJSON(fromMarkdown(editor, "a\n\n\n\nb")).eq(editor.state.doc)).toBe(true);
  });
});

/**
 * `markdown.ts` patches Tiptap's markdown manager, which is not public API: the
 * packages are pinned, and this fails when an upgrade changes what is patched.
 */
describe("the Tiptap internals the composer patches", () => {
  type Proto = Record<string, unknown>;
  const proto = MarkdownManager.prototype as unknown as Proto;
  it.each(["parse", "parseHTMLToken", "htmlAsLiteralText", "encodeTextForMarkdown", "serialize"])("MarkdownManager.prototype.%s is a method", (name) => {
    expect(typeof proto[name], `@tiptap/markdown no longer has MarkdownManager.${name}; see composer/markdown.ts`).toBe("function");
  });

  it("calls them as the patches expect", () => {
    make();
    const manager = editor.markdown! as unknown as Proto;
    // htmlAsLiteralText(html, block) gives a paragraph for a block and a text node inline.
    const asText = manager.htmlAsLiteralText as (html: string, block: boolean) => JSONContent;
    expect(asText.call(manager, "<x>", true)).toEqual({ type: "paragraph", content: [{ type: "text", text: "<x>" }] });
    expect(asText.call(manager, "<x>", false)).toEqual({ type: "text", text: "<x>" });
    // parseHTMLToken is how HTML in markdown is parsed, inline and block.
    editor.commands.setContent("a <span>b</span>\n\n<div>c</div>", { contentType: "markdown" });
    expect(texts()).toEqual(["a <span>b</span>", "<div>c</div>"]);
    // encodeTextForMarkdown(text, node, parent) writes every text node.
    const calls: unknown[][] = [];
    const own = new MarkdownManager({ extensions: editor.extensionManager.baseExtensions });
    const encode = (own as unknown as Proto).encodeTextForMarkdown as (...args: unknown[]) => string;
    Object.assign(own, { encodeTextForMarkdown(...args: unknown[]) { calls.push(args); return encode.apply(own, args); } });
    own.serialize({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("x");
    expect(calls[0][1]).toMatchObject({ type: "text", text: "x" });
    expect(calls[0][2]).toMatchObject({ type: "paragraph" });
  });
});
