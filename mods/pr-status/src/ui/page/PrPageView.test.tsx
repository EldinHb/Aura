// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { UiApi } from "@aura/mod-sdk/ui";
import { useStore } from "@aura/host";
import type { PageFile, PrPage } from "../../shared/page";
import { toStatus } from "../../daemon/status";
import { prNode } from "../../test/fixtures";
import { setCtx } from "../ctx";
import { LARGE_DIFF, PrPageView, type PageProps } from "./PrPageView";
import { NOTIFY_CHECK_MS } from "./usePrPage";

const NOW = Date.parse("2026-11-27T10:00:00Z");
const props: PageProps = { key: "https://github.com/acme/api/pull/7", title: "#7 Add limits", repo: "acme/api", number: 7, url: "https://github.com/acme/api/pull/7" };

function page(over: Partial<PrPage> = {}): PrPage {
  const status = toStatus({ url: props.url, repo: "acme/api", number: 7 }, prNode({ number: 7, title: "Add limits", reviewDecision: "APPROVED", reviews: [["alice", "APPROVED"]], requested: [["Team", "acme/core"]] }), {}, { squashMergeAllowed: true, viewerPermission: "WRITE" });
  status.merge.account = "github.com:sam";
  return {
    repo: "acme/api", number: 7, url: props.url, title: "Add limits", author: "sam", createdAt: "2026-11-27T08:00:00Z", body: "Adds **limits**.",
    base: "main", head: "feature/limits", headRepo: "acme/api", commitCount: 2, changedFiles: 2, additions: 450, deletions: 3,
    assignees: ["sam"], labels: [{ name: "feature", color: "a2eeef" }], milestone: null,
    timeline: [
      { kind: "commit", at: "2026-11-27T08:10:00Z", author: "sam", sha: "abc1234", message: "Add limiter", url: "c1" },
      { kind: "review", state: "CHANGES_REQUESTED", author: "bob", body: "Please fix", at: "2026-11-27T09:00:00Z", url: "r", comments: [
        { author: "bob", body: "Off by one", at: "t", url: "rc", path: "src/limit.ts", line: 12, snippet: [" a", "+b"] },
      ] },
      { kind: "labeled", at: "2026-11-27T09:10:00Z", actor: "sam", label: { name: "feature", color: "a2eeef" } },
    ],
    commits: [{ sha: "a".repeat(40), short: "abc1234", message: "Add limiter", author: "sam", at: "2026-11-27T08:10:00Z", url: "c1" }],
    checks: [{ name: "test", workflow: "CI", state: "failing", label: "Failure", seconds: 95, url: "d" }],
    commentCount: 1, status, complete: true, readAt: new Date(NOW).toISOString(), nextMs: 60_000,
    ...over,
  };
}

const files: PageFile[] = [
  { path: "src/limit.ts", previous: null, status: "modified", additions: 2, deletions: 1, patch: "@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d" },
  { path: "src/big.ts", previous: null, status: "added", additions: LARGE_DIFF + 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+big" },
];

function fakeCtx(answer: (name: string, p: any) => unknown = () => undefined) {
  const rpc = vi.fn(async (name: string, p?: any) => {
    const own = answer(name, p);
    if (own !== undefined) return own;
    if (name === "page.get") return page();
    if (name === "page.files") return files;
    if (name === "page.notified") return null;
    return null;
  });
  const call = vi.fn(async () => ["s1"]);
  setCtx({ rpc, call, toast: vi.fn(), storage: { get: () => undefined, set: () => {}, delete: () => {} } } as unknown as UiApi);
  return { rpc, call };
}

const calls = (rpc: ReturnType<typeof fakeCtx>["rpc"], name: string) => rpc.mock.calls.filter(([n]) => n === name).length;

describe("PrPageView", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
    (useStore as any).setState({ sessions: { s1: { title: "Rate limits" } } });
  });
  afterEach(() => {
    cleanup();
    setCtx(null);
    vi.useRealTimers();
  });

  it("shows GitHub's header: title, number, state, and what merges into what", async () => {
    fakeCtx();
    render(<PrPageView props={props} close={() => {}} active />);
    await act(async () => {});
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Add limits #7");
    const sub = screen.getByText(/wants to merge/).parentElement!;
    expect(sub.textContent).toContain("Opensam wants to merge 2 commits into main from feature/limits");
    expect(screen.getByRole("button", { name: "Copy branch name feature/limits" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open on GitHub" }).getAttribute("href")).toBe(props.url);
  });

  it("has tabs with counts, switched with the arrow keys", async () => {
    fakeCtx();
    render(<PrPageView props={props} close={() => {}} active />);
    await act(async () => {});
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Conversation 1", "Commits 2", "Checks 1", "Files changed 2"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /Commits/ }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Commits/ }));
    expect(screen.getByRole("list", { name: "Commits" }).textContent).toContain("Add limiter");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: /Files changed/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("shows the description, the timeline, the merge box and the details column", async () => {
    fakeCtx();
    render(<PrPageView props={props} close={() => {}} active />);
    await act(async () => {});
    expect(screen.getByText("Adds **limits**.")).toBeTruthy();
    const timeline = screen.getByRole("list", { name: "Timeline" });
    expect(timeline.textContent).toContain("sam added a commit: Add limiter abc1234");
    const review = within(timeline).getByRole("article", { name: "bob requested changes" });
    expect(review.textContent).toContain("src/limit.ts:12");
    expect(review.textContent).toContain("Off by one");
    expect(timeline.textContent).toContain("sam added the feature label");
    const merge = screen.getByRole("region", { name: "Merge" });
    expect(merge.textContent).toContain("Approved by alice · waiting on acme/core");
    expect(within(merge).getByRole("button", { name: "Squash and merge" })).toBeTruthy();
    const side = screen.getByRole("complementary", { name: "Details" });
    expect(within(side).getByRole("region", { name: "Reviewers" }).textContent).toContain("aliceApproved");
    expect(within(side).getByRole("region", { name: "Labels" }).textContent).toBe("Labelsfeature");
    await act(async () => {});
    fireEvent.click(within(side).getByRole("button", { name: "Rate limits" }));
    expect(useStore.getState().selectedId).toBe("s1");
  });

  it("reads the files only when asked, with large diffs behind Load diff", async () => {
    const { rpc } = fakeCtx();
    render(<PrPageView props={props} close={() => {}} active />);
    await act(async () => {});
    expect(calls(rpc, "page.files")).toBe(0);
    fireEvent.click(screen.getByRole("tab", { name: /Files changed/ }));
    await act(async () => {});
    expect(calls(rpc, "page.files")).toBe(1);
    const small = screen.getByRole("region", { name: "src/limit.ts" });
    expect(small.querySelectorAll("tr.diff-add")).toHaveLength(2);
    expect(small.querySelectorAll("tr.diff-del")).toHaveLength(1);
    const big = screen.getByRole("region", { name: "src/big.ts" });
    fireEvent.click(within(big).getByRole("button", { name: /src\/big.ts/ }));
    expect(big.querySelector("table")).toBeNull();
    fireEvent.click(within(big).getByRole("button", { name: "Load diff" }));
    expect(big.querySelectorAll("tr.diff-add")).toHaveLength(1);
    // Collapsing a file hides its diff.
    fireEvent.click(within(small).getByRole("button", { name: /src\/limit.ts/ }));
    expect(small.querySelector("table")).toBeNull();
  });

  it("reads again on the paced schedule while shown, and not while its tab is hidden", async () => {
    const { rpc } = fakeCtx();
    const { rerender } = render(<PrPageView props={props} close={() => {}} active />);
    await act(async () => {});
    expect(calls(rpc, "page.get")).toBe(1);
    await act(async () => void vi.advanceTimersByTime(60_000));
    expect(calls(rpc, "page.get")).toBe(2);
    rerender(<PrPageView props={props} close={() => {}} active={false} />);
    await act(async () => void vi.advanceTimersByTime(5 * 60_000));
    expect(calls(rpc, "page.get")).toBe(2);
    // Shown again: stale, so read at once.
    rerender(<PrPageView props={props} close={() => {}} active />);
    await act(async () => {});
    expect(calls(rpc, "page.get")).toBe(3);
  });

  it("reads again at once on a new notification for the PR, once per notification", async () => {
    let notified: string | null = null;
    const { rpc } = fakeCtx((name) => (name === "page.notified" ? notified : undefined));
    render(<PrPageView props={props} close={() => {}} active />);
    await act(async () => {});
    notified = new Date(NOW + 5_000).toISOString();
    await act(async () => void vi.advanceTimersByTime(NOTIFY_CHECK_MS));
    expect(calls(rpc, "page.get")).toBe(2);
    await act(async () => void vi.advanceTimersByTime(NOTIFY_CHECK_MS));
    expect(calls(rpc, "page.get")).toBe(2);
  });

  it("says why it cannot show the page, and tries again on request", async () => {
    const { rpc } = fakeCtx((name) => (name === "page.get" ? Promise.reject(new Error("Not Found")) : undefined));
    render(<PrPageView props={props} close={() => {}} active />);
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toBe("Could not read acme/api#7: Not Found");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(calls(rpc, "page.get")).toBe(2);
  });
});
