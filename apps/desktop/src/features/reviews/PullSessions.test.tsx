import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Session } from "../../gen";
import type { RpcClient } from "../../lib/rpc";
import { useStore } from "../../state/store";
import { useDetectedLinksStore, useLinkPreferencesStore } from "../../state/sessionLinkPreferences";
import { useGithubRepos } from "../../state/githubRepos";
import { resetPullSessions } from "../../state/pullSessions";
import { PullSessionCount, PullSessions } from "./PullSessions";
import { ReviewSidebar } from "./ReviewSidebar";
import { useReviews } from "./state";
import { inboxFixture, pullFixture } from "./fixtures";

vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear() } });
});

function session(id: string, patch: Partial<Session> = {}): Session {
  return { id, title: id, cwd: `/work/${id}`, provider: "claude", agent: null, status: "idle", mode: "structured", archived: false, pinned: false,
    pending_count: 0, last_activity: new Date().toISOString(), group: null, worktree: null, model: null, orchestrator: false, orchestrator_id: null, pulls: [], ...patch } as Session;
}

const getSetting = vi.fn();
const gitGithubRepo = vi.fn();
beforeEach(() => {
  getSetting.mockReset().mockImplementation(async (key: string) => key === "session.links.v1.linker" ? JSON.stringify({ prs: [pullFixture.url] }) : null);
  gitGithubRepo.mockReset().mockResolvedValue("acme/widget");
  useLinkPreferencesStore.setState({ entries: {} });
  useDetectedLinksStore.setState({ links: {} });
  useGithubRepos.setState({ repos: {} });
  resetPullSessions();
  useReviews.setState({ inbox: inboxFixture, error: null, hidden: false, collapsed: false, mineCollapsed: false, showHidden: false, busy: false, reviewId: null });
  useStore.setState({
    prSelection: pullFixture, selectedId: null, showArchived: false, connection: "open",
    client: { getSetting, gitGithubRepo, call: vi.fn().mockResolvedValue(inboxFixture), onNotification: () => () => {}, onState: () => () => {} } as unknown as RpcClient,
    sessions: {
      orch: session("orch", { title: "Release orchestrator", orchestrator: true, status: "running" }),
      worker: session("worker", { title: "Fix the empty response", orchestrator_id: "orch", provider: "codex", worktree: { repo_root: "/work/widget", path: "/work/worker", branch: "fix-empty" } }),
      linker: session("linker", { title: "Talk about the fix", agent: "gemini", provider: "acp" }),
      old: session("old", { title: "First attempt", archived: true, pulls: [pullFixture.url], status: "waiting_input" }),
      unrelated: session("unrelated", { title: "Something else", pulls: ["https://github.com/acme/widget/pull/41"] }),
    },
  });
});
afterEach(cleanup);

it("lists the PR's sessions with title, agent, status and activity, workers under their orchestrator", async () => {
  render(<PullSessions pull={pullFixture} />);
  const section = await screen.findByRole("region", { name: "Sessions" });
  await waitFor(() => expect(within(section).getAllByRole("button").map((b) => b.dataset.sessionId)).toEqual(["orch", "worker", "linker", "old"]));
  const worker = within(section).getByRole("button", { name: /Fix the empty response/ });
  expect(worker.className).toContain("worker");
  expect(worker.hasAttribute("data-hint")).toBe(true);
  expect(within(worker).getByText("codex")).toBeTruthy();
  expect(within(worker).getByText("branch")).toBeTruthy();
  expect(within(within(section).getByRole("button", { name: /Release orchestrator/ })).getByText("workers")).toBeTruthy();
  expect(within(within(section).getByRole("button", { name: /Talk about the fix/ })).getByText("linked")).toBeTruthy();
  const old = within(section).getByRole("button", { name: /First attempt/ });
  expect(within(old).getByText("archived")).toBeTruthy();
  expect(within(old).getByText("waiting input")).toBeTruthy();
  expect(within(section).queryByText("Something else")).toBeNull();
  // The archived session's links were read although the sidebar does not list it.
  expect(getSetting).toHaveBeenCalledWith("session.links.v1.old");
});

it("opens a session from the PR page, revealing archived ones", async () => {
  render(<PullSessions pull={pullFixture} />);
  fireEvent.click(await screen.findByRole("button", { name: /Release orchestrator/ }));
  expect(useStore.getState().selectedId).toBe("orch");
  expect(useStore.getState().prSelection).toBeNull();
  expect(useStore.getState().showArchived).toBe(false);
  useStore.setState({ prSelection: pullFixture });
  fireEvent.click(screen.getByRole("button", { name: /First attempt/ }));
  expect(useStore.getState().selectedId).toBe("old");
  expect(useStore.getState().showArchived).toBe(true);
});

it("shows nothing for a PR no session worked on", () => {
  useStore.setState({ connection: "closed" });
  const { container } = render(<><PullSessions pull={{ ...pullFixture, number: 7, head_ref: "other" }} /><PullSessionCount pull={{ ...pullFixture, number: 7, head_ref: "other" }} /></>);
  expect(container.textContent).toBe("");
});

it("counts the sessions on the PR's row in the list", async () => {
  render(<ReviewSidebar />);
  const chip = await screen.findByText("4 sessions");
  expect(chip.getAttribute("title")).toContain("First attempt (archived)");
});
