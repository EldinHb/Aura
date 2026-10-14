import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { RepoIssue, Session } from "../../gen";
import type { RpcClient } from "../../lib/rpc";
import { useStore } from "../../state/store";
import { useGithubRepos } from "../../state/githubRepos";
import { useLinkPreferencesStore } from "../../state/sessionLinkPreferences";
import { NewSessionDialog } from "./NewSessionDialog";

const issue = (number: number, title: string, sprint: string | null = null): RepoIssue =>
  ({ number, title, url: `https://github.com/owner/repo/issues/${number}`, assignees: ["eldin"], sprint, updated_at: "2026-09-30T00:00:00Z" });
const open = [issue(1, "Fix login", "Sprint 3"), issue(2, "Dark mode"), issue(3, "Export CSV", "Sprint 3")];
const githubIssues = vi.fn((_repo: string, query = "") => Promise.resolve(query ? [issue(40, "Old login bug")] : open));
const gitGithubRepo = vi.fn((cwd: string) => Promise.resolve(cwd.startsWith("/repo") ? "owner/repo" : null));
const createSession = vi.fn(() => Promise.resolve({ id: "new" } as Session));
const setSetting = vi.fn(() => Promise.resolve(true));

const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");
beforeAll(() => Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => document.body }));
afterAll(() => offsetParent && Object.defineProperty(HTMLElement.prototype, "offsetParent", offsetParent));
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.clearAllMocks();
  useGithubRepos.setState({ repos: {} });
  useLinkPreferencesStore.setState({ entries: {} });
  useStore.setState({
    client: {
      home: () => Promise.resolve("/home/me"), listDir: () => Promise.resolve([]), gitRepoRoot: () => Promise.resolve(null),
      groups: () => Promise.resolve([]), groupForDir: () => Promise.resolve(null), models: () => Promise.resolve([]),
      gitGithubRepo, githubIssues, createSession, setSetting,
    } as unknown as RpcClient,
    providers: [], selectedId: null, sessions: {},
  });
});
afterEach(cleanup);

const rows = () => [...document.querySelectorAll(".issue-list .list-item .grow")].map((el) => el.textContent);
const issueInput = () => screen.getByLabelText("Issues (optional)") as HTMLInputElement;

it("lists the current sprint by default and all open issues on request", async () => {
  render(<NewSessionDialog cwd="/repo" />);
  await waitFor(() => expect(rows()).toEqual(["Fix login", "Export CSV"]));
  expect(githubIssues).toHaveBeenCalledWith("owner/repo");
  expect(screen.getByRole("radio", { name: "Current sprint · Sprint 3" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("radio", { name: "All open" }));
  expect(rows()).toEqual(["Fix login", "Dark mode", "Export CSV"]);
});

it("offers all open issues when nothing is in the current sprint", async () => {
  githubIssues.mockResolvedValueOnce([issue(2, "Dark mode")]);
  render(<NewSessionDialog cwd="/repo" />);
  fireEvent.click(await screen.findByRole("button", { name: "Show all open" }));
  expect(rows()).toEqual(["Dark mode"]);
});

it("filters by title and searches GitHub beyond the loaded issues", async () => {
  render(<NewSessionDialog cwd="/repo" />);
  await waitFor(() => expect(rows()).toHaveLength(2));
  fireEvent.click(screen.getByRole("radio", { name: "All open" }));
  fireEvent.change(issueInput(), { target: { value: "login" } });
  expect(rows()).toEqual(["Fix login"]);
  await waitFor(() => expect(rows()).toEqual(["Fix login", "Old login bug"]));
  expect(githubIssues).toHaveBeenCalledWith("owner/repo", "login");
});

it("links every picked issue to the created session", async () => {
  render(<NewSessionDialog cwd="/repo" />);
  await waitFor(() => expect(rows()).toHaveLength(2));
  fireEvent.keyDown(issueInput(), { key: "ArrowDown" });
  fireEvent.keyDown(issueInput(), { key: "Enter" });
  expect(screen.getByText("owner/repo #3 — Export CSV")).toBeTruthy();
  expect(rows()).toEqual(["Fix login"]);
  fireEvent.keyDown(issueInput(), { key: "Enter" });
  expect(screen.getByText("owner/repo #1 — Fix login")).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Create/ })); });
  await waitFor(() => expect(setSetting).toHaveBeenCalledWith("session.links.v1.new", JSON.stringify({ issues: ["https://github.com/owner/repo/issues/3", "https://github.com/owner/repo/issues/1"] })));
  expect(createSession).toHaveBeenCalled();
});

it("accepts an issue number or a pasted URL, and can be removed", async () => {
  render(<NewSessionDialog cwd="/repo" />);
  await waitFor(() => expect(rows()).toHaveLength(2));
  fireEvent.change(issueInput(), { target: { value: "#77" } });
  expect(rows()).toEqual(["Link this issue"]);
  fireEvent.change(issueInput(), { target: { value: "https://github.com/other/repo/issues/5" } });
  expect(rows()).toEqual(["other/repo"]);
  fireEvent.keyDown(issueInput(), { key: "Enter" });
  expect(issueInput().value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Remove other/repo #5" }));
  expect(screen.queryByText("other/repo #5")).toBeNull();
});

it("only takes a pasted URL outside a GitHub repository", async () => {
  render(<NewSessionDialog cwd="/elsewhere" />);
  await waitFor(() => expect(gitGithubRepo).toHaveBeenCalledWith("/elsewhere"));
  expect(screen.queryByRole("radio", { name: "All open" })).toBeNull();
  expect(githubIssues).not.toHaveBeenCalled();
  fireEvent.change(issueInput(), { target: { value: "not a url" } });
  expect(screen.getByText("Not a GitHub issue URL")).toBeTruthy();
});
