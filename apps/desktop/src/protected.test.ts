import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

// The pins the security re-review asked for, so they cannot quietly go away.
// (Whether they hold is checked in real Chromium and WebKit against the
// reviewer's spoof stylesheets; jsdom has no cascade layers.)
const css = readFileSync(resolve(__dirname, "protected.css"), "utf8");
const layer = css.slice(css.indexOf("@layer aura-protected {"));

it("is one cascade layer, declared before any other stylesheet", () => {
  expect(css.indexOf("@layer aura-protected {")).toBeGreaterThan(0);
  const main = readFileSync(resolve(__dirname, "main.tsx"), "utf8");
  const imports = main.split("\n").filter((l) => l.startsWith("import "));
  expect(imports[0]).toBe('import "./protected.css";');
});

it("pins the text properties the reviewer used to garble or spoof the prompt", () => {
  for (const pin of [
    "-webkit-text-fill-color: currentColor !important",
    "-webkit-text-stroke: 0 !important",
    "-webkit-text-security: none !important",
    "writing-mode: horizontal-tb !important",
    "text-shadow: none !important",
    "text-indent: 0 !important",
    "letter-spacing: normal !important",
    "word-spacing: normal !important",
    "font-family: system-ui, sans-serif !important",
    "font-size: 14px !important",
    "font-weight: 400 !important",
  ])
    expect(layer, pin).toContain(pin);
});

it("resets the prompt's pseudo-elements, cuts inheritance, and has an opaque backdrop", () => {
  for (const sel of ["*::marker", "*::before", "*::after", "*::first-line", "*::first-letter"]) expect(layer).toContain(`dialog.aura-protected ${sel}`);
  expect(layer).toMatch(/dialog\.aura-protected \{\s*all: initial !important;/);
  const backdrop = layer.slice(layer.lastIndexOf("dialog.aura-protected::backdrop {"));
  expect(backdrop).toMatch(/background: #[0-9a-f]{6} !important/);
  expect(backdrop).toContain("opacity: 1 !important");
});
