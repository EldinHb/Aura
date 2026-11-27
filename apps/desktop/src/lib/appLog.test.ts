import { afterEach, beforeEach, describe as group, expect, it, vi } from "vitest";

const invoke = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { appLog, describe, logUncaughtErrors, resetAppLog } from "./appLog";

const flush = () => new Promise((r) => setTimeout(r, 0));

group("app log", () => {
  beforeEach(() => {
    invoke.mockClear();
    resetAppLog();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("writes to the app's log through the shell", async () => {
    appLog("warn", "updates: check failed");
    await flush();
    expect(invoke).toHaveBeenCalledWith("webview_log", { level: "warn", message: "updates: check failed" });
  });

  it("does nothing outside the app", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    appLog("error", "x");
    await flush();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("never throws when the shell cannot take it", async () => {
    invoke.mockRejectedValueOnce(new Error("no such command"));
    expect(() => appLog("error", "x")).not.toThrow();
    await flush();
  });

  it("logs uncaught errors and unhandled rejections", async () => {
    const target = new EventTarget();
    logUncaughtErrors(target as unknown as Window);
    const err = Object.assign(new Event("error"), { error: new Error("boom"), message: "boom", filename: "app.js", lineno: 3 });
    target.dispatchEvent(err);
    const rejection = Object.assign(new Event("unhandledrejection"), { reason: { kind: "network", message: "offline" } });
    target.dispatchEvent(rejection);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    const messages = invoke.mock.calls.map((c) => (c[1] as { message: string }).message);
    expect(messages[0]).toMatch(/^uncaught error: .*boom[\s\S]*\(app\.js:3\)$/);
    expect(messages[1]).toBe('unhandled rejection: {"kind":"network","message":"offline"}');
    expect(invoke.mock.calls.every((c) => (c[1] as { level: string }).level === "error")).toBe(true);
  });

  it("describes what was thrown", () => {
    expect(describe("plain")).toBe("plain");
    expect(describe({ a: 1 })).toBe('{"a":1}');
    const e = new Error("bad");
    expect(describe(e)).toContain("bad");
  });
});
