// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "../test/rtl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PullChange } from "@aura/github-client";
import type { InboxItemProps } from "@aura/mod-sdk/ui";
import { useStore } from "../host";
import { openInboxItem, PullChangeItem } from "../inbox";
import { useNav, VIEW_PULL } from "../nav";
import { normalizePullChanges } from "../pulls";
import { defaultPrSettings, usePrSettings } from "../settings";
import { startSync } from "../sync";
import { installFakeCtx, type FakeCtx } from "../test/ctx";
import { resetStores } from "../test/reset";
import { unreadChanges } from "./changes";
import { useReviews } from "./state";
import { inboxFixture, pullFixture } from "./fixtures";

vi.mock("../host", () => import("../test/host"));
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
/** As the daemon half puts a change in Aura's inbox. */
const item = (c: PullChange): InboxItemProps["item"] => ({ id: `pull-change:${c.id}`, title: c.title, detail: c.summary, at: c.created_at, unread: !c.read, data: c as never });

let fake: FakeCtx;
let stop: (() => void) | undefined;
beforeEach(() => {
  resetStores();
  fake = installFakeCtx();
  fake.rpc.mockImplementation(async (method: string) => method === "pulls.list" ? inboxFixture : method === "watches.list" ? [] : true);
  useReviews.setState({ inbox: inboxFixture });
  useNav.setState({ reviewId: "stale" });
  useStore.setState({ dialog: { kind: "inbox" }, settings: { ...useStore.getState().settings, notifications: true } });
});
afterEach(() => { stop?.(); stop = undefined; cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("renders an unread pull request change in the inbox and opens the PR, marking the entry read", async () => {
  render(<PullChangeItem item={item(change())} />);
  expect(screen.getByText("Handle empty responses")).toBeTruthy();
  expect(screen.getByText("acme/widget#42")).toBeTruthy();
  expect(screen.getByText("bob pushed 2 commits · alice approved")).toBeTruthy();
  expect(screen.getByText("review requested")).toBeTruthy();
  openInboxItem(item(change()));
  await waitFor(() => expect(fake.view()).toEqual({ id: VIEW_PULL, props: { pull: pullFixture } }));
  expect(useNav.getState().reviewId).toBe(null);
  expect(fake.rpc).toHaveBeenCalledWith("pulls.changes.read", { ids: ["change-1"] });
});

it("opens a PR the sidebar does not list, such as a merged one, from its last copy or GitHub", async () => {
  const merged = { ...pullFixture, id: "acme/widget#9", number: 9, title: "Merged one", state: "merged" };
  fake.rpc.mockImplementation(async (method: string) => method === "pulls.cached" ? Promise.reject(new Error("No cached PR detail")) : method === "pulls.get" ? { pull: merged } : true);
  openInboxItem(item(change({ id: "change-9", pull_id: merged.id, number: 9, title: "Merged one" })));
  await waitFor(() => expect(useNav.getState().pull?.id).toBe(merged.id));
  expect(fake.rpc).toHaveBeenCalledWith("pulls.get", { repo: "acme/widget", number: 9, account: pullFixture.account });
});

it("says when a PR cannot be opened", async () => {
  fake.rpc.mockRejectedValue(new Error("offline"));
  openInboxItem(item(change({ pull_id: "acme/widget#5", number: 5 })));
  await waitFor(() => expect(fake.toasts.at(-1)).toEqual({ message: "Could not open acme/widget#5: Error: offline", level: "error" }));
});

it("leaves out muted kinds, and counts entries with nothing else as nothing new", () => {
  usePrSettings.setState({ ...defaultPrSettings, pullChangesMuted: ["commits", "checks"] });
  render(<PullChangeItem item={item(change())} />);
  expect(screen.getByText("alice approved")).toBeTruthy();
  expect(screen.queryByText(/commits/)).toBeNull();
  const onlyChecks = change({ id: "change-2", events: [{ kind: "checks", actor: "", bot: false, detail: "FAILURE", count: 1, review_id: 0, text: "checks failed" }] });
  expect(unreadChanges([change(), onlyChecks, change({ id: "change-3", read: true })], ["commits", "checks"]).map((c) => c.id)).toEqual(["change-1"]);
});

it("announces new changes, and a click on the notification opens the PR", async () => {
  // Notifications go through Aura (ctx.notify); a click comes back with the target.
  const shown = (fake.api.notify as unknown as { mock: { calls: [string, string, unknown][] } }).mock.calls;
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  vi.spyOn(window, "focus").mockImplementation(() => {});
  useStore.setState({ dialog: { kind: "none" } });
  stop = startSync(fake.api, true);
  fake.emit("pulls.activity", { changes: [change()] });
  expect(fake.toasts.at(-1)?.message).toBe("acme/widget#42: bob pushed 2 commits · alice approved");
  await waitFor(() => expect(shown.length).toBe(1));
  expect(shown[0][0]).toBe("Handle empty responses");
  (await import("../notify")).handleNotificationTarget(shown[0][2]);
  await waitFor(() => expect(useNav.getState().pull?.id).toBe(pullFixture.id));
  expect(fake.rpc).toHaveBeenCalledWith("pulls.changes.read", { ids: ["change-1"] });

  // The same review again (announced by a watch, say) and only muted kinds stay quiet.
  fake.toasts.length = 0;
  usePrSettings.setState({ ...defaultPrSettings, pullChangesMuted: ["commits"] });
  fake.emit("pulls.activity", { changes: [change({ id: "change-3" })] });
  expect(fake.toasts).toEqual([]);

  // Without the notifications setting, no OS notification.
  useStore.setState({ settings: { ...useStore.getState().settings, notifications: false } });
  fake.emit("pulls.activity", { changes: [change({ id: "change-4", events: [{ kind: "comment", actor: "carol", bot: false, detail: "", count: 1, review_id: 0, text: "carol commented" }] })] });
  expect(fake.toasts.at(-1)?.message).toBe("acme/widget#42: carol commented");
  await new Promise((r) => setTimeout(r, 0));
  expect(shown.length).toBe(1);
});

it("opens the PR of a notification the daemon half sent, through Aura's click handler", async () => {
  stop = startSync(fake.api, true);
  const { handleNotificationTarget } = await import("../notify");
  handleNotificationTarget({ kind: "pull-change", id: "change-1", account: pullFixture.account, pull_id: pullFixture.id, repo: pullFixture.repo, number: pullFixture.number });
  await waitFor(() => expect(useNav.getState().pull?.id).toBe(pullFixture.id));
  expect(useStore.getState().dialog.kind).toBe("none");
});

it("keeps a detached session window's PR list current, without announcing changes again", async () => {
  stop = startSync(fake.api, false);
  await waitFor(() => expect(fake.rpc).toHaveBeenCalledWith("pulls.list", {}));
  fake.emit("pulls.activity", { changes: [change({ id: "change-2" })] });
  expect(fake.toasts).toEqual([]);
  fake.rpc.mockClear();
  fake.emit("reviews.changed");
  await waitFor(() => expect(fake.rpc).toHaveBeenCalledWith("pulls.list", {}));
  fake.connect("open");
  expect(fake.rpc).toHaveBeenCalledWith("watches.list", {});
});

it("reads entries from an older or newer daemon", () => {
  expect(normalizePullChanges(undefined)).toEqual([]);
  const [c] = normalizePullChanges([{ id: "x", events: [{ kind: "comment" }] }]);
  expect(c.events[0]).toEqual({ kind: "comment", actor: "", bot: false, detail: "", count: 1, review_id: 0, text: "" });
  expect([c.read, c.summary]).toEqual([false, ""]);
});
