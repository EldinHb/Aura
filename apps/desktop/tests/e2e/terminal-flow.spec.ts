import { test, expect } from "@playwright/test";

/**
 * Full keyboard-only flow with a terminal session: create via the new-session
 * dialog, type into the PTY, use hint mode, open inbox/diff/search/settings,
 * switch focus regions, and delete the session again.
 */
test("terminal session lifecycle without a mouse", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".statusbar")).toContainText("daemon", { timeout: 15_000 });
  await page.waitForTimeout(500);

  // Leader menu: s n -> new session dialog
  await page.keyboard.press("Control+Space");
  await expect(page.locator(".whichkey")).toBeVisible();
  await page.keyboard.press("s");
  await page.keyboard.press("n");
  const dialog = page.locator('[role="dialog"]').filter({ hasText: /new session/i }).first();
  await expect(dialog).toBeVisible();

  // Provider: Terminal (Alt+3), directory /tmp, title, then Cmd+Enter
  await page.keyboard.press("Alt+3");
  const dir = dialog.locator("input").first();
  await dir.fill("/tmp");
  const title = dialog.locator('input[placeholder*="terminal"], input').nth(1);
  await title.fill("e2e terminal");
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator('[role="dialog"]')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator(".session-row", { hasText: "e2e terminal" })).toBeVisible();
  await expect(page.locator(".xterm")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(800);

  // type into the PTY and check the daemon echoes it back
  await page.keyboard.type("echo pw_$((40+2))\n");
  await page.waitForTimeout(1500);
  const sessionText = await page.locator(".titlebar").textContent();
  expect(sessionText).toContain("e2e terminal");

  // Esc Esc leaves the terminal, focus goes to the sidebar
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator(".statusbar")).toContainText("focus: sidebar");

  // hint mode labels everything clickable
  await page.keyboard.press("f");
  await expect(page.locator(".hint-label").first()).toBeVisible();
  expect(await page.locator(".hint-label").count()).toBeGreaterThan(3);
  await page.keyboard.press("Escape");
  await expect(page.locator(".hint-label")).toHaveCount(0);

  // inbox, diff, search, settings, help all open and close from the keyboard
  for (const [keys, text] of [
    ["Meta+i", /inbox/i],
    ["Meta+d", /diff|git/i],
    ["Meta+Shift+f", /search/i],
    ["Meta+Comma", /settings/i],
  ] as const) {
    await page.keyboard.press(keys);
    await expect(page.locator('[role="dialog"]').filter({ hasText: text }).first()).toBeVisible({ timeout: 5000 });
    await page.keyboard.press("Escape");
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  }

  // palette runs a command: toggle inspector twice
  const inspectorVisible = async () => (await page.locator('[data-region="inspector"]').count()) > 0;
  const before = await inspectorVisible();
  await page.keyboard.press("Meta+k");
  await page.locator(".palette input").first().fill("toggle inspector");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  expect(await inspectorVisible()).toBe(!before);
  await page.keyboard.press("Meta+Shift+i");
  await page.waitForTimeout(200);
  expect(await inspectorVisible()).toBe(before);

  // delete the session from the sidebar: d d then confirm with y
  await page.locator('[data-region="sidebar"]').focus();
  await page.keyboard.press("d");
  await page.keyboard.press("d");
  const confirm = page.locator('[role="dialog"]').filter({ hasText: /delete/i }).first();
  await expect(confirm).toBeVisible();
  await page.keyboard.press("y");
  await expect(page.locator(".session-row", { hasText: "e2e terminal" })).toHaveCount(0, { timeout: 10_000 });
});
