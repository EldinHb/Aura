/**
 * User themes: `<data dir>/themes/<id>.json` (and mods' `themes/`), listed and
 * validated by the daemon (`themes.list`), applied here on top of their base.
 *
 * A theme sets `data-theme` to its base ("dark" or "light"), then sets its
 * tokens one by one with `style.setProperty` (a value can never add a
 * declaration of its own), and adds its CSS, which the daemon hands out only
 * once the user approved that exact CSS. A theme that is missing or invalid
 * never breaks the window: its base (or dark) shows, and Settings says why.
 *
 * The choice is kept by the daemon (`themes.use` / `themes.current`), so it
 * holds for every window and across restarts, whether it was made in
 * Settings or with `aura themes use`.
 */
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { useStore } from "./store";
import { isTauri } from "../lib/connection";
import { THEME_APPLIED_EVENT } from "../lib/terminalTheme";

type RpcLike = { call<T = unknown>(method: string, params?: unknown): Promise<T> };

export type UserTheme = {
  id: string;
  name: string;
  author?: string;
  base: "dark" | "light";
  tokens: Record<string, string>;
  css?: string;
  path: string;
  /** "user", or "mod:<id>". */
  source: string;
  warnings: string[];
  error?: string;
  /** For a theme with CSS: "needs_approval" (its CSS is withheld) or "approved". */
  approval?: "needs_approval" | "approved";
  /** The size of CSS that waits for approval. */
  cssBytes?: number;
};

export const BUILTIN_THEMES = ["dark", "light", "system"] as const;
export const isBuiltinTheme = (id: string) => (BUILTIN_THEMES as readonly string[]).includes(id);

export const useThemes = create<{ loaded: boolean; dir: string | null; themes: UserTheme[] }>(() => ({ loaded: false, dir: null, themes: [] }));

const CACHE_KEY = "aura.theme.cache.v1";

/** The last user theme applied, so the next start shows it before the daemon answers. */
function cachedTheme(): UserTheme | null {
  try {
    const t = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as UserTheme | null;
    return t && typeof t.id === "string" && (t.base === "dark" || t.base === "light") ? t : null;
  } catch {
    return null;
  }
}

function cacheTheme(t: UserTheme | null) {
  try {
    if (t) localStorage.setItem(CACHE_KEY, JSON.stringify(t));
    else localStorage.removeItem(CACHE_KEY);
  } catch {
    /* storage unavailable */
  }
}

export type ResolvedTheme = {
  base: "dark" | "light";
  /** The user theme to lay over the base, if one applies. */
  theme: UserTheme | null;
  /** Why the chosen theme is not (fully) shown, for Settings. */
  problem: string | null;
};

/**
 * What to show for the theme setting `choice`. `themes` is null while the list
 * has not arrived; `cached` is the theme applied last time.
 */
export function resolveTheme(choice: string, themes: UserTheme[] | null, prefersLight: boolean, cached: UserTheme | null = null): ResolvedTheme {
  if (choice === "system") return { base: prefersLight ? "light" : "dark", theme: null, problem: null };
  if (choice === "dark" || choice === "light") return { base: choice, theme: null, problem: null };
  if (themes === null) {
    // Not listed yet: the last copy of this theme, if any, avoids a flash.
    return cached && cached.id === choice ? { base: cached.base, theme: cached, problem: null } : { base: "dark", theme: null, problem: null };
  }
  const t = themes.find((x) => x.id === choice);
  if (!t) return { base: "dark", theme: null, problem: `The theme "${choice}" is not installed. Dark is shown instead.` };
  if (t.error) return { base: t.base === "light" ? "light" : "dark", theme: null, problem: `${t.name} cannot be used: ${t.error}. Its base (${t.base}) is shown instead.` };
  return { base: t.base, theme: t, problem: null };
}

const SAFE_NAME = /^--[a-z0-9-]+$/;
const RULE = ":root:root[data-user-theme]";

/** No `;`, `{`, `}` or `!` outside strings and brackets: one value (the daemon checks this fully). */
export function isSingleValue(v: string): boolean {
  let quote = "";
  let depth = 0;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (c === "{" || c === "}") return false;
    else if (depth === 0 && (c === ";" || c === "!")) return false;
  }
  return true;
}

/**
 * Set a theme's tokens on the rule of `el`, each with `style.setProperty`:
 * the browser parses every value as one value of that one property, so no
 * value can add, hide or end a declaration. (The daemon validates them too.)
 * The selector outranks :root[data-theme="light"], whatever the order of the stylesheets.
 */
export function setTokens(el: HTMLStyleElement, tokens: Record<string, string>): CSSStyleRule | null {
  if (el.textContent !== `${RULE} {}`) el.textContent = `${RULE} {}`;
  const rule = el.sheet?.cssRules[0] as CSSStyleRule | undefined;
  if (!rule) return null;
  for (let i = rule.style.length - 1; i >= 0; i--) rule.style.removeProperty(rule.style[i]);
  for (const [name, value] of Object.entries(tokens)) {
    if (SAFE_NAME.test(name) && typeof value === "string" && isSingleValue(value)) rule.style.setProperty(name, value);
  }
  return rule;
}

const TOKENS_ID = "aura-user-theme-tokens";
const CSS_ID = "aura-user-theme-css";

function styleEl(id: string): HTMLStyleElement {
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = id;
  }
  // Last in <head>, after the app's and the mods' styles.
  document.head.appendChild(el);
  return el;
}

/** Put `r` on the document, then tell what draws its own colours (the terminal) to read them again. */
export function applyTheme(r: ResolvedTheme) {
  putTheme(r);
  window.dispatchEvent(new Event(THEME_APPLIED_EVENT));
}

function putTheme(r: ResolvedTheme) {
  const root = document.documentElement;
  root.dataset.theme = r.base;
  if (!r.theme) {
    delete root.dataset.userTheme;
    document.getElementById(TOKENS_ID)?.remove();
    document.getElementById(CSS_ID)?.remove();
    return;
  }
  root.dataset.userTheme = r.theme.id;
  setTokens(styleEl(TOKENS_ID), r.theme.tokens);
  // Only approved CSS ever arrives here (the daemon withholds the rest), and only
  // where cascade layers keep approval prompts out of its reach.
  if (r.theme.css && r.theme.approval !== "needs_approval" && cssLayersSupported()) {
    const css = styleEl(CSS_ID);
    if (css.textContent !== r.theme.css) css.textContent = r.theme.css;
  } else document.getElementById(CSS_ID)?.remove();
}

/**
 * Whether this browser engine has cascade layers. Approval prompts are kept
 * out of a theme's reach by a cascade layer (protected.css); an engine
 * without them (Safari before 15.4, so macOS 12.0–12.2) would ignore that
 * layer, so there a theme's CSS is never applied, only its tokens.
 */
export function cssLayersSupported(win: { CSSLayerBlockRule?: unknown } = globalThis as never): boolean {
  return typeof win.CSSLayerBlockRule === "function";
}

/** Settings' explanation when a theme's CSS is left out for that reason. */
export const NO_LAYERS_NOTE = "This system can't protect approval prompts from theme CSS, so only its colours are used.";

/** Fetch the theme list again (also after an approval). */
export async function refreshThemes() {
  await refresh();
}

async function refresh() {
  const c = useStore.getState().client;
  if (!c) return;
  try {
    const r = await c.call<{ dir: string; themes: UserTheme[] }>("themes.list", {});
    useThemes.setState({ loaded: true, dir: r.dir, themes: r.themes ?? [] });
  } catch {
    // An older daemon without themes: only the built-in ones.
    useThemes.setState({ loaded: true, themes: [] });
  }
}

/** Mount once at the app root: keeps the theme list current and applies the chosen theme. */
export function useThemeLoader() {
  const client = useStore((s) => s.client);
  const choice = useStore((s) => s.settings.theme);
  const loaded = useThemes((s) => s.loaded);
  const themes = useThemes((s) => s.themes);

  // The daemon keeps the choice. On connecting, take its choice (set by
  // another window or `aura themes use` while this one was closed); after
  // that, tell it each choice made here.
  const synced = useRef<RpcLike | null>(null);
  useEffect(() => {
    if (!client) return;
    const sync = () => {
      client
        .call<{ id: string | null }>("themes.current", {})
        .then(({ id }) => {
          const mine = useStore.getState().settings.theme;
          if (id && id !== mine) useStore.getState().setSettings({ theme: id });
          else if (!id) void client.call("themes.use", { id: mine, allowInvalid: true }).catch(() => {});
        })
        .catch(() => {
          /* an older daemon: the choice stays this window's */
        })
        .finally(() => {
          synced.current = client;
        });
    };
    sync();
    void refresh();
    const offState = client.onState((s) => {
      if (s === "open") {
        void refresh();
        sync();
      }
    });
    const offNote = client.onNotification((method, params) => {
      if (method === "themes.changed" || method === "mods.changed" || method === "notifications.lagged") void refresh();
      else if (method === "themes.use") {
        const id = (params as { id?: unknown } | null)?.id;
        if (typeof id === "string" && id) useStore.getState().setSettings({ theme: id });
      }
    });
    return () => {
      offState();
      offNote();
    };
  }, [client]);

  useEffect(() => {
    if (client && synced.current === client) void client.call("themes.use", { id: choice, allowInvalid: true }).catch(() => {});
  }, [client, choice]);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const r = resolveTheme(choice, loaded ? themes : null, media.matches, cachedTheme());
      applyTheme(r);
      if (loaded || isBuiltinTheme(choice)) cacheTheme(r.theme);
      return r;
    };
    const first = apply();
    // Native controls (select menus, scrollbars, checkboxes) follow the window appearance, not our CSS, so pin the
    // window to the theme's base; "system" releases it and then tracks the OS as it changes.
    if (isTauri())
      import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setTheme(choice === "system" ? null : first.base)).catch(() => {});
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [choice, loaded, themes]);
}
