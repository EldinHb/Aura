import { expect, test, type Page } from "@playwright/test";
import { diffFixture, inboxFixture, pullFixture, reviewFixture } from "../../src/features/reviews/fixtures";
import type { PreReview, Session } from "../../src/gen";

async function mockDaemon(page: Page) {
  let review: PreReview | null = null;
  let hidden = false;
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let notify = () => {};
  const session: Session = { id: "session-1", title: "My coding session", provider: "codex", agent: null, native_id: null, cwd: "/tmp", worktree: null, group: null, status: "idle", mode: "structured", model: null, effort: null, permission_mode: null, sandbox_mode: "read-only", command: null, created_at: "2026-09-22T10:00:00Z", last_activity: "2026-09-22T10:00:00Z", archived: false, pinned: false, last_error: null, pending_count: 0, exit_code: null, system_prompt: null, orchestrator: false, orchestrator_id: null, feature_owner: false, specialist_id: null, specialist_name: null, folderless: false, attention: null, pulls: [], usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, total_cost_usd: null, context_window: null, context_used: null, running_totals: false } };
  const inbox = () => ({ ...inboxFixture, pulls: [{ ...pullFixture, hidden }], reviews: review ? [review] : [] });
  await page.route("**/__aura/daemon.json", (route) => route.fulfill({ json: { port: 19999, token: "test" } }));
  await page.routeWebSocket("ws://127.0.0.1:19999/**", (socket) => {
    const changed = () => socket.send(JSON.stringify({ method: "reviews.changed", params: {} }));
    notify = changed;
    socket.onMessage((raw) => {
      const { id, method, params } = JSON.parse(String(raw));
      calls.push({ method, params });
      let result: unknown = null;
      switch (method) {
        case "provider.list": result = [{ kind: "codex", display_name: "Codex", available: true, version: "test", binary: "/test/codex", capabilities: { structured: true, terminal: false, models: true, effort: true, permission_modes: [], sandbox_modes: ["read-only"], slash_commands: false } }]; break;
        case "sessions.list": case "session.list": result = [session]; break;
        case "daemon.info": result = { version: "test" }; break;
        case "session.history": case "history": case "feature.list": result = []; break;
        case "settings.get": result = null; break;
        case "provider.models": result = [{ id: "model-test", display_name: "Test model", is_default: true, efforts: ["low", "high"], default_effort: "high" }]; break;
        case "pulls.list": case "pulls.refresh": result = inbox(); break;
        case "pulls.get": result = { pull: pullFixture, comments: [], reviews: [], threads: [], projects: [], project_error: null }; break;
        case "pulls.diff": result = { diff: diffFixture, sha: pullFixture.head_sha }; break;
        case "pulls.hide": hidden = true; result = inbox(); changed(); break;
        case "pulls.restore": hidden = false; result = inbox(); changed(); break;
        case "reviews.defaults": result = { instructions: "Review correctness and edge cases", config: inboxFixture.defaults }; break;
        case "reviews.start": review = { ...structuredClone(reviewFixture), config: params.config, status: "running", phase: "running" }; result = review; changed(); setTimeout(() => { if (review) { review.status = "ready"; review.phase = "done"; changed(); } }, 450); break;
        case "reviews.get": result = review; break;
        case "reviews.save": if (review) { review.result = params.result; review.revision++; result = review; } break;
        case "reviews.preview": result = { token: "preview-token", review_id: review!.id, revision: review!.revision, account: pullFixture.account, head_sha: pullFixture.head_sha, reviewed_sha: pullFixture.head_sha, event: "COMMENT", body: review!.result.summary, comments: review!.result.comments.filter((c) => !c.deleted), stale: false }; break;
        case "reviews.submit": review!.status = "submitted"; review!.submitted_url = pullFixture.url; result = review; changed(); break;
        case "reviews.ready": review!.status = "ready"; review!.phase = "done"; result = review; changed(); break;
        default: if (method.includes("history") || method.includes("commands") || method.includes("native")) result = []; else if (method === "session.pending") result = { approvals: [], inputs: [] }; break;
      }
      socket.send(JSON.stringify({ id, result }));
    });
  });
  /** What the daemon does when an orchestrator records or changes a review through `aura mcp`: store it and say so. */
  const orchestrator = (next: (current: PreReview | null) => PreReview) => { review = next(review); notify(); };
  return Object.assign(calls, { orchestrator });
}

test("PR settings, editing, preview and explicit submission preserve the chat draft", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  const calls = await mockDaemon(page);
  await page.goto("/");
  await expect(page.getByTitle("Handle empty responses", { exact: true })).toBeVisible();
  const composer = page.locator(".composer [aria-label='Message']");
  await expect(composer).toBeVisible(); await composer.fill("Keep my unsent session message");
  await page.getByTitle("Handle empty responses", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Handle empty responses" })).toBeVisible();
  await page.getByRole("button", { name: "Pre-review…", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(calls.filter((c) => c.method === "reviews.start")).toHaveLength(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Pre-review…", exact: true }).click();
  await page.getByLabel("Review instructions").selectOption("append");
  await page.getByLabel("Additional instructions").fill("Check empty responses carefully");
  await page.getByLabel("Effort", { exact: true }).selectOption("high");
  await page.getByRole("button", { name: "Start pre-review" }).click();
  await expect(page.getByLabel("Summary", { exact: true })).toBeVisible();
  expect(calls.filter((c) => c.method === "reviews.start")).toHaveLength(1);
  await page.getByLabel("Summary", { exact: true }).fill("Edited summary, ready to post");
  await page.screenshot({ path: "/tmp/aura-pr-review-editor.png", fullPage: true });
  await page.getByRole("button", { name: "Submit to GitHub…" }).click();
  await expect(page.getByRole("dialog")).toContainText("Edited summary, ready to post");
  expect(calls.filter((c) => c.method === "reviews.submit")).toHaveLength(0);
  await page.getByRole("button", { name: "Post comment", exact: true }).click();
  await expect(page.getByText("✓ Submitted to GitHub")).toBeVisible();
  expect(calls.filter((c) => c.method === "reviews.submit")).toHaveLength(1);
  await page.getByText("My coding session", { exact: true }).click();
  await expect(composer).toHaveText("Keep my unsent session message");
  expect(errors).toEqual([]);
});

test("hidden PRs survive refresh and can be restored", async ({ page }) => {
  await mockDaemon(page); await page.goto("/");
  await expect(page.getByTitle("Hide PR", { exact: true })).toBeVisible();
  await page.getByTitle("Hide PR", { exact: true }).click();
  await expect(page.locator(".pr-sidebar-row")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".pr-sidebar-row")).toHaveCount(0);
  await page.getByTitle("Refresh pull requests").click();
  await expect(page.locator(".pr-sidebar-row")).toHaveCount(0);
  await page.getByRole("button", { name: "Show hidden", exact: true }).click();
  await page.getByTitle("Restore PR", { exact: true }).click();
  await expect(page.getByTitle("Hide PR", { exact: true })).toBeVisible();
});

test("PR workspace adapts to light theme and a narrow window", async ({ page }) => {
  await mockDaemon(page); await page.setViewportSize({ width: 900, height: 800 });
  await page.goto("/"); await page.getByTitle("Handle empty responses", { exact: true }).click();
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.getByRole("button", { name: "Files changed" }).click();
  await expect(page.locator(".pr-diff-file")).toBeVisible();
  await page.screenshot({ path: "/tmp/aura-pr-workspace.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});


test("keyboard navigation reaches PRs and opens settings without starting a job", async ({ page }) => {
  const calls = await mockDaemon(page); await page.goto("/");
  await expect(page.getByTitle("Hide PR", { exact: true })).toBeVisible();
  await page.locator('[data-region="sidebar"]').focus();
  await page.keyboard.press("j");
  await expect(page.getByRole("heading", { name: "Handle empty responses" })).toBeVisible();
  await page.keyboard.press("Meta+k");
  await page.locator(".palette input").fill("Pre-review selected");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(calls.filter((c) => c.method === "reviews.start")).toHaveLength(0);
});

test("a review an orchestrator records shows up live, follows its changes and reaches the user when ready", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  const daemon = await mockDaemon(page);
  await page.goto("/");
  const row = page.locator(".pr-sidebar-row", { hasText: "Handle empty responses" });
  await expect(row).toBeVisible();
  await expect(row.getByTitle(/Recorded by/)).toHaveCount(0);
  const source = { orchestrator: "orchestrator-1", orchestrator_title: "Review lead", worker: "worker-1", worker_title: "Review #42" };
  const agent = { provider: "Codex", model: "gpt-5.5", model_id: null, effort: "high" };
  // create_review with ready: false, then add_review_comment, then update_review with ready: true.
  daemon.orchestrator(() => ({ ...structuredClone(reviewFixture), status: "drafting", phase: "drafting", context_mode: "recorded", source, agent, result: { ...reviewFixture.result, summary: "Started by the worker", verdict: "approve", comments: [] } }));
  await expect(row.getByTitle("Recorded by Review lead from its worker Review #42")).toHaveText("drafting");
  await row.getByRole("button").first().click();
  await page.getByRole("button", { name: "Open pre-review · drafting" }).click();
  await expect(page.getByText("Review lead is still writing this review.", { exact: false })).toBeVisible();
  await expect(page.getByText("Codex · model gpt-5.5 · effort high · Recorded by Review lead from its worker Review #42", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Summary", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Submit to GitHub…" })).toHaveCount(0);
  daemon.orchestrator((r) => ({ ...r!, revision: 1, result: { ...r!.result, comments: [{ ...reviewFixture.result.comments[0], id: "nit-1", severity: "nit", body: "Name the guard after what it checks." }] } }));
  await expect(page.getByLabel("Finding at service.ts:1")).toHaveValue("Name the guard after what it checks.");
  daemon.orchestrator((r) => ({ ...r!, revision: 2, status: "ready", phase: "done", result: { ...r!.result, summary: "Approve: handles empty responses." } }));
  await expect(page.getByLabel("Summary", { exact: true })).toHaveValue("Approve: handles empty responses.");
  await expect(page.getByLabel("Summary", { exact: true })).toBeEnabled();
  await expect(row.getByTitle(/Recorded by Review lead/)).toHaveText("ready");
  await page.screenshot({ path: "/tmp/aura-pr-review-recorded.png", fullPage: true });
  // Posting stays the user's, through the same preview and explicit Post button.
  await page.getByRole("button", { name: "Submit to GitHub…" }).click();
  await expect(page.getByRole("dialog")).toContainText("Approve: handles empty responses.");
  expect(daemon.filter((c) => c.method === "reviews.submit")).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("the user takes over a review an orchestrator left unfinished", async ({ page }) => {
  const daemon = await mockDaemon(page);
  await page.goto("/");
  daemon.orchestrator(() => ({ ...structuredClone(reviewFixture), status: "drafting", phase: "drafting", context_mode: "recorded", source: { orchestrator: "o", orchestrator_title: "Review lead", worker: null, worker_title: null } }));
  await page.getByTitle("Handle empty responses", { exact: true }).click();
  await page.getByRole("button", { name: "Open pre-review · drafting" }).click();
  await page.getByRole("button", { name: "Take over and edit" }).click();
  await expect(page.getByLabel("Summary", { exact: true })).toBeEnabled();
  expect(daemon.filter((c) => c.method === "reviews.ready")).toHaveLength(1);
});
