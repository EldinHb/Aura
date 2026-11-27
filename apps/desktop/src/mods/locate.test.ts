import { expect, it } from "vitest";
import { locateUiError } from "./loader";

it("names ui.js with the line and column the browser gives", () => {
  const e = new TypeError("x is not a function");
  e.stack = "TypeError: x is not a function\n    at activate (blob:http://localhost:1420/6f1c-22:12:5)\n    at load (http://localhost:1420/src/mods/loader.ts:250:3)";
  expect(locateUiError(e)).toBe("ui.js:12:5: TypeError: x is not a function");
  const safari = new Error("boom");
  safari.stack = "activate@blob:tauri://localhost/abc:3:14\nload@tauri://localhost/assets/index.js:1:2";
  expect(locateUiError(safari)).toBe("ui.js:3:14: Error: boom");
});

it("says what it can when the browser gives no place", () => {
  const e = new SyntaxError("Unexpected token '<'");
  e.stack = "";
  expect(locateUiError(e)).toBe("SyntaxError: Unexpected token '<'");
});
