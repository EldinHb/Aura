import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-shell";
import { isTauri } from "../../lib/connection";
import { useStore } from "../../state/store";
import { Markdown } from "./MarkdownView";

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../lib/connection", () => ({ isTauri: vi.fn(() => false) }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.mocked(isTauri).mockReturnValue(false);
});

describe("Markdown links", () => {
  it("renders a browser link with its label and destination", () => {
    render(<Markdown text="See [documentation](https://example.com/docs)." />);
    const link = screen.getByRole("link", { name: "documentation" });
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("opens desktop links through the system browser without navigating the app", () => {
    vi.mocked(isTauri).mockReturnValue(true);
    render(<Markdown text="[documentation](https://example.com/docs)" />);
    expect(fireEvent.click(screen.getByRole("link"))).toBe(false);
    expect(open).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("reports an opener failure", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(open).mockRejectedValueOnce(new Error("unavailable"));
    const toast = vi.spyOn(useStore.getState(), "toast").mockImplementation(() => {});
    render(<Markdown text="[documentation](https://example.com/docs)" />);
    fireEvent.click(screen.getByRole("link"));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(
      "Could not open link: Error: unavailable", "error",
    ));
    toast.mockRestore();
  });

  it.each(["javascript:alert", "data:text/html,hello", "file:///tmp/example", "/tmp/example"])(
    "keeps unsupported destinations as text: %s", (url) => {
      render(<Markdown text={`[destination](${url})`} />);
      expect(screen.queryByRole("link")).toBeNull();
      expect(screen.getByText("destination", { exact: false })).toBeTruthy();
    },
  );
});
