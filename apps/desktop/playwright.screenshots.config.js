import { defineConfig } from "@playwright/test";
/**
 * Regenerates the README screenshots against a fake daemon (see tests/screenshots).
 * Starts its own Vite server on a separate port with an empty data dir, so it never
 * talks to a running Aura.  Run: pnpm exec playwright test -c playwright.screenshots.config.ts
 */
export default defineConfig({
    testDir: "./tests/screenshots",
    timeout: 60000,
    reporter: "list",
    use: { baseURL: "http://localhost:1430", headless: true, viewport: { width: 1440, height: 880 }, deviceScaleFactor: 2, colorScheme: "dark" },
    projects: [{ name: "chromium", use: { browserName: "chromium" } }],
    webServer: { command: "pnpm exec vite --port 1430 --strictPort", url: "http://localhost:1430", reuseExistingServer: false, env: { AURA_DATA_DIR: "/nonexistent-aura-screenshots" } },
});
