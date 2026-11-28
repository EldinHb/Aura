/** The inbox lists what waits on every connected computer, labelled, and acts on the right one. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Approval, Session } from "../../gen";
import type { RpcClient } from "../../lib/rpc";

const remoteApproval = { id: "ap1", session_id: "x", kind: "command", title: "Run the deploy", description: null, payload: { command: "make deploy" }, created_at: "2026-11-28T10:00:00Z" } as unknown as Approval;
const respondApproval = vi.fn().mockResolvedValue(true);
const switched: string[] = [];
const localClient = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../../state/computers", async (orig) => ({
  ...(await orig<typeof import("../../state/computers")>()),
  pendingElsewhere: () => Promise.resolve([{ computer: "srv", approvals: [remoteApproval], inputs: [], sessions: { x: { id: "x", title: "Deploy bot", provider: "claude" } as Session } }]),
  clientOf: (id: string) => (id === "srv" ? ({ respondApproval } as unknown as RpcClient) : id === "local" ? localClient.current : null),
  switchComputer: (id: string) => {
    switched.push(id);
    return Promise.resolve();
  },
}));

const { InboxDialog } = await import("./InboxDialog");
const { useStore, emptyTranscript, LOCAL } = await import("../../state/store");
const { useComputers, localName } = await import("../../state/computers");
const { useModInbox } = await import("../../mods/inbox");

const localRespond = vi.fn().mockResolvedValue(true);
beforeEach(() => {
  localClient.current = { respondApproval: localRespond };
  useModInbox.setState({ items: [] });
  respondApproval.mockClear();
  localRespond.mockClear();
  switched.length = 0;
  useComputers.setState({ remotes: [{ id: "srv", name: "Home server" }] as never });
  useStore.setState({
    computer: LOCAL,
    client: { pending: vi.fn().mockResolvedValue({ approvals: [], inputs: [] }), respondApproval: localRespond } as unknown as RpcClient,
    sessions: {},
    transcripts: { s: emptyTranscript() },
  });
});
afterEach(cleanup);

it("labels another computer's approval, answers it there, and opens it by switching", async () => {
  await act(async () => void render(<InboxDialog />));
  expect(screen.getByText("Run the deploy")).toBeTruthy();
  expect(screen.getByText("Home server")).toBeTruthy();
  expect(screen.getByText("Deploy bot")).toBeTruthy();
  const list = document.querySelector<HTMLElement>(".list")!;
  await act(async () => void fireEvent.keyDown(list, { key: "y" }));
  expect(respondApproval).toHaveBeenCalledWith("x", "ap1", { option: "accept", updated_input: null, message: null });
  expect(localRespond).not.toHaveBeenCalled();
  expect(screen.queryByText("Run the deploy")).toBeNull();
});

it("Enter on another computer's row shows that computer", async () => {
  await act(async () => void render(<InboxDialog />));
  const list = document.querySelector<HTMLElement>(".list")!;
  await act(async () => void fireEvent.keyDown(list, { key: "Enter" }));
  expect(switched).toEqual(["srv"]);
  expect(localName()).toMatch(/^This /);
});

it("an approval with the same id on this computer is answered here and does not hide the remote's", async () => {
  // Ids are unique per daemon only: this computer has its own ap1.
  const here = { ...remoteApproval, session_id: "s", title: "Here too" } as Approval;
  useStore.setState({ client: { pending: vi.fn().mockResolvedValue({ approvals: [here], inputs: [] }), respondApproval: localRespond } as unknown as RpcClient });
  await act(async () => void render(<InboxDialog />));
  expect(screen.getByText("Here too")).toBeTruthy();
  expect(screen.getByText("Run the deploy")).toBeTruthy();
  const list = document.querySelector<HTMLElement>(".list")!;
  await act(async () => void fireEvent.keyDown(list, { key: "y" }));
  expect(localRespond).toHaveBeenCalledWith("s", "ap1", { option: "accept", updated_input: null, message: null });
  expect(respondApproval).not.toHaveBeenCalled();
  expect(screen.queryByText("Here too")).toBeNull();
  expect(screen.getByText("Run the deploy")).toBeTruthy();
});

it("a pending list that answers after another computer is shown is dropped", async () => {
  let answer!: (v: unknown) => void;
  const late = new Promise((r) => (answer = r));
  const stale = { ...remoteApproval, id: "old", title: "From the computer left" } as Approval;
  useStore.setState({ client: { pending: vi.fn(() => late), respondApproval: localRespond } as unknown as RpcClient });
  await act(async () => void render(<InboxDialog />));
  act(() => useStore.setState({ computer: "srv2", client: { pending: vi.fn(() => new Promise(() => {})) } as unknown as RpcClient }));
  await act(async () => answer({ approvals: [stale], inputs: [] }));
  expect(screen.queryByText("From the computer left")).toBeNull();
});

it("a row of the computer shown is never answered on the one shown after it", async () => {
  const here = { ...remoteApproval, id: "h1", session_id: "s", title: "Approve here", created_at: "2026-11-28T09:00:00Z" } as Approval;
  useStore.setState({ client: { pending: vi.fn().mockResolvedValue({ approvals: [here], inputs: [] }), respondApproval: localRespond } as unknown as RpcClient });
  await act(async () => void render(<InboxDialog />));
  expect(screen.getByText("Approve here")).toBeTruthy();
  // Another computer is shown while the inbox stays open.
  const otherRespond = vi.fn().mockResolvedValue(true);
  act(() => useStore.setState({ computer: "srv2", client: { pending: vi.fn(() => new Promise(() => {})), respondApproval: otherRespond } as unknown as RpcClient }));
  const list = document.querySelector<HTMLElement>(".list")!;
  await act(async () => void fireEvent.keyDown(list, { key: "y" }));
  expect(otherRespond).not.toHaveBeenCalledWith("s", "h1", expect.anything());
});
