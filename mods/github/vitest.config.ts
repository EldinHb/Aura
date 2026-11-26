import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
// UI tests render with the desktop app's React DOM and Testing Library rather than
// bundling copies of their own; both resolve the same React as this mod.
const desktop = path.resolve(here, "../../apps/desktop/node_modules");

export default defineConfig({
  resolve: {
    alias: [
      // At runtime "@aura/host" is Aura's live module; tests get a small stand-in.
      { find: /^@aura\/host$/, replacement: path.resolve(here, "src/test/host.tsx") },
      { find: /^@testing-library\/react$/, replacement: path.join(desktop, "@testing-library/react") },
      { find: /^react-dom$/, replacement: path.join(desktop, "react-dom") },
      { find: /^react-dom\/(.*)$/, replacement: path.join(desktop, "react-dom/$1") },
    ],
  },
  esbuild: { jsx: "automatic" },
  test: {
    // Daemon tests run in node; UI tests opt into jsdom with `// @vitest-environment jsdom`.
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
