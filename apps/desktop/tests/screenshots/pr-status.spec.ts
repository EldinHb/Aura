import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { Session } from "../../src/gen";

/**
 * The pr-status mod's cards in the Inspector, loaded from its build (mods/pr-status/dist, made by
 * ./scripts/build-mods.sh) by a fake daemon, next to the pull-requests mod's stylesheet as in the
 * app. Long, real-looking data at three Inspector widths; fails when anything sticks out of the
 * section, and writes the measured contrast of every status word. Not a README shot; run it alone:
 *   SHOTS=/tmp/pr-status-shots/v2 pnpm exec playwright test -c playwright.screenshots.config.ts tests/screenshots/pr-status.spec.ts
 */
const OUT = process.env.SHOTS ?? "test-results/pr-status";
const now = Date.parse("2026-11-27T10:00:00Z");
const at = (secAgo: number) => new Date(now - secAgo * 1000).toISOString();
const usage = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0, total_cost_usd: null, context_window: null, context_used: null, running_totals: false };
const mods = new URL("../../../../mods/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, mods), "utf8");

function session(id: string, over: Partial<Session>): Session {
  return { id, title: id, provider: "claude", agent: null, native_id: null, cwd: "/Users/sam/code/wortell.clientapps", worktree: null, group: "wortell", workspace: "default", status: "idle", mode: "structured", model: null, effort: null, permission_mode: null, sandbox_mode: null, command: null, created_at: at(7200), last_activity: at(60), archived: false, pinned: false, last_error: null, pending_count: 0, exit_code: null, system_prompt: null, orchestrator: false, orchestrator_id: null, feature_owner: false, specialist_id: null, specialist_name: null, folderless: false, attention: null, scheduled_task_id: null, scheduled_task_name: null, usage, ...over };
}

const id = (n: number) => `9a1b2c3d-0000-4000-8000-${String(n).padStart(12, "0")}`;
const lead = id(1);
const workers = [
  "#244 new news editor (frontend)", "#244 end-to-end tester for the news editor", "#244 backend review of the news endpoints",
  "#1213 News MCP infra (Pulumi)",
];
const sessions: Session[] = [
  session(lead, { title: "Customer portal news", orchestrator: true }),
  ...workers.map((title, i) => session(id(i + 2), { title, orchestrator_id: lead })),
];
const from = (...ws: number[]) => [{ sessionId: lead, title: "Customer portal news", worker: false }, ...ws.map((w) => ({ sessionId: id(w + 2), title: workers[w], worker: true }))];

const person = (name: string, state: string, previous: string | null = null) => ({ name, kind: name.includes("/") ? "team" : name.endsWith("[bot]") ? "bot" : "user", state, previous });
const check = (name: string, state: string) => ({ name, url: `https://github.com/wortell/wortell.clientapps/actions/runs/1/${name}`, state });
const passing = (n: number) => ({ state: "passing", passing: n, failing: 0, pending: 0, total: n, open: [], complete: true });

const mergeInfo = (over: Record<string, unknown> = {}) => ({
  reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", headSha: "f".repeat(40), headRef: "feature/news-translator",
  sameRepo: true, squashAllowed: true, canMerge: true, account: "github.com:eldin", ...over,
});

let n = 0;
function pr(repo: string, number: number, title: string, sources: unknown[], status: Record<string, unknown>) {
  n++;
  return {
    ref: { url: `https://github.com/${repo}/pull/${number}`, repo, number, sources },
    status: { url: `https://github.com/${repo}/pull/${number}`, repo, number, title, author: "eldin", updatedAt: at(10 + n), reviewers: { reviewed: [], pending: [], complete: true }, checks: passing(12), readiness: null, merge: mergeInfo(), ...status },
    readAt: at(10 + n),
    error: null,
  };
}

const merged = (repo: string, number: number, title: string, sources: unknown[]) => pr(repo, number, title, sources, {
  state: "merged",
  reviewers: { reviewed: [person("martijntakken-wortell-long-login", "APPROVED"), person("github-advanced-security[bot]", "COMMENTED")], pending: [person("Renevdo", "PENDING")], complete: true },
});

const pulls = [
  merged("wortell/wortell.clientapps", 299, "feat(customer-portal): news editor with drafts, scheduling and a live preview of the rendered article", from(0, 1, 2, 3)),
  merged("wortell/customer-portal-backend", 1212, ":sparkles: News section layouts with hero, grid and list variants for the landing page", from(2, 0)),
  pr("wortell/wortell.clientapps", 333, "feat(customer-portal): translate news articles while editing them, with a side-by-side preview per language", from(0, 1, 2, 3), {
    state: "open",
    reviewers: {
      reviewed: [person("martijntakken-wortell-long-login", "CHANGES_REQUESTED"), person("github-advanced-security[bot]", "COMMENTED")],
      pending: [person("Renevdo", "PENDING", "APPROVED"), person("wortell/customer-portal-maintainers", "PENDING")],
      complete: true,
    },
    checks: { state: "failing", passing: 9, failing: 2, pending: 1, total: 12, open: [check("integration-tests-against-the-acceptance-environment", "failing"), check("lint", "failing"), check("e2e (chromium)", "pending")], complete: true },
    readiness: { ready: false, reasons: ["changes_requested", "checks_failing", "behind"] },
  }),
  merged("wortell/customer-portal-backend", 1277, ":sparkles: Translate news while editing", from(0)),
  merged("wortell/customer-portal-backend", 1230, ":sparkles: News MCP server for drafting articles from tickets", from(3)),
  merged("wortell/customer-portal-infra", 529, ":sparkle: Provision the My Wortell News MCP server and its managed identity", from(3)),
  pr("wortell/customer-portal-infra", 545, ":sparkle: Provision Azure OpenAI (GPT-5) for the news translator, with private endpoints", from(3), {
    state: "open",
    reviewers: { reviewed: [person("Renevdo", "APPROVED"), person("martijntakken-wortell-long-login", "APPROVED")], pending: [], complete: true },
    checks: passing(4),
    readiness: { ready: true, reasons: [] },
    merge: mergeInfo({ reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" }),
  }),
  merged("wortell/customer-portal-backend", 1255, ":sparkles: News page templates and the article RSS feed", from(1)),
];
const view = { sessionId: lead, pulls, blocked: null };

// "Squash and merge": an approved, clean PR, and an approved one behind its base.
const mergeLead = id(9);
sessions.push(session(mergeLead, { title: "Rate limits" }));
const mergePulls = [
  pr("wortell/customer-portal-backend", 1290, ":sparkles: Rate limit the news API per tenant and per key", [{ sessionId: mergeLead, title: "Rate limits", worker: false }], {
    state: "open",
    reviewers: { reviewed: [person("Renevdo", "APPROVED")], pending: [], complete: true },
    checks: passing(12),
    readiness: { ready: true, reasons: [] },
    merge: mergeInfo({ reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" }),
  }),
  pr("wortell/customer-portal-backend", 1291, ":bug: Return Retry-After on 429 responses", [{ sessionId: mergeLead, title: "Rate limits", worker: false }], {
    state: "open",
    reviewers: { reviewed: [person("martijntakken-wortell-long-login", "APPROVED")], pending: [], complete: true },
    checks: passing(12),
    readiness: { ready: false, reasons: ["behind"] },
    merge: mergeInfo({ reviewDecision: "APPROVED", mergeStateStatus: "BEHIND" }),
  }),
];
const views: Record<string, unknown> = { [lead]: view, [mergeLead]: { sessionId: mergeLead, pulls: mergePulls, blocked: null } };

const modInfo = { id: "pr-status", name: "PR status", version: "1.0.0", source: "bundled", dir: "/bundled/pr-status", status: { state: "running" }, enabled: true, approved: true, hasUi: true, hasDaemon: true, permissions: {}, dependsOn: {}, settings: [], settingValues: {} };

async function mockDaemon(page: Page) {
  const js = read("pr-status/dist/ui.js");
  const css = read("pr-status/dist/ui.css");
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
        case "mod.pr-status.watch": case "mod.pr-status.view": case "mod.pr-status.refresh": result = views[params.sessionId]; break;
        case "mod.pr-status.merge.defaults": result = { title: ":sparkles: Rate limit the news API per tenant and per key (#1290)", message: "* Add a limiter per tenant\n\n* Read the limits from the tenant settings\n\n* Return Retry-After" }; break;
        case "mod.pr-status.merge":
          // Never a real merge: the fake daemon refuses as GitHub does when the head moved.
          socket.send(JSON.stringify({ id: rid, error: { code: -32000, message: "New commits arrived since this card was read; refresh and look at them first. GitHub said: Head branch was modified. Review and try the merge again.", data: { code: "head_moved" } } }));
          return;
        case "mod.pr-status.unwatch": result = true; break;
        case "git.branch_status": result = null; break;
        default:
          if (/history|commands|native|list|candidates|inbox|status|diff|log|worktrees|branches/.test(method)) result = [];
      }
      socket.send(JSON.stringify({ id: rid, result }));
    });
  });
}

/** Contrast (WCAG) of each status word against what is painted behind it. */
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
  const out: Record<string, { color: string; background: string; ratio: number }> = {};
  for (const el of document.querySelectorAll(".prs-section .prs-word, .prs-section .prs-chip, .prs-section .prs-updated, .prs-section .prs-meta, .prs-section .prs-group-title")) {
    const key = `${el.className.replace("prs-word ", "")}: ${el.textContent}`;
    if (out[key]) continue;
    const fg = getComputedStyle(el).color;
    const bg = behind(el);
    const [a, b] = [lum(rgb(fg)), lum(rgb(bg))].sort((x, y) => y - x);
    out[key] = { color: fg, background: bg, ratio: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100 };
  }
  return out;
}

/** Elements of the section that show right of it: ending past its edge, and not cut off by a clipping parent inside it. */
const overflow = () => {
  const section = document.querySelector(".prs-section")!;
  const edge = section.getBoundingClientRect().right + 0.5;
  const clipped = (el: Element) => {
    for (let p = el.parentElement; p && p !== section; p = p.parentElement) {
      if (getComputedStyle(p).overflowX !== "visible" && p.getBoundingClientRect().right <= edge) return true;
    }
    return false;
  };
  return [...section.querySelectorAll("*")]
    .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right > edge && !clipped(el))
    .map((el) => `${el.className}: ${el.textContent?.slice(0, 40)}`);
};

for (const theme of ["dark", "light"] as const) {
  for (const width of [200, 240, 280, 340, 420]) {
    test(`pr status cards ${theme} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 2400 });
      await page.addInitScript((t) => localStorage.setItem("aura.settings.v1", JSON.stringify({ theme: t })), theme);
      await mockDaemon(page);
      await page.clock.setFixedTime(now);
      await page.goto(`/?port=19998&token=shots&session=${lead}`);
      // As in the app: the pull-requests mod's styles are on the same page.
      await page.addStyleTag({ content: read("pull-requests/dist/ui.css") });
      await page.addStyleTag({ content: `:root { --inspector-w: ${width}px; }` });
      const section = page.locator(".prs-section");
      await expect(section.getByRole("article")).toHaveCount(2);
      await section.getByRole("button", { name: /Checks failing/ }).click();
      await page.waitForTimeout(250);
      expect(await page.evaluate(overflow)).toEqual([]);
      // The heading is never cut short: the timestamp wraps below it instead.
      expect(await section.locator(".prs-head h4").evaluate((h) => h.scrollWidth <= h.clientWidth)).toBe(true);
      await section.screenshot({ path: `${OUT}/${theme}-${width}.png` });
      await section.getByRole("button", { name: /Merged & closed/ }).click();
      await section.getByRole("button", { name: "this session + 4 workers" }).first().click();
      await page.waitForTimeout(250);
      expect(await page.evaluate(overflow)).toEqual([]);
      await section.screenshot({ path: `${OUT}/${theme}-${width}-expanded.png` });
      if (width === 340) writeFileSync(`${OUT}/contrast-${theme}.json`, JSON.stringify(await page.evaluate(measure), null, 2));
    });
  }
}

for (const theme of ["dark", "light"] as const) {
  test(`squash and merge ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1600 });
    await page.addInitScript((t) => localStorage.setItem("aura.settings.v1", JSON.stringify({ theme: t })), theme);
    await mockDaemon(page);
    await page.clock.setFixedTime(now);
    await page.goto(`/?port=19998&token=shots&session=${mergeLead}`);
    await page.addStyleTag({ content: read("pull-requests/dist/ui.css") });
    await page.addStyleTag({ content: ":root { --inspector-w: 340px; }" });
    const ready = page.getByRole("article", { name: /#1290/ });
    const behind = page.getByRole("article", { name: /#1291/ });
    await expect(ready.getByRole("button", { name: "Squash and merge" })).toBeEnabled();
    await expect(behind.getByRole("button", { name: "Squash and merge" })).toBeDisabled();
    await page.waitForTimeout(250);
    await ready.screenshot({ path: `${OUT}/merge-button-${theme}.png` });
    await behind.screenshot({ path: `${OUT}/merge-disabled-${theme}.png` });
    await ready.getByRole("button", { name: "Squash and merge" }).click();
    await expect(ready.getByRole("button", { name: "Cancel" })).toBeFocused();
    await expect(ready.getByLabel("Commit message")).toHaveValue(/Return Retry-After/);
    await ready.getByLabel("Delete branch after merge").check();
    await page.waitForTimeout(250);
    expect(await page.evaluate(overflow)).toEqual([]);
    await ready.screenshot({ path: `${OUT}/merge-confirm-${theme}.png` });
    await ready.getByRole("button", { name: "Merge", exact: true }).click();
    await expect(ready.getByRole("alert")).toContainText("Head branch was modified");
    await expect(ready.getByRole("button", { name: "Merge", exact: true })).toBeEnabled();
    await page.waitForTimeout(250);
    await ready.screenshot({ path: `${OUT}/merge-error-${theme}.png` });
  });
}
