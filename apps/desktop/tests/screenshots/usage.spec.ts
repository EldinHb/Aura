import { expect, test, type Page } from "@playwright/test";
import type { Event, Item, ProviderInfo, Session, SessionTemplate, SessionUsage, StoredEvent, TurnUsage, UsageGroup, UsageSummary, UsageTotals } from "../../src/gen";

/**
 * Usage and cost, and session templates, against a fake daemon. Not README shots; run on their own:
 *   SHOTS=/tmp/usage pnpm exec playwright test -c playwright.screenshots.config.ts usage
 */
const OUT = process.env.SHOTS ?? "test-results/usage";
/** App modules, imported in the page to open what has no button in the shots. */
const STORE: string = "/src/state/store.ts";
const USAGE: string = "/src/features/usage/state.ts";
const now = Date.now();
const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
const usage0 = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0, total_cost_usd: null, context_window: null, context_used: null, running_totals: false };
const id = (n: number) => `5e55a0e0-0000-4000-8000-${String(n).padStart(12, "0")}`;
const lead = id(1);
const sid = id(10);

function session(sessionId: string, over: Partial<Session>): Session {
  return {
    id: sessionId, title: sessionId, provider: "claude", agent: null, native_id: null, cwd: "/Users/sam/code/shop", worktree: null, group: null, workspace: "default",
    status: "idle", mode: "structured", model: "claude-opus-5-5", effort: null, permission_mode: null, sandbox_mode: null, command: null, created_at: at(600),
    last_activity: at(5), archived: false, pinned: false, usage: { ...usage0, input_tokens: 48_000, output_tokens: 9_100, cached_input_tokens: 610_000, total_cost_usd: 1.92, context_window: 1_000_000, context_used: 142_000 },
    last_error: null, pending_count: 0, exit_code: null, system_prompt: null, orchestrator: false, orchestrator_id: null, feature_owner: false, specialist_id: null,
    specialist_name: null, folderless: false, attention: null, scheduled_task_id: null, scheduled_task_name: null, ...over,
  };
}
const sessions: Session[] = [
  session(lead, { title: "Checkout revamp", feature_owner: true, orchestrator: true, folderless: true, cwd: "/data/o" }),
  session(id(2), { title: "Backend engineer", orchestrator_id: lead, specialist_name: "Backend engineer" }),
  session(id(3), { title: "Frontend engineer", orchestrator_id: lead, specialist_name: "Frontend engineer", provider: "codex", model: "gpt-5-codex" }),
  session(sid, { title: "Speed up CSV import" }),
];

const totals = (cost: number, tokens: number, over: Partial<UsageTotals> = {}): UsageTotals => ({
  turns: Math.max(1, Math.round(tokens / 90_000)), inputTokens: Math.round(tokens * 0.08), outputTokens: Math.round(tokens * 0.02), cachedInputTokens: Math.round(tokens * 0.9),
  cacheWriteTokens: Math.round(tokens * 0.08), costUsd: cost, estimatedCostUsd: 0, unpricedTurns: 0, ...over,
});
const g = (key: string, label: string, cost: number, tokens: number, parts: UsageGroup[] = [], over: Partial<UsageTotals> = {}): UsageGroup => ({ key, label, totals: totals(cost, tokens, over), parts });
const sum = (groups: UsageGroup[]) => groups.reduce((t, x) => ({
  ...t, turns: t.turns + x.totals.turns, inputTokens: t.inputTokens + x.totals.inputTokens, outputTokens: t.outputTokens + x.totals.outputTokens,
  cachedInputTokens: t.cachedInputTokens + x.totals.cachedInputTokens, cacheWriteTokens: t.cacheWriteTokens + x.totals.cacheWriteTokens,
  costUsd: t.costUsd + x.totals.costUsd, estimatedCostUsd: t.estimatedCostUsd + x.totals.estimatedCostUsd,
}), totals(0, 0, { turns: 0 }));

function daySummary(from: string, to: string, split: string): UsageSummary {
  const groups: UsageGroup[] = [];
  const day = new Date(from);
  let i = 0;
  while (day < new Date(to)) {
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    const wave = 0.6 + 0.4 * Math.sin(i * 1.3) + (i % 7 === 5 ? -0.5 : 0);
    const parts = split === "agent"
      ? [g("claude", "claude", 9 * wave, 3_000_000 * wave), g("codex", "codex", 2.5 * wave, 1_400_000 * wave, [], { estimatedCostUsd: 2.5 * wave })]
      : [g("claude-opus-5-5", "claude-opus-5-5", 7 * wave, 2_200_000 * wave), g("gpt-5-codex", "gpt-5-codex", 2.5 * wave, 1_400_000 * wave, [], { estimatedCostUsd: 2.5 * wave }), g("claude-sonnet-5-5", "claude-sonnet-5-5", 2 * wave, 800_000 * wave)];
    groups.push({ key, label: key, totals: sum(parts), parts });
    day.setDate(day.getDate() + 1);
    i++;
  }
  return { from, to, groupBy: "day", totals: sum(groups), groups, more: 0 };
}
const tables: Record<string, UsageGroup[]> = {
  session: [g(lead, "Checkout revamp", 21.4, 7_900_000), g(id(2), "Backend engineer", 14.2, 5_100_000), g(sid, "Speed up CSV import", 9.8, 3_600_000), g(id(3), "Frontend engineer", 8.1, 4_200_000, [], { estimatedCostUsd: 8.1 }), g("gone", "Spike: search index", 3.3, 1_100_000)],
  feature: [g(lead, "Checkout revamp", 43.7, 17_200_000), g("", "no feature", 13.1, 4_700_000)],
  project: [g("/Users/sam/code/shop", "shop", 47.9, 18_400_000), g("/Users/sam/code/infra", "infra", 8.9, 3_500_000)],
  model: [g("claude-opus-5-5", "claude-opus-5-5", 36.2, 11_800_000), g("gpt-5-codex", "gpt-5-codex", 12.6, 7_300_000, [], { estimatedCostUsd: 12.6 }), g("claude-sonnet-5-5", "claude-sonnet-5-5", 8.0, 2_800_000)],
  agent: [g("claude", "claude", 44.2, 14_600_000), g("codex", "codex", 12.6, 7_300_000, [], { estimatedCostUsd: 12.6 })],
};

const turns: TurnUsage[] = Array.from({ length: 14 }, (_, i) => ({
  turnId: `t${i + 1}`, at: at(300 - i * 20), model: "claude-opus-5-5", inputTokens: 1_800 + i * 140, outputTokens: 900 + (i % 4) * 700,
  cacheReadTokens: 28_000 + i * 9_000, cacheWriteTokens: i % 3 === 0 ? 14_000 : 3_000, contextUsed: 24_000 + i * 8_500 + (i > 9 ? -40_000 : 0),
  contextWindow: 200_000, costUsd: 0.06 + i * 0.012, estimated: false,
}));
const sessionUsage = (sessionId: string): SessionUsage => ({
  sessionId, title: sessions.find((s) => s.id === sessionId)?.title ?? "", totals: totals(1.92, 640_000), allTotals: sessionId === lead ? totals(43.7, 17_200_000, { estimatedCostUsd: 8.1 }) : totals(1.92, 640_000),
  turns, models: sessionId === lead ? tables.model : [g("claude-opus-5-5", "claude-opus-5-5", 1.92, 640_000)],
  workers: sessionId === lead ? [g(id(2), "Backend engineer", 14.2, 5_100_000), g(id(3), "Frontend engineer", 8.1, 4_200_000, [], { estimatedCostUsd: 8.1 })] : [],
});

function history(): StoredEvent[] {
  const out: StoredEvent[] = [];
  const push = (event: Event) => out.push({ seq: out.length + 1, ts: at(10), event });
  const texts = [
    ["Why is the CSV import slow?", "It parses every row twice: once to validate and once to insert. I'll stream it through `COPY` instead."],
    ["Go ahead, and keep the validation.", "Done: validation now runs on the stream, and 1M rows import in **41 s** instead of 7 minutes."],
  ];
  texts.forEach(([q, a], n) => {
    const tid = `t${n + 1}`;
    const turn = { id: tid, session_id: sid, status: "completed" as const, started_at: at(20), ended_at: at(19), usage: { ...usage0, input_tokens: 2400, output_tokens: 1100, cached_input_tokens: 52_000, cache_write_tokens: 9_000, total_cost_usd: 0.084, context_used: 61_000 + n * 30_000, context_window: 200_000 }, error: null };
    const item = (iid: string, kind: Item["kind"], text: string): Item => ({ id: iid, session_id: sid, turn_id: tid, kind, status: "completed", title: null, text, data: {}, parent_id: null, started_at: at(20), ended_at: at(19) });
    push({ type: "turn_started", session_id: sid, turn: { ...turn, status: "running", usage: null } });
    for (const it of [item(`u${n}`, "user_message", q), item(`a${n}`, "agent_message", a)]) {
      push({ type: "item_started", session_id: sid, item: it });
      push({ type: "item_completed", session_id: sid, item: it });
    }
    push({ type: "turn_completed", session_id: sid, turn });
  });
  return out;
}

const templates: SessionTemplate[] = [
  { id: "t1", created_at: at(900), updated_at: at(900), name: "Review PRs", kind: "agent", provider: "codex", agent: null, cwd: "/Users/sam/code/shop", worktree: true, branch_pattern: "review/{slug}-{date}", workspace: null, group: null, mode: null, command: null, model: "gpt-5-codex", effort: "high", permission_mode: null, sandbox_mode: "workspace-write", autonomy: null, system_prompt: null, prompt: "Review the open pull requests and leave comments." },
  { id: "t2", created_at: at(900), updated_at: at(900), name: "Bug triage", kind: "orchestrator", provider: "claude", agent: null, cwd: null, worktree: false, branch_pattern: null, workspace: null, group: null, mode: null, command: null, model: "claude-opus-5-5", effort: null, permission_mode: "acceptEdits", sandbox_mode: null, autonomy: null, system_prompt: null, prompt: "Triage today's new issues." },
  { id: "t3", created_at: at(900), updated_at: at(900), name: "New feature", kind: "feature_owner", provider: "claude", agent: null, cwd: null, worktree: false, branch_pattern: null, workspace: null, group: null, mode: null, command: null, model: null, effort: null, permission_mode: null, sandbox_mode: null, autonomy: { level: "blocking_decisions", checkpoints: [] }, system_prompt: null, prompt: null },
];
const providers = [
  { kind: "claude", display_name: "Claude Code", available: true, version: "2.1", binary: null, capabilities: { structured: true, models: true, effort: true, permission_modes: ["default", "acceptEdits", "plan"], sandbox_modes: [] }, agents: [] },
  { kind: "codex", display_name: "Codex", available: true, version: "0.9", binary: null, capabilities: { structured: true, models: true, effort: true, permission_modes: [], sandbox_modes: ["read-only", "workspace-write"] }, agents: [] },
] as unknown as ProviderInfo[];

async function mockDaemon(page: Page) {
  await page.routeWebSocket("ws://127.0.0.1:19997/**", (socket) => {
    socket.onMessage((raw) => {
      if (typeof raw !== "string") return;
      const { id: rid, method, params } = JSON.parse(raw);
      let result: unknown = null;
      switch (method) {
        case "daemon.info": result = { port: 19997, token: "shots", pid: 1, version: "0.6.3", started_at: at(600), data_dir: "/tmp" }; break;
        case "provider.list": result = providers; break;
        case "provider.models": result = params.provider === "codex" ? [{ id: "gpt-5-codex", display_name: "GPT-5 Codex", description: null, efforts: ["low", "medium", "high"], default_effort: "medium", is_default: true }] : [{ id: "claude-opus-5-5", display_name: "Opus 5.5", description: null, efforts: ["low", "medium", "high", "xhigh", "max"], default_effort: "medium", is_default: true }]; break;
        case "session.list": result = sessions; break;
        case "session.get": result = sessions.find((s) => s.id === params.id); break;
        case "session.history": result = params.id === sid ? history().filter((e) => e.seq > (params.after_seq ?? 0)) : []; break;
        case "session.pending": result = { approvals: [], inputs: [] }; break;
        case "mods.inbox": result = []; break;
        case "workspace.list": result = [{ id: "default", name: "Default", created_at: at(9000), position: 0 }]; break;
        case "workspace.touch": result = true; break;
        case "fs.home": result = "/Users/sam"; break;
        case "git.repo_root": result = "/Users/sam/code/shop"; break;
        case "template.list": result = templates; break;
        case "usage.reports": result = []; break;
        case "usage.daily": result = { enabled: true, time: "18:00" }; break;
        case "usage.session": result = sessionUsage(params.id); break;
        case "usage.report": result = { id: "r", title: params.title, from: params.from, to: params.to, generatedAt: at(0), totals: totals(12.4, 4_200_000), previous: totals(9.9, 3_600_000), markdown: `## Usage summary: ${params.title}\n\n_Thu 12 Nov 00:00 – Fri 13 Nov 00:00_\n\n- **Cost:** $12.40 ($2.50 of it estimated from list prices), +25% against the period before ($9.90)\n- **Tokens:** 336k in, 84k out, 3.8M cached over 47 turns, +17% in tokens\n\n### Biggest sessions\n\n- Checkout revamp: $5.10 · 1.9M tokens · 18 turns\n- Speed up CSV import: $3.20 · 1.1M tokens · 12 turns\n\n### Notable\n\n- Model gpt-5-codex spent 2.4× as much as the period before.\n` }; break;
        case "usage.summary": {
          if (params.groupBy === "day") result = daySummary(params.from, params.to, params.splitBy);
          else {
            const before = new Date(params.to) <= new Date(now - 86_400_000 * 6);
            const list = tables[params.groupBy] ?? [];
            result = { from: params.from, to: params.to, groupBy: params.groupBy, totals: before ? totals(41.2, 16_900_000) : sum(list), groups: list, more: 0 };
          }
          break;
        }
        default:
          if (/history|commands|native|list|candidates|status|diff_stat|log|worktrees|branches|search_files/.test(method)) result = [];
      }
      socket.send(JSON.stringify({ id: rid, result }));
    });
  });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 960 });
  await mockDaemon(page);
});

for (const scheme of ["dark", "light"] as const) {
  test(`usage dashboard (${scheme})`, async ({ page }) => {
    await page.addInitScript((theme) => localStorage.setItem("aura.settings.v1", JSON.stringify({ theme })), scheme);
    await page.goto(`/?port=19997&token=shots&session=${sid}`);
    await expect(page.locator(`[data-session-id="${sid}"]`)).toBeVisible();
    await page.evaluate(() => (window as unknown as { __aura?: unknown }).__aura);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
    await page.keyboard.type("Usage and cost");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Cost per day")).toBeVisible();
    await page.getByRole("radio", { name: "30 days" }).click();
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: "Yesterday" }).click();
    await expect(page.locator(".usage-report")).toBeVisible();
    await page.waitForTimeout(300);
    await page.locator(".modal").screenshot({ path: `${OUT}/dashboard-${scheme}.png` });
  });
}

test("a feature owner's usage with its workers", async ({ page }) => {
  await page.goto(`/?port=19997&token=shots&session=${sid}`);
  await expect(page.locator(`[data-session-id="${sid}"]`)).toBeVisible();
  await page.evaluate(([path, id]) => import(path).then((m) => m.openUsage(id)), [USAGE, lead]);
  await expect(page.getByText("Context after each turn")).toBeVisible();
  await page.waitForTimeout(300);
  await page.locator(".modal").screenshot({ path: `${OUT}/session-usage.png` });
});

test("the line under each reply, one opened", async ({ page }) => {
  await page.goto(`/?port=19997&token=shots&session=${sid}`);
  await expect(page.locator(`[data-session-id="${sid}"]`)).toBeVisible();
  // The fake daemon's first connection does not load the selected session's history by itself.
  await page.evaluate(([path, id]) => import(path).then((m) => m.useStore.getState().loadTranscript(id)), [STORE, sid]);
  const line = page.locator(".turn-usage-line").first();
  await expect(line).toBeVisible();
  await line.click();
  await page.waitForTimeout(300);
  await page.locator(".transcript, main").first().screenshot({ path: `${OUT}/turn-lines.png` });
});

test("new session from a template, and the templates in Settings", async ({ page }) => {
  await page.goto(`/?port=19997&token=shots&session=${sid}`);
  await expect(page.locator(`[data-session-id="${sid}"]`)).toBeVisible();
  await page.evaluate((path) => import(path).then((m) => m.useStore.getState().openDialog({ kind: "new-session" })), STORE);
  await page.getByRole("radio", { name: "Review PRs" }).click();
  await expect(page.locator(".modal textarea").first()).toHaveValue("Review the open pull requests and leave comments.");
  await page.waitForTimeout(400);
  await page.locator(".modal").screenshot({ path: `${OUT}/new-session-template.png` });
  await page.evaluate((path) => import(path).then((m) => m.useStore.getState().openDialog({ kind: "settings", tab: "templates" })), STORE);
  await expect(page.getByText("Bug triage")).toBeVisible();
  await page.waitForTimeout(200);
  await page.locator(".modal").screenshot({ path: `${OUT}/settings-templates.png` });
});
