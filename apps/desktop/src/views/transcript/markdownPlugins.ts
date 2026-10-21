import type { Nodes as MdNodes, Parent as MdParent, PhrasingContent } from "mdast";
import type { Element, Nodes as HastNodes, Root as HastRoot } from "hast";
import { fileRef, PATH_IN_TEXT } from "../../lib/localPaths";

/** Marks a link the renderer made from a path in prose rather than one the author wrote. */
export const PATH_LINK = "data-path-link";

/**
 * Turns file paths in prose (`src/foo.ts:12`) into links, so the renderer can
 * make them openable. Leaves code, links and images alone.
 */
export function remarkFilePaths() {
  return (tree: MdNodes) => walk(tree);
}

function walk(node: MdNodes) {
  if (!("children" in node)) return;
  if (node.type === "link" || node.type === "linkReference") return;
  const parent = node as MdParent;
  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i];
    if (child.type !== "text") {
      walk(child);
      continue;
    }
    const pieces = splitPaths(child.value);
    if (pieces.length === 1 && pieces[0].type === "text") continue;
    parent.children.splice(i, 1, ...(pieces as typeof parent.children));
    i += pieces.length - 1;
  }
}

function splitPaths(text: string): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  let last = 0;
  for (const m of text.matchAll(PATH_IN_TEXT)) {
    if (!fileRef(m[0])) continue;
    if (m.index > last) out.push({ type: "text", value: text.slice(last, m.index) });
    out.push({ type: "link", url: m[0], children: [{ type: "text", value: m[0] }], data: { hProperties: { [PATH_LINK]: "" } } });
    last = m.index + m[0].length;
  }
  if (last < text.length || out.length === 0) out.push({ type: "text", value: text.slice(last) });
  return out;
}

const BLOCKS = new Set(["p", "ul", "ol", "li", "pre", "blockquote", "table", "thead", "tbody", "tr", "th", "td", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "div", "section", "input"]);
const isBlock = (n: HastNodes | undefined) => !!n && n.type === "element" && BLOCKS.has(n.tagName);

/**
 * Drops the line breaks the converter puts between blocks. Paragraphs and list
 * items keep their own line breaks visible (`white-space: pre-wrap`), and
 * these would show as blank lines.
 */
export function rehypeBlockWhitespace() {
  return (tree: HastRoot) => strip(tree);
}

function strip(node: HastRoot | Element) {
  if (node.type === "element" && (node.tagName === "pre" || node.tagName === "code")) return;
  const kids = node.children;
  node.children = kids.filter((child, i) => {
    if (child.type !== "text" || !/^\s*\n\s*$/.test(child.value)) return true;
    const before = kids[i - 1];
    const after = kids[i + 1];
    return !(!before || !after || isBlock(before) || isBlock(after));
  }) as typeof node.children;
  for (const child of node.children) if (child.type === "element") strip(child);
}

/** Below this, a message is parsed whole. */
const SEGMENT_FROM = 4000;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** Lines after a blank line that can still belong to the block before it. */
const CONTINUES = /^(\s|[-*+>|]|\d+[.)]|<)/;
/** A definition anywhere can be used anywhere, so such text is never split. */
const DEFINITION = /^ {0,3}\[[^\]]+\]:/m;

/**
 * Splits long markdown into pieces that parse the same apart as together,
 * so a streaming message re-parses only its last piece. Splits only at a
 * blank line outside code followed by an unindented line that cannot continue
 * a list, quote, table or HTML block.
 */
export function markdownSegments(text: string): string[] {
  if (text.length < SEGMENT_FROM || DEFINITION.test(text)) return [text];
  const lines = text.split("\n");
  const out: string[] = [];
  let start = 0;
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    if (line.trim() === "" && i + 1 < lines.length && lines[i + 1].trim() !== "" && !CONTINUES.test(lines[i + 1]) && i + 1 - start > 1) {
      out.push(lines.slice(start, i + 1).join("\n"));
      start = i + 1;
    }
  }
  out.push(lines.slice(start).join("\n"));
  return out;
}
