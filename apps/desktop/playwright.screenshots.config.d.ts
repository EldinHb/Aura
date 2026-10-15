/**
 * Regenerates the README screenshots against a fake daemon (see tests/screenshots).
 * Starts its own Vite server on a separate port with an empty data dir, so it never
 * talks to a running Aura.  Run: pnpm exec playwright test -c playwright.screenshots.config.ts
 */
declare const _default: import("@playwright/test").PlaywrightTestConfig<{}, {}>;
export default _default;
