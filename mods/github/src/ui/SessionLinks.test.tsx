// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Item, Session } from "@aura/mod-sdk";
import { daemonCtx } from "../test/ctx";
import { opened, useStore } from "../test/host";
import { resetLinks } from "./links";
import { resetGithubRepos } from "./repos";
import { SessionLinks, SessionLinksSection } from "./SessionLinks";

function item(text: string, kind: Item["kind"] = "agent_message"): Item {
  return { id: "item", session_id: "session", turn_id: null, kind, status: "completed", title: null,
    text, data: {}, parent_id: null, started_at: "2026-09-21T00:00:00Z", ended_at: null };
}
let d: ReturnType<typeof daemonCtx>;
beforeEach(() => {
  resetLinks();
  resetGithubRepos();
  opened.length = 0;
  d = daemonCtx();
  useStore.setState({ connection: "open", transcripts: {}, sessions: {} });
});
afterEach(cleanup);

it("updates when a streamed link completes and opens it in the system browser", () => {
  const { rerender } = render(<SessionLinks items={{ item: item("Created PR: https://github.com/owner/repo/pull/") }} title="Session" />);
  expect(screen.queryByText("Issues & PRs")).toBeNull();
  rerender(<SessionLinks items={{ item: item("Created PR: https://github.com/owner/repo/pull/42\n") }} title="Session" />);
  const link = screen.getByRole("link", { name: "PR #42 owner/repo" });
  expect(link.getAttribute("href")).toBe("https://github.com/owner/repo/pull/42");
  fireEvent.click(link);
  expect(opened).toEqual(["https://github.com/owner/repo/pull/42"]);
  rerender(<SessionLinks items={{}} title="Another session" />);
  expect(screen.queryByRole("link")).toBeNull();
});

it("shows the session's saved links in the Inspector, and edits them in the mod's dialog", async () => {
  const s = { id: "s", title: "Hours page", cwd: "/work/s" } as Session;
  await d.host.call("links.set", { sessionId: "s", links: { prs: ["https://github.com/owner/repo/pull/5"], reviews: false } });
  useStore.setState({ sessions: { s }, transcripts: { s: { loaded: true, items: { m: item("Created PR: https://github.com/owner/repo/pull/9") } } } });
  render(<SessionLinksSection session={s} />);
  expect(screen.getByText("Loading links…")).toBeTruthy();
  await waitFor(() => expect(screen.getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual(["https://github.com/owner/repo/pull/5"]));
  expect(screen.getByText("Reviews on these PRs are not handed to this session")).toBeTruthy();
  const edit = screen.getByRole("button", { name: "Edit issues & PRs…" });
  expect(edit.dataset.command).toBe("github.session.links");
  fireEvent.click(edit);
  expect(d.openDialog).toHaveBeenCalledWith("links", { sessionId: "s" });
});

it("says when saved links cannot be read", async () => {
  const s = { id: "s", title: "Hours page", cwd: "/work/s" } as Session;
  await d.host.api.sessions.data("s").set("links", "broken-json");
  render(<SessionLinksSection session={s} />);
  await waitFor(() => expect(screen.getByText("Could not load saved links")).toBeTruthy());
});
