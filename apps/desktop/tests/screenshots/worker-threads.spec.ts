import { expect, test, type Page } from "@playwright/test";
import type { Item, Session } from "../../src/gen";

/**
 * An orchestrator's threads with its workers, the links to them from its chat,
 * and a worker's chat labelling what its orchestrator sent. Not a README shot;
 * run it on its own when changing these views:
 *   SHOTS=/tmp/threads pnpm exec playwright test -c playwright.screenshots.config.ts worker-threads
 */
const OUT = process.env.SHOTS ?? "test-results/worker-threads";
const now = Date.now();
const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
const usage = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, total_cost_usd: null, context_window: null, context_used: null, running_totals: false };

function session(id: string, over: Partial<Session>): Session {
  return { id, title: id, provider: "claude", agent: null, native_id: null, cwd: "/Users/sam/code/vidara.portal", worktree: null, group: "Vidara Portal", status: "idle", mode: "structured", model: null, effort: null, permission_mode: null, sandbox_mode: null, command: null, created_at: at(240), last_activity: at(10), archived: false, pinned: false, last_error: null, pending_count: 0, exit_code: null, system_prompt: null, orchestrator: false, orchestrator_id: null, folderless: false, attention: null, usage, pulls: [], ...over };
}

const id = (n: number) => `5e55a0e0-0000-4000-8000-${String(n).padStart(12, "0")}`;
const lead = id(1), builder = id(2), tester = id(3);
const sessions: Session[] = [
  session(lead, { title: "Portal admin improvements", orchestrator: true, folderless: true, group: null }),
  session(builder, { title: "Bulk actions on the users table", orchestrator_id: lead, model: "opus", effort: "high", created_at: at(200) }),
  session(tester, { title: "E2E tests for the admin pages", provider: "codex", orchestrator_id: lead, model: "gpt-5.5-codex", status: "error", created_at: at(199) }),
];

let n = 0;
const item = (sid: string, kind: Item["kind"], text: string, min: number, extra: Partial<Item> = {}): Item => ({
  id: `it${++n}`, session_id: sid, turn_id: `t${n}`, kind, status: "completed", title: null, text, data: {}, parent_id: null, started_at: at(min), ended_at: at(min), ...extra,
});
const report = (min: number) => `[Aura] Worker report. This message comes from Aura, not the user.

### Bulk actions on the users table (\`${builder}\`) · claude · opus · high · idle
In /Users/sam/code/vidara.portal on branch \`bulk-actions\`
Last reply:
Bulk delete and bulk role change are in, with undo. Tests pass.

### E2E tests for the admin pages (\`${tester}\`) · codex · gpt-5.5-codex · default · failed
In /Users/sam/code/vidara.portal
Error: the dev server did not start within ${min} seconds
No reply yet.
`;
const brief = "Add bulk actions to the **users table** in the admin pages:\n\n- bulk delete, with undo\n- bulk role change\n\nWork on branch `bulk-actions` and run the tests before you report.";
const history: Record<string, Item[]> = {
  [lead]: [
    item(lead, "user_message", "Add bulk actions to the users table and cover the admin pages with e2e tests.", 200),
    item(lead, "mcp_call", "", 199, { title: "aura: start_session", data: { server: "aura", tool: "start_session", input: { agent: "claude", prompt: brief } } }),
    item(lead, "agent_message", "I started two workers: one for the bulk actions, one for the e2e tests. I will tell you when they are done.", 198),
    item(lead, "user_message", report(30), 120),
    item(lead, "mcp_call", "", 119, { title: "aura: send_message", data: { server: "aura", tool: "send_message", input: { session: builder, text: "Also add a confirmation dialog before a bulk delete of more than 10 users." } } }),
    item(lead, "agent_message", "The bulk actions are in. The e2e worker failed to start the dev server; I asked the builder for a confirmation dialog meanwhile.", 118),
  ],
  [builder]: [
    item(builder, "user_message", brief, 199, { data: { from_orchestrator: lead } }),
    item(builder, "command_exec", "", 150, { data: { command: "pnpm test" } }),
    item(builder, "agent_message", "Bulk delete and bulk role change are in, with undo. Tests pass.", 121),
    item(builder, "user_message", "Use the red button style for bulk delete, please.", 119.5),
    item(builder, "agent_message", "Done: bulk delete uses the danger button.", 119.4),
    item(builder, "user_message", "Also add a confirmation dialog before a bulk delete of more than 10 users.", 119, { data: { from_orchestrator: lead } }),
    item(builder, "agent_message", "Added the confirmation dialog, shown above 10 selected users.", 100),
  ],
};

async function mockDaemon(page: Page) {
  await page.routeWebSocket("ws://127.0.0.1:19998/**", (socket) => {
    socket.onMessage((raw) => {
      if (typeof raw !== "string") return;
      const { id: rid, method, params } = JSON.parse(raw);
      let result: unknown = null;
      switch (method) {
        case "daemon.info": result = { port: 19998, token: "shots", pid: 1, version: "0.2.15", started_at: at(600), data_dir: "/tmp" }; break;
        case "provider.list": result = []; break;
        case "session.list": result = sessions; break;
        case "session.get": result = sessions.find((s) => s.id === params.id); break;
        case "session.pending": result = { approvals: [], inputs: [] }; break;
        case "session.history": result = (history[params.id] ?? []).map((it, i) => ({ seq: i + 1, ts: it.started_at, event: { type: "item_completed", session_id: params.id, item: it } })); break;
        default:
          if (/history|commands|native|list|candidates|status|diff_stat|log|worktrees|branches/.test(method)) result = [];
      }
      socket.send(JSON.stringify({ id: rid, result }));
    });
  });
}

for (const theme of ["dark", "light"] as const) {
  test(`worker threads ${theme}`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem("aura.settings.v1", JSON.stringify({ theme: t })), theme);
    await mockDaemon(page);
    await page.goto(`/?port=19998&token=shots&session=${lead}`);
    await expect(page.locator(".steps-threads .chip").first()).toBeVisible();
    await page.screenshot({ path: `${OUT}/${theme}-chat.png` });

    await page.locator(".steps-threads .chip").first().click();
    await expect(page.locator(".thread-msg.from-orchestrator").first()).toBeVisible();
    await page.locator(".from-aura .thread-head").first().click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${theme}-thread.png` });

    await page.getByText("Open session ↗").click();
    await expect(page.locator(".item.from-orchestrator").first()).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${theme}-worker.png` });
  });
}
