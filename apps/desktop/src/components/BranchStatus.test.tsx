import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BranchPull, BranchStatus, Item, Session } from "../gen";
import type { RpcClient } from "../lib/rpc";
import { emptyTranscript, useStore } from "../state/store";
import { useDetectedLinksStore, useLinkPreferencesStore } from "../state/sessionLinkPreferences";
import { useGithubRepos } from "../state/githubRepos";
import { PULL_TTL, resetBranches } from "../state/branchStatus";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";

vi.mock("../features/reviews/ReviewSidebar", () => ({ ReviewSidebar: () => null }));

const pr = "https://github.com/owner/repo/pull/42";
const git = new Map<string, BranchStatus | null>();
let pullResult: BranchPull | null = null;
const gitBranchStatus = vi.fn(async (cwd: string) => git.get(cwd) ?? null);
const githubBranchPull = vi.fn(async () => pullResult);
const gitGithubRepo = vi.fn(async (cwd: string) => (cwd === "/work/a" ? "owner/repo" : null));

function session(id: string, title: string, extra: Partial<Session> = {}): Session {
  return { id, title, cwd: `/work/${id}`, provider: "claude", status: "idle", mode: "structured", archived: false, pinned: false,
    pending_count: 0, last_activity: "2026-09-30T00:00:00Z", group: null, worktree: null, model: null, usage: {}, ...extra } as Session;
}

function status(extra: Partial<BranchStatus> = {}): BranchStatus {
  return { branch: "feature", head: "1234567890abcdef", upstream: "origin/feature", upstream_branch: "feature", upstream_repo: "owner/repo",
    ahead: 0, behind: 0, changed: 0, ...extra };
}

function pull(extra: Partial<BranchPull> = {}): BranchPull {
  return { repo: "owner/repo", number: 42, title: "Add hours page", url: pr, state: "open", draft: false,
    checks: "SUCCESS", review_decision: "APPROVED", head_sha: "1234567890abcdef", reviews: [], ...extra };
}

const rowText = (id: string, part: string) => document.querySelector(`[data-session-id="${id}"] ${part}`)?.textContent;
const rowLinks = (id: string) => [...document.querySelectorAll(`[data-session-id="${id}"] .session-row-link`)].map((el) => el.textContent);

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  resetBranches();
  git.clear();
  pullResult = null;
  gitBranchStatus.mockClear();
  githubBranchPull.mockClear();
  useLinkPreferencesStore.setState({ entries: {} });
  useDetectedLinksStore.setState({ links: {} });
  useGithubRepos.setState({ repos: {} });
  useStore.setState({
    client: { getSetting: async () => null, setSetting: async () => true, gitGithubRepo, gitBranchStatus, githubBranchPull } as unknown as RpcClient,
    connection: "open",
    sessions: { a: session("a", "Hours page"), b: session("b", "Other") },
    sessionOrder: ["a", "b"], transcripts: {}, sidebarFilter: "", showArchived: false, selectedId: "a", prSelection: null, reviewHistoryOpen: false,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("shows each session's branch with unpushed, unpulled and uncommitted counts", async () => {
  git.set("/work/a", status({ ahead: 2, behind: 1, changed: 3 }));
  git.set("/work/b", status({ branch: null, head: "abcdef0123456789", upstream: null, upstream_branch: null, upstream_repo: null }));
  render(<Sidebar />);
  await waitFor(() => expect(rowText("a", ".sub")).toBe("a · ⎇ feature ↑2 ↓1 ±3"));
  expect(rowText("b", ".sub")).toBe("b · ⎇ abcdef0");
});

it("keeps showing the worktree branch before git is read, and no folder for worktree sessions", async () => {
  useStore.setState({ sessions: { a: session("a", "Hours page", { worktree: { repo_root: "/work", path: "/work/a", branch: "wt-branch" } }) }, sessionOrder: ["a"] });
  git.set("/work/a", status({ changed: 1 }));
  render(<Sidebar />);
  expect(rowText("a", ".sub")).toBe("⎇ wt-branch");
  await waitFor(() => expect(rowText("a", ".sub")).toBe("⎇ feature ±1"));
});

it("shows the branch's pull request status in its row in place of the same linked PR", async () => {
  git.set("/work/a", status());
  pullResult = pull();
  useStore.setState({ transcripts: { a: { ...emptyTranscript(), loaded: true, items: { m: { id: "m", session_id: "a", turn_id: null, kind: "agent_message", status: "completed", title: null, text: `Created PR: ${pr}`, data: {}, parent_id: null, started_at: "2026-09-30T00:00:00Z", ended_at: null } as Item }, order: ["m"] } } });
  render(<Sidebar />);
  await waitFor(() => expect(rowLinks("a")).toEqual(["PR #42 ✓ approved"]));
  expect(githubBranchPull).toHaveBeenCalledWith("owner/repo", "owner/repo", "feature");
  expect(document.querySelector(".branch-pull")?.getAttribute("title")).toBe("owner/repo#42 · open · checks pass · approved\nAdd hours page");
  // Session b has no GitHub repository, so its pull request is never asked for.
  expect(githubBranchPull).toHaveBeenCalledTimes(1);
});

it("looks for the pull request under the tracked branch of a fork", async () => {
  git.set("/work/a", status({ branch: "local-name", upstream: "fork/feat", upstream_branch: "feat", upstream_repo: "me/repo" }));
  render(<Sidebar />);
  await waitFor(() => expect(githubBranchPull).toHaveBeenCalledWith("owner/repo", "me/repo", "feat"));
});

it("shows merged and draft pull requests", async () => {
  git.set("/work/a", status());
  pullResult = pull({ state: "merged" });
  const { unmount } = render(<Sidebar />);
  await waitFor(() => expect(rowLinks("a")).toEqual(["PR #42 merged"]));
  unmount();
  resetBranches();
  pullResult = pull({ draft: true, checks: "PENDING", review_decision: "REVIEW_REQUIRED" });
  render(<Sidebar />);
  await waitFor(() => expect(rowLinks("a")).toEqual(["PR #42 draft …"]));
});

it("counts a comment-only review as reviewed in the row", async () => {
  git.set("/work/a", status());
  pullResult = pull({ review_decision: "REVIEW_REQUIRED", reviews: [{ bot: false, reviewer: "alice", state: "COMMENTED", submitted_at: "2026-10-05T10:00:00Z", commit_sha: "1234567890abcdef" }] });
  render(<Sidebar />);
  await waitFor(() => expect(rowLinks("a")).toEqual(["PR #42 ✓ commented"]));
});

it("shows the selected session's branch and pull request in the status bar", async () => {
  git.set("/work/a", status({ ahead: 1 }));
  pullResult = pull({ checks: "FAILURE", review_decision: "CHANGES_REQUESTED" });
  render(<StatusBar />);
  await waitFor(() => expect(document.querySelector(".statusbar-branch")?.textContent).toBe("⎇ feature ↑1PR #42 · open · checks fail · changes requested"));
  expect(screen.getByRole("link").getAttribute("href")).toBe(pr);
});

it("reads the pull request again after a push, but not on every git read", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  git.set("/work/a", status({ ahead: 1 }));
  pullResult = pull();
  render(<StatusBar />);
  await waitFor(() => expect(githubBranchPull).toHaveBeenCalledTimes(1));
  await act(async () => { vi.advanceTimersByTime(20_000); });
  await waitFor(() => expect(gitBranchStatus.mock.calls.length).toBeGreaterThan(1));
  expect(githubBranchPull).toHaveBeenCalledTimes(1);
  git.set("/work/a", status({ ahead: 0 }));
  await act(async () => { vi.advanceTimersByTime(11_000); });
  await waitFor(() => expect(githubBranchPull).toHaveBeenCalledTimes(2));
  await act(async () => { vi.advanceTimersByTime(PULL_TTL.selected + 1); });
  await waitFor(() => expect(githubBranchPull).toHaveBeenCalledTimes(3));
});

it("shows nothing outside a repository", async () => {
  render(<StatusBar />);
  await waitFor(() => expect(gitBranchStatus).toHaveBeenCalledWith("/work/a"));
  expect(document.querySelector(".statusbar-branch")).toBeNull();
});
