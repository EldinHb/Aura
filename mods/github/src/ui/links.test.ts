import { beforeEach, describe, expect, it, vi } from "vitest";
import { daemonCtx } from "../test/ctx";
import { useStore } from "../test/host";
import { linksChanged, loadAllLinks, loadLinkPreferences, resetLinks, saveDetectedLinks, saveLinkPreferences, startDetectedLinksSync, useDetectedLinksStore, useLinkPreferencesStore, useSessionPullsStore, workedOnBranch } from "./links";
import { resetGithubRepos } from "./repos";

const issue = "https://github.com/owner/repo/issues/1";
const pr = "https://github.com/owner/repo/pull/2";
const pr2 = "https://github.com/other/repo/pull/3";
let d: ReturnType<typeof daemonCtx>;

beforeEach(() => {
  resetLinks();
  resetGithubRepos();
  d = daemonCtx();
  useStore.setState({ sessions: {}, transcripts: {}, connection: "open" });
});

describe("saved session links", () => {
  it("restores selections after clearing frontend state and isolates sessions", async () => {
    await saveLinkPreferences("first", { issues: [issue], prs: [] });
    await saveLinkPreferences("second", { prs: [pr, pr2], reviews: false });
    useLinkPreferencesStore.setState({ entries: {} });
    await Promise.all([loadLinkPreferences("first"), loadLinkPreferences("second")]);
    expect(useLinkPreferencesStore.getState().entries.first.preferences).toEqual({ issues: [issue], prs: [] });
    expect(useLinkPreferencesStore.getState().entries.second.preferences).toEqual({ prs: [pr, pr2], reviews: false });
    await saveLinkPreferences("first", {});
    expect(d.host.sessionData.get("first")?.get("links")).toEqual({});
  });

  it("does not replace a saved choice with a stale read", async () => {
    let finish!: (value: unknown) => void;
    d.rpc.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const reading = loadLinkPreferences("race");
    await saveLinkPreferences("race", { prs: [pr] });
    finish({ links: {}, detected: null, pulls: [] });
    await reading;
    expect(useLinkPreferencesStore.getState().entries.race.preferences).toEqual({ prs: [pr] });
  });

  it("preserves the previous selection when a save fails", async () => {
    await saveLinkPreferences("failure", { prs: [pr] });
    d.rpc.mockRejectedValueOnce(new Error("disconnected"));
    await expect(saveLinkPreferences("failure", { prs: [] })).rejects.toThrow("disconnected");
    expect(useLinkPreferencesStore.getState().entries.failure.preferences).toEqual({ prs: [pr] });
  });

  it("rejects wrong-kind or unsafe URLs and reports invalid persisted data", async () => {
    await expect(saveLinkPreferences("invalid", { issues: [pr] })).rejects.toThrow();
    await expect(saveLinkPreferences("invalid", { prs: [pr, "javascript:alert(1)"] })).rejects.toThrow();
    expect(d.rpc).not.toHaveBeenCalled();
    d.host.api.sessions.data("invalid").set("links", "broken-json");
    await loadLinkPreferences("invalid");
    expect(useLinkPreferencesStore.getState().entries.invalid.error).toBeTruthy();
  });

  it("reads the older one-issue, one-PR form", async () => {
    await d.host.api.sessions.data("old").set("links", { issue, pr: null });
    await loadLinkPreferences("old");
    expect(useLinkPreferencesStore.getState().entries.old.preferences).toEqual({ issues: [issue], prs: [] });
    await d.host.api.sessions.data("old").set("links", { pr });
    await loadLinkPreferences("old");
    expect(useLinkPreferencesStore.getState().entries.old.preferences).toEqual({ prs: [pr] });
  });

  it("takes changes made in another window from the daemon's notification", async () => {
    d.ctx.on("links.changed", linksChanged);
    await d.host.call("links.set", { sessionId: "elsewhere", links: { prs: [pr] } });
    expect(useLinkPreferencesStore.getState().entries.elsewhere.preferences).toEqual({ prs: [pr] });
    linksChanged({ sessionId: "elsewhere", links: { prs: "nope" }, detected: null, pulls: [] });
    expect(useLinkPreferencesStore.getState().entries.elsewhere).toEqual({ preferences: { prs: [pr] }, error: expect.any(String) });
  });

  it("loads every session's links in one call", async () => {
    await d.host.api.sessions.data("a").set("links", { issues: [issue] });
    await d.host.api.sessions.data("b").set("detected", [pr]);
    await d.host.api.sessions.data("b").set("pulls", [pr2]);
    await loadAllLinks();
    await loadAllLinks();
    expect(d.rpc.mock.calls.filter(([name]) => name === "links.all")).toHaveLength(1);
    expect(useLinkPreferencesStore.getState().entries.a.preferences).toEqual({ issues: [issue] });
    expect(useDetectedLinksStore.getState().links.b.map((l) => l.url)).toEqual([pr]);
    expect(useSessionPullsStore.getState().pulls.b).toEqual([pr2]);
  });
});

describe("detected links", () => {
  const message = (text: string, kind = "agent_message") => ({ m: { id: "m", session_id: "a", turn_id: null, kind, status: "completed", title: null, text, data: {}, parent_id: null, started_at: "2026-09-30T00:00:00Z", ended_at: null } });

  it("saves the automatic links of loaded transcripts, once per change", async () => {
    d.host.api.git.remotes = async () => [{ name: "origin", url: "https://github.com/owner/repo.git" }];
    useStore.setState({
      sessions: { a: { id: "a", title: "Hours page", cwd: "/work/a" }, b: { id: "b", title: "B", cwd: "/work/b" } },
      transcripts: {
        a: { loaded: true, items: message("Please work on issue #7", "user_message") },
        b: { loaded: false, items: message(`Created PR: ${pr}`) },
      },
    });
    const stop = startDetectedLinksSync();
    await vi.waitFor(() => expect(d.host.sessionData.get("a")?.get("detected")).toEqual(["https://github.com/owner/repo/issues/7"]));
    expect(d.host.sessionData.get("b")?.get("detected"), "a partial transcript is not taken").toBeUndefined();
    const saves = () => d.rpc.mock.calls.filter(([name]) => name === "detected.set").length;
    const before = saves();
    useStore.setState({ selectedId: "a" });
    await saveDetectedLinks("a", useDetectedLinksStore.getState().links.a);
    expect(saves()).toBe(before);
    stop();
  });
});

it("counts a plain checkout's branch only while its session is active", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  const s = (patch: object) => ({ worktree: null, status: "idle", last_activity: "2026-10-15T10:00:00Z", ...patch }) as never;
  expect(workedOnBranch(s({ worktree: { repo_root: "/r", path: "/w", branch: "b" }, last_activity: "2026-01-01T00:00:00Z" }), now)).toBe(true);
  expect(workedOnBranch(s({ status: "running", last_activity: "2026-01-01T00:00:00Z" }), now)).toBe(true);
  expect(workedOnBranch(s({ last_activity: "2026-10-15T11:55:00Z" }), now)).toBe(true);
  expect(workedOnBranch(s({}), now)).toBe(false);
});
