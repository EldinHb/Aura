import { chromium } from "@playwright/test";
const out = "/private/tmp/claude-501/-Users-eldin-Projects-Aura/3fedb99a-db28-49ff-af2c-7546d274220e/scratchpad";
const shot = (p, n) => p.screenshot({ path: `${out}/${n}.png` });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message.slice(0, 200)));
await page.goto("http://localhost:1420/");
await page.waitForFunction(() => document.querySelector(".statusbar")?.textContent?.includes("daemon"), null, { timeout: 15000 });
await page.waitForTimeout(500);
// keyboard only: focus sidebar, jump to session 2 (claude) with Cmd+2
await page.locator('[data-region="sidebar"]').focus();
await page.keyboard.press("Meta+2");
await page.waitForTimeout(600);
console.log("selected:", await page.locator(".titlebar").textContent());
await page.keyboard.press("Meta+e"); // composer
await page.keyboard.type("Use the Bash tool to run: echo ui_ok > ui-marker.txt . Then reply with exactly: done.");
await page.keyboard.press("Enter");
console.log("sent; waiting for approval card...");
await page.waitForSelector(".card", { timeout: 90000 });
await page.waitForTimeout(400);
await shot(page, "flow-approval");
console.log("card:", (await page.locator(".card").first().textContent())?.slice(0, 160));
// keyboard: escape to main, press y
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
console.log("active:", await page.evaluate(() => document.activeElement?.className));
await page.keyboard.press("y");
await page.waitForFunction(() => document.querySelectorAll(".card").length === 0, null, { timeout: 10000 });
console.log("approved via y");
await page.waitForFunction(() => document.querySelector(".statusbar")?.textContent?.includes("idle"), null, { timeout: 90000 });
await page.waitForTimeout(500);
await shot(page, "flow-done");
const items = await page.locator(".transcript .item").allTextContents();
console.log("last items:", items.slice(-3).map((s) => s.slice(0, 80)));
// mode switch to terminal and back
await page.keyboard.press("Meta+t");
await page.waitForSelector(".xterm", { timeout: 15000 });
await page.waitForTimeout(4000);
await shot(page, "flow-terminal");
const term = await page.evaluate(() => document.querySelector(".xterm")?.textContent ?? "");
console.log("terminal shows claude tui:", /claude|Claude|›|\?/.test(term), term.replace(/\s+/g, " ").slice(0, 160));
await page.keyboard.press("Meta+t");
await page.waitForSelector(".transcript", { timeout: 15000 });
await page.waitForTimeout(800);
console.log("back to structured, items:", await page.locator(".transcript .item").count());
console.log("errors:", errors);
await browser.close();
