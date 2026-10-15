import { expect, test, type Page } from "@playwright/test";
import type { CapabilitySet, Event, Item, Session, StoredEvent } from "../../src/gen";

/**
 * The composer's image strip and images on sent messages, in both themes.
 * Not README material: writes to $SHOTS_DIR (default /tmp/aura-composer-images).
 * Run: pnpm exec playwright test -c playwright.screenshots.config.ts composer-images
 */
const OUT = process.env.SHOTS_DIR ?? "/tmp/aura-composer-images";
const sid = "3f6a1c9e-2f43-4c1a-9d5e-1a2b3c4d5e01";
const ts = "2026-10-15T09:30:00Z";

const session: Session = { id: sid, title: "Fix the settings layout", provider: "claude", agent: null, native_id: null, cwd: "/Users/sam/code/acme-web", worktree: null, group: "acme", status: "idle", mode: "structured", model: "claude-opus-5-5", effort: "high", permission_mode: "default", sandbox_mode: null, command: null, created_at: ts, last_activity: ts, archived: false, pinned: false, last_error: null, pending_count: 0, exit_code: null, system_prompt: null, orchestrator: false, orchestrator_id: null, usage: { input_tokens: 41_000, output_tokens: 2_100, cached_input_tokens: 30_000, total_cost_usd: 0.42, context_window: 200_000, context_used: 38_000 } };
const caps: CapabilitySet = { structured: true, models: true, effort: true, permission_modes: ["default", "plan"], sandbox_modes: [], fork: true, steer: true, interrupt: true, review: false, compact: true, mcp_status: true, skills_list: true, slash_commands: true, images: true, diff_stream: true, plan_stream: true, native_sessions: true, rename: true, terminal_mode: true };

/** A gradient PNG with a label, drawn in the page so the thumbnails look like screenshots. */
async function makeImages(page: Page, specs: { name: string; w: number; h: number; hue: number }[]) {
  return page.evaluate(async (specs) => {
    const out: string[] = [];
    for (const s of specs) {
      const c = document.createElement("canvas");
      c.width = s.w;
      c.height = s.h;
      const g = c.getContext("2d")!;
      const grad = g.createLinearGradient(0, 0, s.w, s.h);
      grad.addColorStop(0, `hsl(${s.hue} 70% 55%)`);
      grad.addColorStop(1, `hsl(${s.hue + 60} 70% 35%)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, s.w, s.h);
      g.fillStyle = "rgba(255,255,255,0.85)";
      g.fillRect(s.w * 0.08, s.h * 0.1, s.w * 0.84, s.h * 0.12);
      g.fillRect(s.w * 0.08, s.h * 0.3, s.w * 0.5, s.h * 0.5);
      g.fillStyle = "#222";
      g.font = `${Math.round(s.h / 12)}px sans-serif`;
      g.fillText(s.name, s.w * 0.1, s.h * 0.19);
      out.push(c.toDataURL("image/png"));
    }
    return out;
  }, specs);
}

async function pasteImages(page: Page, specs: { name: string; w: number; h: number; hue: number }[]) {
  const urls = await makeImages(page, specs);
  await page.evaluate(async ({ urls, names }) => {
    const dt = new DataTransfer();
    for (let i = 0; i < urls.length; i++) {
      const blob = await (await fetch(urls[i])).blob();
      dt.items.add(new File([blob], names[i], { type: "image/png" }));
    }
    const ta = document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
    ta.focus();
    ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, { urls, names: specs.map((s) => s.name) });
}

async function mockDaemon(page: Page, history: StoredEvent[]) {
  await page.routeWebSocket("ws://127.0.0.1:19997/**", (socket) => {
    socket.onMessage((raw) => {
      if (typeof raw !== "string") return;
      const { id, method, params } = JSON.parse(raw);
      let result: unknown = null;
      switch (method) {
        case "daemon.info": result = { port: 19997, token: "shots", pid: 1, version: "0.2.10", started_at: ts, data_dir: "/tmp" }; break;
        case "provider.list": result = [{ kind: "claude", display_name: "Claude Code", available: true, version: "2.4.0", binary: "/usr/local/bin/claude", capabilities: caps, agents: [] }]; break;
        case "session.list": result = [session]; break;
        case "session.get": result = session; break;
        case "session.history": result = history.filter((e) => e.seq > (params.after_seq ?? 0)); break;
        case "session.pending": result = { approvals: [], inputs: [] }; break;
        case "session.attachment": result = { data: fullImage.split(",")[1], media_type: "image/png" }; break;
        case "git.branch_status": result = null; break;
        default:
          if (/history|commands|native|list|candidates|status|diff_stat|log|worktrees|branches/.test(method)) result = [];
      }
      socket.send(JSON.stringify({ id, result }));
    });
  });
}

let fullImage = "";

function historyWith(thumbs: string[]): StoredEvent[] {
  const out: StoredEvent[] = [];
  const push = (event: Event) => out.push({ seq: out.length + 1, ts, event });
  const turn = { id: "t1", session_id: sid, status: "completed" as const, started_at: ts, ended_at: ts, usage: null, error: null };
  const item = (id: string, kind: Item["kind"], text: string, data: Record<string, unknown> = {}): Item => ({ id, session_id: sid, turn_id: "t1", kind, status: "completed", title: null, text, data, parent_id: null, started_at: ts, ended_at: ts });
  push({ type: "turn_started", session_id: sid, turn: { ...turn, status: "running" } });
  for (const it of [
    item("u1", "user_message", "The settings dialog overflows on small windows, see these two screenshots.", {
      attachments: thumbs.map((t, i) => ({ id: `a${i}.png`, name: `settings-${i + 1}.png`, media_type: "image/png", width: 1280, height: 800, thumbnail: t })),
    }),
    item("a1", "agent_message", "The tab list has a fixed `min-width: 520px`, so below that the body scrolls sideways. I'll let it wrap and cap the dialog at `92vw`."),
  ]) {
    push({ type: "item_started", session_id: sid, item: it });
    push({ type: "item_completed", session_id: sid, item: it });
  }
  push({ type: "turn_completed", session_id: sid, turn });
  return out;
}

const specs = [
  { name: "settings-dialog.png", w: 1280, h: 800, hue: 220 },
  { name: "sidebar.png", w: 600, h: 1100, hue: 140 },
  { name: "error-toast.png", w: 900, h: 300, hue: 10 },
  { name: "diagram.png", w: 1000, h: 1000, hue: 280 },
];

for (const theme of ["dark", "light"] as const) {
  test(`composer images (${theme})`, async ({ page }) => {
    await page.addInitScript((theme) => localStorage.setItem("aura.settings.v1", JSON.stringify({ theme })), theme);
    await page.goto("/");
    // Thumbnails for the sent message, made the way the composer makes them.
    const made = await makeImages(page, specs.slice(0, 2).map((s) => ({ ...s, w: 256, h: Math.round((256 * s.h) / s.w) })));
    fullImage = (await makeImages(page, [specs[0]]))[0];
    await mockDaemon(page, historyWith(made));
    await page.goto(`/?port=19997&token=shots&session=${sid}`);
    await expect(page.getByText("The settings dialog overflows")).toBeVisible();
    const composer = page.locator(".composer");

    await pasteImages(page, specs.slice(0, 1));
    await expect(composer.locator(".image-thumb")).toHaveCount(1);
    await page.locator(".composer textarea").fill("Here is the dialog after the change");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/composer-1-${theme}.png` });
    await composer.screenshot({ path: `${OUT}/composer-1-${theme}-crop.png` });

    await pasteImages(page, specs.slice(1));
    await expect(composer.locator(".image-thumb")).toHaveCount(4);
    await composer.locator(".image-thumb").nth(1).hover();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/composer-4-${theme}.png` });
    await composer.screenshot({ path: `${OUT}/composer-4-${theme}-crop.png` });

    // Lightbox from the composer, then from the transcript.
    await composer.locator(".image-thumb-open").first().click();
    await expect(page.locator(".image-modal img")).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/lightbox-composer-${theme}.png` });
    await page.keyboard.press("Escape");
    await expect(page.locator(".image-modal")).toHaveCount(0);

    await page.locator(".message-images .image-thumb-open").first().click();
    await expect(page.locator(".image-modal img")).toHaveAttribute("src", /^blob:/);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/lightbox-transcript-${theme}.png` });
    await page.keyboard.press("Escape");
    // Focus goes back to the transcript a frame later.
    await page.waitForTimeout(100);

    // Backspace in the empty textbox takes the last image off.
    await page.locator(".composer textarea").fill("");
    await page.locator(".composer textarea").press("Backspace");
    await expect(composer.locator(".image-thumb")).toHaveCount(3);
  });
}
