import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Session } from "../gen";
import type { RpcClient } from "../lib/rpc";
import { useStore } from "../state/store";
import { updateDraft, useComposerDrafts } from "../state/composerDrafts";
import { Composer } from "./Composer";

const send = vi.fn().mockResolvedValue(undefined);
function session(id: string): Session {
  return { id, title: id, provider: "claude", agent: null, native_id: null, cwd: "/tmp", worktree: null, group: null, status: "idle", mode: "structured", model: null, effort: null, permission_mode: null, sandbox_mode: null, command: null, created_at: "", last_activity: "", archived: false, pinned: false, last_error: null, pending_count: 0, exit_code: null, system_prompt: null, orchestrator: false, orchestrator_id: null, usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, total_cost_usd: null, context_window: null, context_used: null } };
}
beforeEach(() => {
  send.mockReset().mockResolvedValue(undefined);
  useComposerDrafts.setState({ drafts: {} });
  useStore.setState({ sessions: { a: session("a"), b: session("b") }, providers: [], client: { send } as unknown as RpcClient });
});
afterEach(cleanup);

it("restores separate drafts, attachments and selection when switching sessions", () => {
  updateDraft("a", () => ({ images: [{ data: "test", path: null, media_type: "image/png" }] }));
  const { rerender } = render(<Composer key="a" sessionId="a" />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "unfinished first draft" } });
  const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
  textarea.focus();
  textarea.setSelectionRange(3, 8);
  fireEvent.select(textarea);
  rerender(<Composer key="b" sessionId="b" />);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  expect(screen.queryByTitle("remove")).toBeNull();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "second draft" } });
  rerender(<Composer key="a" sessionId="a" />);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("unfinished first draft");
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).selectionStart).toBe(3);
  expect(screen.getByTitle("remove")).toBeTruthy();
  expect(useComposerDrafts.getState().drafts.b.text).toBe("second draft");
});

it("clears only the sent session after switching while a send is pending", async () => {
  let finish!: () => void;
  send.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const { rerender } = render(<Composer key="a" sessionId="a" />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "send me" } });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  rerender(<Composer key="b" sessionId="b" />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "keep me" } });
  await act(async () => finish());
  expect(useComposerDrafts.getState().drafts.a.text).toBe("");
  expect(useComposerDrafts.getState().drafts.b.text).toBe("keep me");
});

it("keeps the draft after a failed send", async () => {
  send.mockRejectedValueOnce(new Error("offline"));
  render(<Composer sessionId="a" />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "do not lose this" } });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  await waitFor(() => expect(useComposerDrafts.getState().drafts.a.sending).toBe(false));
  expect(useComposerDrafts.getState().drafts.a.text).toBe("do not lose this");
});
