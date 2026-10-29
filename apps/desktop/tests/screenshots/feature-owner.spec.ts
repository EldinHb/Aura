import { expect, test, type Page } from "@playwright/test";
import type { Feature, Item, Session, Specialist } from "../../src/gen";

/**
 * A feature owner's chat with its cards (a decision for the user, a proposed
 * specialist, the delivery report), its team in the sidebar and inspector, and
 * the Specialists and autonomy settings. Not a README shot; run it on its own
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
    card("suggestion", "s1", 150),
    item(owner, "agent_message", "The tester signed off and the reviewer approved. Here is the report.", 20),
    card("report", "report", 19),
  ],
};

const feature: Feature = {
  owner_id: owner,
  goal: "Add a dark mode to the settings screen. Users have asked for it for months.",
  status: "waiting_on_user",
  autonomy: null,
  team: [
    { worker_id: ux, specialist_id: "ux-designer", name: "UX designer", role: "Designs flows", instructions: "", hired_at: at(200) },
    { worker_id: fe, specialist_id: "frontend-engineer", name: "Frontend engineer", role: "Builds the UI", instructions: "", hired_at: at(199) },
    { worker_id: qa, specialist_id: "tester", name: "Tester (QA)", role: "Verifies", instructions: "", hired_at: at(198) },
  ],
  decisions: [
    { id: "d1", decision: "Use the existing CSS variables for both themes", rationale: "The app already themes through them; no new tokens needed.", decided_by: "owner", question_id: null, at: at(190) },
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
  counters: { q: 1, d: 1, s: 1 },
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

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("ControlOrMeta+Comma");
    await expect(page.locator(".settings-modal")).toBeVisible();
    await page.getByRole("tab", { name: /Specialists/ }).click();
    await page.getByRole("option", { name: /Frontend engineer/ }).click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/${theme}-specialists.png` });
    await page.getByRole("tab", { name: /Orchestrators/ }).click();
    await page.locator(".feature-owner-settings").scrollIntoViewIfNeeded();
    await page.getByRole("radio", { name: /Checkpoints/ }).click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/${theme}-autonomy.png` });
  });
}
