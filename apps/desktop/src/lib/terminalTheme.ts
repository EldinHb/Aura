import type { ITheme } from "@xterm/xterm";

/** xterm's colour slots and the theme token each one reads (styles.css, group "Terminal"). */
export const TERMINAL_TOKENS: Array<[keyof ITheme, string]> = [
  ["background", "--term-bg"],
  ["foreground", "--term-fg"],
  ["cursor", "--term-cursor"],
  ["cursorAccent", "--term-cursor-accent"],
  ["selectionBackground", "--term-selection"],
  ["black", "--term-black"],
  ["red", "--term-red"],
  ["green", "--term-green"],
  ["yellow", "--term-yellow"],
  ["blue", "--term-blue"],
  ["magenta", "--term-magenta"],
  ["cyan", "--term-cyan"],
  ["white", "--term-white"],
  ["brightBlack", "--term-bright-black"],
  ["brightRed", "--term-bright-red"],
  ["brightGreen", "--term-bright-green"],
  ["brightYellow", "--term-bright-yellow"],
  ["brightBlue", "--term-bright-blue"],
  ["brightMagenta", "--term-bright-magenta"],
  ["brightCyan", "--term-bright-cyan"],
  ["brightWhite", "--term-bright-white"],
];

/** The terminal palette of the theme on screen now. A token that is not set leaves xterm's own default. */
export function terminalTheme(root: Element = document.documentElement): ITheme {
  const style = getComputedStyle(root);
  const theme: ITheme = {};
  for (const [slot, token] of TERMINAL_TOKENS) {
    const value = style.getPropertyValue(token).trim();
    if (value) (theme as Record<string, string>)[slot] = value;
  }
  return theme;
}

/** Fired on window whenever the theme on screen changes (state/themes.ts). */
export const THEME_APPLIED_EVENT = "aura:theme-applied";
