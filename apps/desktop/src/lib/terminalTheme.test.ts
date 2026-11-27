import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TERMINAL_TOKENS, THEME_APPLIED_EVENT, terminalTheme } from "./terminalTheme";
import { applyTheme } from "../state/themes";

afterEach(() => {
  document.documentElement.removeAttribute("style");
  document.head.innerHTML = "";
});

it("maps every --term-* token of styles.css to an xterm slot, and nothing else", () => {
  const css = readFileSync(resolve(__dirname, "../styles.css"), "utf8");
  const inCss = [...new Set([...css.matchAll(/^\s*(--term-[a-z-]+):/gm)].map((m) => m[1]))].sort();
  expect(TERMINAL_TOKENS.map(([, token]) => token).sort()).toEqual(inCss);
  expect(TERMINAL_TOKENS).toHaveLength(21);
});

it("reads the palette from the theme on screen and leaves unset slots to xterm", () => {
  const root = document.documentElement;
  root.style.setProperty("--term-bg", "#102030");
  root.style.setProperty("--term-bright-white", "#fafafa");
  const theme = terminalTheme();
  expect(theme.background).toBe("#102030");
  expect(theme.brightWhite).toBe("#fafafa");
  expect(theme.red).toBeUndefined();
});

it("announces every theme change, so an open terminal repaints", () => {
  const seen = vi.fn();
  window.addEventListener(THEME_APPLIED_EVENT, seen);
  applyTheme({ base: "light", theme: null, problem: null });
  applyTheme({
    base: "dark",
    theme: { id: "t", name: "T", base: "dark", tokens: { "--term-bg": "#000000" }, path: "", source: "user", warnings: [] },
    problem: null,
  });
  window.removeEventListener(THEME_APPLIED_EVENT, seen);
  expect(seen).toHaveBeenCalledTimes(2);
});
