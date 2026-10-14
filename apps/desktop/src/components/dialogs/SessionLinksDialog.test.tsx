import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Item } from "../../gen";
import type { RpcClient } from "../../lib/rpc";
import { coreCommands } from "../../commands/core";
import { emptyTranscript, useStore } from "../../state/store";
import { useLinkPreferencesStore } from "../../state/sessionLinkPreferences";
import { SessionLinksDialog } from "./SessionLinksDialog";

const issue = "https://github.com/owner/repo/issues/1";
const pr = "https://github.com/owner/repo/pull/2";
const setSetting = vi.fn().mockResolvedValue(true);
const getSetting = vi.fn().mockResolvedValue(null);
beforeEach(() => {
  setSetting.mockReset().mockResolvedValue(true);
  getSetting.mockReset().mockResolvedValue(null);
  useLinkPreferencesStore.setState({ entries: {} });
  const entry: Item = { id: "message", session_id: "session", kind: "agent_message", status: "completed", text: `Reference links: ${issue} ${pr}`, data: {}, parent_id: null, turn_id: null, title: null, started_at: "2026-09-21T00:00:00Z", ended_at: null };
  useStore.setState({
    client: { getSetting, setSetting } as unknown as RpcClient,
    transcripts: { session: { ...emptyTranscript(), loaded: true, items: { message: entry }, order: ["message"] } },
    dialog: { kind: "session-links", sessionId: "session" },
  });
});
afterEach(cleanup);

const pr2 = "https://github.com/other/repo/pull/9";
const automaticOff = (name: "Issues" | "Pull requests") =>
  fireEvent.click(within(screen.getByRole("group", { name })).getByRole("checkbox", { name: "Automatic" }));

it("adds several mentioned and pasted links, saves them, and restores them on reopening", async () => {
  const { unmount } = render(<SessionLinksDialog sessionId="session" />);
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
  await waitFor(() => expect(setSetting).toHaveBeenCalledWith("session.links.v1.session", JSON.stringify({ issues: [issue], prs: [pr, pr2] })));
  await waitFor(() => expect(useStore.getState().dialog.kind).toBe("none"));
  unmount();
  useLinkPreferencesStore.setState({ entries: {} });
  getSetting.mockResolvedValue(JSON.stringify({ issues: [issue], prs: [pr, pr2] }));
  render(<SessionLinksDialog sessionId="session" />);
  expect(await screen.findByText("owner/repo #1")).toBeTruthy();
  expect(screen.getByText("owner/repo #2")).toBeTruthy();
  expect(screen.getByText("other/repo #9")).toBeTruthy();
});

it("validates pasted URLs, removes links, turns review follow-ups off, and retains edits on save failure", async () => {
  getSetting.mockResolvedValue(JSON.stringify({ prs: [pr] }));
  render(<SessionLinksDialog sessionId="session" />);
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
  setSetting.mockRejectedValueOnce(new Error("offline"));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("offline"));
  expect(useStore.getState().dialog.kind).toBe("session-links");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(useStore.getState().dialog.kind).toBe("none"));
  expect(setSetting).toHaveBeenLastCalledWith("session.links.v1.session", JSON.stringify({ issues: [], prs: [pr2], reviews: false }));
});

it("cancels without persisting changes", async () => {
  render(<SessionLinksDialog sessionId="session" />);
  await screen.findByRole("group", { name: "Issues" });
  automaticOff("Issues");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(setSetting).not.toHaveBeenCalled();
  expect(useStore.getState().dialog.kind).toBe("none");
});

it("exposes the editor in the command palette", () => {
  const command = coreCommands.find((entry) => entry.id === "session.links");
  expect(command?.title).toBe("Edit issues & PRs…");
  expect(command?.when).toBe("hasSelection");
  expect(command?.hidden).not.toBe(true);
});
