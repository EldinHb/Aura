import { expect, test, type Page } from "@playwright/test";
import type { Session, Workspace } from "../../src/gen";

/**
 * QA probes for workspaces, Elsewhere, Scheduled runs, leaders-only and cleanup,
 * against a stateful fake daemon. Run:
 *   SHOTS=/tmp/aura-qa pnpm exec playwright test -c playwright.screenshots.config.ts workspaces-qa
 */
const OUT = process.env.SHOTS ?? "test-results/workspaces-qa";
const now = Date.now();
const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
const usage = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, total_cost_usd: null, context_window: null, context_used: null, running_totals: false };
const id = (n: number) => `5e55a0e0-0000-4000-8000-${String(n).padStart(12, "0")}`;

function session(n: number, over: Partial<Session>): Session {
  return { id: id(n), title: `S${n}`, provider: "claude", agent: null, native_id: null, cwd: "/Users/sam/code/aura", worktree: null, group: null, workspace: "a", status: "idle", mode: "structured", model: null, effort: null, permission_mode: null, sandbox_mode: null, command: null, created_at: at(240), last_activity: at(10), archived: false, pinned: false, last_error: null, pending_count: 0, exit_code: null, system_prompt: null, orchestrator: false, orchestrator_id: null, feature_owner: false, specialist_id: null, specialist_name: null, folderless: false, attention: null, scheduled_task_id: null, scheduled_task_name: null, usage, ...over };
}

type Fake = {
  workspaces: Workspace[];
  sessions: Session[];
  tasks: Record<string, unknown>[];
  calls: { method: string; params: any }[];
  failDelete: Set<string>;
  push: (ev: unknown) => void;
};

const WS: Workspace[] = [
  { id: "a", name: "Alpha", created_at: at(9000), position: 0 },
  { id: "b", name: "Beta", created_at: at(8000), position: 1 },
];

async function boot(page: Page, sessions: Session[], opts: { workspaces?: Workspace[]; tasks?: Record<string, unknown>[]; active?: string; select?: string; url?: string } = {}): Promise<Fake> {
  const fake: Fake = { workspaces: opts.workspaces ?? WS.map((w) => ({ ...w })), sessions: sessions.map((s) => ({ ...s })), tasks: opts.tasks ?? [], calls: [], failDelete: new Set(), push: () => {} };
  await page.addInitScript((active) => {
    localStorage.setItem("aura.workspace", active);
  }, opts.active ?? "a");
  await page.setViewportSize({ width: 1300, height: 900 });
  await page.routeWebSocket("ws://127.0.0.1:19997/**", (socket) => {
    fake.push = (ev) => socket.send(JSON.stringify({ method: "event", params: ev }));
    socket.onMessage((raw) => {
      if (typeof raw !== "string") return;
      const { id: rid, method, params } = JSON.parse(raw);
      fake.calls.push({ method, params });
      let result: unknown = null;
      let error: string | null = null;
      switch (method) {
        case "daemon.info": result = { port: 19997, token: "t", pid: 1, version: "0.5.0", started_at: at(600), data_dir: "/tmp" }; break;
        case "provider.list": result = []; break;
        case "session.list": result = fake.sessions; break;
        case "session.get": result = fake.sessions.find((s) => s.id === params.id); break;
        case "session.pending": result = { approvals: [], inputs: [] }; break;
        case "mods.inbox": result = []; break;
        case "schedules.list": result = fake.tasks; break;
        case "workspace.list": result = fake.workspaces; break;
        case "workspace.touch": result = true; break;
        case "workspace.create": {
          const w = { id: `w${fake.workspaces.length + 1}${Math.random().toString(36).slice(2, 5)}`, name: params.name, created_at: at(0), position: fake.workspaces.length };
          fake.workspaces.push(w);
          result = w;
          break;
        }
        case "workspace.rename": {
          const w = fake.workspaces.find((x) => x.id === params.id)!;
          w.name = params.name;
          result = w;
          break;
        }
        case "workspace.delete": {
          for (const s of fake.sessions) if (s.workspace === params.id) { s.workspace = params.move_to; fake.push({ type: "session_updated", session: s }); }
          fake.workspaces = fake.workspaces.filter((w) => w.id !== params.id);
          result = fake.workspaces;
          break;
        }
        case "session.set_workspace": {
          const tree = (rootId: string): Session[] => {
            const r = fake.sessions.find((s) => s.id === rootId)!;
            return [r, ...fake.sessions.filter((s) => s.orchestrator_id === rootId).flatMap((s) => tree(s.id))];
          };
          const moved = tree(params.id);
          for (const s of moved) s.workspace = params.workspace;
          result = moved;
          break;
        }
        case "session.delete_many": {
          const deleted: string[] = [];
          const failed: { id: string; error: string }[] = [];
          for (const sid of params.ids) {
            if (fake.failDelete.has(sid)) { failed.push({ id: sid, error: "Couldn't stop the process: EPERM" }); continue; }
            deleted.push(sid);
            fake.sessions = fake.sessions.filter((s) => s.id !== sid && s.orchestrator_id !== sid);
            fake.push({ type: "session_removed", session_id: sid });
          }
          result = { deleted, failed };
          break;
        }
        case "session.delete": fake.sessions = fake.sessions.filter((s) => s.id !== params.id); result = true; break;
        default:
          if (/history|commands|native|list|candidates|status|diff_stat|log|worktrees|branches/.test(method)) result = [];
      }
      socket.send(JSON.stringify(error ? { id: rid, error: { code: -32000, message: error } } : { id: rid, result }));
    });
  });
  await page.goto(opts.url ?? `/?port=19997&token=t${opts.select ? `&session=${opts.select}` : ""}`);
  await expect(page.locator(".sidebar")).toBeVisible();
  await page.waitForTimeout(400);
  return fake;
}

const rows = (page: Page) => page.locator(".sidebar .session-list [data-session-id]");
const titles = async (page: Page) => (await rows(page).locator(".title").allInnerTexts()).map((t) => t.trim());
const sidebarText = (page: Page) => page.locator(".sidebar").innerText();
const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/${name}.png` });
const dialog = (page: Page) => page.locator(".modal");

// ---------------------------------------------------------------- 1. workspaces

test("1a create: validation (empty, duplicate, case, >40) then success switches", async ({ page }) => {
  const fake = await boot(page, [session(1, { title: "In alpha" })]);
  await page.getByRole("button", { name: /^Workspace: / }).click();
  await page.getByRole("option", { name: /New workspace/ }).click();
  const input = page.locator("#workspace-name");
  await expect(input).toBeVisible();
  const create = dialog(page).getByRole("button", { name: /^Create/ });
  await expect(create).toBeDisabled();
  await input.fill("alpha");
  await expect(page.locator("#workspace-name-error")).toHaveText(/already exists/);
  await expect(create).toBeDisabled();
  await input.fill("  BETA ");
  await expect(page.locator("#workspace-name-error")).toHaveText(/already exists/);
  await input.fill("   ");
  await expect(page.locator("#workspace-name-error")).toHaveText(/can't be empty/);
  await input.fill("x".repeat(41));
  await expect(page.locator("#workspace-name-error")).toHaveText(/at most 40/);
  await expect(create).toBeDisabled();
  await input.fill("y".repeat(40));
  await expect(create).toBeEnabled();
  await shot(page, "1a-40chars");
  await input.fill("  Gamma  ");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Workspace: Gamma. Switch workspace" })).toBeVisible();
  expect(fake.calls.find((c) => c.method === "workspace.create")?.params).toEqual({ name: "Gamma" });
  await expect(page.getByText("No sessions in Gamma yet.")).toBeVisible();
  await shot(page, "1a-empty-ws");
});

test("1a2 40-char name does not wreck the switcher layout", async ({ page }) => {
  const long = "W".repeat(40);
  await boot(page, [session(1, { title: "In alpha" })], { workspaces: [{ id: "a", name: long, created_at: at(9), position: 0 }, ...WS.slice(1)] });
  const box = await page.locator(".workspace-switcher").boundingBox();
  const sb = await page.locator(".sidebar").boundingBox();
  expect(box!.width).toBeLessThanOrEqual(sb!.width + 1);
  await shot(page, "1a2-long-name");
});

test("1b rename + switch + keyboard shortcuts (⌃1-9, ⌘⇧K)", async ({ page }) => {
  const fake = await boot(page, [session(1, { title: "In alpha" }), session(2, { title: "In beta", workspace: "b" })]);
  expect(await titles(page)).toEqual(["In alpha"]);
  await page.getByRole("button", { name: "Workspace actions" }).click();
  await page.getByRole("menuitem", { name: /Rename workspace/ }).click();
  await page.locator("#workspace-name").fill("alpha"); // same name, different case, own id: allowed
  await expect(page.locator("#workspace-name-error")).toHaveCount(0);
  await page.locator("#workspace-name").fill("Alpha 2");
  await page.locator("#workspace-name").press("Enter");
  await expect(page.getByRole("button", { name: "Workspace: Alpha 2. Switch workspace" })).toBeVisible();
  expect(fake.calls.some((c) => c.method === "workspace.rename")).toBe(true);
  // ⌃2 switches
  await page.keyboard.press("Control+2");
  await expect(page.getByRole("button", { name: /Workspace: Beta/ })).toBeVisible();
  expect(await titles(page)).toEqual(["In beta"]);
  await page.keyboard.press("Control+1");
  await expect(page.getByRole("button", { name: /Workspace: Alpha 2/ })).toBeVisible();
  await page.keyboard.press("Control+9"); // no 9th: no-op
  await expect(page.getByRole("button", { name: /Workspace: Alpha 2/ })).toBeVisible();
  // ⌘⇧K opens the switcher
  await page.keyboard.press("Meta+Shift+K");
  await expect(page.getByRole("listbox", { name: "Workspaces" })).toBeVisible();
  await shot(page, "1b-switcher");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /Workspace: Beta/ })).toBeVisible();
});

test("1c delete: empty, with move-to, active, and last", async ({ page }) => {
  const fake = await boot(page, [session(1, { title: "In alpha" }), session(2, { title: "In beta", workspace: "b" })], {
    workspaces: [...WS, { id: "c", name: "Empty", created_at: at(5), position: 2 }],
  });
  // empty workspace → plain confirm
  await page.keyboard.press("Control+3");
  await page.getByRole("button", { name: "Workspace actions" }).click();
  await page.getByRole("menuitem", { name: /Delete workspace/ }).click();
  await expect(dialog(page)).toContainText("It has no sessions");
  await shot(page, "1c-delete-empty");
  await dialog(page).getByRole("button", { name: /^Delete/ }).click();
  await expect(page.getByRole("button", { name: /Workspace: Alpha/ })).toBeVisible({ timeout: 3000 }).catch(async () => { await shot(page, "1c-after-empty-delete"); throw new Error("did not leave deleted active workspace"); });
  // delete active workspace with sessions → move to dialog
  await page.getByRole("button", { name: "Workspace actions" }).click();
  await page.getByRole("menuitem", { name: /Delete workspace/ }).click();
  await expect(dialog(page)).toContainText("1 session");
  await shot(page, "1c-delete-move");
  await dialog(page).locator("select").selectOption("b");
  await dialog(page).getByRole("button", { name: /Move and delete/ }).click();
  await expect(page.getByRole("button", { name: /Workspace: Beta/ })).toBeVisible();
  expect((await titles(page)).sort()).toEqual(["In alpha", "In beta"]);
  expect(fake.calls.find((c) => c.method === "workspace.delete" && c.params.move_to === "b")).toBeTruthy();
  // last workspace
  await page.getByRole("button", { name: "Workspace actions" }).click();
  const del = page.getByRole("menuitem", { name: /Delete workspace/ });
  await expect(del).toBeDisabled();
  await shot(page, "1c-last-disabled");
  await page.keyboard.press("Escape");
  // palette command on last workspace
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Workspace: Delete");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Aura needs at least one workspace")).toBeVisible();
  // switcher hidden/rail hidden with one workspace
  await expect(page.locator(".status-rail [aria-label='Other workspaces']")).toHaveCount(0);
});

test("1d move a session; orchestrator moves its tree; worker refuses", async ({ page }) => {
  const fake = await boot(page, [
    session(1, { title: "Boss", orchestrator: true }),
    session(2, { title: "W1", orchestrator_id: id(1) }),
    session(3, { title: "W2", orchestrator_id: id(1), orchestrator: true }),
    session(4, { title: "W3", orchestrator_id: id(3) }),
    session(5, { title: "Plain" }),
  ], { select: id(5) });
  // worker: refuse
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("@W1");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Move to workspace");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Workers stay with their orchestrator/).first()).toBeVisible();
  await shot(page, "1d-worker-refused");
  // orchestrator: move
  await rows(page).filter({ hasText: "Boss" }).first().click();
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Move to workspace");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toContainText(/Moves .*Boss.* and its 3 workers/);
  await shot(page, "1d-move-picker");
  await dialog(page).getByText("Beta", { exact: true }).click();
  await page.waitForTimeout(300);
  const moved = fake.calls.find((c) => c.method === "session.set_workspace");
  expect(moved?.params.workspace).toBe("b");
  expect(fake.sessions.filter((s) => s.workspace === "b").length).toBe(4);
  await shot(page, "1d-after-move");
  expect(await titles(page)).toEqual(["Plain"]);
  await expect(page.getByText(/Moved .Boss. to Beta/)).toBeVisible();
});

// ---------------------------------------------------------------- 2. elsewhere

test("2 Elsewhere: needs-you, idle folded, overflow >5, click jumps and switches", async ({ page }) => {
  const sessions: Session[] = [session(1, { title: "Local" })];
  for (let i = 0; i < 7; i++) sessions.push(session(10 + i, { title: `Needs ${i}`, workspace: "b", pending_count: 1, status: "waiting_approval", attention: "waiting", last_activity: at(i + 1) }));
  for (let i = 0; i < 3; i++) sessions.push(session(30 + i, { title: `Idle ${i}`, workspace: "b", last_activity: at(100 + i) }));
  sessions.push(session(40, { title: "Archived idle", workspace: "b", archived: true }));
  sessions.push(session(41, { title: "Working elsewhere", workspace: "b", status: "running" }));
  await boot(page, sessions);
  const rail = page.getByRole("group", { name: "Other workspaces" });
  await expect(rail).toBeVisible();
  await shot(page, "2-rail");
  const needRows = rail.locator("[data-session-id-rail]");
  expect(await needRows.count()).toBe(5);
  await expect(rail.getByText("+ 2 more")).toBeVisible();
  await expect(rail).not.toContainText("Working elsewhere");
  await expect(rail).not.toContainText("Archived idle");
  await expect(rail).toContainText("Idle · 3");
  await expect(rail).not.toContainText("Idle 0");
  await rail.getByText("+ 2 more").click();
  expect(await needRows.count()).toBe(7);
  await shot(page, "2-rail-expanded");
  await rail.getByText("Idle · 3").click();
  await expect(rail).toContainText("Idle 0");
  await needRows.first().click();
  await expect(page.getByRole("button", { name: /Workspace: Beta/ })).toBeVisible();
  await shot(page, "2-after-jump");
});

test("2b Elsewhere hidden-state text when nothing needs you", async ({ page }) => {
  await boot(page, [session(1, { title: "Local" }), session(2, { title: "Other idle", workspace: "b" })]);
  const rail = page.getByRole("group", { name: "Other workspaces" });
  await expect(rail).toContainText("Nothing needs you elsewhere.");
});

// ---------------------------------------------------------------- 3. scheduled

test("3 scheduled runs stay out of every state section and the rail, own section", async ({ page }) => {
  const sessions = [
    session(1, { title: "Plain waiting", pending_count: 1, status: "waiting_approval", attention: "waiting" }),
    session(2, { title: "Plain working", status: "running" }),
    session(3, { title: "Plain idle" }),
    session(4, { title: "RUN-waiting", scheduled_task_id: "t1", scheduled_task_name: "Nightly", pending_count: 1, status: "waiting_approval", attention: "waiting" }),
    session(5, { title: "RUN-working", scheduled_task_id: "t1", scheduled_task_name: "Nightly", status: "running" }),
    session(6, { title: "RUN-idle", scheduled_task_id: "t1", scheduled_task_name: "Nightly" }),
    session(7, { title: "RUN-worker", orchestrator_id: id(5), scheduled_task_id: null }),
    session(8, { title: "RUN-b-waiting", workspace: "b", scheduled_task_id: "t2", scheduled_task_name: "Other nightly", pending_count: 1, status: "waiting_approval", attention: "waiting" }),
    session(9, { title: "RUN-b-idle", workspace: "b", scheduled_task_id: "t2", scheduled_task_name: "Other nightly" }),
  ];
  await boot(page, sessions);
  const list = await titles(page);
  console.log("SESSIONS TAB:", JSON.stringify(list));
  for (const t of list) expect(t).not.toMatch(/RUN-/);
  const rail = page.getByRole("group", { name: "Other workspaces" });
  await expect(rail).not.toContainText("RUN-b");
  await expect(rail).not.toContainText("Other nightly");
  const sched = page.getByRole("group", { name: "Scheduled runs" });
  console.log("SCHEDULED RAIL:", (await sched.innerText().catch(() => "(none)")).replace(/\n/g, " | "));
  await shot(page, "3-sessions-tab");
  // Scheduled tab
  await page.getByRole("tab", { name: /Scheduled/ }).click().catch(() => page.getByRole("button", { name: /^Scheduled/ }).first().click());
  await page.waitForTimeout(300);
  console.log("SCHEDULED TAB:", (await sidebarText(page)).replace(/\n/g, " | "));
  await shot(page, "3-scheduled-tab");
});

// ---------------------------------------------------------------- 4. leaders only

test("4 leaders only: no worker rows, rollup, peek, nested, orphan", async ({ page }) => {
  const sessions = [
    session(1, { title: "Lead idle", orchestrator: true }),
    session(2, { title: "w-running", orchestrator_id: id(1), status: "running" }),
    session(3, { title: "w-waiting", orchestrator_id: id(1), status: "waiting_input", pending_count: 1, attention: "waiting" }),
    session(4, { title: "w-sub-orch", orchestrator_id: id(1), orchestrator: true }),
    session(5, { title: "w-subsub", orchestrator_id: id(4), status: "waiting_approval", pending_count: 2, attention: "waiting" }),
    session(6, { title: "Lead2 finished", orchestrator: true }),
    session(7, { title: "w-done", orchestrator_id: id(6), attention: "done" }),
    session(8, { title: "Lead3 working-only", orchestrator: true }),
    session(9, { title: "w-run2", orchestrator_id: id(8), status: "running" }),
    session(10, { title: "Orphan worker", orchestrator_id: id(999) }),
    session(11, { title: "Plain" }),
  ];
  await boot(page, sessions);
  const top = await titles(page);
  console.log("TOP ROWS:", JSON.stringify(top));
  await shot(page, "4-collapsed");
  const text = await sidebarText(page);
  console.log("SIDEBAR:", text.replace(/\n/g, " | "));
  for (const w of ["w-running", "w-sub-orch", "w-done", "w-run2"]) expect(top.join("|")).not.toContain(w);
  // w-waiting is peeked, w-subsub (sub-orch's worker, waits) should be peeked too
  await expect(page.locator('[data-session-id="' + id(3) + '"]')).toBeVisible();
  console.log("subsub peeked:", await page.locator('[data-session-id="' + id(5) + '"]').isVisible());
  // Section membership
  const section = async (title: string) => page.evaluate((t) => {
    let el = [...document.querySelectorAll(".sidebar .session-list [data-session-id]")].find((e) => e.textContent?.includes(t));
    let prev: Element | null = el ?? null;
    while (prev) { if (prev.matches?.(".section-title,.section-heading,[class*=section]") && !prev.matches("[data-session-id]")) return prev.textContent; prev = prev.previousElementSibling ?? prev.parentElement; }
    return null;
  }, title);
  for (const t of ["Lead idle", "Lead2 finished", "Lead3 working-only", "Orphan worker", "Plain"]) console.log("SECTION", t, "=>", await section(t));
  // orphan appears as its own row (its orchestrator is gone)?
  console.log("orphan row visible:", top.includes("Orphan worker"));
});

test("4b expand/collapse + keyboard walks leaders only", async ({ page }) => {
  const sessions = [
    session(1, { title: "Lead A", orchestrator: true, last_activity: at(1) }),
    session(2, { title: "wa1", orchestrator_id: id(1) }),
    session(3, { title: "Lead B", orchestrator: true, last_activity: at(2) }),
    session(4, { title: "wb1", orchestrator_id: id(3) }),
    session(5, { title: "Plain C", last_activity: at(3) }),
  ];
  await boot(page, sessions, { select: id(1) });
  console.log("4b rows:", JSON.stringify(await titles(page)));
  await rows(page).first().click();
  await page.keyboard.press("Escape");
  // ⌘2 selects 2nd LEADER
  await page.keyboard.press("Meta+2");
  await page.waitForTimeout(200);
  console.log("⌘2 url/selected:", await page.locator(".session-row.selected, .session-row[aria-selected=true], .session-row.active").allInnerTexts());
  await page.keyboard.press("Meta+3");
  await page.waitForTimeout(200);
  console.log("⌘3 selected:", await page.locator(".session-row.selected, .session-row.active").allInnerTexts());
  await page.keyboard.press("Meta+4");
  await page.waitForTimeout(200);
  console.log("⌘4 selected (should be unchanged, no 4th leader):", await page.locator(".session-row.selected, .session-row.active").allInnerTexts());
  // ⌘K finds workers
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("@wb1");
  await expect(page.locator(".palette, [role=dialog], .modal").first()).toContainText("wb1");
  await shot(page, "4b-palette-worker");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  await shot(page, "4b-after-palette");
  console.log("after ⌘K worker: rows", JSON.stringify(await titles(page)));
});

// ---------------------------------------------------------------- 5. cleanup

function cleanupSessions(): Session[] {
  return [
    session(1, { title: "Orch 1", orchestrator: true, last_activity: at(1) }),
    session(2, { title: "idle w", orchestrator_id: id(1), created_at: at(200) }),
    session(3, { title: "done w", orchestrator_id: id(1), attention: "done", created_at: at(190) }),
    session(4, { title: "running w", orchestrator_id: id(1), status: "running", created_at: at(180) }),
    session(5, { title: "waiting w", orchestrator_id: id(1), status: "waiting_approval", pending_count: 1, attention: "waiting", created_at: at(170) }),
    session(6, { title: "failed w", orchestrator_id: id(1), status: "error", attention: "failed", created_at: at(160) }),
    session(7, { title: "sub orch", orchestrator_id: id(1), orchestrator: true, created_at: at(150) }),
    session(8, { title: "sub worker", orchestrator_id: id(7), created_at: at(140) }),
    session(9, { title: "Orphan", orchestrator_id: id(777) }),
    session(20, { title: "Sched run", scheduled_task_id: "t1", scheduled_task_name: "Nightly" }),
    session(21, { title: "Sched worker", orchestrator_id: id(20) }),
    session(22, { title: "Sched orch", scheduled_task_id: "t1", scheduled_task_name: "Nightly", orchestrator: true }),
    session(30, { title: "Beta orch", workspace: "b", orchestrator: true }),
    session(31, { title: "beta w", workspace: "b", orchestrator_id: id(30) }),
    session(50, { title: "Plain leader" }),
  ];
}

test("5 cleanup dialog: groups, defaults, scheduled separate, one confirm, partial failure + retry", async ({ page }) => {
  const fake = await boot(page, cleanupSessions());
  await page.getByRole("button", { name: "Workspace actions" }).click();
  await page.getByRole("menuitem", { name: "Clean up worker sessions…" }).click();
  await expect(dialog(page)).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, "5-cleanup");
  const m = dialog(page);
  console.log("DIALOG:", (await m.innerText()).replace(/\n/g, " | "));
  const state = await m.locator("input[type=checkbox]").evaluateAll((els) => els.map((e: any) => ({ label: e.closest("label, li, div")?.textContent?.trim().slice(0, 60), checked: e.checked, disabled: e.disabled })));
  console.log("CHECKBOXES:", JSON.stringify(state, null, 1));
  // orchestrators never listed as rows
  const text = await m.innerText();
  expect(text).not.toContain("Plain leader");
  expect(text).not.toContain("Sched orch\n");
  // delete: one confirmation
  const del = m.getByRole("button", { name: /^Delete \d+/ });
  console.log("delete label:", await del.innerText());
  fake.failDelete.add(id(6));
  await del.click();
  await expect(page.locator(".modal").last()).toContainText(/Delete \d+ worker session/);
  await shot(page, "5-confirm");
  console.log("CONFIRM:", (await page.locator(".modal").last().innerText()).replace(/\n/g, " | "));
  await page.locator(".modal").last().getByRole("button", { name: "Delete", exact: true }).click();
  await page.waitForTimeout(500);
  await shot(page, "5-partial");
  console.log("AFTER:", (await page.locator(".modal").first().innerText()).replace(/\n/g, " | "));
  const dm = fake.calls.filter((c) => c.method === "session.delete_many");
  console.log("delete_many calls:", JSON.stringify(dm.map((c) => c.params)));
  expect(dm[0].params.remove_worktree).toBe(false);
  await expect(page.getByRole("button", { name: "Retry failed" })).toBeVisible();
  fake.failDelete.clear();
  await page.getByRole("button", { name: "Retry failed" }).click();
  await page.waitForTimeout(500);
  await shot(page, "5-retried");
  console.log("AFTER RETRY dialog count:", await page.locator(".modal").count());
  console.log("retry calls:", JSON.stringify(fake.calls.filter((c) => c.method === "session.delete_many").map((c) => c.params.ids.length)));
});

test("5b cleanup empty list", async ({ page }) => {
  await boot(page, [session(1, { title: "Plain" })]);
  await page.getByRole("button", { name: "Workspace actions" }).click();
  await page.getByRole("menuitem", { name: "Clean up worker sessions…" }).click();
  await expect(dialog(page)).toContainText("No worker sessions to clean up.");
  await shot(page, "5b-empty");
});

test("5c cleanup: all-workspaces scope toggle", async ({ page }) => {
  await boot(page, cleanupSessions());
  await page.getByRole("button", { name: "Workspace actions" }).click();
  await page.getByRole("menuitem", { name: "Clean up worker sessions…" }).click();
  const before = await dialog(page).innerText();
  expect(before).not.toContain("beta w");
  const sel = dialog(page).locator("select");
  if (await sel.count()) await sel.selectOption({ index: 1 });
  await page.waitForTimeout(200);
  await shot(page, "5c-all");
  expect(await dialog(page).innerText()).toContain("beta w");
});

// ---------------------------------------------------------------- 7. keyboard / empty states

test("7a Windows/Linux: Alt+Shift+digit switches workspace, Ctrl+digit does not", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "platform", { get: () => "Win32" });
    Object.defineProperty(Navigator.prototype, "userAgent", { get: () => "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
  });
  await boot(page, [session(1, { title: "In alpha" }), session(2, { title: "In beta", workspace: "b" })]);
  await page.keyboard.press("Alt+Shift+2");
  await expect(page.getByRole("button", { name: /Workspace: Beta/ })).toBeVisible();
  await page.keyboard.press("Alt+Shift+1");
  await expect(page.getByRole("button", { name: /Workspace: Alpha/ })).toBeVisible();
});

test("7b empty workspace copy, filter hint for matches elsewhere", async ({ page }) => {
  await boot(page, [session(1, { title: "needle here", workspace: "b" })]);
  await expect(page.getByText("No sessions in Alpha yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Move sessions here/ })).toBeVisible();
  await page.getByRole("textbox", { name: "Filter sessions" }).fill("needle");
  await shot(page, "7b-filter");
  console.log("FILTER TEXT:", (await sidebarText(page)).replace(/\n/g, " | "));
});
