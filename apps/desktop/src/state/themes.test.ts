import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyTheme, bootSafeValue, cachedTheme, cssLayersSupported, isSingleValue, resolveTheme, setTokens, type UserTheme } from "./themes";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Node's own (empty) localStorage shadows jsdom's; a plain in-memory one.
const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear() },
});

// The engine has cascade layers unless a test says otherwise (jsdom has none).
const g = globalThis as { CSSLayerBlockRule?: unknown };
beforeEach(() => {
  g.CSSLayerBlockRule = class {};
});

const theme = (over: Partial<UserTheme> = {}): UserTheme => ({
  id: "ocean",
  name: "Ocean",
  base: "light",
  tokens: { "--md-primary": "#0066cc" },
  path: "/data/themes/ocean.json",
  source: "user",
  warnings: [],
  ...over,
});

describe("resolveTheme", () => {
  it("keeps the built-in themes as they were", () => {
    expect(resolveTheme("dark", [], false)).toEqual({ base: "dark", theme: null, problem: null });
    expect(resolveTheme("light", null, false)).toEqual({ base: "light", theme: null, problem: null });
    expect(resolveTheme("system", [], true).base).toBe("light");
    expect(resolveTheme("system", [], false).base).toBe("dark");
  });

  it("lays a user theme over its base", () => {
    const t = theme();
    expect(resolveTheme("ocean", [t], false)).toEqual({ base: "light", theme: t, problem: null });
  });

  it("falls back to the base of an invalid theme, and says why", () => {
    const r = resolveTheme("ocean", [theme({ error: "\"base\" is missing" })], false);
    expect(r.theme).toBeNull();
    expect(r.base).toBe("light");
    expect(r.problem).toContain("cannot be used");
    expect(r.problem).toContain("base");
  });

  it("falls back to dark for a theme that is gone", () => {
    const r = resolveTheme("gone", [theme()], true);
    expect(r).toMatchObject({ base: "dark", theme: null });
    expect(r.problem).toContain("not installed");
  });

  it("uses the cached copy until the list arrives", () => {
    const cached = theme();
    expect(resolveTheme("ocean", null, false, cached).theme).toBe(cached);
    expect(resolveTheme("other", null, false, cached)).toEqual({ base: "dark", theme: null, problem: null });
  });
});

describe("bootSafeValue (cached tokens before the daemon answers)", () => {
  it("passes plain values and whole data: URLs only", () => {
    for (const ok of ["#fff", "var(--a)", "color-mix(in srgb, var(--fg) 8%, transparent)", "0 1px 2px rgb(0 0 0 / 0.3)", "\"Google Sans\", system-ui", "url('data:image/svg+xml;utf8,<svg x=\"1\"/>')"])
      expect(bootSafeValue(ok), ok).toBe(true);
    for (const bad of ["image-set(var(--mono) 1x)", "url(https://e.x/a.png)", "u\\72l(x)", "cross-fade(a, b)", "url('data:x') , url(https://e.x)", "red;display:none", "attr(x)"])
      expect(bootSafeValue(bad), bad).toBe(false);
  });
});

describe("setTokens", () => {
  const sheet = () => {
    const el = document.createElement("style");
    document.head.appendChild(el);
    return el;
  };

  it("sets each token as one value of its own property", () => {
    const rule = setTokens(sheet(), { "--fg": "#fff", "--bg": "var(--md-surface)" })!;
    expect(rule.selectorText).toBe(":root:root[data-user-theme]");
    expect(rule.style.getPropertyValue("--fg").trim()).toBe("#fff");
    expect(rule.style.getPropertyValue("--bg").trim()).toBe("var(--md-surface)");
  });

  it("cannot be made to add a declaration (the reviewer's case)", () => {
    const el = sheet();
    const rule = setTokens(el, { "--fg": "red;display:none", "--x;y": "1", "--ok": "1px" })!;
    expect(rule.style.getPropertyValue("display")).toBe("");
    expect(rule.style.getPropertyValue("--ok").trim()).toBe("1px");
    expect(el.textContent).toBe(":root:root[data-user-theme] {}");
    expect(rule.cssText).not.toMatch(/display\s*:/);
  });

  it("knows one value from several", () => {
    for (const ok of ["#fff", "var(--a)", "\"a;b\", serif", "url('data:image/svg+xml;utf8,<svg/>')", "0 1px 2px rgb(0 0 0 / 0.3), 0 2px 4px rgb(0 0 0 / 0.2)"])
      expect(isSingleValue(ok)).toBe(true);
    for (const bad of ["red;display:none", "red } body { x: y", "red !important"]) expect(isSingleValue(bad)).toBe(false);
  });

  it("drops tokens a new version of the theme no longer sets", () => {
    const el = sheet();
    setTokens(el, { "--fg": "#fff", "--bg": "#000" });
    const rule = setTokens(el, { "--fg": "#eee" })!;
    expect(rule.style.getPropertyValue("--bg")).toBe("");
    expect(rule.style.getPropertyValue("--fg").trim()).toBe("#eee");
  });
});

describe("theme-boot.js (before the first paint)", () => {
  const boot = readFileSync(resolve(__dirname, "../../public/theme-boot.js"), "utf8");
  afterEach(() => {
    localStorage.clear();
    document.head.innerHTML = "";
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.userTheme;
  });

  it("shows the cached user theme's base and safe tokens, never its CSS", () => {
    localStorage.setItem("aura.settings.v1", JSON.stringify({ theme: "ocean" }));
    localStorage.setItem("aura.theme.cache.v1", JSON.stringify(theme({ css: ".a{color:red}", approval: "approved" })));
    new Function(boot)();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.userTheme).toBe("ocean");
    const rule = (document.getElementById("aura-user-theme-tokens") as HTMLStyleElement).sheet!.cssRules[0] as CSSStyleRule;
    expect(rule.style.getPropertyValue("--md-primary").trim()).toBe("#0066cc");
    expect(document.getElementById("aura-user-theme-css")).toBeNull();
  });

  it("does not apply a poisoned cache (the re-review's var() indirection, escapes, CSS)", () => {
    localStorage.setItem("aura.settings.v1", JSON.stringify({ theme: "ocean" }));
    const tokens = {
      "--mono": '"https://evil.example/a.png"',
      "--chevron": "image-set(var(--mono) 1x)",
      "--inbox-icon": "u\\72l(https://evil.example/b.png)",
      "--fg": "#eee",
      "--orchestrator-icon": "url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\"/>')",
    };
    localStorage.setItem("aura.theme.cache.v1", JSON.stringify(theme({ tokens, css: "body{background:url(https://evil.example/c.png)}", approval: "approved" })));
    new Function(boot)();
    const rule = (document.getElementById("aura-user-theme-tokens") as HTMLStyleElement).sheet!.cssRules[0] as CSSStyleRule;
    expect(rule.style.getPropertyValue("--chevron")).toBe("");
    expect(rule.style.getPropertyValue("--inbox-icon")).toBe("");
    expect(rule.style.getPropertyValue("--fg").trim()).toBe("#eee");
    expect(rule.style.getPropertyValue("--orchestrator-icon")).toContain("data:image/svg+xml");
    expect(document.getElementById("aura-user-theme-css")).toBeNull();
    // The app's own early path (before the daemon's list) applies the same rule.
    const cached = cachedTheme()!;
    // A bare string loads nothing; the image-set() that would use it is what is dropped.
    expect(Object.keys(cached.tokens).sort()).toEqual(["--fg", "--mono", "--orchestrator-icon"]);
    expect(cached.css).toBeUndefined();
  });

  it("uses a built-in theme as is, and dark when the cache is for another theme", () => {
    localStorage.setItem("aura.settings.v1", JSON.stringify({ theme: "light" }));
    new Function(boot)();
    expect(document.documentElement.dataset.theme).toBe("light");
    localStorage.setItem("aura.settings.v1", JSON.stringify({ theme: "other" }));
    localStorage.setItem("aura.theme.cache.v1", JSON.stringify(theme()));
    new Function(boot)();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("never applies CSS that waits for approval", () => {
    localStorage.setItem("aura.settings.v1", JSON.stringify({ theme: "ocean" }));
    localStorage.setItem("aura.theme.cache.v1", JSON.stringify(theme({ css: ".a{}", approval: "needs_approval" })));
    new Function(boot)();
    expect(document.getElementById("aura-user-theme-css")).toBeNull();
  });
});

describe("applyTheme", () => {
  afterEach(() => {
    document.head.innerHTML = "";
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.userTheme;
  });

  it("sets the base, the tokens and the theme's CSS, and removes them again", () => {
    applyTheme({ base: "light", theme: theme({ css: ".sidebar { opacity: 0.9 }" }), problem: null });
    const root = document.documentElement;
    expect(root.dataset.theme).toBe("light");
    expect(root.dataset.userTheme).toBe("ocean");
    expect(((document.getElementById("aura-user-theme-tokens") as HTMLStyleElement).sheet!.cssRules[0] as CSSStyleRule).style.getPropertyValue("--md-primary").trim()).toBe("#0066cc");
    expect(document.getElementById("aura-user-theme-css")?.textContent).toBe(".sidebar { opacity: 0.9 }");

    applyTheme({ base: "dark", theme: null, problem: null });
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.userTheme).toBeUndefined();
    expect(document.getElementById("aura-user-theme-tokens")).toBeNull();
    expect(document.getElementById("aura-user-theme-css")).toBeNull();
  });

  it("leaves an approved theme's CSS out where cascade layers are missing, and keeps its tokens", () => {
    delete g.CSSLayerBlockRule;
    expect(cssLayersSupported()).toBe(false);
    applyTheme({ base: "dark", theme: theme({ base: "dark", css: ".sidebar { display: none }", approval: "approved" }), problem: null });
    expect(document.getElementById("aura-user-theme-css")).toBeNull();
    const rule = (document.getElementById("aura-user-theme-tokens") as HTMLStyleElement).sheet!.cssRules[0] as CSSStyleRule;
    expect(rule.style.getPropertyValue("--md-primary").trim()).toBe("#0066cc");
    g.CSSLayerBlockRule = class {};
    expect(cssLayersSupported()).toBe(true);
    applyTheme({ base: "dark", theme: theme({ base: "dark", css: ".sidebar { display: none }", approval: "approved" }), problem: null });
    expect(document.getElementById("aura-user-theme-css")).not.toBeNull();
  });

  it("keeps its styles last in <head>, after styles added later", () => {
    applyTheme({ base: "dark", theme: theme({ base: "dark" }), problem: null });
    const late = document.createElement("style");
    document.head.appendChild(late);
    applyTheme({ base: "dark", theme: theme({ base: "dark", tokens: { "--fg": "#eee" } }), problem: null });
    expect(document.head.lastElementChild?.id).toBe("aura-user-theme-tokens");
  });
});
