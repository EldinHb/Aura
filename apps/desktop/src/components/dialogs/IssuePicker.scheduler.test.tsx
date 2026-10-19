import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RepoIssue } from "../../gen";
import type { RpcClient } from "../../lib/rpc";
import { useStore } from "../../state/store";
import { NewSessionDialog } from "./NewSessionDialog";

// On a busy machine React's scheduler, which runs effects through setImmediate in Node, can fall behind RTL's
// setTimeout(0): a test, or a user, then acts while an effect from the last render is still pending. Forced here,
// before React loads, so the issue picker's keyboard is tested in that moment every time.
vi.hoisted(() => {
  const real = globalThis.setImmediate;
  globalThis.setImmediate = ((fn: (...a: unknown[]) => void, ...a: unknown[]) => {
    setTimeout(() => fn(...a), 3);
    return real(() => {});
  }) as typeof setImmediate;
});

Element.prototype.scrollIntoView = vi.fn();
Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => document.body });
afterEach(cleanup);

const issue = (number: number, title: string): RepoIssue =>
  ({ number, title, url: `https://github.com/owner/repo/issues/${number}`, assignees: [], sprint: "Sprint 3", updated_at: "2026-09-30T00:00:00Z" });

it("an arrow key pressed as the issues arrive moves the cursor and is not undone", async () => {
  useStore.setState({
    client: {
      home: () => Promise.resolve("/home/me"), listDir: () => Promise.resolve([]), gitRepoRoot: () => Promise.resolve(null),
      groups: () => Promise.resolve([]), groupForDir: () => Promise.resolve(null), models: () => Promise.resolve([]),
      gitGithubRepo: () => Promise.resolve("owner/repo"),
      githubIssues: () => Promise.resolve([issue(1, "Fix login"), issue(3, "Export CSV")]),
    } as unknown as RpcClient,
    providers: [], selectedId: null, sessions: {},
  });
  render(<NewSessionDialog cwd="/repo" />);
  await waitFor(() => expect(document.querySelectorAll(".issue-list .list-item")).toHaveLength(2));
  const input = screen.getByLabelText("Issues (optional)");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByText("owner/repo #3 — Export CSV")).toBeTruthy();
});
