#!/usr/bin/env node
// aura-mod build [dir] [--watch]
//
// Bundles a mod in `dir` (default: cwd) into dist/:
//   src/daemon.ts → dist/daemon.js  one ES module, no imports left, runs in aurad's QuickJS
//   src/ui.tsx    → dist/ui.js      one ES module; react, zustand and @aura/host map to
//                  (+ dist/ui.css)   Aura's own copies at runtime
// and copies mod.json next to them, so dist/ is the installable mod folder.
import { build, context } from "esbuild";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Imports a UI half shares with Aura instead of bundling its own copy. */
export const SHARED = ["react", "react/jsx-runtime", "react-dom", "zustand", "zustand/shallow", "zustand/react/shallow", "clsx", "@aura/host"];

const shared = {
  name: "aura-shared",
  setup(b) {
    const filter = new RegExp(`^(${SHARED.map((s) => s.replace(/[/.]/g, "\\$&")).join("|")})$`);
    b.onResolve({ filter }, (args) => ({ path: args.path, namespace: "aura-shared" }));
    b.onLoad({ filter: /.*/, namespace: "aura-shared" }, (args) => ({
      contents: `const m = globalThis.__aura && globalThis.__aura.modules[${JSON.stringify(args.path)}];
if (!m) throw new Error("Aura does not provide ${args.path}");
module.exports = m;`,
      loader: "js",
    }));
  },
};

/** The daemon half must not pull in UI or Node modules. */
const daemonGuard = {
  name: "aura-daemon-guard",
  setup(b) {
    b.onResolve({ filter: /^(node:|react|zustand|@aura\/host)/ }, (args) => ({
      errors: [{ text: `"${args.path}" is not available in a mod's daemon half` }],
    }));
  },
};

export async function buildMod(dir, { watch = false, minify = true } = {}) {
  const root = resolve(dir);
  const manifest = JSON.parse(readFileSync(join(root, "mod.json"), "utf8"));
  const out = join(root, "dist");
  mkdirSync(out, { recursive: true });
  const jobs = [];
  const find = (...names) => names.map((n) => join(root, "src", n)).find(existsSync);
  const daemon = find("daemon.ts", "daemon.js");
  if (daemon) {
    jobs.push({
      entryPoints: [daemon],
      outfile: join(out, "daemon.js"),
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      minify: false, // readable stack traces in aurad.log
      sourcemap: false,
      plugins: [daemonGuard],
      logLevel: "warning",
    });
  }
  const ui = find("ui.tsx", "ui.ts", "ui.jsx", "ui.js");
  if (ui) {
    jobs.push({
      entryPoints: [ui],
      outfile: join(out, "ui.js"),
      bundle: true,
      format: "esm",
      platform: "browser",
      target: ["chrome105", "safari15"],
      jsx: "automatic",
      minify,
      plugins: [shared],
      loader: { ".svg": "text" },
      logLevel: "warning",
    });
  }
  const copyManifest = () => {
    const m = { ...manifest };
    if (daemon) m.daemon = "daemon.js";
    else delete m.daemon;
    if (ui) {
      m.ui = "ui.js";
      if (existsSync(join(out, "ui.css"))) m.styles = "ui.css";
    } else {
      delete m.ui;
      delete m.styles;
    }
    writeFileSync(join(out, "mod.json"), JSON.stringify(m, null, 2) + "\n");
  };
  if (watch) {
    for (const j of jobs) {
      const ctx = await context({ ...j, plugins: [...j.plugins, { name: "manifest", setup: (b) => b.onEnd(copyManifest) }] });
      await ctx.watch();
    }
    console.log(`watching ${manifest.id}`);
    return;
  }
  await Promise.all(jobs.map((j) => build(j)));
  copyManifest();
  return { id: manifest.id, out };
}

