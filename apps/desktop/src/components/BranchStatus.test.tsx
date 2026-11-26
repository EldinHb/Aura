import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BranchStatus, Session } from "../gen";
import type { RpcClient } from "../lib/rpc";
import { useStore } from "../state/store";
import { resetBranches } from "../state/branchStatus";
import { slots } from "../mods/registry";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";

const git = new Map<string, BranchStatus | null>();
const gitBranchStatus = vi.fn(async (cwd: string) => git.get(cwd) ?? null);
const unregister: Array<() => void> = [];

function session(id: string, title: string, extra: Partial<Session> = {}): Session {
  return { id, title, cwd: `/work/${id}`, provider: "claude", status: "idle", mode: "structured", archived: false, pinned: false,
    pending_count: 0, last_activity: "2026-09-30T00:00:00Z", group: null, worktree: null, model: null, usage: {}, ...extra } as Session;
}

function status(extra: Partial<BranchStatus> = {}): BranchStatus {
  return { branch: "feature", head: "1234567890abcdef", upstream: "origin/feature", upstream_branch: "feature", upstream_repo: "owner/repo",
    ahead: 0, behind: 0, changed: 0, ...extra };
}

const rowText = (id: string, part: string) => document.querySelector(`[data-session-id="${id}"] ${part}`)?.textContent;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  resetBranches();
  git.clear();
  gitBranchStatus.mockClear();
  useStore.setState({
    client: { getSetting: async () => null, setSetting: async () => true, gitBranchStatus } as unknown as RpcClient,
    connection: "open",
    sessions: { a: session("a", "Hours page"), b: session("b", "Other") },
    sessionOrder: ["a", "b"], transcripts: {}, sidebarFilter: "", showArchived: false, selectedId: "a", modView: null,
  });
});
afterEach(() => {
  cleanup();
  while (unregister.length) unregister.pop()!();
  vi.useRealTimers();
});

it("shows each session's branch with unpushed, unpulled and uncommitted counts", async () => {
  git.set("/work/a", status({ ahead: 2, behind: 1, changed: 3 }));
  git.set("/work/b", status({ branch: null, head: "abcdef0123456789", upstream: null, upstream_branch: null, upstream_repo: null }));
  render(<Sidebar />);
  await waitFor(() => expect(rowText("a", ".sub .where")).toBe("a · ⎇ feature ↑2 ↓1 ±3"));
  expect(rowText("b", ".sub .where")).toBe("b · ⎇ abcdef0");
});

it("keeps showing the worktree branch before git is read, and no folder for worktree sessions", async () => {
  useStore.setState({ sessions: { a: session("a", "Hours page", { worktree: { repo_root: "/work", path: "/work/a", branch: "wt-branch" } }) }, sessionOrder: ["a"] });
  git.set("/work/a", status({ changed: 1 }));
  render(<Sidebar />);
  expect(rowText("a", ".sub .where")).toBe("⎇ wt-branch");
  await waitFor(() => expect(rowText("a", ".sub .where")).toBe("⎇ feature ±1"));
});

it("shows the selected session's branch in the status bar, with what mods add to it", async () => {
  git.set("/work/a", status({ ahead: 1 }));
  const seen = vi.fn();
  unregister.push(slots.branchDecoration.register("test-mod", "pull", {
    component: ({ cwd, status, place, session }) => {
      seen(cwd, (status as BranchStatus).branch, place, session?.id);
      return <span className="test-decoration">PR #42</span>;
    },
  }));
  render(<StatusBar />);
  await waitFor(() => expect(document.querySelector(".statusbar-branch")?.textContent).toBe("⎇ feature ↑1PR #42"));
  expect(seen).toHaveBeenLastCalledWith("/work/a", "feature", "statusbar", "a");
});

it("keeps the branch when a mod's decoration fails to render", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  git.set("/work/a", status());
  unregister.push(slots.branchDecoration.register("test-mod", "broken", { component: () => { throw new Error("boom"); } }));
  render(<StatusBar />);
  await waitFor(() => expect(document.querySelector(".statusbar-branch")?.textContent).toBe("⎇ feature"));
});

it("shows nothing outside a repository", async () => {
  render(<StatusBar />);
  await waitFor(() => expect(gitBranchStatus).toHaveBeenCalledWith("/work/a"));
  expect(document.querySelector(".statusbar-branch")).toBeNull();
});
