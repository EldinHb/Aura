import { beforeEach, expect, it, vi } from "vitest";
import type { Session } from "../gen";
import type { RpcClient } from "../lib/rpc";
import { evaluateWhen, getCommand, runCommand } from "../lib/commands";
import { currentCommandContext } from "../hooks/useCommandContext";
import { useStore } from "../state/store";
import { registerCoreCommands } from "./core";

registerCoreCommands();

const deleteSession = vi.fn(() => Promise.resolve(true));
const toast = vi.fn();
const session = (id: string, patch: Partial<Session> = {}) => ({ id, title: id, cwd: `/work/${id}`, orchestrator: false, orchestrator_id: null, folderless: false, ...patch }) as Session;

beforeEach(() => {
  deleteSession.mockClear();
  toast.mockClear();
  const list = [
    session("lead", { orchestrator: true, folderless: true }),
    session("w1", { orchestrator_id: "lead" }),
    session("sub", { orchestrator: true, orchestrator_id: "lead" }),
    session("w2", { orchestrator_id: "sub" }),
    session("plain"),
  ];
  useStore.setState({
    sessions: Object.fromEntries(list.map((s) => [s.id, s])),
    selectedId: "lead",
    prSelection: null,
    reviewHistoryOpen: false,
    dialog: { kind: "none" },
    client: { deleteSession } as unknown as RpcClient,
    toast,
    settings: { ...useStore.getState().settings, confirmDelete: true },
  });
});

it("says how many workers go with an orchestrator before deleting it", async () => {
  await runCommand("session.delete");
  const dialog = useStore.getState().dialog;
  if (dialog.kind !== "confirm") throw new Error(`no confirmation, got ${dialog.kind}`);
  expect(dialog.title).toBe("Delete orchestrator and workers");
  expect(dialog.message).toContain("the 3 worker sessions it started");
  expect(deleteSession).not.toHaveBeenCalled();
  dialog.onConfirm();
  await vi.waitFor(() => expect(toast).toHaveBeenCalledWith("Deleted “lead” and the 3 worker sessions it started"));
  expect(deleteSession).toHaveBeenCalledWith("lead", false);
});

it("asks as before for a session without workers", async () => {
  useStore.setState({ selectedId: "w2" });
  await runCommand("session.delete");
  const dialog = useStore.getState().dialog;
  if (dialog.kind !== "confirm") throw new Error(`no confirmation, got ${dialog.kind}`);
  expect(dialog.message).toBe("Delete “w2” and its history? The provider's own transcript is kept.");
  useStore.setState({ selectedId: "sub", dialog: { kind: "none" } });
  await runCommand("session.delete");
  const sub = useStore.getState().dialog;
  expect(sub.kind === "confirm" && sub.message).toContain("the worker session it started");
});

it("keeps an orchestrator without a folder out of git and terminal mode", async () => {
  const switchMode = vi.fn();
  useStore.setState({ client: { deleteSession, switchMode } as unknown as RpcClient });
  await runCommand("session.mode-terminal");
  expect(switchMode).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith(expect.stringContaining("structured view"), "warn");
  await runCommand("session.copy-cwd");
  expect(toast).toHaveBeenCalledWith("This orchestrator belongs to no folder", "warn");
});

it("lets an orchestrator left in terminal mode go back to the structured view, and no further", async () => {
  const switchMode = vi.fn(() => Promise.resolve(null));
  const shown = (id: string) => evaluateWhen(getCommand(id)!.when, currentCommandContext());
  useStore.setState({
    client: { deleteSession, switchMode } as unknown as RpcClient,
    sessions: { ...useStore.getState().sessions, lead: session("lead", { orchestrator: true, folderless: true, provider: "claude", mode: "terminal" }) },
  });
  expect(shown("session.toggle-mode")).toBe(true);
  await runCommand("session.toggle-mode");
  expect(switchMode).toHaveBeenCalledWith("lead", "structured");

  useStore.setState({ sessions: { ...useStore.getState().sessions, lead: { ...useStore.getState().sessions.lead, mode: "structured" } } });
  expect(shown("session.toggle-mode")).toBe(false);
  expect(shown("session.mode-terminal")).toBe(false);
  switchMode.mockClear();
  await runCommand("session.toggle-mode");
  expect(switchMode).not.toHaveBeenCalled();
});
