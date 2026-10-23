/**
 * The rich composer's document as markdown, through Tiptap's own markdown
 * extension (`@tiptap/markdown`).
 *
 * Tiptap escapes every `*`, `_`, `[`, `]`, `~` and `` ` `` in text and writes
 * `<`, `>` and `&` as entities, so `src/foo_bar.ts -> 2 * 3` would reach the
 * agent as `src/foo\_bar.ts -&gt; 2 \* 3`. Text goes out as typed instead.
 * Each block takes the first of these that reads back as what the box shows:
 * the text as it is; with what markdown always reads as something else
 * escaped (a backslash before punctuation, an entity, an autolink); Tiptap's
 * escaping. A line that would start a block (`# `, `- `, `1. `, `> `, a fence)
 * is escaped in all three.
 *
 * HTML is not formatting in a message: it stays the source it was written as.
 */
import type { Editor, JSONContent } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import type { Node as PMNode } from "@tiptap/pm/model";

type HtmlToken = { text?: string; raw?: string; block?: boolean };
type Internals = {
  parse(markdown: string): JSONContent;
  parseHTMLToken(token: HtmlToken): JSONContent | null;
  htmlAsLiteralText(html: string, block: boolean): JSONContent | null;
  encodeTextForMarkdown(text: string, node: JSONContent, parent?: JSONContent): string;
};
// Tiptap parses HTML into the schema, keeping its text only (`<div>x</div>` is `x`, a `<script>` or a comment is
// nothing). Every manager, the editor's own included, keeps it as written.
(MarkdownManager.prototype as unknown as Internals).parseHTMLToken = function (this: Internals, token: HtmlToken) {
  const html = token.text || token.raw || "";
  if (!html.trim()) return null;
  // A `<br>` is a line break in a table cell (where Tiptap writes one so), and text elsewhere (see `lineBreaks`).
  if (!token.block && BR.test(html)) return { type: "hardBreak", [BR_TAG]: html };
  return this.htmlAsLiteralText(html, !!token.block);
};
const BR = /^<br\s*\/?>$/i;
const BR_TAG = "auraBr";

/**
 * A newline in the text of a paragraph (a soft line break in the markdown) as a line break node, as Shift+Enter
 * makes; in a table cell, a `<br>` too.
 */
function lineBreaks(node: JSONContent, inCell = false): JSONContent {
  if (!node.content || node.type === "codeBlock") return node;
  const cell = inCell || node.type === "tableCell" || node.type === "tableHeader";
  const content = node.content.flatMap((child): JSONContent[] => {
    const { [BR_TAG]: br, ...text } = child as JSONContent & { [BR_TAG]?: string };
    if (br !== undefined) return [cell ? text : { type: "text", text: br }];
    if (child.type !== "text") return [lineBreaks(child, cell)];
    if (!text.text?.includes("\n")) return [text];
    return text.text.split("\n").flatMap((part, i) => [...(i ? [{ type: "hardBreak" }] : []), ...(part ? [{ ...text, text: part }] : [])]);
  });
  return { ...node, content };
}
// A newline left in a paragraph's text would not survive the browser: ProseMirror reads typed text back from the
// page with newlines as spaces.
const parseMarkdown = (MarkdownManager.prototype as unknown as Internals).parse;
(MarkdownManager.prototype as unknown as Internals).parse = function (this: Internals, markdown: string) {
  return lineBreaks(parseMarkdown.call(this, markdown));
};

/** How a text node is written: as it is, with the minimal escapes, or with Tiptap's. */
type Level = 0 | 1 | 2;
type Serializer = { manager: MarkdownManager; level: (node: JSONContent) => Level };

const serializers = new WeakMap<Editor, Serializer>();

/** Escapes what markdown always reads as something else: a backslash before punctuation, an entity, an autolink or tag. */
const minimal = (text: string) =>
  text
    .replace(/\\(?=[!-/:-@[-`{-~])/g, "\\\\")
    .replace(/&(?=#?[a-zA-Z0-9]+;)/g, "\\&")
    .replace(/<(?=[a-zA-Z/!?])/g, "\\<");

/** A line that would start a block: a heading, list item, quote, fence, rule or setext underline. */
const blockStart = /^( {0,3})(#{1,6}(?=[ \t]|$)|[-+*](?=[ \t]|$)|\d{1,9}(?=[.)](?:[ \t]|$))|>|`{3,}|~{3,}|([-*_])(?:[ \t]*\3){2,}[ \t]*$|[-=]+[ \t]*$)/;
function escapeBlockStart(line: string): string {
  const m = blockStart.exec(line);
  if (!m) return line;
  const at = m[1].length + (/^\d/.test(m[2]) ? m[2].length : 0);
  return `${line.slice(0, at)}\\${line.slice(at)}`;
}

/** Escapes the line starts in `text`: each line after a newline, and the first when the node starts a line of its paragraph. */
function escapeLineStarts(text: string, node: JSONContent, parent?: JSONContent): string {
  if (parent?.type !== "paragraph") return text;
  const siblings = parent.content ?? [];
  const i = siblings.indexOf(node);
  const startsLine = i === 0 || siblings[i - 1]?.type === "hardBreak";
  return text
    .split("\n")
    .map((line, n) => (n > 0 || startsLine ? escapeBlockStart(line) : line))
    .join("\n");
}

function serializer(editor: Editor): Serializer {
  let s = serializers.get(editor);
  if (!s) {
    const manager = new MarkdownManager({ extensions: editor.extensionManager.baseExtensions });
    const own: Serializer = { manager, level: () => 0 };
    const tiptap = (manager as unknown as Internals).encodeTextForMarkdown;
    Object.assign(manager, {
      encodeTextForMarkdown(this: MarkdownManager, text: string, node: JSONContent, parent?: JSONContent) {
        if (parent?.type === "codeBlock" || node.marks?.some((m) => m.type === "code")) return text;
        const level = own.level(node);
        const out = level === 0 ? text : level === 1 ? minimal(text) : tiptap.call(this, text, node, parent);
        return escapeLineStarts(out, node, parent);
      },
    });
    s = own;
    serializers.set(editor, s);
  }
  return s;
}

/** Without the blank lines Tiptap leaves after the last block. */
const trimEnd = (markdown: string) => markdown.replace(/\n+$/, "");

function textNodes(node: JSONContent, into: JSONContent[] = []): JSONContent[] {
  if (node.type === "text") into.push(node);
  for (const child of node.content ?? []) textNodes(child, into);
  return into;
}

/** `doc` (the editor's own by default) as markdown. */
export function toMarkdown(editor: Editor, doc: PMNode = editor.state.doc): string {
  if (doc.childCount === 1 && doc.firstChild!.type.name === "paragraph" && doc.firstChild!.content.size === 0) return "";
  const json = doc.toJSON() as JSONContent;
  const readsBack = (markdown: string, expected: PMNode) => editor.schema.nodeFromJSON(fromMarkdown(editor, markdown)).eq(expected);
  const s = serializer(editor);
  const levels = new Map<JSONContent, Level>();
  s.level = (node) => levels.get(node) ?? 0;
  const serialize = (content: JSONContent) => trimEnd(s.manager.serialize(content));
  try {
    const plain = serialize(json);
    if (readsBack(plain, doc)) return plain;
    for (const block of json.content ?? []) {
      const alone: JSONContent = { type: "doc", content: [block] };
      const expected = editor.schema.nodeFromJSON(alone);
      const texts = textNodes(block);
      for (const level of [1, 2] as const) {
        for (const t of texts) levels.set(t, level);
        if (readsBack(serialize(alone), expected)) break;
      }
    }
    const mixed = serialize(json);
    if (readsBack(mixed, doc)) return mixed;
    for (const t of textNodes(json)) levels.set(t, 2);
    return serialize(json);
  } finally {
    s.level = () => 0;
  }
}

/** Markdown as the editor's content. */
export function fromMarkdown(editor: Editor, markdown: string): JSONContent {
  return editor.markdown!.parse(markdown);
}

/** A link or image destination: in `<...>` when it has spaces, angle brackets or unbalanced parentheses. */
export function destination(url: string): string {
  let depth = 0;
  for (const ch of url) {
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) break;
  }
  if (url === "" || depth !== 0 || /[\s<>]/.test(url)) return `<${url.replace(/[\\<>]/g, "\\$&")}>`;
  return url.replace(/\\(?=[!-/:-@[-`{-~])/g, "\\\\");
}

/** A link or image title, with its quotes. */
export const title = (text: string) => `"${text.replace(/[\\"]/g, "\\$&")}"`;
