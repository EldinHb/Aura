import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BranchPull, BranchStatus, Session } from "../gen";
import type { RpcClient } from "../lib/rpc";
import { pullKey } from "./branchStatus";
import { flattenPullSessions, pullOfUrl, resetPullSessions, sessionsOfPull, useRecordBranchPull, workedOnBranch, type PullSessionSources } from "./pullSessions";
import { useStore } from "./store";

const pr = { repo: "owner/repo", number: 42, head_ref: "feature" };
const url = "https://github.com/owner/repo/pull/42";
const now = Date.parse("2026-10-15T12:00:00Z");

function session(id: string, patch: Partial<Session> = {}): Session {
  return { id, title: id, cwd: `/work/${id}`, provider: "claude", agent: null, status: "idle", mode: "structured", archived: false, pinned: false,
    pending_count: 0, last_activity: "2026-10-15T10:00:00Z", group: null, worktree: null, model: null, orchestrator: false, orchestrator_id: null, pulls: [], ...patch } as Session;
}

function sources(list: Session[], patch: Partial<PullSessionSources> = {}): PullSessionSources {
  return { sessions: Object.fromEntries(list.map((s) => [s.id, s])), preferences: {}, detected: {}, git: {}, branchPulls: {}, repos: {}, ...patch };
}

const ids = (list: ReturnType<typeof sessionsOfPull>) => list.map((e) => e.session.id);

it("reads pull request URLs from github.com and Enterprise hosts", () => {
  expect(pullOfUrl(url)).toEqual({ repo: "owner/repo", number: 42 });
  expect(pullOfUrl("https://git.example.com/team/app/pull/7/files")).toEqual({ repo: "team/app", number: 7 });
  expect(pullOfUrl("https://github.com/owner/repo/issues/42")).toBeNull();
});

it("lists sessions that link the PR: the chosen links, else the detected ones", () => {
  const list = [session("chosen"), session("detected"), session("overridden"), session("other")];
  const found = sessionsOfPull(pr, sources(list, {
    preferences: { chosen: { prs: ["https://github.com/Owner/Repo/pull/42"] }, overridden: { prs: [] } },
    detected: {
      detected: [{ url, kind: "PR", repo: "owner/repo", number: "42" }],
      overridden: [{ url, kind: "PR", repo: "owner/repo", number: "42" }],
      other: [{ url: "https://github.com/else/repo/pull/42", kind: "PR", repo: "else/repo", number: "42" }],
    },
  }));
  expect(ids(found).sort()).toEqual(["chosen", "detected"]);
  expect(found.every((e) => e.reasons.join() === "linked")).toBe(true);
});

it("lists sessions whose branch is or was the PR's head", () => {
  const list = [
    session("recorded", { pulls: ["https://github.com/OWNER/repo/pull/42"] }),
    session("checked-out"),
    session("worktree", { worktree: { repo_root: "/work/repo", path: "/work/worktree", branch: "feature" } }),
    session("same-branch-other-repo", { worktree: { repo_root: "/work/x", path: "/work/same-branch-other-repo", branch: "feature" } }),
    session("other-pull", { pulls: ["https://github.com/owner/repo/pull/43"] }),
  ];
  const git = { "/work/checked-out": { branch: "feature", upstream_branch: "feature", upstream_repo: null } as unknown as BranchStatus };
  const found = sessionsOfPull(pr, sources(list, {
    git,
    branchPulls: { [pullKey({ repo: "owner/repo", headRepo: "owner/repo", branch: "feature" })]: { pull: { repo: "owner/repo", number: 42 } as BranchPull } },
    repos: { "/work/checked-out": "owner/repo", "/work/worktree": "owner/repo", "/work/same-branch-other-repo": "else/repo" },
  }));
  expect(ids(found).sort()).toEqual(["checked-out", "recorded", "worktree"]);
  expect(found.every((e) => e.reasons.join() === "branch")).toBe(true);
});

it("shows workers under their orchestrator, and archived sessions last", () => {
  const list = [
    session("orch", { orchestrator: true, last_activity: "2026-10-15T09:00:00Z" }),
    session("w1", { orchestrator_id: "orch", pulls: [url], last_activity: "2026-10-15T08:00:00Z" }),
    session("w2", { orchestrator_id: "orch", pulls: [url], last_activity: "2026-10-15T11:00:00Z" }),
    session("old", { archived: true, pulls: [url], last_activity: "2026-10-15T11:30:00Z" }),
    session("solo", { pulls: [url] }),
  ];
  const found = sessionsOfPull(pr, sources(list, { preferences: { solo: { prs: [url] } } }));
  expect(ids(found)).toEqual(["solo", "orch", "old"]);
  const orch = found[1];
  expect(orch.reasons).toEqual([]);
  expect(ids(orch.workers)).toEqual(["w2", "w1"]);
  expect(found[0].reasons).toEqual(["linked", "branch"]);
  expect(flattenPullSessions(found).map((e) => e.session.id)).toEqual(["solo", "orch", "w2", "w1", "old"]);
  expect(sessionsOfPull({ ...pr, number: 1 }, sources(list))).toEqual([]);
});

it("nests workers of workers under the top orchestrator, and survives a loop", () => {
  const list = [
    session("o1", { orchestrator: true }),
    session("w2", { orchestrator: true, orchestrator_id: "o1" }),
    session("w3", { orchestrator_id: "w2", pulls: [url] }),
    session("a", { orchestrator_id: "b", pulls: [url] }),
    session("b", { orchestrator_id: "a", pulls: [url] }),
  ];
  const found = sessionsOfPull(pr, sources(list));
  const o1 = found.find((e) => e.session.id === "o1")!;
  expect(ids(o1.workers)).toEqual(["w2"]);
  expect(ids(o1.workers[0].workers)).toEqual(["w3"]);
  expect(flattenPullSessions(found).map((e) => e.session.id).sort()).toEqual(["a", "b", "o1", "w2", "w3"]);
});

it("counts a plain checkout's branch only while its session is active", () => {
  expect(workedOnBranch(session("w", { worktree: { repo_root: "/r", path: "/w", branch: "b" }, last_activity: "2026-01-01T00:00:00Z" }), now)).toBe(true);
  expect(workedOnBranch(session("r", { status: "running", last_activity: "2026-01-01T00:00:00Z" }), now)).toBe(true);
  expect(workedOnBranch(session("recent", { last_activity: "2026-10-15T11:55:00Z" }), now)).toBe(true);
  expect(workedOnBranch(session("idle", { last_activity: "2026-10-15T10:00:00Z" }), now)).toBe(false);
});

const recordSessionPull = vi.fn();
beforeEach(() => {
  resetPullSessions();
  recordSessionPull.mockReset().mockResolvedValue(null);
  useStore.setState({ client: { recordSessionPull } as unknown as RpcClient });
});
afterEach(cleanup);

it("records the branch's PR on the session once", () => {
  const pull = { repo: "owner/repo", number: 42, url } as BranchPull;
  const worker = session("w", { worktree: { repo_root: "/r", path: "/w", branch: "feature" } });
  const { rerender } = renderHook(({ s }) => useRecordBranchPull(s, pull), { initialProps: { s: worker } });
  rerender({ s: { ...worker, title: "renamed" } });
  expect(recordSessionPull).toHaveBeenCalledTimes(1);
  expect(recordSessionPull).toHaveBeenCalledWith("w", url);
  renderHook(() => useRecordBranchPull(session("known", { worktree: worker.worktree, pulls: [url] }), pull));
  renderHook(() => useRecordBranchPull(session("idle", { last_activity: "2020-01-01T00:00:00Z" }), pull));
  renderHook(() => useRecordBranchPull(session("none", { status: "running" }), null));
  expect(recordSessionPull).toHaveBeenCalledTimes(1);
});
