import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useStore } from "../state/store";
import { ImageDialog } from "./ImageThumbs";

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:full");
  URL.revokeObjectURL = vi.fn();
  useStore.setState({ dialog: { kind: "image", caption: "shot.png", preview: "data:image/png;base64,AAAA" } });
});
afterEach(cleanup);

it("shows the preview, swaps in the full image and revokes it when closed", async () => {
  const { unmount } = render(<ImageDialog caption="shot.png · 800 × 600" preview="data:image/png;base64,AAAA" load={() => Promise.resolve(new Blob(["x"]))} />);
  expect(screen.getByRole("img").getAttribute("src")).toBe("data:image/png;base64,AAAA");
  await act(async () => {});
  expect(screen.getByRole("img").getAttribute("src")).toBe("blob:full");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(useStore.getState().dialog.kind).toBe("none");
  unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:full");
});

it("falls back to the preview when the full image is gone", async () => {
  render(<ImageDialog caption="old" preview="data:image/png;base64,AAAA" load={() => Promise.reject(new Error("unknown method"))} />);
  await act(async () => {});
  expect(screen.getByRole("img").getAttribute("src")).toBe("data:image/png;base64,AAAA");
  expect(screen.getByText(/Full size is not available; showing the preview/)).toBeTruthy();
});
