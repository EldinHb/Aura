import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Daemon tests run in node; UI tests opt into jsdom with `// @vitest-environment jsdom`.
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
