import { test, expect } from "@playwright/test";

test.describe("keyboard-only navigation", () => {
  test("palette, help, which-key and new session are reachable without a mouse", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".statusbar")).toContainText("daemon", { timeout: 15_000 });
    // let the initial history load settle before driving the keyboard
    await page.waitForTimeout(500);

    await page.keyboard.press("Meta+k");
    const palette = page.locator(".palette input").first();
    await expect(palette).toBeVisible();
    await palette.fill("help");
    await page.keyboard.press("Enter");
    await expect(page.locator('[role="dialog"]').filter({ hasText: /shortcut|help/i }).first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);

    await page.keyboard.press("Control+Space");
    await expect(page.locator(".whichkey")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".whichkey")).toHaveCount(0);

    await page.keyboard.press("Meta+n");
    await expect(page.locator('[role="dialog"]').filter({ hasText: /new session/i }).first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  });
});
