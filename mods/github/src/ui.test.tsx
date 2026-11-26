// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import type { Session } from "@aura/mod-sdk";
import { fakeCtx } from "./test/ctx";
import { useStore } from "./test/host";
import { activate, detectLinks } from "./ui";
import { useGithubRepos } from "./ui/repos";
import { useLinkPreferencesStore } from "./ui/links";

beforeEach(() => {
  useGithubRepos.setState({ repos: {} });
  useLinkPreferencesStore.setState({ entries: {} });
  useStore.setState({ sessions: {}, transcripts: {}, selectedId: null, connection: "open" });
});

it("contributes every GitHub piece of the interface, and the links command", () => {
  const f = fakeCtx(() => ({}));
  const dispose = activate(f.ctx);
  expect(f.registered.map((r) => `${r.kind}:${r.def.id}`).sort()).toEqual([
    "branchDecoration:pull",
    "command:session.links",
    "dialog:links",
    "inspectorSection:links",
    "newSessionField:issues",
    "sessionRowChips:links",
    "transcriptLinks:github",
  ]);
  const command = f.registered.find((r) => r.kind === "command")!.def;
  expect([command.title, command.when, command.group, command.hidden]).toEqual(["Edit issues & PRs…", "hasSelection", "Session", undefined]);
  command.run();
  expect(f.openDialog).not.toHaveBeenCalled();
  useStore.setState({ selectedId: "s" });
  command.run();
  expect(f.openDialog).toHaveBeenCalledWith("links", { sessionId: "s" });
  // The daemon's notification reaches the stores.
  f.emit("links.changed", { sessionId: "s", links: { prs: ["https://github.com/o/r/pull/1"] }, detected: null, pulls: [] });
  expect(useLinkPreferencesStore.getState().entries.s.preferences).toEqual({ prs: ["https://github.com/o/r/pull/1"] });
  dispose?.();
});

it("labels issue and PR links in transcript text, briefly in the session's own repository", () => {
  const session = { id: "s", cwd: "/work/s" } as Session;
  useGithubRepos.setState({ repos: { "/work/s": "owner/repo" } });
  const text = "See https://github.com/owner/repo/issues/12 and https://github.com/other/app/pull/5/files, not https://example.com/a/b/issues/1";
  expect(detectLinks(text, session)).toEqual([
    { label: "#12", url: "https://github.com/owner/repo/issues/12", kind: "Issue" },
    { label: "other/app#5", url: "https://github.com/other/app/pull/5", kind: "PR" },
  ]);
  expect(detectLinks("https://github.com/owner/repo/pull/3", { ...session, folderless: true })[0].label).toBe("owner/repo#3");
});
