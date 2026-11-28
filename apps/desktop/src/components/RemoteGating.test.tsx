/** What a remote computer refuses is hidden or explained, not thrown at the user. */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { ProviderInfo, Session } from "../gen";
import type { RpcClient } from "../lib/rpc";
import { LOCAL, useStore } from "../state/store";
import { NewSessionDialog } from "./dialogs/NewSessionDialog";
import { TerminalView } from "../views/TerminalView";

const provider = (kind: string): ProviderInfo =>
  ({ kind, display_name: kind, available: true, version: null, binary: null, capabilities: { structured: kind !== "terminal", terminal_mode: true, permission_modes: [], sandbox_modes: [] }, agents: [] }) as unknown as ProviderInfo;

const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");
beforeAll(() => Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => document.body }));
afterAll(() => offsetParent && Object.defineProperty(HTMLElement.prototype, "offsetParent", offsetParent));

const listDir = vi.fn(() => Promise.resolve([]));
const home = vi.fn(() => Promise.resolve("/Users/me"));
const projects = vi.fn(() =>
  Promise.resolve([
    { path: "/srv/aura", repo: true, groups: [], sessions: 3, last_used: "" },
    { path: "/srv/notes", repo: false, groups: [], sessions: 1, last_used: "" },
  ]),
);
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  listDir.mockClear();
  home.mockClear();
  useStore.setState({
    computer: "srv",
    client: { listDir, home, projects, models: () => Promise.resolve([]), gitRepoRoot: vi.fn(), groupForDir: vi.fn(), groups: vi.fn(), autonomy: vi.fn() } as unknown as RpcClient,
    localClient: null,
    providers: [provider("claude"), provider("codex"), provider("terminal")],
    selectedId: null,
    sessions: {},
    workspaces: [],
  });
});
afterEach(() => {
  cleanup();
  useStore.setState({ computer: LOCAL });
});

it("the new-session dialog on a remote: no terminal, no file browsing, its projects to pick from", async () => {
  render(<NewSessionDialog />);
  await waitFor(() => expect(document.querySelectorAll(".dir-browser .list-item")).toHaveLength(1));
  // Starts in its most recent project; the other is offered.
  expect((screen.getByPlaceholderText("A folder in one of its projects") as HTMLInputElement).value).toBe("/srv/aura");
  expect(document.querySelector(".dir-browser .list-item")?.textContent).toContain("/srv/notes");
  expect(screen.queryByRole("radio", { name: /Terminal/ })).toBeNull();
  expect(screen.getByRole("radio", { name: /claude/ })).toBeTruthy();
  expect(screen.queryByText("Native TUI in terminal")).toBeNull();
  expect(screen.getByText(/Browsing its files: not available on remote computers/)).toBeTruthy();
  // Its project is a repository: a worktree can be asked for.
  // (Known once the projects are in: a render after the folder rows.)
  expect(await screen.findByText("Create a git worktree for this session")).toBeTruthy();
  // Nothing of the local file system was asked.
  expect(listDir).not.toHaveBeenCalled();
  expect(home).not.toHaveBeenCalled();
});

it("a terminal session on a remote says why it is not shown", () => {
  useStore.setState({ sessions: { t: { id: "t", title: "Build shell", mode: "terminal" } as Session } });
  render(<TerminalView sessionId="t" />);
  expect(screen.getByRole("status").textContent).toContain("Terminals: not available on remote computers");
});

it("a new-session dialog creates nothing on a computer other than the one it was opened for", async () => {
  const createSession = vi.fn(() => Promise.resolve({ id: "s" }));
  const toast = vi.fn();
  useStore.setState({ client: { listDir, home, projects, createSession, models: () => Promise.resolve([]) } as unknown as RpcClient, toast });
  render(<NewSessionDialog />);
  await waitFor(() => expect(document.querySelectorAll(".dir-browser .list-item")).toHaveLength(1));
  expect(document.querySelector(".new-session-computer")?.textContent).toBe("on Remote computer");
  // Another computer shown underneath (a switch the dialog did not see).
  act(() => useStore.setState({ computer: LOCAL }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /Create/ })));
  expect(createSession).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith(expect.stringContaining("Nothing was created"), "error");
});
