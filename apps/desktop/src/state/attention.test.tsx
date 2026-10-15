import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PullChange, Session } from "../gen";
import type { RpcClient } from "../lib/rpc";
import { usePullChanges } from "../features/reviews/changes";
import { Sidebar } from "../components/Sidebar";
import { InboxButton } from "../components/InboxButton";
import { StatusBar } from "../components/StatusBar";
import { useKeyboard } from "../hooks/useKeyboard";
import { registerCoreCommands } from "../commands/core";
import { formatKeys, normalizeChord } from "../lib/keymap";
import { isMac } from "../lib/platform";
import { inboxCount, useInboxCount, useMarkViewedSeen } from "./attention";
import { defaultSettings, useStore } from "./store";

vi.mock("../features/reviews/ReviewSidebar", () => ({ ReviewSidebar: () => null }));

function session(id: string, patch: Partial<Session> = {}): Session {
  return { id, title: id, cwd: `/work/${id}`, provider: "claude", status: "idle", mode: "structured", archived: false, pinned: false,
    pending_count: 0, last_activity: "2026-10-15T00:00:00Z", group: null, worktree: null, model: null, orchestrator: false, orchestrator_id: null, pulls: [], attention: null, ...patch } as Session;
}

function change(id: string, patch: Partial<PullChange> = {}): PullChange {
  return { id, account: "me", pull_id: "o/r#1", repo: "o/r", number: 1, title: "PR", url: "", role: "authored", events: [{ kind: "review", text: "approved" }], summary: "", created_at: "", read: false, ...patch } as PullChange;
}

const markSeen = vi.fn(async (id: string) => session(id));
let focused = true;
let visibility: DocumentVisibilityState = "visible";
const marker = (id: string) => document.querySelector<HTMLElement>(`[data-session-id="${id}"] .title-line .attention`);
const setFocused = (on: boolean) => act(() => {
  focused = on;
  window.dispatchEvent(new Event(on ? "focus" : "blur"));
});

const setVisible = (on: boolean) => act(() => {
  visibility = on ? "visible" : "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
});

beforeEach(() => {
  focused = true;
  visibility = "visible";
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  Element.prototype.scrollIntoView = vi.fn();
  markSeen.mockClear();
  usePullChanges.setState({ changes: [] });
  useStore.setState({
    // Links and repositories never arrive, so rows do not re-render behind the test's back.
    client: { markSeen, getSetting: () => new Promise(() => {}), gitGithubRepo: () => new Promise(() => {}) } as unknown as RpcClient,
    sessions: {
      done: session("done", { attention: "done" }),
      failed: session("failed", { attention: "failed", status: "error" }),
      waiting: session("waiting", { attention: "waiting", status: "waiting_approval", pending_count: 2 }),
      quiet: session("quiet"),
    },
    sessionOrder: ["done", "failed", "waiting", "quiet"], transcripts: {}, sidebarFilter: "", showArchived: false,
    collapsedOrchestras: [], selectedId: null, sidebarCursor: null, prSelection: null, reviewHistoryOpen: false, settings: defaultSettings,
    dialog: { kind: "none" }, paletteOpen: false,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("marks sessions that stopped since they were opened, each kind its own way", () => {
  render(<Sidebar />);
  expect(marker("done")?.className).toBe("attention done");
  expect(marker("failed")?.className).toBe("attention failed");
  expect(marker("waiting")?.className).toBe("attention waiting");
  expect(marker("waiting")?.getAttribute("aria-label")).toBe("Waiting on you since you last looked");
  expect(marker("quiet")).toBeNull();
  expect(document.querySelector('[data-session-id="done"]')?.classList.contains("unseen")).toBe(true);
  expect(document.querySelector('[data-session-id="quiet"]')?.classList.contains("unseen")).toBe(false);
});

it("clears the marker of the session the user opens, and keeps the others across switches", () => {
  renderHook(() => useMarkViewedSeen());
  render(<Sidebar />);
  act(() => useStore.getState().select("done"));
  expect(markSeen).toHaveBeenCalledWith("done");
  expect(useStore.getState().sessions.done.attention).toBeNull();
  expect(marker("done")).toBeNull();

  act(() => useStore.getState().select("quiet"));
  expect(markSeen).toHaveBeenCalledTimes(1);
  expect(marker("failed")).not.toBeNull();
  expect(marker("waiting")).not.toBeNull();
  // The pending approvals stay: opening a session does not answer them.
  expect(useStore.getState().sessions.waiting.pending_count).toBe(2);
});

it("does not mark a session that stops while the user looks at it, only while they look elsewhere", () => {
  renderHook(() => useMarkViewedSeen());
  render(<Sidebar />);
  act(() => useStore.getState().select("quiet"));
  act(() => useStore.getState().upsertSession(session("quiet", { attention: "done" })));
  expect(markSeen).toHaveBeenCalledWith("quiet");
  expect(useStore.getState().sessions.quiet.attention).toBeNull();

  // Another window has the focus: the selected session is not being looked at.
  setFocused(false);
  markSeen.mockClear();
  act(() => useStore.getState().upsertSession(session("quiet", { attention: "done" })));
  expect(markSeen).not.toHaveBeenCalled();
  expect(marker("quiet")).not.toBeNull();
  // Coming back to the window is looking at it.
  setFocused(true);
  expect(markSeen).toHaveBeenCalledWith("quiet");
  expect(marker("quiet")).toBeNull();
});

it("does not clear a session hidden behind an open pull request", () => {
  renderHook(() => useMarkViewedSeen());
  act(() => useStore.setState({ selectedId: "done", reviewHistoryOpen: true }));
  expect(markSeen).not.toHaveBeenCalled();
  expect(useStore.getState().sessions.done.attention).toBe("done");
});

it("marks the hidden-workers chip of a collapsed orchestrator with the most urgent kind under it", () => {
  useStore.setState({
    sessions: {
      lead: session("lead", { orchestrator: true }),
      w1: session("w1", { orchestrator_id: "lead", attention: "done" }),
      w2: session("w2", { orchestrator_id: "lead", attention: "waiting", pending_count: 1 }),
    },
    sessionOrder: ["lead", "w1", "w2"], collapsedOrchestras: ["lead"],
  });
  render(<Sidebar />);
  const chip = document.querySelector<HTMLElement>('[data-session-id="lead"] .chip.workers');
  expect(chip?.querySelector(".attention")?.className).toBe("attention waiting");
  expect(chip?.querySelector(".attention")?.getAttribute("aria-label")).toBe("Hidden workers: waiting on you since you last looked");
  expect(chip?.title).toBe("w1 · finished since you last looked\nw2 · waiting on you since you last looked");
});

it("counts what the inbox lists: waiting approvals and questions, and unread unmuted PR changes", () => {
  const changes = [change("c1"), change("c2", { read: true }), change("c3", { events: [{ kind: "commits", text: "1 new commit" }] as PullChange["events"] })];
  usePullChanges.setState({ changes });
  expect(inboxCount(useStore.getState())).toBe(4);
  const { result } = renderHook(() => useInboxCount());
  expect(result.current).toBe(4);
  act(() => useStore.getState().setSettings({ pullChangesMuted: ["commits"] }));
  expect(result.current).toBe(3);
  act(() => useStore.getState().upsertSession(session("waiting", { pending_count: 0 })));
  expect(result.current).toBe(1);
  act(() => usePullChanges.setState({ changes: [] }));
  expect(result.current).toBe(0);
});

it("does not count a session as looked at while the window is hidden", () => {
  renderHook(() => useMarkViewedSeen());
  setVisible(false);
  act(() => useStore.getState().select("done"));
  expect(markSeen).not.toHaveBeenCalled();
  setVisible(true);
  expect(markSeen).toHaveBeenCalledWith("done");
});

it("does not count a session as looked at while a dialog or the palette covers it", () => {
  renderHook(() => useMarkViewedSeen());
  render(<Sidebar />);
  act(() => useStore.setState({ dialog: { kind: "inbox" } }));
  act(() => useStore.getState().select("done"));
  expect(markSeen).not.toHaveBeenCalled();
  expect(marker("done")).not.toBeNull();
  act(() => useStore.setState({ dialog: { kind: "none" }, paletteOpen: true }));
  expect(markSeen).not.toHaveBeenCalled();
  act(() => useStore.setState({ paletteOpen: false }));
  expect(markSeen).toHaveBeenCalledWith("done");
  expect(marker("done")).toBeNull();
});

it("warns when the daemon could not mark a session seen", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  markSeen.mockRejectedValueOnce(new Error("gone"));
  renderHook(() => useMarkViewedSeen());
  act(() => useStore.getState().select("done"));
  await act(async () => {});
  expect(warn).toHaveBeenCalledWith("Could not mark session done seen:", expect.any(Error));
});

/** A default binding as the app shows it. */
const keys = (chord: string) => formatKeys(normalizeChord(chord, isMac, defaultSettings.leader), isMac);

/** The top bar's button as the app shows it, with the keymap installed. */
function TopBar() {
  useKeyboard();
  return <InboxButton />;
}

it("keeps the inbox button in the top bar and badges it with what the inbox lists", async () => {
  const unregister = registerCoreCommands();
  useStore.setState({ sessions: { quiet: session("quiet") }, sessionOrder: ["quiet"] });
  render(<TopBar />);
  const button = screen.getByRole("button", { name: "Inbox" });
  expect(button.querySelector(".badge")).toBeNull();
  expect(button.title).toBe(`Inbox: nothing waiting (${keys("mod+i")})`);

  // Approvals waiting in a session and an unread pull request change.
  act(() => {
    useStore.getState().upsertSession(session("waiting", { pending_count: 2 }));
    usePullChanges.setState({ changes: [change("c1"), change("c2", { read: true })] });
  });
  expect(button.getAttribute("aria-label")).toBe("Inbox, 3 items");
  expect(button.querySelector(".badge")?.textContent).toBe("3");
  expect(button.title).toBe(`Inbox: 3 waiting on you or unread (${keys("mod+i")})`);
  await act(async () => { fireEvent.click(button); });
  expect(useStore.getState().dialog).toEqual({ kind: "inbox" });
  unregister();
});

it("shows the shortcuts the keymap has, also after they are rebound", () => {
  function Bars() {
    useKeyboard();
    return <><InboxButton /><StatusBar /></>;
  }
  useStore.setState({ sessions: { waiting: session("waiting", { pending_count: 1 }) }, sessionOrder: ["waiting"] });
  render(<Bars />);
  const statusbar = document.querySelector(".statusbar")!;
  const kbds = () => [...statusbar.querySelectorAll("kbd")].map((k) => k.textContent);
  expect(kbds()).toEqual([keys("mod+i"), keys("ctrl+space"), keys("mod+k"), "?"]);
  act(() => useStore.getState().setSettings({ keymapOverrides: [{ keys: "mod+i", command: "" }, { keys: "mod+shift+i", command: "inbox.open" }] }));
  expect(kbds()[0]).toBe(keys("mod+shift+i"));
  expect(screen.getByRole("button", { name: /^Inbox/ }).title).toContain(keys("mod+shift+i"));
});
