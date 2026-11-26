// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Item } from "@aura/mod-sdk";
import { daemonCtx } from "../test/ctx";
import { emptyTranscript, useStore } from "../test/host";
import { resetLinks } from "./links";
import { resetGithubRepos } from "./repos";
import { SessionLinksDialog } from "./SessionLinksDialog";

const issue = "https://github.com/owner/repo/issues/1";
const pr = "https://github.com/owner/repo/pull/2";
const pr2 = "https://github.com/other/repo/pull/9";
const close = vi.fn();
let d: ReturnType<typeof daemonCtx>;
const saved = () => d.host.sessionData.get("session")?.get("links");

beforeEach(() => {
  resetLinks();
  resetGithubRepos();
  close.mockReset();
  d = daemonCtx();
  const entry: Item = { id: "message", session_id: "session", kind: "agent_message", status: "completed", text: `Reference links: ${issue} ${pr}`, data: {}, parent_id: null, turn_id: null, title: null, started_at: "2026-09-21T00:00:00Z", ended_at: null };
  useStore.setState({
    connection: "open",
    sessions: {},
    transcripts: { session: { ...emptyTranscript(), loaded: true, items: { message: entry }, order: ["message"] } },
  });
});
afterEach(cleanup);

const dialog = () => <SessionLinksDialog props={{ sessionId: "session" }} close={close} />;
const automaticOff = (name: "Issues" | "Pull requests") =>
  fireEvent.click(within(screen.getByRole("group", { name })).getByRole("checkbox", { name: "Automatic" }));

it("adds several mentioned and pasted links, saves them, and restores them on reopening", async () => {
  const { unmount } = render(dialog());
  await screen.findByRole("group", { name: "Issues" });
  automaticOff("Issues");
  fireEvent.change(screen.getByLabelText("Add issue"), { target: { value: issue } });
  automaticOff("Pull requests");
  fireEvent.change(screen.getByLabelText("Add pull request"), { target: { value: pr } });
  fireEvent.change(screen.getByLabelText("Add pull request"), { target: { value: "paste" } });
  fireEvent.change(screen.getByLabelText("PR URL"), { target: { value: pr2 } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(screen.getByText("other/repo #9")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(saved()).toEqual({ issues: [issue], prs: [pr, pr2] }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  unmount();
  resetLinks();
  render(dialog());
  expect(await screen.findByText("owner/repo #1")).toBeTruthy();
  expect(screen.getByText("owner/repo #2")).toBeTruthy();
  expect(screen.getByText("other/repo #9")).toBeTruthy();
});

it("validates pasted URLs, removes links, turns review follow-ups off, and retains edits on save failure", async () => {
  await d.host.api.sessions.data("session").set("links", { prs: [pr] });
  render(dialog());
  await screen.findByText("owner/repo #2");
  automaticOff("Issues");
  fireEvent.change(screen.getByLabelText("Add pull request"), { target: { value: "paste" } });
  fireEvent.change(screen.getByLabelText("PR URL"), { target: { value: issue } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(screen.getByRole("alert").textContent).toContain("valid GitHub pull request URL");
  fireEvent.change(screen.getByLabelText("PR URL"), { target: { value: `${pr2}#discussion` } });
  fireEvent.keyDown(screen.getByLabelText("PR URL"), { key: "Enter" });
  fireEvent.click(screen.getByRole("button", { name: "Remove owner/repo #2" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Hand new reviews/ }));
  d.rpc.mockRejectedValueOnce(new Error("offline"));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("offline"));
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(saved()).toEqual({ issues: [], prs: [pr2], reviews: false });
});

it("cancels without persisting changes", async () => {
  render(dialog());
  await screen.findByRole("group", { name: "Issues" });
  automaticOff("Issues");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(d.rpc.mock.calls.some(([name]) => name === "links.set")).toBe(false);
  expect(close).toHaveBeenCalled();
});

it("looks up no GitHub repository for an orchestrator without a folder", async () => {
  useStore.setState({ sessions: { session: { id: "session", title: "Chat", cwd: "/data/orchestrators/session", folderless: true, orchestrator: true } } });
  render(dialog());
  await screen.findByRole("group", { name: "Issues" });
  expect(d.rpc.mock.calls.some(([name]) => name === "repo")).toBe(false);
});

it("offers a retry when the saved links cannot be read", async () => {
  await d.host.api.sessions.data("session").set("links", "broken-json");
  render(dialog());
  expect((await screen.findByRole("alert")).textContent).toContain("Could not load saved links");
  await d.host.api.sessions.data("session").set("links", { prs: [pr] });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("owner/repo #2")).toBeTruthy();
});
