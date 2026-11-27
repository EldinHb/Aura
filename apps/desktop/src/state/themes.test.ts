import { afterEach, describe, expect, it } from "vitest";
import { applyTheme, resolveTheme, tokenCss, type UserTheme } from "./themes";

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

describe("tokenCss", () => {
  it("writes the overrides with a selector that outranks the base themes", () => {
    expect(tokenCss(theme({ tokens: { "--fg": "#fff", "--bg": "var(--md-surface)" } }))).toBe(
      ":root:root[data-user-theme] {\n  --fg: #fff;\n  --bg: var(--md-surface);\n}\n",
    );
  });

  it("drops anything that could leave the rule", () => {
    const css = tokenCss(theme({ tokens: { "--fg": "red } body { display: none", "--x;y": "1", "--ok": "1px" } }));
    expect(css).not.toContain("display");
    expect(css).not.toContain("--x;y");
    expect(css).toContain("--ok: 1px;");
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
    expect(document.getElementById("aura-user-theme-tokens")?.textContent).toContain("--md-primary: #0066cc;");
    expect(document.getElementById("aura-user-theme-css")?.textContent).toBe(".sidebar { opacity: 0.9 }");

    applyTheme({ base: "dark", theme: null, problem: null });
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.userTheme).toBeUndefined();
    expect(document.getElementById("aura-user-theme-tokens")).toBeNull();
    expect(document.getElementById("aura-user-theme-css")).toBeNull();
  });

  it("keeps its styles last in <head>, after styles added later", () => {
    applyTheme({ base: "dark", theme: theme({ base: "dark" }), problem: null });
    const late = document.createElement("style");
    document.head.appendChild(late);
    applyTheme({ base: "dark", theme: theme({ base: "dark", tokens: { "--fg": "#eee" } }), problem: null });
    expect(document.head.lastElementChild?.id).toBe("aura-user-theme-tokens");
  });
});
