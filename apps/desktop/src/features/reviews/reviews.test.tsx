import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../../lib/rpc";
import type { ProviderInfo, Session } from "../../gen";
import { defaultSettings, selectSelected, useStore } from "../../state/store";
import { ReviewSettings } from "./ReviewSettings";
import { ReviewSubmit } from "./ReviewEditor";
import { ReviewSidebar } from "./ReviewSidebar";
import { editDraft, ensureDraft, flushDraft, openPull, pullFilter, pullFilterError, useReviewDrafts, useReviews } from "./state";
import { inboxFixture, pullFixture, reviewFixture } from "./fixtures";
vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear() } });
});
const call = vi.fn();
const models = vi.fn().mockResolvedValue([{ id: "review-model", display_name: "Review model", is_default: true, efforts: ["low", "high"], default_effort: "high" }]);
beforeEach(() => {
  localStorage.clear(); call.mockReset();
  call.mockImplementation(async (method: string) => method === "reviews.defaults" ? { instructions: "Default instructions" } : method === "reviews.start" ? { ...reviewFixture, status: "queued" } : inboxFixture);
  useReviews.setState({ inbox: inboxFixture, error: null, hidden: false, collapsed: false, mineCollapsed: false, showHidden: false, busy: false, reviewId: null });
  useReviewDrafts.setState({ drafts: {} });
  useStore.setState({ prSelection: null, reviewHistoryOpen: false, dialog: { kind: "none" }, providers: [{ kind: "codex", display_name: "Codex", available: true }] as ProviderInfo[], client: { call, models, onNotification: () => () => {}, onState: () => () => {} } as unknown as RpcClient });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("opening and cancelling settings never starts a review", async () => {
  render(<ReviewSettings pull={pullFixture} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Start pre-review" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(call.mock.calls.some(([method]) => method === "reviews.start")).toBe(false);
});
it("sends the confirmed replacement prompt, model and effort", async () => {
  render(<ReviewSettings pull={pullFixture} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Start pre-review" }).hasAttribute("disabled")).toBe(false));
  fireEvent.change(screen.getByLabelText("Review instructions"), { target: { value: "replace" } });
  expect(screen.getByRole("button", { name: "Start pre-review" }).hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByLabelText("Replacement instructions"), { target: { value: "Check edge cases" } });
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "review-model" } });
  fireEvent.change(screen.getByLabelText("Effort"), { target: { value: "high" } });
  fireEvent.click(screen.getByRole("button", { name: "Start pre-review" }));
  await waitFor(() => expect(call).toHaveBeenCalledWith("reviews.start", expect.objectContaining({ config: expect.objectContaining({ prompt_mode: "replace", prompt: "Check edge cases", model: "review-model", effort: "high" }) })));
});
it("PR selection guards session commands and session selection restores the session", () => {
  const session = { id: "s" } as Session;
  useStore.setState({ selectedId: "s", sessions: { s: session } });
  openPull(pullFixture);
  expect(selectSelected(useStore.getState())).toBe(null);
  expect(useStore.getState().selectedId).toBe("s");
  useStore.getState().select("s");
  expect(selectSelected(useStore.getState())).toBe(session);
  expect(useStore.getState().prSelection).toBe(null);
});
it("hides and restores PRs through the persisted account-scoped preference", async () => {
  render(<ReviewSidebar />);
  fireEvent.click(screen.getByTitle("Hide PR"));
  await waitFor(() => expect(call).toHaveBeenCalledWith("pulls.hide", { id: pullFixture.id, account: pullFixture.account }));
  act(() => useReviews.setState({ inbox: { ...inboxFixture, pulls: [{ ...pullFixture, hidden: true }] }, showHidden: true }));
  fireEvent.click(screen.getByTitle("Restore PR"));
  await waitFor(() => expect(call).toHaveBeenCalledWith("pulls.restore", { id: pullFixture.id, account: pullFixture.account }));
});
it("lists your own pull requests with their status, separately from review requests", () => {
  const mine = { ...pullFixture, id: "acme/widget#7", number: 7, title: "Add retries", author: "reviewer", draft: true, checks: "FAILURE", review_decision: "APPROVED" };
  useReviews.setState({ inbox: { ...inboxFixture, mine: [mine] } });
  render(<ReviewSidebar />);
  expect(screen.getByRole("button", { name: /Your pull requests/ }).textContent).toContain("1");
  const row = screen.getByTitle("Add retries");
  expect(row.textContent).toContain("acme/widget#7");
  expect(row.textContent).not.toContain("reviewer");
  expect([...row.querySelectorAll(".chip")].map((c) => [c.textContent, c.className.trim()])).toEqual([["draft", "chip"], ["checks fail", "chip err"], ["approved", "chip ok"]]);
  fireEvent.click(screen.getByRole("button", { name: /Your pull requests/ }));
  expect(screen.queryByTitle("Add retries")).toBe(null);
  expect(screen.getByTitle(pullFixture.title)).toBeTruthy();
});
it("matches pull filter rules by author, label, repo, title and draft", () => {
  const bot = { ...pullFixture, author: "dependabot[bot]" };
  expect(pullFilter(bot, ["author:dependabot"])).toBe("author:dependabot");
  expect(pullFilter(bot, ["author:Dependabot[bot]"])).toBe("author:Dependabot[bot]");
  expect(pullFilter(pullFixture, ["author:dependabot"])).toBe(undefined);
  expect(pullFilter(pullFixture, ["label:BUG"])).toBe("label:BUG");
  expect(pullFilter(pullFixture, ["repo:acme/*"])).toBe("repo:acme/*");
  expect(pullFilter(pullFixture, ["title:*empty*"])).toBe("title:*empty*");
  expect(pullFilter(pullFixture, ["title:empty"])).toBe(undefined);
  expect(pullFilter({ ...pullFixture, draft: true }, ["", "# note", "draft"])).toBe("draft");
  expect(pullFilter(pullFixture, ["nonsense:x", "author:", "draft"])).toBe(undefined);
  expect(pullFilterError("nonsense:x")).toMatch(/Unknown rule/);
  expect(pullFilterError("author:")).toMatch(/needs a value/);
  expect(pullFilterError("repo:a/b:c")).toBe(undefined);
});
it("hides Dependabot PRs by default and lists them with Show hidden", () => {
  const bot = { ...pullFixture, id: "acme/widget#9", number: 9, title: "Bump lodash", author: "dependabot[bot]" };
  useStore.setState({ settings: defaultSettings });
  useReviews.setState({ inbox: { ...inboxFixture, pulls: [pullFixture, bot] } });
  render(<ReviewSidebar />);
  expect(screen.queryByTitle("Bump lodash")).toBe(null);
  expect(screen.getByRole("button", { name: /Needs your review/ }).textContent).toContain("1");
  fireEvent.click(screen.getByRole("button", { name: "Show hidden" }));
  expect(screen.getByTitle("Bump lodash").textContent).toContain("hidden by author:dependabot");
  act(() => useStore.setState({ settings: { ...defaultSettings, pullFilters: [] } }));
  fireEvent.click(screen.getByRole("button", { name: "Hide hidden" }));
  expect(screen.getByTitle("Bump lodash")).toBeTruthy();
  expect(screen.getByRole("button", { name: /Needs your review/ }).textContent).toContain("2");
});
it("flush waits for text typed during an in-flight save", async () => {
  let resolve!: (value: unknown) => void;
  call.mockImplementationOnce(() => new Promise((r) => { resolve = r; })).mockImplementationOnce(async (_method, p) => ({ ...reviewFixture, revision: 2, result: p.result }));
  ensureDraft(reviewFixture);
  editDraft(reviewFixture.id, { ...reviewFixture.result, summary: "first" });
  const pending = flushDraft(reviewFixture.id);
  editDraft(reviewFixture.id, { ...reviewFixture.result, summary: "second" });
  resolve({ ...reviewFixture, revision: 1, result: { ...reviewFixture.result, summary: "first" } });
  await pending;
  expect(call).toHaveBeenLastCalledWith("reviews.save", expect.objectContaining({ revision: 1, result: expect.objectContaining({ summary: "second" }) }));
  expect(useReviewDrafts.getState().drafts[reviewFixture.id].saving).toBe(false);
});
it("save failure retains recoverable local edits", async () => {
  call.mockRejectedValue(new Error("offline")); ensureDraft(reviewFixture);
  editDraft(reviewFixture.id, { ...reviewFixture.result, summary: "keep this" });
  await expect(flushDraft(reviewFixture.id)).rejects.toThrow("offline");
  expect(localStorage.getItem(`aura.review-draft.${reviewFixture.id}`)).toContain("keep this");
});
it("preview is inert until its explicit Post button is clicked", async () => {
  const preview = { token: "token", review_id: reviewFixture.id, revision: 0, account: pullFixture.account, head_sha: pullFixture.head_sha, reviewed_sha: pullFixture.head_sha, event: "COMMENT", body: "Preview body", comments: [], stale: false };
  render(<ReviewSubmit preview={preview} />);
  expect(call).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
  await waitFor(() => expect(call).toHaveBeenCalledWith("reviews.submit", { id: reviewFixture.id, token: "token" }));
});
it("marks a PR whose review was requested again after you reviewed it", () => {
  const again = { ...pullFixture, my_review: { state: "APPROVED", submitted_at: "2026-10-01T10:00:00Z", commit_sha: "c".repeat(40) }, review_requested_at: "2026-10-02T10:00:00Z" };
  const earlier = { ...reviewFixture, status: "submitted", created_at: "2026-10-01T09:00:00Z" };
  useReviews.setState({ inbox: { ...inboxFixture, pulls: [again], reviews: [earlier] } });
  render(<ReviewSidebar />);
  const row = screen.getByTitle(pullFixture.title);
  expect([...row.querySelectorAll(".chip")].map((c) => c.textContent)).toEqual(["re-review requested", "changed since your review", "checks pass", "review required", "submitted · earlier round"]);
  expect(row.closest(".pr-sidebar-row")!.className).toContain("rerequested");
});
it("shows your verdict on a PR you already reviewed in this round", () => {
  const reviewed = { ...pullFixture, my_review: { state: "CHANGES_REQUESTED", submitted_at: "2026-10-02T10:00:00Z", commit_sha: pullFixture.head_sha }, review_requested_at: "2026-10-01T10:00:00Z" };
  useReviews.setState({ inbox: { ...inboxFixture, pulls: [reviewed] } });
  render(<ReviewSidebar />);
  const row = screen.getByTitle(pullFixture.title);
  expect(row.textContent).toContain("you requested changes");
  expect(row.textContent).not.toContain("re-review requested");
  expect(row.closest(".pr-sidebar-row")!.className).not.toContain("rerequested");
});
