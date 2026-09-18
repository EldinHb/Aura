import { chromium } from "@playwright/test";
const out = "/private/tmp/claude-501/-Users-eldin-Projects-Aura/3fedb99a-db28-49ff-af2c-7546d274220e/scratchpad";
const shot = (p, n) => p.screenshot({ path: `${out}/${n}.png` });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message.slice(0, 200)));
await page.goto("http://localhost:1420/");
await page.waitForFunction(() => document.querySelector(".statusbar")?.textContent?.includes("daemon"), null, { timeout: 15000 });
await page.waitForTimeout(800);
console.log("rows:", await page.locator(".session-row").count());
// select claude session via keyboard: focus sidebar then j/k + enter
await page.locator(".session-row", { hasText: "e2e claude" }).first().click();
await page.waitForTimeout(1200);
await shot(page, "ui-claude");
console.log("items:", await page.locator(".transcript .item").count(), "cards:", await page.locator(".card").count());
// palette
await page.keyboard.press("Meta+k");
await page.waitForTimeout(300);
console.log("palette input:", await page.locator(".modal input").count());
await page.keyboard.type("help");
await page.waitForTimeout(200);
await shot(page, "ui-palette");
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
console.log("help modal text has 'leader':", (await page.locator(".modal").first().textContent())?.toLowerCase().includes("leader"));
await shot(page, "ui-help");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
// which-key
await page.locator('[data-region="sidebar"]').focus();
await page.keyboard.press("Control+Space");
await page.waitForTimeout(300);
console.log("whichkey:", await page.locator(".whichkey").count());
await shot(page, "ui-whichkey");
await page.keyboard.press("s");
await page.waitForTimeout(200);
await page.keyboard.press("n");
await page.waitForTimeout(400);
console.log("new session dialog:", await page.locator(".modal").count(), (await page.locator(".modal .modal-head").first().textContent()));
await shot(page, "ui-newsession");
await page.keyboard.press("Escape");
// hint mode
await page.locator('[data-region="sidebar"]').focus();
await page.keyboard.press("f");
await page.waitForTimeout(300);
console.log("hints:", await page.locator(".hint-label").count());
await shot(page, "ui-hints");
await page.keyboard.press("Escape");
// inbox
await page.keyboard.press("Meta+i");
await page.waitForTimeout(400);
console.log("inbox:", (await page.locator(".modal").first().textContent())?.slice(0, 80));
await page.keyboard.press("Escape");
// diff
await page.keyboard.press("Meta+d");
await page.waitForTimeout(600);
console.log("diff:", (await page.locator(".modal").first().textContent())?.slice(0, 80));
await shot(page, "ui-diff");
await page.keyboard.press("Escape");
// settings
await page.keyboard.press("Meta+Comma");
await page.waitForTimeout(400);
console.log("settings:", (await page.locator(".modal").first().textContent())?.slice(0, 80));
await page.keyboard.press("Escape");
// composer typing
await page.keyboard.press("Meta+e");
await page.waitForTimeout(200);
console.log("composer focused:", await page.evaluate(() => document.activeElement?.tagName));
await page.keyboard.type("/");
await page.waitForTimeout(500);
console.log("slash popover:", await page.locator(".popover").count());
await shot(page, "ui-slash");
await page.keyboard.press("Escape");
console.log("errors:", errors.slice(0, 6));
await browser.close();
