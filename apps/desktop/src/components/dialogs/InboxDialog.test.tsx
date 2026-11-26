import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UserInputRequest } from "../../gen";
import type { RpcClient } from "../../lib/rpc";
import { emptyTranscript, useStore } from "../../state/store";
import { useModInbox } from "../../mods/inbox";
import { slots } from "../../mods/registry";
import { InboxDialog } from "./InboxDialog";

beforeEach(() => useModInbox.setState({ items: [] }));
afterEach(cleanup);

it("n dismisses a waiting question, telling the agent the user declined", async () => {
  const req: UserInputRequest = {
    id: "r1", session_id: "s", turn_id: null, item_id: null, created_at: "2026-10-01T00:00:00Z",
    questions: [{ id: "q", header: "Color", question: "Red or blue?", options: [{ label: "Red", description: null }], multi_select: false, allow_free_text: true, secret: false }],
  };
  const respondInput = vi.fn().mockResolvedValue(true);
  const respondApproval = vi.fn().mockResolvedValue(true);
  const pending = vi.fn().mockResolvedValue({ approvals: [], inputs: [req] });
  useStore.setState({
    client: { respondInput, respondApproval, pending } as unknown as RpcClient,
    transcripts: { s: { ...emptyTranscript(), loaded: true, inputs: { r1: req } } },
  });
  render(<InboxDialog />);
  expect(screen.getByText("Red or blue?")).toBeTruthy();
  const list = document.querySelector<HTMLElement>(".list")!;
  // y on a question does nothing: it is answered on its card.
  await act(async () => void fireEvent.keyDown(list, { key: "y" }));
  expect(respondInput).not.toHaveBeenCalled();
  await act(async () => void fireEvent.keyDown(list, { key: "n" }));
  expect(respondInput).toHaveBeenCalledWith("s", { request_id: "r1", answers: {}, declined: true });
  expect(respondApproval).not.toHaveBeenCalled();
  expect(screen.queryByText("Red or blue?")).toBeNull();
});

it("lists the unread items mods put in the inbox, latest first, and opens one through its mod", async () => {
  const open = vi.fn();
  const off = slots.inboxRenderer.register("render-mod", "inbox", {
    component: ({ item }) => <span className="test-inbox-item">{`Rendered: ${item.title}`}</span>,
    open,
  });
  try {
    useStore.setState({
      client: { pending: vi.fn().mockResolvedValue({ approvals: [], inputs: [] }) } as unknown as RpcClient,
      transcripts: {},
    });
    useModInbox.setState({ items: [
      { modId: "plain-mod", items: [
        { id: "1", title: "Older news", detail: "from a mod", at: "2026-10-01T00:00:00Z", unread: true },
        { id: "2", title: "Already read", at: "2026-10-03T00:00:00Z", unread: false },
      ] },
      { modId: "render-mod", items: [{ id: "3", title: "Newer news", at: "2026-10-02T00:00:00Z", unread: true }] },
    ] });
    render(<InboxDialog />);
    // The daemon's (empty) pending list arrives.
    await act(async () => {});
    const titles = [...document.querySelectorAll(".inbox-row")].map((el) => el.querySelector(".test-inbox-item, .inbox-title")?.textContent);
    expect(titles).toEqual(["Rendered: Newer news", "Older news"]);
    // Without a renderer, the mod's name, title and detail.
    expect(screen.getByText("plain-mod")).toBeTruthy();
    expect(screen.getByText("from a mod")).toBeTruthy();
    expect(screen.queryByText("Already read")).toBeNull();

    const list = document.querySelector<HTMLElement>(".list")!;
    await act(async () => void fireEvent.keyDown(list, { key: "Enter" }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: "3", title: "Newer news" }));
  } finally {
    cleanup();
    off();
  }
});
