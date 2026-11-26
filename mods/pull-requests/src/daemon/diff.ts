// Where review comments can go in a unified diff (former aura-review diff.rs).
import type { ReviewComment } from "@aura/github-client";

/** Old- and new-side lines a comment can be on, per file. */
export type Positions = Map<string, [Set<number>, Set<number>]>;

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Diff positions keyed by canonical path and side; no guesses across ambiguous filenames. */
export function positions(diff: string): Positions {
  const files: Positions = new Map();
  const entry = (path: string) => {
    let pair = files.get(path);
    if (!pair) {
      pair = [new Set(), new Set()];
      files.set(path, pair);
    }
    return pair;
  };
  let path = "";
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of lines(diff)) {
    if (line.startsWith("diff --git ")) inHunk = false;
    let m: RegExpExecArray | null;
    if (line.startsWith("+++ ")) {
      const p = line.slice(4);
      if (p !== "/dev/null") path = decodePath(p.startsWith("b/") ? p.slice(2) : p);
      entry(path);
    } else if (line.startsWith("--- ")) {
      const p = line.slice(4);
      path = decodePath(p.startsWith("a/") ? p.slice(2) : p);
    } else if ((m = HUNK.exec(line))) {
      oldLine = Number(m[1]) || 0;
      newLine = Number(m[2]) || 0;
      inHunk = true;
    } else if (inHunk) {
      const pair = entry(path);
      switch (line[0]) {
        case "+":
          pair[1].add(newLine++);
          break;
        case "-":
          pair[0].add(oldLine++);
          break;
        case " ":
          pair[0].add(oldLine++);
          pair[1].add(newLine++);
          break;
        case "\\":
          break;
        default:
          inHunk = false;
      }
    }
  }
  return files;
}

/** Rust's `str::lines`: split on \n, drop a trailing \r, no final empty line. */
function lines(s: string): string[] {
  if (s === "") return [];
  const out = s.split("\n");
  if (out[out.length - 1] === "") out.pop();
  return out.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

function decodePath(s: string): string {
  if (!s.startsWith('"')) return s;
  let decoded = s;
  try {
    const v = JSON.parse(s);
    if (typeof v === "string") decoded = v;
  } catch {
    // Kept as given.
  }
  return decoded.replace(/^(a\/)+/, "").replace(/^(b\/)+/, "");
}

/** Mark which comments fall on the diff; with `relocate`, move ones up to 3 lines off. */
export function validate(comments: ReviewComment[], diff: string, relocate: boolean): void {
  const files = positions(diff);
  for (const c of comments) {
    c.valid = false;
    const wanted = c.path.replace(/^(\.\/)+/, "");
    const matches = [...files.keys()].filter((p) => p === wanted || p.endsWith(`/${wanted}`));
    const path = files.has(wanted) ? wanted : matches.length === 1 ? matches[0] : null;
    if (path === null) {
      c.position_note = "No unambiguous file in this diff; included in the review body.";
      continue;
    }
    c.path = path;
    const pair = files.get(path)!;
    const allowed = c.side === "LEFT" ? pair[0] : pair[1];
    if (!allowed.has(c.line) && relocate) {
      let best: number | null = null;
      for (const n of [...allowed].sort((a, b) => a - b)) {
        if (best === null || Math.abs(n - c.line) < Math.abs(best - c.line)) best = n;
      }
      if (best !== null && Math.abs(best - c.line) <= 3) {
        c.position_note = `Moved from line ${c.line} to ${best}; verify this location.`;
        c.line = best;
        c.start_line = null;
      }
    }
    c.valid = allowed.has(c.line) && (c.side === "LEFT" || c.side === "RIGHT");
    const start = c.start_line;
    if (start != null) {
      let all = start < c.line;
      for (let n = start; all && n <= c.line; n++) all = allowed.has(n);
      if (!all) c.valid = false;
    }
    if (!c.valid) c.position_note = "Outside the reviewed diff; included in the review body.";
  }
}
