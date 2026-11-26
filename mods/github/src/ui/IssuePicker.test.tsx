// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { RepoIssue } from "@aura/github-client";
import { fakeCtx } from "../test/ctx";
import { useStore } from "../test/host";
import { IssueField } from "./IssuePicker";
import { resetGithubRepos } from "./repos";

const issue = (number: number, title: string, sprint: string | null = null): RepoIssue =>
  ({ number, title, url: `https://github.com/owner/repo/issues/${number}`, assignees: ["eldin"], sprint, updated_at: "2026-09-30T00:00:00Z" });
const open = [issue(1, "Fix login", "Sprint 3"), issue(2, "Dark mode"), issue(3, "Export CSV", "Sprint 3")];
const issues = vi.fn((p: { repo: string; query?: string }) => Promise.resolve(p.query ? [issue(40, "Old login bug")] : open));
const repoOf = vi.fn((p: { cwd: string }) => Promise.resolve(p.cwd.startsWith("/repo") ? "owner/repo" : null));
const onChange = vi.fn();
let rpc: ReturnType<typeof fakeCtx>["rpc"];

const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");
beforeAll(() => Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => document.body }));
afterAll(() => offsetParent && Object.defineProperty(HTMLElement.prototype, "offsetParent", offsetParent));
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.clearAllMocks();
  resetGithubRepos();
  rpc = fakeCtx((name, params) => (name === "issues" ? issues(params) : name === "repo" ? repoOf(params) : null)).rpc;
  useStore.setState({ connection: "open" });
});
afterEach(cleanup);

const rows = () => [...document.querySelectorAll(".issue-list .list-item .grow")].map((el) => el.textContent);
const issueInput = () => screen.getByLabelText("Issues (optional)") as HTMLInputElement;

it("lists the current sprint by default and all open issues on request", async () => {
  render(<IssueField cwd="/repo/" onChange={onChange} />);
  await waitFor(() => expect(rows()).toEqual(["Fix login", "Export CSV"]));
  expect(rpc).toHaveBeenCalledWith("issues", { repo: "owner/repo" });
  expect(rpc).toHaveBeenCalledWith("repo", { cwd: "/repo" });
  expect(screen.getByRole("radio", { name: "Current sprint · Sprint 3" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("radio", { name: "All open" }));
  expect(rows()).toEqual(["Fix login", "Dark mode", "Export CSV"]);
});

it("offers all open issues when nothing is in the current sprint", async () => {
  issues.mockResolvedValueOnce([issue(2, "Dark mode")]);
  render(<IssueField cwd="/repo" onChange={onChange} />);
  fireEvent.click(await screen.findByRole("button", { name: "Show all open" }));
  expect(rows()).toEqual(["Dark mode"]);
});

it("filters by title and searches GitHub beyond the loaded issues", async () => {
  render(<IssueField cwd="/repo" onChange={onChange} />);
  await waitFor(() => expect(rows()).toHaveLength(2));
  fireEvent.click(screen.getByRole("radio", { name: "All open" }));
  fireEvent.change(issueInput(), { target: { value: "login" } });
  expect(rows()).toEqual(["Fix login"]);
  await waitFor(() => expect(rows()).toEqual(["Fix login", "Old login bug"]));
  expect(rpc).toHaveBeenCalledWith("issues", { repo: "owner/repo", query: "login" });
});

it("hands every picked issue to the new session as its links", async () => {
  render(<IssueField cwd="/repo" onChange={onChange} />);
  await waitFor(() => expect(rows()).toHaveLength(2));
  expect(onChange).toHaveBeenLastCalledWith(null);
  fireEvent.keyDown(issueInput(), { key: "ArrowDown" });
  fireEvent.keyDown(issueInput(), { key: "Enter" });
  expect(screen.getByText("owner/repo #3 — Export CSV")).toBeTruthy();
  expect(rows()).toEqual(["Fix login"]);
  fireEvent.keyDown(issueInput(), { key: "Enter" });
  expect(screen.getByText("owner/repo #1 — Fix login")).toBeTruthy();
  expect(onChange).toHaveBeenLastCalledWith({ data: { links: { issues: ["https://github.com/owner/repo/issues/3", "https://github.com/owner/repo/issues/1"] } } });
});

it("accepts an issue number or a pasted URL, and can be removed", async () => {
  render(<IssueField cwd="/repo" onChange={onChange} />);
  await waitFor(() => expect(rows()).toHaveLength(2));
  fireEvent.change(issueInput(), { target: { value: "#77" } });
  expect(rows()).toEqual(["Link this issue"]);
  fireEvent.change(issueInput(), { target: { value: "https://github.com/other/repo/issues/5" } });
  expect(rows()).toEqual(["other/repo"]);
  fireEvent.keyDown(issueInput(), { key: "Enter" });
  expect(issueInput().value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Remove other/repo #5" }));
  expect(screen.queryByText("other/repo #5")).toBeNull();
  expect(onChange).toHaveBeenLastCalledWith(null);
});

it("only takes a pasted URL outside a GitHub repository", async () => {
  render(<IssueField cwd="/elsewhere" onChange={onChange} />);
  await waitFor(() => expect(repoOf).toHaveBeenCalledWith({ cwd: "/elsewhere" }));
  expect(screen.queryByRole("radio", { name: "All open" })).toBeNull();
  expect(issues).not.toHaveBeenCalled();
  fireEvent.change(issueInput(), { target: { value: "not a url" } });
  expect(screen.getByText("Not a GitHub issue URL")).toBeTruthy();
});

it("shows nothing for an orchestrator without a folder", () => {
  const { container } = render(<IssueField cwd={null} onChange={onChange} />);
  expect(container.innerHTML).toBe("");
  expect(onChange).toHaveBeenLastCalledWith(null);
});

it("says when issues cannot be loaded", async () => {
  issues.mockRejectedValueOnce(new Error("GitHub login expired"));
  render(<IssueField cwd="/repo" onChange={onChange} />);
  expect((await screen.findByRole("alert")).textContent).toBe("Could not load issues: GitHub login expired");
});
