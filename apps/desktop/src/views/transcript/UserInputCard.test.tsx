import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Question, UserInputRequest } from "../../gen";
import type { RpcClient } from "../../lib/rpc";
import { useStore } from "../../state/store";
import { UserInputCard } from "./UserInputCard";

const respondInput = vi.fn().mockResolvedValue(undefined);
const toast = vi.fn();
function question(id: string, labels: string[], multi_select = false): Question {
  return { id, header: id, question: `Pick ${id}?`, options: labels.map((label) => ({ label, description: null })), multi_select, allow_free_text: true, secret: false };
}
function request(...questions: Question[]): UserInputRequest {
  return { id: "r1", session_id: "s", turn_id: null, item_id: null, questions, created_at: "" };
}
function card() {
  return document.querySelector<HTMLElement>("[data-input-id]")!;
}
const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(card(), { key: k, ...init });

beforeEach(() => {
  respondInput.mockReset().mockResolvedValue(undefined);
  toast.mockReset();
  useStore.setState({ client: { respondInput } as unknown as RpcClient, toast });
});
afterEach(cleanup);

it("takes focus when the question appears", async () => {
  render(<UserInputCard request={request(question("a", ["x", "y"]))} sessionId="s" cursor={false} />);
  await act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));
  expect(document.activeElement).toBe(card());
});

it("answers each question with number keys, moving on after a single pick, then sends on Enter", async () => {
  render(<UserInputCard request={request(question("a", ["a1", "a2"]), question("b", ["b1", "b2"], true), question("c", ["c1", "c2"]))} sessionId="s" cursor={false} />);
  key("2");
  expect(screen.getByText("2/3", { exact: false })).toBeTruthy();
  key("1");
  key("2");
  // Multi-select stays put until Enter moves on.
  expect(screen.getByText("2/3", { exact: false })).toBeTruthy();
  key("Enter");
  expect(screen.getByText("3/3", { exact: false })).toBeTruthy();
  key("1");
  expect(respondInput).not.toHaveBeenCalled();
  await act(async () => void key("Enter"));
  expect(respondInput).toHaveBeenCalledWith("s", { request_id: "r1", answers: { a: ["a2"], b: ["b1", "b2"], c: ["c1"] }, declined: false });
});

it("Enter picks the option under the cursor and sends in one press", async () => {
  render(<UserInputCard request={request(question("a", ["a1", "a2"]))} sessionId="s" cursor={false} />);
  key("ArrowDown");
  await act(async () => void key("Enter"));
  expect(respondInput).toHaveBeenCalledWith("s", { request_id: "r1", answers: { a: ["a2"] }, declined: false });
});

it("moves between questions with arrows and Tab, and keeps earlier answers", async () => {
  render(<UserInputCard request={request(question("a", ["a1", "a2"]), question("b", ["b1", "b2"]))} sessionId="s" cursor={false} />);
  key("ArrowRight");
  key("2");
  key("ArrowLeft");
  expect(screen.getByText("1/2", { exact: false })).toBeTruthy();
  key("Tab", { shiftKey: true });
  expect(screen.getByText("2/2", { exact: false })).toBeTruthy();
  key("Tab");
  // Enter on the first question takes its cursor option; the second is already answered, so it sends.
  await act(async () => void key("Enter"));
  expect(respondInput).toHaveBeenCalledWith("s", { request_id: "r1", answers: { a: ["a1"], b: ["b2"] }, declined: false });
});

it("keeps the keyboard on the card after clicking an option", () => {
  render(<UserInputCard request={request(question("a", ["a1", "a2"]))} sessionId="s" cursor={false} />);
  fireEvent.click(screen.getByText("a2"));
  expect(document.activeElement).toBe(card());
});

const nextFrame = () => act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));
const textField = () => document.querySelector<HTMLInputElement>("input.other-input");

it("choosing Other opens a text field with the keyboard in it, and sends what is typed", async () => {
  render(<UserInputCard request={request(question("a", ["a1"]))} sessionId="s" cursor={false} />);
  expect(textField()).toBeNull();
  fireEvent.click(screen.getByText("Other"));
  expect(document.activeElement).toBe(textField());
  // Keys typed in the field are text, not option hotkeys or app shortcuts.
  const outer = vi.fn();
  document.addEventListener("keydown", outer);
  for (const k of ["1", "j", "x", " ", "i"]) fireEvent.keyDown(textField()!, { key: k });
  document.removeEventListener("keydown", outer);
  expect(outer).not.toHaveBeenCalled();
  expect(screen.getByText("a1").closest("button")!.className).not.toContain("picked");
  fireEvent.change(textField()!, { target: { value: "my own" } });
  await act(async () => void fireEvent.keyDown(textField()!, { key: "Enter" }));
  expect(respondInput).toHaveBeenCalledWith("s", { request_id: "r1", answers: { a: ["my own"] }, declined: false });
});

it("Enter in an empty Other field stays in the field instead of skipping the question", () => {
  render(<UserInputCard request={request(question("a", ["a1"]), question("b", ["b1"]))} sessionId="s" cursor={false} />);
  key("2");
  expect(document.activeElement).toBe(textField());
  fireEvent.keyDown(textField()!, { key: "Enter" });
  expect(document.activeElement).toBe(textField());
  expect(screen.getByText("1/2", { exact: false })).toBeTruthy();
  expect(respondInput).not.toHaveBeenCalled();
});

it("the number key and i open Other too, and Escape in an empty field goes back to the options", () => {
  render(<UserInputCard request={request(question("a", ["a1", "a2"]))} sessionId="s" cursor={false} />);
  key("3");
  expect(document.activeElement).toBe(textField());
  fireEvent.keyDown(textField()!, { key: "Escape" });
  expect(textField()).toBeNull();
  expect(document.activeElement).toBe(card());
  expect(respondInput).not.toHaveBeenCalled();
  key("i");
  expect(document.activeElement).toBe(textField());
});

it("picking an option after typing for Other answers with the option alone", async () => {
  render(<UserInputCard request={request(question("a", ["a1", "a2"]))} sessionId="s" cursor={false} />);
  fireEvent.click(screen.getByText("Other"));
  fireEvent.change(textField()!, { target: { value: "draft" } });
  fireEvent.click(screen.getByText("a2"));
  await act(async () => void key("Enter"));
  expect(respondInput).toHaveBeenCalledWith("s", { request_id: "r1", answers: { a: ["a2"] }, declined: false });
});

it("multi-select sends the picked options and the Other text together", async () => {
  render(<UserInputCard request={request(question("a", ["a1", "a2"], true))} sessionId="s" cursor={false} />);
  key("2");
  key("3");
  expect(document.activeElement).toBe(textField());
  fireEvent.change(textField()!, { target: { value: "also this" } });
  await act(async () => void fireEvent.keyDown(textField()!, { key: "Enter" }));
  expect(respondInput).toHaveBeenCalledWith("s", { request_id: "r1", answers: { a: ["a2", "also this"] }, declined: false });
});

it("uses the agent's own Other option for the typed answer instead of adding a second one", async () => {
  render(<UserInputCard request={request(question("a", ["a1", "Other (please specify)"]))} sessionId="s" cursor={false} />);
  expect(screen.queryByText("Other")).toBeNull();
  fireEvent.click(screen.getByText("Other (please specify)"));
  expect(document.activeElement).toBe(textField());
  fireEvent.change(textField()!, { target: { value: "green" } });
  await act(async () => void fireEvent.keyDown(textField()!, { key: "Enter" }));
  expect(respondInput).toHaveBeenCalledWith("s", { request_id: "r1", answers: { a: ["green"] }, declined: false });
});

it("offers no Other when the agent takes no typed answer", () => {
  render(<UserInputCard request={request({ ...question("a", ["a1"]), allow_free_text: false })} sessionId="s" cursor={false} />);
  expect(screen.queryByText("Other")).toBeNull();
  key("i");
  expect(textField()).toBeNull();
});

it("a question with nothing to choose from starts in its text field, hidden when secret", async () => {
  render(<UserInputCard request={request({ ...question("a", []), secret: true })} sessionId="s" cursor={false} />);
  await nextFrame();
  expect(document.querySelectorAll(".option")).toHaveLength(0);
  expect(document.activeElement).toBe(textField());
  expect(textField()!.type).toBe("password");
});

it("d and the Dismiss button tell the agent the user declined, once however often they are pressed", async () => {
  // The card stays up until the resolved event removes it; a second send in that gap would only fail.
  let finish: () => void = () => {};
  respondInput.mockImplementation(() => new Promise<void>((r) => (finish = r)));
  const { unmount } = render(<UserInputCard request={request(question("a", ["a1"]))} sessionId="s" cursor={false} />);
  key("d");
  key("d");
  fireEvent.click(screen.getByText("Dismiss"));
  await act(async () => finish());
  key("d");
  expect(respondInput).toHaveBeenCalledTimes(1);
  expect(respondInput).toHaveBeenCalledWith("s", { request_id: "r1", answers: {}, declined: true });
  expect(toast).not.toHaveBeenCalled();
  unmount();
  respondInput.mockReset().mockResolvedValue(undefined);
  render(<UserInputCard request={request(question("a", ["a1"]))} sessionId="s" cursor={false} />);
  await act(async () => void fireEvent.click(screen.getByText("Dismiss")));
  expect(respondInput).toHaveBeenCalledWith("s", { request_id: "r1", answers: {}, declined: true });
});

it("a failed dismissal can be tried again", async () => {
  respondInput.mockRejectedValueOnce(new Error("daemon away"));
  render(<UserInputCard request={request(question("a", ["a1"]))} sessionId="s" cursor={false} />);
  await act(async () => void key("d"));
  expect(toast).toHaveBeenCalledWith("dismiss: daemon away", "error");
  await act(async () => void key("d"));
  expect(respondInput).toHaveBeenCalledTimes(2);
});

it("d typed in the Other field is text, not a dismissal", () => {
  render(<UserInputCard request={request(question("a", ["a1"]))} sessionId="s" cursor={false} />);
  key("2");
  fireEvent.keyDown(textField()!, { key: "d" });
  expect(respondInput).not.toHaveBeenCalled();
});

it("is where focus lands when the session's main region is focused, and Escape leaves it for the transcript", async () => {
  const { focusRegionEl, coreCommands } = await import("../../commands/core");
  render(
    <div data-region="main">
      <div className="transcript" data-autofocus tabIndex={0}>
        <UserInputCard request={request(question("a", ["a1"]))} sessionId="s" cursor={false} />
      </div>
    </div>,
  );
  focusRegionEl("main");
  expect(document.activeElement).toBe(card());
  useStore.setState({ focus: "main" });
  await coreCommands.find((c) => c.id === "ui.escape")!.run(undefined);
  expect(document.activeElement).toBe(document.querySelector(".transcript"));
});

it("inside the transcript, the Other field keeps the keyboard after the region notices the focus", async () => {
  const { Transcript } = await import("../Transcript");
  const { emptyTranscript } = await import("../../state/store");
  const req = request(question("a", ["a1"]));
  useStore.setState({ transcripts: { s: { ...emptyTranscript(), loaded: true, inputs: { r1: req } } } });
  render(
    <div data-region="main">
      <Transcript sessionId="s" />
    </div>,
  );
  await nextFrame();
  expect(document.activeElement).toBe(card());
  fireEvent.click(screen.getByText("Other"));
  expect(document.activeElement).toBe(textField());
  await nextFrame();
  await nextFrame();
  expect(document.activeElement).toBe(textField());
});

it("with the app keymap: Escape on the card goes to the transcript and stays, Escape in the Other field goes back to the card", async () => {
  const { useKeyboard } = await import("../../hooks/useKeyboard");
  const { registerCoreCommands } = await import("../../commands/core");
  const { Transcript } = await import("../Transcript");
  const { emptyTranscript } = await import("../../state/store");
  const unregister = registerCoreCommands();
  function Keys() {
    useKeyboard();
    return null;
  }
  useStore.setState({ focus: "main", transcripts: { s: { ...emptyTranscript(), loaded: true, inputs: { r1: request(question("a", ["a1"])) } } } });
  render(
    <div data-region="main">
      <Keys />
      <Transcript sessionId="s" />
    </div>,
  );
  await nextFrame();
  expect(document.activeElement).toBe(card());
  key("2");
  expect(document.activeElement).toBe(textField());
  fireEvent.keyDown(textField()!, { key: "Escape" });
  expect(document.activeElement).toBe(card());
  fireEvent.keyDown(card(), { key: "Escape" });
  expect(document.activeElement).toBe(document.querySelector(".transcript"));
  await nextFrame();
  await nextFrame();
  expect(document.activeElement).toBe(document.querySelector(".transcript"));
  expect(respondInput).not.toHaveBeenCalled();
  unregister();
});

it("multi-select: turning Other off by click gives the keyboard back to the card", () => {
  render(<UserInputCard request={request(question("a", ["a1"], true))} sessionId="s" cursor={false} />);
  fireEvent.click(screen.getByText("Other"));
  expect(document.activeElement).toBe(textField());
  fireEvent.click(screen.getByText("Other"));
  expect(textField()).toBeNull();
  expect(document.activeElement).toBe(card());
});

it("multi-select: an open but empty Other is not dropped next to picked options", async () => {
  render(<UserInputCard request={request(question("a", ["a1", "a2"], true))} sessionId="s" cursor={false} />);
  key("1");
  key("3");
  fireEvent.click(screen.getByText("Answer"));
  expect(respondInput).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith("Type your “Other” answer to “a”, or untick Other", "warn");
  expect(document.activeElement).toBe(textField());
  fireEvent.click(screen.getByText("Other"));
  await act(async () => void fireEvent.click(screen.getByText("Answer")));
  expect(respondInput).toHaveBeenCalledWith("s", { request_id: "r1", answers: { a: ["a1"] }, declined: false });
});

it("single-select: an open but empty Other is not an answer either", () => {
  render(<UserInputCard request={request(question("a", ["a1"]))} sessionId="s" cursor={false} />);
  key("2");
  fireEvent.click(screen.getByText("Answer"));
  expect(respondInput).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith("Type your answer to “a”, or pick an option", "warn");
  expect(document.activeElement).toBe(textField());
});

it("a question with nothing to choose from is just its field, and moving on to it puts the keyboard there", () => {
  render(<UserInputCard request={request({ ...question("a", ["a1"]), allow_free_text: false }, question("b", []))} sessionId="s" cursor={false} />);
  expect(document.querySelectorAll(".question")[1].querySelectorAll(".option")).toHaveLength(0);
  key("1");
  expect(screen.getByText("2/2", { exact: false })).toBeTruthy();
  expect(document.activeElement).toBe(textField());
});
