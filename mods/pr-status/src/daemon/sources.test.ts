import { describe, expect, it } from "vitest";
import { createTestHost } from "@aura/mod-sdk/testing";
import { NO_GH, type Github } from "@aura/github-client";
import { NOT_SIGNED_IN } from "./ghcli";
import { activate } from "../daemon";
import type { SessionView } from "../shared/types";
import { fakeGithub, prNode, session } from "../test/fixtures";
import { ghReply, rate } from "../test/gh";
import { branchPull, branchQuestion, githubRepo, parseRemotes, parseStatus } from "./branch";
import { itemText, MAX_DETECTED, MAX_DOC, MAX_LIST, MAX_URL, prUrlsIn, Sources } from "./sources";

describe("PR URLs in a conversation", () => {
  it("finds github.com PR URLs once each, canonical", () => {
    expect(prUrlsIn("Opened https://github.com/acme/api/pull/42/files and https://github.com/ACME/api/pull/42. See https://github.com/acme/api/issues/3 and https://github.com/acme/web/pull/7#discussion"))
      .toEqual(["https://github.com/acme/api/pull/42", "https://github.com/acme/web/pull/7"]);
    expect(itemText({ text: "done", data: { output: "https://github.com/acme/api/pull/9\n" } })).toContain("https://github.com/acme/api/pull/9");
  });

  it("keeps the detected, linked and unlinked PRs of a session in its own storage", async () => {
    const host = createTestHost({ id: "pr-status" });
    const sources = new Sources(host.api);
    expect(await sources.detect("s1", "https://github.com/acme/api/pull/1")).toBe(true);
    expect(await sources.detect("s1", "again https://github.com/acme/api/pull/1")).toBe(false);
    await sources.link("s1", "https://github.com/acme/api/pull/2");
    expect(sources.linkedOf("s1")).toEqual(["https://github.com/acme/api/pull/2", "https://github.com/acme/api/pull/1"]);
    await sources.unlink("s1", "https://github.com/acme/api/pull/1");
    // Unlinked: gone, and staying gone when the conversation names it again.
    await sources.detect("s1", "https://github.com/acme/api/pull/1");
    expect(sources.linkedOf("s1")).toEqual(["https://github.com/acme/api/pull/2"]);
    expect(sources.sessionsOf("https://github.com/acme/api/pull/2")).toEqual(["s1"]);
    await expect(sources.link("s1", "https://example.com/x")).rejects.toMatchObject({ code: "invalid" });
    // Bounded, and read back after a restart; a session that no longer exists is forgotten.
    for (let i = 10; i < 10 + MAX_DETECTED + 5; i++) await sources.detect("s1", `https://github.com/acme/api/pull/${i}`);
    await sources.detect("gone", "https://github.com/acme/api/pull/5");
    host.state.sessions = [session("s1")];
    const again = new Sources(host.api);
    await again.ready;
    expect(again.linkedOf("s1")).toHaveLength(1 + MAX_DETECTED);
    expect(again.linkedOf("gone")).toEqual([]);
    expect(host.collections.get("sessions")?.has("gone")).toBe(false);
  });
});

describe("Sources: start-up and bounds (review items 4 and 6)", () => {
  it("loses nothing changed while what was kept is still being read", async () => {
    const host = createTestHost({ id: "pr-status" });
    host.state.sessions = [session("s1")];
    await host.api.storage.collection("sessions").put("s1", { detected: [], linked: ["https://github.com/acme/api/pull/1"], hidden: [] });
    // The session list arrives late: the read of what was kept is still running.
    let release!: () => void;
    const list = host.api.sessions.list;
    host.api.sessions.list = () => new Promise((r) => (release = () => r(list())));
    const sources = new Sources(host.api);
    const changes = Promise.all([
      sources.detect("s1", "https://github.com/acme/api/pull/2"),
      sources.link("s1", "https://github.com/acme/api/pull/3"),
      sources.link("s1", "https://github.com/acme/api/pull/4"),
      sources.unlink("s1", "https://github.com/acme/api/pull/9"),
    ]);
    release();
    await changes;
    const urls = ["https://github.com/acme/api/pull/1", "https://github.com/acme/api/pull/3", "https://github.com/acme/api/pull/4", "https://github.com/acme/api/pull/2"];
    expect(sources.linkedOf("s1")).toEqual(urls);
    host.api.sessions.list = list;
    const again = new Sources(host.api);
    await again.ready;
    expect(again.linkedOf("s1")).toEqual(urls);
    expect(again.isHidden("s1", "https://github.com/acme/api/pull/9")).toBe(true);
  });

  it("refuses long URLs and links or unlinks past the caps, and keeps the stored document small", async () => {
    const host = createTestHost({ id: "pr-status" });
    const sources = new Sources(host.api);
    const long = `https://github.com/acme/${"r".repeat(MAX_URL)}/pull/1`;
    await expect(sources.link("s1", long)).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining(`${MAX_URL} characters`) });
    expect(await sources.detect("s1", `see ${long}`)).toBe(false);
    for (let i = 1; i <= MAX_LIST; i++) await sources.link("s1", `https://github.com/acme/api/pull/${i}`);
    await expect(sources.link("s1", "https://github.com/acme/api/pull/999")).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining(`At most ${MAX_LIST}`) });
    for (let i = 1; i <= MAX_LIST; i++) await sources.unlink("s1", `https://github.com/acme/web/pull/${i}`);
    await expect(sources.unlink("s1", "https://github.com/acme/web/pull/999")).rejects.toMatchObject({ code: "invalid" });
    // Detections still fit: the oldest give way.
    for (let i = 0; i < 80; i++) await sources.detect("s1", `https://github.com/acme/a-very-long-repository-name-for-the-test/pull/${10_000 + i}`);
    const stored = host.collections.get("sessions")!.get("s1");
    expect(JSON.stringify(stored).length).toBeLessThanOrEqual(MAX_DOC);
    expect(sources.linkedOf("s1")).toContain("https://github.com/acme/a-very-long-repository-name-for-the-test/pull/10079");
  });
});

describe("the PR of a session's branch", () => {
  it("reads git's branch, upstream and remotes", () => {
    expect(parseStatus("# branch.oid abc\n# branch.head feature/x\n# branch.upstream fork/feature/x\n# branch.ab +2 -0\n1 .M N... x"))
      .toEqual({ branch: "feature/x", head: "abc", upstream: "fork/feature/x", ahead: 2 });
    expect(parseStatus("# branch.oid abc\n# branch.head (detached)\n").branch).toBeNull();
    expect(githubRepo("git@github.com:acme/api.git")).toBe("acme/api");
    expect(githubRepo("https://github.com/acme/api")).toBe("acme/api");
    expect(githubRepo("ssh://git@github.com/acme/api.git")).toBe("acme/api");
    expect(githubRepo("https://gitlab.com/acme/api.git")).toBeNull();
    const remotes = parseRemotes("origin\tgit@github.com:acme/api.git (fetch)\nfork\thttps://github.com/sam/api.git (fetch)\nlab\thttps://gitlab.com/x/y (fetch)");
    expect(remotes).toEqual({ origin: "acme/api", fork: "sam/api" });
    // A fork's branch: the PR is in origin's repository, from the fork owner's branch.
    expect(branchQuestion({ branch: "local", head: "abc", upstream: "fork/feature/x", ahead: 0 }, remotes))
      .toEqual({ repo: "acme/api", branch: "feature/x", headOwner: "sam", stamp: "acme/api|sam:feature/x|abc|0" });
    expect(branchQuestion({ branch: "local", head: "abc", upstream: null, ahead: 1 }, { upstream: "acme/api", origin: "sam/api" }))
      .toMatchObject({ repo: "acme/api", branch: "local", headOwner: "sam" });
  });

  it("asks GitHub for the branch's PRs, page by page, keeping the head owner's (review item 7)", async () => {
    const asked: any[] = [];
    // 150 PRs of other forks with the same branch name, newest first; the owner's open one is on page 2.
    const others = Array.from({ length: 150 }, (_, i) => ({ url: `https://github.com/acme/api/pull/${1000 - i}`, state: "OPEN", headRepositoryOwner: { login: `fork${i}` } }));
    const all = [...others.slice(0, 120), { url: "https://github.com/acme/api/pull/4", state: "OPEN", headRepositoryOwner: { login: "Sam" } }, { url: "https://github.com/acme/api/pull/2", state: "MERGED", headRepositoryOwner: { login: "sam" } }];
    const gh = { request: async (_m: string, _p: string, body: any) => {
      asked.push(body.variables);
      const start = body.variables.after ? Number(body.variables.after) : 0;
      const nodes = all.slice(start, start + 100);
      return { data: { repository: { pullRequests: { pageInfo: { hasNextPage: start + 100 < all.length, endCursor: String(start + 100) }, nodes } } } };
    } } as unknown as Github;
    expect(await branchPull(gh, { repo: "acme/api", branch: "feature/x", headOwner: "sam", stamp: "" })).toBe("https://github.com/acme/api/pull/4");
    expect(asked).toEqual([
      { owner: "acme", name: "api", head: "feature/x", after: null },
      { owner: "acme", name: "api", head: "feature/x", after: "100" },
    ]);
    // Only other forks' PRs: every page read, then none.
    all.splice(120);
    asked.length = 0;
    expect(await branchPull(gh, { repo: "acme/api", branch: "feature/x", headOwner: "sam", stamp: "" })).toBeNull();
    expect(asked).toHaveLength(2);
  });
});

/** A host where everything goes through aura.process: gh's answers from `fake`, git from canned output. */
function selfContained(opts: { gh?: "missing"; auth?: { code: number; stderr?: string } } = {}) {
  const host = createTestHost({ id: "pr-status" });
  const fake = fakeGithub({ 9: prNode({ number: 9, title: "From the worker" }) });
  const calls: string[] = [];
  host.state.sessions = [session("lead", { cwd: "/code/lead" }), session("worker", { orchestrator_id: "lead", cwd: "/code/worker" })];
  host.process.route(async (bin, args, o) => {
    calls.push(`${bin} ${[args[0], ...args.slice(3, 5)].join(" ")}`);
    if (bin === "git") return { code: 128, stderr: "not a git repository" };
    if (opts.gh === "missing") throw new Error("gh: not found");
    if (args[0] === "auth" && args[1] === "status") return opts.auth ?? { code: 0, stdout: "✓ Logged in to github.com account sam" };
    if (args[0] === "api" && args[4] === "graphql") return ghReply({ headers: rate("graphql", 4990), body: await fake.gh.request("POST", "graphql", JSON.parse(o.stdin!)) });
    if (args[0] === "api" && args[4] === "user") return ghReply({ headers: rate("core", 4990), body: { login: "sam" } });
    if (args[0] === "api" && args[4].startsWith("notifications")) return ghReply({ headers: rate("core", 4990), body: [] });
    return undefined;
  });
  return { host, fake, calls };
}

describe("self-contained: no other mod, only aura.process", () => {
  it("finds a PR named in a worker's conversation, reads it with gh, and keeps it across a restart", async () => {
    const t = selfContained();
    let { dispose } = activate(t.host.api, { loop: false });
    t.host.fire({ type: "item_completed", session_id: "worker", item: { kind: "agent_message", text: "Opened https://github.com/acme/api/pull/9", data: {} } } as any);
    await new Promise((r) => setTimeout(r, 0));
    const view = await t.host.call<SessionView>("watch", { viewer: "v", sessionId: "lead", refresh: true });
    expect(view.pulls.map((p) => [p.ref.url, p.ref.sources.map((s) => s.sessionId), p.status?.title])).toEqual([["https://github.com/acme/api/pull/9", ["worker"], "From the worker"]]);
    expect(t.calls.filter((c) => c.startsWith("gh api -i graphql"))).toHaveLength(1);
    expect(await t.host.call("pulls.sessions", { url: "https://github.com/acme/api/pull/9" })).toEqual(["worker"]);
    dispose();

    // A restart: the card is there at once, from storage, before GitHub is asked anything.
    const before = t.calls.filter((c) => c.startsWith("gh")).length;
    ({ dispose } = activate(t.host.api, { loop: false }));
    const cached = await t.host.call<SessionView>("view", { sessionId: "lead" });
    expect(cached.pulls[0]).toMatchObject({ status: { title: "From the worker" }, readAt: expect.any(String) });
    expect(t.calls.filter((c) => c.startsWith("gh")).length).toBe(before);

    // The worker is deleted: what it found goes.
    t.host.state.sessions = t.host.state.sessions.filter((s) => s.id !== "worker");
    t.host.fire({ type: "session_removed", session_id: "worker" } as any);
    await new Promise((r) => setTimeout(r, 0));
    expect(t.host.collections.get("sessions")?.has("worker")).toBe(false);
    expect((await t.host.call<SessionView>("view", { sessionId: "lead" })).pulls).toEqual([]);
    dispose();
  });

  it("says on the very first answer why it is not updating, without per-card errors (QA item 3)", async () => {
    for (const [opts, reason] of [[{ gh: "missing" as const }, NO_GH], [{ auth: { code: 1, stderr: "You are not logged into any GitHub hosts." } }, NOT_SIGNED_IN]] as const) {
      const t = selfContained(opts);
      const { dispose } = activate(t.host.api, { loop: false });
      await t.host.call("links.add", { sessionId: "lead", url: "https://github.com/acme/api/pull/9" });
      const first = await t.host.call<SessionView>("watch", { viewer: "v", sessionId: "lead", refresh: true });
      expect(first.blocked).toBe(reason);
      expect(first.pulls.map((p) => p.error)).toEqual([null]);
      expect(t.calls.filter((c) => c.startsWith("gh api"))).toEqual([]);
      dispose();
    }
  });

  it("spawns no gh while nothing is watched, nor for a watched session without PRs (QA item 2)", async () => {
    const t = selfContained();
    const { poller, dispose } = activate(t.host.api, { loop: false });
    for (let i = 0; i < 5; i++) await poller.tick();
    // A session without PRs (and outside git) is watched: still nothing.
    await t.host.call("watch", { viewer: "v", sessionId: "lead", refresh: true });
    for (let i = 0; i < 5; i++) await poller.tick();
    expect(t.calls.filter((c) => c.startsWith("gh"))).toEqual([]);
    // A PR to show: now gh is used.
    await t.host.call("links.add", { sessionId: "lead", url: "https://github.com/acme/api/pull/9" });
    await t.host.call("watch", { viewer: "v", sessionId: "lead", refresh: true });
    expect(t.calls.filter((c) => c.startsWith("gh")).length).toBeGreaterThan(0);
    dispose();
  });
});
