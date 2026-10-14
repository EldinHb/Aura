import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Question, UserInputRequest } from "../../gen";
import type { RpcClient } from "../../lib/rpc";
import { useStore } from "../../state/store";
import { UserInputCard } from "./UserInputCard";

const respondInput = vi.fn().mockResolvedValue(undefined);
const toast = vi.fn();
function question(id: string, labels: string[], multi_select = false): Question {
  return { id, header: id, question: `Pick ${id}?`, options: labels.map((label) => ({ label, description: null })), multi_select, allow_free_text: true };
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
  expect(respondInput).toHaveBeenCalledWith("s", { request_id: "r1", answers: { a: ["a2"], b: ["b1", "b2"], c: ["c1"] } });
});

it("Enter picks the option under the cursor and sends in one press", async () => {
  render(<UserInputCard request={request(question("a", ["a1", "a2"]))} sessionId="s" cursor={false} />);
  key("ArrowDown");
  await act(async () => void key("Enter"));
  expect(respondInput).toHaveBeenCalledWith("s", { request_id: "r1", answers: { a: ["a2"] } });
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
  expect(respondInput).toHaveBeenCalledWith("s", { request_id: "r1", answers: { a: ["a1"], b: ["b2"] } });
});

it("keeps the keyboard on the card after clicking an option", () => {
  render(<UserInputCard request={request(question("a", ["a1", "a2"]))} sessionId="s" cursor={false} />);
  fireEvent.click(screen.getByText("a2"));
  expect(document.activeElement).toBe(card());
});

it("sends a typed answer from the text field", async () => {
  render(<UserInputCard request={request(question("a", ["a1"]))} sessionId="s" cursor={false} />);
  const input = screen.getByPlaceholderText("Or type an answer… (i)");
  fireEvent.change(input, { target: { value: "my own" } });
  await act(async () => void fireEvent.keyDown(input, { key: "Enter" }));
  expect(respondInput).toHaveBeenCalledWith("s", { request_id: "r1", answers: { a: ["my own"] } });
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
