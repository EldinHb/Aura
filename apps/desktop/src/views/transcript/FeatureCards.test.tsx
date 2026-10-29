import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Feature, Item, Project, Session, SpecialistSuggestion, UserQuestion } from "../../gen";
import type { RpcClient } from "../../lib/rpc";
import { useStore } from "../../state/store";
import { setFeature, setRoleSuggestions, useFeatures } from "../../state/features";
import { useWorkerThreads } from "../../state/workerThreads";
import { ItemRow } from "./ItemRow";

const answerQuestion = vi.fn(async () => feature);
const resolveSuggestion = vi.fn(async () => feature);
const resolveRoleSuggestion = vi.fn(async () => ({}) as SpecialistSuggestion);
const projects = vi.fn(async (): Promise<Project[]> => [{ path: "/repo", repo: true, groups: [], sessions: 1, last_used: "" }]);
let feature: Feature;

const question = (patch: Partial<UserQuestion> = {}): UserQuestion => ({
  id: "q1",
  question: "Which layout?",
  context: "Tabs scale better.",
  options: [{ label: "Tabs", description: "More room" }, { label: "List", description: null }],
  recommended: "Tabs",
  kind: "decision",
  checkpoint: null,
  asked_at: "2026-10-01T00:00:00Z",
  answer: null,
  withdrawn: false,
  ...patch,
});

const card = (kind: string, id: string): Item => ({ id: `card-${id}`, session_id: "owner", turn_id: "t", kind: "system", status: "completed", title: null, text: "fallback", data: { feature_card: { kind, id } }, parent_id: null, started_at: "", ended_at: null });

const row = (it: Item) => render(<ItemRow item={it} cursor={false} expanded={undefined} onToggle={() => {}} onCursor={() => {}} showReasoning={false} />);

beforeEach(() => {
  vi.clearAllMocks();
  feature = {
    owner_id: "owner",
    goal: "Dark mode",
    status: "waiting_on_user",
    autonomy: null,
    meeting_mode: null,
    team: [],
    decisions: [],
    questions: [question()],
    checkpoints: [],
    meetings: [],
    one_on_ones: [],
    suggestions: [
      {
        id: "s1",
        specialist: { id: "data-engineer", name: "Data engineer", role: "Builds pipelines", description: "ETL", instructions: "Build **pipelines**.", agent: null, model: null, effort: null, scope: "global", project: null },
        reason: "We keep needing ETL",
        status: "pending",
        accepted_id: null,
        created_at: "",
        resolved_at: null,
        delivered: false,
        evidence: [],
        owner_id: null,
      },
    ],
    report: { what: "- Added a toggle", why: "Users asked", how_to_test: "Open settings", where_to_test: "branch `dark`", notes: "", delivered_at: "2026-10-02T00:00:00Z" },
    created_at: "",
    updated_at: "",
    counters: {},
  };
  useFeatures.setState({ features: {} });
  setFeature(feature);
  useStore.setState({
    sessions: { owner: { id: "owner", cwd: "/repo/sub", folderless: false } as Session },
    client: { answerQuestion, resolveSuggestion, resolveRoleSuggestion, projects } as unknown as RpcClient,
  });
});
afterEach(cleanup);

it("puts a decision to the user with the recommended option marked and sends the answer", async () => {
  row(card("decision", "q1"));
  expect(screen.getByText("Which layout?")).toBeTruthy();
  expect(screen.getByText("Tabs scale better.")).toBeTruthy();
  expect(screen.getByText("recommended").closest("button")!.textContent).toContain("Tabs");
  const answer = screen.getByRole("button", { name: /Answer/ }) as HTMLButtonElement;
  expect(answer.disabled).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: /List/ }));
  fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: "keep it small" } });
  fireEvent.click(answer);
  await waitFor(() => expect(answerQuestion).toHaveBeenCalledWith("owner", "q1", "List", "keep it small"));
});

it("answers in the user's own words with Enter", async () => {
  row(card("decision", "q1"));
  const field = screen.getByLabelText("Your answer");
  fireEvent.change(field, { target: { value: "Neither, use a grid" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => expect(answerQuestion).toHaveBeenCalledWith("owner", "q1", null, "Neither, use a grid"));
});

it("shows the answer once given, and a checkpoint review as one", () => {
  feature = { ...feature, questions: [question({ kind: "checkpoint", checkpoint: "after_design", answer: { option: "Approve", text: "nice", at: "", delivered: true } })] };
  setFeature(feature);
  row(card("decision", "q1"));
  expect(screen.getByText("Checkpoint review · after design")).toBeTruthy();
  expect(screen.getByText("Approve")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Answer/ })).toBeNull();
  expect(screen.getByText("answered")).toBeTruthy();
});

it("shows the delivery report: what, why, how and where to test", () => {
  row(card("report", "report"));
  expect(screen.getByText("Feature delivered")).toBeTruthy();
  for (const label of ["What was done", "Why", "How to test", "Where to test"]) expect(screen.getByText(label)).toBeTruthy();
  expect(screen.queryByText("Notes")).toBeNull();
  expect(screen.getByText("Added a toggle")).toBeTruthy();
});

it("accepts a proposed specialist for the owner's project, as edited", async () => {
  row(card("suggestion", "s1"));
  expect(screen.getByText("New specialist proposed: Data engineer")).toBeTruthy();
  const scope = screen.getByLabelText("Where the specialist applies") as HTMLSelectElement;
  await waitFor(() => expect(scope.value).toBe("/repo"));
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Role"), { target: { value: "Builds and tests pipelines" } });
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  await waitFor(() =>
    expect(resolveSuggestion).toHaveBeenCalledWith("owner", "s1", true, expect.objectContaining({ id: "data-engineer", role: "Builds and tests pipelines", scope: "project", project: "/repo" })),
  );
});

it("accepts a specialist for every project or dismisses it", async () => {
  row(card("suggestion", "s1"));
  const scope = screen.getByLabelText("Where the specialist applies") as HTMLSelectElement;
  await waitFor(() => expect(scope.value).toBe("/repo"));
  fireEvent.change(scope, { target: { value: "global" } });
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  await waitFor(() => expect(resolveSuggestion).toHaveBeenLastCalledWith("owner", "s1", true, expect.objectContaining({ role: "Builds pipelines", scope: "global", project: null })));
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(resolveSuggestion).toHaveBeenLastCalledWith("owner", "s1", false, null));
});

it("shows a resolved suggestion without its buttons", () => {
  feature = { ...feature, suggestions: [{ ...feature.suggestions[0], status: "accepted", accepted_id: "data-engineer" }] };
  setFeature(feature);
  row(card("suggestion", "s1"));
  expect(screen.getByText("accepted as data-engineer")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
});

it("says on a checkpoint review that words of the user's own ask for changes", async () => {
  feature = { ...feature, questions: [question({ kind: "checkpoint", checkpoint: "before_delivery", options: [{ label: "Approve", description: null }, { label: "Request changes", description: null }], recommended: null })] };
  setFeature(feature);
  row(card("decision", "q1"));
  expect((screen.getByLabelText("Your answer") as HTMLInputElement).placeholder).toMatch(/what to change/);
  fireEvent.click(screen.getByRole("radio", { name: /Approve/ }));
  fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: "nice" } });
  fireEvent.click(screen.getByRole("button", { name: /Answer/ }));
  await waitFor(() => expect(answerQuestion).toHaveBeenCalledWith("owner", "q1", "Approve", "nice"));
});

it("points to a meeting in one line, which opens the Team tab on it", () => {
  feature = {
    ...feature,
    meetings: [{
      id: "m1", topic: "Default theme", agenda: "System or dark?", context: "",
      attendees: [{ worker_id: "ux", name: "UX designer", role: "", guest: false, status: "answered", answer: "System, which nobody should see in the chat.", missing: null, answered_at: "" }],
      status: "collecting", decision_ids: [], started_at: "", deadline: "", ended_at: null, delivered: false,
      mode: "written", round: 0, max_rounds: 0, turn_words: 0, turns: [], outcome: null, timeout_minutes: 0, left: [],
    }],
  };
  setFeature(feature);
  row(card("meeting", "m1"));
  expect(screen.getByText("Meeting: Default theme")).toBeTruthy();
  expect(screen.getByText("collecting · 1 of 1 answered")).toBeTruthy();
  expect(screen.queryByText(/nobody should see/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open in Team" }));
  expect(useWorkerThreads.getState().views.owner).toEqual({ tab: "team", meeting: "m1" });
  expect(useStore.getState().selectedId).toBe("owner");
  cleanup();
  setFeature({ ...feature, meetings: [{ ...feature.meetings[0], status: "complete" }] });
  row(card("meeting", "m1"));
  expect(screen.getByText("Meeting held: Default theme")).toBeTruthy();
  expect(screen.getByText("1 attendee")).toBeTruthy();
});

const found = (patch: Partial<SpecialistSuggestion> = {}): SpecialistSuggestion => ({
  id: "r1",
  specialist: { id: "migration-writer", name: "Migration writer", role: "Writes database migrations", description: "", instructions: "Write reversible migrations.", agent: null, model: null, effort: null, scope: "project", project: "/repo" },
  reason: "Feature owners started 2 ad-hoc workers for this role in 2 features.",
  status: "pending",
  accepted_id: null,
  created_at: "",
  resolved_at: null,
  delivered: true,
  evidence: [
    { owner_id: "owner", worker_id: "w1", feature: "Orders export", title: "Migration writer", summary: "Migration writer: Write the SQL migrations for orders", project: "/repo" },
    { owner_id: "other", worker_id: "w2", feature: "Invoices", title: "Migration writer", summary: "Migration writer: Write SQL migrations for invoices", project: "/repo" },
  ],
  owner_id: "owner",
  ...patch,
});

it("shows a specialist found in repeated work with its briefs, for the project they come from", async () => {
  setRoleSuggestions([found()]);
  row(card("role_suggestion", "r1"));
  expect(screen.getByText("Specialist suggested from repeated work: Migration writer")).toBeTruthy();
  expect(screen.getByText("found by Aura")).toBeTruthy();
  expect(screen.getByText("Seen in 2 ad-hoc briefs")).toBeTruthy();
  expect(screen.getByText("Migration writer: Write SQL migrations for invoices")).toBeTruthy();
  // Suggested for the project both briefs come from.
  await waitFor(() => expect((screen.getByLabelText("Where the specialist applies") as HTMLSelectElement).value).toBe("/repo"));
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  await waitFor(() => expect(resolveRoleSuggestion).toHaveBeenCalledWith("r1", true, expect.objectContaining({ id: "migration-writer", scope: "project", project: "/repo" })));
  expect(resolveSuggestion).not.toHaveBeenCalled();
});

it("shows a resolved found specialist without buttons, and dismisses a pending one", async () => {
  setRoleSuggestions([found({ status: "dismissed" })]);
  const { unmount } = row(card("role_suggestion", "r1"));
  expect(screen.getByText("dismissed")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  unmount();
  setRoleSuggestions([found()]);
  row(card("role_suggestion", "r1"));
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(resolveRoleSuggestion).toHaveBeenCalledWith("r1", false, null));
});

it("points to a live meeting in one line with its round and speaker", () => {
  feature = {
    ...feature,
    meetings: [{
      id: "m2", topic: "Toggle", agenda: "Where?", context: "",
      attendees: [{ worker_id: "ux", name: "UX designer", role: "", guest: false, status: "asked", answer: null, missing: null, answered_at: null }],
      status: "collecting", decision_ids: [], started_at: "", deadline: "", ended_at: null, delivered: false,
      mode: "live", round: 1, max_rounds: 2, turn_words: 150, outcome: null, timeout_minutes: 20, left: [],
      turns: [{ round: 1, worker_id: "ux", name: "UX designer", role: "", chair: false, status: "asked", text: null, missing: null, at: null }],
    }],
  };
  setFeature(feature);
  const { unmount } = row(card("meeting", "m2"));
  expect(screen.getByText("Live meeting: Toggle")).toBeTruthy();
  expect(screen.getByText("round 1 of 2 · UX designer speaking")).toBeTruthy();
  unmount();
  setFeature({ ...feature, meetings: [{ ...feature.meetings[0], status: "waiting_on_chair" }] });
  row(card("meeting", "m2"));
  expect(screen.getByText("Live meeting: Toggle")).toBeTruthy();
  expect(screen.getByText("round 1 of 2 over · waiting on the owner")).toBeTruthy();
});
