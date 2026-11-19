import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "../../lib/rpc";
import type { ProviderInfo, ScheduledRun, ScheduledTask, Session } from "../../gen";
import { useStore } from "../../state/store";
import { SchedulesDialog } from "./SchedulesDialog";
import { ScheduleSidebar } from "./ScheduleSidebar";
import { useScheduleSync, useSchedules } from "./state";
import { describeSchedule, draftError, draftOf, draftOfTask, formatWhen, inputOf, newDraft, nextRuns, scheduleError, scheduleOf } from "./schedule";

vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear() } });
});

const task = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: "t1", name: "Nightly triage", prompt: "Triage new issues", agent: "claude", model: null, effort: null,
  permission_mode: null, sandbox_mode: null, cwd: "/repo", run_as: "session", feature_goal: null, autonomy: null, worktree: false, branch_prefix: null, group: null, enabled: true,
  schedule: { unit: "days", every: 1, at: "09:00" }, missed: "run_once", allow_overlap: false,
  created_at: "2026-11-18T08:00:00Z", updated_at: "2026-11-18T08:00:00Z", anchor: "2026-11-18T08:00:00Z",
  last_slot: null, next_run: "2026-11-19T08:00:00Z", last_run: null, created_by: null, ...over,
});
const run = (over: Partial<ScheduledRun> = {}): ScheduledRun => ({
  id: "r1", task_id: "t1", at: "2026-11-18T08:00:00Z", slot: "2026-11-18T08:00:00Z", trigger: "schedule", result: "started",
  session_id: "s1", session_title: "Nightly triage · Wed 18 Nov 09:00", message: null, ...over,
});

const call = vi.fn();
let notify: (method: string, params: unknown) => void = () => {};
const providers = [
  { kind: "claude", display_name: "Claude Code", available: true, version: "2", capabilities: { permission_modes: ["default", "acceptEdits"], sandbox_modes: [] }, agents: [] },
  { kind: "codex", display_name: "Codex", available: true, version: "1", capabilities: { permission_modes: [], sandbox_modes: ["read-only", "workspace-write"] }, agents: [] },
] as unknown as ProviderInfo[];
let tasks: ScheduledTask[] = [];
let runs: ScheduledRun[] = [];

beforeEach(() => {
  call.mockReset();
  tasks = [task()];
  runs = [run(), run({ id: "r2", result: "skipped", session_id: null, session_title: null, message: "The previous run is still working." })];
  call.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "schedules.list": return tasks;
      case "schedules.runs": return runs;
      case "schedules.preview": return ["2026-11-19T08:00:00Z", "2026-11-20T08:00:00Z"];
      case "schedules.create": { const t = task({ id: "t2", name: params.name as string, prompt: params.prompt as string }); tasks = [...tasks, t]; return t; }
      case "schedules.update": { tasks = tasks.map((t) => t.id === params.id ? { ...t, ...(params as Partial<ScheduledTask>) } : t); return tasks.find((t) => t.id === params.id); }
      case "schedules.set_enabled": { tasks = tasks.map((t) => t.id === params.id ? { ...t, enabled: params.enabled as boolean, next_run: params.enabled ? t.next_run : null } : t); return tasks[0]; }
      case "schedules.run": return run({ id: "r3", trigger: "manual", session_title: "Nightly triage · now" });
      case "schedules.delete": { const t = tasks[0]; tasks = []; return t; }
      case "orchestrator.projects": return [{ path: "/repo", repo: true, groups: [], sessions: 1, last_used: "" }];
      case "group.list": return [];
      default: return null;
    }
  });
  useSchedules.setState({ tasks: [], loaded: false, error: null, version: 0 });
  useStore.setState({
    dialog: { kind: "schedules" }, providers, sessions: { s1: { id: "s1", title: "Nightly triage · Wed" } as Session }, selectedId: null,
    client: {
      call, models: vi.fn().mockResolvedValue([{ id: "opus", display_name: "Opus", is_default: true, efforts: ["low", "high"], default_effort: "high", description: null }]),
      projects: () => call("orchestrator.projects", {}), groups: () => call("group.list", {}), gitRepoRoot: vi.fn().mockResolvedValue("/repo"),
      onNotification: (l: (m: string, p: unknown) => void) => { notify = l; return () => {}; }, onState: () => () => {},
    } as unknown as RpcClient,
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

function Synced({ children }: { children: React.ReactNode }) {
  useScheduleSync();
  return <>{children}</>;
}

describe("schedules in words", () => {
  it("say what the daemon says", () => {
    expect(describeSchedule({ unit: "minutes", every: 1 })).toBe("every minute");
    expect(describeSchedule({ unit: "hours", every: 3 })).toBe("every 3 hours");
    expect(describeSchedule({ unit: "days", every: 1, at: "09:00" })).toBe("every day at 09:00");
    expect(describeSchedule({ unit: "weeks", every: 2, weekdays: ["fri", "mon", "wed"], at: "17:30" })).toBe("every 2 weeks on Monday, Wednesday and Friday at 17:30");
    expect(describeSchedule({ unit: "months", every: 1, day: 31, at: "08:00" })).toBe("every month on the 31st (the last day in shorter months) at 08:00");
    expect(describeSchedule({ unit: "months", every: 3, day: 12, at: "08:00" })).toBe("every 3 months on the 12th at 08:00");
  });

  it("keep what was typed when the unit changes, and send only the unit's fields", () => {
    const d = draftOf({ unit: "weeks", every: 2, weekdays: ["thu", "mon"], at: "07:15" });
    expect(scheduleOf({ ...d, unit: "days" })).toEqual({ unit: "days", every: 2, at: "07:15" });
    expect(scheduleOf(d)).toEqual({ unit: "weeks", every: 2, weekdays: ["mon", "thu"], at: "07:15" });
    expect(scheduleOf({ ...d, unit: "minutes" })).toEqual({ unit: "minutes", every: 2 });
    expect(scheduleOf({ ...d, unit: "months", day: 31 })).toEqual({ unit: "months", every: 2, day: 31, at: "07:15" });
  });

  it("refuse what cannot run", () => {
    const d = draftOf({ unit: "days", every: 1, at: "09:00" });
    expect(scheduleError(d)).toBe(null);
    expect(scheduleError({ ...d, every: 0 })).toBe("Every 1 to 365 days");
    expect(scheduleError({ ...d, at: "" })).toBe("Pick a time of day");
    expect(scheduleError({ ...d, unit: "weeks", weekdays: [] })).toBe("Pick at least one day");
    expect(scheduleError({ ...d, unit: "months", day: 32 })).toBe("Pick a day from 1 to 31");
    expect(scheduleError({ ...d, unit: "minutes", at: "" })).toBe(null);
    const draft = newDraft("claude", "/repo");
    expect(draftError(draft)).toBe("Give the task a name");
    expect(draftError({ ...draft, name: "n" })).toBe("Write the prompt each run starts with");
    expect(draftError({ ...draft, name: "n", prompt: "p", cwd: " " })).toBe("Pick the folder the sessions work in");
    expect(draftError({ ...draft, name: "n", prompt: "p" })).toBe(null);
  });

  it("round-trip a task through the editor", () => {
    const t = task({ model: "opus", group: "Chores", worktree: true, branch_prefix: "chore/x" });
    expect(inputOf(draftOfTask(t))).toEqual({
      name: "Nightly triage", prompt: "Triage new issues", agent: "claude", model: "opus", effort: "", permission_mode: "", sandbox_mode: "",
      cwd: "/repo", worktree: true, run_as: "session", feature_goal: "", autonomy: null,
      branch_prefix: "chore/x", group: "Chores", enabled: true, schedule: t.schedule, missed: "run_once", allow_overlap: false,
    });
  });

  it("carry what a run starts as, and leave out what only a feature owner has", () => {
    const autonomy = { level: "checkpoints" as const, checkpoints: ["before_delivery" as const] };
    const owner = task({ run_as: "feature_owner", cwd: "", feature_goal: "A changelog", autonomy });
    const draft = draftOfTask(owner);
    expect(draft.no_folder).toBe(true);
    expect(inputOf(draft)).toMatchObject({ run_as: "feature_owner", cwd: "", worktree: false, feature_goal: "A changelog", autonomy });
    expect(draftError(draft)).toBeNull();
    // A session needs its folder back, and has no feature.
    const plain = { ...draft, run_as: "session" as const };
    expect(draftError(plain)).toBe("Pick the folder the sessions work in");
    expect(inputOf({ ...plain, cwd: "/repo" })).toMatchObject({ run_as: "session", cwd: "/repo", feature_goal: "", autonomy: null });
    // An orchestrator given a folder keeps it, with its worktree.
    expect(inputOf({ ...draft, run_as: "orchestrator", no_folder: false, cwd: "/repo", worktree: true })).toMatchObject({ cwd: "/repo", worktree: true, feature_goal: "", autonomy: null });
  });

  it("show times relative to today in the user's clock", () => {
    const now = new Date(2026, 10, 18, 12, 0);
    expect(formatWhen(new Date(2026, 10, 18, 9, 0).toISOString(), now)).toMatch(/^today /);
    expect(formatWhen(new Date(2026, 10, 19, 9, 0).toISOString(), now)).toMatch(/^tomorrow /);
    expect(formatWhen(new Date(2026, 10, 17, 9, 0).toISOString(), now)).toMatch(/^yesterday /);
    expect(formatWhen(new Date(2026, 10, 25, 9, 0).toISOString(), now)).not.toMatch(/today|tomorrow/);
    expect(nextRuns([task({ id: "a", next_run: "2026-11-20T08:00:00Z" }), task({ id: "b", enabled: false }), task({ id: "c" })]).map((t) => t.id)).toEqual(["c", "a"]);
  });
});

describe("the scheduled tasks window", () => {
  it("lists the tasks with their schedule and next run, and the chosen one's history with a link to its session", async () => {
    render(<Synced><SchedulesDialog /></Synced>);
    const list = await screen.findByRole("listbox", { name: "Tasks" });
    const row = await within(list).findByRole("option", { name: /Nightly triage/ });
    expect(row.textContent).toContain("every day at 09:00");
    expect(row.textContent).toContain("next ");
    const history = await screen.findByRole("region", { name: "Run history" });
    await within(history).findByText("Skipped");
    expect(within(history).getByText("The previous run is still working.")).toBeTruthy();
    fireEvent.click(within(history).getByRole("button", { name: "Nightly triage · Wed 18 Nov 09:00" }));
    expect(useStore.getState().selectedId).toBe("s1");
    expect(useStore.getState().dialog.kind).toBe("none");
  });

  it("creates a task with what the editor holds", async () => {
    render(<Synced><SchedulesDialog create /></Synced>);
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Weekly deps" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Update the dependencies" } });
    fireEvent.change(screen.getByLabelText(/Folder or repository/), { target: { value: "/repo" } });
    fireEvent.change(screen.getByLabelText("Unit"), { target: { value: "weeks" } });
    fireEvent.click(screen.getByRole("button", { name: "Fri" }));
    fireEvent.change(screen.getByLabelText("Time of day"), { target: { value: "07:30" } });
    fireEvent.change(screen.getByLabelText("Runs missed while Aura was not running"), { target: { value: "skip" } });
    await screen.findByText(/Next runs:/);
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("schedules.create", expect.objectContaining({
      name: "Weekly deps", prompt: "Update the dependencies", agent: "claude", cwd: "/repo", missed: "skip",
      schedule: { unit: "weeks", every: 1, weekdays: ["mon", "fri"], at: "07:30" },
    })));
    await within(screen.getByRole("listbox", { name: "Tasks" })).findByRole("option", { name: /Weekly deps/ });
  });

  it("saves changes, runs now, disables and deletes through the daemon", async () => {
    render(<Synced><SchedulesDialog taskId="t1" /></Synced>);
    const save = await screen.findByRole("button", { name: /^Save/ });
    expect(save.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /Codex/ }));
    fireEvent.change(await screen.findByLabelText("Sandbox"), { target: { value: "workspace-write" } });
    fireEvent.click(save);
    await waitFor(() => expect(call).toHaveBeenCalledWith("schedules.update", expect.objectContaining({ id: "t1", agent: "codex", sandbox_mode: "workspace-write" })));

    fireEvent.click(screen.getByRole("button", { name: /Run now/ }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("schedules.run", { id: "t1" }));
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("schedules.set_enabled", { id: "t1", enabled: false }));
    await screen.findByRole("button", { name: "Enable" });
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete task and history" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("schedules.delete", { id: "t1" }));
    await screen.findByText(/No scheduled tasks yet/);
  });

  it("shows a change made elsewhere as soon as the daemon announces it", async () => {
    render(<Synced><SchedulesDialog /></Synced>);
    await screen.findByRole("option", { name: /Nightly triage/ });
    // An orchestrator renames it through its tools.
    tasks = [task({ name: "Morning triage", created_by: { orchestrator: "o1", orchestrator_title: "Lead" } })];
    act(() => notify("schedules.changed", { id: "t1" }));
    await screen.findByRole("option", { name: /Morning triage/ });
    expect(screen.getByText("by Lead")).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Morning triage");
  });
});

describe("the sidebar line", () => {
  it("survives a daemon that answers with nothing", async () => {
    call.mockImplementation(async () => null);
    render(<Synced><ScheduleSidebar /></Synced>);
    expect((await screen.findByRole("button", { name: /Scheduled tasks/ })).textContent).toContain("none yet");
  });

  it("names the next run and opens the window", async () => {
    render(<Synced><ScheduleSidebar /></Synced>);
    const line = await screen.findByRole("button", { name: /Scheduled tasks/ });
    expect(line.textContent).toContain("next ");
    expect(line.textContent).toContain("Nightly triage");
    useStore.setState({ dialog: { kind: "none" } });
    fireEvent.click(line);
    expect(useStore.getState().dialog).toEqual({ kind: "schedules", taskId: "t1", create: false });
  });
});
