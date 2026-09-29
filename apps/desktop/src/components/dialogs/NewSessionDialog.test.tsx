import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { DirEntry } from "../../gen";
import type { RpcClient } from "../../lib/rpc";
import { useStore } from "../../state/store";
import { NewSessionDialog } from "./NewSessionDialog";

const dirs = (base: string, n: number): DirEntry[] =>
  Array.from({ length: n }, (_, i) => ({ name: `d${String(i).padStart(2, "0")}`, path: `${base}d${String(i).padStart(2, "0")}`, is_dir: true, is_git_repo: false }));
const listDir = vi.fn((base: string) => Promise.resolve(dirs(base, 20)));

// jsdom lays nothing out: give every element an offsetParent so the modal's Tab trap sees it as visible.
const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");
beforeAll(() => Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => document.body }));
afterAll(() => offsetParent && Object.defineProperty(HTMLElement.prototype, "offsetParent", offsetParent));
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  listDir.mockClear();
  useStore.setState({
    client: {
      home: () => Promise.resolve("/home/me"),
      listDir,
      gitRepoRoot: () => Promise.resolve(null),
      models: () => Promise.resolve([]),
    } as unknown as RpcClient,
    providers: [],
    selectedId: null,
  });
});
afterEach(cleanup);

async function openAt(path: string) {
  render(<NewSessionDialog cwd={path} />);
  const input = screen.getByPlaceholderText("~/projects/…") as HTMLInputElement;
  await waitFor(() => expect(document.querySelectorAll(".dir-browser .list-item")).toHaveLength(12));
  input.focus();
  return input;
}
const activeRow = () => document.querySelector(".dir-browser .list-item.active")?.textContent;

it("keeps the arrow keys within the rendered directory rows", async () => {
  const input = await openAt("/work/");
  for (let i = 0; i < 20; i++) fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(activeRow()).toBe("d11/");
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(activeRow()).toBe("d10/");
  expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
});

it("descends into the highlighted directory with the right arrow at the end of the field", async () => {
  const input = await openAt("/work/");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  input.setSelectionRange(input.value.length, input.value.length);
  await act(async () => {
    fireEvent.keyDown(input, { key: "ArrowRight" });
  });
  expect(input.value).toBe("/work/d01/");

  input.setSelectionRange(0, 0);
  fireEvent.keyDown(input, { key: "ArrowRight" });
  expect(input.value).toBe("/work/d01/");
});

it("tabs past the directory rows to the next field", async () => {
  const input = await openAt("/work/");
  fireEvent.keyDown(input, { key: "Tab" });
  expect(document.activeElement).not.toBe(input);
  expect(document.activeElement?.closest(".dir-browser")).toBeNull();
  expect((document.activeElement as HTMLInputElement).placeholder).toMatch(/·/);
});
