import { beforeEach, describe, expect, it } from "vitest";
import { createTestHost } from "@aura/mod-sdk/testing";
import { activate } from "../daemon";
import type { SessionView } from "../shared/types";
import { fakeGithub, Notified, prNode, run, session } from "../test/fixtures";
import { baseDelay, FAST_POLL_MS, LEASE_MS, MAX_BACKOFF_MS, nextDelay, POLL_MS } from "./poller";

const URL1 = "https://github.com/acme/api/pull/1";
const URL2 = "https://github.com/acme/api/pull/2";

function setup(nodes: Record<number, any> = { 1: prNode({ number: 1 }) }) {
  const host = createTestHost({ id: "pr-status" });
  const fake = fakeGithub(nodes);
  let now = Date.parse("2026-11-27T10:00:00Z");
  const links: Record<string, { pulls: string[] }> = {};
  const linked: Record<string, string[]> = { lead: [URL1] };
  const branches: Record<string, string | null> = {};
  const githubCalls: string[] = [];
  host.state.sessions = [session("lead", { title: "Lead" }), session("worker", { title: "Worker", orchestrator_id: "lead" })];
  host.provideMod("github", (name, params) => {
    githubCalls.push(name);
    if (name === "sessions.prs") return linked;
    if (name === "links.all") return links;
    if (name === "repo") return "acme/api";
    if (name === "branch_pull") return branches[params.branch] ? { url: branches[params.branch] } : null;
    throw new Error(`unexpected ${name}`);
  });
  host.api.git.branchStatus = async (cwd: string) => ({ branch: cwd === "/code/worker" ? "feature" : "main", head: "h", upstream: null, upstream_branch: null, upstream_repo: null, ahead: 0, behind: 0, changed: 0 });
  const { poller, dispose } = activate(host.api, { gh: fake.gh, now: () => now, loop: false });
  return {
    host, fake, poller, dispose, links, linked, branches, githubCalls,
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
    expect(baseDelay(status({ state: "closed", readiness: null }) as any)).toBe(Infinity);
  });

  it("uses the paced wait, and after failures doubles up to 15 minutes", () => {
    expect(nextDelay(POLL_MS, 4 * POLL_MS, 0)).toBe(4 * POLL_MS);
    expect(nextDelay(POLL_MS, POLL_MS, 1)).toBe(2 * POLL_MS);
    expect(nextDelay(POLL_MS, POLL_MS, 3)).toBe(8 * POLL_MS);
    expect(nextDelay(POLL_MS, 10 * POLL_MS, 1)).toBe(10 * POLL_MS);
    expect(nextDelay(POLL_MS, POLL_MS, 10)).toBe(MAX_BACKOFF_MS);
  });
});

describe("PrPoller", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
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
    expect(t.fake.paceCalls).toEqual([FAST_POLL_MS, FAST_POLL_MS]);

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
    t.advance(10 * POLL_MS);
    await t.poller.tick();
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
    const view = await t.watch();
    expect(view.pulls.map((p) => [p.ref.url, p.ref.sources.map((s) => s.title)])).toEqual([[URL1, ["Lead"]], [URL2, ["Worker"]]]);
    expect(t.fake.queries).toEqual([[1, 2]]);

    t.links.worker = { pulls: ["https://github.com/acme/api/pull/3"] };
    t.fake.state.nodes[3] = prNode({ number: 3 });
    t.host.fireMod("github", "links.changed", { sessionId: "worker" });
    await t.poller.tick();
    expect((await t.host.call<SessionView>("view", { sessionId: "lead" })).pulls).toHaveLength(3);
    expect(t.fake.queries.at(-1)).toEqual([3]);
  });

  it("looks a branch's PR up again only when the branch moves or the copy is old", async () => {
    await t.watch();
    const lookups = () => t.githubCalls.filter((c) => c === "branch_pull").length;
    expect(lookups()).toBe(2);
    t.host.fire({ type: "turn_completed", session_id: "worker" } as any);
    await t.poller.tick();
    expect(lookups()).toBe(2);
  });
});
