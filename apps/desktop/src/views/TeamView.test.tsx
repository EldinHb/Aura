import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Feature, Meeting, Session } from "../gen";
import { useStore } from "../state/store";
import { setFeature, useFeatures } from "../state/features";
import { closeWorkerThreads, openTeam, reloadWorkerThreads, useWorkerThreads } from "../state/workerThreads";
import { OrchestratorTabs } from "./WorkerThreads";
import { TeamView } from "./TeamView";

const session = (id: string, patch: Partial<Session> = {}): Session =>
  ({ id, title: id, cwd: "/work", provider: "claude", status: "idle", mode: "structured", archived: false, created_at: "2026-10-29T00:00:00Z", model: "opus", effort: "high", orchestrator: false, orchestrator_id: "owner", feature_owner: false, pulls: [], ...patch }) as Session;

const meeting = (patch: Partial<Meeting> = {}): Meeting => ({
  id: "m1",
  topic: "Default theme",
  agenda: "System or dark first?",
  context: "",
  attendees: [
    { worker_id: "ux", name: "UX designer", role: "Designs flows", guest: false, status: "answered", answer: "Follow the system.", missing: null, answered_at: "" },
    { worker_id: "qa", name: "Tester", role: "", guest: true, status: "missing", answer: null, missing: "its agent stopped: crashed", answered_at: null },
  ],
  status: "incomplete",
  decision_ids: ["d1"],
  started_at: "",
  deadline: "",
  ended_at: "",
  delivered: true,
  ...patch,
});

const feature = (patch: Partial<Feature> = {}): Feature => ({
  owner_id: "owner",
  goal: "Dark mode for the settings",
  status: "in_progress",
  autonomy: { level: "autonomous", checkpoints: [] },
  team: [
    { worker_id: "ux", specialist_id: "ux-designer", name: "UX designer", role: "Designs flows", instructions: "", hired_at: "", meeting: null },
    { worker_id: "qa", specialist_id: "tester", name: "Tester", role: "", instructions: "", hired_at: "", meeting: "m1" },
    { worker_id: "gone", specialist_id: null, name: "Scout", role: "", instructions: "", hired_at: "", meeting: null },
  ],
  decisions: [{ id: "d1", decision: "Follow the system theme", rationale: "Design wants it", decided_by: "owner", question_id: null, meeting_id: "m1", at: "" }],
  questions: [],
  checkpoints: [],
  suggestions: [],
  meetings: [meeting()],
  one_on_ones: [
    { id: "a1", from_id: "qa", from_name: "Tester", to_id: "owner", to_name: "Owner", to_owner: true, question: "Is high contrast in scope?", answer: null, error: null, status: "open", asked_at: "", answered_at: null, sent: true, delivered: false },
    { id: "a2", from_id: "ux", from_name: "UX designer", to_id: "qa", to_name: "Tester", to_owner: false, question: "Which browsers?", answer: "Chrome and Safari.", error: null, status: "answered", asked_at: "", answered_at: "", sent: true, delivered: true },
  ],
  report: null,
  created_at: "",
  updated_at: "",
  counters: {},
  ...patch,
});

const saved = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => saved.set(k, v), removeItem: (k: string) => saved.delete(k), clear: () => saved.clear() } });

beforeEach(() => {
  localStorage.clear();
  reloadWorkerThreads();
  useFeatures.setState({ features: {} });
  const sessions = [session("owner", { title: "Owner", orchestrator: true, feature_owner: true, orchestrator_id: null }), session("ux", { title: "UX designer" }), session("qa", { title: "Tester", status: "running" }), session("lead", { orchestrator: true, orchestrator_id: null })];
  useStore.setState({ sessions: Object.fromEntries(sessions.map((s) => [s.id, s])), sessionOrder: sessions.map((s) => s.id), selectedId: "owner", providers: [], client: null });
});
afterEach(cleanup);

it("is a tab of feature owners only, opened by the user and remembered", () => {
  const { unmount } = render(<OrchestratorTabs orchestratorId="lead" />);
  expect(screen.queryByRole("tab", { name: "Team" })).toBeNull();
  unmount();
  render(<OrchestratorTabs orchestratorId="owner" />);
  const tab = screen.getByRole("tab", { name: "Team" });
  expect(tab.getAttribute("aria-selected")).toBe("false");
  expect(tab.getAttribute("data-command")).toBe("orchestrator.team");
  fireEvent.click(tab);
  expect(useWorkerThreads.getState().views.owner).toEqual({ tab: "team" });
  expect(screen.getByRole("tab", { name: "Team" }).getAttribute("aria-selected")).toBe("true");
  // Saved across restarts, like the Workers tab.
  reloadWorkerThreads();
  expect(useWorkerThreads.getState().views.owner.tab).toBe("team");
  closeWorkerThreads("owner");
  expect(useWorkerThreads.getState().views.owner.tab).toBe("chat");
});

it("opens on the meeting it was opened from", () => {
  openTeam("owner", "m1");
  expect(useWorkerThreads.getState().views.owner).toEqual({ tab: "team", meeting: "m1" });
  localStorage.setItem("aura.worker-threads.v1", JSON.stringify({ a: { tab: "team", meeting: 3 }, b: { tab: "nope" }, c: { tab: "team", meeting: "m2" } }));
  reloadWorkerThreads();
  expect(useWorkerThreads.getState().views).toEqual({ c: { tab: "team", meeting: "m2" } });
});

it("shows the feature, its members, meetings, one-on-ones and decisions", () => {
  setFeature(feature());
  const { container } = render(<TeamView ownerId="owner" />);
  expect(screen.getByText("Dark mode for the settings")).toBeTruthy();
  expect(screen.getByText(/autonomy: autonomous/)).toBeTruthy();

  // Members with their role, agent and status; the deleted one cannot be opened.
  const members = [...container.querySelectorAll<HTMLElement>(".team-member")];
  expect(members).toHaveLength(3);
  expect(within(members[0]).getByText(/Designs flows · Claude Code · opus · high|Designs flows · claude · opus · high/)).toBeTruthy();
  expect(within(members[1]).getByText("guest of m1")).toBeTruthy();
  expect(within(members[1]).getByText("working")).toBeTruthy();
  expect(within(members[2]).getByText("deleted")).toBeTruthy();
  expect(within(members[2]).queryByRole("button")).toBeNull();
  fireEvent.click(within(members[0]).getByRole("button", { name: /Open/ }));
  expect(useStore.getState().selectedId).toBe("ux");

  // The latest meeting is open: the question, every contribution and the outcome.
  expect(screen.getByText("held · 1 missing · UX designer, Tester")).toBeTruthy();
  expect(screen.getByText("System or dark first?")).toBeTruthy();
  expect(screen.getByText("Follow the system.")).toBeTruthy();
  expect(screen.getByText("its agent stopped: crashed")).toBeTruthy();
  expect(screen.getAllByText("Follow the system theme")).toHaveLength(2);

  // An open one-on-one shows its question; an answered one folds until opened.
  expect(screen.getByText("Tester → Owner (owner)")).toBeTruthy();
  expect(screen.queryByText("Chrome and Safari.")).toBeNull();
  fireEvent.click(screen.getByText("UX designer → Tester"));
  expect(screen.getByText("Chrome and Safari.")).toBeTruthy();

  // Decisions say who made them and what meeting they came out of.
  expect(screen.getByText("from m1")).toBeTruthy();
  expect(screen.getByText("owner")).toBeTruthy();
});

it("waits for the feature and leaves out what a feature has not had", () => {
  const { unmount } = render(<TeamView ownerId="owner" />);
  expect(screen.getByText("Loading the feature…")).toBeTruthy();
  unmount();
  // From a daemon that predates meetings.
  const old = feature({ team: [], decisions: [] }) as Partial<Feature>;
  delete old.meetings;
  delete old.one_on_ones;
  setFeature(old as Feature);
  render(<TeamView ownerId="owner" />);
  expect(screen.getByText(/Nobody yet/)).toBeTruthy();
  expect(screen.getByText("None recorded yet.")).toBeTruthy();
  expect(screen.queryByText(/Meetings/)).toBeNull();
  expect(screen.queryByText(/One-on-ones/)).toBeNull();
});
