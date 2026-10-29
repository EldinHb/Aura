import { expect, test, type Page } from "@playwright/test";
import type { Feature, Item, MeetingTurn, Session, Specialist, SpecialistSuggestion } from "../../src/gen";

/**
 * A feature owner's chat with its cards (a decision for the user, a meeting,
 * a proposed specialist, the delivery report, a specialist found in repeated
 * work), its team in the sidebar and inspector, its Team tab with a written
 * and a live meeting and one-on-ones, and the Specialists (with their
 * Suggestions), autonomy and meeting settings. Not a README shot; run it on its own
 * when changing these views:
 *   SHOTS=/tmp/owner pnpm exec playwright test -c playwright.screenshots.config.ts feature-owner
 */
const OUT = process.env.SHOTS ?? "test-results/feature-owner";
const now = Date.now();
const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
const usage = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, total_cost_usd: null, context_window: null, context_used: null, running_totals: false };

function session(id: string, over: Partial<Session>): Session {
  return { id, title: id, provider: "claude", agent: null, native_id: null, cwd: "/Users/sam/code/acme-web", worktree: null, group: null, status: "idle", mode: "structured", model: null, effort: null, permission_mode: null, sandbox_mode: null, command: null, created_at: at(240), last_activity: at(10), archived: false, pinned: false, last_error: null, pending_count: 0, exit_code: null, system_prompt: null, orchestrator: false, orchestrator_id: null, feature_owner: false, specialist_id: null, specialist_name: null, folderless: false, attention: null, usage, pulls: [], ...over };
}

const id = (n: number) => `fe47a0e0-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = id(1), ux = id(2), fe = id(3), qa = id(4);
const sessions: Session[] = [
  session(owner, { title: "Dark mode for the settings", orchestrator: true, feature_owner: true, folderless: true, cwd: "/tmp/aura/orchestrators/x" }),
  session(ux, { title: "UX designer", orchestrator_id: owner, specialist_id: "ux-designer", specialist_name: "UX designer", model: "opus", effort: "medium", created_at: at(200) }),
  session(fe, { title: "Frontend engineer", provider: "codex", orchestrator_id: owner, specialist_id: "frontend-engineer", specialist_name: "Frontend engineer", model: "gpt-5.5-codex", status: "running", created_at: at(199) }),
  session(qa, { title: "Tester (QA)", orchestrator_id: owner, specialist_id: "tester", specialist_name: "Tester (QA)", created_at: at(198) }),
];

let n = 0;
const item = (sid: string, kind: Item["kind"], text: string, min: number, extra: Partial<Item> = {}): Item => ({
  id: `it${++n}`, session_id: sid, turn_id: `t${n}`, kind, status: "completed", title: null, text, data: {}, parent_id: null, started_at: at(min), ended_at: at(min), ...extra,
});
const card = (kind: string, cardId: string, min: number) => item(owner, "system", "", min, { data: { feature_card: { kind, id: cardId } } });
const history: Record<string, Item[]> = {
  [owner]: [
    item(owner, "user_message", "Add a dark mode to the settings screen. Users have asked for it for months.", 200),
    item(owner, "mcp_call", "", 199, { title: "aura: hire", data: { server: "aura", tool: "hire", input: { specialist: "ux-designer", prompt: "Design the theme switch." } } }),
    item(owner, "agent_message", "I hired a UX designer for the flow, then a frontend engineer and a tester. One decision is yours: where the switch lives.", 198),
    card("decision", "q1", 197),
    card("meeting", "m1", 180),
    card("suggestion", "s1", 150),
    item(owner, "agent_message", "The tester signed off and the reviewer approved. Here is the report.", 20),
    card("report", "report", 19),
    card("role_suggestion", "r1", 18),
  ],
};

const turn = (round: number, worker: string, name: string, role: string, text: string | null, min: number, over: Partial<MeetingTurn> = {}): MeetingTurn => ({
  round, worker_id: worker, name, role, chair: false, status: text ? "answered" : "asked", text, missing: null, at: text ? at(min) : null, ...over,
});

const found: SpecialistSuggestion = {
  id: "r1",
  specialist: { id: "migration-writer", name: "Migration writer", role: "Writes reversible database migrations", description: "SQL migrations with a tested rollback", instructions: "Write every schema change as a reversible migration and test the rollback on a copy of the data.", agent: null, model: null, effort: null, scope: "project", project: "/Users/sam/code/acme-web" },
  reason: "Feature owners started 3 ad-hoc workers for this role in 3 features.",
  status: "pending",
  accepted_id: null,
  created_at: at(18),
  resolved_at: null,
  delivered: true,
  evidence: [
    { owner_id: owner, worker_id: id(11), feature: "Dark mode for the settings", title: "Migration writer", summary: "Migration writer: Add the theme column to user_settings with a rollback", project: "/Users/sam/code/acme-web" },
    { owner_id: id(20), worker_id: id(21), feature: "Orders export", title: "Schema change", summary: "Schema change: Write the SQL migration for the exports table", project: "/Users/sam/code/acme-web" },
    { owner_id: id(30), worker_id: id(31), feature: "Invoices", title: "Migration writer", summary: "Migration writer: Migrate invoices to integer cents, reversibly", project: "/Users/sam/code/acme-web" },
  ],
  owner_id: owner,
};

const feature: Feature = {
  owner_id: owner,
  goal: "Add a dark mode to the settings screen. Users have asked for it for months.",
  status: "waiting_on_user",
  autonomy: null,
    meeting_mode: null,
  team: [
    { worker_id: ux, specialist_id: "ux-designer", name: "UX designer", role: "Designs flows", instructions: "", hired_at: at(200), meeting: null },
    { worker_id: fe, specialist_id: "frontend-engineer", name: "Frontend engineer", role: "Builds the UI", instructions: "", hired_at: at(199), meeting: null },
    { worker_id: qa, specialist_id: "tester", name: "Tester (QA)", role: "Verifies", instructions: "", hired_at: at(198), meeting: null },
  ],
  decisions: [
    { id: "d1", decision: "Use the existing CSS variables for both themes", rationale: "The app already themes through them; no new tokens needed.", decided_by: "owner", question_id: null, meeting_id: null, at: at(190) },
    { id: "d2", decision: "Follow the system theme by default, with an override in Settings", rationale: "Design and QA agreed; it is what users expect and keeps the test matrix at three states.", decided_by: "owner", question_id: null, meeting_id: "m1", at: at(170) },
  ],
  questions: [
    {
      id: "q1",
      question: "Where should the theme switch live?",
      context: "Both work with the keyboard. **General** is where users look first; a **status bar toggle** is one click away but adds clutter.",
      options: [
        { label: "Settings → General", description: "Next to font size" },
        { label: "Status bar toggle", description: "Always visible" },
      ],
      recommended: "Settings → General",
      kind: "decision",
      checkpoint: null,
      asked_at: at(197),
      answer: null,
      withdrawn: false,
    },
  ],
  checkpoints: [],
  meetings: [
    {
      id: "m1",
      topic: "Default theme",
      agenda: "Should the app start in the system theme, or in dark until the user picks?",
      context: "The settings screen gets a Theme setting either way.",
      attendees: [
        { worker_id: ux, name: "UX designer", role: "Designs flows", guest: false, status: "answered", answer: "**Follow the system.** Users who run light mode expect apps to match; a dark default reads as a bug to them. Keep an explicit Dark / Light / System choice in Settings → General.", missing: null, answered_at: at(176) },
        { worker_id: fe, name: "Frontend engineer", role: "Builds the UI", guest: false, status: "answered", answer: "System is one `prefers-color-scheme` listener; the variables already switch. No extra cost either way.", missing: null, answered_at: at(175) },
        { worker_id: qa, name: "Tester (QA)", role: "Verifies", guest: false, status: "answered", answer: "System default means three states to test (light, dark, follow). I can cover them with one matrix.", missing: null, answered_at: at(174) },
      ],
      status: "complete",
      decision_ids: ["d2"],
      started_at: at(180),
      deadline: at(160),
      ended_at: at(174),
      delivered: true,
      mode: "written",
      round: 0,
      max_rounds: 0,
      turn_words: 0,
      turns: [],
      outcome: null,
      timeout_minutes: 0,
      left: [],
    },
    {
      id: "m2",
      topic: "Contrast of the code blocks",
      agenda: "Do the code blocks in the dark theme meet AA contrast?",
      context: "",
      attendees: [
        { worker_id: fe, name: "Frontend engineer", role: "Builds the UI", guest: false, status: "answered", answer: "Agreed: I add the axe check to the existing theme test.", missing: null, answered_at: at(26) },
        { worker_id: qa, name: "Tester (QA)", role: "Verifies", guest: false, status: "asked", answer: null, missing: null, answered_at: null },
      ],
      status: "collecting",
      decision_ids: [],
      started_at: at(31),
      deadline: at(6),
      ended_at: null,
      delivered: false,
      mode: "live",
      round: 2,
      max_rounds: 3,
      turn_words: 150,
      turns: [
        turn(1, fe, "Frontend engineer", "Builds the UI", "They use `--bg-elev`; I measured **7.2:1** for the text and 4.8:1 for comments.", 30),
        turn(1, qa, "Tester (QA)", "Verifies", "4.8:1 passes AA but only just. Selection highlight is untested: it sits on `--accent-bg` and may drop below 4.5:1.", 29),
        turn(2, owner, "Dark mode for the settings", "", "Settle how we keep selection contrast at AA, and who checks it.", 27, { chair: true }),
        turn(2, fe, "Frontend engineer", "Builds the UI", "Agreed: I darken the selection colour to keep 4.5:1, and add the axe check to the existing theme test.", 26),
        turn(2, qa, "Tester (QA)", "Verifies", null, 25),
      ],
      outcome: null,
      timeout_minutes: 20,
      left: [],
    },
  ],
  one_on_ones: [
    { id: "a1", from_id: fe, from_name: "Frontend engineer", to_id: ux, to_name: "UX designer", to_owner: false, question: "Does the switch animate between themes, or swap at once?", answer: "Swap at once. An animated swap flashes every surface; keep transitions on hover states only.", error: null, status: "answered", asked_at: at(120), answered_at: at(118), sent: true, delivered: true },
    { id: "a2", from_id: qa, from_name: "Tester (QA)", to_id: owner, to_name: "Dark mode for the settings", to_owner: true, question: "Is Windows high-contrast mode in scope?", answer: null, error: null, status: "open", asked_at: at(25), answered_at: null, sent: true, delivered: false },
  ],
  suggestions: [
    {
      id: "s1",
      specialist: { id: "accessibility-reviewer", name: "Accessibility reviewer", role: "Checks contrast, focus and screen readers", description: "WCAG AA review of UI changes", instructions: "Review every UI change for WCAG 2.1 AA: contrast, focus order, labels.", agent: null, model: null, effort: null, scope: "global", project: null },
      reason: "Every theme change needs a contrast check, and no specialist covers it.",
      status: "pending",
      accepted_id: null,
      created_at: at(150),
      resolved_at: null,
      delivered: false,
      evidence: [],
      owner_id: null,
    },
  ],
  report: {
    what: "- A **Theme** setting with Dark, Light and System\n- Every screen reads its colours from the theme variables",
    why: "The variables already existed, so both themes share one stylesheet.",
    how_to_test: "1. Open Settings → General\n2. Switch the theme and check the sidebar, chat and dialogs",
    where_to_test: "Branch `dark-mode` in `/Users/sam/code/acme-web/.aura-worktrees/dark-mode`, `pnpm dev`",
    notes: "",
    delivered_at: at(19),
  },
  created_at: at(200),
  updated_at: at(19),
  counters: { q: 1, d: 2, s: 1, m: 2, a: 2 },
};

const spec = (sid: string, name: string, role: string, over: Partial<Specialist> = {}): Specialist => ({
  id: sid, name, role, description: "", instructions: `You are the team's ${name}.\n\nStandards:\n- …`, agent: null, model: null, effort: null, scope: "global", project: null, built_in: true, customized: false, created_at: at(9999), updated_at: at(9999), ...over,
});
const specialists = [
  spec("ux-designer", "UX designer", "Designs flows, interactions and information architecture"),
  spec("ui-designer", "UI designer", "Designs the visual layer within the product's design system"),
  spec("frontend-engineer", "Frontend engineer", "Builds the user interface", { customized: true, model: "sonnet" }),
  spec("backend-engineer", "Backend engineer", "Builds services, APIs, data and integrations"),
  spec("tester", "Tester (QA)", "Verifies the feature works, end to end"),
  spec("code-reviewer", "Code reviewer", "Reviews changes for correctness and clarity", { agent: "codex" }),
  spec("security-reviewer", "Security reviewer", "Reviews changes for security and privacy risks"),
];

async function mockDaemon(page: Page) {
  await page.routeWebSocket("ws://127.0.0.1:19997/**", (socket) => {
    socket.onMessage((raw) => {
      if (typeof raw !== "string") return;
      const { id: rid, method, params } = JSON.parse(raw);
      let result: unknown = null;
      switch (method) {
        case "daemon.info": result = { port: 19997, token: "shots", pid: 1, version: "0.2.18", started_at: at(600), data_dir: "/tmp" }; break;
        case "provider.list": result = []; break;
        case "session.list": result = sessions; break;
        case "session.get": result = sessions.find((s) => s.id === params.id); break;
        case "session.pending": result = { approvals: [], inputs: [] }; break;
        case "session.history": result = (history[params.id] ?? []).map((it, i) => ({ seq: i + 1, ts: it.started_at, event: { type: "item_completed", session_id: params.id, item: it } })); break;
        case "feature.list": result = [feature]; break;
        case "feature.get": result = feature; break;
        case "autonomy.set": result = params; break;
        case "autonomy.get": result = { level: "blocking_decisions", checkpoints: ["after_design", "before_implementation", "before_delivery"] }; break;
        case "load_balancer.get": result = { enabled: false, policy: "…", policy_is_default: true, default_policy: "…", rules: "", prefer: [], avoid: [] }; break;
        case "specialists.list": result = specialists; break;
        case "specialists.hidden": result = []; break;
        case "meetings.get": result = { mode: "live", max_rounds: 3, turn_words: 150 }; break;
        case "suggestions.settings": result = { enabled: true, model: "haiku" }; break;
        case "suggestions.list": result = [found]; break;
        case "orchestrator.projects": result = [{ path: "/Users/sam/code/acme-web", repo: true, groups: [], sessions: 4, last_used: at(5) }]; break;
        default:
          if (/history|commands|native|list|candidates|status|diff_stat|log|worktrees|branches/.test(method)) result = [];
      }
      socket.send(JSON.stringify({ id: rid, result }));
    });
  });
}

for (const theme of ["dark", "light"] as const) {
  test(`feature owner ${theme}`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem("aura.settings.v1", JSON.stringify({ theme: t })), theme);
    await mockDaemon(page);
    await page.goto(`/?port=19997&token=shots&session=${owner}`);
    await expect(page.locator(".feature-card.decision")).toBeVisible();
    await page.getByRole("radio", { name: /Settings → General/ }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${theme}-chat.png` });
    await page.locator(".feature-card.report").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/${theme}-report.png` });
    // A specialist Aura found in repeated ad-hoc work, with its briefs.
    const role = page.locator(".feature-card.suggestion", { hasText: "Migration writer" });
    await role.getByText(/Seen in 3 ad-hoc briefs/).click();
    await role.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/${theme}-role-suggestion.png` });

    // The Team tab opens only when the user picks it.
    await expect(page.locator(".team-view")).toHaveCount(0);
    await page.getByRole("tab", { name: "Team" }).click();
    await expect(page.locator(".team-view")).toBeVisible();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/${theme}-team.png` });
    // The live meeting, open as the latest: its thread round by round.
    await expect(page.locator(".live-thread")).toBeVisible();
    await page.locator(".live-thread").scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/${theme}-team-live.png` });
    await page.locator(".team-entry.meeting").nth(1).locator(".team-entry-head").click();
    await page.locator(".team-entry.one-on-one").last().scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/${theme}-team-meetings.png` });
    await page.getByRole("tab", { name: "Chat" }).click();

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("ControlOrMeta+Comma");
    await expect(page.locator(".settings-modal")).toBeVisible();
    await page.getByRole("tab", { name: /Specialists/ }).click();
    await page.getByRole("option", { name: /Frontend engineer/ }).click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/${theme}-specialists.png` });
    await expect(page.getByRole("region", { name: "Suggestions" })).toBeVisible();
    await page.getByRole("region", { name: "Suggestions" }).getByText(/Seen in 3 ad-hoc briefs/).click();
    await page.getByRole("region", { name: "Suggestions" }).evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/${theme}-suggestions.png` });
    // Folded, it keeps to its heading with how many wait.
    await page.getByRole("button", { name: /Suggestions/ }).click();
    await expect(page.getByText("2 waiting")).toBeVisible();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/${theme}-suggestions-folded.png` });
    await page.getByRole("button", { name: /Suggestions/ }).click();
    await page.getByRole("tab", { name: /Orchestrators/ }).click();
    await page.locator(".feature-owner-settings").first().scrollIntoViewIfNeeded();
    await page.getByRole("radio", { name: /Checkpoints/ }).click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/${theme}-autonomy.png` });
    await page.locator(".feature-owner-settings").last().scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/${theme}-meetings.png` });
  });
}
