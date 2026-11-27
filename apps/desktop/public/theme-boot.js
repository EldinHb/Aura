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
    // localStorage is not the daemon: anything that wrote it could have put a
    // URL there. Only plainly safe values are shown before the daemon's
    // validated list arrives (the same rule as bootSafeValue in state/themes.ts):
    // no escapes, one value, functions from a short list, url() only as a
    // whole quoted data: URL. A theme's CSS is never applied from the cache.
    var SAFE = { rgb: 1, rgba: 1, hsl: 1, hsla: 1, hwb: 1, lab: 1, lch: 1, oklab: 1, oklch: 1, color: 1, "color-mix": 1, var: 1, calc: 1, min: 1, max: 1, clamp: 1 };
    var safe = function (v) {
      if (typeof v !== "string" || v.indexOf("\\") >= 0 || /[{};!]/.test(v.replace(/(["'])(?:(?!\1).)*\1/g, ""))) return false;
      if (/^url\(\s*(?:'data:[^'\\]*'|"data:[^"\\]*")\s*\)$/i.test(v.trim())) return true;
      var re = /([a-zA-Z_-][\w-]*)\s*\(/g;
      var m;
      while ((m = re.exec(v))) if (!SAFE[m[1].toLowerCase()]) return false;
      return true;
    };
    if (rule) {
      for (var name in tokens) {
        if (/^--[a-z0-9-]+$/.test(name) && safe(tokens[name])) rule.style.setProperty(name, tokens[name]);
      }
    }
  } catch (e) {
    /* no storage: the default dark theme */
  }
})();
