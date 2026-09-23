import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "../lib/rpc";
import { linkPreferencesKey, loadLinkPreferences, saveLinkPreferences, useLinkPreferencesStore } from "./sessionLinkPreferences";

const issue = "https://github.com/owner/repo/issues/1";
const pr = "https://github.com/owner/repo/pull/2";
const saved = new Map<string, string>();
const client = {
  getSetting: vi.fn(async (key: string) => saved.get(key) ?? null),
  setSetting: vi.fn(async (key: string, value: string) => { saved.set(key, value); return true; }),
};
const rpc = client as unknown as RpcClient;
beforeEach(() => {
  saved.clear();
  vi.clearAllMocks();
  useLinkPreferencesStore.setState({ entries: {} });
});

describe("saved session links", () => {
  it("restores selections after clearing frontend state and isolates sessions", async () => {
    await saveLinkPreferences(rpc, "first", { issue, pr: null });
    await saveLinkPreferences(rpc, "second", { pr });
    useLinkPreferencesStore.setState({ entries: {} });
    await Promise.all([loadLinkPreferences(rpc, "first"), loadLinkPreferences(rpc, "second")]);
    expect(useLinkPreferencesStore.getState().entries.first.preferences).toEqual({ issue, pr: null });
    expect(useLinkPreferencesStore.getState().entries.second.preferences).toEqual({ pr });
    await saveLinkPreferences(rpc, "first", {});
    expect(saved.get(linkPreferencesKey("first"))).toBe("{}");
  });

  it("does not replace a saved choice with a stale read", async () => {
    let finish!: (value: string) => void;
    client.getSetting.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const reading = loadLinkPreferences(rpc, "race");
    await saveLinkPreferences(rpc, "race", { pr });
    finish("{}");
    await reading;
    expect(useLinkPreferencesStore.getState().entries.race.preferences).toEqual({ pr });
  });

  it("preserves the previous selection when a save fails", async () => {
    await saveLinkPreferences(rpc, "failure", { pr });
    client.setSetting.mockRejectedValueOnce(new Error("disconnected"));
    await expect(saveLinkPreferences(rpc, "failure", { pr: null })).rejects.toThrow("disconnected");
    expect(useLinkPreferencesStore.getState().entries.failure.preferences).toEqual({ pr });
  });

  it("rejects wrong-kind or unsafe URLs and reports invalid persisted data", async () => {
    await expect(saveLinkPreferences(rpc, "invalid", { issue: pr })).rejects.toThrow();
    await expect(saveLinkPreferences(rpc, "invalid", { pr: "javascript:alert(1)" })).rejects.toThrow();
    expect(client.setSetting).not.toHaveBeenCalled();
    saved.set(linkPreferencesKey("invalid"), "broken-json");
    await loadLinkPreferences(rpc, "invalid");
    expect(useLinkPreferencesStore.getState().entries.invalid.error).toBeTruthy();
  });
});
