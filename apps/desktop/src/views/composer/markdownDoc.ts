/**
 * Markdown to and from the rich composer's document.
 *
 * What is sent is the markdown, so the round trip must not change what the
 * user wrote: text is kept as its source (escapes, entities and all) and is
 * never escaped on the way out, and anything the editor has no node for
 * (tables, HTML, images, reference links, setext headings, indented code)
 * stays as the lines it was written as. Each source line is a paragraph of
 * its own and a blank line an empty paragraph, so lines typed one under the
 * other come back one under the other.
 */
import type { JSONContent } from "@tiptap/core";
import type { Mark, Node as PMNode } from "@tiptap/pm/model";
import type { Blockquote, Heading, List, ListItem, Nodes, Paragraph, Parent, PhrasingContent, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTaskListItemFromMarkdown } from "mdast-util-gfm-task-list-item";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";

type JMark = { type: string; attrs?: Record<string, unknown> };
/** Removes the prefixes of the containers a line sits in (`> `, list indentation). */
type Strip = (line: string) => string;
type Ctx = { src: string; lineStarts: number[]; strip: Strip; top: boolean };

const para = (content: JSONContent[] = []): JSONContent => (content.length ? { type: "paragraph", content } : { type: "paragraph" });
const leadingSpaces = (s: string) => /^[ \t]*/.exec(s)![0].length;

export function markdownToDoc(markdown: string): JSONContent {
  const src = markdown.replace(/\r\n?/g, "\n");
  const tree = fromMarkdown(src, {
    extensions: [gfmStrikethrough({ singleTilde: false }), gfmTaskListItem()],
    mdastExtensions: [gfmStrikethroughFromMarkdown(), gfmTaskListItemFromMarkdown()],
  });
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStarts.push(i + 1);
  const ctx: Ctx = { src, lineStarts, strip: (l) => l, top: true };
  const content = blocks(tree.children, ctx, 1, lineStarts.length);
  return { type: "doc", content: content.length ? content : [para()] };
}

/** Blocks with the blank lines around them, between source lines `first` and `last`. */
function blocks(children: RootContent[], ctx: Ctx, first: number, last: number): JSONContent[] {
  const out: JSONContent[] = [];
  let line = first;
  for (const child of children) {
    const pos = child.position!;
    for (let i = line; i < pos.start.line; i++) out.push(para());
    out.push(...block(child, ctx));
    line = pos.end.line + 1;
  }
  for (let i = line; i <= last; i++) out.push(para());
  return out;
}

function raw(node: Nodes, ctx: Ctx): string {
  return ctx.src.slice(node.position!.start.offset, node.position!.end.offset);
}

/** A block kept as the lines it was written as. */
function rawLines(node: Nodes, ctx: Ctx): JSONContent[] {
  const lines = raw(node, ctx).split("\n");
  const first = ctx.top ? indentBefore(node, ctx) : "";
  return lines.map((l, i) => para(textNodes(i === 0 ? first + l : ctx.strip(l), [])));
}

/** Leading spaces of a top-level block's first line, which the parser leaves out of the block. */
function indentBefore(node: Nodes, ctx: Ctx): string {
  const start = node.position!.start;
  const before = ctx.src.slice(ctx.lineStarts[start.line - 1], start.offset);
  return /^[ \t]*$/.test(before) ? before : "";
}

function textNodes(text: string, marks: JMark[]): JSONContent[] {
  if (!text) return [];
  return [marks.length ? { type: "text", text, marks } : { type: "text", text }];
}

function block(node: RootContent, ctx: Ctx): JSONContent[] {
  const source = raw(node, ctx);
  switch (node.type) {
    case "paragraph":
      return paragraph(node, ctx, ctx.top ? indentBefore(node, ctx) : "");
    case "heading": {
      // ATX headings only; setext ones and closing #s stay as written.
      if (source.includes("\n") || !/^#{1,6}(\s|$)/.test(source) || /\s#+\s*$/.test(source)) return rawLines(node, ctx);
      const inline = paragraph(node, ctx, "");
      if (inline.length !== 1) return rawLines(node, ctx);
      return [{ type: "heading", attrs: { level: node.depth }, content: inline[0].content }];
    }
    case "code": {
      const fence = /^(`{3,}|~{3,})/.exec(source);
      if (!fence) return rawLines(node, ctx);
      const attrs = { language: node.lang ?? null, marker: fence[1], meta: node.meta ?? null };
      return [{ type: "codeBlock", attrs, ...(node.value ? { content: [{ type: "text", text: node.value }] } : {}) }];
    }
    case "blockquote":
      return quote(node, ctx);
    case "list":
      return list(node, ctx) ?? rawLines(node, ctx);
    case "thematicBreak":
      return [{ type: "horizontalRule", attrs: { marker: source.trim() } }];
    default:
      return rawLines(node, ctx);
  }
}

function quote(node: Blockquote, ctx: Ctx): JSONContent[] {
  if (node.children.length === 0) return rawLines(node, ctx);
  const inner: Ctx = { ...ctx, top: false, strip: (l) => ctx.strip(l).replace(/^ {0,3}> ?/, "") };
  const { start, end } = node.position!;
  return [{ type: "blockquote", content: blocks(node.children, inner, start.line, end.line) }];
}

function list(node: List, ctx: Ctx): JSONContent[] | null {
  const items = node.children;
  const tasks = items.filter((i) => typeof i.checked === "boolean").length;
  if (items.length === 0 || (tasks > 0 && tasks < items.length)) return null;
  if (items.some((i) => i.children[0]?.type !== "paragraph")) return null;
  const first = /^\s*(?:\d+([.)])|([-*+]))/.exec(raw(items[0], ctx));
  const loose = items.some((item, i) => i > 0 && item.position!.start.line > items[i - 1].position!.end.line + 1);
  const content: JSONContent[] = [];
  for (const item of items) {
    const body = listItem(item, ctx);
    if (!body) return null;
    content.push(tasks ? { type: "taskItem", attrs: { checked: item.checked }, content: body } : { type: "listItem", content: body });
  }
  if (tasks) return [{ type: "taskList", attrs: { marker: first?.[2] ?? "-", loose }, content }];
  if (node.ordered) return [{ type: "orderedList", attrs: { start: node.start ?? 1, marker: first?.[1] ?? ".", loose }, content }];
  return [{ type: "bulletList", attrs: { marker: first?.[2] ?? "-", loose }, content }];
}

function listItem(item: ListItem, ctx: Ctx): JSONContent[] | null {
  const { start, end } = item.position!;
  const firstChild = item.children[0].position!.start;
  // Where the item's content starts, measured on the line with its prefixes removed.
  const line = ctx.src.slice(ctx.lineStarts[start.line - 1], ctx.lineStarts[start.line] ?? ctx.src.length).replace(/\n$/, "");
  const stripped = ctx.strip(line);
  const width = stripped.length - (line.length - (firstChild.column - 1));
  if (width < 0) return null;
  const inner: Ctx = { ...ctx, top: false, strip: (l) => { const s = ctx.strip(l); return s.slice(Math.min(width, leadingSpaces(s))); } };
  const body = blocks(item.children, inner, start.line, end.line);
  return body[0]?.type === "paragraph" ? body : null;
}

type Piece = { text: string; marks: JMark[] } | { br: true; marks: JMark[] };

/** A paragraph's lines: one paragraph per line, unless a mark runs across lines. */
function paragraph(node: Paragraph | Heading, ctx: Ctx, indent: string): JSONContent[] {
  const pieces: Piece[] = indent ? [{ text: indent, marks: [] }] : [];
  for (const child of node.children) inline(child, [], ctx, pieces);
  // Spaces at the end are the block's but not its text's; the user typed them.
  const last = node.children.at(-1)?.position?.end.offset ?? node.position!.start.offset;
  const tail = ctx.src.slice(last, node.position!.end.offset);
  if (/^[ \t]+$/.test(tail)) pieces.push({ text: tail, marks: [] });
  const lines: JSONContent[][] = [[]];
  let spans = false;
  for (const p of pieces) {
    if ("br" in p) {
      if (p.marks.length) spans = true;
      lines.push([]);
    } else lines[lines.length - 1].push(...textNodes(p.text, p.marks));
  }
  if (!spans) return lines.map((l) => para(l));
  const content: JSONContent[] = [];
  for (const p of pieces) {
    if ("br" in p) content.push(p.marks.length ? { type: "hardBreak", marks: p.marks } : { type: "hardBreak" });
    else content.push(...textNodes(p.text, p.marks));
  }
  return [para(content)];
}

/** Source text split into lines, container prefixes taken off the later ones. */
function pushText(text: string, marks: JMark[], ctx: Ctx, out: Piece[]) {
  text.split("\n").forEach((line, i) => {
    if (i > 0) out.push({ br: true, marks });
    out.push({ text: i > 0 ? ctx.strip(line) : line, marks });
  });
}

function inline(node: PhrasingContent, marks: JMark[], ctx: Ctx, out: Piece[]) {
  if (!node.position) {
    if ("value" in node) pushText(node.value, marks, ctx, out);
    return;
  }
  const source = raw(node, ctx);
  const nested = (mark: JMark) => {
    for (const child of (node as Parent).children as PhrasingContent[]) inline(child, [...marks, mark], ctx, out);
  };
  switch (node.type) {
    case "text":
      return pushText(source, marks, ctx, out);
    case "strong":
      return nested({ type: "bold", attrs: { marker: source.slice(0, 2) } });
    case "emphasis":
      return nested({ type: "italic", attrs: { marker: source[0] } });
    case "delete":
      return nested({ type: "strike" });
    case "inlineCode": {
      // The editor's code takes no other marks, and has no line breaks.
      if (marks.length || source.includes("\n")) return pushText(source, marks, ctx, out);
      const fence = /^`+/.exec(source)![0].length;
      return out.push({ text: source.slice(fence, -fence), marks: [{ type: "code" }] });
    }
    case "link":
      if (!source.startsWith("[") || marks.some((m) => m.type === "link")) return pushText(source, marks, ctx, out);
      return nested({ type: "link", attrs: { href: node.url, title: node.title ?? null } });
    case "break":
      // `  ` or `\` before the line break stays at the end of the line.
      out.push({ text: source.replace(/\n[\s\S]*$/, ""), marks });
      return out.push({ br: true, marks });
    default:
      return pushText(source, marks, ctx, out);
  }
}

// ---------------------------------------------------------------- serialise

const MARK_ORDER = ["link", "bold", "italic", "strike", "code"];
const byOrder = (a: Mark, b: Mark) => MARK_ORDER.indexOf(a.type.name) - MARK_ORDER.indexOf(b.type.name);

export function docToMarkdown(doc: PMNode): string {
  return serializeBlocks(children(doc)).join("\n");
}

function children(node: PMNode): PMNode[] {
  const out: PMNode[] = [];
  node.forEach((c) => out.push(c));
  return out;
}

const isText = (n: PMNode) => n.type.name === "paragraph" && n.content.size > 0;
const isList = (n: PMNode) => ["bulletList", "orderedList", "taskList"].includes(n.type.name);

/** Whether `next` would join `prev` (or turn it into something else) without a blank line. */
function needsBlank(prev: PMNode, next: PMNode): boolean {
  if ((isList(prev) || prev.type.name === "blockquote") && (isText(next) || (isList(next) && next.type.name !== prev.type.name))) return true;
  if (!isText(prev)) return false;
  if (next.type.name === "horizontalRule") return /^\s*-/.test(String(next.attrs.marker ?? "---"));
  return next.type.name === "orderedList" && Number(next.attrs.start ?? 1) !== 1;
}

function serializeBlocks(nodes: PMNode[]): string[] {
  const out: string[] = [];
  nodes.forEach((node, i) => {
    if (i > 0 && needsBlank(nodes[i - 1], node)) out.push("");
    out.push(...serializeBlock(node));
  });
  return out;
}

function serializeBlock(node: PMNode): string[] {
  switch (node.type.name) {
    case "paragraph":
      return inlineMarkdown(node).split("\n");
    case "heading":
      return [`${"#".repeat(Number(node.attrs.level) || 1)} ${inlineMarkdown(node).replace(/\n/g, " ")}`];
    case "codeBlock": {
      const code = node.textContent;
      const info = [node.attrs.language, node.attrs.meta].filter(Boolean).join(" ");
      return [fenceFor(code, node.attrs.marker as string | null) + info, ...(code ? code.split("\n") : []), fenceFor(code, node.attrs.marker as string | null)];
    }
    case "blockquote":
      return serializeBlocks(children(node)).map((l) => (l ? `> ${l}` : ">"));
    case "bulletList":
    case "orderedList":
    case "taskList":
      return serializeList(node);
    case "horizontalRule":
      return [String(node.attrs.marker ?? "---")];
    default:
      return node.textContent.split("\n");
  }
}

/** The fence a code block was written with, made longer if its code contains it. */
function fenceFor(code: string, marker: string | null): string {
  const char = marker?.[0] === "~" ? "~" : "`";
  const runs = code.match(new RegExp(`^ {0,3}${char === "`" ? "`" : "~"}{3,}`, "gm")) ?? [];
  const longest = Math.max(0, ...runs.map((r) => r.trim().length));
  const length = Math.max(marker?.length ?? 3, 3, longest + 1);
  return char.repeat(length);
}

function serializeList(node: PMNode): string[] {
  const out: string[] = [];
  const kind = node.type.name;
  const start = Number(node.attrs.start ?? 1);
  children(node).forEach((item, i) => {
    if (i > 0 && node.attrs.loose) out.push("");
    let marker = kind === "orderedList" ? `${start + i}${node.attrs.marker === ")" ? ")" : "."}` : String(node.attrs.marker ?? "-");
    const indent = " ".repeat(marker.length + 1);
    if (kind === "taskList") marker += item.attrs.checked ? " [x]" : " [ ]";
    const lines = serializeBlocks(children(item));
    out.push(lines[0] ? `${marker} ${lines[0]}` : marker);
    for (const line of lines.slice(1)) out.push(line ? indent + line : "");
  });
  return out;
}

const DELIMS: Record<string, (m: Mark) => string> = {
  bold: (m) => (m.attrs.marker === "__" ? "__" : "**"),
  italic: (m) => (m.attrs.marker === "_" ? "_" : "*"),
  strike: () => "~~",
};

/** A textblock's text with its marks as markdown; the text itself is never escaped. */
function inlineMarkdown(node: PMNode): string {
  let out = "";
  let open: Mark[] = [];
  const close = (mark: Mark) => {
    if (mark.type.name === "link") {
      const href = String(mark.attrs.href ?? "");
      const dest = /[\s()<>]/.test(href) ? `<${href}>` : href;
      const title = mark.attrs.title ? ` "${String(mark.attrs.title).replace(/"/g, '\\"')}"` : "";
      out += `](${dest}${title})`;
      return;
    }
    const delim = DELIMS[mark.type.name]?.(mark);
    // Closing delimiters go before trailing spaces, which they cannot follow.
    if (delim) out = out.replace(/(\s*)$/, `${delim}$1`);
  };
  const children: { text: string; marks: readonly Mark[] }[] = [];
  node.forEach((child) => {
    if (child.isText) children.push({ text: child.text ?? "", marks: child.marks });
    else if (child.type.name === "hardBreak") children.push({ text: "\n", marks: child.marks });
  });
  for (const child of [...children, { text: "", marks: [] as readonly Mark[] }]) {
    const marks = [...child.marks].sort(byOrder);
    let keep = 0;
    while (keep < open.length && keep < marks.length && open[keep].eq(marks[keep])) keep++;
    for (let j = open.length - 1; j >= keep; j--) close(open[j]);
    let text = child.text;
    const opening = marks.slice(keep);
    const code = marks.some((m) => m.type.name === "code");
    if (opening.some((m) => DELIMS[m.type.name])) {
      // Opening delimiters go after leading spaces, which they cannot precede.
      const lead = /^\s*/.exec(text)![0];
      out += lead;
      text = text.slice(lead.length);
    }
    for (const mark of opening) {
      if (mark.type.name === "link") out += "[";
      else if (mark.type.name !== "code") out += DELIMS[mark.type.name]?.(mark) ?? "";
    }
    if (code) {
      const run = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
      const fence = "`".repeat(run + 1);
      const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
      out += `${fence}${pad}${text}${pad}${fence}`;
    } else out += text;
    open = marks.filter((m) => m.type.name !== "code");
  }
  return out;
}
