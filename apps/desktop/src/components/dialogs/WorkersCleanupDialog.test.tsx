import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BulkDeleteResult, Session, Workspace } from "../../gen";
import type { RpcClient } from "../../lib/rpc";
import { defaultSettings, useStore } from "../../state/store";
import { WorkersCleanupDialog, cleanupGroups, defaultPicks } from "./WorkersCleanupDialog";

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
 * done; an orphaned worker; a scheduled run; and in workspace two another orchestra.
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
    session("sub", { orchestrator_id: "lead", orchestrator: true, created_at: "2026-11-20T07:00:00Z" }),
    session("subw", { orchestrator_id: "sub", attention: "done" }),
    session("orphan", { orchestrator_id: "gone" }),
    session("run", { scheduled_task_id: "t", scheduled_task_name: "Nightly" }),
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

const checked = () => [...document.querySelectorAll<HTMLInputElement>(".cleanup-row input:checked")].map((el) => el.closest("label")!.querySelector(".cleanup-title")!.textContent!.split(" ")[0]);

it("groups workers by orchestrator in the workspace, orphans and scheduled runs last", () => {
  const groups = cleanupGroups(useStore.getState().sessions, null, "one");
  expect(groups.map((g) => [g.label, g.rows.map((s) => s.id)])).toEqual([
    ["lead", ["idle", "done", "failed", "old", "busy", "asks", "sub"]],
    ["No orchestrator", ["orphan"]],
    ["Scheduled runs", ["run"]],
  ]);
  // Every workspace: the other orchestra too.
  expect(cleanupGroups(useStore.getState().sessions, null, null).map((g) => g.label)).toContain("lead2");
});

it("preselects what is done: not what works or waits on the user, not a sub-orchestra still busy, never a scheduled run", () => {
  const sessions = useStore.getState().sessions;
  expect(defaultPicks(cleanupGroups(sessions, null, "one"), sessions)).toEqual(["idle", "done", "failed", "old", "sub", "orphan"]);
  const busy = { ...sessions, subw: { ...sessions.subw, status: "running" as const } };
  expect(defaultPicks(cleanupGroups(busy, null, "one"), busy)).not.toContain("sub");
});

it("deletes the selection after one confirmation that says what is still working or waiting", async () => {
  deleteSessions.mockResolvedValue({ deleted: ["idle", "busy", "asks"], failed: [] });
  render(<WorkersCleanupDialog orchestratorId="lead" />);
  expect(checked()).toEqual(["idle", "done", "failed", "old", "sub"]);
  fireEvent.click(screen.getByRole("button", { name: "Select none" }));
  expect(screen.getByRole("button", { name: /Delete 0 sessions/ }).hasAttribute("disabled")).toBe(true);
  for (const id of ["idle", "busy", "asks"]) fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(`^${id}`) }));
  // A waiting row says so in words.
  expect(screen.getByRole("checkbox", { name: /^asks/ }).closest("label")!.textContent).toContain("waiting on you");
  fireEvent.click(screen.getByRole("button", { name: /Delete 3 sessions/ }));
  expect(screen.getByText(/Delete 3 sessions and their history from Aura\?/).textContent).toContain("1 of them is still working and will be stopped. 1 waits on you; its question will be discarded.");
  // Cancel has the focus.
  expect(document.activeElement?.textContent).toBe("Cancel");
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(deleteSessions).toHaveBeenCalledWith(["idle", "busy", "asks"]));
  await waitFor(() => expect(useStore.getState().dialog.kind).toBe("none"));
  expect(toast).toHaveBeenCalledWith("Deleted 3 worker sessions");
});

it("skips the confirmation when deleting is not confirmed, and counts a sub-orchestrator's workers", async () => {
  useStore.setState({ settings: { ...defaultSettings, confirmDelete: false } });
  deleteSessions.mockResolvedValue({ deleted: ["sub", "subw"], failed: [] });
  render(<WorkersCleanupDialog orchestratorId="lead" />);
  fireEvent.click(screen.getByRole("button", { name: "Select none" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /^sub/ }));
  fireEvent.click(screen.getByRole("button", { name: /Delete 2 sessions/ }));
  await waitFor(() => expect(deleteSessions).toHaveBeenCalledWith(["sub"]));
});

it("keeps failed rows checked with their reason, and retries only those", async () => {
  useStore.setState({ settings: { ...defaultSettings, confirmDelete: false } });
  deleteSessions.mockResolvedValueOnce({ deleted: ["idle", "done", "old"], failed: [{ id: "failed", error: "Couldn't stop the process: busy" }, { id: "sub", error: "locked" }] });
  render(<WorkersCleanupDialog orchestratorId="lead" />);
  fireEvent.click(screen.getByRole("button", { name: /Delete 6 sessions/ }));
  await waitFor(() => expect(screen.getByText("Deleted 3. 2 couldn't be deleted.")).toBeTruthy());
  // The daemon's events take the deleted rows away.
  act(() => { for (const id of ["idle", "done", "old"]) useStore.getState().removeSession(id); });
  expect(checked()).toEqual(["failed", "sub"]);
  expect(screen.getByText("Couldn't stop the process: busy")).toBeTruthy();
  deleteSessions.mockResolvedValueOnce({ deleted: ["failed", "sub", "subw"], failed: [] });
  fireEvent.click(screen.getByRole("button", { name: "Retry failed" }));
  await waitFor(() => expect(deleteSessions).toHaveBeenLastCalledWith(["failed", "sub"]));
  await waitFor(() => expect(useStore.getState().dialog.kind).toBe("none"));
});

it("says why when the daemon cannot be reached, and deletes nothing here", async () => {
  useStore.setState({ settings: { ...defaultSettings, confirmDelete: false } });
  deleteSessions.mockRejectedValue(new Error("connection closed"));
  render(<WorkersCleanupDialog orchestratorId="lead" />);
  fireEvent.click(screen.getByRole("button", { name: /Delete 6 sessions/ }));
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
