import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-shell";
import type { Item } from "../gen";
import { emptyTranscript, useStore } from "../state/store";
import { mentionedSessionLinks, selectedSessionLinks, sessionLinks } from "./issueLinks";
import { SessionLinks } from "./SessionLinks";

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/connection", () => ({ isTauri: () => true }));

function item(text: string, data: Record<string, unknown> = {}, kind: Item["kind"] = "agent_message"): Item {
  return { id: "item", session_id: "session", turn_id: null, kind, status: "completed", title: null,
    text, data, parent_id: null, started_at: "2026-09-21T00:00:00Z", ended_at: null };
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("session issue and PR links", () => {
  it("offers all mentioned links in the picker without automatically selecting them", () => {
    const items = {
      a: item("Compare https://github.com/owner/repo/pull/99 with https://github.com/owner/repo/pull/99/files"),
      b: item("", { result: [{ url: "https://github.com/owner/repo/issues/2" }] }, "mcp_call"),
      c: item("", { command: "gh pr view 3 --repo owner/repo" }, "command_exec"),
    };
    expect(mentionedSessionLinks(items).map((link) => link.url)).toEqual([
      "https://github.com/owner/repo/pull/99", "https://github.com/owner/repo/issues/2", "https://github.com/owner/repo/pull/3",
    ]);
    expect(sessionLinks(items)).toEqual([]);
  });

  it("keeps explicit selections and None despite new automatic targets", () => {
    const automatic = sessionLinks({ a: item("Created PR: https://github.com/owner/repo/pull/2") }, "https://github.com/owner/repo/issues/3");
    const preferences = { pr: "https://github.com/owner/repo/pull/1", issue: null };
    expect(selectedSessionLinks(automatic, preferences).map((link) => link.url)).toEqual([preferences.pr]);
    expect(selectedSessionLinks(automatic, {})).toEqual(automatic);
  });
  it("restores Claude's issue request and heredoc PR creation from saved history", () => {
    const items = [
      item("Hi Claude, I want you to work on this issue for me: https://github.com/owner/repo/issues/2294. Can you first make a plan and let me review it?", {}, "user_message"),
      item("", {
        command: 'gh pr create --draft --base develop --title "Added: Hours page" --body-file - <<\'EOF\'\n# PR Summary\nCloses https://github.com/owner/repo/issues/2294\nReference: https://github.com/owner/repo/pull/99\nEOF',
        output: "https://github.com/owner/repo/pull/2521", exit_code: 0,
      }, "command_exec"),
    ];
    useStore.setState({ transcripts: {} });
    useStore.getState().loadHistory("session", items.map((value, index) => ({
      seq: index + 1, ts: value.started_at,
      event: { type: "item_completed", session_id: "session", item: { ...value, id: `claude-${index}` } },
    })));
    render(<SessionLinks items={useStore.getState().transcripts.session.items} title="Hours page" />);
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "https://github.com/owner/repo/issues/2294", "https://github.com/owner/repo/pull/2521",
    ]);
  });

  it("recognizes Claude's draft PR summary and a direct answer to a link request", () => {
    const url = "https://github.com/owner/repo/pull/2521";
    expect(sessionLinks({ a: item(`Done. Draft PR #2521 is open on your account and assigned to you: ${url}`) })[0]?.url).toBe(url);
    expect(sessionLinks({
      a: item("Where's the PR link?", {}, "user_message"),
      b: item(`${url}\n\nIt is draft PR #2521 on your account.`),
    })[0]?.url).toBe(url);
    expect(sessionLinks({ a: item(url) })).toEqual([]);
  });

  it.each([
    "cat <<'EOF'\ngh pr create --fill\nEOF",
    "gh pr create --body-file - <<'EOF'\nbody\nEOF\ngh pr list",
    "gh pr create --body-file - <<'EOF'\nmissing terminator",
  ])("does not confuse heredoc contents or combined outputs with a created PR: %s", (command) => {
    expect(sessionLinks({ a: item("", { command, exit_code: 0, output: "https://github.com/owner/repo/pull/99" }, "command_exec") })).toEqual([]);
  });

  it("restores the screenshot's active PR from saved shell-wrapped reviewer commands", () => {
    const commands = [
      '/bin/zsh -lc "gh api repos/acme/acme.webapp/collaborators --paginate --jq \'.[].login\'"',
      "/bin/zsh -lc 'gh pr view 169 --repo acme/acme.webapp --json reviewRequests,reviews'",
      "/bin/zsh -lc 'gh pr edit 169 --repo acme/acme.webapp --add-reviewer SaMpLeDEV'",
      "/bin/zsh -lc 'gh pr view 169 --repo acme/acme.webapp --json reviewRequests'",
    ];
    useStore.setState({ transcripts: {} });
    useStore.getState().loadHistory("session", commands.map((command, index) => ({
      seq: index + 1, ts: "2026-09-21T00:00:00Z",
      event: { type: "item_completed", session_id: "session", item: {
        ...item("", { command, exit_code: 0, output: "" }, "command_exec"), id: `command-${index}`,
      } },
    })));
    render(<SessionLinks items={useStore.getState().transcripts.session.items} title="Session" />);
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link").getAttribute("href")).toBe("https://github.com/acme/acme.webapp/pull/169");
  });

  it.each([
    "Requested Sam’s (@SaMpLeDEV) review on [PR #169](https://github.com/acme/acme.webapp/pull/169).",
    "Created [PR #169](https://github.com/acme/acme.webapp/pull/169).",
    "**PR:** [#169](https://github.com/acme/acme.webapp/pull/169)",
  ])("recognizes a direct result without requiring a special label: %s", (text) => {
    expect(sessionLinks({ a: item(text) }).map((link) => link.url)).toEqual([
      "https://github.com/acme/acme.webapp/pull/169",
    ]);
  });

  it.each([
    ["/bin/zsh -lc 'gh pr create --title \"Fix & test\" --fill'", "https://github.com/owner/repo/pull/2", "https://github.com/owner/repo/pull/2"],
    ["gh issue edit 3 --repo=owner/repo --add-assignee @me", "", "https://github.com/owner/repo/issues/3"],
    ["gh pr checkout https://github.com/owner/repo/pull/4", "", "https://github.com/owner/repo/pull/4"],
  ])("recognizes successful work commands: %s", (command, output, expected) => {
    expect(sessionLinks({ a: item("", { command, output, exit_code: 0 }, "command_exec") }).map((link) => link.url)).toEqual([expected]);
  });

  it.each([
    "gh pr view 99 --repo owner/repo",
    "gh pr list --repo owner/repo",
    "echo 'gh pr edit 99 --repo owner/repo'",
    "gh pr edit 99", // no repository: do not guess a destination
    "echo context && gh pr edit 99 --repo owner/repo",
  ])("does not treat research or quoted commands as the work target: %s", (command) => {
    expect(sessionLinks({ a: item("", { command, exit_code: 0, output: "https://github.com/owner/repo/pull/99" }, "command_exec") })).toEqual([]);
  });

  it("keeps the requested issue and created PR, ignoring background links", () => {
    const links = sessionLinks({
      a: item("Please fix [this issue](https://github.com/owner/repo/issues/12). Compare with https://github.com/owner/repo/issues/99", {}, "user_message"),
      b: item("", { output: "https://github.com/owner/repo/pull/88 https://github.com/other/repo/issues/77" }, "command_exec"),
      c: item("For context: https://github.com/owner/repo/pull/90"),
      d: item("Created PR: https://github.com/owner/repo/pull/34/files"),
    });
    expect(links).toEqual([
      { kind: "Issue", repo: "owner/repo", number: "12", url: "https://github.com/owner/repo/issues/12" },
      { kind: "PR", repo: "owner/repo", number: "34", url: "https://github.com/owner/repo/pull/34" },
    ]);
  });

  it("uses the session title and successful PR creation output", () => {
    const links = sessionLinks({
      a: item("", { command: "gh pr create --fill", exit_code: 0, output: "https://github.com/owner/repo/pull/1\n" }, "command_exec"),
      b: item("", { result: { content: [{ text: "https://github.com/owner/repo/issues/2" }] } }, "mcp_call"),
    }, "Fix https://github.com/owner/repo/issues/3");
    expect(links.map((link) => link.url)).toEqual([
      "https://github.com/owner/repo/issues/3", "https://github.com/owner/repo/pull/1",
    ]);
  });

  it("replaces the previous task when the user explicitly switches issues", () => {
    const links = sessionLinks({
      a: item("Fix https://github.com/owner/repo/issues/1", {}, "user_message"),
      b: item("Created PR: https://github.com/owner/repo/pull/2"),
      c: item("Now work on https://github.com/owner/repo/issues/3", {}, "user_message"),
      d: item("See https://github.com/owner/repo/issues/4 for context", {}, "user_message"),
    });
    expect(links.map((link) => link.url)).toEqual(["https://github.com/owner/repo/issues/3"]);
  });

  it("does not choose from ambiguous user targets or failed commands", () => {
    expect(sessionLinks({
      a: item("Review https://github.com/owner/repo/pull/1\nReview https://github.com/owner/repo/pull/2", {}, "user_message"),
      b: item("", { command: "gh pr create --fill", exit_code: 1, output: "https://github.com/owner/repo/pull/3" }, "command_exec"),
      c: { ...item("Created PR: https://github.com/owner/repo/pull/4"), parent_id: "subagent" },
    })).toEqual([]);
  });

  it("ignores unrelated URLs, incomplete references, and file patches", () => {
    expect(sessionLinks({
      a: item("https://example.com/owner/repo/issues/1 https://github.com/owner/repo/issues/ https://github.com/owner/repo/pull/12abc #123 https://github.com/owner/repo"),
      b: item("", { diff: "+https://github.com/owner/repo/issues/3" }, "file_change"),
    })).toEqual([]);
  });

  const issue12 = "https://github.com/owner/repo/issues/12";
  it.each([
    `Can you work on the following issue: ${issue12}`,
    `I want you to tackle ${issue12}`,
    `Please take a look at ${issue12}`,
    `investigate ${issue12}`,
    `Implement the feature described in ${issue12}`,
    `Here is the issue: ${issue12}`,
    `Issue: ${issue12}`,
    "work on owner/repo#12",
    "Work on issue #12",
    "fix issue 12 please",
    "Please work on #12.",
  ])("links the issue the user asks the agent to work on: %s", (text) => {
    expect(sessionLinks({ a: item(text, {}, "user_message") }, "", "owner/repo").map((link) => link.url)).toEqual([issue12]);
  });

  it("links a requested PR number as a pull request", () => {
    expect(sessionLinks({ a: item("Review #7", {}, "user_message") }, "", "owner/repo").map((link) => link.url)).toEqual(["https://github.com/owner/repo/pull/7"]);
    expect(sessionLinks({ a: item("work on PR #7", {}, "user_message") }, "", "owner/repo").map((link) => link.url)).toEqual(["https://github.com/owner/repo/pull/7"]);
  });

  it("links a requested number in the session title", () => {
    expect(sessionLinks({}, "Work on issue #12", "owner/repo").map((link) => link.url)).toEqual([issue12]);
  });

  it.each([
    `Fix the login like ${issue12}`,
    `Handle errors the same way as ${issue12}`,
    `Look at ${issue12} for inspiration`,
    `I fixed ${issue12}`,
    `Fix the typo in the README and then update all the docs from ${issue12}`,
    "fix #12 and #13",
    "fix 3 bugs",
  ])("does not link background, past or ambiguous references: %s", (text) => {
    expect(sessionLinks({ a: item(text, {}, "user_message") }, "", "owner/repo")).toEqual([]);
  });

  it("needs the session repository to link a bare number", () => {
    expect(sessionLinks({ a: item("Work on issue #12", {}, "user_message") })).toEqual([]);
  });

  it("updates when a streamed link completes and opens it in the system browser", () => {
    useStore.setState({ transcripts: { session: emptyTranscript() } });
    useStore.getState().applyEvent({ type: "item_started", session_id: "session", item: item("Created PR: https://github.com/owner/repo/pull/") });
    const { rerender } = render(<SessionLinks items={useStore.getState().transcripts.session.items} title="Session" />);
    expect(screen.queryByText("Issues & PRs")).toBeNull();
    useStore.getState().applyEvent({ type: "item_delta", session_id: "session", item_id: "item", delta: { kind: "text", text: "42\n" } });
    rerender(<SessionLinks items={useStore.getState().transcripts.session.items} title="Session" />);
    const link = screen.getByRole("link", { name: "PR #42 owner/repo" });
    expect(link.getAttribute("href")).toBe("https://github.com/owner/repo/pull/42");
    fireEvent.click(link);
    expect(open).toHaveBeenCalledWith("https://github.com/owner/repo/pull/42");
    rerender(<SessionLinks items={{}} title="Another session" />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
