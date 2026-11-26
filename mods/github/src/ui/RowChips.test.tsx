// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchStatus, Session } from "@aura/mod-sdk";
import type { BranchPull } from "@aura/github-client";
import { daemonCtx } from "../test/ctx";
import { emptyTranscript, useStore } from "../test/host";
import { BranchDecoration } from "./BranchPull";
import { PULL_TTL, resetBranches } from "./branch";
import { resetLinks, startDetectedLinksSync, useDetectedLinksStore, useLinkPreferencesStore } from "./links";
import { resetGithubRepos } from "./repos";
import { RowChips } from "./RowChips";

const issue = "https://github.com/owner/repo/issues/7";
const pr = "https://github.com/owner/repo/pull/42";
const git = new Map<string, BranchStatus | null>();
let pullResult: BranchPull | Omit<BranchPull, "reviews"> | null = null;
const branchPull = vi.fn(async (_params: unknown) => pullResult);
const repoOf = vi.fn(async ({ cwd }: { cwd: string }) => (cwd === "/work/a" ? "owner/repo" : null));
const gitBranchStatus = vi.fn(async (cwd: string) => git.get(cwd) ?? null);
let d: ReturnType<typeof daemonCtx>;

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
const message = (text: string, kind = "agent_message") =>
  ({ ...emptyTranscript(), loaded: true, items: { m: { id: "m", session_id: "a", turn_id: null, kind, status: "completed", title: null, text, data: {}, parent_id: null, started_at: "2026-09-30T00:00:00Z", ended_at: null } }, order: ["m"] });

function Rows() {
  const sessions = useStore((s) => s.sessions) as Record<string, Session>;
  const selected = useStore((s) => s.selectedId);
  return <>{Object.values(sessions).map((s) => <div key={s.id} className="session-row" data-session-id={s.id}><RowChips session={s} selected={s.id === selected} /></div>)}</>;
}
const rowLinks = (id: string) => [...document.querySelectorAll(`[data-session-id="${id}"] .session-row-link`)].map((el) => el.textContent);

beforeEach(() => {
  resetBranches();
  resetLinks();
  resetGithubRepos();
  git.clear();
  pullResult = null;
  branchPull.mockClear();
  repoOf.mockClear();
  gitBranchStatus.mockClear();
  d = daemonCtx(
    (name, params) => (name === "branch_pull" ? branchPull(params) : name === "repo" ? repoOf(params) : undefined),
    (method, params) => (method === "git.branch_status" ? gitBranchStatus(params.cwd) : null),
  );
  const sessions = { a: session("a", "Hours page"), b: session("b", "Other") };
  d.host.state.sessions = Object.values(sessions);
  useStore.setState({ connection: "open", sessions, transcripts: {}, selectedId: "a" });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("shows links detected in an opened session and saved selections for unopened ones", async () => {
  await d.host.api.sessions.data("b").set("links", { issue });
  useStore.setState({ transcripts: { a: message(`Created PR: ${pr}`) } });
  render(<Rows />);
  await waitFor(() => expect(rowLinks("b")).toEqual(["Issue #7"]));
  expect(rowLinks("a")).toEqual(["PR #42"]);
  expect(screen.getByTitle(pr)).toBeTruthy();
});

it("saves detected links so the sidebar shows them before the session is opened again", async () => {
  useStore.setState({ transcripts: { a: message(`Created PR: ${pr}`) } });
  const stop = startDetectedLinksSync();
  await waitFor(() => expect(d.host.sessionData.get("a")?.get("detected")).toEqual([pr]));
  stop();
  resetLinks();
  useStore.setState({ transcripts: {} });
  render(<Rows />);
  await waitFor(() => expect(rowLinks("a")).toEqual(["PR #42"]));
  expect(rowLinks("b")).toEqual([]);
});

it("prefers None over a saved detected link", async () => {
  await d.host.api.sessions.data("a").set("detected", [pr]);
  await d.host.api.sessions.data("a").set("links", { pr: null });
  render(<Rows />);
  await waitFor(() => expect(useLinkPreferencesStore.getState().entries.a).toBeTruthy());
  expect(useDetectedLinksStore.getState().links.a).toHaveLength(1);
  expect(rowLinks("a")).toEqual([]);
});

it("links the issue number the user asked the agent to work on, using the session's GitHub repository", async () => {
  useStore.setState({ transcripts: { a: message("Please work on issue #7", "user_message") } });
  render(<Rows />);
  await waitFor(() => expect(rowLinks("a")).toEqual(["Issue #7"]));
  expect(screen.getByTitle(issue)).toBeTruthy();
});

it("shows the branch's pull request status in its row in place of the same linked PR", async () => {
  git.set("/work/a", status());
  pullResult = pull();
  useStore.setState({ transcripts: { a: message(`Created PR: ${pr}`) } });
  render(<Rows />);
  await waitFor(() => expect(rowLinks("a")).toEqual(["PR #42 ✓ approved"]));
  expect(branchPull).toHaveBeenCalledWith({ repo: "owner/repo", head_repo: "owner/repo", branch: "feature" });
  expect(document.querySelector(".branch-pull")?.getAttribute("title")).toBe("owner/repo#42 · open · checks pass · approved\nAdd hours page");
  // Session b has no GitHub repository, so its pull request is never asked for.
  expect(branchPull).toHaveBeenCalledTimes(1);
});

it("looks for the pull request under the tracked branch of a fork", async () => {
  git.set("/work/a", status({ branch: "local-name", upstream: "fork/feat", upstream_branch: "feat", upstream_repo: "me/repo" }));
  render(<Rows />);
  await waitFor(() => expect(branchPull).toHaveBeenCalledWith({ repo: "owner/repo", head_repo: "me/repo", branch: "feat" }));
});

it("shows merged and draft pull requests", async () => {
  git.set("/work/a", status());
  pullResult = pull({ state: "merged" });
  const { unmount } = render(<Rows />);
  await waitFor(() => expect(rowLinks("a")).toEqual(["PR #42 merged"]));
  unmount();
  resetBranches();
  pullResult = pull({ draft: true, checks: "PENDING", review_decision: "REVIEW_REQUIRED" });
  render(<Rows />);
  await waitFor(() => expect(rowLinks("a")).toEqual(["PR #42 draft …"]));
});

it("counts a comment-only review as reviewed in the row", async () => {
  git.set("/work/a", status());
  pullResult = pull({ review_decision: "REVIEW_REQUIRED", reviews: [{ bot: false, reviewer: "alice", state: "COMMENTED", submitted_at: "2026-10-05T10:00:00Z", commit_sha: "1234567890abcdef" }] });
  render(<Rows />);
  await waitFor(() => expect(rowLinks("a")).toEqual(["PR #42 ✓ commented"]));
});

it("marks new commits since the latest review, which a bot's review does not count as", async () => {
  git.set("/work/a", status());
  pullResult = pull({ review_decision: "REVIEW_REQUIRED", reviews: [
    { bot: false, reviewer: "alice", state: "COMMENTED", submitted_at: "2026-10-05T10:00:00Z", commit_sha: "old" },
    { bot: true, reviewer: "copilot", state: "COMMENTED", submitted_at: "2026-10-06T10:00:00Z", commit_sha: "1234567890abcdef" },
  ] });
  render(<Rows />);
  await waitFor(() => expect(rowLinks("a")).toEqual(["PR #42 ✓ commented ↻"]));
  expect(document.querySelector(".branch-pull")?.getAttribute("title")).toContain("new commits since the latest review");
});

it("shows a pull request from a daemon older than its reviews", async () => {
  git.set("/work/a", status());
  const { reviews: _, ...old } = pull({ review_decision: "REVIEW_REQUIRED" });
  pullResult = old;
  render(<Rows />);
  await waitFor(() => expect(rowLinks("a")).toEqual(["PR #42 ✓"]));
});

it("records the branch's PR on the session once, while it works on the branch", async () => {
  const worker = session("a", "Hours page", { worktree: { repo_root: "/work", path: "/work/a", branch: "feature" } });
  d.host.state.sessions = [worker, session("b", "Other")];
  useStore.setState({ sessions: { a: worker, b: session("b", "Other", { cwd: "/work/a" }) } });
  git.set("/work/a", status());
  pullResult = pull();
  const { rerender } = render(<Rows />);
  await waitFor(() => expect(d.host.sessionData.get("a")?.get("pulls")).toEqual([pr]));
  rerender(<Rows />);
  await act(async () => {});
  expect(d.rpc.mock.calls.filter(([name]) => name === "pulls.record")).toHaveLength(1);
  // An idle plain checkout did not work on the branch it has now.
  expect(d.host.sessionData.get("b")?.get("pulls")).toBeUndefined();
});

it("shows only whole link chips that fit, then +N with the rest in its tooltip, and adapts as the sidebar resizes", async () => {
  const urls = [7, 8, 9, 10].map((n) => `https://github.com/owner/repo/issues/${n}`);
  await d.host.api.sessions.data("a").set("detected", urls);
  // jsdom lays nothing out: chips are 60px wide, "+N" 24px, and the line as wide as `room`.
  let room = 150;
  let resized = () => {};
  vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { resized = cb; } observe() {} disconnect() {} });
  const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("link-slot") ? 60 : this.classList.contains("links-more") ? 24 : 0;
  });
  const client = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("links") ? room : 0;
  });
  try {
    render(<Rows />);
    const shown = () => [...document.querySelectorAll('[data-session-id="a"] .link-slot:not(.overflow)')].map((el) => el.textContent);
    const more = () => document.querySelector<HTMLElement>('[data-session-id="a"] .links-more')!;
    // 60 + 60 + "+2" fits in 150; a third chip with "+1" does not.
    await waitFor(() => expect(shown()).toEqual(["Issue #7", "Issue #8"]));
    expect(more().textContent).toBe("+2");
    expect(more().classList.contains("overflow")).toBe(false);
    expect(more().title).toBe(`${urls[2]}\n${urls[3]}`);
    room = 240;
    act(() => resized());
    expect(shown()).toEqual(["Issue #7", "Issue #8", "Issue #9", "Issue #10"]);
    expect(more().classList.contains("overflow")).toBe(true);
    // Too narrow for any chip: only the count.
    room = 30;
    act(() => resized());
    expect(shown()).toEqual([]);
    expect(more().textContent).toBe("+4");
  } finally {
    width.mockRestore();
    client.mockRestore();
    vi.unstubAllGlobals();
  }
});

describe("the branch decoration", () => {
  const a = () => useStore.getState().sessions.a as Session;

  it("shows the pull request of the branch core reports, as a link", async () => {
    pullResult = pull({ checks: "FAILURE", review_decision: "CHANGES_REQUESTED" });
    render(<BranchDecoration cwd="/work/a" status={status({ ahead: 1 })} place="statusbar" session={a()} />);
    await waitFor(() => expect(document.querySelector(".statusbar-pull")?.textContent).toBe("PR #42 · open · checks fail · changes requested"));
    expect(screen.getByRole("link").getAttribute("href")).toBe(pr);
    expect(gitBranchStatus, "core's status is used as it is").not.toHaveBeenCalled();
  });

  it("reads the pull request again after a push, but not on every render", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    pullResult = pull();
    const { rerender } = render(<BranchDecoration cwd="/work/a" status={status({ ahead: 1 })} place="statusbar" session={a()} />);
    await waitFor(() => expect(branchPull).toHaveBeenCalledTimes(1));
    rerender(<BranchDecoration cwd="/work/a" status={status({ ahead: 1 })} place="statusbar" session={a()} />);
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(branchPull).toHaveBeenCalledTimes(1);
    rerender(<BranchDecoration cwd="/work/a" status={status({ ahead: 0 })} place="statusbar" session={a()} />);
    await waitFor(() => expect(branchPull).toHaveBeenCalledTimes(2));
    await act(async () => { vi.advanceTimersByTime(PULL_TTL.selected + 1); });
    await waitFor(() => expect(branchPull).toHaveBeenCalledTimes(3));
  });

  it("shows nothing outside a GitHub repository, and nothing in a row", async () => {
    pullResult = pull();
    render(<BranchDecoration cwd="/work/b" status={status()} place="statusbar" session={null} />);
    await waitFor(() => expect(repoOf).toHaveBeenCalledWith({ cwd: "/work/b" }));
    expect(branchPull).not.toHaveBeenCalled();
    cleanup();
    render(<BranchDecoration cwd="/work/a" status={status()} place="row" session={a()} />);
    await waitFor(() => expect(branchPull).toHaveBeenCalled());
    expect(document.querySelector(".statusbar-pull")).toBeNull();
  });
});
