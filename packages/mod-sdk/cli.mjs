#!/usr/bin/env node
// aura-mod build [dir…] [--watch]
import { buildMod } from "./build.mjs";

const [cmd, ...rest] = process.argv.slice(2);
if (cmd !== "build") {
  console.error("usage: aura-mod build [dir…] [--watch]");
  process.exit(2);
}
const watch = rest.includes("--watch");
const dirs = rest.filter((a) => !a.startsWith("--"));
for (const d of dirs.length ? dirs : ["."]) {
  const r = await buildMod(d, { watch });
  if (r) console.log(`built ${r.id} → ${r.out}`);
}
