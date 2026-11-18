import { expect, test, type Page } from "@playwright/test";
import type { ScheduledRun, ScheduledTask, Session } from "../../src/gen";

const session = (id: string, title: string): Session => ({ id, title, provider: "claude", agent: null, native_id: null, cwd: "/tmp/repo", worktree: null, group: null, status: "idle", mode: "structured", model: null, effort: null, permission_mode: null, sandbox_mode: null, command: null, created_at: "2026-11-18T10:00:00Z", last_activity: "2026-11-18T10:00:00Z", archived: false, pinned: false, last_error: null, pending_count: 0, exit_code: null, system_prompt: null, orchestrator: false, orchestrator_id: null, feature_owner: false, specialist_id: null, specialist_name: null, folderless: false, attention: null, pulls: [], usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, total_cost_usd: null, context_window: null, context_used: null, running_totals: false } });

/** A daemon that keeps scheduled tasks the way aurad does, for the methods the app calls. */
async function mockDaemon(page: Page) {
  const tasks: ScheduledTask[] = [];
  const runs: ScheduledRun[] = [];
  const sessions: Session[] = [session("session-1", "My coding session")];
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let send: (msg: unknown) => void = () => {};
  const changed = (id: string) => send({ method: "schedules.changed", params: { id } });
  const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString();
  await page.route("**/__aura/daemon.json", (route) => route.fulfill({ json: { port: 19998, token: "test" } }));
  await page.routeWebSocket("ws://127.0.0.1:19998/**", (socket) => {
    send = (msg) => socket.send(JSON.stringify(msg));
    socket.onMessage((raw) => {
      const { id, method, params } = JSON.parse(String(raw));
      calls.push({ method, params });
      let result: unknown = null;
      switch (method) {
        case "provider.list": result = [{ kind: "claude", display_name: "Claude Code", available: true, version: "test", binary: "/test/claude", capabilities: { structured: true, permission_modes: ["default", "acceptEdits"], sandbox_modes: [] }, agents: [] }]; break;
        case "session.list": result = sessions; break;
        case "daemon.info": result = { version: "test" }; break;
        case "provider.models": result = [{ id: "haiku", display_name: "Haiku", description: null, is_default: true, efforts: ["low", "high"], default_effort: "low" }]; break;
        case "orchestrator.projects": result = [{ path: "/tmp/repo", repo: true, groups: [], sessions: 1, last_used: "2026-11-18T10:00:00Z" }]; break;
        case "git.repo_root": result = "/tmp/repo"; break;
        case "group.list": result = []; break;
        case "schedules.list": result = tasks; break;
        case "schedules.preview": result = [tomorrow]; break;
        case "schedules.create": {
          const now = new Date().toISOString();
          const t: ScheduledTask = { id: "task-1", name: params.name, prompt: params.prompt, agent: params.agent, model: params.model || null, effort: params.effort || null, permission_mode: params.permission_mode || null, sandbox_mode: null, cwd: params.cwd, worktree: params.worktree, branch_prefix: null, group: null, enabled: params.enabled, schedule: params.schedule, missed: params.missed, allow_overlap: params.allow_overlap, created_at: now, updated_at: now, anchor: now, last_slot: null, next_run: tomorrow, last_run: null, created_by: null };
          tasks.push(t); result = t; changed(t.id); break;
        }
        case "schedules.run": {
          const s = session("session-2", `${tasks[0].name} · now`);
          sessions.push(s);
          send({ method: "event", params: { type: "session_created", session: s } });
          const r: ScheduledRun = { id: `run-${runs.length + 1}`, task_id: params.id, at: new Date().toISOString(), slot: null, trigger: "manual", result: "started", session_id: s.id, session_title: s.title, message: null };
          runs.unshift(r); tasks[0].last_run = r; result = r; changed(params.id); break;
        }
        case "schedules.runs": result = runs; break;
        default:
          if (method.includes("history") || method.includes("commands") || method.includes("native") || method === "feature.list") result = [];
          else if (method === "session.pending") result = { approvals: [], inputs: [] };
          else if (method === "pulls.list" || method === "pulls.refresh") result = { account: null, pulls: [], reviewed: [], mine: [], reviews: [], defaults: null, last_synced: null, error: null, blocked: null };
          break;
      }
      socket.send(JSON.stringify({ id, result }));
    });
  });
  /** What the daemon does when the schedule fires, or an orchestrator changes a task through `aura mcp`. */
  const elsewhere = (change: (t: ScheduledTask[], r: ScheduledRun[]) => void) => { change(tasks, runs); changed(tasks[0]?.id ?? ""); };
  return Object.assign(calls, { elsewhere });
}

test("a task is created, run now and opened from its history, by keyboard where it counts", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  const daemon = await mockDaemon(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Scheduled tasks/ })).toContainText("none yet");

  // Through the palette, as any command.
  await page.keyboard.press("Meta+k");
  await page.locator(".palette input").fill("New scheduled task");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "New scheduled task" })).toBeVisible();
  await expect(dialog.getByLabel("Name")).toBeFocused();
  await page.keyboard.type("Morning summary");
  await dialog.getByLabel("Prompt").fill("Summarise yesterday's commits.");
  await dialog.getByLabel(/Folder or repository/).fill("/tmp/repo");
  await dialog.getByLabel("Model").selectOption("haiku");
  await dialog.getByLabel("Unit").selectOption("weeks");
  await dialog.getByRole("button", { name: "Fri" }).click();
  await dialog.getByLabel("Time of day").fill("08:30");
  await expect(dialog.getByText(/Next runs: tomorrow/)).toBeVisible();
  await page.keyboard.press("Meta+Enter");
  await expect(dialog.getByRole("option", { name: /Morning summary/ })).toContainText("every week on Monday and Friday at 08:30");
  const create = daemon.find((c) => c.method === "schedules.create")!;
  expect(create.params).toMatchObject({ name: "Morning summary", agent: "claude", model: "haiku", cwd: "/tmp/repo", missed: "run_once", allow_overlap: false, schedule: { unit: "weeks", every: 1, weekdays: ["mon", "fri"], at: "08:30" } });
  await expect(dialog.getByText(/Next run tomorrow/)).toBeVisible();

  await dialog.getByRole("button", { name: /Run now/ }).click();
  const history = dialog.getByRole("region", { name: "Run history" });
  await expect(history.getByText("Started")).toBeVisible();
  await page.screenshot({ path: "/tmp/aura-scheduled-tasks.png", fullPage: true });
  await history.getByRole("button", { name: "Morning summary · now" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".titlebar")).toContainText("Morning summary · now");
  await expect(page.getByRole("button", { name: /Scheduled tasks/ })).toContainText("Morning summary");
  expect(errors).toEqual([]);
});

test("runs and changes made by the daemon or an orchestrator show up live", async ({ page }) => {
  const daemon = await mockDaemon(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Scheduled tasks/ })).toContainText("none yet");
  await page.keyboard.press("Meta+k");
  await page.locator(".palette input").fill("New scheduled task");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Nightly triage");
  await dialog.getByLabel("Prompt").fill("Triage new issues.");
  await dialog.getByLabel(/Folder or repository/).fill("/tmp/repo");
  await dialog.getByRole("button", { name: /Create/ }).click();
  await expect(dialog.getByRole("option", { name: /Nightly triage/ })).toBeVisible();

  // The schedule fires while the previous run still works: the skip is recorded.
  daemon.elsewhere((tasks, runs) => {
    const r: ScheduledRun = { id: "run-skip", task_id: tasks[0].id, at: new Date().toISOString(), slot: new Date().toISOString(), trigger: "schedule", result: "skipped", session_id: null, session_title: null, message: "The previous run, “Nightly triage · Wed”, is still working, so no second session was started." };
    runs.unshift(r); tasks[0].last_run = r;
  });
  const history = dialog.getByRole("region", { name: "Run history" });
  await expect(history.getByText("Skipped")).toBeVisible();
  await expect(history.getByText(/still working/)).toBeVisible();
  // An orchestrator renames and disables it through its tools.
  daemon.elsewhere((tasks) => { tasks[0].name = "Evening triage"; tasks[0].enabled = false; tasks[0].next_run = null; tasks[0].created_by = { orchestrator: "o1", orchestrator_title: "Lead" }; });
  await expect(dialog.getByRole("option", { name: /Evening triage/ })).toContainText("disabled");
  await expect(dialog.getByLabel("Name")).toHaveValue("Evening triage");
  await expect(dialog.getByText("by Lead")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Scheduled tasks/ })).toContainText("none enabled");
});
