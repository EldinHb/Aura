import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-shell";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { isTauri } from "../../lib/connection";
import type { RpcClient } from "../../lib/rpc";
import { useStore } from "../../state/store";
import { clearImageCache } from "./LocalFiles";
import { Markdown } from "./MarkdownView";
import { markdownSegments } from "./markdownPlugins";

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn().mockResolvedValue(undefined) }));
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

describe("Markdown rendering", () => {
  it("renders GitHub-flavoured markdown", () => {
    const { container } = render(<Markdown text={[
      "# Title", "", "Some **bold**, *em*, ~~gone~~ and `code`.", "",
      "- one", "  - nested", "- [x] done", "- [ ] open", "",
      "3. three", "4. four", "",
      "> quoted", "", "| a | b |", "|:-|-:|", "| 1 | 2 |", "", "---", "", "Note[^n].", "", "[^n]: The note.",
    ].join("\n")} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Title");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("em");
    expect(container.querySelector("del")?.textContent).toBe("gone");
    expect(container.querySelector(".md-code")?.textContent).toBe("code");
    expect(container.querySelector("ul.md-list ul.md-list li")?.textContent).toBe("nested");
    const boxes = [...container.querySelectorAll<HTMLInputElement>(".task-list-item input")];
    expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([[true, true], [false, true]]);
    expect(container.querySelector("ol")?.getAttribute("start")).toBe("3");
    expect(container.querySelector("blockquote.md-quote")?.textContent).toBe("quoted");
    expect([...container.querySelectorAll("td")].map((td) => td.style.textAlign)).toEqual(["left", "right"]);
    expect(container.querySelector("hr.md-hr")).toBeTruthy();
    expect(container.querySelector(".footnotes li")?.textContent).toContain("The note.");
  });

  it("shows HTML as text instead of markup", () => {
    const { container } = render(<Markdown text={'<img src=x onerror="alert(1)"> <script>alert(2)</script>\n\n<div onclick="x()">block</div>\n\n<b>bold?</b>'} />);
    expect(container.querySelector("img, script, div[onclick], b")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(container.textContent).toContain("<b>bold?</b>");
  });

  it("does not strike through single tildes", () => {
    const { container } = render(<Markdown text="takes ~5 to ~10 minutes" />);
    expect(container.querySelector("del")).toBeNull();
  });

  it("links bare web addresses but not scheme-less ones", () => {
    render(<Markdown text="See https://example.com/a, www.example.org and example.com/page.html." />);
    expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["https://example.com/a", "http://www.example.org"]);
  });

  it("keeps line breaks within a paragraph and none between blocks", () => {
    const { container } = render(<Markdown text={"first\nsecond\n\n- a\n- b"} />);
    expect(container.querySelector(".md-p")?.textContent).toBe("first\nsecond");
    expect([...container.querySelector(".md")!.childNodes].every((n) => n.nodeType === Node.ELEMENT_NODE)).toBe(true);
    expect([...container.querySelector("ul")!.childNodes].every((n) => n.nodeType === Node.ELEMENT_NODE)).toBe(true);
  });

  it("renders a long message in segments with the same result", () => {
    const para = (i: number) => `Paragraph ${i} with **bold** text and enough words to make it long. `.repeat(4);
    const text = Array.from({ length: 30 }, (_, i) => `${para(i)}\n\n- item ${i}\n- more\n\n\`\`\`ts\nconst x${i} = 1;\n\n// still code\n\`\`\``).join("\n\n");
    expect(markdownSegments(text).length).toBeGreaterThan(10);
    expect(markdownSegments(text).join("\n")).toBe(text);
    const { container } = render(<Markdown text={text} />);
    expect(container.querySelectorAll(".code-block")).toHaveLength(30);
    expect(container.querySelectorAll("ul")).toHaveLength(30);
    expect(container.querySelectorAll(".code-block code")[0].textContent).toBe("const x0 = 1;\n\n// still code");
  });

  it("does not split text whose definitions apply across it", () => {
    const text = `${"Long text. ".repeat(500)}\n\nSee [the docs][d].\n\n[d]: https://example.com/docs`;
    expect(markdownSegments(text)).toEqual([text]);
    render(<Markdown text={text} />);
    expect(screen.getByRole("link", { name: "the docs" }).getAttribute("href")).toBe("https://example.com/docs");
  });
});

describe("Markdown images", () => {
  const readImage = vi.fn();
  beforeEach(() => {
    clearImageCache();
    readImage.mockReset().mockResolvedValue({ data: btoa("png"), media_type: "image/png" });
    useStore.setState({ client: { readImage, home: () => Promise.resolve("/Users/me") } as unknown as RpcClient });
    URL.createObjectURL = vi.fn(() => "blob:shown");
    URL.revokeObjectURL = vi.fn();
  });

  it("shows https images without sending a referrer", () => {
    render(<Markdown text="![chart](https://example.com/chart.png)" />);
    const img = screen.getByRole("img", { name: "chart" });
    expect(img.getAttribute("src")).toBe("https://example.com/chart.png");
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("reads image files from the agent's folder, relative and absolute", async () => {
    render(<Markdown cwd="/repo/app" text={"![rel](./shots/a.png) ![up](../b.png) ![abs](/tmp/c.png) ![home](~/d.png) ![url](file:///tmp/e%20f.png)"} />);
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(5));
    expect(readImage.mock.calls.map((c) => c[0]).sort()).toEqual(["/repo/app/shots/a.png", "/repo/b.png", "/tmp/c.png", "/tmp/e f.png", "/Users/me/d.png"].sort());
    expect(screen.getByRole("img", { name: "rel" }).getAttribute("src")).toBe("blob:shown");
  });

  it("opens an image in the viewer", async () => {
    const openDialog = vi.spyOn(useStore.getState(), "openDialog").mockImplementation(() => {});
    render(<Markdown cwd="/repo" text="![diagram](out.png)" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open diagram" }));
    expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({ kind: "image", caption: "diagram", preview: "blob:shown" }));
    openDialog.mockRestore();
  });

  it("says why an image file could not be shown", async () => {
    readImage.mockRejectedValueOnce(new Error("not an image: /repo/secret.png"));
    const { container } = render(<Markdown cwd="/repo" text="![s](secret.png)" />);
    await waitFor(() => expect(container.querySelector(".md-img-missing")?.getAttribute("title")).toContain("not an image"));
    expect(container.querySelector("img")).toBeNull();
  });

  it("never reads files for text without a folder, such as pull request descriptions", () => {
    const { container } = render(<Markdown text={"![a](/etc/passwd.png) ![b](docs/b.png) ![c](http://example.com/c.png) ![d](javascript:alert(1))"} />);
    expect(readImage).not.toHaveBeenCalled();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelectorAll(".md-img-missing")).toHaveLength(4);
  });
});

describe("Markdown file paths", () => {
  it("makes paths in agent messages show the file, relative ones in the agent's folder", () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const { container } = render(<Markdown cwd="/repo" text={"Changed `src/views/Composer.tsx:42` and src/lib/rpc.ts, see [the test](./tests/a.spec.ts) and Composer.tsx:12."} />);
    const links = [...container.querySelectorAll<HTMLAnchorElement>("a.md-file")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/repo/src/views/Composer.tsx", "/repo/src/lib/rpc.ts", "/repo/tests/a.spec.ts", "/repo/Composer.tsx"]);
    expect(links[0].title).toContain("/repo/src/views/Composer.tsx:42");
    fireEvent.click(links[0]);
    return waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith("/repo/src/views/Composer.tsx"));
  });

  it("leaves prose, versions, hosts and web addresses alone", () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const { container } = render(<Markdown cwd="/repo" text={"Use v1.2.3, e.g. and/or, api.example.com:443, example.com/x.html, `foo.bar` and 3.5/2.5."} />);
    expect(container.querySelector("a")).toBeNull();
  });

  it("keeps paths as text outside the desktop app and outside agent messages", () => {
    const { container, rerender } = render(<Markdown cwd="/repo" text="see src/a.ts" />);
    expect(container.querySelector("a")).toBeNull();
    vi.mocked(isTauri).mockReturnValue(true);
    rerender(<Markdown text="see src/a.ts and [b](src/b.ts)" />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("see src/a.ts and b (src/b.ts)");
  });
});
