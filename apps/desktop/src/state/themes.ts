/**
 * User themes: `<data dir>/themes/<id>.json` (and mods' `themes/`), listed and
 * validated by the daemon (`themes.list`), applied here on top of their base.
 *
 * A theme sets `data-theme` to its base ("dark" or "light"), then overrides
 * tokens from one <style> and adds its own CSS from another. A theme that is
 * missing or invalid never breaks the window: its base (or dark) shows, and
 * Settings › General says why.
 */
import { useEffect } from "react";
import { create } from "zustand";
import { useStore } from "./store";
import { isTauri } from "../lib/connection";
import { THEME_APPLIED_EVENT } from "../lib/terminalTheme";

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

/** The stylesheet with a theme's token overrides. Values are validated by the daemon; this guards again. */
export function tokenCss(t: UserTheme): string {
  const lines = Object.entries(t.tokens)
    .filter(([name, value]) => SAFE_NAME.test(name) && typeof value === "string" && !/[{}<]/.test(value))
    .map(([name, value]) => `  ${name}: ${value};`);
  // :root:root[…] outranks :root[data-theme="light"], whatever the order of the stylesheets.
  return `:root:root[data-user-theme] {\n${lines.join("\n")}\n}\n`;
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
  const tokens = styleEl(TOKENS_ID);
  const text = tokenCss(r.theme);
  if (tokens.textContent !== text) tokens.textContent = text;
  if (r.theme.css) {
    const css = styleEl(CSS_ID);
    if (css.textContent !== r.theme.css) css.textContent = r.theme.css;
  } else document.getElementById(CSS_ID)?.remove();
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

  useEffect(() => {
    if (!client) return;
    void refresh();
    const offState = client.onState((s) => {
      if (s === "open") void refresh();
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
