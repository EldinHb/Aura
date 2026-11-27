// Runs before Aura's first paint: index.html loads it, blocking, in <head>
// (a file, because the CSP allows no inline script). It shows the theme this
// window showed last, from localStorage, so the window does not flash dark
// before React starts. state/themes.ts takes over from there; keep the two in
// step (the same keys, selector and rules).
(function () {
  try {
    var root = document.documentElement;
    var saved = JSON.parse(localStorage.getItem("aura.settings.v1") || "{}");
    var choice = typeof saved.theme === "string" ? saved.theme : "dark";
    var light = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches;
    if (choice === "system") {
      root.dataset.theme = light ? "light" : "dark";
      return;
    }
    if (choice === "dark" || choice === "light") {
      root.dataset.theme = choice;
      return;
    }
    var t = JSON.parse(localStorage.getItem("aura.theme.cache.v1") || "null");
    if (!t || t.id !== choice || (t.base !== "dark" && t.base !== "light")) {
      root.dataset.theme = "dark";
      return;
    }
    root.dataset.theme = t.base;
    root.dataset.userTheme = t.id;
    var el = document.createElement("style");
    el.id = "aura-user-theme-tokens";
    el.textContent = ":root:root[data-user-theme] {}";
    document.head.appendChild(el);
    var rule = el.sheet && el.sheet.cssRules[0];
    var tokens = t.tokens || {};
    if (rule) {
      for (var name in tokens) {
        // One value per property, set by the browser's parser: never a declaration of its own.
        var v = tokens[name];
        if (/^--[a-z0-9-]+$/.test(name) && typeof v === "string" && !/[{}]/.test(v)) rule.style.setProperty(name, v);
      }
    }
    // Without cascade layers approval prompts cannot be protected from theme CSS: tokens only.
    if (typeof t.css === "string" && t.css && t.approval !== "needs_approval" && typeof window.CSSLayerBlockRule === "function") {
      var css = document.createElement("style");
      css.id = "aura-user-theme-css";
      css.textContent = t.css;
      document.head.appendChild(css);
    }
  } catch (e) {
    /* no storage: the default dark theme */
  }
})();
