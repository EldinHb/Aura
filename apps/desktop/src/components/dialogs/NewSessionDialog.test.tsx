import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { DirEntry, ProviderInfo } from "../../gen";
import type { RpcClient } from "../../lib/rpc";
import { useStore } from "../../state/store";
import { NewSessionDialog } from "./NewSessionDialog";

const dirs = (base: string, n: number): DirEntry[] =>
  Array.from({ length: n }, (_, i) => ({ name: `d${String(i).padStart(2, "0")}`, path: `${base}d${String(i).padStart(2, "0")}`, is_dir: true, is_git_repo: false }));
const listDir = vi.fn((base: string) => Promise.resolve(dirs(base, 20)));
const groupForDir = vi.fn((cwd: string) => Promise.resolve(cwd.startsWith("/repo") ? "backend" : null));

// jsdom lays nothing out: give every element an offsetParent so the modal's Tab trap sees it as visible.
const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");
beforeAll(() => Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => document.body }));
afterAll(() => offsetParent && Object.defineProperty(HTMLElement.prototype, "offsetParent", offsetParent));
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  listDir.mockClear();
  groupForDir.mockClear();
  useStore.setState({
    client: {
      home: () => Promise.resolve("/home/me"),
      listDir,
      gitRepoRoot: () => Promise.resolve(null),
      gitGithubRepo: () => Promise.resolve(null),
      groups: () => Promise.resolve([{ name: "backend", repos: [] }, { name: "docs", repos: [] }]),
      groupForDir,
      models: () => Promise.resolve([]),
    } as unknown as RpcClient,
    providers: [],
    selectedId: null,
  });
});
afterEach(cleanup);

async function openAt(path: string) {
  render(<NewSessionDialog cwd={path} />);
  const input = screen.getByPlaceholderText("~/projects/…") as HTMLInputElement;
  await waitFor(() => expect(document.querySelectorAll(".dir-browser .list-item")).toHaveLength(12));
  input.focus();
  return input;
}
const activeRow = () => document.querySelector(".dir-browser .list-item.active")?.textContent;

it("keeps the arrow keys within the rendered directory rows", async () => {
  const input = await openAt("/work/");
  for (let i = 0; i < 20; i++) fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(activeRow()).toBe("d11/");
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(activeRow()).toBe("d10/");
  expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
});

it("descends into the highlighted directory with the right arrow at the end of the field", async () => {
  const input = await openAt("/work/");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  input.setSelectionRange(input.value.length, input.value.length);
  await act(async () => {
    fireEvent.keyDown(input, { key: "ArrowRight" });
  });
  expect(input.value).toBe("/work/d01/");

  input.setSelectionRange(0, 0);
  fireEvent.keyDown(input, { key: "ArrowRight" });
  expect(input.value).toBe("/work/d01/");
});

it("tabs past the directory rows to the next field", async () => {
  const input = await openAt("/work/");
  fireEvent.keyDown(input, { key: "Tab" });
  expect(document.activeElement).not.toBe(input);
  expect(document.activeElement?.closest(".dir-browser")).toBeNull();
  expect((document.activeElement as HTMLInputElement).placeholder).toMatch(/·/);
});

const groupInput = () => screen.getByText(/^Group \(optional\)/).parentElement!.querySelector("input") as HTMLInputElement;

it("fills the group linked to the directory's repository", async () => {
  const dir = await openAt("/repo/");
  await waitFor(() => expect(groupInput().value).toBe("backend"));
  expect(screen.getByText("· from this repository")).toBeTruthy();
  fireEvent.change(dir, { target: { value: "/elsewhere/" } });
  await waitFor(() => expect(groupInput().value).toBe(""));
  expect(screen.queryByText("· from this repository")).toBeNull();
  expect(Array.from(document.querySelectorAll("#aura-groups-new option")).map((o) => (o as HTMLOptionElement).value)).toEqual(["backend", "docs"]);
});

it("keeps a group the user typed when the directory changes", async () => {
  const dir = await openAt("/repo/");
  await waitFor(() => expect(groupInput().value).toBe("backend"));
  fireEvent.change(groupInput(), { target: { value: "docs" } });
  fireEvent.change(dir, { target: { value: "/elsewhere/" } });
  await waitFor(() => expect(groupForDir).toHaveBeenCalledTimes(1));
  expect(groupInput().value).toBe("docs");
});

it("turns spaces in the worktree branch name into hyphens", async () => {
  useStore.setState({ client: { ...useStore.getState().client, gitRepoRoot: () => Promise.resolve("/repo") } as unknown as RpcClient });
  await openAt("/repo/");
  fireEvent.click(await screen.findByLabelText("Create a git worktree for this session"));
  const branch = screen.getByPlaceholderText("branch name") as HTMLInputElement;
  fireEvent.change(branch, { target: { value: "aura/fix login  bug" } });
  expect(branch.value).toBe("aura/fix-login--bug");
});

const claude = { kind: "claude", display_name: "Claude Code", available: true, version: null, binary: null, agents: [],
  capabilities: { structured: true, models: true, effort: true, permission_modes: [], sandbox_modes: [], terminal_mode: true } } as unknown as ProviderInfo;

it("creates an orchestrator in no folder unless the user gives it one", async () => {
  const createSession = vi.fn((opts: { cwd: string }) => Promise.resolve({ id: `new-${opts.cwd || "none"}` }));
  useStore.setState({ providers: [claude], client: { ...useStore.getState().client, createSession, gitRepoRoot: () => Promise.resolve("/repo") } as unknown as RpcClient });
  render(<NewSessionDialog cwd="/repo/" />);
  await screen.findByLabelText("Create a git worktree for this session");
  fireEvent.click(screen.getByLabelText("Orchestrator: starts and directs other sessions"));
  expect(screen.getByText("None: the orchestrator names a folder for each worker.")).toBeTruthy();
  // No directory, worktree or terminal mode: it is a chat that names a folder per worker.
  expect(screen.queryByPlaceholderText("~/projects/…")).toBeNull();
  expect(screen.queryByLabelText("Create a git worktree for this session")).toBeNull();
  expect(screen.queryByText("Native TUI in terminal")).toBeNull();
  expect(screen.getByPlaceholderText("claude · orchestrator")).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByText(/^Create/)); });
  expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: "", orchestrator: true, mode: "structured", worktree: null }));

  cleanup();
  createSession.mockClear();
  render(<NewSessionDialog cwd="/repo/" />);
  fireEvent.click(screen.getByLabelText("Orchestrator: starts and directs other sessions"));
  fireEvent.click(screen.getByText("Use a folder"));
  expect((screen.getByPlaceholderText("~/projects/…") as HTMLInputElement).value).toBe("/repo/");
  await act(async () => { fireEvent.click(screen.getByText(/^Create/)); });
  expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo", orchestrator: true }));
});

it("does not offer an orchestrator's own directory as the folder of a new session", async () => {
  useStore.setState({
    sessions: { o: { id: "o", cwd: "/data/orchestrators/o", folderless: true, orchestrator: true } as never },
    selectedId: "o",
  });
  render(<NewSessionDialog />);
  const input = screen.getByPlaceholderText("~/projects/…") as HTMLInputElement;
  await waitFor(() => expect(input.value).toBe("/home/me"));
});

it("gives a terminal its folder back after the orchestrator box was ticked for another provider", async () => {
  const createSession = vi.fn(() => Promise.resolve({ id: "t" }));
  const terminal = { kind: "terminal", display_name: "Terminal", available: true, version: null, binary: null, agents: [], capabilities: { structured: false, permission_modes: [], sandbox_modes: [] } } as unknown as ProviderInfo;
  useStore.setState({ providers: [claude, terminal], client: { ...useStore.getState().client, createSession } as unknown as RpcClient });
  render(<NewSessionDialog cwd="/work/" />);
  fireEvent.click(screen.getByLabelText("Orchestrator: starts and directs other sessions"));
  expect(screen.queryByPlaceholderText("~/projects/…")).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: /Terminal/ }));
  expect(screen.getByPlaceholderText("~/projects/…")).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByText(/^Create/)); });
  expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ provider: "terminal", cwd: "/work", orchestrator: false, mode: "terminal" }));
});

it("creates a feature owner with its goal as the first message and its own autonomy", async () => {
  const createSession = vi.fn(async () => ({ id: "s" }));
  const st = useStore.getState();
  useStore.setState({
    client: { ...(st.client as object), createSession, autonomy: () => Promise.resolve({ level: "blocking_decisions", checkpoints: ["after_design", "before_implementation", "before_delivery"] }) } as unknown as RpcClient,
    providers: [{ kind: "claude", display_name: "Claude Code", available: true, version: null, binary: null, agents: [], capabilities: { permission_modes: [], sandbox_modes: [] } } as unknown as ProviderInfo],
  });
  render(<NewSessionDialog featureOwner />);
  const owner = screen.getByRole("checkbox", { name: /Feature owner/ }) as HTMLInputElement;
  expect(owner.checked).toBe(true);
  expect((screen.getByRole("checkbox", { name: /Orchestrator/ }) as HTMLInputElement).checked).toBe(true);
  expect(screen.queryByText("Initial prompt (optional)")).toBeNull();
  expect(await screen.findByText(/otherwise blocking decisions/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Dark mode for the settings" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /Own autonomy for this feature/ }));
  fireEvent.click(screen.getByRole("radio", { name: /Autonomous/ }));
  fireEvent.click(screen.getByRole("button", { name: /Create/ }));
  await waitFor(() =>
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      provider: "claude",
      cwd: "",
      orchestrator: true,
      feature_owner: true,
      feature_goal: "Dark mode for the settings",
      initial_prompt: "Dark mode for the settings",
      autonomy: { level: "autonomous", checkpoints: ["after_design", "before_implementation", "before_delivery"] },
    })),
  );
});
