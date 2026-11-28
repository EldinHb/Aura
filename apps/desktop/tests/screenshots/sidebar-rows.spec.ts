import { expect, test, type Page } from "@playwright/test";
import type { BranchStatus, Session } from "../../src/gen";

/**
 * Sidebar rows crowded with tags (orchestrator, workers chip, agent, branch
 * state) and unseen markers (done, failed, waiting on you)
 * at the default and a narrow sidebar width, in both themes. Not a README shot; run it on its own when changing the row layout:
 *   SHOTS=/tmp/rows pnpm exec playwright test -c playwright.screenshots.config.ts sidebar-rows
 */
const OUT = process.env.SHOTS ?? "test-results/sidebar-rows";
const now = Date.now();
const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
const usage = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0, total_cost_usd: null, context_window: null, context_used: null, running_totals: false };

function session(id: string, over: Partial<Session>): Session {
  return { id, title: id, provider: "claude", agent: null, native_id: null, cwd: "/Users/sam/code/vidara.portal", worktree: null, group: "Vidara Portal", workspace: "default", status: "idle", mode: "structured", model: null, effort: null, permission_mode: null, sandbox_mode: null, command: null, created_at: at(240), last_activity: at(10), archived: false, pinned: false, last_error: null, pending_count: 0, exit_code: null, system_prompt: null, orchestrator: false, orchestrator_id: null, feature_owner: false, specialist_id: null, specialist_name: null, folderless: false, attention: null, scheduled_task_id: null, scheduled_task_name: null, usage, ...over };
}

const id = (n: number) => `5e55a0e0-0000-4000-8000-${String(n).padStart(12, "0")}`;
const portal = id(1), customer = id(20), billing = id(30);
const sessions: Session[] = [
  session(portal, { title: "Portal improvements across the admin pages", orchestrator: true, status: "running" }),
  ...[2, 3, 4, 5, 6, 7].map((n) => session(id(n), { title: `Portal worker ${n}`, orchestrator_id: portal, status: n === 4 ? "waiting_input" : n === 3 ? "idle" : "running", pending_count: n === 4 ? 1 : 0, attention: n === 4 ? "waiting" : n === 3 ? "done" : null })),
  session(customer, { title: "user management for the customer portal", orchestrator: true, group: "Customer Portal", cwd: "/Users/sam/code/wortell.client-portal", last_activity: at(10), attention: "done" }),
  session(id(21), { title: "Invite flow with role picker", provider: "codex", group: "Customer Portal", cwd: "/Users/sam/code/wortell.client-portal", orchestrator_id: customer, worktree: { repo_root: "/Users/sam/code/wortell.client-portal", path: "/tmp/wt", branch: "invite-flow" }, model: "gpt-5.5-codex", status: "waiting_approval", pending_count: 2 }),
  session(id(22), { title: "Nested reviewer of the invite flow", provider: "acp", agent: "gemini", group: "Customer Portal", cwd: "/Users/sam/code/wortell.client-portal", orchestrator_id: id(21), last_activity: at(3), status: "error", attention: "failed" }),
  session(billing, { title: "Move billing to Stripe webhooks", provider: "codex", group: "Customer Portal", cwd: "/Users/sam/code/acme-billing-service-with-a-long-name", model: "gpt-5.5-codex", pinned: true, last_activity: at(90) }),
  session(id(40), { title: "pnpm dev", provider: "terminal", mode: "terminal", group: null, cwd: "/Users/sam/code/vidara.portal", status: "exited", exit_code: 0, attention: "done", last_activity: at(60 * 26) }),
];

const git: Record<string, BranchStatus> = {
  "/Users/sam/code/vidara.portal": { branch: "portal-admin-improvements", head: "4f9c2e1", upstream: "origin/portal-admin-improvements", upstream_branch: "portal-admin-improvements", upstream_repo: "vidara/portal", ahead: 2, behind: 0, changed: 5 },
  "/Users/sam/code/acme-billing-service-with-a-long-name": { branch: "stripe-webhooks", head: "9a8b7c6", upstream: null, upstream_branch: null, upstream_repo: null, ahead: 0, behind: 3, changed: 0 },
};

async function mockDaemon(page: Page) {
  await page.routeWebSocket("ws://127.0.0.1:19998/**", (socket) => {
    socket.onMessage((raw) => {
      if (typeof raw !== "string") return;
      const { id: rid, method, params } = JSON.parse(raw);
      let result: unknown = null;
      switch (method) {
        case "daemon.info": result = { port: 19998, token: "shots", pid: 1, version: "0.2.10", started_at: at(600), data_dir: "/tmp" }; break;
        case "provider.list": result = []; break;
        case "session.list": result = sessions; break;
        case "session.get": result = sessions.find((s) => s.id === params.id); break;
        case "session.pending": result = { approvals: [], inputs: [] }; break;
        case "mods.inbox": result = []; break;
        case "git.branch_status": result = git[params.cwd] ?? null; break;
        default:
          if (/history|commands|native|list|candidates|status|diff_stat|log|worktrees|branches/.test(method)) result = [];
      }
      socket.send(JSON.stringify({ id: rid, result }));
    });
  });
}

for (const theme of ["dark", "light"] as const) {
  for (const [label, width] of [["default", 280], ["narrow", 220]] as const) {
    test(`rows ${theme} ${label}`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem("aura.settings.v1", JSON.stringify({ theme: t })), theme);
      await page.setViewportSize({ width: 1100, height: 1000 });
      await mockDaemon(page);
      await page.goto(`/?port=19998&token=shots&session=${billing}`);
      // Leaders start collapsed: the Vidara orchestrator shows "6 workers · 1 needs you", and its waiting worker peeks out.
      await expect(page.locator(`[data-session-id="${portal}"] .chip.workers`)).toBeVisible();
      await page.locator(`[data-session-id="${id(21)}"]`).click();
      await page.evaluate((w) => document.documentElement.style.setProperty("--sidebar-w", `${w}px`), width);
      await expect(page.locator(`[data-session-id="${id(40)}"] .where`)).toContainText("⎇ portal-admin-improvements");
      await page.waitForTimeout(400);
      await page.locator(".sidebar").screenshot({ path: `${OUT}/${theme}-${label}.png` });
    });
  }
}

test("rows with hint labels", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 1000 });
  await mockDaemon(page);
  await page.goto(`/?port=19998&token=shots&session=${billing}`);
  await expect(page.locator(`[data-session-id="${id(40)}"] .where`)).toContainText("⎇ portal-admin-improvements");
  await page.evaluate(async () => {
    // A path in a variable, so the type checker leaves this browser-side import alone.
    const path = "/src/lib/commands.ts";
    const commands = (await import(/* @vite-ignore */ path)) as { runCommand: (id: string) => void };
    commands.runCommand("hints.enter");
  });
  await expect(page.locator(".hint-label").first()).toBeVisible();
  await page.screenshot({ path: `${OUT}/hints.png`, clip: { x: 0, y: 0, width: 300, height: 700 } });
});
