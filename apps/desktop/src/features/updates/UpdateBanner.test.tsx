import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useStore } from "../../state/store";
import { Toasts } from "../../components/Toasts";
import { checkForUpdates, resetUpdates, startUpdates, type UpdaterDeps } from "./updates";
import type { UpdateInfo } from "./machine";

const info = (support: UpdateInfo["support"] = { kind: "inPlace" }): UpdateInfo => ({
  version: "0.5.0",
  currentVersion: "0.4.0",
  notes: null,
  date: null,
  releaseUrl: "https://github.com/EldinHb/Aura/releases/tag/v0.5.0",
  support,
});

function shell(found: UpdateInfo): UpdaterDeps & { install: ReturnType<typeof vi.fn>; openUrl: ReturnType<typeof vi.fn> } {
  return {
    config: async () => ({ currentVersion: "0.4.0", autoCheck: true, support: found.support, releasesUrl: "https://github.com/EldinHb/Aura/releases", testAutoRestart: false, firstCheckPassed: false }),
    check: async () => found,
    download: async () => {},
    install: vi.fn(async () => {}),
    lastResult: async () => null,
    relaunch: async () => {},
    openUrl: vi.fn(async () => {}),
    now: () => 1,
    onTick: () => () => {},
    log: () => {},
  };
}

describe("update banner", () => {
  beforeEach(() => {
    resetUpdates();
    useStore.setState({ toasts: [], sessions: {}, dialog: { kind: "none" } });
  });
  afterEach(cleanup);

  it("offers the restart, the release notes and Later once the update is ready", async () => {
    const s = shell(info());
    await startUpdates(s);
    render(<Toasts />);
    await act(() => checkForUpdates(false));
    expect(screen.getByText(/Aura 0\.5\.0 is ready —/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Release notes" }));
    expect(s.openUrl).toHaveBeenCalledWith("https://github.com/EldinHb/Aura/releases/tag/v0.5.0");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Restart to update" })));
    expect(s.install).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Installing Aura 0\.5\.0/)).toBeTruthy();
  });

  it("Later hides it", async () => {
    await startUpdates(shell(info()));
    render(<Toasts />);
    await act(() => checkForUpdates(false));
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByText(/is ready/)).toBeNull();
  });

  it("links to the download when this copy cannot replace itself, with the reason", async () => {
    const s = shell(info({ kind: "manual", reason: "Aura runs from a read-only disk." }));
    await startUpdates(s);
    render(<Toasts />);
    await act(() => checkForUpdates(false));
    expect(screen.getByText("Update available: Aura 0.5.0")).toBeTruthy();
    expect(screen.getByText("Aura runs from a read-only disk.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restart to update" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(s.openUrl).toHaveBeenCalledWith("https://github.com/EldinHb/Aura/releases/latest");
  });

  it("runs a toast's action and dismisses the toast", () => {
    const run = vi.fn();
    render(<Toasts />);
    act(() => useStore.getState().toast("Could not check", "error", { actions: [{ label: "Download manually", run }] }));
    fireEvent.click(screen.getByRole("button", { name: "Download manually" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(useStore.getState().toasts).toEqual([]);
  });
});
