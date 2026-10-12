import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CleanupReport, Session } from "../../gen";
import type { RpcClient } from "../../lib/rpc";
import { defaultSettings, useStore } from "../../state/store";
import { CLEANUP_PROMPT, GitCleanupDialog } from "./GitCleanupDialog";

const report: CleanupReport = {
  root: "/code/widget",
  base: "origin/main",
  branches: [
    { name: "fix-empty", reason: "gone", unmerged: 2, subject: "Handle empty", date: "2026-10-01T10:00:00Z" },
    { name: "old-docs", reason: "merged", unmerged: 0, subject: "Docs", date: "2026-09-01T10:00:00Z" },
  ],
  prunable_worktrees: ["/code/widget/.aura-worktrees/gone"],
  fetch_error: null,
};
const client = {
  gitMainRepoRoot: vi.fn(async (cwd: string) => (cwd.startsWith("/code/widget") ? "/code/widget" : cwd === "/code/other" ? "/code/other" : null)),
  gitGithubRepo: vi.fn(async (root: string) => (root === "/code/widget" ? "acme/widget" : null)),
  gitCleanupCandidates: vi.fn(async () => report),
  gitCleanup: vi.fn(async () => ({ deleted: ["old-docs"], failed: [], pruned_worktrees: 1 })),
  createSession: vi.fn(async () => ({ id: "s-clean" }) as Session),
};

beforeEach(() => {
  vi.clearAllMocks();
  const sessions = {
    a: { id: "a", cwd: "/code/widget/.aura-worktrees/feat" },
    b: { id: "b", cwd: "/code/other" },
    c: { id: "c", cwd: "/tmp/not-a-repo" },
  } as unknown as Record<string, Session>;
  useStore.setState({ client: client as unknown as RpcClient, sessions, settings: { ...defaultSettings, defaultProvider: "terminal" }, dialog: { kind: "git-cleanup" }, selectedId: null });
});
afterEach(cleanup);

it("finds the PR's repository among session folders and deletes the selected branches", async () => {
  render(<GitCleanupDialog repo="acme/widget" />);
  await screen.findByText("fix-empty");
  expect((screen.getByLabelText("Repository") as HTMLSelectElement).value).toBe("/code/widget");
  expect(screen.getAllByRole("option")).toHaveLength(2);
  expect(screen.getByText("2 commits not in origin/main")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: /fix-empty/ }));
  fireEvent.click(screen.getByRole("button", { name: /Delete 1 branch and prune/ }));
  await waitFor(() => expect(client.gitCleanup).toHaveBeenCalledWith("/code/widget", ["old-docs"], true));
  await waitFor(() => expect(useStore.getState().dialog.kind).toBe("none"));
});

it("hands the repository to an agent session", async () => {
  render(<GitCleanupDialog cwd="/code/other" />);
  await waitFor(() => expect((screen.getByLabelText("Repository") as HTMLSelectElement).value).toBe("/code/other"));
  fireEvent.click(screen.getByRole("button", { name: "Let an agent clean up" }));
  await waitFor(() => expect(client.createSession).toHaveBeenCalledWith({ provider: "claude", cwd: "/code/other", title: "Clean up other", initial_prompt: CLEANUP_PROMPT }));
  expect(useStore.getState().selectedId).toBe("s-clean");
  expect(client.gitCleanup).not.toHaveBeenCalled();
});
