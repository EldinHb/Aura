import { expect, test, type Page } from "@playwright/test";
import { inboxFixture, pullFixture as basePull, reviewFixture as baseReview } from "../../src/features/reviews/fixtures";
import type { Approval, CapabilitySet, Event, Item, PullRequest, PullTimeline, Session, StoredEvent, TimelineItem, UserInputRequest } from "../../src/gen";

const OUT = "../../docs/screenshots";
const now = Date.parse("2026-10-15T09:40:00Z");
const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
const usage = (input: number, output: number, cost: number | null, used: number | null = null) => ({ input_tokens: input, output_tokens: output, cached_input_tokens: Math.round(input * 0.7), total_cost_usd: cost, context_window: used ? 200_000 : null, context_used: used, running_totals: false });

function session(id: string, over: Partial<Session>): Session {
  return { id, title: id, provider: "claude", agent: null, native_id: null, cwd: "/Users/sam/code/acme-api", worktree: null, group: "acme", status: "idle", mode: "structured", model: null, effort: null, permission_mode: null, sandbox_mode: null, command: null, created_at: at(240), last_activity: at(5), archived: false, pinned: false, last_error: null, pending_count: 0, exit_code: null, system_prompt: null, orchestrator: false, orchestrator_id: null, folderless: false, attention: null, pulls: [], usage: usage(0, 0, null), ...over };
}

const ids = {
  rate: "7b0c1c9e-2f43-4c1a-9d5e-1a2b3c4d5e01",
  billing: "7b0c1c9e-2f43-4c1a-9d5e-1a2b3c4d5e02",
  flaky: "7b0c1c9e-2f43-4c1a-9d5e-1a2b3c4d5e03",
  dev: "7b0c1c9e-2f43-4c1a-9d5e-1a2b3c4d5e04",
  docs: "7b0c1c9e-2f43-4c1a-9d5e-1a2b3c4d5e05",
  orch: "7b0c1c9e-2f43-4c1a-9d5e-1a2b3c4d5e06",
};

const sessions: Session[] = [
  session(ids.rate, { title: "Add rate limiting to the public API", model: "claude-opus-5-5", effort: "high", permission_mode: "default", last_activity: at(1), pinned: true, usage: usage(412_000, 18_400, 2.84, 61_000) }),
  session(ids.billing, { title: "Move billing to Stripe webhooks", provider: "codex", model: "gpt-5.5-codex", effort: "medium", sandbox_mode: "workspace-write", status: "waiting_input", pending_count: 1, attention: "waiting", last_activity: at(2), usage: usage(198_000, 9_100, null) }),
  session(ids.flaky, { title: "Fix flaky checkout test", provider: "acp", agent: "gemini", cwd: "/Users/sam/code/acme-web", status: "waiting_approval", pending_count: 1, attention: "waiting", last_activity: at(3), usage: usage(88_000, 4_200, null) }),
  session(ids.orch, { title: "Release 2.0 checklist", orchestrator: true, cwd: "/Users/sam/code/acme-web", status: "running", model: "claude-opus-5-5", last_activity: at(0), usage: usage(240_000, 12_000, 1.37) }),
  session(ids.docs, { title: "Update API reference docs", provider: "codex", cwd: "/Users/sam/code/acme-web", orchestrator_id: ids.orch, attention: "done", last_activity: at(0), usage: usage(64_000, 3_000, null) }),
  session(ids.dev, { title: "pnpm dev", provider: "terminal", mode: "terminal", command: ["pnpm", "dev"], status: "running", group: null, cwd: "/Users/sam/code/acme-web", last_activity: at(12) }),
];

const caps = (over: Partial<CapabilitySet> = {}): CapabilitySet => ({ structured: true, models: true, effort: true, permission_modes: ["default", "acceptEdits", "plan"], sandbox_modes: [], fork: true, steer: true, interrupt: true, review: false, compact: true, mcp_status: true, skills_list: true, slash_commands: true, images: true, diff_stream: true, plan_stream: true, native_sessions: true, rename: true, terminal_mode: true, ...over });
const providers = [
  { kind: "claude", display_name: "Claude Code", available: true, version: "2.4.0", binary: "/usr/local/bin/claude", capabilities: caps(), agents: [] },
  { kind: "codex", display_name: "Codex", available: true, version: "0.98.0", binary: "/usr/local/bin/codex", capabilities: caps({ permission_modes: [], sandbox_modes: ["read-only", "workspace-write"] }), agents: [] },
  { kind: "acp", display_name: "ACP agents", available: true, version: null, binary: null, capabilities: caps({ models: false, effort: false, permission_modes: [] }), agents: [{ id: "gemini", display_name: "Gemini CLI", command: ["gemini", "--experimental-acp"], available: true, binary: "/usr/local/bin/gemini", source: "builtin" }] },
  { kind: "terminal", display_name: "Terminal", available: true, version: null, binary: null, capabilities: caps({ structured: false }), agents: [] },
];

/** Builds a stored history: one turn per entry, items in order. */
function history(sid: string, turns: { minAgo: number; items: Omit<Item, "id" | "session_id" | "turn_id" | "status" | "parent_id" | "started_at" | "ended_at" | "title">[] }[]): StoredEvent[] {
  const out: StoredEvent[] = [];
  const push = (ev: Event, ts: string) => out.push({ seq: out.length + 1, ts, event: ev });
  turns.forEach((t, ti) => {
    const turnId = `${sid}-t${ti}`;
    const ts = at(t.minAgo);
    const end = at(t.minAgo - 1.6);
    push({ type: "turn_started", session_id: sid, turn: { id: turnId, session_id: sid, status: "running", started_at: ts, ended_at: null, usage: null, error: null } }, ts);
    t.items.forEach((it, ii) => {
      const item: Item = { id: `${turnId}-i${ii}`, session_id: sid, turn_id: turnId, status: "completed", parent_id: null, started_at: ts, ended_at: end, title: null, ...it };
      push({ type: "item_started", session_id: sid, item }, ts);
      push({ type: "item_completed", session_id: sid, item }, ts);
    });
    push({ type: "turn_completed", session_id: sid, turn: { id: turnId, session_id: sid, status: "completed", started_at: ts, ended_at: end, usage: null, error: null } }, ts);
  });
  return out;
}

const rateDiff = `--- a/src/middleware/rateLimit.ts
+++ b/src/middleware/rateLimit.ts
@@ -0,0 +1,14 @@
+import { RateLimiterRedis } from "rate-limiter-flexible";
+import { redis } from "../redis";
+
+const limiter = new RateLimiterRedis({ storeClient: redis, points: 100, duration: 60 });
+
+export async function rateLimit(req, res, next) {
+  try {
+    await limiter.consume(req.apiKey ?? req.ip);
+    next();
+  } catch (e) {
+    res.set("Retry-After", String(Math.ceil(e.msBeforeNext / 1000)));
+    res.status(429).json({ error: "rate_limited" });
+  }
+}
`;

const histories: Record<string, StoredEvent[]> = {
  [ids.rate]: history(ids.rate, [
    {
      minAgo: 14,
      items: [
        { kind: "user_message", text: "Add rate limiting to the public API. 100 requests per minute per API key, fall back to the IP for anonymous calls. Return a proper 429.", data: {} },
        { kind: "reasoning", text: "Look at how middleware is wired up and whether Redis is already available.", data: {} },
        { kind: "command_exec", text: "", data: { command: "rg -n \"app.use\" src/server.ts", output: "12:app.use(auth)\n13:app.use(json())\n14:app.use(\"/v1\", routes)", exit_code: 0, duration_ms: 41 } },
        { kind: "tool_call", text: "", data: { tool_name: "Read", input: { file_path: "src/redis.ts" }, result: "export const redis = new Redis(process.env.REDIS_URL)" } },
        { kind: "file_change", text: "", data: { changes: [{ path: "src/middleware/rateLimit.ts", kind: "add", diff: rateDiff }, { path: "src/server.ts", kind: "update", diff: "--- a/src/server.ts\n+++ b/src/server.ts\n@@ -12,3 +12,4 @@\n app.use(auth)\n+app.use(rateLimit)\n app.use(json())\n" }] } },
        { kind: "command_exec", text: "", data: { command: "pnpm test -- rateLimit", output: " ✓ allows 100 requests per minute (38 ms)\n ✓ returns 429 with Retry-After (12 ms)\n ✓ keys anonymous calls on the IP (9 ms)\n\nTests: 3 passed, 3 total", exit_code: 0, duration_ms: 2140 } },
        { kind: "agent_message", text: "Rate limiting is in place.\n\n- **`src/middleware/rateLimit.ts`**: a Redis-backed limiter, 100 requests per 60 s, keyed on the API key with the client IP as fallback.\n- **`src/server.ts`**: the middleware runs right after `auth`, so the API key is known.\n- Over the limit the API answers `429` with a `Retry-After` header.\n\nThe three new tests pass. Want me to make the limit configurable per plan?", data: {} },
      ],
    },
    {
      minAgo: 2,
      items: [
        { kind: "user_message", text: "Yes, read the limit from the plan on the API key.", data: {} },
        { kind: "reasoning", text: "Plans live in the accounts table; the auth middleware already loads the key's account.", data: {} },
        { kind: "command_exec", text: "", data: { command: "rg -n \"plan\" src/auth.ts", output: "27:  req.account = { id: row.account_id, plan: row.plan }", exit_code: 0, duration_ms: 35 } },
        { kind: "agent_message", text: "Each plan now gets its own limiter: **free** 60/min, **team** 600/min, **enterprise** 3000/min. Anonymous calls stay at 30/min per IP. Tests updated and passing.", data: {} },
      ],
    },
  ]),
  [ids.billing]: history(ids.billing, [
    {
      minAgo: 6,
      items: [
        { kind: "user_message", text: "Move billing from the nightly sync job to Stripe webhooks.", data: {} },
        { kind: "command_exec", text: "", data: { command: "rg -ln stripe src", output: "src/billing/sync.ts\nsrc/billing/plans.ts\nsrc/jobs/nightly.ts", exit_code: 0, duration_ms: 52 } },
        { kind: "agent_message", text: "I mapped the current sync job. Before I write the webhook handler I need two decisions from you.", data: {} },
      ],
    },
  ]),
  [ids.orch]: [], [ids.docs]: [], [ids.dev]: [],
};

const question: UserInputRequest = {
  id: "q-billing", session_id: ids.billing, turn_id: `${ids.billing}-t0`, item_id: null, created_at: at(2),
  questions: [
    { id: "events", header: "Webhook events", question: "Which Stripe events should update a subscription?", multi_select: true, allow_free_text: false, secret: false, options: [
      { label: "customer.subscription.updated", description: "Plan changes, renewals, cancellations" },
      { label: "invoice.paid", description: "Mark the period as paid" },
      { label: "invoice.payment_failed", description: "Start the dunning flow" },
    ] },
    { id: "nightly", header: "Nightly job", question: "What should happen to the nightly sync job?", multi_select: false, allow_free_text: true, secret: false, options: [
      { label: "Remove it", description: "Webhooks become the only source of truth" },
      { label: "Keep it as a reconciliation check", description: "Runs nightly, only reports drift" },
    ] },
  ],
};
const approval: Approval = { id: "a-flaky", session_id: ids.flaky, turn_id: null, item_id: null, kind: "command", title: "Run the checkout test 20 times", description: null, payload: { command: "pnpm vitest run checkout --repeat 20", cwd: "/Users/sam/code/acme-web" }, options: ["accept", "accept_for_session", "decline"], created_at: at(3) };

histories[ids.billing].push({ seq: histories[ids.billing].length + 1, ts: at(2), event: { type: "user_input_requested", session_id: ids.billing, request: question } });
histories[ids.flaky] = [{ seq: 1, ts: at(3), event: { type: "approval_requested", session_id: ids.flaky, approval } }];

const diffFixture = `diff --git a/src/webhooks/deliver.ts b/src/webhooks/deliver.ts
--- a/src/webhooks/deliver.ts
+++ b/src/webhooks/deliver.ts
@@ -8,5 +8,13 @@ export async function deliver(hook: Webhook, event: WebhookEvent) {
   const body = JSON.stringify(event);
   const signature = sign(body, hook.secret);
-  const res = await fetch(hook.url, { method: "POST", body, headers: { "x-acme-signature": signature } });
-  if (!res.ok) throw new DeliveryError(hook.id, res.status);
+  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
+    try {
+      const res = await fetch(hook.url, { method: "POST", body, headers: { "x-acme-signature": signature } });
+      if (res.ok) return;
+      if (res.status < 500) throw new DeliveryError(hook.id, res.status);
+    } catch (e) {
+      if (attempt === MAX_ATTEMPTS) throw e;
+    }
+    await sleep(2 ** attempt * 1000);
+  }
 }
`;
const pullFixture = { ...basePull, id: "acme/acme-web#318", repo: "acme/acme-web", number: 318, title: "Retry failed webhook deliveries", body: "Webhook deliveries now retry with exponential backoff on network errors and 5xx responses.", url: "https://github.com/acme/acme-web/pull/318", author: "jordan", head_ref: "webhook-retries", additions: 10, deletions: 2, updated_at: at(90), created_at: at(1500), labels: ["webhooks"], assignees: [], head_sha: "4f9c2e1d8b7a6c5e4d3f2a1b0c9d8e7f6a5b4c3d" };
const reviewFixture = {
  ...baseReview, pull: pullFixture, diff: diffFixture, reviewed_sha: pullFixture.head_sha, created_at: at(30), updated_at: at(28),
  result: {
    summary: "The retry loop is a good fit, but a 4xx thrown inside the try block is caught and retried, so client errors are retried too.",
    verdict: "request_changes", risk: "medium", confidence: 0.85,
    comments: [
      { ...baseReview.result.comments[0], id: "f1", path: "src/webhooks/deliver.ts", line: 15, severity: "major", body: "`DeliveryError` for a 4xx is thrown inside the `try`, so the `catch` swallows it and the delivery is retried anyway. Rethrow `DeliveryError` from the catch block.", rationale: "Receivers that reject a payload get hit up to MAX_ATTEMPTS times." },
      { ...baseReview.result.comments[0], id: "f2", path: "src/webhooks/deliver.ts", line: 19, severity: "minor", body: "The backoff has no jitter; many failing hooks will retry in lockstep. Consider adding a random 0-500 ms.", rationale: "Thundering herd after a receiver outage." },
    ],
  },
} as typeof baseReview;

const event = (kind: string, minAgo: number, over: Partial<TimelineItem> = {}): TimelineItem => ({ kind, id: `${kind}-${minAgo}`, at: at(minAgo), actor: "jordan", body: "", url: "", state: "", review_id: null, subject: "", previous: "", color: "", sha: "", before: "", ...over });
const timelineFixture: PullTimeline = {
  commits: 3,
  items: [
    event("commit", 1490, { subject: "Retry webhook deliveries with exponential backoff", sha: "9a1f3c2b7d" }),
    event("commit", 1485, { subject: "Add delivery retry tests", sha: "3e8d2a1c4b" }),
    event("labeled", 1480, { subject: "webhooks", color: "1d76db" }),
    event("review_requested", 1479, { subject: "sam" }),
    event("comment", 1200, { actor: "riley", body: "Do we cap the total delay? A receiver that is down for an hour should not keep a worker busy." }),
    event("comment", 1150, { body: "Yes: `MAX_ATTEMPTS` is 5, so the worst case is about a minute of backoff." }),
    event("review", 300, { actor: "sam", state: "CHANGES_REQUESTED", review_id: 11, body: "The loop reads well. One problem with client errors, see inline." }),
    event("commit", 120, { subject: "Do not retry 4xx responses", sha: "4f9c2e1d8b" }),
    event("review", 90, { actor: "riley", state: "APPROVED", review_id: 12 }),
  ],
  threads: [
    { id: "t1", path: "src/webhooks/deliver.ts", line: 15, original_line: 15, resolved: true, outdated: false, resolved_by: "jordan", review_id: 11, more: 0, diff_hunk: "@@ -8,5 +8,13 @@\n+    try {\n+      const res = await fetch(hook.url, { method: \"POST\", body });\n+      if (res.ok) return;\n+      if (res.status < 500) throw new DeliveryError(hook.id, res.status);",
      comments: [{ id: "t1a", author: "sam", at: at(301), body: "This `DeliveryError` is caught by the `catch` below, so a 4xx is retried anyway.", url: "" }, { id: "t1b", author: "jordan", at: at(118), body: "Good catch, fixed in 4f9c2e1.", url: "" }] },
    { id: "t2", path: "src/webhooks/deliver.ts", line: 19, original_line: 19, resolved: false, outdated: false, resolved_by: "", review_id: 11, more: 0, diff_hunk: "@@ -8,5 +8,13 @@\n+    } catch (e) {\n+      if (attempt === MAX_ATTEMPTS) throw e;\n+    }\n+    await sleep(2 ** attempt * 1000);",
      comments: [{ id: "t2a", author: "sam", at: at(300), body: "Worth adding jitter here so failing hooks do not retry in lockstep.", url: "" }] },
  ],
};

async function mockDaemon(page: Page, detail: { pull: PullRequest; timeline: PullTimeline } = { pull: pullFixture, timeline: timelineFixture }) {
  const inbox = { ...inboxFixture, pulls: [pullFixture], reviews: [reviewFixture] };
  await page.routeWebSocket("ws://127.0.0.1:19998/**", (socket) => {
    socket.onMessage((raw) => {
      if (typeof raw !== "string") return;
      const { id, method, params } = JSON.parse(raw);
      let result: unknown = null;
      switch (method) {
        case "daemon.info": result = { port: 19998, token: "shots", pid: 1, version: "0.2.8", started_at: at(600), data_dir: "/tmp" }; break;
        case "provider.list": result = providers; break;
        case "session.list": result = sessions; break;
        case "session.get": result = sessions.find((s) => s.id === params.id); break;
        case "session.history": result = (histories[params.id] ?? []).filter((e) => e.seq > (params.after_seq ?? 0)); break;
        case "session.pending": result = { approvals: params.id === ids.flaky ? [approval] : [], inputs: params.id === ids.billing ? [question] : [] }; break;
        case "group.list": result = [{ name: "acme", repos: [{ path: "/Users/sam/code/acme-api", last_used: at(10) }, { path: "/Users/sam/code/acme-web", last_used: at(20) }] }]; break;
        case "provider.models": result = [{ id: "claude-opus-5-5", display_name: "Opus 5.5", description: null, efforts: ["low", "medium", "high"], default_effort: "high", is_default: true }]; break;
        case "pty.attach": result = { scrollback: "" }; break;
        case "git.branch_status": result = null; break;
        case "git.status": case "git.diff_stat": case "git.log": case "git.worktrees": case "git.branches": result = []; break;
        case "pulls.list": case "pulls.refresh": result = inbox; break;
        case "pulls.get": result = { pull: detail.pull, timeline: detail.timeline, comments: [], reviews: [], threads: [], projects: [], project_error: null }; break;
        case "pulls.diff": result = { diff: diffFixture, sha: pullFixture.head_sha }; break;
        case "reviews.get": result = reviewFixture; break;
        case "reviews.defaults": result = { instructions: "Review correctness and edge cases", config: inboxFixture.defaults }; break;
        default:
          if (/history|commands|native|list|candidates/.test(method)) result = [];
      }
      socket.send(JSON.stringify({ id, result }));
    });
  });
}

const open = async (page: Page, sid: string, detail?: Parameters<typeof mockDaemon>[1]) => {
  await mockDaemon(page, detail);
  await page.goto(`/?port=19998&token=shots&session=${sid}`);
};

test("overview", async ({ page }) => {
  await open(page, ids.rate);
  await expect(page.getByText("Each plan now gets its own limiter", { exact: false })).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/overview.png` });
});

test("question", async ({ page }) => {
  await open(page, ids.billing);
  const card = page.locator("[data-input-id]");
  await expect(card).toBeVisible();
  await card.press("1");
  await card.press("2");
  await card.press("Enter");
  await card.press("ArrowDown");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/question.png` });
});

test("pull request review", async ({ page }) => {
  await open(page, ids.rate);
  await page.getByTitle("Retry failed webhook deliveries", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Retry failed webhook deliveries" })).toBeVisible();
  await page.getByRole("button", { name: /Open pre-review/ }).click();
  await expect(page.getByLabel("Summary", { exact: true })).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/pull-request.png` });
});

/** Not for the README: the PR page, open and merged, in both themes. Written to AURA_SHOTS_DIR. */
const SHOTS = process.env.AURA_SHOTS_DIR ?? "test-results/screenshots";
const reviewedPull = { ...pullFixture, review_decision: "APPROVED", milestone: 7, milestone_title: "October release", assignees: ["jordan"], reviews: [{ reviewer: "riley", bot: false, state: "APPROVED", submitted_at: at(90), commit_sha: "4f9c2e1d8b" }, { reviewer: "sam", bot: false, state: "CHANGES_REQUESTED", submitted_at: at(300), commit_sha: "3e8d2a1c4b" }] };
const variants = {
  open: { pull: reviewedPull, timeline: timelineFixture },
  merged: {
    pull: { ...reviewedPull, state: "merged", can_merge: false, merge_blocked_by: "This pull request is not open" },
    timeline: { ...timelineFixture, items: [...timelineFixture.items, event("merged", 30, { actor: "riley", subject: "main", sha: "7c1d9e3f2a" }), event("head_ref_deleted", 29, { actor: "riley", subject: "webhook-retries" })] },
  },
};
for (const [name, detail] of Object.entries(variants)) for (const theme of ["dark", "light"]) test(`pull request conversation (${name}, ${theme})`, async ({ page }) => {
  await open(page, ids.rate, detail);
  await page.getByTitle("Retry failed webhook deliveries", { exact: true }).click();
  await expect(page.getByText("Worth adding jitter here", { exact: false })).toBeVisible();
  await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/pull-${name}-${theme}.png` });
  await page.locator(".pr-detail-scroll").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/pull-${name}-${theme}-end.png` });
});
