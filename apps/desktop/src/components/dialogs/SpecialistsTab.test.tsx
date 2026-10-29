import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Project, Specialist, SpecialistInput } from "../../gen";
import type { RpcClient } from "../../lib/rpc";
import { useStore } from "../../state/store";
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

beforeEach(() => {
  vi.clearAllMocks();
  global = [spec("tester"), spec("code-reviewer", { name: "Code reviewer", customized: true }), spec("writer", { name: "Writer", built_in: false })];
  local = [spec("tester", { scope: "project", project: "/repo", built_in: false, instructions: "Test our way." }), global[1], global[2]];
  useStore.setState({ dialog: { kind: "none" }, client: { specialists, hiddenSpecialists, saveSpecialist, deleteSpecialist, resetSpecialist, projects } as unknown as RpcClient });
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
