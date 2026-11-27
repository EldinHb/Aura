import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { Session } from "../../src/gen";

/**
 * The pr-status mod's PR page (`pr` view) in a main-area tab, opened from its card, against a fake
 * daemon serving the mod's build (./scripts/build-mods.sh). A long conversation and a multi-file
 * diff, in both themes, with the main area about 1000 and 700 px wide. Not a README shot:
 *   SHOTS=/tmp/pr-status-shots/v3 pnpm exec playwright test -c playwright.screenshots.config.ts tests/screenshots/pr-page.spec.ts
 */
const OUT = process.env.SHOTS ?? "test-results/pr-page";
const now = Date.parse("2026-11-27T10:00:00Z");
const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
const usage = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, total_cost_usd: null, context_window: null, context_used: null, running_totals: false };
const mods = new URL("../../../../mods/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, mods), "utf8");

function session(id: string, over: Partial<Session>): Session {
  return { id, title: id, provider: "claude", agent: null, native_id: null, cwd: "/Users/sam/code/customer-portal-backend", worktree: null, group: "wortell", workspace: "default", status: "idle", mode: "structured", model: null, effort: null, permission_mode: null, sandbox_mode: null, command: null, created_at: at(600), last_activity: at(2), archived: false, pinned: false, last_error: null, pending_count: 0, exit_code: null, system_prompt: null, orchestrator: false, orchestrator_id: null, feature_owner: false, specialist_id: null, specialist_name: null, folderless: false, attention: null, scheduled_task_id: null, scheduled_task_name: null, usage, ...over };
}
const lead = "9a1b2c3d-0000-4000-8000-000000000101";
const worker = "9a1b2c3d-0000-4000-8000-000000000102";
const sessions = [session(lead, { title: "Customer portal news", orchestrator: true }), session(worker, { title: "#1290 rate limits for the news API", orchestrator_id: lead })];

const repo = "wortell/customer-portal-backend";
const url = `https://github.com/${repo}/pull/1290`;
const title = ":sparkles: Rate limit the news API per tenant and per key, with Retry-After on 429";
const person = (name: string, state: string, previous: string | null = null) => ({ name, kind: name.includes("/") ? "team" : "user", state, previous });
const status = {
  url, repo, number: 1290, title, author: "eldin", updatedAt: at(60), state: "open",
  reviewers: { reviewed: [person("Renevdo", "APPROVED"), person("martijntakken", "COMMENTED")], pending: [person("wortell/portal-maintainers", "PENDING")], complete: true },
  checks: { state: "passing", passing: 11, failing: 0, pending: 0, total: 11, open: [], complete: true },
  readiness: { ready: true, reasons: [] },
  merge: { reviewDecision: "APPROVED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headSha: "f".repeat(40), headRef: "feature/news-rate-limits", sameRepo: true, squashAllowed: true, canMerge: true, account: "github.com:eldin" },
};
const body = `## What

Rate limits for the news API, **per tenant** and **per API key**, read from the tenant settings.

- A token bucket per tenant (Redis), refilled every second
- \`429 Too Many Requests\` with a \`Retry-After\` header
- Limits can be raised per tenant without a deploy

## How to test

1. \`pnpm test\`
2. Call \`GET /news\` 101 times within a minute with one key; the last call returns 429.

Closes #1281.`;
const timeline = [
  { kind: "commit", at: at(300), author: "eldin", sha: "4b1c2d9", message: "Add a token bucket per tenant", url },
  { kind: "commit", at: at(290), author: "eldin", sha: "9e0a7f1", message: "Read the limits from the tenant settings", url },
  { kind: "review_requested", at: at(285), actor: "eldin", reviewer: "Renevdo" },
  { kind: "review_requested", at: at(285), actor: "eldin", reviewer: "wortell/portal-maintainers" },
  { kind: "labeled", at: at(284), actor: "eldin", label: { name: "enhancement", color: "a2eeef" } },
  { kind: "labeled", at: at(284), actor: "eldin", label: { name: "api", color: "1d76db" } },
  { kind: "comment", author: "martijntakken", body: "Do we also need a limit per **IP** for anonymous calls? The public feed is open.", at: at(240), url },
  { kind: "comment", author: "eldin", body: "Good point. Anonymous calls go through the CDN, which already limits per IP; I added a note to the README.", at: at(230), url },
  { kind: "review", state: "CHANGES_REQUESTED", author: "Renevdo", body: "Nice work. Two things before this can go in:", at: at(200), url, comments: [
    { author: "Renevdo", body: "This should be `Math.ceil`, otherwise a client retries one second too early.", at: at(200), url, path: "src/middleware/rateLimit.ts", line: 14,
      snippet: ["   } catch (e) {", "-    res.set(\"Retry-After\", String(e.msBeforeNext / 1000));", "+    res.set(\"Retry-After\", String(Math.floor(e.msBeforeNext / 1000)));", "     res.status(429).json({ error: \"rate_limited\" });"] },
    { author: "Renevdo", body: "Can the bucket size come from the tenant settings too?", at: at(199), url, path: "src/limits/bucket.ts", line: 8,
      snippet: [" export function bucketFor(tenant: Tenant) {", "+  return new TokenBucket({ size: 100, refillPerSecond: 2 });"] },
  ] },
  { kind: "force_push", at: at(150), actor: "eldin", before: "9e0a7f1", after: "c31d0b2" },
  { kind: "commit", at: at(149), author: "eldin", sha: "c31d0b2", message: "Round Retry-After up and size buckets per tenant", url },
  { kind: "review", state: "APPROVED", author: "Renevdo", body: "Thanks, looks good now.", at: at(90), url, comments: [] },
  { kind: "review", state: "COMMENTED", author: "martijntakken", body: "LGTM from the frontend side.", at: at(60), url, comments: [] },
];
const check = (name: string, workflow: string, state: string, label: string, seconds: number | null) => ({ name, workflow, state, label, seconds, url });
const page = {
  repo, number: 1290, url, title, author: "eldin", createdAt: at(310), body, base: "main", head: "feature/news-rate-limits", headRepo: repo,
  baseSha: "0".repeat(40), headSha: status.merge.headSha,
  commitCount: 3, changedFiles: 4, additions: 186, deletions: 12,
  assignees: ["eldin"], labels: [{ name: "enhancement", color: "a2eeef" }, { name: "api", color: "1d76db" }], milestone: { title: "Portal 2.4", url },
  timeline,
  commits: [
    { sha: "4b1c2d9".padEnd(40, "0"), short: "4b1c2d9", message: "Add a token bucket per tenant", author: "eldin", at: at(300), url },
    { sha: "9e0a7f1".padEnd(40, "0"), short: "9e0a7f1", message: "Read the limits from the tenant settings", author: "eldin", at: at(290), url },
    { sha: "c31d0b2".padEnd(40, "0"), short: "c31d0b2", message: "Round Retry-After up and size buckets per tenant", author: "eldin", at: at(149), url },
  ],
  checks: [
    check("build (ubuntu-latest)", "CI", "passing", "Success", 214), check("unit tests", "CI", "passing", "Success", 388), check("lint", "CI", "passing", "Success", 41),
    check("integration tests (acc)", "Integration", "passing", "Success", 912), check("CodeQL", "Code scanning", "passing", "Success", 301), check("deploy preview", "Preview", "skipped", "Skipped", null),
  ],
  commentCount: 6, status, complete: true, readAt: at(0.2), nextMs: 60_000,
};
const files = [
  { path: "src/middleware/rateLimit.ts", previous: null, status: "added", additions: 24, deletions: 0, patch: "@@ -0,0 +1,24 @@\n+import { bucketFor } from \"../limits/bucket\";\n+import type { Request, Response, NextFunction } from \"express\";\n+\n+/** 429 with Retry-After once a tenant's or a key's bucket is empty. */\n+export async function rateLimit(req: Request, res: Response, next: NextFunction) {\n+  const bucket = bucketFor(req.tenant);\n+  try {\n+    await bucket.take(req.apiKey ?? req.ip);\n+    next();\n+  } catch (e) {\n+    res.set(\"Retry-After\", String(Math.ceil(e.msBeforeNext / 1000)));\n+    res.status(429).json({ error: \"rate_limited\" });\n+  }\n+}" },
  { path: "src/limits/bucket.ts", previous: null, status: "added", additions: 31, deletions: 0, patch: "@@ -0,0 +1,12 @@\n+import { TokenBucket } from \"./tokenBucket\";\n+import type { Tenant } from \"../tenants\";\n+\n+const buckets = new Map<string, TokenBucket>();\n+\n+export function bucketFor(tenant: Tenant) {\n+  let bucket = buckets.get(tenant.id);\n+  if (!bucket) {\n+    bucket = new TokenBucket({ size: tenant.limits.burst, refillPerSecond: tenant.limits.perSecond });\n+    buckets.set(tenant.id, bucket);\n+  }\n+  return bucket;\n+}" },
  { path: "src/routes/news.ts", previous: null, status: "modified", additions: 3, deletions: 2, patch: "@@ -1,9 +1,10 @@\n import { Router } from \"express\";\n+import { rateLimit } from \"../middleware/rateLimit\";\n import { listNews, getArticle } from \"../news\";\n \n export const news = Router();\n \n-news.get(\"/news\", listNews);\n-news.get(\"/news/:id\", getArticle);\n+news.get(\"/news\", rateLimit, listNews);\n+news.get(\"/news/:id\", rateLimit, getArticle);\n" },
  { path: "test/fixtures/tenants.json", previous: null, status: "modified", additions: 128, deletions: 10, patch: null },
];
const view = { sessionId: lead, blocked: null, pulls: [{ ref: { url, repo, number: 1290, sources: [{ sessionId: worker, title: sessions[1].title, worker: true }] }, status, readAt: at(0.2), error: null }] };
const modInfo = { id: "pr-status", name: "PR status", version: "1.0.0", source: "bundled", dir: "/bundled/pr-status", status: { state: "running" }, enabled: true, approved: true, hasUi: true, hasDaemon: true, permissions: {}, dependsOn: {}, settings: [], settingValues: {} };

/** The page of a busy PR: four-digit counts on every tab. */
let busy = false;
const busyPage = () => ({ ...page, commentCount: 1284, commitCount: 1045, changedFiles: 3000, checks: Array.from({ length: 1187 }, (_, i) => check(`job ${i}`, "CI", "passing", "Success", 60)) });

async function mockDaemon(p: Page) {
  const js = read("pr-status/dist/ui.js");
  const css = read("pr-status/dist/ui.css");
  await p.routeWebSocket("ws://127.0.0.1:19998/**", (socket) => {
    socket.onMessage((raw) => {
      if (typeof raw !== "string") return;
      const { id: rid, method, params } = JSON.parse(raw);
      let result: unknown = null;
      switch (method) {
        case "daemon.info": result = { port: 19998, token: "shots", pid: 1, version: "0.4.0", started_at: at(600), data_dir: "/tmp" }; break;
        case "provider.list": result = []; break;
        case "session.list": result = sessions; break;
        case "session.get": result = sessions.find((s) => s.id === params.id); break;
        case "session.pending": result = { approvals: [], inputs: [] }; break;
        case "mods.list": result = [modInfo]; break;
        case "mods.ui_source": result = { js, css, version: "1.0.0" }; break;
        case "mod.pr-status.watch": result = params.background ? null : view; break;
        case "mod.pr-status.view": case "mod.pr-status.refresh": result = view; break;
        case "mod.pr-status.page.get": result = busy ? busyPage() : page; break;
        case "mod.pr-status.page.files": result = files; break;
        case "mod.github.pulls.sessions": result = [lead, worker]; break;
        case "git.branch_status": result = null; break;
        default:
          if (/history|commands|native|list|candidates|inbox|status|diff|log|worktrees|branches/.test(method)) result = [];
      }
      socket.send(JSON.stringify({ id: rid, result }));
    });
  });
}

/** Contrast (WCAG) of each state pill and status word against what is painted behind it. */
function measure() {
  const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
  const lum = ([r, g, b]: number[]) => {
    const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const behind = (el: Element | null): string => {
    for (; el; el = el.parentElement) {
      const bg = getComputedStyle(el).backgroundColor;
      if (rgb(bg)[3] !== 0 && bg !== "transparent") return bg;
    }
    return "rgb(255, 255, 255)";
  };
  const out: Record<string, number> = {};
  for (const el of document.querySelectorAll(".prs-page .prs-pill, .prs-page .prs-word, .prs-page .prs-badge, .prs-page .prs-ref, .prs-page .prs-count")) {
    const [a, b] = [lum(rgb(getComputedStyle(el).color)), lum(rgb(behind(el)))].sort((x, y) => y - x);
    out[`${el.className}: ${el.textContent}`] = Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100;
  }
  return out;
}

/** Make a pill of each state, to measure all four. */
const pills = () => {
  const host = document.querySelector(".prs-page-sub")!;
  for (const s of ["draft", "merged", "closed"]) {
    const pill = document.createElement("span");
    pill.className = `prs-pill prs-pill-${s}`;
    pill.textContent = s;
    host.appendChild(pill);
  }
};

for (const theme of ["dark", "light"] as const) {
  for (const [width, viewport] of [[1000, 1288], [700, 988]] as const) {
    test(`pr page ${theme} ${width}`, async ({ page: p }) => {
      await p.setViewportSize({ width: viewport, height: 2800 });
      await p.addInitScript((t) => localStorage.setItem("aura.settings.v1", JSON.stringify({ theme: t })), theme);
      await mockDaemon(p);
      await p.clock.setFixedTime(now);
      await p.goto(`/?port=19998&token=shots&session=${lead}`);
      await p.addStyleTag({ content: read("pull-requests/dist/ui.css") });
      await p.locator(".prs-section").getByRole("button", { name: title }).click();
      const view = p.locator(".prs-page");
      await expect(view.getByRole("heading", { level: 1 })).toContainText("#1290");
      const main = await view.evaluate((el) => Math.round(el.getBoundingClientRect().width));
      expect(Math.abs(main - width)).toBeLessThan(60);
      // All four tabs show whole, without scrolling the tab row (QA: at 700 px "Files changed" was cut off).
      const tabs = await view.getByRole("tablist").evaluate((list) => {
        const box = list.getBoundingClientRect();
        return { scrolls: list.scrollWidth > list.clientWidth, outside: [...list.children].filter((t) => t.getBoundingClientRect().right > box.right + 0.5).map((t) => t.textContent) };
      });
      expect(tabs).toEqual({ scrolls: false, outside: [] });
      await p.waitForTimeout(300);
      await view.screenshot({ path: `${OUT}/conversation-${theme}-${width}.png` });
      if (width === 1000) {
        await view.getByRole("tab", { name: /Files changed/ }).click();
        await expect(view.getByRole("region", { name: "src/routes/news.ts" })).toBeVisible();
        await p.waitForTimeout(200);
        await view.screenshot({ path: `${OUT}/files-${theme}-${width}.png` });
        await view.getByRole("tab", { name: /Checks/ }).click();
        await view.screenshot({ path: `${OUT}/checks-${theme}-${width}.png` });
        await view.getByRole("tab", { name: /Commits/ }).click();
        await view.screenshot({ path: `${OUT}/commits-${theme}-${width}.png` });
        await view.getByRole("tab", { name: /Conversation/ }).click();
        await p.evaluate(pills);
        writeFileSync(`${OUT}/contrast-${theme}.json`, JSON.stringify(await p.evaluate(measure), null, 2));
      }
    });
  }
}

for (const [width, viewport] of [[700, 988], [600, 888]] as const) {
  test(`all four tabs show whole at ${width} px, also with four-digit counts`, async ({ page: p }) => {
    busy = true;
    try {
      await p.setViewportSize({ width: viewport, height: 1200 });
      await mockDaemon(p);
      await p.clock.setFixedTime(now);
      await p.goto(`/?port=19998&token=shots&session=${lead}`);
      await p.locator(".prs-section").getByRole("button", { name: title }).click();
      const list = p.locator(".prs-page").getByRole("tablist");
      await expect(list.getByRole("tab")).toHaveCount(4);
      const tabs = await list.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return { scrolls: el.scrollWidth > el.clientWidth, outside: [...el.children].filter((t) => t.getBoundingClientRect().right > box.right + 0.5).map((t) => t.textContent) };
      });
      expect(tabs).toEqual({ scrolls: false, outside: [] });
      await list.screenshot({ path: `${OUT}/tabs-busy-${width}.png` });
    } finally {
      busy = false;
    }
  });
}
