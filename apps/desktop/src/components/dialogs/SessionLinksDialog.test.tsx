import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

it("lists mentions, saves chosen links, and restores them on reopening", async () => {
  const { unmount } = render(<SessionLinksDialog sessionId="session" />);
  fireEvent.change(await screen.findByLabelText("Issue"), { target: { value: issue } });
  fireEvent.change(screen.getByLabelText("Pull request"), { target: { value: pr } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(setSetting).toHaveBeenCalledWith("session.links.v1.session", JSON.stringify({ issue, pr })));
  await waitFor(() => expect(useStore.getState().dialog.kind).toBe("none"));
  unmount();
  useLinkPreferencesStore.setState({ entries: {} });
  getSetting.mockResolvedValue(JSON.stringify({ issue, pr }));
  render(<SessionLinksDialog sessionId="session" />);
  expect((await screen.findByLabelText("Issue") as HTMLSelectElement).value).toBe(issue);
  expect((screen.getByLabelText("Pull request") as HTMLSelectElement).value).toBe(pr);
});

it("validates pasted URLs, permits None, and retains edits on save failure", async () => {
  render(<SessionLinksDialog sessionId="session" />);
  fireEvent.change(await screen.findByLabelText("Issue"), { target: { value: "none" } });
  fireEvent.change(screen.getByLabelText("Pull request"), { target: { value: "custom" } });
  fireEvent.change(screen.getByLabelText("PR URL"), { target: { value: issue } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert").textContent).toContain("valid GitHub pull request URL");
  expect(setSetting).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("PR URL"), { target: { value: `${pr}#discussion` } });
  setSetting.mockRejectedValueOnce(new Error("offline"));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("offline"));
  expect(useStore.getState().dialog.kind).toBe("session-links");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(useStore.getState().dialog.kind).toBe("none"));
  expect(setSetting).toHaveBeenLastCalledWith("session.links.v1.session", JSON.stringify({ issue: null, pr }));
});

it("cancels without persisting changes", async () => {
  render(<SessionLinksDialog sessionId="session" />);
  fireEvent.change(await screen.findByLabelText("Issue"), { target: { value: "none" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(setSetting).not.toHaveBeenCalled();
  expect(useStore.getState().dialog.kind).toBe("none");
});

it("exposes the editor in the command palette", () => {
  const command = coreCommands.find((entry) => entry.id === "session.links");
  expect(command?.title).toBe("Edit issue & PR…");
  expect(command?.when).toBe("hasSelection");
  expect(command?.hidden).not.toBe(true);
});
