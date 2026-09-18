/** Unified diff parsing and side-by-side pairing. Pure functions, no DOM. */

export type DiffLineKind = "add" | "del" | "ctx" | "hunk" | "meta";

export type DiffLine = {
  kind: DiffLineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
};

export type Hunk = {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
};

export type FileDiff = {
  oldPath: string;
  newPath: string;
  /** raw header lines (diff --git, index, ---, +++) */
  meta: string[];
  hunks: Hunk[];
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
};

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const raw of lines) {
    if (raw.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(raw);
      cur = { oldPath: m?.[1] ?? "", newPath: m?.[2] ?? "", meta: [raw], hunks: [], isNew: false, isDeleted: false, isBinary: false };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) {
      // diff without a header (e.g. plain `git diff --no-index` fragments) — synthesize
      if (raw.startsWith("--- ") || raw.startsWith("+++ ") || raw.startsWith("@@")) {
        cur = { oldPath: "", newPath: "", meta: [], hunks: [], isNew: false, isDeleted: false, isBinary: false };
        files.push(cur);
      } else continue;
    }
    const hm = HUNK_RE.exec(raw);
    if (hm) {
      oldNo = Number(hm[1]);
      newNo = Number(hm[3]);
      hunk = { header: raw, oldStart: oldNo, newStart: newNo, lines: [{ kind: "hunk", text: raw, oldNo: null, newNo: null }] };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      cur.meta.push(raw);
      if (raw.startsWith("new file mode")) cur.isNew = true;
      if (raw.startsWith("deleted file mode")) cur.isDeleted = true;
      if (raw.startsWith("Binary files") || raw.startsWith("GIT binary patch")) cur.isBinary = true;
      if (raw.startsWith("--- ")) {
        const p = raw.slice(4);
        if (p === "/dev/null") cur.isNew = true;
        else if (!cur.oldPath) cur.oldPath = p.replace(/^a\//, "");
      }
      if (raw.startsWith("+++ ")) {
        const p = raw.slice(4);
        if (p === "/dev/null") cur.isDeleted = true;
        else if (!cur.newPath) cur.newPath = p.replace(/^b\//, "");
      }
      continue;
    }
    if (raw.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: raw.slice(1), oldNo: null, newNo: newNo++ });
    } else if (raw.startsWith("-")) {
      hunk.lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++, newNo: null });
    } else if (raw.startsWith("\\")) {
      hunk.lines.push({ kind: "meta", text: raw, oldNo: null, newNo: null });
    } else {
      hunk.lines.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return files;
}

export function displayPath(f: FileDiff): string {
  if (f.isDeleted) return f.oldPath || f.newPath;
  return f.newPath || f.oldPath;
}

export type SideRow = {
  left: DiffLine | null;
  right: DiffLine | null;
  /** true when left/right differ only by whitespace */
  wsOnly?: boolean;
};

export function normalizeWs(s: string): string {
  return s.replace(/\s+/g, "");
}

/** Pair removed and added lines within a hunk for side-by-side rendering. */
export function pairHunk(h: Hunk, ignoreWs = false): SideRow[] {
  const rows: SideRow[] = [];
  const body = h.lines.filter((l) => l.kind !== "hunk");
  let i = 0;
  while (i < body.length) {
    const l = body[i];
    if (l.kind === "ctx" || l.kind === "meta") {
      rows.push({ left: l, right: l });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < body.length && body[i].kind === "del") dels.push(body[i++]);
    while (i < body.length && body[i].kind === "add") adds.push(body[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      const left = dels[k] ?? null;
      const right = adds[k] ?? null;
      const wsOnly = !!left && !!right && ignoreWs && normalizeWs(left.text) === normalizeWs(right.text);
      rows.push({ left, right, wsOnly });
    }
  }
  return rows;
}

/** Drop change pairs that differ only in whitespace (unified view). */
export function filterWhitespace(h: Hunk): DiffLine[] {
  const rows = pairHunk(h, true);
  const out: DiffLine[] = [h.lines[0]];
  for (const r of rows) {
    if (r.wsOnly && r.left && r.right) {
      out.push({ kind: "ctx", text: r.right.text, oldNo: r.left.oldNo, newNo: r.right.newNo });
      continue;
    }
    if (r.left && r.left === r.right) out.push(r.left);
    else {
      if (r.left) out.push(r.left);
      if (r.right) out.push(r.right);
    }
  }
  return out;
}

export function countChanges(f: FileDiff): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const h of f.hunks) for (const l of h.lines) if (l.kind === "add") added++; else if (l.kind === "del") deleted++;
  return { added, deleted };
}
