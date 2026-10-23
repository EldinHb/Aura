import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilitySet, ProviderInfo, Session } from "../gen";
import type { DraftImage } from "../lib/images";
import type { RpcClient } from "../lib/rpc";
import { defaultSettings, useStore } from "../state/store";
import { updateDraft, useComposerDrafts } from "../state/composerDrafts";
import { Composer, richInputReady } from "./Composer";

// jsdom cannot decode images, so attaching skips the thumbnail step.
vi.mock("../lib/images", async (orig) => {
  const real = await orig<typeof import("../lib/images")>();
  return { ...real, prepareImage: async (file: File) => image(file.name) };
});

// jsdom has no layout; the editor measures text ranges to scroll the caret into view.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
// Nor `isContentEditable`, by which the global keymap knows the rich editor is a text field.
Object.defineProperty(HTMLElement.prototype, "isContentEditable", { configurable: true, get(this: HTMLElement) { return this.closest("[contenteditable]")?.getAttribute("contenteditable") === "true"; } });

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
  return { id, title: id, provider: "claude", agent: null, native_id: null, cwd: "/tmp", worktree: null, group: null, status: "idle", mode: "structured", model: null, effort: null, permission_mode: null, sandbox_mode: null, command: null, created_at: "", last_activity: "", archived: false, pinned: false, last_error: null, pending_count: 0, exit_code: null, system_prompt: null, orchestrator: false, orchestrator_id: null, folderless: false, attention: null, pulls: [], usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, total_cost_usd: null, context_window: null, context_used: null, running_totals: false } };
}
beforeEach(async () => {
  await richInputReady;
  send.mockReset().mockResolvedValue(undefined);
  useComposerDrafts.setState({ drafts: {} });
  toast.mockReset();
  useStore.setState({ sessions: { a: session("a"), b: session("b") }, providers: [provider(true)], toast, client: { send } as unknown as RpcClient, settings: { ...defaultSettings, composerRich: false } });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

/** A send that goes out when `finish` is called. */
function pendingSend() {
  const pending = { finish: () => {}, fail: (_e: Error) => {} };
  send.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { pending.finish = resolve; pending.fail = reject; }));
  return pending;
}

it("clears only the sent session after switching while a send is pending", async () => {
  const pending = pendingSend();
  const { rerender } = render(<Composer key="a" sessionId="a" />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "send me" } });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  rerender(<Composer key="b" sessionId="b" />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "keep me" } });
  await waitFor(() => expect(send).toHaveBeenCalled());
  await act(async () => pending.finish());
  expect(useComposerDrafts.getState().drafts.a.text).toBe("");
  expect(useComposerDrafts.getState().drafts.b.text).toBe("keep me");
});

it("gives a message that failed to send back, ahead of what was typed since", async () => {
  const pending = pendingSend();
  updateDraft("a", () => ({ images: [image("sent.png")] }));
  render(<Composer sessionId="a" />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "do not lose this" } });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "next one" } });
  await waitFor(() => expect(send).toHaveBeenCalled());
  await act(async () => pending.fail(new Error("offline")));
  const draft = useComposerDrafts.getState().drafts.a;
  expect(draft.sending).toBe(0);
  expect(draft.text).toBe("do not lose this\n\nnext one");
  expect(draft.images.map((i) => i.name)).toEqual(["sent.png"]);
  expect(toast).toHaveBeenCalledWith("send: offline", "error");
});

it("gives failed messages back in the order they were sent, ahead of what was typed since, holding back the ones behind a failure", async () => {
  const first = pendingSend();
  updateDraft("a", () => ({ images: [image("one.png")] }));
  render(<Composer sessionId="a" />);
  const box = () => screen.getByRole("textbox");
  fireEvent.change(box(), { target: { value: "first" } });
  fireEvent.keyDown(box(), { key: "Enter" });
  act(() => updateDraft("a", () => ({ images: [image("two.png")] })));
  fireEvent.change(box(), { target: { value: "second" } });
  fireEvent.keyDown(box(), { key: "Enter" });
  fireEvent.change(box(), { target: { value: "new typing" } });
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  await act(async () => first.fail(new Error("offline")));
  await waitFor(() => expect(useComposerDrafts.getState().drafts.a.sending).toBe(0));
  const draft = useComposerDrafts.getState().drafts.a;
  expect(draft.text).toBe("first\n\nsecond\n\nnew typing");
  expect(draft.images.map((i) => i.name)).toEqual(["one.png", "two.png"]);
  // `second` would have arrived without `first`.
  expect(send).toHaveBeenCalledTimes(1);
});

it("gives back a message that failed after the one before it went out", async () => {
  const first = pendingSend();
  const second = pendingSend();
  render(<Composer sessionId="a" />);
  const box = () => screen.getByRole("textbox");
  for (const text of ["first", "second"]) {
    fireEvent.change(box(), { target: { value: text } });
    fireEvent.keyDown(box(), { key: "Enter" });
  }
  fireEvent.change(box(), { target: { value: "new typing" } });
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  await act(async () => first.finish());
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  await act(async () => second.fail(new Error("offline")));
  await waitFor(() => expect(useComposerDrafts.getState().drafts.a.text).toBe("second\n\nnew typing"));
});

it("retries a draft of only images", async () => {
  useStore.setState({ sessions: { a: { ...session("a"), status: "error", last_error: "boom" }, b: session("b") } });
  updateDraft("a", () => ({ images: [image("only.png")] }));
  render(<Composer sessionId="a" />);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(send).toHaveBeenCalled());
  expect(send.mock.calls[0][1].images[0]).toMatchObject({ name: "only.png" });
});

describe("the app's focus and the keyboard agree", () => {
  it("follows the keyboard out of the box to another part of the app", () => {
    useStore.setState({ focus: "composer" });
    render(<><div data-region="main"><button>Window</button></div><Composer sessionId="a" /></>);
    act(() => screen.getByRole("textbox").focus());
    expect(useStore.getState().focus).toBe("composer");
    act(() => screen.getByRole("button", { name: "Window" }).focus());
    expect(useStore.getState().focus).toBe("main");
  });

  it.each([true, false])("takes the keyboard back when the box loses it to the page while the app's focus is on it (rich: %s)", async (composerRich) => {
    // jsdom says the page has no focus when nothing in it has; a window in front says it has.
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    useStore.setState({ focus: "composer", settings: { ...defaultSettings, composerRich } });
    render(<Composer sessionId="a" />);
    act(() => screen.getByRole("textbox").focus());
    // After the frame in which a box that mounts takes the keyboard back itself.
    await act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));
    act(() => screen.getByRole("textbox").blur());
    expect(document.activeElement).toBe(document.body);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox")));
    // Not when the app's focus went elsewhere on purpose (Escape).
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    await new Promise((r) => setTimeout(r, 50));
    expect(document.activeElement).not.toBe(screen.getByRole("textbox"));
  });
});

describe("taking the keyboard back never takes it from what has it by then", () => {
  it.each([
    ["a dialog", null, "composer"],
    ["the sidebar filter", "sidebar", "sidebar"],
  ] as const)("%s, opened in the frame after the box lost the keyboard (rich)", async (_name, region, focusAfter) => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    useStore.setState({ focus: "composer", settings: { ...defaultSettings, composerRich: true } });
    const other = <input aria-label="Other" />;
    render(<>{region ? <div data-region={region}>{other}</div> : <div role="dialog">{other}</div>}<Composer sessionId="a" /></>);
    const box = screen.getByRole("textbox", { name: "Message" });
    act(() => box.focus());
    await act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));
    act(() => box.blur());
    // Registered after the box's own check for the same frame: the other field opens then.
    requestAnimationFrame(() => screen.getByRole("textbox", { name: "Other" }).focus());
    for (let i = 0; i < 3; i++) await act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Other" }));
    expect(useStore.getState().focus).toBe(focusAfter);
  });
});

it.each([true, false])("keeps the keyboard while a message goes out, and keys typed then are text, not shortcuts (rich: %s)", async (composerRich) => {
  const { useKeyboard } = await import("../hooks/useKeyboard");
  function Keys() {
    useKeyboard();
    return null;
  }
  useStore.setState({ settings: { ...defaultSettings, composerRich }, focus: "composer", hintMode: false });
  const first = pendingSend();
  const second = pendingSend();
  render(<><Keys /><Composer sessionId="a" /></>);
  const box = () => screen.getByRole("textbox");
  act(() => box().focus());
  // The box is never made non-editable on the way, nor does it lose the keyboard: WebKit (the app's web view)
  // does not take typing again in a contenteditable that was off and on again while focused, though it stays focused.
  const changes: string[] = [];
  const watch = new MutationObserver((records) => records.forEach((r) => changes.push(`${r.attributeName}=${(r.target as Element).getAttribute(r.attributeName!)}`)));
  watch.observe(document.querySelector(".composer")!, { attributes: true, subtree: true, attributeFilter: ["contenteditable", "disabled"] });
  const blurs = vi.fn();
  box().addEventListener("blur", blurs);
  const typeIn = (text: string) => {
    if (!composerRich) return fireEvent.change(box(), { target: { value: (box() as HTMLTextAreaElement).value + text } });
    // What the keyboard does: a keydown the app may take, then the text, unless the keydown was prevented.
    for (const ch of text) {
      if (!fireEvent.keyDown(box(), { key: ch })) continue;
      const view = (box() as unknown as { editor: { view: { state: { selection: { from: number }; tr: { insertText: (t: string, from: number) => unknown } }; dispatch: (tr: unknown) => void } } }).editor.view;
      act(() => view.dispatch(view.state.tr.insertText(ch, view.state.selection.from)));
    }
  };
  typeIn("one");
  fireEvent.keyDown(box(), { key: "Enter" });
  expect(document.activeElement).toBe(box());
  expect(useComposerDrafts.getState().drafts.a.text).toBe("");
  // `f` is the hint mode key outside a text field.
  typeIn("fix");
  expect(useStore.getState().hintMode).toBe(false);
  expect(useComposerDrafts.getState().drafts.a.text).toBe("fix");
  expect(screen.getByRole("status").textContent).toContain("Sending");
  // A second message while the first is on its way goes after it.
  fireEvent.keyDown(box(), { key: "Enter" });
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  await act(async () => first.finish());
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(send.mock.calls.map((c) => c[1].text)).toEqual(["one", "fix"]);
  await act(async () => second.finish());
  expect(document.activeElement).toBe(box());
  expect(useComposerDrafts.getState().drafts.a.sending).toBe(0);
  expect(screen.queryByRole("status")).toBeNull();
  await act(async () => {});
  expect(changes.concat(watch.takeRecords().map((r) => String(r.attributeName)))).toEqual([]);
  expect(blurs).not.toHaveBeenCalled();
  watch.disconnect();
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
  expect(thumbs()).toHaveLength(0);
  await waitFor(() => expect(send).toHaveBeenCalled());
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

describe("rich composer", () => {
  type View = { dom: HTMLElement; state: { selection: { from: number; to: number }; tr: { insertText: (t: string, from?: number, to?: number) => unknown } }; dispatch: (tr: unknown) => void; someProp: (name: string, f: (fn: (...args: unknown[]) => boolean) => boolean) => boolean };
  type Ed = { view: View; getText: () => string; isEditable: boolean; state: { doc: { child: (i: number) => { type: { name: string } }; childCount: number } } };
  const box = () => screen.getByRole("textbox");
  const editor = () => (box() as unknown as { editor: Ed }).editor;
  /** Types like a user: each character goes through the editor's input rules. */
  const type = (text: string) => act(() => {
    for (const ch of text) {
      const view = editor().view;
      const { from, to } = view.state.selection;
      if (!view.someProp("handleTextInput", (f) => f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)))) view.dispatch(view.state.tr.insertText(ch, from, to));
    }
  });
  const key = (k: string, init: Partial<KeyboardEventInit> = {}) => act(() => { fireEvent.keyDown(box(), { key: k, ...init }); });
  const paste = (text: string) => act(() => { fireEvent.paste(box(), { clipboardData: { items: [], types: ["text/plain"], getData: (t: string) => (t === "text/plain" ? text : "") } }); });
  const sent = () => send.mock.calls.at(-1)?.[1].text;
  beforeEach(() => {
    useStore.setState({ settings: { ...defaultSettings, composerRich: true } });
    // jsdom keeps the page's selection from test to test; the editor would read it back.
    document.getSelection()?.removeAllRanges();
  });

  it("formats markdown as it is typed and sends it as markdown", async () => {
    render(<Composer sessionId="a" />);
    type("# Title");
    expect(editor().state.doc.child(0).type.name).toBe("heading");
    key("Enter", { shiftKey: true });
    type("Some **bold** and `code` and *em*");
    expect(box().querySelector("strong")?.textContent).toBe("bold");
    expect(box().querySelector("code")?.textContent).toBe("code");
    expect(box().querySelector("em")?.textContent).toBe("em");
    key("Enter", { shiftKey: true });
    type("- one");
    key("Enter", { shiftKey: true });
    type("two");
    expect(box().querySelectorAll("ul li")).toHaveLength(2);
    key("Enter", { shiftKey: true });
    key("Enter", { shiftKey: true });
    type("> quoted");
    expect(box().querySelector("blockquote")?.textContent).toBe("quoted");
    key("Enter");
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(sent()).toBe("# Title\n\nSome **bold** and `code` and *em*\n\n- one\n- two\n\n> quoted");
  });

  it("sends plain text as typed, escaping only what markdown would read as something else, with Shift+Enter a line break", async () => {
    render(<Composer sessionId="a" />);
    const text = "2 * 3 * 4 = 24, snake_case_name, a_b_c, #tag, 50% off, [x] and \\* stays";
    type(text);
    key("Enter", { shiftKey: true });
    type("second line");
    key("Enter", { shiftKey: true });
    key("Enter", { shiftKey: true });
    type("after a blank line");
    key("Enter");
    await waitFor(() => expect(send).toHaveBeenCalled());
    // The typed backslash before `*` is one: `\\*` reads back as the `\*` typed.
    // Shift+Enter is a line break, twice a blank line, as in the markdown textbox.
    expect(sent()).toBe(`${text.replace("\\*", "\\\\*")}\nsecond line\n\nafter a blank line`);
  });

  it("makes a code block from a fence and keeps its code as typed", async () => {
    render(<Composer sessionId="a" />);
    type("```ts ");
    expect(editor().state.doc.child(0).type.name).toBe("codeBlock");
    type("const a = **b**;");
    key("Enter", { shiftKey: true });
    type("  // # not a heading");
    key("Enter");
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(sent()).toBe("```ts\nconst a = **b**;\n  // # not a heading\n```");
  });

  it("formats pasted markdown and sends it back the same", async () => {
    render(<Composer sessionId="a" />);
    const md = "## Plan\n\n1. first `step`\n2. second\n\n```sh\npnpm test\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |";
    paste(md);
    expect(box().querySelector("ol")).toBeTruthy();
    expect(box().querySelector("pre")?.textContent).toBe("pnpm test");
    expect(box().querySelector("table td")?.textContent).toBe("1");
    key("Enter");
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(sent()).toBe("## Plan\n\n1. first `step`\n2. second\n\n```sh\npnpm test\n```\n\n\n| a   | b   |\n| --- | --- |\n| 1   | 2   |");
  });

  it("starts a list on a line made with Shift+Enter, as the markdown would", async () => {
    render(<Composer sessionId="a" />);
    type("intro");
    key("Enter", { shiftKey: true });
    type("- item");
    expect(box().querySelector("ul li")?.textContent).toBe("item");
    expect(box().querySelector("p")?.textContent).toBe("intro");
    key("Enter");
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(sent()).toBe("intro\n\n- item");
  });

  it.each([["- ", "ul", "intro\n\\- "], ["1. ", "ol", "intro\n1\\. "]])("takes %s typed after a line break back to the line break with Backspace, in one step", (marker, list, markdown) => {
    render(<Composer sessionId="a" />);
    type("intro");
    key("Enter", { shiftKey: true });
    type(marker);
    expect(box().querySelector(list)).toBeTruthy();
    key("Backspace");
    expect(box().querySelector(list)).toBeNull();
    expect(editor().state.doc.childCount).toBe(1);
    expect(box().querySelector("p br")).toBeTruthy();
    // What the box shows, a line break and the marker as text.
    expect(useComposerDrafts.getState().drafts.a.text).toBe(markdown);
  });

  it("starts an ordered list after a line break only at 1., as markdown does", async () => {
    render(<Composer sessionId="a" />);
    type("intro");
    key("Enter", { shiftKey: true });
    type("2020. was a year");
    expect(box().querySelector("ol")).toBeNull();
    key("Enter");
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(sent()).toBe("intro\n2020\\. was a year");
  });

  it("keeps HTML in a draft as written when switching from plain markdown", () => {
    useStore.setState({ settings: { ...defaultSettings, composerRich: false } });
    const html = '<div class="x">hello</div>\n\n<!-- keep me -->';
    updateDraft("a", () => ({ text: html }));
    render(<Composer sessionId="a" />);
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    expect(box().textContent).toContain('<div class="x">hello</div>');
    expect(box().textContent).toContain("<!-- keep me -->");
    expect(useComposerDrafts.getState().drafts.a.text).toBe(html);
    type("!");
    expect(useComposerDrafts.getState().drafts.a.text).toBe(`${html}!`);
  });

  it("switches to plain markdown and back without losing the draft, and remembers the choice", () => {
    render(<Composer sessionId="a" />);
    type("**bold** text");
    fireEvent.click(screen.getByRole("button", { name: "Rich text" }));
    expect(useStore.getState().settings.composerRich).toBe(false);
    const ta = box() as HTMLTextAreaElement;
    expect(ta.tagName).toBe("TEXTAREA");
    expect(ta.value).toBe("**bold** text");
    fireEvent.change(ta, { target: { value: "**bold** text\n- item" } });
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    expect(box().querySelector("strong")?.textContent).toBe("bold");
    expect(box().querySelector("li")?.textContent).toBe("item");
    expect(useComposerDrafts.getState().drafts.a.text).toBe("**bold** text\n- item");
  });

  it("goes through sent messages with the arrows", async () => {
    render(<Composer sessionId="a" />);
    type("first message");
    key("Enter");
    await waitFor(() => expect(useComposerDrafts.getState().drafts.a.text).toBe(""));
    type("draft");
    key("ArrowUp");
    expect(editor().getText()).toBe("first message");
    key("ArrowDown");
    expect(editor().getText()).toBe("draft");
  });

  it("completes slash commands and file mentions", async () => {
    const commands = vi.fn().mockResolvedValue([{ name: "review", description: "Review", source: null }]);
    const searchFiles = vi.fn().mockResolvedValue(["src/views/Composer.tsx"]);
    useStore.setState({ client: { send, commands, searchFiles } as unknown as RpcClient });
    render(<Composer sessionId="a" />);
    type("/rev");
    await screen.findByText("/review");
    key("Enter");
    expect(useComposerDrafts.getState().drafts.a.text).toBe("/review ");
    type("look at @Comp");
    await screen.findByText("src/views/Composer.tsx");
    key("Enter");
    expect(useComposerDrafts.getState().drafts.a.text).toBe("/review look at @src/views/Composer.tsx ");
    expect(send).not.toHaveBeenCalled();
  });

  it("attaches pasted images instead of pasting them, and backspace takes the last one off", async () => {
    render(<Composer sessionId="a" />);
    act(() => { fireEvent.paste(box(), { clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => new File(["x"], "p.png", { type: "image/png" }) }], types: ["Files"], getData: () => "" } }); });
    await waitFor(() => expect(thumbs()).toHaveLength(1));
    expect(editor().getText()).toBe("");
    key("Backspace");
    expect(useComposerDrafts.getState().drafts.a.images).toHaveLength(0);
  });

  it("keeps each session's draft and caret", () => {
    const { rerender } = render(<Composer key="a" sessionId="a" />);
    type("draft for a");
    rerender(<Composer key="b" sessionId="b" />);
    expect(editor().getText()).toBe("");
    rerender(<Composer key="a" sessionId="a" />);
    expect(editor().getText()).toBe("draft for a");
    expect(editor().view.state.selection.from).toBe(12);
  });

  it("Escape hands the keyboard to the transcript", () => {
    render(<Composer sessionId="a" />);
    act(() => box().focus());
    key("Escape");
    expect(document.activeElement).not.toBe(box());
  });

  it("interrupts with Ctrl+C when empty", () => {
    const interrupt = vi.fn().mockResolvedValue(undefined);
    useStore.setState({ client: { send, interrupt } as unknown as RpcClient });
    render(<Composer sessionId="a" />);
    key("c", { ctrlKey: true });
    expect(interrupt).toHaveBeenCalledWith("a");
  });
});

it.each([true, false])("does not send on the Enter that ends an input method composition (rich: %s)", (composerRich) => {
  useStore.setState({ settings: { ...defaultSettings, composerRich } });
  render(<Composer sessionId="a" />);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", isComposing: true });
  updateDraft("a", () => ({ text: "かな" }));
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", isComposing: true });
  expect(send).not.toHaveBeenCalled();
});
