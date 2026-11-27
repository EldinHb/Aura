import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Session, Workspace } from "../../gen";
import type { RpcClient } from "../../lib/rpc";
import { defaultSettings, useStore } from "../../state/store";
import { Overlays } from "../Overlays";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear() } });

const ws = (id: string, name: string): Workspace => ({ id, name, position: 0, created_at: "" });
const session = (id: string, patch: Partial<Session> = {}) => ({ id, title: id.toUpperCase(), workspace: "one", status: "idle", archived: false, pinned: false, pending_count: 0, attention: null, orchestrator: false, orchestrator_id: null, created_at: "", last_activity: "", ...patch }) as Session;
const createWorkspace = vi.fn(async (name: string) => ws("new", name));
const setWorkspace = vi.fn(async (id: string, workspace: string) => Object.values(useStore.getState().sessions).filter((s) => s.id === id || s.orchestrator_id === id).map((s) => ({ ...s, workspace })));
const touchWorkspace = vi.fn(async () => true);
const toast = vi.fn();

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  vi.clearAllMocks();
  const list = [session("lead", { orchestrator: true }), session("w", { orchestrator_id: "lead" }), session("other")];
  useStore.setState({
    client: { createWorkspace, setWorkspace, touchWorkspace } as unknown as RpcClient, toast, settings: defaultSettings,
    sessions: Object.fromEntries(list.map((s) => [s.id, s])), sessionOrder: list.map((s) => s.id),
    workspaces: [ws("one", "One"), ws("two", "Two")], activeWorkspace: "one", selectedId: "other", paletteOpen: false,
    dialog: { kind: "workspace-move", sessionId: "lead" },
  });
});
afterEach(cleanup);

it("moves the session into a workspace made from the move picker, once it is created", async () => {
  render(<Overlays />);
  expect(screen.getByText("Moves LEAD and its 1 worker.")).toBeTruthy();
  fireEvent.click(screen.getByRole("option", { name: /New workspace…/ }));
  expect(useStore.getState().dialog).toEqual({ kind: "workspace-edit", moveSessionId: "lead" });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Client X" } });
  // Nothing moves before the workspace exists.
  expect(setWorkspace).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Create/ })); });
  await waitFor(() => expect(setWorkspace).toHaveBeenCalledWith("lead", "new"));
  expect(createWorkspace).toHaveBeenCalledWith("Client X");
  expect(useStore.getState().sessions.lead.workspace).toBe("new");
  expect(useStore.getState().sessions.w.workspace).toBe("new");
  expect(useStore.getState().workspaces.map((w) => w.id)).toEqual(["one", "two", "new"]);
  // The user stays where they were; the toast offers to go there.
  expect(useStore.getState().activeWorkspace).toBe("one");
  expect(toast).toHaveBeenCalledWith("Moved “LEAD” to Client X", "info", expect.objectContaining({ label: "Go there" }));
  expect(useStore.getState().dialog.kind).toBe("none");
});
