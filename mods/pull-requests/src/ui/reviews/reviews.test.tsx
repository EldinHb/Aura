// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "../test/rtl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useStore } from "../host";
import { useNav, VIEW_PULL } from "../nav";
import { defaultPrSettings, usePrSettings } from "../settings";
import { installFakeCtx, type FakeCtx } from "../test/ctx";
import { resetStores } from "../test/reset";
import { ReviewSettings } from "./ReviewSettings";
import { ReviewEditor, ReviewSubmit } from "./ReviewEditor";
import { ReviewSidebar } from "./ReviewSidebar";
import { MergeCard, PullPage } from "./PullWorkspace";
import { draftKey, editDraft, ensureDraft, flushDraft, pullFilter, pullFilterError, reviewStatus, useReviewDrafts, useReviews } from "./state";
import { openPull } from "../nav";
import { inboxFixture, pullFixture, reviewFixture } from "./fixtures";

vi.mock("../host", () => import("../test/host"));
vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear() } });
});

let fake: FakeCtx;
const models = vi.fn().mockResolvedValue([{ id: "review-model", display_name: "Review model", is_default: true, efforts: ["low", "high"], default_effort: "high" }]);
beforeEach(() => {
  resetStores();
  fake = installFakeCtx();
  fake.rpc.mockImplementation(async (method: string) => method === "reviews.defaults" ? { instructions: "Default instructions" } : method === "reviews.start" ? { ...reviewFixture, status: "queued" } : inboxFixture);
  useReviews.setState({ inbox: inboxFixture });
  useStore.setState({ dialog: { kind: "none" }, providers: [{ kind: "codex", display_name: "Codex", available: true }] as never, client: { models } as never });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("opening and cancelling settings never starts a review", async () => {
  const close = vi.fn();
  render(<ReviewSettings pull={pullFixture} close={close} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Start pre-review" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).toHaveBeenCalled();
  expect(fake.rpc.mock.calls.some(([method]) => method === "reviews.start")).toBe(false);
});

it("sends the confirmed replacement prompt, model and effort, then opens the pre-review", async () => {
  const close = vi.fn();
  render(<ReviewSettings pull={pullFixture} close={close} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Start pre-review" }).hasAttribute("disabled")).toBe(false));
  fireEvent.change(screen.getByLabelText("Review instructions"), { target: { value: "replace" } });
  expect(screen.getByRole("button", { name: "Start pre-review" }).hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByLabelText("Replacement instructions"), { target: { value: "Check edge cases" } });
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "review-model" } });
  fireEvent.change(screen.getByLabelText("Effort"), { target: { value: "high" } });
  fireEvent.click(screen.getByRole("button", { name: "Start pre-review" }));
  await waitFor(() => expect(fake.rpc).toHaveBeenCalledWith("reviews.start", expect.objectContaining({ config: expect.objectContaining({ prompt_mode: "replace", prompt: "Check edge cases", model: "review-model", effort: "high" }) })));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(fake.view()).toEqual({ id: VIEW_PULL, props: { pull: pullFixture } });
  expect(useNav.getState().reviewId).toBe(reviewFixture.id);
});

it("opens a PR as the mod's view, marks it while it shows and forgets it when it closes", () => {
  openPull(pullFixture);
  expect(fake.view()).toEqual({ id: VIEW_PULL, props: { pull: pullFixture } });
  expect(useStore.getState().focus).toBe("main");
  fake.rpc.mockImplementation(() => new Promise(() => {}));
  const { unmount } = render(<><ReviewSidebar /><PullPage props={{ pull: pullFixture }} close={() => {}} /></>);
  expect(screen.getByTitle(pullFixture.title).closest(".pr-sidebar-row")!.className).toContain("selected");
  unmount();
  expect(useNav.getState().pull).toBe(null);
});

it("hides and restores PRs through the persisted account-scoped preference", async () => {
  render(<ReviewSidebar />);
  fireEvent.click(screen.getByTitle("Hide PR"));
  await waitFor(() => expect(fake.rpc).toHaveBeenCalledWith("pulls.hide", { id: pullFixture.id, account: pullFixture.account }));
  act(() => useReviews.setState({ inbox: { ...inboxFixture, pulls: [{ ...pullFixture, hidden: true }] }, showHidden: true }));
  fireEvent.click(screen.getByTitle("Restore PR"));
  await waitFor(() => expect(fake.rpc).toHaveBeenCalledWith("pulls.restore", { id: pullFixture.id, account: pullFixture.account }));
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

it("shows your pull request as reviewed when someone only left comments", () => {
  const commented = { ...pullFixture, author: "reviewer", reviews: [{ bot: false, reviewer: "alice", state: "COMMENTED", submitted_at: "2026-10-05T10:00:00Z", commit_sha: pullFixture.head_sha }] };
  useReviews.setState({ inbox: { ...inboxFixture, pulls: [], mine: [commented] } });
  render(<ReviewSidebar />);
  expect([...screen.getByTitle(pullFixture.title).querySelectorAll(".chip")].map((c) => c.textContent)).toEqual(["checks pass", "commented"]);
});

it("derives the review state from other people's reviews when GitHub made no decision", () => {
  const by = (...states: string[]) => states.map((state, i) => ({ bot: false, reviewer: `r${i}`, state, submitted_at: "", commit_sha: "" }));
  expect(reviewStatus({ review_decision: "APPROVED", reviews: by("COMMENTED") })).toEqual({ label: "approved", tone: "ok" });
  expect(reviewStatus({ review_decision: "REVIEW_REQUIRED", reviews: [] })).toEqual({ label: "review required" });
  expect(reviewStatus({ review_decision: "REVIEW_REQUIRED", reviews: by("COMMENTED") })).toEqual({ label: "commented" });
  expect(reviewStatus({ review_decision: "REVIEW_REQUIRED", reviews: by("COMMENTED", "APPROVED") })).toEqual({ label: "approved, review required" });
  expect(reviewStatus({ review_decision: "", reviews: by("APPROVED") })).toEqual({ label: "approved", tone: "ok" });
  expect(reviewStatus({ review_decision: "", reviews: by("APPROVED", "CHANGES_REQUESTED") })).toEqual({ label: "changes requested", tone: "err" });
  expect(reviewStatus({ review_decision: "", reviews: [] })).toBeUndefined();
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
  useReviews.setState({ inbox: { ...inboxFixture, pulls: [pullFixture, bot] } });
  render(<ReviewSidebar />);
  expect(screen.queryByTitle("Bump lodash")).toBe(null);
  expect(screen.getByRole("button", { name: /Needs your review/ }).textContent).toContain("1");
  fireEvent.click(screen.getByRole("button", { name: "Show hidden" }));
  expect(screen.getByTitle("Bump lodash").textContent).toContain("hidden by author:dependabot");
  act(() => usePrSettings.getState().set({ pullFilters: [] }));
  expect(fake.storage.get("pullFilters")).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Hide hidden" }));
  expect(screen.getByTitle("Bump lodash")).toBeTruthy();
  expect(screen.getByRole("button", { name: /Needs your review/ }).textContent).toContain("2");
});

it("flush waits for text typed during an in-flight save", async () => {
  let resolve!: (value: unknown) => void;
  fake.rpc.mockImplementationOnce(() => new Promise((r) => { resolve = r; })).mockImplementationOnce(async (_method: string, p: any) => ({ ...reviewFixture, revision: 2, result: p.result }));
  ensureDraft(reviewFixture);
  editDraft(reviewFixture.id, { ...reviewFixture.result, summary: "first" });
  const pending = flushDraft(reviewFixture.id);
  editDraft(reviewFixture.id, { ...reviewFixture.result, summary: "second" });
  resolve({ ...reviewFixture, revision: 1, result: { ...reviewFixture.result, summary: "first" } });
  await pending;
  expect(fake.rpc).toHaveBeenLastCalledWith("reviews.save", expect.objectContaining({ revision: 1, result: expect.objectContaining({ summary: "second" }) }));
  expect(useReviewDrafts.getState().drafts[reviewFixture.id].saving).toBe(false);
  expect(fake.storage.has(draftKey(reviewFixture.id))).toBe(false);
});

it("save failure retains recoverable local edits", async () => {
  fake.rpc.mockRejectedValue(new Error("offline")); ensureDraft(reviewFixture);
  editDraft(reviewFixture.id, { ...reviewFixture.result, summary: "keep this" });
  await expect(flushDraft(reviewFixture.id)).rejects.toThrow("offline");
  expect(JSON.stringify(fake.storage.get(`review-draft.${reviewFixture.id}`))).toContain("keep this");
  // A reload finds them again.
  useReviewDrafts.setState({ drafts: {} });
  ensureDraft(reviewFixture);
  expect(useReviewDrafts.getState().drafts[reviewFixture.id].result.summary).toBe("keep this");
});

it("preview is inert until its explicit Post button is clicked", async () => {
  const preview = { token: "token", review_id: reviewFixture.id, revision: 0, account: pullFixture.account, head_sha: pullFixture.head_sha, reviewed_sha: pullFixture.head_sha, event: "COMMENT", body: "Preview body", comments: [], stale: false };
  const close = vi.fn();
  render(<ReviewSubmit preview={preview} close={close} />);
  expect(fake.rpc).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
  await waitFor(() => expect(fake.rpc).toHaveBeenCalledWith("reviews.submit", { id: reviewFixture.id, token: "token" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
});

it("marks a PR whose review was requested again after you reviewed it", () => {
  const again = { ...pullFixture, my_review: { bot: false, reviewer: "reviewer", state: "APPROVED", submitted_at: "2026-10-01T10:00:00Z", commit_sha: "c".repeat(40) }, review_requested_at: "2026-10-02T10:00:00Z" };
  const earlier = { ...reviewFixture, status: "submitted", created_at: "2026-10-01T09:00:00Z" };
  useReviews.setState({ inbox: { ...inboxFixture, pulls: [again], reviews: [earlier] } });
  render(<ReviewSidebar />);
  const row = screen.getByTitle(pullFixture.title);
  expect([...row.querySelectorAll(".chip")].map((c) => c.textContent)).toEqual(["re-review requested", "changed since your review", "checks pass", "review required", "submitted · earlier round"]);
  expect(row.closest(".pr-sidebar-row")!.className).toContain("rerequested");
});

it("shows your verdict on a PR you already reviewed in this round", () => {
  const reviewed = { ...pullFixture, my_review: { bot: false, reviewer: "reviewer", state: "CHANGES_REQUESTED", submitted_at: "2026-10-02T10:00:00Z", commit_sha: pullFixture.head_sha }, review_requested_at: "2026-10-01T10:00:00Z" };
  useReviews.setState({ inbox: { ...inboxFixture, pulls: [reviewed] } });
  render(<ReviewSidebar />);
  const row = screen.getByTitle(pullFixture.title);
  expect(row.textContent).toContain("you requested changes");
  expect(row.textContent).not.toContain("re-review requested");
  expect(row.closest(".pr-sidebar-row")!.className).not.toContain("rerequested");
});

const mergeable = { ...pullFixture, can_merge: true, can_delete_branch: true, merge_state: "CLEAN", merge_blocked_by: null, merge_methods: ["merge", "squash"], default_merge_method: "merge" };
it("keeps merging disabled with GitHub's reason until the PR is ready", () => {
  render(<MergeCard pull={{ ...mergeable, merge_state: "BLOCKED", merge_blocked_by: "A review is required" }} busy={false} onMerged={() => {}} />);
  expect(screen.getByText("A review is required")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create a merge commit" }).hasAttribute("disabled")).toBe(true);
});

it("merges the shown head with the remembered method and branch choice", async () => {
  usePrSettings.setState({ ...defaultPrSettings, mergeMethod: "squash", deleteBranchAfterMerge: true });
  fake.rpc.mockResolvedValue({ branch_deleted: false, branch_error: null });
  const onMerged = vi.fn();
  render(<MergeCard pull={mergeable} busy={false} onMerged={onMerged} />);
  expect((screen.getByLabelText("Merge method") as HTMLSelectElement).value).toBe("squash");
  fireEvent.click(screen.getByRole("checkbox"));
  expect(usePrSettings.getState().deleteBranchAfterMerge).toBe(false);
  expect(fake.storage.get("deleteBranchAfterMerge")).toBe(false);
  fireEvent.change(screen.getByLabelText("Merge method"), { target: { value: "merge" } });
  expect(usePrSettings.getState().mergeMethod).toBe("merge");
  expect(fake.storage.get("mergeMethod")).toBe("merge");
  fireEvent.click(screen.getByRole("button", { name: "Create a merge commit" }));
  expect(fake.rpc).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm create a merge commit" }));
  await waitFor(() => expect(onMerged).toHaveBeenCalled());
  expect(fake.rpc).toHaveBeenCalledWith("pulls.merge", { repo: "acme/widget", number: 42, account: pullFixture.account, method: "merge", sha: pullFixture.head_sha, delete_branch: false });
});

it("falls back to the repository's default when the remembered method is not allowed", () => {
  usePrSettings.setState({ ...defaultPrSettings, mergeMethod: "rebase" });
  render(<MergeCard pull={mergeable} busy={false} onMerged={() => {}} />);
  expect((screen.getByLabelText("Merge method") as HTMLSelectElement).value).toBe("merge");
});

it("labels mergeable PRs in the sidebar", () => {
  useReviews.setState({ inbox: { ...inboxFixture, pulls: [mergeable] } });
  render(<ReviewSidebar />);
  expect(screen.getByText("ready to merge")).toBeTruthy();
});

it("follows a review an orchestrator is writing as it changes, until the user takes it over", async () => {
  const source = { orchestrator: "o1", orchestrator_title: "Lead", worker: "w1", worker_title: "Review 42" };
  let review = { ...reviewFixture, status: "drafting", phase: "drafting", context_mode: "recorded", source, agent: { provider: "Codex", model: "gpt-5.5", model_id: null, effort: "high" } };
  fake.rpc.mockImplementation(async (method: string) => {
    if (method === "reviews.ready") review = { ...review, status: "ready", phase: "done" };
    return method === "reviews.get" || method === "reviews.ready" ? review : inboxFixture;
  });
  render(<ReviewEditor id={review.id} />);
  expect(await screen.findByText(/Lead is still writing this review/)).toBeTruthy();
  expect(screen.getByText(/Codex · model gpt-5.5 · effort high · Recorded by Lead from its worker Review 42/)).toBeTruthy();
  expect((screen.getByLabelText("Summary") as HTMLTextAreaElement).disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "Submit to GitHub…" })).toBeNull();
  // The orchestrator changes it: the daemon says so, and the editor reads it again.
  review = { ...review, revision: 1, result: { ...review.result, summary: "Written by the worker" } };
  act(() => fake.emit("reviews.changed"));
  await waitFor(() => expect((screen.getByLabelText("Summary") as HTMLTextAreaElement).value).toBe("Written by the worker"));
  fireEvent.click(screen.getByRole("button", { name: "Take over and edit" }));
  await waitFor(() => expect(fake.rpc).toHaveBeenCalledWith("reviews.ready", { id: review.id }));
  await waitFor(() => expect((screen.getByLabelText("Summary") as HTMLTextAreaElement).disabled).toBe(false));
  expect(screen.getByRole("button", { name: "Submit to GitHub…" })).toBeTruthy();
});

it("asks before discarding a pre-review, and opens the submit dialog with the preview", async () => {
  const preview = { token: "t", review_id: reviewFixture.id };
  fake.rpc.mockImplementation(async (method: string) => method === "reviews.get" ? reviewFixture : method === "reviews.preview" ? preview : inboxFixture);
  fake.confirm.mockResolvedValueOnce(false);
  render(<ReviewEditor id={reviewFixture.id} />);
  fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
  await waitFor(() => expect(fake.confirm).toHaveBeenCalledWith({ title: "Discard pre-review?", message: "Nothing will be posted to GitHub." }));
  expect(fake.rpc).not.toHaveBeenCalledWith("reviews.discard", expect.anything());
  fireEvent.click(screen.getByRole("button", { name: "Submit to GitHub…" }));
  await waitFor(() => expect(fake.dialogs).toEqual([{ id: "review-submit", props: { preview } }]));
});

it("names the orchestrator that recorded a PR's pre-review on its chip", () => {
  const recorded = { ...reviewFixture, source: { orchestrator: "o1", orchestrator_title: "Lead", worker: null, worker_title: null } };
  useReviews.setState({ inbox: { ...inboxFixture, reviews: [recorded] } });
  render(<ReviewSidebar />);
  expect(screen.getByTitle("Recorded by Lead").textContent).toBe("ready");
});

it("closes the PR page and the review dialogs when the GitHub account changed", async () => {
  openPull(pullFixture);
  const close = vi.fn();
  fake.rpc.mockImplementation(async (method: string) => method === "reviews.defaults" ? { instructions: "x" } : { ...inboxFixture, account: "github.com:someone-else" });
  render(<ReviewSettings pull={pullFixture} close={close} />);
  await act(() => useReviews.getState().refresh());
  expect(fake.view()).toBe(null);
  expect(close).toHaveBeenCalled();
  expect(fake.toasts.at(-1)?.message).toMatch(/GitHub account changed/);
});
