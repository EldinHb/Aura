import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Feature, Project, Specialist, SpecialistInput, SpecialistSuggestion, SuggestionSettings } from "../../gen";
import type { RpcClient } from "../../lib/rpc";
import { useStore } from "../../state/store";
import { setRoleSuggestions, useFeatures } from "../../state/features";
import { SettingsDialog } from "./SettingsDialog";

const spec = (id: string, patch: Partial<Specialist> = {}): Specialist => ({
  id,
  name: id === "tester" ? "Tester (QA)" : id,
  role: `${id} role`,
  description: "",
  instructions: `Be a ${id}.`,
  agent: null,
  model: null,
  effort: null,
  scope: "global",
  project: null,
  built_in: true,
  customized: false,
  created_at: "",
  updated_at: "",
  ...patch,
});

let global: Specialist[];
let local: Specialist[];
const specialists = vi.fn(async (project: string | null = null) => (project ? local : global));
const hiddenSpecialists = vi.fn(async () => [spec("ux-designer", { name: "UX designer" })]);
const saveSpecialist = vi.fn(async (s: SpecialistInput) => spec(s.id, { ...s, built_in: false }));
const deleteSpecialist = vi.fn(async () => true);
const resetSpecialist = vi.fn(async (id: string) => spec(id));
const projects = vi.fn(async (): Promise<Project[]> => [{ path: "/repo", repo: true, groups: [], sessions: 2, last_used: "" }]);
let suggestionSettings: SuggestionSettings;
const setSuggestionSettings = vi.fn(async (x: SuggestionSettings) => (suggestionSettings = x));
const suggestSpecialists = vi.fn(async () => ({ suggestions: [], note: "No two ad-hoc workers' briefs look alike yet." }));
const resolveRoleSuggestion = vi.fn(async () => ({}) as SpecialistSuggestion);
const resolveSuggestion = vi.fn(async () => ({}) as Feature);
const toast = vi.fn();

const stored = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v), removeItem: (k: string) => stored.delete(k), clear: () => stored.clear() } });

beforeEach(() => {
  stored.clear();
  vi.clearAllMocks();
  global = [spec("tester"), spec("code-reviewer", { name: "Code reviewer", customized: true }), spec("writer", { name: "Writer", built_in: false })];
  local = [spec("tester", { scope: "project", project: "/repo", built_in: false, instructions: "Test our way." }), global[1], global[2]];
  suggestionSettings = { enabled: true, model: "haiku" };
  setRoleSuggestions([]);
  useFeatures.setState({ features: {} });
  useStore.setState({
    dialog: { kind: "none" },
    toast,
    client: { specialists, hiddenSpecialists, saveSpecialist, deleteSpecialist, resetSpecialist, projects, suggestionSettings: async () => suggestionSettings, setSuggestionSettings, suggestSpecialists, resolveRoleSuggestion, resolveSuggestion } as unknown as RpcClient,
  });
});
afterEach(cleanup);

const list = () => screen.getByRole("listbox", { name: "Specialists" });

it("lists the global specialists and edits one", async () => {
  render(<SettingsDialog tab="specialists" />);
  fireEvent.click(await within(list()).findByRole("option", { name: /Tester \(QA\)/ }));
  const instructions = screen.getByLabelText(/^Instructions/) as HTMLTextAreaElement;
  expect(instructions.value).toBe("Be a tester.");
  expect((screen.getByLabelText(/^Id/) as HTMLInputElement).readOnly).toBe(true);
  fireEvent.change(instructions, { target: { value: "Break it." } });
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "sonnet" } });
  fireEvent.keyDown(instructions, { key: "Enter", metaKey: true });
  await waitFor(() => expect(saveSpecialist).toHaveBeenCalledWith(expect.objectContaining({ id: "tester", instructions: "Break it.", model: "sonnet", scope: "global", project: null })));
});

it("makes a new specialist with an id from its name", async () => {
  render(<SettingsDialog tab="specialists" />);
  await within(list()).findByRole("option", { name: /Writer/ });
  fireEvent.click(screen.getByRole("button", { name: "New specialist" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Data engineer" } });
  expect((screen.getByLabelText(/^Id/) as HTMLInputElement).placeholder).toBe("data-engineer");
  const save = screen.getByRole("button", { name: /Save/ }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText(/^Instructions/), { target: { value: "Pipelines." } });
  fireEvent.click(save);
  await waitFor(() => expect(saveSpecialist).toHaveBeenCalledWith(expect.objectContaining({ id: "data-engineer", name: "Data engineer", instructions: "Pipelines." })));
});

it("resets an edited built-in, deletes after confirming and restores a deleted built-in", async () => {
  render(<SettingsDialog tab="specialists" />);
  fireEvent.click(await within(list()).findByRole("option", { name: /Code reviewer/ }));
  fireEvent.click(screen.getByRole("button", { name: "Reset to Aura's version" }));
  await waitFor(() => expect(resetSpecialist).toHaveBeenCalledWith("code-reviewer"));
  fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
  expect(screen.getByText("Delete it? Reset brings it back.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(deleteSpecialist).toHaveBeenCalledWith("code-reviewer", "global", null));
  fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
  await waitFor(() => expect(resetSpecialist).toHaveBeenLastCalledWith("ux-designer"));
});

it("shows a project's own specialists and saves a global one there as the project's copy", async () => {
  render(<SettingsDialog tab="specialists" />);
  await within(list()).findByRole("option", { name: /Writer/ });
  fireEvent.click(screen.getByRole("radio", { name: "Project" }));
  await waitFor(() => expect(specialists).toHaveBeenLastCalledWith("/repo"));
  const own = await within(list()).findByRole("option", { name: /Tester \(QA\)/ });
  expect(within(own).getByText("this project")).toBeTruthy();
  fireEvent.click(own);
  fireEvent.click(screen.getByRole("button", { name: "Delete this project's copy…" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(deleteSpecialist).toHaveBeenCalledWith("tester", "project", "/repo"));

  fireEvent.click(within(list()).getByRole("option", { name: /Writer/ }));
  expect(screen.getByText(/saving makes this project's own copy/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
  fireEvent.change(screen.getByLabelText(/^Instructions/), { target: { value: "Write for this repo." } });
  fireEvent.click(screen.getByRole("button", { name: /Save/ }));
  await waitFor(() => expect(saveSpecialist).toHaveBeenCalledWith(expect.objectContaining({ id: "writer", scope: "project", project: "/repo", instructions: "Write for this repo." })));
});

const suggestion = (id: string, patch: Partial<SpecialistSuggestion> = {}): SpecialistSuggestion => ({
  id,
  specialist: { id: "migration-writer", name: "Migration writer", role: "Writes migrations", description: "", instructions: "Write reversible migrations.", agent: null, model: null, effort: null, scope: "global", project: null },
  reason: "Feature owners started 2 ad-hoc workers for this role in 2 features.",
  status: "pending",
  accepted_id: null,
  created_at: "",
  resolved_at: null,
  delivered: true,
  evidence: [{ owner_id: "o", worker_id: "w", feature: "Orders", title: "Migrator", summary: "Migrator: Write SQL", project: "/repo" }],
  owner_id: null,
  ...patch,
});

it("gathers the specialists waiting for the user's word, found or proposed", async () => {
  setRoleSuggestions([suggestion("r1"), suggestion("r0", { status: "dismissed", specialist: { ...suggestion("r0").specialist, name: "Old idea" } })]);
  useFeatures.setState({
    features: {
      owner: { owner_id: "owner", suggestions: [{ ...suggestion("s1", { evidence: [] }), specialist: { ...suggestion("s1").specialist, id: "data-engineer", name: "Data engineer" } }] } as unknown as Feature,
    },
  });
  render(<SettingsDialog tab="specialists" />);
  const area = screen.getByRole("region", { name: "Suggestions" });
  expect(within(area).getByText("Specialist suggested from repeated work: Migration writer")).toBeTruthy();
  expect(within(area).getByText("New specialist proposed: Data engineer")).toBeTruthy();
  expect(within(area).getByText("Resolved (1)")).toBeTruthy();
  const [first, second] = within(area).getAllByRole("button", { name: "Accept" });
  fireEvent.click(first);
  await waitFor(() => expect(resolveRoleSuggestion).toHaveBeenCalledWith("r1", true, expect.objectContaining({ id: "migration-writer", scope: "global" })));
  fireEvent.click(second);
  await waitFor(() => expect(resolveSuggestion).toHaveBeenCalledWith("owner", "s1", true, expect.objectContaining({ id: "data-engineer" })));
  // The list of specialists is read again with the new one.
  await waitFor(() => expect(specialists.mock.calls.length).toBeGreaterThan(1));
});

it("looks for repeated roles on demand and can be switched off or given another model", async () => {
  render(<SettingsDialog tab="specialists" />);
  const area = screen.getByRole("region", { name: "Suggestions" });
  expect(within(area).getByText("No suggestions waiting.")).toBeTruthy();
  const run = await within(area).findByRole("button", { name: "Suggest specialists" });
  await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(run);
  await waitFor(() => expect(suggestSpecialists).toHaveBeenCalledWith(null));
  await waitFor(() => expect(toast).toHaveBeenCalledWith("No two ad-hoc workers' briefs look alike yet."));
  const model = within(area).getByLabelText("Suggestion model") as HTMLInputElement;
  expect(model.value).toBe("haiku");
  fireEvent.change(model, { target: { value: "sonnet" } });
  fireEvent.keyDown(model, { key: "Enter" });
  await waitFor(() => expect(setSuggestionSettings).toHaveBeenCalledWith({ enabled: true, model: "sonnet" }));
  fireEvent.click(within(area).getByRole("checkbox"));
  await waitFor(() => expect(setSuggestionSettings).toHaveBeenLastCalledWith({ enabled: false, model: "sonnet" }));
  await waitFor(() => expect((within(area).getByRole("button", { name: "Suggest specialists" }) as HTMLButtonElement).disabled).toBe(true));
});

it("folds the suggestions to a count, and remembers it", async () => {
  setRoleSuggestions([suggestion("r1")]);
  const { unmount } = render(<SettingsDialog tab="specialists" />);
  const area = () => screen.getByRole("region", { name: "Suggestions" });
  const toggle = () => within(area()).getByRole("button", { name: /Suggestions/ });
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(within(area()).getByText("Specialist suggested from repeated work: Migration writer")).toBeTruthy();
  fireEvent.click(toggle());
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(within(area()).getByText("1 waiting")).toBeTruthy();
  expect(within(area()).queryByText(/Migration writer/)).toBeNull();
  expect(within(area()).queryByRole("button", { name: "Suggest specialists" })).toBeNull();
  // Closed and opened again, it stays folded until the user opens it.
  unmount();
  render(<SettingsDialog tab="specialists" />);
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle());
  expect(within(area()).getByText("Specialist suggested from repeated work: Migration writer")).toBeTruthy();
  expect(localStorage.getItem("aura.specialist-suggestions-open.v1")).toBe("true");
});
