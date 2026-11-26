// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "../test/rtl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useStore } from "../host";
import { installFakeCtx, type FakeCtx } from "../test/ctx";
import { resetStores } from "../test/reset";
import { PullSessionCount, PullSessions } from "./PullSessions";
import { ReviewSidebar } from "./ReviewSidebar";
import { sessionsOfPull, type Session } from "./sessions";
import { useReviews } from "./state";
import { inboxFixture, pullFixture } from "./fixtures";

vi.mock("../host", () => import("../test/host"));
vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear() } });
});

// The list sorts by activity, so each session gets its own time from one reading of the clock.
const NOW = Date.now();
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

function session(id: string, patch: Partial<Session> = {}): Session {
  return { id, title: id, cwd: `/work/${id}`, provider: "claude", agent: null, status: "idle", mode: "structured", archived: false, pinned: false,
    pending_count: 0, last_activity: minutesAgo(0), group: null, worktree: null, model: null, orchestrator: false, orchestrator_id: null, pulls: [], ...patch } as Session;
}

let fake: FakeCtx;
beforeEach(() => {
  resetStores();
  fake = installFakeCtx();
  // The github mod knows which sessions worked on the PR: a worker, one that links it, an archived one.
  fake.call.mockImplementation(async (mod: string, method: string, params: any) =>
    mod === "github" && method === "pulls.sessions" && params.url === pullFixture.url ? ["worker", "linker", "old"] : []);
  fake.rpc.mockResolvedValue(inboxFixture);
  useReviews.setState({ inbox: inboxFixture });
  useStore.setState({
    selectedId: null, showArchived: false, connection: "open",
    sessions: {
      orch: session("orch", { title: "Release orchestrator", orchestrator: true, status: "running", last_activity: minutesAgo(1) }),
      worker: session("worker", { title: "Fix the empty response", orchestrator_id: "orch", provider: "codex", worktree: { repo_root: "/work/widget", path: "/work/worker", branch: "fix-empty" } as Session["worktree"], last_activity: minutesAgo(2) }),
      linker: session("linker", { title: "Talk about the fix", agent: "gemini", provider: "acp" as Session["provider"], last_activity: minutesAgo(3) }),
      // Archived: listed last although it was active most recently.
      old: session("old", { title: "First attempt", archived: true, status: "waiting_input", last_activity: minutesAgo(0) }),
      unrelated: session("unrelated", { title: "Something else", last_activity: minutesAgo(4) }),
    },
  });
});
afterEach(cleanup);

it("lists the PR's sessions with title, agent, status and activity, workers under their orchestrator", async () => {
  render(<PullSessions pull={pullFixture} />);
  const section = await screen.findByRole("region", { name: "Sessions" });
  await waitFor(() => expect(within(section).getAllByRole("button").map((b) => b.dataset.sessionId)).toEqual(["orch", "worker", "linker", "old"]));
  expect(fake.call).toHaveBeenCalledWith("github", "pulls.sessions", { url: pullFixture.url });
  const worker = within(section).getByRole("button", { name: /Fix the empty response/ });
  expect(worker.className).toContain("worker");
  expect(worker.hasAttribute("data-hint")).toBe(true);
  expect(within(worker).getByText("codex")).toBeTruthy();
  expect(within(within(section).getByRole("button", { name: /Release orchestrator/ })).getByText("workers")).toBeTruthy();
  expect(within(within(section).getByRole("button", { name: /Talk about the fix/ })).getByText("gemini")).toBeTruthy();
  const old = within(section).getByRole("button", { name: /First attempt/ });
  expect(within(old).getByText("archived")).toBeTruthy();
  expect(within(old).getByText("waiting input")).toBeTruthy();
  expect(within(section).queryByText("Something else")).toBeNull();
});

it("opens a session from the PR page, revealing archived ones", async () => {
  render(<PullSessions pull={pullFixture} />);
  fireEvent.click(await screen.findByRole("button", { name: /Release orchestrator/ }));
  expect(useStore.getState().selectedId).toBe("orch");
  expect(useStore.getState().showArchived).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: /First attempt/ }));
  expect(useStore.getState().selectedId).toBe("old");
  expect(useStore.getState().showArchived).toBe(true);
});

it("shows nothing for a PR no session worked on", async () => {
  const other = { ...pullFixture, number: 7, url: "https://github.com/acme/widget/pull/7" };
  const { container } = render(<><PullSessions pull={other} /><PullSessionCount pull={other} /></>);
  await waitFor(() => expect(fake.call).toHaveBeenCalledWith("github", "pulls.sessions", { url: other.url }));
  expect(container.textContent).toBe("");
});

it("asks again when sessions come or go, and lists none without the github mod", async () => {
  fake.call.mockRejectedValue(new Error("mod github is not running"));
  const { container } = render(<PullSessions pull={pullFixture} />);
  await waitFor(() => expect(fake.call).toHaveBeenCalledTimes(1));
  expect(container.textContent).toBe("");
  fake.call.mockResolvedValue(["linker"]);
  useStore.setState((s) => ({ sessions: { ...s.sessions, fresh: session("fresh") } }));
  expect(await screen.findByRole("button", { name: /Talk about the fix/ })).toBeTruthy();
  expect(fake.call).toHaveBeenCalledTimes(2);
});

it("counts the sessions on the PR's row in the list", async () => {
  render(<ReviewSidebar />);
  const chip = await screen.findByText("4 sessions");
  expect(chip.getAttribute("title")).toContain("First attempt (archived)");
});

it("never hangs on orchestrators that loop", () => {
  const sessions = { a: session("a", { orchestrator_id: "b" }), b: session("b", { orchestrator_id: "a" }) };
  expect(sessionsOfPull(["a"], sessions).map((e) => e.session.id)).toEqual(["a"]);
});
