import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CapabilitySet, ProviderInfo, Session } from "../gen";
import type { DraftImage } from "../lib/images";
import type { RpcClient } from "../lib/rpc";
import { useStore } from "../state/store";
import { updateDraft, useComposerDrafts } from "../state/composerDrafts";
import { Composer } from "./Composer";

// jsdom cannot decode images, so attaching skips the thumbnail step.
vi.mock("../lib/images", async (orig) => {
  const real = await orig<typeof import("../lib/images")>();
  return { ...real, prepareImage: async (file: File) => image(file.name) };
});

const send = vi.fn().mockResolvedValue(undefined);
const toast = vi.fn();
let n = 0;
function image(name = "shot.png"): DraftImage {
  return { key: `t${++n}`, blob: new Blob(["png-bytes"], { type: "image/png" }), name, media_type: "image/png", width: 800, height: 600, thumbnail: "data:image/png;base64,AAAA" };
}
function provider(images: boolean): ProviderInfo {
  const capabilities = { images, permission_modes: [], sandbox_modes: [] } as unknown as CapabilitySet;
  return { kind: "claude", display_name: "Claude Code", available: true, version: null, binary: null, capabilities, agents: [] };
}
function pasteImages(count: number) {
  const items = Array.from({ length: count }, (_, i) => ({ kind: "file", type: "image/png", getAsFile: () => new File(["x"], `p${i}.png`, { type: "image/png" }) }));
  fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { items } });
}
const thumbs = () => screen.queryAllByRole("button", { name: /^Open / });
function session(id: string): Session {
  return { id, title: id, provider: "claude", agent: null, native_id: null, cwd: "/tmp", worktree: null, group: null, status: "idle", mode: "structured", model: null, effort: null, permission_mode: null, sandbox_mode: null, command: null, created_at: "", last_activity: "", archived: false, pinned: false, last_error: null, pending_count: 0, exit_code: null, system_prompt: null, orchestrator: false, orchestrator_id: null, folderless: false, attention: null, pulls: [], usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, total_cost_usd: null, context_window: null, context_used: null } };
}
beforeEach(() => {
  send.mockReset().mockResolvedValue(undefined);
  useComposerDrafts.setState({ drafts: {} });
  toast.mockReset();
  useStore.setState({ sessions: { a: session("a"), b: session("b") }, providers: [provider(true)], toast, client: { send } as unknown as RpcClient });
});
afterEach(cleanup);

it("restores separate drafts, attachments and selection when switching sessions", () => {
  updateDraft("a", () => ({ images: [image()] }));
  const { rerender } = render(<Composer key="a" sessionId="a" />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "unfinished first draft" } });
  const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
  textarea.focus();
  textarea.setSelectionRange(3, 8);
  fireEvent.select(textarea);
  rerender(<Composer key="b" sessionId="b" />);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  expect(thumbs()).toHaveLength(0);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "second draft" } });
  rerender(<Composer key="a" sessionId="a" />);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("unfinished first draft");
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).selectionStart).toBe(3);
  expect(thumbs()).toHaveLength(1);
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

it("shows a thumbnail per pasted image and removes one with its button", async () => {
  render(<Composer sessionId="a" />);
  pasteImages(4);
  await waitFor(() => expect(thumbs()).toHaveLength(4));
  expect(thumbs()[0].querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  expect(thumbs()[0].title).toContain("800 × 600");
  fireEvent.click(screen.getByRole("button", { name: /^Remove p1\.png/ }));
  expect(useComposerDrafts.getState().drafts.a.images.map((i) => i.name)).toEqual(["p0.png", "p2.png", "p3.png"]);
});

it("attaches dropped images and leaves other files out", async () => {
  render(<Composer sessionId="a" />);
  const files = [new File(["x"], "a.png", { type: "image/png" }), new File(["x"], "notes.txt", { type: "text/plain" })];
  fireEvent.drop(screen.getByRole("textbox"), { dataTransfer: { types: ["Files"], files } });
  await waitFor(() => expect(thumbs()).toHaveLength(1));
  expect(toast).toHaveBeenCalledWith(expect.stringContaining("notes.txt"), "warn");
});

it("removes the last image on backspace only when the textbox is empty", () => {
  updateDraft("a", () => ({ images: [image("one.png"), image("two.png")] }));
  render(<Composer sessionId="a" />);
  const textarea = screen.getByRole("textbox");
  fireEvent.change(textarea, { target: { value: "x" } });
  fireEvent.keyDown(textarea, { key: "Backspace" });
  expect(useComposerDrafts.getState().drafts.a.images).toHaveLength(2);
  fireEvent.change(textarea, { target: { value: "" } });
  fireEvent.keyDown(textarea, { key: "Backspace" });
  expect(useComposerDrafts.getState().drafts.a.images.map((i) => i.name)).toEqual(["one.png"]);
});

it("removes a focused thumbnail with Delete", () => {
  updateDraft("a", () => ({ images: [image("one.png"), image("two.png")] }));
  render(<Composer sessionId="a" />);
  fireEvent.keyDown(thumbs()[0], { key: "Delete" });
  expect(useComposerDrafts.getState().drafts.a.images.map((i) => i.name)).toEqual(["two.png"]);
});

it("sends the images with their previews and clears the strip", async () => {
  updateDraft("a", () => ({ images: [image()] }));
  render(<Composer sessionId="a" />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "look" } });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  await waitFor(() => expect(thumbs()).toHaveLength(0));
  const input = send.mock.calls[0][1];
  expect(input.text).toBe("look");
  expect(input.images[0]).toMatchObject({ data: btoa("png-bytes"), media_type: "image/png", name: "shot.png", width: 800, height: 600, thumbnail: "data:image/png;base64,AAAA" });
});

it("says so when the agent does not take images", async () => {
  useStore.setState({ providers: [provider(false)] });
  render(<Composer sessionId="a" />);
  pasteImages(1);
  await waitFor(() => expect(toast).toHaveBeenCalledWith("Claude Code does not accept images", "warn"));
  expect(thumbs()).toHaveLength(0);
});

it("marks images that will be shrunk and blocks ones that cannot be", async () => {
  const retina = { ...image("retina.png"), width: 5120, height: 2880 };
  updateDraft("a", () => ({ images: [retina] }));
  render(<Composer sessionId="a" />);
  expect(thumbs()[0].title).toContain("will be sent resized to 2000 × 1125");
  expect(thumbs()[0].textContent).toContain("resized");

  // Too big to send and not decodable, so it cannot be shrunk.
  const broken = { ...image("broken.png"), width: null, height: null, blob: new Blob([new Uint8Array(4_000_000)], { type: "image/png" }) };
  act(() => updateDraft("a", () => ({ images: [broken] })));
  expect(thumbs()[0].textContent).toContain("too large");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "look" } });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/broken\.png is over the 5 MB.*remove it to send/), "warn"));
  expect(send).not.toHaveBeenCalled();
  expect(useComposerDrafts.getState().drafts.a.images).toHaveLength(1);
});

it("while a question waits, the message box says which key goes to it; the question never takes the keyboard from it", async () => {
  const { useKeyboard } = await import("../hooks/useKeyboard");
  const { defaultSettings, emptyTranscript } = await import("../state/store");
  function Keys() {
    useKeyboard();
    return null;
  }
  useStore.setState({ settings: { ...defaultSettings }, focus: "main", transcripts: { a: emptyTranscript() } });
  render(<><Keys /><Composer sessionId="a" /></>);
  const hint = () => screen.queryByText("The agent has a question", { exact: false });
  act(() => screen.getByRole("textbox").focus());
  expect(hint()).toBeNull();
  const question = { id: "r1", session_id: "a", turn_id: null, item_id: null, created_at: "", questions: [] };
  act(() => useStore.setState({ transcripts: { a: { ...emptyTranscript(), inputs: { r1: question } } } }));
  expect(hint()!.textContent).toBe(` The agent has a question · Esc go to it`);
  expect(document.activeElement).toBe(screen.getByRole("textbox"));
  // Only while the message box has the keyboard: from elsewhere the card says it itself.
  act(() => useStore.setState({ focus: "sidebar" }));
  expect(hint()).toBeNull();
});

it("shows the context as a share of the window, or as tokens until the window is known", () => {
  const withUsage = (context_used: number | null, context_window: number | null) =>
    useStore.setState({ sessions: { a: { ...session("a"), usage: { ...session("a").usage, context_used, context_window } } } });
  withUsage(30_000, null);
  const { rerender } = render(<Composer sessionId="a" />);
  expect(screen.getByText("ctx 30.0k")).toBeTruthy();
  withUsage(30_000, 200_000);
  rerender(<Composer sessionId="a" />);
  expect(screen.getByText("ctx 15%")).toBeTruthy();
});
