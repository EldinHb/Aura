// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "../test/rtl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PrWatch } from "@aura/github-client";
import { useStore } from "../host";
import { useNav } from "../nav";
import { startSync } from "../sync";
import { installFakeCtx, type FakeCtx } from "../test/ctx";
import { resetStores } from "../test/reset";
import { pullFixture } from "../reviews/fixtures";
import { type Session } from "../reviews/sessions";
import { WatchDialog, people } from "./WatchDialog";
import { SessionWatches, WatchSection } from "./WatchSection";
import { currentWatchTarget, isHandlingReview, useWatches, type Candidates } from "./state";

vi.mock("../host", () => import("../test/host"));

const candidates: Candidates = {
  title: "Add watch", url: "https://github.com/o/r/pull/7", author: "me", state: "open",
  requested: ["alice"], teams: [], reviewed: [{ login: "carol", state: "COMMENTED" }],
  candidates: ["zed", "bob", "alice", "carol"], candidate_error: null, watch: null,
};
const watch: PrWatch = {
  id: "o/r#7", account: "github.com:me", repo: "o/r", number: 7, url: "", title: "Add watch", author: "me",
  reviewers: ["alice", "bob"], status: "watching", seen: 3, created_at: "", updated_at: "", last_checked: null, error: null,
  reviews: [{ id: 4, reviewer: "alice", state: "COMMENTED", body: "Looks off", url: "https://github.com/o/r/pull/7#pullrequestreview-4", submitted_at: new Date().toISOString() }],
};
let fake: FakeCtx;
let stop: (() => void) | undefined;
beforeEach(() => {
  resetStores();
  fake = installFakeCtx();
  fake.rpc.mockImplementation(async (method: string) => method === "watches.candidates" ? candidates : method === "watches.list" ? [] : method === "pulls.list" ? { pulls: [], mine: [], reviewed: [], reviews: [] } : {});
  useStore.setState({ dialog: { kind: "none" }, selectedId: null });
});
afterEach(() => { stop?.(); stop = undefined; cleanup(); });

it("lists requested reviewers, then earlier reviewers, then everyone else alphabetically", () => {
  expect(people(candidates).map((p) => p.login)).toEqual(["alice", "carol", "bob", "zed"]);
});

it("watches the requested reviewer and requests the ones the user adds", async () => {
  const close = vi.fn();
  render(<WatchDialog target={{ repo: "o/r", number: 7 }} close={close} />);
  await waitFor(() => expect(screen.getByText("zed")).toBeTruthy());
  expect((screen.getByRole("checkbox", { name: /alice/ }) as HTMLInputElement).checked).toBe(true);
  fireEvent.change(screen.getByLabelText("Find reviewers"), { target: { value: "ze" } });
  fireEvent.keyDown(screen.getByLabelText("Find reviewers"), { key: "Enter" });
  expect(screen.getByText("will request")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Request & watch/ }));
  await waitFor(() => expect(fake.rpc).toHaveBeenCalledWith("watches.start", { repo: "o/r", number: 7, reviewers: ["alice", "zed"], request: ["zed"] }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(fake.toasts.at(-1)?.message).toBe("Watching o/r#7 for reviews");
});

it("shows who is still pending and every review, including comment-only ones", () => {
  useWatches.setState({ watches: [watch] });
  render(<WatchSection target={{ repo: "O/R", number: 7 }} />);
  expect(screen.getByText("Waiting for bob")).toBeTruthy();
  expect(screen.getByText("alice commented")).toBeTruthy();
});

it("shows a watch section for each PR the github mod links to the session, and opens the watch dialog", async () => {
  fake.call.mockImplementation(async (mod: string, method: string, params: any) =>
    mod === "github" && method === "session.prs" && params.sessionId === "s" ? ["https://github.com/o/r/pull/7", "o/r#8", "https://github.com/O/R/pull/7"] : []);
  render(<SessionWatches session={{ id: "s", title: "work", status: "idle" } as Session} />);
  expect(await screen.findByText("Review watch · #7")).toBeTruthy();
  expect(screen.getByText("Review watch · #8")).toBeTruthy();
  fireEvent.click(screen.getAllByRole("button", { name: "Watch…" })[0]);
  await waitFor(() => expect(fake.dialogs).toEqual([{ id: "pr-watch", props: { repo: "o/r", number: 7 } }]));
});

it("announces reviews the daemon reports", () => {
  stop = startSync(fake.api, true);
  fake.emit("watches.review", { watch, review: watch.reviews[0] });
  expect(fake.toasts.at(-1)?.message).toBe("alice commented on o/r#7: Looks off");
});

it("refreshes the watches when the daemon says they changed", async () => {
  stop = startSync(fake.api, true);
  fake.rpc.mockImplementation(async (method: string) => method === "watches.list" ? [watch] : {});
  act(() => fake.emit("watches.changed"));
  await waitFor(() => expect(useWatches.getState().watches).toEqual([watch]));
});

it("announces review activity handed to a session once, and how the session handled it", () => {
  stop = startSync(fake.api, true);
  const review = { id: 50, reviewer: "bob", state: "CHANGES_REQUESTED", body: "Rename it", url: "", submitted_at: "" };
  fake.emit("watches.review", { watch, review });
  fake.emit("follows.activity", {
    pr: { repo: "o/r", number: 7, title: "Add watch", url: "" },
    items: [
      { kind: "review", id: 50, author: "bob", state: "CHANGES_REQUESTED", body: "Rename it", url: "", path: null, line: null },
      { kind: "comment", id: 60, author: "bob", state: "", body: "Typo here", url: "", path: "a.rs", line: 3 },
    ],
    session: { id: "s", title: "Feature" },
  });
  const messages = () => fake.toasts.map((t) => t.message);
  expect(messages().at(-1)).toBe("bob commented on o/r#7: Typo here — for “Feature”");
  expect(isHandlingReview("s")).toBe(false);
  fake.emit("follows.started", { session: { id: "s", title: "Feature" }, prs: [] });
  expect(isHandlingReview("s")).toBe(true);
  fake.emit("follows.handled", { session: { id: "s", title: "Feature" }, prs: [{ repo: "o/r", number: 7, title: "", url: "" }], status: "completed", reply: "Renamed it and pushed." });
  expect(messages().at(-1)).toBe("“Feature” handled the review on o/r#7: Renamed it and pushed.");
});

it("targets the open PR, else the selected session's first linked PR", async () => {
  fake.call.mockImplementation(async (mod: string, method: string) => mod === "github" && method === "session.prs" ? ["https://github.com/o/r/pull/7", "https://github.com/o/r/pull/8"] : []);
  expect(await currentWatchTarget()).toBe(null);
  useStore.setState({ selectedId: "s", sessions: { s: { id: "s", title: "work" } as Session } });
  expect(await currentWatchTarget()).toEqual({ repo: "o/r", number: 7 });
  expect(fake.call).toHaveBeenCalledWith("github", "session.prs", { sessionId: "s" });
  useNav.setState({ pull: pullFixture });
  expect(await currentWatchTarget()).toEqual({ repo: "acme/widget", number: 42 });
});
