/**
 * Markdown-lite parser producing a safe block tree (no HTML passthrough).
 * Supports fenced code blocks, headings, bullet/numbered lists, tables,
 * paragraphs, and inline `code`, **bold**, *italic*, and [text](url) links.
 */
export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "bold"; v: Inline[] }
  | { t: "em"; v: Inline[] }
  | { t: "link"; text: string; url: string };

export type Block =
  | { t: "code"; lang: string; v: string }
  | { t: "heading"; level: number; v: Inline[] }
  | { t: "list"; ordered: boolean; items: Inline[][] }
  | { t: "table"; align: TableAlign[]; head: Inline[][]; rows: Inline[][][] }
  | { t: "para"; v: Inline[] }
  | { t: "hr" };

export type TableAlign = "left" | "center" | "right" | null;

const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** `| a | b \| c |` -> ["a", "b | c"]. */
function tableCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function tableAlign(cell: string): TableAlign {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : null;
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i) {
        flush();
        out.push({ t: "code", v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (src.startsWith("**", i)) {
      const end = src.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: "bold", v: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (ch === "*" || ch === "_") {
      const end = src.indexOf(ch, i + 1);
      if (end > i + 1 && /\S/.test(src[i + 1]) && /\S/.test(src[end - 1])) {
        flush();
        out.push({ t: "em", v: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ t: "link", text: m[1], url: m[2] });
        i += m[0].length;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      blocks.push({ t: "para", v: parseInline(para.join("\n")) });
      para = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(```+|~~~+)\s*(\S*)[^\n]*$/.exec(line);
    if (fence) {
      flushPara();
      const marker = fence[1];
      const lang = fence[2];
      const body: string[] = [];
      i++;
      const closing = new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`);
      while (i < lines.length && !closing.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or EOF)
      blocks.push({ t: "code", lang, v: body.join("\n") });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && lines[i + 1].includes("|") && TABLE_DELIMITER.test(lines[i + 1])) {
      const head = tableCells(line);
      const align = tableCells(lines[i + 1]).map(tableAlign);
      if (align.length === head.length) {
        flushPara();
        i += 2;
        const rows: Inline[][][] = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
          const cells = tableCells(lines[i++]);
          rows.push(head.map((_, c) => parseInline(cells[c] ?? "")));
        }
        blocks.push({ t: "table", align, head: head.map((c) => parseInline(c)), rows });
        continue;
      }
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      blocks.push({ t: "heading", level: heading[1].length, v: parseInline(heading[2].trim()) });
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      blocks.push({ t: "hr" });
      i++;
      continue;
    }
    const bullet = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      const ordered = /\d/.test(bullet[1]);
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        if (/\d/.test(m[1]) !== ordered) break;
        let text = m[2];
        i++;
        // continuation lines (indented, non-list)
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) && !/^\s*(```+|~~~+)/.test(lines[i])) text += "\n" + lines[i++].trim();
        items.push(parseInline(text));
      }
      blocks.push({ t: "list", ordered, items });
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return blocks;
}
