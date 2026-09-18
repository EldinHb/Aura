import { defineConfig } from "@playwright/test";

/** Runs against the Vite dev server (pnpm dev) which proxies the daemon's daemon.json. */
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  retries: 0,
  reporter: "list",
  use: { baseURL: "http://localhost:1420", headless: true, viewport: { width: 1400, height: 900 } },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: undefined,
});
