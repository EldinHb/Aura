import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { Session } from "../../src/gen";

/**
 * The pr-status mod's cards in the Inspector, loaded from its build (mods/pr-status/dist, made by
 * ./scripts/build-mods.sh) by a fake daemon. Not a README shot; run it on its own:
 *   SHOTS=/tmp/pr-status-shots pnpm exec playwright test -c playwright.screenshots.config.ts tests/screenshots/pr-status.spec.ts
 */
const OUT = process.env.SHOTS ?? "test-results/pr-status";
const now = Date.parse("2026-11-27T10:00:00Z");
const at = (secAgo: number) => new Date(now - secAgo * 1000).toISOString();
const usage = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, total_cost_usd: null, context_window: null, context_used: null, running_totals: false };
const dist = new URL("../../../../mods/pr-status/dist/", import.meta.url);

function session(id: string, over: Partial<Session>): Session {
  return { id, title: id, provider: "claude", agent: null, native_id: null, cwd: "/Users/sam/code/acme-api", worktree: null, group: "acme", status: "idle", mode: "structured", model: null, effort: null, permission_mode: null, sandbox_mode: null, command: null, created_at: at(7200), last_activity: at(60), archived: false, pinned: false, last_error: null, pending_count: 0, exit_code: null, system_prompt: null, orchestrator: false, orchestrator_id: null, feature_owner: false, specialist_id: null, specialist_name: null, folderless: false, attention: null, scheduled_task_id: null, scheduled_task_name: null, usage, ...over };
}

const id = (n: number) => `9a1b2c3d-0000-4000-8000-${String(n).padStart(12, "0")}`;
const lead = id(1), api = id(2), docs = id(3);
const sessions: Session[] = [
  session(lead, { title: "Public API rate limits", orchestrator: true }),
  session(api, { title: "Rate limiter middleware", orchestrator_id: lead }),
  session(docs, { title: "API reference docs", orchestrator_id: api, provider: "codex" }),
];

const pr = (number: number, title: string, from: Array<[string, string, boolean]>, status: Record<string, unknown>) => ({
  ref: { url: `https://github.com/acme/api/pull/${number}`, repo: "acme/api", number, sources: from.map(([sessionId, t, worker]) => ({ sessionId, title: t, worker })) },
  status: { url: `https://github.com/acme/api/pull/${number}`, repo: "acme/api", number, title, author: "sam", ...status },
  readAt: at(12),
  error: null,
});
const check = (name: string, state: string) => ({ name, url: `https://github.com/acme/api/actions/runs/1/${name}`, state });

const ready = pr(412, "Add per-plan rate limiting", [[lead, "Public API rate limits", false], [api, "Rate limiter middleware", true]], {
  state: "open",
  reviewers: { reviewed: [{ name: "alice", kind: "user", state: "APPROVED", previous: null }, { name: "dmitri", kind: "user", state: "APPROVED", previous: null }], pending: [] },
  checks: { state: "passing", passing: 12, failing: 0, pending: 0, total: 12, open: [] },
  readiness: { ready: true, reasons: [] },
});
const failing = pr(415, "Return Retry-After on 429 responses", [[api, "Rate limiter middleware", true]], {
  state: "open",
  reviewers: {
    reviewed: [{ name: "carol", kind: "user", state: "COMMENTED", previous: null }],
    pending: [{ name: "bob", kind: "user", state: "PENDING", previous: "CHANGES_REQUESTED" }, { name: "acme/platform", kind: "team", state: "PENDING", previous: null }],
  },
  checks: { state: "failing", passing: 9, failing: 2, pending: 1, total: 12, open: [check("integration-tests", "failing"), check("lint", "failing"), check("e2e (chromium)", "pending")] },
  readiness: { ready: false, reasons: ["review_required", "checks_failing"] },
});
const merged = pr(409, "Document the rate limit headers", [[docs, "API reference docs", true]], {
  state: "merged",
  reviewers: { reviewed: [{ name: "alice", kind: "user", state: "APPROVED", previous: null }], pending: [] },
  checks: { state: "passing", passing: 4, failing: 0, pending: 0, total: 4, open: [] },
  readiness: null,
});
const view = { sessionId: lead, pulls: [ready, failing, merged], blocked: null };

const modInfo = { id: "pr-status", name: "PR status", version: "1.0.0", source: "bundled", dir: "/bundled/pr-status", status: { state: "running" }, enabled: true, approved: true, hasUi: true, hasDaemon: true, permissions: {}, dependsOn: {}, settings: [], settingValues: {} };

async function mockDaemon(page: Page) {
  const js = readFileSync(new URL("ui.js", dist), "utf8");
  const css = readFileSync(new URL("ui.css", dist), "utf8");
  await page.routeWebSocket("ws://127.0.0.1:19998/**", (socket) => {
    socket.onMessage((raw) => {
      if (typeof raw !== "string") return;
      const { id: rid, method, params } = JSON.parse(raw);
      let result: unknown = null;
      switch (method) {
        case "daemon.info": result = { port: 19998, token: "shots", pid: 1, version: "0.4.0", started_at: at(36000), data_dir: "/tmp" }; break;
        case "provider.list": result = []; break;
        case "session.list": result = sessions; break;
        case "session.get": result = sessions.find((s) => s.id === params.id); break;
        case "session.pending": result = { approvals: [], inputs: [] }; break;
        case "mods.list": result = [modInfo]; break;
        case "mods.ui_source": result = { js, css, version: "1.0.0" }; break;
        case "mod.pr-status.watch": case "mod.pr-status.view": case "mod.pr-status.refresh": result = { ...view, sessionId: params.sessionId }; break;
        case "mod.pr-status.unwatch": result = true; break;
        case "git.branch_status": result = null; break;
        default:
          if (/history|commands|native|list|candidates|inbox|status|diff|log|worktrees|branches/.test(method)) result = [];
      }
      socket.send(JSON.stringify({ id: rid, result }));
    });
  });
}

for (const theme of ["dark", "light"] as const) {
  test(`pr status cards ${theme}`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem("aura.settings.v1", JSON.stringify({ theme: t })), theme);
    await mockDaemon(page);
    await page.clock.setFixedTime(now);
    await page.goto(`/?port=19998&token=shots&session=${lead}`);
    const section = page.locator(".pr-status");
    await expect(section.getByRole("article")).toHaveCount(3);
    await section.getByRole("button", { name: /Checks failing/ }).click();
    await page.waitForTimeout(300);
    await page.locator('[data-region="inspector"]').screenshot({ path: `${OUT}/${theme}-inspector.png` });
    if (theme === "dark") {
      await section.getByRole("article", { name: /#412/ }).screenshot({ path: `${OUT}/1-ready.png` });
      await section.getByRole("article", { name: /#415/ }).screenshot({ path: `${OUT}/2-failing-checks-pending-reviewer.png` });
      await section.getByRole("article", { name: /#409/ }).screenshot({ path: `${OUT}/3-merged.png` });
    }
  });
}
