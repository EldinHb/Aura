// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UiApi } from "@aura/mod-sdk/ui";
import type { MergeInfo, PrStatus } from "../shared/types";
import { setCtx } from "./ctx";
import { squashState } from "../shared/squash";
import { DELETE_BRANCH_KEY, SquashMerge } from "./SquashMerge";

const HEAD = "f".repeat(40);
const approved: MergeInfo = { reviewDecision: "APPROVED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headSha: HEAD, headRef: "feature/news", sameRepo: true, squashAllowed: true, canMerge: true, account: "github.com:eldin" };

function status(merge: Partial<MergeInfo> = {}, over: Partial<PrStatus> = {}): PrStatus {
  return {
    url: "https://github.com/acme/api/pull/7", repo: "acme/api", number: 7, title: "Add limits", author: "me", updatedAt: "2026-11-27T09:00:00Z", state: "open",
    reviewers: { reviewed: [], pending: [], complete: true },
    checks: { state: "passing", passing: 3, failing: 0, pending: 0, total: 3, open: [], complete: true },
    readiness: { ready: true, reasons: [] },
    merge: { ...approved, ...merge },
    ...over,
  };
}

describe("squashState", () => {
  it("shows only on open, approved PRs", () => {
    expect(squashState(status())).toEqual({ kind: "ready" });
    expect(squashState(status({ reviewDecision: "REVIEW_REQUIRED" }))).toBeNull();
    expect(squashState(status({ reviewDecision: "" }))).toBeNull();
    expect(squashState(status({}, { state: "draft" }))).toBeNull();
    expect(squashState(status({}, { state: "merged" }))).toBeNull();
    expect(squashState(status({}, { state: "closed" }))).toBeNull();
  });

  it("is usable only when GitHub says mergeable and clean (or clean but for hooks)", () => {
    expect(squashState(status({ mergeStateStatus: "HAS_HOOKS" }))).toEqual({ kind: "ready" });
    const reasons = (merge: Partial<MergeInfo>, checks?: PrStatus["checks"]["state"]) => {
      const st = status(merge);
      if (checks) st.checks.state = checks;
      const out = squashState(st);
      return out?.kind === "disabled" ? out.reasons : out;
    };
    expect(reasons({ mergeStateStatus: "UNSTABLE" }, "failing")).toEqual(["Checks failing"]);
    expect(reasons({ mergeStateStatus: "BLOCKED" }, "pending")).toEqual(["Checks pending"]);
    expect(reasons({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" })).toEqual(["Merge conflicts"]);
    expect(reasons({ mergeStateStatus: "BEHIND" })).toEqual(["Behind base branch"]);
    expect(reasons({ mergeStateStatus: "BLOCKED" })).toEqual(["Blocked by branch protection"]);
    expect(reasons({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" })).toEqual(["GitHub is still checking mergeability"]);
    expect(reasons({ canMerge: false })).toEqual(["You don't have permission to merge"]);
  });

  it("says so instead of a button when the repository does not squash", () => {
    expect(squashState(status({ squashAllowed: false }))).toEqual({ kind: "unavailable", reason: "This repository does not allow squash merging" });
  });
});

function fakeCtx(answer: (name: string, params: any) => unknown) {
  const stored = new Map<string, unknown>();
  const rpc = vi.fn(async (name: string, params?: any) => {
    const out = await answer(name, params);
    if (out instanceof Error) throw out;
    return out;
  });
  const toast = vi.fn();
  setCtx({ rpc, toast, storage: { get: (k: string) => stored.get(k), set: (k: string, v: unknown) => void stored.set(k, v), delete: () => {} } } as unknown as UiApi);
  return { rpc, toast, stored };
}

const defaults = { title: "Add limits (#7)", message: "* Add limiter\n\n* Fix tests" };

describe("SquashMerge", () => {
  afterEach(() => {
    cleanup();
    setCtx(null);
  });

  it("shows a disabled button with its reason as text", () => {
    fakeCtx(() => null);
    render(<SquashMerge status={status({ mergeStateStatus: "BEHIND" })} onMerged={() => {}} />);
    const button = screen.getByRole("button", { name: "Squash and merge" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("Behind base branch").id).toBe(button.getAttribute("aria-describedby"));
  });

  it("confirms with GitHub's suggested commit, focus on Cancel, and the remembered branch choice", async () => {
    const { rpc, stored } = fakeCtx((name) => (name === "merge.defaults" ? defaults : null));
    stored.set(DELETE_BRANCH_KEY, true);
    render(<SquashMerge status={status()} onMerged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Squash and merge" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    expect((screen.getByLabelText("Commit title") as HTMLInputElement).value).toBe("Add limits (#7)");
    await act(async () => {});
    expect(rpc).toHaveBeenCalledWith("merge.defaults", { repo: "acme/api", number: 7 });
    expect((screen.getByLabelText("Commit message") as HTMLTextAreaElement).value).toBe(defaults.message);
    const box = screen.getByLabelText("Delete branch after merge") as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(stored.get(DELETE_BRANCH_KEY)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Squash and merge" })).toBeTruthy();
  });

  it("has the branch choice off by default, and none for a fork's branch", async () => {
    fakeCtx((name) => (name === "merge.defaults" ? defaults : null));
    const { unmount } = render(<SquashMerge status={status()} onMerged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Squash and merge" }));
    expect((screen.getByLabelText("Delete branch after merge") as HTMLInputElement).checked).toBe(false);
    unmount();
    render(<SquashMerge status={status({ sameRepo: false })} onMerged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Squash and merge" }));
    expect(screen.queryByLabelText("Delete branch after merge")).toBeNull();
    expect(screen.getByText("The branch is in a fork and stays.")).toBeTruthy();
  });

  it("merges once at the shown head, however often Merge is pressed, then toasts and refreshes", async () => {
    let finish!: (v: unknown) => void;
    const { rpc, toast } = fakeCtx((name) => (name === "merge.defaults" ? defaults : name === "merge" ? new Promise((r) => (finish = r)) : null));
    const onMerged = vi.fn();
    render(<SquashMerge status={status()} onMerged={onMerged} />);
    fireEvent.click(screen.getByRole("button", { name: "Squash and merge" }));
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Commit title"), { target: { value: "Rate limits (#7)" } });
    const merge = screen.getByRole("button", { name: "Merge" });
    fireEvent.click(merge);
    fireEvent.click(merge);
    fireEvent.submit(merge.closest("form")!);
    expect(screen.getByRole("button", { name: "Merging…" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);
    expect(rpc.mock.calls.filter(([n]) => n === "merge")).toEqual([["merge", {
      repo: "acme/api", number: 7, sha: HEAD, account: "github.com:eldin", title: "Rate limits (#7)", message: defaults.message, deleteBranch: false,
    }]]);
    await act(async () => finish({ merged: true, sha: "b", branchDeleted: false, branchError: null }));
    expect(toast).toHaveBeenCalledWith("Merged #7");
    expect(onMerged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("shows GitHub's refusal inline and keeps the confirmation open", async () => {
    const refused = Object.assign(new Error("New commits arrived since this card was read; refresh and look at them first. GitHub said: Head branch was modified."), { code: "head_moved" });
    const { rpc, toast } = fakeCtx((name) => (name === "merge.defaults" ? defaults : name === "merge" ? refused : null));
    const onMerged = vi.fn();
    render(<SquashMerge status={status()} onMerged={onMerged} />);
    fireEvent.click(screen.getByRole("button", { name: "Squash and merge" }));
    await act(async () => {});
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Merge" })));
    expect(screen.getByRole("alert").textContent).toBe(refused.message);
    expect(screen.getByRole("form", { name: "Squash and merge #7" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Merge" })).toHaveProperty("disabled", false);
    expect(onMerged).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    // Trying again is one more request, not two.
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Merge" })));
    expect(rpc.mock.calls.filter(([n]) => n === "merge")).toHaveLength(2);
  });

  it("freezes the head and account when opened, and asks to review again when new commits arrive (review 4, items 1 and 3)", async () => {
    const { rpc } = fakeCtx((name) => (name === "merge.defaults" ? defaults : name === "merge" ? { merged: true, sha: "b", branchDeleted: false, branchError: null } : null));
    const { rerender } = render(<SquashMerge status={status()} onMerged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Squash and merge" }));
    await act(async () => {});
    expect(screen.getByText("Merges as eldin")).toBeTruthy();
    // A poll reads a new head, and gh switched accounts meanwhile.
    rerender(<SquashMerge status={status({ headSha: "e".repeat(40), account: "github.com:other" })} onMerged={() => {}} />);
    expect(screen.getByRole("alert").textContent).toBe("New commits were pushed — review again");
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    // Opened again, it is on the new head and account.
    fireEvent.click(screen.getByRole("button", { name: "Squash and merge" }));
    await act(async () => {});
    expect(screen.getByText("Merges as other")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Merge" })));
    expect(rpc.mock.calls.filter(([n]) => n === "merge")[0][1]).toMatchObject({ sha: "e".repeat(40), account: "github.com:other" });
  });

  it("keeps the confirmed head when a poll only changes other facts", async () => {
    const { rpc } = fakeCtx((name) => (name === "merge.defaults" ? defaults : name === "merge" ? { merged: true, sha: "b", branchDeleted: false, branchError: null } : null));
    const { rerender } = render(<SquashMerge status={status()} onMerged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Squash and merge" }));
    await act(async () => {});
    rerender(<SquashMerge status={status({ account: "github.com:other" }, { title: "Renamed" })} onMerged={() => {}} />);
    expect((screen.getByLabelText("Commit title") as HTMLInputElement).value).toBe("Add limits (#7)");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Merge" })));
    expect(rpc.mock.calls.filter(([n]) => n === "merge")[0][1]).toMatchObject({ sha: HEAD, account: "github.com:eldin", title: "Add limits (#7)" });
  });

  it("disables Merge in an open confirmation once the PR is blocked or no longer approved (review 4, item 2)", async () => {
    const { rpc } = fakeCtx((name) => (name === "merge.defaults" ? defaults : null));
    const { rerender } = render(<SquashMerge status={status()} onMerged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Squash and merge" }));
    await act(async () => {});
    rerender(<SquashMerge status={status({ mergeStateStatus: "BLOCKED" })} onMerged={() => {}} />);
    const merge = screen.getByRole("button", { name: "Merge" }) as HTMLButtonElement;
    expect(merge.disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Can't merge now: Blocked by branch protection");
    fireEvent.submit(merge.closest("form")!);
    rerender(<SquashMerge status={status({ reviewDecision: "CHANGES_REQUESTED" })} onMerged={() => {}} />);
    expect(screen.getByRole("status").textContent).toBe("Can't merge now: It is no longer open and approved");
    rerender(<SquashMerge status={status()} onMerged={() => {}} />);
    expect((screen.getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(false);
    expect(rpc.mock.calls.filter(([n]) => n === "merge")).toHaveLength(0);
  });

  it("does not merge without a known account", async () => {
    fakeCtx((name) => (name === "merge.defaults" ? defaults : null));
    render(<SquashMerge status={status({ account: "" })} onMerged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Squash and merge" }));
    await act(async () => {});
    expect((screen.getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("The GitHub account is not known");
  });

  it("cancels on Escape, keeping Escape from Aura's keys only while it is open (QA)", async () => {
    fakeCtx((name) => (name === "merge.defaults" ? defaults : null));
    const outside = vi.fn();
    document.addEventListener("keydown", outside);
    try {
      render(<SquashMerge status={status()} onMerged={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "Squash and merge" }));
      await act(async () => {});
      const form = screen.getByRole("form", { name: "Squash and merge #7" });
      // Aura's global keymap leaves Escape alone inside [data-own-escape] (hooks/useCommandContext.ts).
      expect(form.hasAttribute("data-own-escape")).toBe(true);
      fireEvent.keyDown(screen.getByLabelText("Commit title"), { key: "Escape" });
      expect(screen.queryByRole("form")).toBeNull();
      expect(outside).not.toHaveBeenCalled();
      // Closed, Escape is Aura's again.
      fireEvent.keyDown(screen.getByRole("button", { name: "Squash and merge" }), { key: "Escape" });
      expect(outside).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("keydown", outside);
    }
  });
});
