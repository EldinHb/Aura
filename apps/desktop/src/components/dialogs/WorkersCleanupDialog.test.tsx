import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BulkDeleteResult, Session, Workspace } from "../../gen";
import type { RpcClient } from "../../lib/rpc";
import { defaultSettings, useStore } from "../../state/store";
import { WorkersCleanupDialog, cleanupGroups, defaultPicks, runLabel } from "./WorkersCleanupDialog";

function session(id: string, patch: Partial<Session> = {}): Session {
  return { id, title: id, cwd: `/work/${id}`, provider: "claude", status: "idle", mode: "structured", archived: false, pinned: false, workspace: "one",
    pending_count: 0, attention: null, created_at: "2026-11-20T00:00:00Z", last_activity: "2026-11-20T00:00:00Z", group: null, worktree: null, model: null, orchestrator: false, orchestrator_id: null, ...patch } as Session;
}
const ws = (id: string): Workspace => ({ id, name: id, position: 0, created_at: "" });
const deleteSessions = vi.fn<(ids: string[]) => Promise<BulkDeleteResult>>();
const toast = vi.fn();

/**
 * Orchestrator "lead" with an idle, a finished, a failed, an archived, a
 * working and a waiting worker, and a sub-orchestrator whose own worker is
 * done; an orphaned worker; a scheduled run; a scheduled orchestrator run
 * with a worker; and in workspace two another orchestra.
 */
function setup() {
  const list = [
    session("lead", { orchestrator: true, last_activity: "2026-11-20T12:00:00Z" }),
    session("idle", { orchestrator_id: "lead", created_at: "2026-11-20T01:00:00Z" }),
    session("done", { orchestrator_id: "lead", attention: "done", created_at: "2026-11-20T02:00:00Z" }),
    session("failed", { orchestrator_id: "lead", attention: "failed", status: "error", created_at: "2026-11-20T03:00:00Z" }),
    session("old", { orchestrator_id: "lead", archived: true, created_at: "2026-11-20T04:00:00Z" }),
    session("busy", { orchestrator_id: "lead", status: "running", created_at: "2026-11-20T05:00:00Z" }),
    session("asks", { orchestrator_id: "lead", pending_count: 1, created_at: "2026-11-20T06:00:00Z" }),
    session("sub", { orchestrator_id: "lead", orchestrator: true, created_at: "2026-11-20T07:00:00Z", last_activity: "2026-11-20T08:00:00Z" }),
    session("subw", { orchestrator_id: "sub", attention: "done" }),
    session("orphan", { orchestrator_id: "gone" }),
    session("run", { scheduled_task_id: "t", scheduled_task_name: "Nightly" }),
    session("srun", { scheduled_task_id: "t2", scheduled_task_name: "Weekly", orchestrator: true, created_at: new Date(2026, 10, 27, 3, 0).toISOString() }),
    session("sw", { orchestrator_id: "srun", scheduled_run: "t2" }),
    session("lead2", { orchestrator: true, workspace: "two" }),
    session("w2", { orchestrator_id: "lead2", workspace: "two" }),
  ];
  useStore.setState({ sessions: Object.fromEntries(list.map((s) => [s.id, s])), sessionOrder: list.map((s) => s.id) });
}

beforeEach(() => {
  deleteSessions.mockReset();
  toast.mockClear();
  useStore.setState({
    client: { deleteSessions } as unknown as RpcClient, toast, dialog: { kind: "workers-cleanup" },
    settings: { ...defaultSettings, confirmDelete: true }, workspaces: [ws("one"), ws("two")], activeWorkspace: "one",
  });
  setup();
});
afterEach(cleanup);

const checked = () => [...document.querySelectorAll<HTMLInputElement>(".cleanup-row input:checked")].map((el) => el.closest("label")!.querySelector(".cleanup-title")!.firstChild!.textContent);
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

it("never lists an orchestrator: each orchestrator's workers get a group, scheduled orchestrator runs by task and time", () => {
  const groups = cleanupGroups(useStore.getState().sessions, null, "one");
  expect(groups.map((g) => [g.label, g.rows.map((s) => s.id)])).toEqual([
    ["lead", ["idle", "done", "failed", "old", "busy", "asks"]],
    ["sub", ["subw"]],
    ["Weekly · 27 Nov 03:00", ["sw"]],
    ["No orchestrator", ["orphan"]],
    ["Scheduled runs", ["run"]],
  ]);
  const rows = groups.flatMap((g) => g.rows.map((s) => s.id));
  for (const orchestrator of ["lead", "sub", "srun"]) expect(rows).not.toContain(orchestrator);
  // Every workspace: the other orchestra too.
  expect(cleanupGroups(useStore.getState().sessions, null, null).map((g) => g.label)).toContain("lead2");
  // From one orchestrator: its workers and those of the orchestrators under it.
  expect(cleanupGroups(useStore.getState().sessions, "lead", null).map((g) => g.label)).toEqual(["lead", "sub"]);
});

it("names a scheduled run by its task, day and time", () => {
  expect(runLabel(session("r", { scheduled_task_name: "Nightly", created_at: new Date(2026, 10, 27, 3, 5).toISOString() }))).toBe("Nightly · 27 Nov 03:05");
});

it("preselects what is done: not what works or waits on the user, nothing of a scheduled run", () => {
  const sessions = useStore.getState().sessions;
  expect(defaultPicks(cleanupGroups(sessions, null, "one"), sessions)).toEqual(["idle", "done", "failed", "old", "subw", "orphan"]);
});

it("deletes the selection after one confirmation that says what is still working or waiting", async () => {
  deleteSessions.mockResolvedValue({ deleted: ["idle", "busy", "asks"], failed: [] });
  render(<WorkersCleanupDialog orchestratorId="lead" />);
  expect(checked()).toEqual(["idle", "done", "failed", "old", "subw"]);
  fireEvent.click(screen.getByRole("button", { name: "Select none" }));
  expect(screen.getByRole("button", { name: /Delete 0 sessions/ }).hasAttribute("disabled")).toBe(true);
  for (const id of ["idle", "busy", "asks"]) fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(`^${id}`) }));
  // A waiting row says so once, in its chip.
  expect(screen.getByRole("checkbox", { name: /^asks/ }).closest("label")!.textContent!.match(/waiting on you/g)).toHaveLength(1);
  expect(screen.getByRole("checkbox", { name: /^busy/ }).closest("label")!.querySelector(".cleanup-state")!.textContent).toMatch(/^working · /);
  fireEvent.click(screen.getByRole("button", { name: /Delete 3 sessions/ }));
  expect(screen.getByText(/Delete 3 sessions and their history from Aura\?/).textContent).toContain("1 of them is still working and will be stopped. 1 waits on you; its question will be discarded.");
  // Cancel has the focus.
  expect(document.activeElement?.textContent).toBe("Cancel");
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(deleteSessions).toHaveBeenCalledWith(["idle", "busy", "asks"]));
  await waitFor(() => expect(useStore.getState().dialog.kind).toBe("none"));
  expect(toast).toHaveBeenCalledWith("Deleted 3 worker sessions");
});

it("counts in sessions throughout: the button, the countdown while deleting, and the daemon's own deleted list", async () => {
  useStore.setState({ settings: { ...defaultSettings, confirmDelete: false } });
  const call = deferred<BulkDeleteResult>();
  deleteSessions.mockReturnValue(call.promise);
  render(<WorkersCleanupDialog orchestratorId="lead" />);
  fireEvent.click(screen.getByRole("button", { name: "Select none" }));
  for (const id of ["idle", "done", "subw"]) fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(`^${id}`) }));
  fireEvent.click(screen.getByRole("button", { name: /Delete 3 sessions/ }));
  expect(screen.getByRole("button", { name: /Deleting 0 of 3…/ })).toBeTruthy();
  // The daemon's events take sessions away while the call runs.
  act(() => useStore.getState().removeSession("idle"));
  expect(screen.getByRole("button", { name: /Deleting 1 of 3…/ })).toBeTruthy();
  await act(async () => call.resolve({ deleted: ["idle", "done", "subw"], failed: [] }));
  expect(toast).toHaveBeenCalledWith("Deleted 3 worker sessions");
});

it("keeps every failed session listed with its reason, wherever it went, and retries only those", async () => {
  useStore.setState({ settings: { ...defaultSettings, confirmDelete: false } });
  deleteSessions.mockResolvedValueOnce({ deleted: ["idle", "done", "old", "sub"], failed: [{ id: "failed", error: "Couldn't stop the process: busy" }, { id: "subw", error: "locked" }] });
  render(<WorkersCleanupDialog orchestratorId="lead" />);
  fireEvent.click(screen.getByRole("button", { name: /Delete 5 sessions/ }));
  await waitFor(() => expect(screen.getByText("Deleted 4. 2 couldn't be deleted.")).toBeTruthy());
  // The daemon's events take the deleted rows away; subw's orchestrator went too, so it is under lead no more.
  act(() => { for (const id of ["idle", "done", "old", "sub"]) useStore.getState().removeSession(id); });
  const group = screen.getByRole("group", { name: "Couldn't delete" });
  expect(group.textContent).toContain("Couldn't stop the process: busy");
  expect(group.textContent).toContain("locked");
  expect(checked()).toEqual(["failed", "subw"]);
  deleteSessions.mockResolvedValueOnce({ deleted: ["failed", "subw"], failed: [] });
  fireEvent.click(screen.getByRole("button", { name: "Retry failed" }));
  await waitFor(() => expect(deleteSessions).toHaveBeenLastCalledWith(["failed", "subw"]));
  await waitFor(() => expect(useStore.getState().dialog.kind).toBe("none"));
});

it("says why when the daemon cannot be reached, and deletes nothing here", async () => {
  useStore.setState({ settings: { ...defaultSettings, confirmDelete: false } });
  deleteSessions.mockRejectedValue(new Error("connection closed"));
  render(<WorkersCleanupDialog orchestratorId="lead" />);
  fireEvent.click(screen.getByRole("button", { name: /Delete 5 sessions/ }));
  await waitFor(() => expect(screen.getByText("Couldn't delete: connection closed")).toBeTruthy());
  expect(useStore.getState().sessions.idle).toBeTruthy();
  expect(checked()).toHaveLength(5);
});

it("offers every workspace from the global entry, and says when there is nothing to clean up", () => {
  render(<WorkersCleanupDialog />);
  expect(screen.queryByRole("group", { name: "lead2" })).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "Which workspaces" }), { target: { value: "all" } });
  expect(screen.getByRole("group", { name: "lead2" })).toBeTruthy();
  expect(screen.getByRole("group", { name: "Scheduled runs" })).toBeTruthy();
  cleanup();
  act(() => useStore.setState({ sessions: { lead: session("lead", { orchestrator: true }) } }));
  render(<WorkersCleanupDialog />);
  expect(screen.getByText("No worker sessions to clean up.")).toBeTruthy();
});

it("keeps a failed session that became an orchestrator in view, disabled and explained, and leaves it out of the retry", async () => {
  useStore.setState({ settings: { ...defaultSettings, confirmDelete: false } });
  deleteSessions.mockResolvedValueOnce({ deleted: ["idle", "done", "old"], failed: [{ id: "failed", error: "busy" }, { id: "subw", error: "locked" }] });
  render(<WorkersCleanupDialog orchestratorId="lead" />);
  fireEvent.click(screen.getByRole("button", { name: /Delete 5 sessions/ }));
  await waitFor(() => expect(screen.getByText("Deleted 3. 2 couldn't be deleted.")).toBeTruthy());
  act(() => { for (const id of ["idle", "done", "old"]) useStore.getState().removeSession(id); });
  // Meanwhile subw was made an orchestrator and started a worker.
  act(() => useStore.setState({ sessions: { ...useStore.getState().sessions, subw: { ...useStore.getState().sessions.subw, orchestrator: true }, subw1: session("subw1", { orchestrator_id: "subw" }) } }));
  // Its new worker gets a group of its own; subw itself stays under "Couldn't delete".
  expect(screen.getByRole("group", { name: "subw" })).toBeTruthy();
  const row = within(screen.getByRole("group", { name: "Couldn't delete" })).getByRole("checkbox", { name: /^subw/ }) as HTMLInputElement;
  expect(row.disabled).toBe(true);
  expect(row.checked).toBe(false);
  expect(row.closest("label")!.textContent).toContain("It is an orchestrator now; delete it on its own.");
  expect(row.closest("label")!.textContent).toContain("locked");
  expect(screen.getByRole("group", { name: "Couldn't delete" })).toBeTruthy();
  deleteSessions.mockResolvedValueOnce({ deleted: ["failed"], failed: [] });
  fireEvent.click(screen.getByRole("button", { name: "Retry failed" }));
  await waitFor(() => expect(deleteSessions).toHaveBeenLastCalledWith(["failed"]));
});

it("checks again right before deleting: a row that became an orchestrator after it was picked is not sent", async () => {
  useStore.setState({ settings: { ...defaultSettings, confirmDelete: true } });
  deleteSessions.mockResolvedValue({ deleted: ["idle"], failed: [] });
  render(<WorkersCleanupDialog orchestratorId="lead" />);
  fireEvent.click(screen.getByRole("button", { name: "Select none" }));
  for (const id of ["idle", "done"]) fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(`^${id}`) }));
  fireEvent.click(screen.getByRole("button", { name: /Delete 2 sessions/ }));
  const confirm = screen.getByRole("button", { name: "Delete" });
  // Between the confirmation showing and the click, done becomes an orchestrator (no render in between).
  useStore.setState({ sessions: { ...useStore.getState().sessions, done: { ...useStore.getState().sessions.done, orchestrator: true } } });
  fireEvent.click(confirm);
  await waitFor(() => expect(deleteSessions).toHaveBeenCalledWith(["idle"]));
});
