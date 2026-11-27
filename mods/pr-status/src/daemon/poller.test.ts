import { beforeEach, describe, expect, it } from "vitest";
import { createTestHost } from "@aura/mod-sdk/testing";
import { activate } from "../daemon";
import type { SessionView } from "../shared/types";
import { fakeGithub, Notified, prNode, run, session } from "../test/fixtures";
import { baseDelay, BRANCH_RETRY_MS, DISCOVERY_GAP_MS, MAX_CACHED, CLOSED_POLL_MS, DISCOVERY_PER_TICK, FAST_POLL_MS, LEASE_MS, MAX_BACKOFF_MS, nextDelay, POLL_MS, RETAIN_MS, TICK_MS } from "./poller";

const URL1 = "https://github.com/acme/api/pull/1";
const URL2 = "https://github.com/acme/api/pull/2";

/**
 * A daemon half on a test host. GitHub's GraphQL comes from `fake` (as GhCli would answer it); git
 * and `gh pr list` from canned output on the host's aura.process. Sessions: a lead in /code/lead
 * on main, and its worker in /code/worker on `feature`; the lead links PR #1.
 */
async function setup(nodes: Record<number, any> = { 1: prNode({ number: 1 }) }) {
  const host = createTestHost({ id: "pr-status" });
  const fake = fakeGithub(nodes);
  let now = Date.parse("2026-11-27T10:00:00Z");
  /** The branch's PR (GitHub's pullRequests(headRefName:)): its URL, null for none; a branch not listed (but main) fails. */
  const branches: Record<string, string | null> = {};
  /** "branch_pull" per branch query, as the github mod's method was named. */
  const githubCalls: string[] = [];
  /** Hold `git status` answers until released, to race collections. */
  const held: Array<() => void> = [];
  let hold = false;
  let gitBranch: (cwd: string) => string = (cwd) => (cwd === "/code/worker" ? "feature" : "main");
  /** Run before each branch query answers. */
  const hooks: { beforeLookup?: () => Promise<void> } = {};
  host.state.sessions = [session("lead", { title: "Lead", cwd: "/code/lead" }), session("worker", { title: "Worker", orchestrator_id: "lead", cwd: "/code/worker" })];
  host.process.route(async (bin, args) => {
    if (bin === "git" && args[2] === "status") {
      const answer = { stdout: `# branch.oid h\n# branch.head ${gitBranch(args[1])}\n# branch.ab +0 -0\n` };
      return hold ? new Promise((resolve) => held.push(() => resolve(answer))) : answer;
    }
    if (bin === "git" && args[2] === "remote") return { stdout: "origin\tgit@github.com:acme/api.git (fetch)\norigin\tgit@github.com:acme/api.git (push)\n" };
    return undefined;
  });
  // The branch query goes to GitHub through the transport, as the status reads do.
  const read = fake.gh.request.bind(fake.gh);
  fake.gh.request = async (method, path, body: any) => {
    if (!String(body?.query).includes("pullRequests(headRefName")) return read(method, path, body);
    githubCalls.push("branch_pull");
    await hooks.beforeLookup?.();
    const branch = body.variables.head;
    if (branches[branch] === undefined && branch !== "main") throw new Error("GitHub is down");
    const url = branches[branch];
    return { data: { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: url ? [{ url, state: "OPEN", headRepositoryOwner: { login: "acme" } }] : [] } } } };
  };
  const { poller, dispose } = activate(host.api, { gh: fake.gh, now: () => now, loop: false });
  const linked: Record<string, string[]> = {};
  /** The session's linked PRs become `urls` (through the links RPCs). */
  const setLinked = async (id: string, urls: string[]) => {
    for (const url of linked[id] ?? []) if (!urls.includes(url)) await host.call("links.remove", { sessionId: id, url });
    for (const url of urls) await host.call("links.add", { sessionId: id, url });
    linked[id] = urls;
  };
  await setLinked("lead", [URL1]);
  return {
    host, fake, poller, dispose, branches, githubCalls, held, setLinked, hooks,
    setGitBranch: (fn: (cwd: string) => string) => { gitBranch = fn; },
    setHold: (on: boolean) => { hold = on; },
    advance: (ms: number) => { now += ms; },
    watch: (refresh = true) => host.call<SessionView>("watch", { viewer: "v1", sessionId: "lead", refresh }),
    /** What the UI half does every 30 s: renew the watch, which also runs a tick. */
    renew: () => host.call<SessionView>("watch", { viewer: "v1", sessionId: "lead", refresh: false }),
    reads: () => fake.queries.flat(),
  };
}

describe("delays", () => {
  it("polls every minute, every 20 s while checks run or mergeability is unknown, never once merged or closed", () => {
    expect(baseDelay(null)).toBe(POLL_MS);
    const status = (over: any) => ({ state: "open", checks: { state: "passing" }, readiness: { ready: true, reasons: [] }, ...over });
    expect(baseDelay(status({}) as any)).toBe(POLL_MS);
    expect(baseDelay(status({ checks: { state: "pending" } }) as any)).toBe(FAST_POLL_MS);
    expect(baseDelay(status({ readiness: { ready: false, reasons: ["unknown"] } }) as any)).toBe(FAST_POLL_MS);
    expect(baseDelay(status({ state: "merged", readiness: null }) as any)).toBe(Infinity);
    expect(baseDelay(status({ state: "closed", readiness: null }) as any)).toBe(CLOSED_POLL_MS);
  });

  it("uses the paced wait, and after failures doubles up to 15 minutes", () => {
    expect(nextDelay(POLL_MS, 4 * POLL_MS, 0)).toBe(4 * POLL_MS);
    expect(nextDelay(POLL_MS, POLL_MS, 1)).toBe(2 * POLL_MS);
    expect(nextDelay(POLL_MS, POLL_MS, 3)).toBe(8 * POLL_MS);
    expect(nextDelay(POLL_MS, 10 * POLL_MS, 1)).toBe(10 * POLL_MS);
    expect(nextDelay(POLL_MS, POLL_MS, 10)).toBe(MAX_BACKOFF_MS);
  });

  it("never waits less than the pace asks, back-off or not (review item 6)", () => {
    expect(nextDelay(POLL_MS, 60 * 60_000, 1)).toBe(60 * 60_000);
    expect(nextDelay(POLL_MS, 60 * 60_000, 10)).toBe(60 * 60_000);
  });
});

describe("PrPoller", () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    t = await setup();
  });

  it("reads the watched session's PRs at once and then once a minute", async () => {
    const view = await t.watch();
    expect(view.pulls.map((p) => [p.ref.url, p.status?.state, p.readAt])).toEqual([[URL1, "open", "2026-11-27T10:00:00.000Z"]]);
    expect(t.reads()).toEqual([1]);
    t.advance(30_000);
    await t.poller.tick();
    expect(t.reads()).toEqual([1]);
    t.advance(30_000);
    await t.poller.tick();
    expect(t.reads()).toEqual([1, 1]);
    expect(t.host.record.emitted.at(-1)).toEqual({ name: "changed", payload: { sessionIds: ["lead"] } });
  });

  it("polls faster while checks are pending, and as slowly as the rate limit asks", async () => {
    t.fake.state.nodes[1] = prNode({ number: 1, checks: [run("build", null, "IN_PROGRESS")] });
    await t.watch();
    t.advance(FAST_POLL_MS);
    await t.renew();
    expect(t.reads()).toEqual([1, 1]);
    expect(t.fake.paceCalls.filter((b) => b !== TICK_MS)).toEqual([FAST_POLL_MS, FAST_POLL_MS]);

    // Checks done; the budget runs low, so a minute becomes four.
    t.fake.state.nodes[1] = prNode({ number: 1 });
    t.fake.state.pace = (base) => base * 4;
    t.advance(FAST_POLL_MS);
    await t.renew();
    expect(t.reads()).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      t.advance(POLL_MS);
      await t.renew();
    }
    expect(t.reads()).toHaveLength(3);
    t.advance(POLL_MS);
    await t.renew();
    expect(t.reads()).toHaveLength(4);
  });

  it("backs off after failures and keeps the last status", async () => {
    await t.watch();
    t.fake.state.fail = new Error("Bad gateway");
    t.advance(POLL_MS);
    await t.renew();
    const view = await t.host.call<SessionView>("view", { sessionId: "lead" });
    expect(view.pulls[0]).toMatchObject({ error: "Bad gateway", readAt: "2026-11-27T10:00:00.000Z", status: { state: "open" } });
    // One failure: two minutes, then two failures: four.
    const readsAfter = async (minutes: number) => {
      for (let i = 0; i < minutes; i++) {
        t.advance(POLL_MS);
        await t.renew();
      }
      return t.fake.queries.length;
    };
    expect(await readsAfter(1)).toBe(2);
    expect(await readsAfter(1)).toBe(3);
    expect(await readsAfter(3)).toBe(3);
    expect(await readsAfter(1)).toBe(4);
    // Back to normal once a read works.
    t.fake.state.fail = null;
    expect(await readsAfter(8)).toBe(5);
    expect(await readsAfter(1)).toBe(6);
  });

  it("reads a merged PR once, then only on refresh", async () => {
    t.fake.state.nodes[1] = prNode({ number: 1, state: "MERGED" });
    await t.watch();
    for (let i = 0; i < 20; i++) {
      t.advance(POLL_MS);
      await t.renew();
    }
    await t.watch(true);
    expect(t.reads()).toEqual([1]);
    const view = await t.host.call<SessionView>("refresh", { sessionId: "lead" });
    expect(t.reads()).toEqual([1, 1]);
    expect(view.pulls[0].status?.readiness).toBeNull();
  });

  it("reads early on a notification for the PR", async () => {
    await t.watch();
    t.advance(10_000);
    t.fake.state.notified = new Notified({ "acme/api#1": "2026-11-27T10:00:09Z" });
    await t.poller.tick();
    expect(t.reads()).toEqual([1, 1]);
  });

  it("stops polling when nobody looks: unwatched, or the lease runs out", async () => {
    await t.watch();
    await t.host.call("unwatch", { viewer: "v1" });
    t.advance(5 * POLL_MS);
    await t.poller.tick();
    expect(t.reads()).toEqual([1]);

    await t.watch(false);
    expect(t.reads()).toEqual([1, 1]);
    t.advance(LEASE_MS);
    await t.poller.tick();
    expect(t.reads()).toEqual([1, 1]);
  });

  it("leaves GitHub alone while blocked, keeping the last data with the reason", async () => {
    await t.watch();
    t.fake.state.blocked = "GitHub login expired.";
    t.advance(POLL_MS);
    await t.poller.tick();
    expect(t.reads()).toEqual([1]);
    const view = await t.host.call<SessionView>("view", { sessionId: "lead" });
    expect(view).toMatchObject({ blocked: "GitHub login expired.", pulls: [{ status: { state: "open" }, readAt: "2026-11-27T10:00:00.000Z" }] });
    expect(t.host.record.emitted.at(-1)).toEqual({ name: "changed", payload: { sessionIds: ["lead"] } });
    t.fake.state.blocked = null;
    await t.poller.tick();
    expect(t.reads()).toEqual([1, 1]);
  });

  it("finds a worker's branch PR and PRs linked later", async () => {
    t.fake.state.nodes[2] = prNode({ number: 2 });
    t.branches.feature = URL2;
    // The linked PR is read at once; the branch PR shows (loading) once the discovery queue
    // looked it up after that read, and is read in the next round.
    const first = await t.watch();
    expect(first.pulls.map((p) => [p.ref.url, p.status?.state ?? null])).toEqual([[URL1, "open"], [URL2, null]]);
    expect(t.fake.queries).toEqual([[1]]);
    await t.poller.tick();
    const view = await t.host.call<SessionView>("view", { sessionId: "lead" });
    expect(view.pulls.map((p) => [p.ref.url, p.ref.sources.map((s) => s.title)])).toEqual([[URL1, ["Lead"]], [URL2, ["Worker"]]]);
    expect(t.fake.queries).toEqual([[1], [2]]);

    t.fake.state.nodes[3] = prNode({ number: 3 });
    await t.setLinked("worker", ["https://github.com/acme/api/pull/3"]);
    await t.poller.tick();
    expect((await t.host.call<SessionView>("view", { sessionId: "lead" })).pulls).toHaveLength(3);
    expect(t.fake.queries.at(-1)).toEqual([3]);
  });

  it("looks a branch's PR up again only when the branch moves or the copy is old", async () => {
    t.branches.feature = null;
    await t.watch();
    const lookups = () => t.githubCalls.filter((c) => c === "branch_pull").length;
    expect(lookups()).toBe(2);
    t.host.fire({ type: "turn_completed", session_id: "worker" } as any);
    await t.poller.tick();
    expect(lookups()).toBe(2);
  });

  it("reads a PR once per notification, not on every tick of GitHub's overlap (review item 2)", async () => {
    await t.watch();
    t.advance(10_000);
    t.fake.state.notified = new Notified({ "acme/api#1": "2026-11-27T10:00:09Z" });
    for (let i = 0; i < 8; i++) {
      await t.renew();
      t.advance(TICK_MS);
    }
    expect(t.reads()).toEqual([1, 1]);
    // A newer notification reads it again, once.
    t.fake.state.notified = new Notified({ "acme/api#1": "2026-11-27T10:00:45Z" });
    await t.renew();
    await t.renew();
    expect(t.reads()).toEqual([1, 1, 1]);
  });

  it("keeps a failure's retry deadline when a notification comes (review item 2)", async () => {
    await t.watch();
    t.fake.state.fail = new Error("Bad gateway");
    t.advance(POLL_MS);
    await t.renew();
    expect(t.fake.queries).toHaveLength(2);
    t.fake.state.notified = new Notified({ "acme/api#1": new Date(Date.parse("2026-11-27T10:01:05Z")).toISOString() });
    for (let i = 0; i < 20; i++) {
      t.advance(TICK_MS);
      await t.renew();
    }
    // 100 s after the failure; its back-off is two minutes.
    expect(t.fake.queries).toHaveLength(2);
    t.advance(25_000);
    await t.renew();
    expect(t.fake.queries).toHaveLength(3);
  });

  it("does not let an older collection overwrite newer links (review item 3)", async () => {
    await t.watch();
    // A collection (the section shown again) starts and waits on git with the old links …
    t.setHold(true);
    t.poller.invalidate();
    const shown = t.host.call<SessionView>("watch", { viewer: "v2", sessionId: "lead", refresh: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.held).toHaveLength(1);
    // … the user switches the session to PR #2, and the newer collection answers first.
    t.setHold(false);
    await t.setLinked("lead", [URL2]);
    t.setHold(true);
    t.fake.state.nodes[2] = prNode({ number: 2 });
    t.poller.invalidate();
    const tick = t.poller.view("lead");
    await new Promise((r) => setTimeout(r, 0));
    t.held.splice(0).reverse().forEach((release) => release());
    await new Promise((r) => setTimeout(r, 0));
    t.held.splice(0).forEach((release) => release());
    t.setHold(false);
    expect((await tick).pulls.map((p) => p.ref.url)).toEqual([URL2]);
    expect((await shown).pulls.map((p) => p.ref.url)).toEqual([URL2]);
    await t.renew();
    expect((await t.host.call<SessionView>("view", { sessionId: "lead" })).pulls.map((p) => p.ref.url)).toEqual([URL2]);
  });

  it("notices a closed PR was reopened: on a notification, when shown, and every 15 minutes (review item 4)", async () => {
    t.fake.state.nodes[1] = prNode({ number: 1, state: "CLOSED" });
    await t.watch();
    t.advance(POLL_MS);
    await t.renew();
    expect(t.reads()).toEqual([1]);

    t.fake.state.nodes[1] = prNode({ number: 1 });
    t.fake.state.notified = new Notified({ "acme/api#1": "2026-11-27T10:01:01Z" });
    t.advance(TICK_MS);
    await t.renew();
    expect(t.reads()).toEqual([1, 1]);
    expect((await t.host.call<SessionView>("view", { sessionId: "lead" })).pulls[0].status?.state).toBe("open");

    t.fake.state.nodes[1] = prNode({ number: 1, state: "CLOSED" });
    t.advance(POLL_MS);
    await t.renew();
    expect(t.reads()).toHaveLength(3);
    t.advance(TICK_MS * 3);
    await t.watch(true);
    expect(t.reads()).toHaveLength(4);
    for (let i = 0; i < 14; i++) {
      t.advance(POLL_MS);
      await t.renew();
    }
    expect(t.reads()).toHaveLength(4);
    t.advance(POLL_MS);
    await t.renew();
    expect(t.reads()).toHaveLength(5);
  });

  it("discovers branch PRs a few per round, paced, and remembers failed lookups (review item 8)", async () => {
    t.host.state.sessions.push(...["w2", "w3", "w4"].map((id) => session(id, { title: id, orchestrator_id: "lead" })));
    t.setGitBranch((cwd) => `b-${cwd.slice(6)}`);
    const lookups = () => t.githubCalls.filter((c) => c === "branch_pull").length;
    // A low budget spaces the rounds with lookups out: 4 × TICK_MS.
    t.fake.state.pace = (base) => base * 4;
    // The linked PR is read in the first round, before any branch lookup.
    const view = await t.watch();
    expect(view.pulls[0].status?.state).toBe("open");
    expect(t.fake.queries[0]).toEqual([1]);
    expect(lookups()).toBe(DISCOVERY_PER_TICK);
    await t.renew();
    expect(lookups()).toBe(DISCOVERY_PER_TICK);
    t.advance(4 * TICK_MS);
    await t.renew();
    expect(lookups()).toBe(2 * DISCOVERY_PER_TICK);
    t.advance(4 * TICK_MS);
    await t.renew();
    expect(lookups()).toBe(5);
    // Every lookup failed (GitHub is down here): none is tried again before BRANCH_RETRY_MS
    // (the first two were made 40 s ago).
    for (let i = 0; i < 3; i++) {
      t.advance(TICK_MS);
      await t.renew();
    }
    expect(lookups()).toBe(5);
    t.advance(BRANCH_RETRY_MS);
    await t.renew();
    expect(lookups()).toBe(5 + DISCOVERY_PER_TICK);
  });

  it("forgets what nobody looks at, and a removed session's caches (review item 9)", async () => {
    await t.watch();
    expect(t.poller.cached()).toMatchObject({ entries: 1, branches: 2, repos: 2, trees: 1 });
    t.host.fire({ type: "session_removed", session_id: "worker" } as any);
    expect(t.poller.cached()).toMatchObject({ entries: 1, branches: 1, repos: 1, trees: 0 });
    t.advance(LEASE_MS);
    await t.poller.tick();
    expect(t.poller.cached()).toMatchObject({ entries: 1, trees: 0 });
    t.advance(RETAIN_MS);
    await t.poller.tick();
    expect(t.poller.cached()).toEqual({ entries: 0, branches: 0, repos: 0, trees: 0, queued: 0, folders: 0 });
  });

  describe("second review", () => {
    it("keeps a watched card's data while GitHub is blocked, however long (item 1)", async () => {
      await t.watch();
      t.fake.state.blocked = "API rate limit reached; waiting.";
      for (let i = 0; i < 15; i++) {
        t.advance(POLL_MS);
        await t.renew();
      }
      const view = await t.host.call<SessionView>("view", { sessionId: "lead" });
      expect(view.pulls[0]).toMatchObject({ status: { state: "open" }, readAt: "2026-11-27T10:00:00.000Z" });
      expect(t.poller.cached().entries).toBe(1);
    });

    it("keeps every watched PR past MAX_CACHED and reads none of them again early (item 1)", async () => {
      const many = Array.from({ length: MAX_CACHED + 20 }, (_, i) => i + 1);
      many.forEach((n) => (t.fake.state.nodes[n] = prNode({ number: n })));
      // More than a session may link (100): split over the lead, its worker and its conversation.
      const url = (n: number) => `https://github.com/acme/api/pull/${n}`;
      await t.setLinked("lead", many.slice(0, 100).map(url));
      await t.setLinked("worker", many.slice(100, 200).map(url));
      t.host.fire({ type: "item_completed", session_id: "lead", item: { kind: "agent_message", text: many.slice(200).map(url).join(" "), data: {} } } as any);
      await new Promise((r) => setTimeout(r, 0));
      t.poller.invalidate();
      await t.watch();
      const first = t.reads().length;
      expect(first).toBe(MAX_CACHED + 20);
      t.advance(TICK_MS);
      await t.renew();
      await t.renew();
      expect(t.reads()).toHaveLength(first);
      expect(t.poller.cached().entries).toBe(MAX_CACHED + 20);
    });

    it("gives callers that joined a collection before an invalidation the newer tree (item 2)", async () => {
      await t.watch();
      t.setHold(true);
      t.poller.invalidate();
      const a = t.poller.view("lead");
      const b = t.poller.view("lead");
      await new Promise((r) => setTimeout(r, 0));
      expect(t.held).toHaveLength(1);
      t.setHold(false);
      await t.setLinked("lead", [URL2]);
      t.poller.invalidate();
      t.held.splice(0).forEach((release) => release());
      expect((await a).pulls.map((p) => p.ref.url)).toEqual([URL2]);
      expect((await b).pulls.map((p) => p.ref.url)).toEqual([URL2]);
    });

    it("keeps a lookup's answer when the tree is collected again meanwhile (item 3)", async () => {
      t.branches.feature = URL2;
      t.fake.state.nodes[2] = prNode({ number: 2 });
      // Every lookup is answered only after the trees were collected again (a finished turn).
      const lookup = t.githubCalls.length;
      t.hooks.beforeLookup = async () => {
        t.poller.invalidate();
        await t.poller.view("lead");
      };
      await t.watch();
      expect(t.githubCalls.length).toBe(lookup + 2);
      const view = await t.host.call<SessionView>("view", { sessionId: "lead" });
      expect(view.pulls.map((p) => p.ref.url)).toEqual([URL1, URL2]);
      expect(t.poller.cached().queued).toBe(0);
    });

    it("stops looking up a tree's branches once nobody watches it (item 4)", async () => {
      t.host.state.sessions.push(session("solo", { title: "Solo" }), ...["w2", "w3", "w4"].map((id) => session(id, { orchestrator_id: "lead" })));
      const lookups = () => t.githubCalls.filter((c) => c === "branch_pull").length;
      // No PR linked, and no branch has one.
      await t.setLinked("lead", []);
      t.setGitBranch(() => "main");
      await t.watch();
      expect(lookups()).toBe(DISCOVERY_PER_TICK);
      expect(t.poller.cached()).toMatchObject({ queued: 5 - DISCOVERY_PER_TICK, folders: 5 });
      // The user selects another session: the lead's watch goes, the solo session's starts.
      await t.host.call("unwatch", { viewer: "v1" });
      await t.host.call("watch", { viewer: "v2", sessionId: "solo", refresh: true });
      expect(t.poller.cached()).toMatchObject({ folders: 1 });
      for (let i = 0; i < 5; i++) {
        t.advance(DISCOVERY_GAP_MS);
        await t.host.call("watch", { viewer: "v2", sessionId: "solo", refresh: false });
      }
      // Only the solo session's own folder was looked up after the switch.
      expect(lookups()).toBe(DISCOVERY_PER_TICK + 1);
      expect(t.poller.cached().queued).toBe(0);
    });

    it("spaces lookup rounds by the full paced gap, whoever runs the round (item 5)", async () => {
      t.host.state.sessions.push(...["w2", "w3", "w4"].map((id) => session(id, { orchestrator_id: "lead" })));
      const lookups = () => t.githubCalls.filter((c) => c === "branch_pull").length;
      t.branches.feature = null;
      t.setGitBranch(() => "main");
      await t.watch();
      expect(lookups()).toBe(DISCOVERY_PER_TICK);
      // RPC-driven rounds back to back (renewals, refreshes) do not look up more.
      await t.renew();
      await t.host.call("refresh", { sessionId: "lead" });
      await t.renew();
      expect(lookups()).toBe(DISCOVERY_PER_TICK);
      t.advance(DISCOVERY_GAP_MS - 1);
      await t.renew();
      expect(lookups()).toBe(DISCOVERY_PER_TICK);
      t.advance(1);
      await t.renew();
      expect(lookups()).toBe(2 * DISCOVERY_PER_TICK);
    });
  });

  describe("third review", () => {
    it("does not prune the lookup of a session selected while the previous round was collecting", async () => {
      t.host.state.sessions.push(session("solo", { title: "Solo" }));
      t.setGitBranch((cwd) => (cwd === "/code/solo" ? "solo-branch" : "main"));
      t.branches["solo-branch"] = URL2;
      t.fake.state.nodes[2] = prNode({ number: 2 });
      await t.watch();
      t.advance(DISCOVERY_GAP_MS);
      // A round starts collecting the lead's tree and waits on the github mod …
      t.poller.invalidate();
      t.setHold(true);
      const round = t.poller.tick();
      await new Promise((r) => setTimeout(r, 0));
      expect(t.held).toHaveLength(1);
      t.setHold(false);
      // … while the user selects the solo session, whose collection queues its branch lookup.
      await t.host.call("unwatch", { viewer: "v1" });
      const shown = t.host.call<SessionView>("watch", { viewer: "v2", sessionId: "solo", refresh: true });
      await new Promise((r) => setTimeout(r, 0));
      expect(t.poller.cached().queued).toBe(1);
      t.held.splice(0).forEach((release) => release());
      await round;
      await shown;
      // Well within the 60 s collection TTL: the branch PR was found and shows.
      await t.host.call("watch", { viewer: "v2", sessionId: "solo", refresh: false });
      const view = await t.host.call<SessionView>("view", { sessionId: "solo" });
      expect(view.pulls.map((p) => [p.ref.url, p.status?.state ?? null])).toEqual([[URL2, "open"]]);
    });
  });

  describe("sessions open in the background", () => {
    const background = (sessionId = "lead") => t.host.call("watch", { viewer: "tab", sessionId, background: true });

    it("keeps an open session's PRs without reading them, and reads them again when shown", async () => {
      await t.watch();
      expect(t.reads()).toEqual([1]);
      // Another session is selected; the lead stays open in its tab.
      await t.host.call("unwatch", { viewer: "v1" });
      for (let i = 0; i < 15; i++) {
        t.advance(POLL_MS);
        expect(await background()).toBeNull();
        await t.poller.tick();
      }
      expect(t.reads()).toEqual([1]);
      expect(t.poller.cached().entries).toBe(1);
      // Shown again: the cards are there, dated, and read once more.
      const view = await t.watch();
      expect(view.pulls[0].status?.state).toBe("open");
      expect(t.reads()).toEqual([1, 1]);
    });

    it("polls a selected session at the normal rate, also while it is open in a tab", async () => {
      await background();
      await t.watch();
      t.advance(POLL_MS);
      await t.renew();
      expect(t.reads()).toEqual([1, 1]);
    });

    it("forgets an open session's PRs once its tab closes", async () => {
      await t.watch();
      await t.host.call("unwatch", { viewer: "v1" });
      await background();
      await t.host.call("unwatch", { viewer: "tab" });
      t.advance(RETAIN_MS);
      await t.poller.tick();
      expect(t.poller.cached()).toMatchObject({ entries: 0, trees: 0 });
    });
  });

  describe("QA", () => {
    it("asks GitHub for notifications only while a PR is on screen", async () => {
      await t.setLinked("lead", []);
      t.poller.invalidate();
      await t.watch();
      for (let i = 0; i < 5; i++) {
        t.advance(POLL_MS);
        await t.renew();
      }
      expect(t.fake.notifiedCalls).toHaveLength(0);
      await t.setLinked("lead", [URL1]);
      t.poller.invalidate();
      await t.renew();
      expect(t.fake.notifiedCalls.length).toBeGreaterThan(0);
    });
  });
});
