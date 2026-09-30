import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Item, Session } from "../gen";
import type { RpcClient } from "../lib/rpc";
import { emptyTranscript, useStore } from "../state/store";
import { useDetectedLinksStore, useDetectedLinksSync, useLinkPreferencesStore } from "../state/sessionLinkPreferences";
import { useGithubRepos } from "../state/githubRepos";
import { Sidebar } from "./Sidebar";

vi.mock("../features/reviews/ReviewSidebar", () => ({ ReviewSidebar: () => null }));

const issue = "https://github.com/owner/repo/issues/7";
const pr = "https://github.com/owner/repo/pull/42";
const settings = new Map<string, string>();
const getSetting = vi.fn(async (key: string) => settings.get(key) ?? null);
const setSetting = vi.fn(async (key: string, value: string) => { settings.set(key, value); return true; });
const gitGithubRepo = vi.fn(async (cwd: string) => cwd === "/work/a" ? "owner/repo" : null);

function session(id: string, title: string): Session {
  return { id, title, cwd: `/work/${id}`, provider: "claude", status: "idle", mode: "structured", archived: false, pinned: false,
    pending_count: 0, last_activity: "2026-09-30T00:00:00Z", group: null, worktree: null, model: null } as Session;
}

function item(text: string, kind: Item["kind"] = "agent_message"): Item {
  return { id: "message", session_id: "a", turn_id: null, kind, status: "completed", title: null,
    text, data: {}, parent_id: null, started_at: "2026-09-30T00:00:00Z", ended_at: null };
}

const rowLinks = (id: string) => [...document.querySelectorAll(`[data-session-id="${id}"] .session-row-link`)].map((el) => el.textContent);

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  settings.clear();
  getSetting.mockClear();
  setSetting.mockClear();
  useLinkPreferencesStore.setState({ entries: {} });
  useDetectedLinksStore.setState({ links: {} });
  useGithubRepos.setState({ repos: {} });
  useStore.setState({
    client: { getSetting, setSetting, gitGithubRepo } as unknown as RpcClient,
    sessions: { a: session("a", "Hours page"), b: session("b", "Other") },
    sessionOrder: ["a", "b"], transcripts: {}, sidebarFilter: "", showArchived: false,
  });
});
afterEach(cleanup);

it("shows links detected in an opened session and saved selections for unopened ones", async () => {
  settings.set("session.links.v1.b", JSON.stringify({ issue }));
  useStore.setState({ transcripts: { a: { ...emptyTranscript(), loaded: true, items: { message: item(`Created PR: ${pr}`) }, order: ["message"] } } });
  render(<Sidebar />);
  await waitFor(() => expect(rowLinks("b")).toEqual(["Issue #7"]));
  expect(rowLinks("a")).toEqual(["PR #42"]);
  expect(screen.getByTitle(pr)).toBeTruthy();
});

it("saves detected links so the sidebar shows them before the session is opened again", async () => {
  useStore.setState({ transcripts: { a: { ...emptyTranscript(), loaded: true, items: { message: item(`Created PR: ${pr}`) }, order: ["message"] } } });
  const { unmount } = renderHook(() => useDetectedLinksSync());
  await waitFor(() => expect(setSetting).toHaveBeenCalledWith("session.links.detected.v1.a", JSON.stringify([pr])));
  unmount();

  useDetectedLinksStore.setState({ links: {} });
  useStore.setState({ transcripts: {} });
  render(<Sidebar />);
  await waitFor(() => expect(rowLinks("a")).toEqual(["PR #42"]));
  expect(rowLinks("b")).toEqual([]);
});

it("prefers None over a saved detected link", async () => {
  settings.set("session.links.detected.v1.a", JSON.stringify([pr]));
  settings.set("session.links.v1.a", JSON.stringify({ pr: null }));
  render(<Sidebar />);
  await waitFor(() => expect(getSetting).toHaveBeenCalledWith("session.links.v1.a"));
  await waitFor(() => expect(useLinkPreferencesStore.getState().entries.a).toBeTruthy());
  expect(rowLinks("a")).toEqual([]);
});

it("links the issue number the user asked the agent to work on, using the session's GitHub repository", async () => {
  useStore.setState({ transcripts: { a: { ...emptyTranscript(), loaded: true, items: { message: item("Please work on issue #7", "user_message") }, order: ["message"] } } });
  render(<Sidebar />);
  await waitFor(() => expect(rowLinks("a")).toEqual(["Issue #7"]));
  expect(screen.getByTitle(issue)).toBeTruthy();
  const { unmount } = renderHook(() => useDetectedLinksSync());
  await waitFor(() => expect(setSetting).toHaveBeenCalledWith("session.links.detected.v1.a", JSON.stringify([issue])));
  unmount();
});
