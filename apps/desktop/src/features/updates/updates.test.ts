import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../gen";
import { defaultSettings, useStore } from "../../state/store";
import { bannerOf, errorMessage, initialState, percent, reduce, showsError, type Action, type UpdateInfo, type UpdateState } from "./machine";
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  checkForUpdates,
  later,
  resetUpdates,
  restartToUpdate,
  startUpdates,
  toUpdateError,
  useUpdates,
  type UpdateConfig,
  type UpdaterDeps,
} from "./updates";

// Node's own localStorage stands in for jsdom's and lacks most of it (as in state/settings.test.ts).
const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear() } });

const info = (version = "0.5.0", support: UpdateInfo["support"] = { kind: "inPlace" }): UpdateInfo => ({
  version,
  currentVersion: "0.4.0",
  notes: "Fixes",
  date: null,
  releaseUrl: `https://github.com/EldinHb/Aura/releases/tag/v${version}`,
  support,
});

const run = (actions: Action[], from: UpdateState = initialState()) => actions.reduce(reduce, from);

describe("update state machine", () => {
  it("goes idle with the check time when there is nothing newer", () => {
    const s = run([{ type: "check", manual: false }, { type: "checked", info: null, at: 42 }]);
    expect(s.phase).toEqual({ kind: "idle" });
    expect(s.lastCheck).toBe(42);
  });

  it("downloads an update it can install, then waits for the restart", () => {
    let s = run([{ type: "check", manual: false }, { type: "checked", info: info(), at: 1 }]);
    expect(s.phase).toMatchObject({ kind: "downloading", manual: false, downloaded: 0 });
    // A background download shows nothing.
    expect(bannerOf(s)).toBeNull();
    s = run([{ type: "progress", downloaded: 50, total: 200 }], s);
    expect(s.phase).toMatchObject({ downloaded: 50, total: 200 });
    s = run([{ type: "downloaded" }], s);
    expect(s.phase).toEqual({ kind: "ready", info: info() });
    expect(bannerOf(s)?.kind).toBe("ready");
    s = run([{ type: "install" }], s);
    expect(bannerOf(s)?.kind).toBe("installing");
  });

  it("offers the release page when this copy cannot replace itself", () => {
    const s = run([{ type: "check", manual: false }, { type: "checked", info: info("0.5.0", { kind: "manual", reason: "deb without pkexec" }), at: 1 }]);
    expect(s.phase.kind).toBe("available");
    expect(bannerOf(s)?.kind).toBe("available");
    // Nothing to install.
    expect(run([{ type: "install" }], s)).toBe(s);
  });

  it("Later hides the banner until a newer version, or until asked again", () => {
    const ready = run([{ type: "check", manual: false }, { type: "checked", info: info("0.5.0"), at: 1 }, { type: "downloaded" }]);
    const hidden = run([{ type: "later" }], ready);
    expect(bannerOf(hidden)).toBeNull();
    // The 6-hourly check finds the same version: still hidden.
    const same = run([{ type: "check", manual: false }, { type: "checked", info: info("0.5.0"), at: 2 }, { type: "downloaded" }], hidden);
    expect(bannerOf(same)).toBeNull();
    // A newer one shows.
    const newer = run([{ type: "check", manual: false }, { type: "checked", info: info("0.5.1"), at: 3 }, { type: "downloaded" }], hidden);
    expect(bannerOf(newer)?.kind).toBe("ready");
    // Checking by hand shows it again.
    const asked = run([{ type: "check", manual: true }, { type: "checked", info: info("0.5.0"), at: 4 }, { type: "downloaded" }], hidden);
    expect(bannerOf(asked)?.kind).toBe("ready");
  });

  it("keeps a downloaded update offered while a later check runs", () => {
    const ready = run([{ type: "check", manual: false }, { type: "checked", info: info("0.5.0"), at: 1 }, { type: "downloaded" }]);
    const checking = run([{ type: "check", manual: false }], ready);
    expect(checking.phase).toMatchObject({ kind: "checking", ready: info("0.5.0") });
    expect(bannerOf(checking)).toBe(checking.phase);
    // The same version again: ready at once, nothing to download.
    expect(run([{ type: "checked", info: info("0.5.0"), at: 2 }], checking).phase).toEqual({ kind: "ready", info: info("0.5.0") });
    // A newer one downloads.
    expect(run([{ type: "checked", info: info("0.5.1"), at: 2 }], checking).phase.kind).toBe("downloading");
    // A failed check leaves it ready.
    expect(run([{ type: "failed", error: { kind: "network", message: "offline" } }], checking).phase).toEqual({ kind: "ready", info: info("0.5.0") });
    // Later during the check hides it.
    expect(bannerOf(run([{ type: "later" }], checking))).toBeNull();
  });

  it("does not start a second check while one runs or a download does", () => {
    const checking = run([{ type: "check", manual: false }]);
    expect(run([{ type: "check", manual: false }], checking)).toBe(checking);
    const downloading = run([{ type: "checked", info: info(), at: 1 }], checking);
    // Asking by hand makes the running download's outcome shown.
    expect(run([{ type: "check", manual: true }], downloading).phase).toMatchObject({ kind: "downloading", manual: true });
    expect(bannerOf(run([{ type: "check", manual: true }], downloading))?.kind).toBe("downloading");
  });

  it("fails automatic checks quietly and shows the rest", () => {
    const err = (kind: "network" | "signature") => ({ type: "failed" as const, error: { kind, message: "boom" } });
    const autoCheck = run([{ type: "check", manual: false }, err("network")]);
    expect(autoCheck.phase).toMatchObject({ kind: "error", during: "check", manual: false });
    expect(showsError(autoCheck.phase)).toBe(false);
    expect(showsError(run([{ type: "check", manual: true }, err("network")]).phase)).toBe(true);
    // An automatic download that lost the network retries at the next check; a bad signature is shown.
    const downloading = run([{ type: "check", manual: false }, { type: "checked", info: info(), at: 1 }]);
    expect(showsError(run([err("network")], downloading).phase)).toBe(false);
    expect(showsError(run([err("signature")], downloading).phase)).toBe(true);
    // The user started the install, so its failure is shown.
    const installing = run([{ type: "downloaded" }, { type: "install" }], downloading);
    const failed = run([err("network")], installing);
    expect(failed.phase).toMatchObject({ kind: "error", during: "install", manual: true });
    expect(showsError(failed.phase)).toBe(true);
    // A failure with nothing under way changes nothing.
    expect(run([err("network")])).toEqual(initialState());
  });

  it("says what failed and what to do", () => {
    const s = run([{ type: "check", manual: false }, { type: "checked", info: info(), at: 1 }, { type: "failed", error: { kind: "signature", message: "bad sig" } }]);
    if (s.phase.kind !== "error") throw new Error("expected an error");
    expect(errorMessage(s.phase)).toBe("Could not download Aura 0.5.0: bad sig. Its signature did not verify, so nothing was installed.");
    const c = run([{ type: "check", manual: true }, { type: "failed", error: { kind: "network", message: "offline." } }]);
    if (c.phase.kind !== "error") throw new Error("expected an error");
    expect(errorMessage(c.phase)).toBe("Could not check for updates: offline. Check your connection and try again.");
  });

  it("computes download progress", () => {
    expect(percent(50, 200)).toBe(25);
    expect(percent(50, null)).toBeNull();
    expect(percent(300, 200)).toBe(100);
  });

  it("reads the shell's errors", () => {
    expect(toUpdateError({ kind: "signature", message: "x" })).toEqual({ kind: "signature", message: "x" });
    expect(toUpdateError({ kind: "weird", message: "x" })).toEqual({ kind: "other", message: "x" });
    expect(toUpdateError("plain")).toEqual({ kind: "other", message: "plain" });
  });
});

const config = (over: Partial<UpdateConfig> = {}): UpdateConfig => ({
  currentVersion: "0.4.0",
  autoCheck: true,
  support: { kind: "inPlace" },
  releasesUrl: "https://github.com/EldinHb/Aura/releases",
  testAutoRestart: false,
  ...over,
});

function fakeShell(over: Partial<UpdaterDeps> = {}) {
  const deps = {
    config: vi.fn(async () => config()),
    check: vi.fn(async (): Promise<UpdateInfo | null> => null),
    download: vi.fn(async (onEvent: Parameters<UpdaterDeps["download"]>[0]) => {
      onEvent({ event: "progress", downloaded: 10, total: 10 });
      onEvent({ event: "finished" });
    }),
    install: vi.fn(async () => {}),
    relaunch: vi.fn(async () => {}),
    openUrl: vi.fn(async (_url: string) => {}),
    now: vi.fn(() => 1000),
    log: vi.fn(),
    ...over,
  };
  return deps;
}

const session = (id: string, status: Session["status"]) => ({ id, status }) as Session;
const toasts = () => useStore.getState().toasts;

describe("updater", () => {
  beforeEach(() => {
    resetUpdates();
    localStorage.clear();
    useStore.setState({ toasts: [], sessions: {}, dialog: { kind: "none" }, settings: { ...defaultSettings } });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks 10 seconds after startup and every 6 hours while the setting is on", async () => {
    vi.useFakeTimers();
    const shell = fakeShell();
    const stop = await startUpdates(shell);
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1);
    expect(shell.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(shell.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(shell.check).toHaveBeenCalledTimes(2);
    useStore.getState().setSettings({ autoCheckUpdates: false });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(shell.check).toHaveBeenCalledTimes(2);
    // An automatic check that finds nothing says nothing.
    expect(toasts()).toEqual([]);
    expect(useUpdates.getState().state.lastCheck).toBe(1000);
    stop();
  });

  it("never checks by itself in a development build", async () => {
    vi.useFakeTimers();
    const shell = fakeShell({ config: vi.fn(async () => config({ autoCheck: false })) });
    const stop = await startUpdates(shell);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(shell.check).not.toHaveBeenCalled();
    // Asked, it checks.
    await checkForUpdates(true);
    expect(shell.check).toHaveBeenCalledTimes(1);
    stop();
  });

  it("says when Aura is up to date, if asked", async () => {
    await startUpdates(fakeShell());
    await checkForUpdates(true);
    expect(toasts().map((t) => t.message)).toEqual(["You're up to date (Aura 0.4.0)"]);
    expect(localStorage.getItem("aura.updates.lastCheck")).toBe("1000");
  });

  it("downloads in the background and installs and relaunches on restart", async () => {
    const shell = fakeShell({ check: vi.fn(async () => info()) });
    await startUpdates(shell);
    await checkForUpdates(false);
    expect(shell.download).toHaveBeenCalledTimes(1);
    expect(useUpdates.getState().state.phase.kind).toBe("ready");
    expect(shell.install).not.toHaveBeenCalled();
    await restartToUpdate();
    expect(shell.install).toHaveBeenCalledTimes(1);
    expect(shell.relaunch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(shell.install).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(shell.relaunch).mock.invocationCallOrder[0]);
  });

  it("asks first while sessions work, saying they resume after the update", async () => {
    const shell = fakeShell({ check: vi.fn(async () => info()) });
    await startUpdates(shell);
    await checkForUpdates(false);
    useStore.setState({ sessions: { a: session("a", "running"), b: session("b", "running"), c: session("c", "idle") } });
    await restartToUpdate();
    const dialog = useStore.getState().dialog;
    if (dialog.kind !== "confirm") throw new Error("expected a confirmation");
    expect(dialog.message).toBe("2 sessions are working. They are paused while Aura updates and resume when Aura restarts.");
    expect(shell.install).not.toHaveBeenCalled();
    dialog.onConfirm();
    await vi.waitFor(() => expect(shell.relaunch).toHaveBeenCalledTimes(1));
    expect(shell.install).toHaveBeenCalledTimes(1);
  });

  it("fails automatic checks quietly but shows a manual check's error with a download link", async () => {
    const shell = fakeShell({ check: vi.fn(async () => Promise.reject({ kind: "network", message: "offline" })) });
    await startUpdates(shell);
    await checkForUpdates(false);
    expect(toasts()).toEqual([]);
    expect(shell.log).toHaveBeenCalled();
    await checkForUpdates(true);
    expect(toasts()).toHaveLength(1);
    const [toast] = toasts();
    expect(toast.level).toBe("error");
    expect(toast.message).toContain("Could not check for updates: offline.");
    expect(toast.actions?.map((a) => a.label)).toEqual(["Download manually"]);
    toast.actions![0].run();
    expect(shell.openUrl).toHaveBeenCalledWith("https://github.com/EldinHb/Aura/releases/latest");
  });

  it("checks again while an update waits, without downloading it twice", async () => {
    const shell = fakeShell({ check: vi.fn(async () => info()) });
    await startUpdates(shell);
    await checkForUpdates(false);
    await checkForUpdates(false);
    expect(shell.check).toHaveBeenCalledTimes(2);
    expect(shell.download).toHaveBeenCalledTimes(1);
    expect(useUpdates.getState().state.phase.kind).toBe("ready");
    // Asked by hand, it says the update waits.
    await checkForUpdates(true);
    expect(toasts().map((t) => t.message)).toEqual(["Aura 0.5.0 is ready; restart to update"]);
    // A manual check that fails says so and keeps the update ready.
    vi.mocked(shell.check).mockRejectedValueOnce({ kind: "network", message: "offline" });
    await checkForUpdates(true);
    expect(toasts().at(-1)?.message).toContain("Could not check for updates: offline.");
    expect(useUpdates.getState().state.phase.kind).toBe("ready");
  });

  it("shows a failed install, keeps the app running and does not relaunch", async () => {
    const shell = fakeShell({
      check: vi.fn(async () => info()),
      install: vi.fn(async () => Promise.reject({ kind: "daemon", message: "The Aura daemon did not stop" })),
    });
    await startUpdates(shell);
    await checkForUpdates(false);
    await restartToUpdate();
    expect(shell.relaunch).not.toHaveBeenCalled();
    expect(toasts().map((t) => t.message)).toEqual(["Could not install Aura 0.5.0: The Aura daemon did not stop."]);
  });

  it("shows a bad signature even from an automatic check", async () => {
    const shell = fakeShell({
      check: vi.fn(async () => info()),
      download: vi.fn(async () => Promise.reject({ kind: "signature", message: "signature mismatch" })),
    });
    await startUpdates(shell);
    await checkForUpdates(false);
    expect(useUpdates.getState().state.phase.kind).toBe("error");
    expect(toasts()[0].message).toContain("Its signature did not verify");
  });

  it("restarts by itself only in a test build that asks for it", async () => {
    const shell = fakeShell({ check: vi.fn(async () => info()), config: vi.fn(async () => config({ testAutoRestart: true })) });
    await startUpdates(shell);
    await checkForUpdates(false);
    expect(shell.install).toHaveBeenCalledTimes(1);
    expect(shell.relaunch).toHaveBeenCalledTimes(1);
  });

  it("opens the release page for a copy that cannot replace itself, and Later hides it", async () => {
    const shell = fakeShell({ check: vi.fn(async () => info("0.5.0", { kind: "manual", reason: "read-only" })) });
    await startUpdates(shell);
    await checkForUpdates(false);
    expect(shell.download).not.toHaveBeenCalled();
    expect(bannerOf(useUpdates.getState().state)?.kind).toBe("available");
    await restartToUpdate();
    expect(shell.install).not.toHaveBeenCalled();
    later();
    expect(bannerOf(useUpdates.getState().state)).toBeNull();
  });
});
