// @vitest-environment jsdom
// The PR page renders descriptions and comments with Aura's own markdown renderer (not the
// plain-text stand-in the other page tests use): GitHub text is untrusted.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { PrPageView } from "./PrPageView";
import { setCtx } from "../ctx";
import type { UiApi } from "@aura/mod-sdk/ui";

vi.mock("@aura/host", async (importOriginal) => {
  const standIn = await importOriginal<Record<string, unknown>>();
  const { Markdown } = await import("../../../../../apps/desktop/src/views/transcript/MarkdownView");
  return { ...standIn, Markdown };
});

const HOSTILE = [
  "Intro **bold**",
  "<script>window.__pwned = 'script'</script>",
  "<img src=x onerror=\"window.__pwned = 'img'\">",
  "<b onclick=\"window.__pwned = 'click'\">raw html</b>",
  "[click me](javascript:window.__pwned='link')",
  "[docs](https://example.com/docs)",
  "![diagram](https://example.com/diagram.png)",
].join("\n\n");

describe("PR text through Aura's markdown renderer", () => {
  afterEach(() => {
    cleanup();
    setCtx(null);
    delete (window as { __pwned?: unknown }).__pwned;
  });

  it("runs no raw HTML, refuses javascript: links, and keeps images and links", async () => {
    const { toStatus } = await import("../../daemon/status");
    const { prNode } = await import("../../test/fixtures");
    const status = toStatus({ url: "https://github.com/acme/api/pull/7", repo: "acme/api", number: 7 }, prNode({ number: 7 }));
    const page = {
      repo: "acme/api", number: 7, url: "https://github.com/acme/api/pull/7", title: "T", author: "sam", createdAt: "2026-11-27T08:00:00Z", body: HOSTILE,
      base: "main", head: "x", headRepo: "acme/api", baseSha: "0".repeat(40), headSha: status.merge.headSha, commitCount: 1, changedFiles: 1, additions: 1, deletions: 0,
      assignees: [], labels: [], milestone: null, timeline: [], commits: [], checks: [], commentCount: 0, status, complete: true,
      readAt: new Date().toISOString(), nextMs: 60_000,
    };
    setCtx({ rpc: async (name: string) => (name === "page.get" ? page : null), call: async () => [], toast: () => {}, storage: { get: () => undefined, set: () => {}, delete: () => {} } } as unknown as UiApi);
    render(<PrPageView props={{ key: page.url, title: "#7 T", repo: "acme/api", number: 7, url: page.url }} close={() => {}} active />);
    await act(async () => {});
    const body = screen.getByRole("article", { name: "sam commented" }).querySelector(".prs-box-body")!;
    expect(body.querySelector("strong")?.textContent).toBe("bold");
    // Raw HTML is not rendered as elements, so none of it can run.
    expect(body.querySelector("script, b, [onerror], [onclick]")).toBeNull();
    expect((window as { __pwned?: unknown }).__pwned).toBeUndefined();
    // No link leads to javascript:.
    for (const a of body.querySelectorAll("a")) expect(a.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
    expect(body.textContent).toContain("click me");
    const docs = [...body.querySelectorAll("a")].find((a) => a.textContent === "docs");
    expect(docs?.getAttribute("href")).toBe("https://example.com/docs");
    // A remote image shows, lazily and without telling its host which page asked.
    const img = body.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://example.com/diagram.png");
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(img.getAttribute("loading")).toBe("lazy");
  });

  it("shows GitHub's HTML as what it means, not as text (next.js#102433)", async () => {
    const { toStatus } = await import("../../daemon/status");
    const { prNode } = await import("../../test/fixtures");
    const status = toStatus({ url: "https://github.com/acme/api/pull/7", repo: "acme/api", number: 7 }, prNode({ number: 7 }));
    const body = [
      "<!-- Thanks for opening a PR! Please fill in the template below. -->",
      "### What?",
      'Fixes the build. <img width="600" alt="before" src="https://github.com/user-attachments/assets/before.png" />',
      "<details><summary>Logs</summary>",
      "",
      "Line one<br>Line two",
      "</details>",
    ].join("\n");
    const page = {
      repo: "acme/api", number: 7, url: "https://github.com/acme/api/pull/7", title: "T", author: "sam", createdAt: "2026-11-27T08:00:00Z", body,
      base: "main", head: "x", headRepo: "acme/api", baseSha: "0".repeat(40), headSha: status.merge.headSha, commitCount: 1, changedFiles: 1, additions: 1, deletions: 0,
      assignees: [], labels: [], milestone: null, timeline: [], commits: [], checks: [], commentCount: 0, status, complete: true,
      readAt: new Date().toISOString(), nextMs: 60_000,
    };
    setCtx({ rpc: async (name: string) => (name === "page.get" ? page : null), toast: () => {}, storage: { get: () => undefined, set: () => {}, delete: () => {} } } as unknown as UiApi);
    render(<PrPageView props={{ key: page.url, title: "#7 T", repo: "acme/api", number: 7, url: page.url }} close={() => {}} active />);
    await act(async () => {});
    const box = screen.getByRole("article", { name: "sam commented" }).querySelector(".prs-box-body")!;
    expect(box.textContent).not.toMatch(/<!--|<img|<details|<br|<summary/);
    expect(box.querySelector("img")?.getAttribute("src")).toBe("https://github.com/user-attachments/assets/before.png");
    expect(box.querySelector("strong")?.textContent).toBe("Logs");
    expect(box.textContent).toContain("Line one");
    expect(box.querySelector("br")).not.toBeNull();
  });
});
