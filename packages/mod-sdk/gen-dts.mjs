#!/usr/bin/env node
// Writes types/aura-mod.d.ts: the whole mod API as one self-contained
// declaration file, for mods written without a build step (plain JS with
// JSDoc). `aura mods new` copies it into every new mod, and `aura guide mods`
// points at it, so it must not import anything: the SDK sources are inlined
// into `declare namespace Aura`, with the core types they use from the
// desktop's generated types.
//
//   node packages/mod-sdk/gen-dts.mjs           write it
//   node packages/mod-sdk/gen-dts.mjs --check   fail when it is out of date
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "src");
const gen = join(here, "../../apps/desktop/src/gen");
const out = join(here, "types/aura-mod.d.ts");

/** The core types core.ts re-exports, with everything they use. */
function coreTypes() {
  const core = readFileSync(join(src, "core.ts"), "utf8");
  const block = core.match(/export type \{([^}]*)\}/)[1];
  const wanted = block
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [name, alias] = s.split(/\s+as\s+/);
      return { name, alias };
    });
  const seen = new Map();
  const queue = wanted.map((w) => w.name);
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    const text = readFileSync(join(gen, `${name}.ts`), "utf8");
    for (const m of text.matchAll(/import type \{ (\w+) \} from "\.\/(\w+)"/g)) queue.push(m[2]);
    seen.set(
      name,
      text
        .split("\n")
        .filter((l) => !l.startsWith("import ") && !l.startsWith("// This file was generated"))
        .join("\n")
        .trim(),
    );
  }
  const body = [...seen.keys()].sort().map((k) => seen.get(k));
  for (const w of wanted) if (w.alias) body.push(`export type ${w.alias} = ${w.name};`);
  return body.join("\n\n");
}

/** An SDK source file without its imports, with function bodies made declarations. */
function sdk(file) {
  let text = readFileSync(join(src, file), "utf8");
  text = text
    .split("\n")
    .filter((l) => !/^import /.test(l) && !/^export type \{ \w+ \};$/.test(l))
    .join("\n");
  // export function defineX(a: T): T { return a; }  →  export function defineX(a: T): T;
  text = text.replace(/export function (\w+)\(([^)]*)\): ([^{]+?) \{\n[\s\S]*?\n\}/g, "export function $1($2): $3;");
  return text.trim();
}

/** "@aura/host": what host.ts exports, typed loosely (its real types are Aura's). */
function hostTypes() {
  const host = readFileSync(join(src, "host.ts"), "utf8");
  const names = [];
  for (const m of host.matchAll(/^export \{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const p = part.trim();
      if (p && !p.startsWith("type ")) names.push(p);
    }
  }
  for (const m of host.matchAll(/^export \* as (\w+)/gm)) names.push(m[1]);
  const doc = {
    Modal: "A dialog with Aura's look and keyboard handling. Props: { title, onClose, children, ... }",
    ModalC: "A compact dialog.",
    KeyList: "A keyboard-navigable list. Props: { items, onSelect, ... }",
    useListNav: "Hook: arrow-key navigation over a list.",
    ExternalLink: "A link that opens in the user's browser. Props: { href, children }",
    Markdown: "Renders markdown the way the transcript does. Props: { text }",
    DiffRenderer: "Renders a unified diff.",
    diff: "Unified diff parsing helpers.",
    timeAgo: "(iso: string) => string, e.g. \"5m\".",
    exactTime: "(iso: string) => string.",
    isMac: "boolean.",
    modLabel: "The platform's modifier key label (⌘ or Ctrl).",
    shortId: "(id: string) => string.",
    basename: "(path: string) => string.",
    relTime: "(iso: string) => string.",
    useStore: "Aura's zustand store (read-only use recommended): useStore((s) => s.sessions).",
    setFocus: "(region: \"sidebar\" | \"main\" | \"inspector\" | ...) => void.",
    openExternal: "(url: string) => void: open a URL in the user's browser.",
  };
  const missing = names.filter((n) => !(n in doc));
  if (missing.length) throw new Error(`gen-dts: describe these @aura/host exports: ${missing.join(", ")}`);
  return [
    "/** Aura's own building blocks (`globalThis.__aura.modules[\"@aura/host\"]`). */",
    "export interface AuraHost {",
    ...names.map((n) => `  /** ${doc[n]} */\n  ${n}: any;`),
    "}",
  ].join("\n");
}

function indent(text) {
  return text
    .split("\n")
    .map((l) => (l ? `  ${l}` : l))
    .join("\n");
}

export function generate() {
  const body = [
    "/** React's component type, simplified: a function from props to an element. */",
    "export type ComponentType<P = {}> = (props: P) => any;",
    "",
    "// ---- Core types (sessions, events) ----",
    coreTypes(),
    "",
    "// ---- mod.json ----",
    sdk("manifest.ts"),
    "",
    "// ---- The daemon half: activate(aura: DaemonApi) ----",
    sdk("daemon.ts"),
    "",
    "// ---- The UI half: activate(ctx: UiApi) ----",
    sdk("ui.ts"),
    "",
    "// ---- globalThis.__aura (UI half only) ----",
    hostTypes(),
    "",
    "/** What `globalThis.__aura` holds in Aura's window. */",
    "export interface AuraGlobal {",
    "  modules: {",
    "    /** Aura's React. Use it, never a copy of your own: two Reacts break hooks. */",
    "    react: any;",
    '    "react/jsx-runtime": any;',
    '    "react-dom": any;',
    "    zustand: any;",
    '    "zustand/shallow": any;',
    '    "zustand/react/shallow": any;',
    "    clsx: any;",
    '    "@aura/host": AuraHost;',
    "  };",
    "}",
  ].join("\n");
  return `// Aura mod API (apiVersion 1), as one file for mods without a build step.
// Generated from Aura's packages/mod-sdk by gen-dts.mjs; do not edit.
//
// Use it from plain JavaScript with JSDoc:
//   /** @param {Aura.DaemonApi} aura */ export default function activate(aura) { ... }
//   /** @param {Aura.UiApi} ctx */      export default function activate(ctx) { ... }
// A jsconfig.json that includes this file gives editors completion and checks.

declare namespace Aura {
${indent(body)}
}

/** Set by Aura in its window before a mod's ui.js runs. Not available in daemon.js. */
declare var __aura: Aura.AuraGlobal;
`;
}

const text = generate();
if (process.argv.includes("--check")) {
  const current = existsSync(out) ? readFileSync(out, "utf8") : "";
  if (current !== text) {
    console.error("packages/mod-sdk/types/aura-mod.d.ts is out of date: run node packages/mod-sdk/gen-dts.mjs");
    process.exit(1);
  }
  console.log("aura-mod.d.ts is up to date");
} else if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("gen-dts.mjs")) {
  writeFileSync(out, text);
  console.log(`wrote ${out}`);
}
