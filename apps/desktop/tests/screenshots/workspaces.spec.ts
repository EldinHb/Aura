import { expect, test, type Page } from "@playwright/test";
import type { Session, Workspace } from "../../src/gen";

/**
 * Workspaces: the sidebar with two workspaces (switcher, a leader with its
 * workers, the Elsewhere and Scheduled runs blocks), the workspace list, and
 * the worker cleanup dialog. Not a README shot; run it on its own:
 *   SHOTS=/tmp/workspaces pnpm exec playwright test -c playwright.screenshots.config.ts workspaces
 */
const OUT = process.env.SHOTS ?? "test-results/workspaces";
const now = Date.now();
const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
const usage = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, total_cost_usd: null, context_window: null, context_used: null, running_totals: false };

function session(id: string, over: Partial<Session>): Session {
  return { id, title: id, provider: "claude", agent: null, native_id: null, cwd: "/Users/sam/code/aura", worktree: null, group: null, workspace: "client", status: "idle", mode: "structured", model: null, effort: null, permission_mode: null, sandbox_mode: null, command: null, created_at: at(240), last_activity: at(10), archived: false, pinned: false, last_error: null, pending_count: 0, exit_code: null, system_prompt: null, orchestrator: false, orchestrator_id: null, feature_owner: false, specialist_id: null, specialist_name: null, folderless: false, attention: null, scheduled_task_id: null, scheduled_task_name: null, usage, ...over };
}

const id = (n: number) => `5e55a0e0-0000-4000-8000-${String(n).padStart(12, "0")}`;
const lead = id(1);
const workspaces: Workspace[] = [
  { id: "client", name: "Aura client work", created_at: at(9000), position: 0 },
  { id: "infra", name: "Infra", created_at: at(8000), position: 1 },
];
const sessions: Session[] = [
  session(lead, { title: "Login revamp", feature_owner: true, orchestrator: true, folderless: true, cwd: "/data/o", last_activity: at(2) }),
  session(id(2), { title: "UX designer", orchestrator_id: lead, specialist_name: "UX designer", attention: "done", created_at: at(200), last_activity: at(120) }),
  session(id(3), { title: "Backend dev", orchestrator_id: lead, specialist_name: "Backend engineer", status: "running", created_at: at(190), last_activity: at(1) }),
  session(id(4), { title: "Frontend dev", orchestrator_id: lead, specialist_name: "Frontend engineer", status: "running", created_at: at(180), last_activity: at(1) }),
  session(id(5), { title: "Tester", orchestrator_id: lead, specialist_name: "Tester (QA)", status: "waiting_approval", pending_count: 1, attention: "waiting", created_at: at(170), last_activity: at(4) }),
  session(id(6), { title: "Researcher", orchestrator_id: lead, orchestrator: true, created_at: at(160), last_activity: at(60 * 24) }),
  session(id(7), { title: "Source survey", orchestrator_id: id(6), attention: "failed", status: "error", created_at: at(150), last_activity: at(60 * 24) }),
  session(id(10), { title: "Fix flaky e2e", status: "running", last_activity: at(3) }),
  session(id(11), { title: "Changelog for 0.5", provider: "codex", last_activity: at(90) }),
  session(id(20), { title: "Review PR #12", workspace: "infra", pending_count: 1, attention: "waiting", last_activity: at(6) }),
  session(id(21), { title: "Spike caching", workspace: "infra", orchestrator: true, last_activity: at(30) }),
  session(id(22), { title: "Benchmark", workspace: "infra", orchestrator_id: id(21), attention: "waiting", last_activity: at(8) }),
  session(id(23), { title: "Terraform drift", workspace: "infra", last_activity: at(300) }),
  session(id(24), { title: "Rotate certs", workspace: "infra", last_activity: at(600) }),
  session(id(30), { title: "Nightly deps · 03:00", workspace: "infra", scheduled_task_id: "t1", scheduled_task_name: "Nightly deps", status: "running", created_at: at(20) }),
];

async function mockDaemon(page: Page) {
  await page.routeWebSocket("ws://127.0.0.1:19998/**", (socket) => {
    socket.onMessage((raw) => {
      if (typeof raw !== "string") return;
      const { id: rid, method, params } = JSON.parse(raw);
      let result: unknown = null;
      switch (method) {
        case "daemon.info": result = { port: 19998, token: "shots", pid: 1, version: "0.5.0", started_at: at(600), data_dir: "/tmp" }; break;
        case "provider.list": result = []; break;
        case "session.list": result = sessions; break;
        case "session.get": result = sessions.find((s) => s.id === params.id); break;
        case "session.pending": result = { approvals: [], inputs: [] }; break;
        case "mods.inbox": result = []; break;
        case "workspace.list": result = workspaces; break;
        case "workspace.touch": result = true; break;
        default:
          if (/history|commands|native|list|candidates|status|diff_stat|log|worktrees|branches/.test(method)) result = [];
      }
      socket.send(JSON.stringify({ id: rid, result }));
    });
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("aura.workspace", "client");
    localStorage.setItem("aura.sidebar-expanded.v1", "[]");
  });
  await page.setViewportSize({ width: 1200, height: 900 });
  await mockDaemon(page);
  await page.goto(`/?port=19998&token=shots&session=${id(10)}`);
  await expect(page.locator(`[data-session-id="${lead}"]`)).toBeVisible();
});

test("sidebar with two workspaces, a collapsed leader peeking at the worker that waits", async ({ page }) => {
  await page.waitForTimeout(300);
  await page.locator(".sidebar").screenshot({ path: `${OUT}/sidebar-collapsed.png` });
});

test("sidebar with the leader expanded", async ({ page }) => {
  await page.locator(`[data-session-id="${lead}"] .orchestra-toggle`).click();
  await expect(page.locator(`[data-session-id="${id(7)}"]`)).toBeVisible();
  await page.waitForTimeout(300);
  await page.locator(".sidebar").screenshot({ path: `${OUT}/sidebar-expanded.png` });
});

test("workspace list", async ({ page }) => {
  await page.getByRole("button", { name: /^Workspace: / }).click();
  await expect(page.getByRole("listbox", { name: "Workspaces" })).toBeVisible();
  await page.waitForTimeout(200);
  await page.locator(".sidebar").screenshot({ path: `${OUT}/switcher.png` });
});

test("worker cleanup dialog", async ({ page }) => {
  await page.getByRole("button", { name: "Workspace actions" }).click();
  await page.getByRole("menuitem", { name: "Clean up worker sessions…" }).click();
  await expect(page.getByRole("group", { name: "Login revamp" })).toBeVisible();
  await page.waitForTimeout(200);
  await page.locator(".modal").screenshot({ path: `${OUT}/cleanup.png` });
});
