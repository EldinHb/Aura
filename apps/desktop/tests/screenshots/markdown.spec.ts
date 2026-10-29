import { expect, test, type Page } from "@playwright/test";
import type { CapabilitySet, Event, Item, Session, StoredEvent } from "../../src/gen";

/**
 * Markdown in the transcript and the rich composer, in both themes, driven in a
 * real browser: input rules, sending, switching to plain markdown and back.
 * Not README material: writes to $SHOTS_DIR (default /tmp/aura-markdown).
 * Run: pnpm exec playwright test -c playwright.screenshots.config.ts markdown
 */
const OUT = process.env.SHOTS_DIR ?? "/tmp/aura-markdown";
const sid = "5b1d2c3e-4f50-4a61-8b72-9c8d7e6f5a01";
const ts = "2026-10-15T09:30:00Z";
const session: Session = { id: sid, title: "Speed up the importer", provider: "claude", agent: null, native_id: null, cwd: "/Users/sam/code/acme-web", worktree: null, group: "acme", status: "idle", mode: "structured", model: "claude-opus-5-5", effort: "high", permission_mode: "default", sandbox_mode: null, command: null, created_at: ts, last_activity: ts, archived: false, pinned: false, last_error: null, pending_count: 0, exit_code: null, system_prompt: null, orchestrator: false, orchestrator_id: null, feature_owner: false, specialist_id: null, specialist_name: null, folderless: false, attention: null, usage: { input_tokens: 41_000, output_tokens: 2_100, cached_input_tokens: 30_000, total_cost_usd: 0.42, context_window: 200_000, context_used: 38_000, running_totals: false }, pulls: [] };
const caps: CapabilitySet = { structured: true, models: true, effort: true, permission_modes: ["default", "plan"], sandbox_modes: [], fork: true, steer: true, interrupt: true, review: false, compact: true, mcp_status: true, skills_list: true, slash_commands: true, images: true, diff_stream: true, plan_stream: true, native_sessions: true, rename: true, terminal_mode: true };

const reply = `## What I changed

The importer parsed every row **twice**: once to validate and once to insert. It now parses once and streams rows to \`COPY\` in batches of ~5,000 (\`src/import/batch.ts:42\`).

- [x] Single pass over the file
- [x] Batched inserts
- [ ] Progress bar in the UI
  - needs a new event from the worker

| Rows | Before | After |
|-----:|-------:|------:|
| 10k | 4.1 s | 0.6 s |
| 1M | 7 min | 48 s |

> Memory stays flat: the parser no longer keeps the whole file.

\`\`\`ts
export async function* batches<T>(rows: AsyncIterable<T>, size = 5_000) {
  let batch: T[] = [];
  for await (const row of rows) {
    if (batch.push(row) === size) yield batch.splice(0);
  }
  if (batch.length) yield batch;
}
\`\`\`

Profile before and after:

![flame graph](./profiles/after.png)

Details in https://github.com/acme/web/pull/412 and the [COPY docs](https://www.postgresql.org/docs/current/sql-copy.html). ~~The old validator~~ is gone. <b>HTML</b> stays text.`;

const user = "Can you make the import faster?\n\n- it takes **7 minutes** for 1M rows\n- see `scripts/import.sh`";

function history(): StoredEvent[] {
  const out: StoredEvent[] = [];
  const push = (event: Event) => out.push({ seq: out.length + 1, ts, event });
  const turn = { id: "t1", session_id: sid, status: "completed" as const, started_at: ts, ended_at: ts, usage: null, error: null };
  const item = (id: string, kind: Item["kind"], text: string): Item => ({ id, session_id: sid, turn_id: "t1", kind, status: "completed", title: null, text, data: {}, parent_id: null, started_at: ts, ended_at: ts });
  push({ type: "turn_started", session_id: sid, turn: { ...turn, status: "running" } });
  for (const it of [item("u1", "user_message", user), item("a1", "agent_message", reply)]) {
    push({ type: "item_started", session_id: sid, item: it });
    push({ type: "item_completed", session_id: sid, item: it });
  }
  push({ type: "turn_completed", session_id: sid, turn });
  return out;
}

const sent: string[] = [];
const readImage: string[] = [];

async function png(page: Page, w: number, h: number): Promise<string> {
  return page.evaluate(({ w, h }) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d")!;
    for (let x = 0; x < w; x += 16) {
      g.fillStyle = `hsl(${(x / w) * 60 + 10} 80% ${45 + ((x * 7) % 20)}%)`;
      g.fillRect(x, h * (0.2 + ((x * 13) % 50) / 100), 15, h);
    }
    return c.toDataURL("image/png").split(",")[1];
  }, { w, h });
}

async function mockDaemon(page: Page, image: string) {
  await page.routeWebSocket("ws://127.0.0.1:19998/**", (socket) => {
    socket.onMessage((raw) => {
      if (typeof raw !== "string") return;
      const { id, method, params } = JSON.parse(raw);
      let result: unknown = null;
      switch (method) {
        case "daemon.info": result = { port: 19998, token: "shots", pid: 1, version: "0.2.15", started_at: ts, data_dir: "/tmp" }; break;
        case "provider.list": result = [{ kind: "claude", display_name: "Claude Code", available: true, version: "2.4.0", binary: "/usr/local/bin/claude", capabilities: caps, agents: [] }]; break;
        case "session.list": result = [session]; break;
        case "session.get": result = session; break;
        case "session.history": result = history().filter((e) => e.seq > (params.after_seq ?? 0)); break;
        case "session.pending": result = { approvals: [], inputs: [] }; break;
        // A send takes a moment, as it does when the daemon starts the agent first.
        case "session.send": result = true; setTimeout(() => { sent.push(params.input.text); socket.send(JSON.stringify({ id, result })); }, 300); return;
        case "fs.read_image": readImage.push(params.path); result = { data: image, media_type: "image/png" }; break;
        case "git.branch_status": result = null; break;
        default:
          if (/history|commands|native|list|candidates|status|diff_stat|log|worktrees|branches|search_files/.test(method)) result = [];
      }
      socket.send(JSON.stringify({ id, result }));
    });
  });
}

for (const theme of ["dark", "light"] as const) {
  test(`markdown and the rich composer (${theme})`, async ({ page }) => {
    await page.addInitScript((theme) => localStorage.setItem("aura.settings.v1", JSON.stringify({ theme })), theme);
    await page.goto("/");
    await mockDaemon(page, await png(page, 900, 260));
    await page.goto(`/?port=19998&token=shots&session=${sid}`);
    const agent = page.locator(".item.agent_message .md");
    await expect(agent.getByRole("heading", { name: "What I changed" })).toBeVisible();

    // GFM, a local image read through the daemon, and HTML kept as text.
    await expect(agent.locator("table td").first()).toHaveText("10k");
    await expect(agent.locator(".task-list-item input")).toHaveCount(3);
    await expect(agent.locator("img[alt='flame graph']")).toHaveAttribute("src", /^blob:/);
    expect(readImage).toContain("/Users/sam/code/acme-web/profiles/after.png");
    await expect(agent.locator("b")).toHaveCount(0);
    await expect(agent.getByRole("link", { name: "https://github.com/acme/web/pull/412" })).toBeVisible();
    await expect(page.locator(".item.user_message strong")).toHaveText("7 minutes");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/transcript-${theme}.png`, fullPage: true });
    await agent.screenshot({ path: `${OUT}/agent-message-${theme}.png` });

    // Typing formats as it goes; Enter sends markdown, exactly as typed.
    const box = page.locator(".composer [role='textbox']");
    await box.click();
    await page.keyboard.type("## Next ");
    await page.keyboard.type("step");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("Add the **progress bar** and keep `batch.ts` as is:");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("- emit an event per batch");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("show 2 * 3 * 4 rows_per_batch");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("```sh ");
    await page.keyboard.type("pnpm test -- importer");
    await expect(box.locator("h2")).toHaveText("Next step");
    await expect(box.locator("strong")).toHaveText("progress bar");
    await expect(box.locator("li")).toHaveCount(2);
    await expect(box.locator("pre")).toHaveText("pnpm test -- importer");
    await page.waitForTimeout(200);
    await page.locator(".composer").screenshot({ path: `${OUT}/composer-rich-${theme}.png` });

    // Plain markdown and back, the draft unchanged.
    await page.getByRole("button", { name: "Rich text" }).click();
    const expected = "## Next step\n\nAdd the **progress bar** and keep `batch.ts` as is:\n\n- emit an event per batch\n- show 2 * 3 * 4 rows_per_batch\n\n```sh\npnpm test -- importer\n```";
    await expect(page.locator(".composer textarea")).toHaveValue(expected);
    await page.locator(".composer").screenshot({ path: `${OUT}/composer-markdown-${theme}.png` });
    await page.getByRole("button", { name: "Markdown" }).click();
    await expect(box.locator("strong")).toHaveText("progress bar");

    await box.click();
    await page.keyboard.press("Enter");

    // The box empties at once and keeps the keyboard: what is typed while the message goes out is
    // text, not shortcuts (`f` is hint mode outside a text field).
    await expect(box).toHaveText("");
    await expect(box).toBeFocused();
    await page.keyboard.type("fix it, thanks");
    await expect(page.locator(".hint-status")).toHaveCount(0);
    await expect.poll(() => sent.at(-1)).toBe(expected);
    await expect(box).toHaveText("fix it, thanks");
    await page.keyboard.press("Enter");
    await expect.poll(() => sent.at(-1)).toBe("fix it, thanks");
    await expect(box).toBeFocused();

    // The markdown textbox keeps the keyboard after sending too.
    await page.getByRole("button", { name: "Rich text" }).click();
    await page.locator(".composer textarea").click();
    await page.keyboard.type("one");
    await page.keyboard.press("Enter");
    await expect(page.locator(".composer textarea")).toBeFocused();
    await page.keyboard.type("fix two");
    await expect(page.locator(".hint-status")).toHaveCount(0);
    await expect.poll(() => sent.at(-1)).toBe("one");
    await expect(page.locator(".composer textarea")).toHaveValue("fix two");
    await page.keyboard.press("Enter");
    await expect.poll(() => sent.at(-1)).toBe("fix two");
    await expect(page.locator(".composer textarea")).toBeFocused();
    await page.keyboard.type("two");
    await page.keyboard.press("Enter");
    await expect.poll(() => sent.at(-1)).toBe("two");
  });
}
