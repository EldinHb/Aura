// QA: the mods' stylesheets are injected into one page, unscoped, so a class both define
// styles both cards. pr-status's `.pr-card`, `.pr-reviewers`, `.pr-reviewer`, `.pr-state`,
// `.pr-avatar`, `.pr-title`, `.pr-meta` … also exist in mods/pull-requests/src/ui.css.
// Reproduced in the real app: with both loaded, every card in the Inspector grows to 366-818 px
// in a 280 px column (reviewers become one nowrap flex row) and the state chips are filled.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** Class names a stylesheet styles on its own (not behind a scoping ancestor class such as `.pr-status`). */
function unscopedClasses(sheet: string, scope?: string): Set<string> {
  const out = new Set<string>();
  for (const [, selectors] of sheet.matchAll(/(?:^|})\s*([^{}@]+)\{/g)) {
    for (const sel of selectors.split(",")) {
      const s = sel.trim();
      if (scope && s.startsWith(`.${scope} `)) continue;
      for (const [, name] of s.matchAll(/\.([A-Za-z_][\w-]*)/g)) out.add(name);
    }
  }
  return out;
}

describe("stylesheet collisions between mods", () => {
  // Fixed by giving pr-status's classes their own `prs-` prefix.
  it("pr-status styles no class that mods/pull-requests styles too", () => {
    const mine = unscopedClasses(css("../ui.css"), "pr-status");
    const theirs = unscopedClasses(css("../../../pull-requests/src/ui.css"));
    const shared = [...mine].filter((name) => theirs.has(name)).sort();
    expect(shared).toEqual([]);
  });
});
