// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { UiApi } from "@aura/mod-sdk/ui";
import { useStore } from "@aura/host";
import type { PageFile, PrPage } from "../../shared/page";
import { toStatus } from "../../daemon/status";
import { prNode } from "../../test/fixtures";
import { setCtx } from "../ctx";
import { DIFF_BUDGET, LARGE_DIFF, PrPageView, type PageProps } from "./PrPageView";
import { MAX_RETRY_MS, NOTIFY_CHECK_MS, RETRY_BASE_MS, retryDelay } from "./usePrPage";

const NOW = Date.parse("2026-11-27T10:00:00Z");
const props: PageProps = { key: "https://github.com/acme/api/pull/7", title: "#7 Add limits", repo: "acme/api", number: 7, url: "https://github.com/acme/api/pull/7" };

function page(over: Partial<PrPage> = {}): PrPage {
  const status = toStatus({ url: props.url, repo: "acme/api", number: 7 }, prNode({ number: 7, title: "Add limits", reviewDecision: "APPROVED", reviews: [["alice", "APPROVED"]], requested: [["Team", "acme/core"]] }), {}, { squashMergeAllowed: true, viewerPermission: "WRITE" });
  status.merge.account = "github.com:sam";
  return {
    repo: "acme/api", number: 7, url: props.url, title: "Add limits", author: "sam", createdAt: "2026-11-27T08:00:00Z", body: "Adds **limits**.",
    base: "main", head: "feature/limits", headRepo: "acme/api", baseSha: "0".repeat(40), headSha: status.merge.headSha, commitCount: 2, changedFiles: 2, additions: 450, deletions: 3,
    assignees: ["sam"], labels: [{ name: "feature", color: "a2eeef" }], milestone: null,
    timeline: [
      { kind: "commit", at: "2026-11-27T08:10:00Z", author: "sam", sha: "abc1234", message: "Add limiter", url: "c1" },
      { kind: "review", state: "CHANGES_REQUESTED", author: "bob", body: "Please fix", at: "2026-11-27T09:00:00Z", url: "r", comments: [
        { author: "bob", body: "Off by one", at: "t", url: "rc", path: "src/limit.ts", line: 12, snippet: [" a", "+b"] },
      ], moreComments: 0 },
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
    if (name === "pulls.sessions") return ["s1"];
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

  describe("review 5", () => {
    it("backs off after failed reads, and waits out a block or a rate limit (item 3)", async () => {
      expect([1, 2, 3, 4].map((n) => retryDelay(n, null))).toEqual([RETRY_BASE_MS, RETRY_BASE_MS * 2, RETRY_BASE_MS * 4, RETRY_BASE_MS * 8]);
      expect(retryDelay(30, null)).toBe(MAX_RETRY_MS);
      expect(retryDelay(1, Object.assign(new Error("x"), { code: "blocked" }))).toBe(60_000);
      expect(retryDelay(1, Object.assign(new Error("x"), { code: "rate_limited", data: { waitMs: 300_000 } }))).toBe(300_000);

      const { rpc } = fakeCtx((name) => (name === "page.get" ? Promise.reject(Object.assign(new Error("Bad gateway"), { code: "failed" })) : undefined));
      render(<PrPageView props={props} close={() => {}} active />);
      await act(async () => {});
      expect(calls(rpc, "page.get")).toBe(1);
      await act(async () => void vi.advanceTimersByTime(RETRY_BASE_MS - 1));
      expect(calls(rpc, "page.get")).toBe(1);
      await act(async () => void vi.advanceTimersByTime(1));
      expect(calls(rpc, "page.get")).toBe(2);
      await act(async () => void vi.advanceTimersByTime(RETRY_BASE_MS * 2));
      expect(calls(rpc, "page.get")).toBe(3);
      // Ten seconds of a broken page are three reads, not ten.
      await act(async () => void vi.advanceTimersByTime(RETRY_BASE_MS * 2));
      expect(calls(rpc, "page.get")).toBe(3);
    });

    it("defers a notification during a rate-limit back-off to the one read at the deadline (re-review)", async () => {
      let fail = false;
      let notified: string | null = null;
      const limited = () => Promise.reject(Object.assign(new Error("API rate limit exceeded"), { code: "rate_limited", data: { waitMs: 120_000 } }));
      const { rpc } = fakeCtx((name) => (name === "page.get" ? (fail ? limited() : page({ readAt: new Date(Date.now()).toISOString() })) : name === "page.notified" ? notified : undefined));
      render(<PrPageView props={props} close={() => {}} active />);
      await act(async () => {});
      // The paced refresh fails on a rate limit: no read for two minutes.
      fail = true;
      await act(async () => void vi.advanceTimersByTime(60_000));
      expect(calls(rpc, "page.get")).toBe(2);
      fail = false;
      // Notifications arrive meanwhile; none of them reads.
      notified = new Date(NOW + 70_000).toISOString();
      await act(async () => void vi.advanceTimersByTime(NOTIFY_CHECK_MS));
      notified = new Date(NOW + 100_000).toISOString();
      await act(async () => void vi.advanceTimersByTime(NOTIFY_CHECK_MS * 4));
      expect(calls(rpc, "page.get")).toBe(2);
      // At the deadline one read covers them.
      await act(async () => void vi.advanceTimersByTime(120_000 - NOTIFY_CHECK_MS * 5));
      expect(calls(rpc, "page.get")).toBe(3);
      await act(async () => void vi.advanceTimersByTime(NOTIFY_CHECK_MS));
      expect(calls(rpc, "page.get")).toBe(3);
    });

    it("reads nothing after the tab closed, even for a notification that was on its way (item 4)", async () => {
      let answer!: (at: string) => void;
      const { rpc } = fakeCtx((name) => (name === "page.notified" ? new Promise((r) => (answer = r)) : undefined));
      const { unmount } = render(<PrPageView props={props} close={() => {}} active />);
      await act(async () => {});
      await act(async () => void vi.advanceTimersByTime(NOTIFY_CHECK_MS));
      unmount();
      await act(async () => answer(new Date(NOW + 1_000).toISOString()));
      expect(calls(rpc, "page.get")).toBe(1);
    });

    it("reads the files only while the page shows (item 4)", async () => {
      const { rpc } = fakeCtx();
      const hide = (hidden: boolean) => act(() => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      try {
        const { rerender } = render(<PrPageView props={props} close={() => {}} active />);
        await act(async () => {});
        await hide(true);
        fireEvent.click(screen.getByRole("tab", { name: /Files changed/ }));
        await act(async () => {});
        expect(calls(rpc, "page.files")).toBe(0);
        await hide(false);
        await act(async () => {});
        expect(calls(rpc, "page.files")).toBe(1);
        // Another tab shown: nothing more is read.
        rerender(<PrPageView props={props} close={() => {}} active={false} />);
        await act(async () => void vi.advanceTimersByTime(5 * 60_000));
        expect(calls(rpc, "page.files")).toBe(1);
      } finally {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      }
    });

    it("says when a review has more comments than shown, and when the file list is cut short (item 5)", async () => {
      const base = page();
      const review = { ...base.timeline[1], moreComments: 23 } as PrPage["timeline"][number];
      fakeCtx((name) => (name === "page.get" ? page({ timeline: [review], changedFiles: 3200 }) : undefined));
      render(<PrPageView props={props} close={() => {}} active />);
      await act(async () => {});
      expect(screen.getByText(/23 more comments in this review/)).toBeTruthy();
      fireEvent.click(screen.getByRole("tab", { name: /Files changed/ }));
      await act(async () => {});
      const note = screen.getByRole("note");
      expect(note.textContent).toContain("Showing 2 of 3200 changed files");
      expect(within(note).getByRole("link", { name: "See all files on GitHub" }).getAttribute("href")).toBe(`${props.url}/files`);
    });

    it("reads the files again for another base, on refresh, and on Retry after an error (item 6)", async () => {
      let base = "0".repeat(40);
      let failFiles = false;
      const { rpc } = fakeCtx((name) => (name === "page.get" ? page({ baseSha: base }) : name === "page.files" && failFiles ? Promise.reject(new Error("Server Error")) : undefined));
      render(<PrPageView props={props} close={() => {}} active />);
      await act(async () => {});
      fireEvent.click(screen.getByRole("tab", { name: /Files changed/ }));
      await act(async () => {});
      expect(calls(rpc, "page.files")).toBe(1);
      // The PR is retargeted: same head, another base.
      base = "9".repeat(40);
      await act(async () => void vi.advanceTimersByTime(60_000));
      expect(calls(rpc, "page.files")).toBe(2);
      failFiles = true;
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh" })));
      expect(calls(rpc, "page.files")).toBe(3);
      expect(screen.getByRole("alert").textContent).toContain("Server Error");
      failFiles = false;
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
      expect(calls(rpc, "page.files")).toBe(4);
      expect(screen.getByRole("region", { name: "src/limit.ts" })).toBeTruthy();
    });

    it("folds a file again when a refresh brings another comparison, and stops showing diffs past the budget (item 7)", async () => {
      let head = "f".repeat(40);
      const many: PageFile[] = Array.from({ length: 12 }, (_, i) => ({ path: `src/f${i}.ts`, previous: null, status: "modified", additions: 300, deletions: 0, patch: "@@ -1 +1 @@\n+x" }));
      fakeCtx((name) => {
        if (name === "page.get") { const p = page(); return { ...p, headSha: head, status: { ...p.status, merge: { ...p.status.merge, headSha: head } } }; }
        if (name === "page.files") return [...files, ...many];
        return undefined;
      });
      render(<PrPageView props={props} close={() => {}} active />);
      await act(async () => {});
      fireEvent.click(screen.getByRole("tab", { name: /Files changed/ }));
      await act(async () => {});
      const big = () => screen.getByRole("region", { name: "src/big.ts" });
      fireEvent.click(within(big()).getByRole("button", { name: /src\/big.ts/ }));
      fireEvent.click(within(big()).getByRole("button", { name: "Load diff" }));
      expect(big().querySelector("table")).not.toBeNull();
      // Within the budget: 3 lines of src/limit.ts and nine files of 300 lines; the rest wait.
      const loaded = many.filter((f) => screen.getByRole("region", { name: f.path }).querySelector("table")).length;
      expect(loaded).toBe(Math.floor((DIFF_BUDGET - 3) / 300));
      // New commits: the large file is folded again, and its diff not shown until asked.
      head = "e".repeat(40);
      await act(async () => void vi.advanceTimersByTime(60_000));
      await act(async () => {});
      expect(big().querySelector("table")).toBeNull();
    });

    it("names who requested changes in the merge box, and who it waits on (QA, cli#13899)", async () => {
      const node = prNode({ number: 7, reviewDecision: "CHANGES_REQUESTED", requested: [["User", "BagToad"]], reviews: [["copilot-pull-request-reviewer", "COMMENTED", "Bot"]], opinions: [["BagToad", "CHANGES_REQUESTED"]] });
      const status = toStatus({ url: props.url, repo: "acme/api", number: 7 }, node, {}, { squashMergeAllowed: true, viewerPermission: "WRITE" });
      fakeCtx((name) => (name === "page.get" ? page({ status, headSha: status.merge.headSha }) : undefined));
      render(<PrPageView props={props} close={() => {}} active />);
      await act(async () => {});
      expect(screen.getByRole("region", { name: "Merge" }).textContent).toContain("Changes requested by BagToad · waiting on BagToad");
    });

    it("offers no merge for a head the page does not show (item 1)", async () => {
      fakeCtx((name) => (name === "page.get" ? page({ headSha: "e".repeat(40) }) : undefined));
      render(<PrPageView props={props} close={() => {}} active />);
      await act(async () => {});
      const merge = screen.getByRole("region", { name: "Merge" });
      expect(within(merge).queryByRole("button", { name: "Squash and merge" })).toBeNull();
      expect(merge.textContent).toContain("New commits were pushed — refresh to review them");
    });
  });
});
