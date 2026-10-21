/**
 * File paths in agent messages: telling them apart from URLs and prose, and
 * resolving them against the session's folder.
 */

/** `src/foo.ts`, `./a/b.rs:12`, `/abs/x.md:3:5`, `~/notes.txt`, `Composer.tsx:42`. */
const PATH_SOURCE = String.raw`(?:~\/|\.{1,2}\/|\/)?(?:[\w.@+-]+\/)*[\w@+-][\w.@+-]*\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?`;
const WHOLE_PATH = new RegExp(`^${PATH_SOURCE}$`);
/** Paths in prose: after a space or opening punctuation, before a space or closing punctuation. */
export const PATH_IN_TEXT = new RegExp(`(?<=^|[\\s(\\["'])${PATH_SOURCE}(?=$|[\\s)\\]"',.;:!?])`, "g");
/** Extensions that make `host.tld:port` look like `file.ext:line`. */
const DOMAIN_ENDINGS = new Set(["com", "net", "org", "io", "dev", "app", "nl", "de", "uk", "co", "ai", "local", "localhost", "internal"]);

export type FileRef = { path: string; line: number | null };

/** The file and line `text` names when the whole of it is a path, else null. */
export function fileRef(text: string): FileRef | null {
  if (!WHOLE_PATH.test(text)) return null;
  const m = /^(.*?)(?::(\d+)(?::\d+)?)?$/.exec(text)!;
  const path = m[1];
  const line = m[2] ? Number(m[2]) : null;
  const slash = path.includes("/");
  if (!slash && line === null) return null;
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (!slash && DOMAIN_ENDINGS.has(ext)) return null;
  // `example.com/page.html` is a web address without its scheme, not a folder.
  const first = path.split("/")[0];
  if (!/^(~|\.{1,2}|)$/.test(first) && /^[^.]+\.[^.]+$/.test(first) && DOMAIN_ENDINGS.has(first.split(".")[1].toLowerCase())) return null;
  return { path, line };
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * The absolute path `path` names, relative ones resolved against `cwd`.
 * `~/` is left for the caller. Null when a relative path has no folder to go by.
 */
export function resolvePath(path: string, cwd: string | null | undefined): string | null {
  if (isAbsolutePath(path) || path.startsWith("~/")) return path;
  if (!cwd) return null;
  const parts = `${cwd.replace(/[\\/]+$/, "")}/${path}`.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "." || (part === "" && out.length > 0)) continue;
    if (part === "..") {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/") || "/";
}

export type ImageSource =
  | { kind: "remote"; url: string }
  | { kind: "local"; path: string }
  | { kind: "none" };

/**
 * Where a markdown image comes from. Only https and data: images load from
 * outside; local files only where a folder (`cwd`) says the message is an
 * agent's, never in pull request text from other people.
 */
export function imageSource(src: string, cwd: string | null | undefined): ImageSource {
  if (/^https:\/\//i.test(src) || /^data:image\/(png|jpe?g|gif|webp);/i.test(src)) return { kind: "remote", url: src };
  if (cwd === undefined) return { kind: "none" };
  if (/^file:\/\//i.test(src)) {
    try {
      return { kind: "local", path: decodeURIComponent(new URL(src).pathname) };
    } catch {
      return { kind: "none" };
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^[A-Za-z]:[\\/]/.test(src)) return { kind: "none" };
  let path: string;
  try {
    path = decodeURIComponent(src);
  } catch {
    path = src;
  }
  const abs = resolvePath(path, cwd);
  return abs ? { kind: "local", path: abs } : { kind: "none" };
}
