import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../../lib/rpc";
import type { PrWatch, Session } from "../../gen";
import { useStore } from "../../state/store";
import { useLinkPreferencesStore } from "../../state/sessionLinkPreferences";
import { WatchDialog, people } from "./WatchDialog";
import { WatchSection } from "./WatchSection";
import { currentWatchTarget, useWatchSync, useWatches, type Candidates } from "./state";

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
const call = vi.fn();
let notify: ((method: string, params: unknown) => void) | undefined;
beforeEach(() => {
  call.mockReset();
  call.mockImplementation(async (method: string) => method === "watches.candidates" ? candidates : method === "watches.list" ? [] : {});
  useWatches.setState({ watches: [], error: null });
  useStore.setState({ dialog: { kind: "none" }, toasts: [], prSelection: null, client: { call, onNotification: (l: typeof notify) => { notify = l; return () => {}; }, onState: () => () => {} } as unknown as RpcClient });
});
afterEach(() => cleanup());

it("lists requested reviewers, then earlier reviewers, then everyone else alphabetically", () => {
  expect(people(candidates).map((p) => p.login)).toEqual(["alice", "carol", "bob", "zed"]);
});

it("watches the requested reviewer and requests the ones the user adds", async () => {
  render(<WatchDialog target={{ repo: "o/r", number: 7 }} />);
  await waitFor(() => expect(screen.getByText("zed")).toBeTruthy());
  expect((screen.getByRole("checkbox", { name: /alice/ }) as HTMLInputElement).checked).toBe(true);
  fireEvent.change(screen.getByLabelText("Find reviewers"), { target: { value: "ze" } });
  fireEvent.keyDown(screen.getByLabelText("Find reviewers"), { key: "Enter" });
  expect(screen.getByText("will request")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Request & watch/ }));
  await waitFor(() => expect(call).toHaveBeenCalledWith("watches.start", { repo: "o/r", number: 7, reviewers: ["alice", "zed"], request: ["zed"] }));
});

it("shows who is still pending and every review, including comment-only ones", () => {
  useWatches.setState({ watches: [watch] });
  render(<WatchSection target={{ repo: "O/R", number: 7 }} />);
  expect(screen.getByText("Waiting for bob")).toBeTruthy();
  expect(screen.getByText("alice commented")).toBeTruthy();
});

it("announces reviews the daemon reports", () => {
  function Sync() { useWatchSync(true); return null; }
  render(<Sync />);
  notify?.("watches.review", { watch, review: watch.reviews[0] });
  expect(useStore.getState().toasts.at(-1)?.message).toBe("alice commented on o/r#7: Looks off");
});

it("targets the selected session's saved PR link", () => {
  useStore.setState({ selectedId: "s", sessions: { s: { id: "s", title: "work" } as Session }, transcripts: {} });
  useLinkPreferencesStore.setState({ entries: { s: { preferences: { pr: "https://github.com/o/r/pull/7" } } } });
  expect(currentWatchTarget()).toEqual({ repo: "o/r", number: 7 });
});
