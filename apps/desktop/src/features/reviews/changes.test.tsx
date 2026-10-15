import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../../lib/rpc";
import type { PullChange } from "../../gen";
import { defaultSettings, useStore } from "../../state/store";
import { normalizePullChanges } from "../../lib/pulls";
import { InboxDialog } from "../../components/dialogs/InboxDialog";
import { announcedReviews } from "../watches/state";
import { usePullChangeSync, usePullChanges } from "./changes";
import { useReviews } from "./state";
import { inboxFixture, pullFixture } from "./fixtures";
vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear() } });
});

const change = (extra: Partial<PullChange> = {}): PullChange => ({
  id: "change-1", account: pullFixture.account, pull_id: pullFixture.id, repo: pullFixture.repo, number: pullFixture.number,
  title: pullFixture.title, url: pullFixture.url, role: "requested", summary: "bob pushed 2 commits · alice approved",
  events: [
    { kind: "commits", actor: "bob", bot: false, detail: "", count: 2, review_id: 0, text: "bob pushed 2 commits" },
    { kind: "review", actor: "alice", bot: false, detail: "APPROVED", count: 1, review_id: 77, text: "alice approved" },
  ],
  created_at: new Date().toISOString(), read: false, ...extra,
});
const call = vi.fn();
let notify: ((method: string, params: unknown) => void) | undefined;
let changes: PullChange[] = [];
beforeEach(() => {
  call.mockReset();
  changes = [change()];
  call.mockImplementation(async (method: string) => method === "pulls.changes" ? changes : method === "pending" ? { approvals: [], inputs: [] } : true);
  announcedReviews.clear();
  usePullChanges.setState({ changes: [] });
  useReviews.setState({ inbox: inboxFixture, reviewId: "stale" });
  useStore.setState({
    prSelection: null, dialog: { kind: "inbox" }, toasts: [], settings: { ...defaultSettings },
    client: { call, pending: async () => ({ approvals: [], inputs: [] }), onNotification: (l: typeof notify) => { notify = l; return () => {}; }, onState: () => () => {} } as unknown as RpcClient,
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("lists unread pull request changes and opens the PR on click, marking the entry read", async () => {
  render(<InboxDialog />);
  const row = await screen.findByRole("button", { name: /Handle empty responses/ });
  expect(row.textContent).toContain("acme/widget#42");
  expect(row.textContent).toContain("bob pushed 2 commits · alice approved");
  expect(row.textContent).toContain("review requested");
  fireEvent.click(row);
  await waitFor(() => expect(useStore.getState().prSelection?.id).toBe(pullFixture.id));
  expect(useReviews.getState().reviewId).toBe(null);
  expect(useStore.getState().dialog.kind).toBe("none");
  expect(call).toHaveBeenCalledWith("pulls.changes.read", { ids: ["change-1"] });
  expect(usePullChanges.getState().changes[0].read).toBe(true);
});

it("opens a PR the sidebar does not list, such as a merged one, from its last copy or GitHub", async () => {
  const merged = { ...pullFixture, id: "acme/widget#9", number: 9, title: "Merged one", state: "merged" };
  changes = [change({ id: "change-9", pull_id: merged.id, number: 9, title: "Merged one" })];
  call.mockImplementation(async (method: string) => method === "pulls.changes" ? changes : method === "pulls.cached" ? Promise.reject(new Error("No cached PR detail")) : method === "pulls.get" ? { pull: merged } : true);
  render(<InboxDialog />);
  fireEvent.keyDown(await screen.findByRole("button", { name: /Merged one/ }), { key: "Enter" });
  await waitFor(() => expect(useStore.getState().prSelection?.id).toBe(merged.id));
  expect(call).toHaveBeenCalledWith("pulls.get", { repo: "acme/widget", number: 9, account: pullFixture.account });
});

it("leaves out muted kinds, and entries with nothing else", async () => {
  changes = [change(), change({ id: "change-2", title: "Only checks", events: [{ kind: "checks", actor: "", bot: false, detail: "FAILURE", count: 1, review_id: 0, text: "checks failed" }] })];
  useStore.setState({ settings: { ...defaultSettings, pullChangesMuted: ["commits", "checks"] } });
  render(<InboxDialog />);
  const row = await screen.findByRole("button", { name: /Handle empty responses/ });
  expect(row.textContent).toContain("alice approved");
  expect(row.textContent).not.toContain("commits");
  expect(screen.queryByText("Only checks")).toBeNull();
  fireEvent.keyDown(row, { key: "x" });
  await waitFor(() => expect(screen.getByText("Nothing is waiting for you")).toBeTruthy());
});

function Sync() { usePullChangeSync(true); return null; }

it("announces new changes, and a click on the notification opens the PR", async () => {
  const shown: { title: string; body?: string; onclick: (() => void) | null }[] = [];
  class FakeNotification { static permission = "granted"; onclick: (() => void) | null = null; constructor(public title: string, options?: { body?: string }) { shown.push(Object.assign(this, { body: options?.body })); } }
  vi.stubGlobal("Notification", FakeNotification);
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  vi.spyOn(window, "focus").mockImplementation(() => {});
  useStore.setState({ dialog: { kind: "none" } });
  render(<Sync />);
  notify?.("pulls.activity", { changes: [change()] });
  expect(useStore.getState().toasts.at(-1)?.message).toBe("acme/widget#42: bob pushed 2 commits · alice approved");
  await waitFor(() => expect(shown.length).toBe(1));
  expect(shown[0].title).toBe("Handle empty responses");
  shown[0].onclick?.();
  await waitFor(() => expect(useStore.getState().prSelection?.id).toBe(pullFixture.id));
  expect(call).toHaveBeenCalledWith("pulls.changes.read", { ids: ["change-1"] });

  // The same review again (announced by a watch, say) and only muted kinds stay quiet.
  useStore.setState({ toasts: [], settings: { ...defaultSettings, pullChangesMuted: ["commits"] } });
  notify?.("pulls.activity", { changes: [change({ id: "change-3" })] });
  expect(useStore.getState().toasts).toEqual([]);

  // Without the notifications setting, no OS notification.
  useStore.setState({ settings: { ...defaultSettings, notifications: false } });
  notify?.("pulls.activity", { changes: [change({ id: "change-4", events: [{ kind: "comment", actor: "carol", bot: false, detail: "", count: 1, review_id: 0, text: "carol commented" }] })] });
  expect(useStore.getState().toasts.at(-1)?.message).toBe("acme/widget#42: carol commented");
  await new Promise((r) => setTimeout(r, 0));
  expect(shown.length).toBe(1);
});

it("reads entries from an older or newer daemon", () => {
  expect(normalizePullChanges(undefined)).toEqual([]);
  const [c] = normalizePullChanges([{ id: "x", events: [{ kind: "comment" }] }]);
  expect(c.events[0]).toEqual({ kind: "comment", actor: "", bot: false, detail: "", count: 1, review_id: 0, text: "" });
  expect([c.read, c.summary]).toEqual([false, ""]);
});
