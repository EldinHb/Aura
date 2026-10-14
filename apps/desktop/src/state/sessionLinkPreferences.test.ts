import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "../lib/rpc";
import { linkPreferencesKey, loadLinkPreferences, saveLinkPreferences, useLinkPreferencesStore } from "./sessionLinkPreferences";

const issue = "https://github.com/owner/repo/issues/1";
const pr = "https://github.com/owner/repo/pull/2";
const pr2 = "https://github.com/other/repo/pull/3";
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
    await saveLinkPreferences(rpc, "first", { issues: [issue], prs: [] });
    await saveLinkPreferences(rpc, "second", { prs: [pr, pr2], reviews: false });
    useLinkPreferencesStore.setState({ entries: {} });
    await Promise.all([loadLinkPreferences(rpc, "first"), loadLinkPreferences(rpc, "second")]);
    expect(useLinkPreferencesStore.getState().entries.first.preferences).toEqual({ issues: [issue], prs: [] });
    expect(useLinkPreferencesStore.getState().entries.second.preferences).toEqual({ prs: [pr, pr2], reviews: false });
    await saveLinkPreferences(rpc, "first", {});
    expect(saved.get(linkPreferencesKey("first"))).toBe("{}");
  });

  it("does not replace a saved choice with a stale read", async () => {
    let finish!: (value: string) => void;
    client.getSetting.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const reading = loadLinkPreferences(rpc, "race");
    await saveLinkPreferences(rpc, "race", { prs: [pr] });
    finish("{}");
    await reading;
    expect(useLinkPreferencesStore.getState().entries.race.preferences).toEqual({ prs: [pr] });
  });

  it("preserves the previous selection when a save fails", async () => {
    await saveLinkPreferences(rpc, "failure", { prs: [pr] });
    client.setSetting.mockRejectedValueOnce(new Error("disconnected"));
    await expect(saveLinkPreferences(rpc, "failure", { prs: [] })).rejects.toThrow("disconnected");
    expect(useLinkPreferencesStore.getState().entries.failure.preferences).toEqual({ prs: [pr] });
  });

  it("rejects wrong-kind or unsafe URLs and reports invalid persisted data", async () => {
    await expect(saveLinkPreferences(rpc, "invalid", { issues: [pr] })).rejects.toThrow();
    await expect(saveLinkPreferences(rpc, "invalid", { prs: [pr, "javascript:alert(1)"] })).rejects.toThrow();
    expect(client.setSetting).not.toHaveBeenCalled();
    saved.set(linkPreferencesKey("invalid"), "broken-json");
    await loadLinkPreferences(rpc, "invalid");
    expect(useLinkPreferencesStore.getState().entries.invalid.error).toBeTruthy();
  });

  it("reads the older one-issue, one-PR form", async () => {
    saved.set(linkPreferencesKey("old"), JSON.stringify({ issue, pr: null }));
    await loadLinkPreferences(rpc, "old");
    expect(useLinkPreferencesStore.getState().entries.old.preferences).toEqual({ issues: [issue], prs: [] });
    saved.set(linkPreferencesKey("old"), JSON.stringify({ pr }));
    await loadLinkPreferences(rpc, "old");
    expect(useLinkPreferencesStore.getState().entries.old.preferences).toEqual({ prs: [pr] });
  });
});
