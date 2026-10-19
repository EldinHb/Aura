import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { UserInputRequest } from "../../gen";
import type { RpcClient } from "../../lib/rpc";
import { emptyTranscript, useStore } from "../../state/store";
import { usePullChanges } from "../../features/reviews/changes";
import { InboxDialog } from "./InboxDialog";

afterEach(cleanup);

it("n dismisses a waiting question, telling the agent the user declined", async () => {
  const req: UserInputRequest = {
    id: "r1", session_id: "s", turn_id: null, item_id: null, created_at: "2026-10-01T00:00:00Z",
    questions: [{ id: "q", header: "Color", question: "Red or blue?", options: [{ label: "Red", description: null }], multi_select: false, allow_free_text: true, secret: false }],
  };
  const respondInput = vi.fn().mockResolvedValue(true);
  const respondApproval = vi.fn().mockResolvedValue(true);
  const pending = vi.fn().mockResolvedValue({ approvals: [], inputs: [req] });
  usePullChanges.setState({ changes: [], refresh: vi.fn().mockResolvedValue(undefined) } as never);
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
