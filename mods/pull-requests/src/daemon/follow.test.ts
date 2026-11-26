import { describe, expect, it, vi } from "vitest";
import { createTestHost } from "@aura/mod-sdk/testing";
import type { CoreEvent } from "@aura/mod-sdk";
import { FollowService, actionable, activity, handOverMessage, removeItems, target, type Activity, type Followed, type PrActivity } from "./follow";
import { parsePrUrl } from "./github";
import { Links, prIds } from "./links";
import { LOGIN_EXPIRED, TestGithub, TestLinks, session, testLib } from "./testing";
import { Tasks, str } from "./util";

const URL1 = "https://github.com/o/r/pull/1";
const row = (id: number, login: string | null, body: string, bot = login?.endsWith("[bot]") ?? false): any => ({
  fullDatabaseId: String(id),
  author: login === null ? null : { login, __typename: bot ? "Bot" : "User" },
  body,
  url: `https://github.com/o/r/pull/1#x-${id}`,
});
const review = (id: number, login: string, state: string, body: string) => ({ ...row(id, login, body), state });

/** GitHub as of its lists, for o/r#1: reviews, inline comments (one thread) and conversation comments, as GraphQL nodes. */
function fake() {
  const world = {
    reviews: [] as any[],
    comments: [] as any[],
    conversation: [] as any[],
    author: "",
    heads: [] as string[],
    reads: 0,
    threads: [] as any[][],
    state: "",
  };
  const gh = new TestGithub();
  const lib = testLib({
    read: async (_gh, prs) => {
      world.reads++;
      return prs.map(([repo, number]) => {
        if (repo !== "o/r" || number !== 1) return new Error(`Unable to read ${repo}#${number}`);
        // A list GitHub left a node out of has a gap: the read fails rather than skip it.
        if ([...world.reviews, ...world.comments, ...world.conversation, ...world.threads.flat()].some((n) => n === null)) {
          return new Error("Unable to read o/r#1: incomplete list");
        }
        const threads = [{ id: "T1", comments: { nodes: [...world.comments] } }, ...world.threads.map((c, i) => ({ id: `T${i + 2}`, comments: { nodes: [...c] } }))];
        return {
          at: new Date().toISOString(),
          node: {
            id: "PR_1",
            number: 1,
            title: "PR",
            url: URL1,
            state: world.state || "OPEN",
            author: { login: world.author || "me" },
            reviews: { nodes: [...world.reviews] },
            comments: { nodes: [...world.conversation] },
            reviewThreads: { nodes: threads },
          },
        };
      });
    },
    branchPull: async (_gh, repo, _head, branch) => {
      world.heads.push(branch);
      return branch === "feature"
        ? { repo, number: 1, title: "PR", url: URL1, state: "open", draft: false, checks: "", review_decision: "", head_sha: "abc", reviews: [] }
        : null;
    },
  });
  const host = createTestHost({ id: "pull-requests" });
  const links = new TestLinks();
  host.provideMod("github", links.serve);
  const svc = new FollowService(host.api, gh, lib, new Links(host.api), new Tasks());
  return { world, gh, lib, host, links, svc };
}

/** Check o/r#1 once. */
async function check(svc: FollowService, known: Followed | null) {
  const [r] = await svc.check([["o/r", 1, known]], "me");
  if (r instanceof Error) throw r;
  return r;
}
const known = (svc: FollowService) => svc.follows.get("o/r#1") ?? null;
const events = (host: ReturnType<typeof createTestHost>) => host.record.emitted.map((e) => e.name);

describe("review follow-ups", () => {
  it("let orchestrators take over from their workers, and the latest session wins", () => {
    const lead = session("lead", {}, 1);
    const worker = session("worker", { orchestrator_id: "lead" }, 5);
    expect(target([worker, lead])!.id).toBe("lead");
    const other = session("other", {}, 9);
    expect(target([worker, other])!.id).toBe("other");
    expect(target([worker])!.id).toBe("worker");
    // The worker wrote the code on the PR's branch; its orchestrator links the PR.
    const linked = session("linked", {}, 2);
    expect(target([worker, linked])!.id).toBe("worker");
  });

  it("read session links as PR ids, once each", () => {
    expect(prIds(["https://github.com/o/r/issues/2", "https://github.com/o/r/pull/3"])).toEqual([["o/r", 3]]);
    expect(prIds(["https://github.com/o/r/pull/4", "https://github.com/O/R/pull/4", "https://github.com/x/y/pull/5"])).toEqual([
      ["o/r", 4],
      ["x/y", 5],
    ]);
    expect(prIds(null)).toEqual([]);
    expect(parsePrUrl("https://github.com/../x/pull/1")).toBeNull();
  });

  it("collect new activity after the first look", async () => {
    const { world, svc } = fake();
    world.reviews.push(review(1, "alice", "CHANGES_REQUESTED", "old"));
    expect(await check(svc, null)).toBeNull();

    world.reviews.push(
      review(2, "alice", "CHANGES_REQUESTED", "Rename this"),
      review(3, "alice", "COMMENTED", ""),
      review(4, "me", "COMMENTED", "Done"),
      review(5, "bob", "APPROVED", ""),
    );
    world.comments.push({ ...row(10, "alice", "Typo"), path: "src/a.rs", line: 7 }, row(11, "me", "Fixed"));
    world.conversation.push(row(20, "carol", "Any news?"), row(21, "ci[bot]", "Coverage 80%"));
    const got = (await check(svc, known(svc)))!;
    expect(got.items.map((i) => [i.kind, i.author, i.state])).toEqual([
      ["comment", "alice", ""],
      ["conversation", "carol", ""],
      ["review", "alice", "CHANGES_REQUESTED"],
      ["review", "bob", "APPROVED"],
    ]);
    expect(actionable(got.items[3])).toBe(false);
    expect(actionable(got.items[0])).toBe(true);
    const text = handOverMessage([got], false);
    expect(text).toContain("alice commented on `src/a.rs` line 7");
    expect(text).toContain("Rename this");
    expect(text.startsWith("[Aura] New review activity on your pull request. This message comes from Aura, not the user.\n")).toBe(true);
    expect(await check(svc, known(svc))).toBeNull();
  });

  it("do not follow PRs by someone else", async () => {
    const { world, svc } = fake();
    world.author = "alice";
    await check(svc, null);
    expect(known(svc)!.author).toBe("alice");
    world.conversation.push(row(1, "bob", "Hi"));
    expect(await check(svc, known(svc))).toBeNull();
  });

  it("give activity to the linked session, and tell the user how it went", async () => {
    const { world, host, links, svc } = fake();
    host.state.sessions = [session("s1", { title: "Feature" })];
    links.prs.s1 = [URL1];
    host.state.lastReplies.set("s1", "Fixed it");
    const off = svc.listen();
    await svc.poll();
    expect(host.record.sent).toEqual([]);

    world.reviews.push(review(2, "alice", "CHANGES_REQUESTED", "Rename this"));
    await svc.poll();
    expect(host.record.sent.length).toBe(1);
    expect(host.record.sent[0].whenFree).toBe(true);
    expect(host.record.sent[0].text.startsWith("[Aura] New review activity")).toBe(true);
    expect(host.record.sent[0].text).toContain("Rename this");
    // The agent's turn on it.
    const turn = { id: "t", session_id: "s1", status: "running", started_at: "", ended_at: null, usage: null, error: null };
    host.fire({ type: "turn_started", session_id: "s1", turn } as CoreEvent);
    host.fire({ type: "turn_completed", session_id: "s1", turn: { ...turn, status: "completed" } } as CoreEvent);
    await vi.waitFor(() => expect(events(host)).toContain("follows.handled"));
    expect(events(host)).toEqual(["follows.activity", "follows.started", "follows.handled"]);
    const handled: any = host.record.emitted[2].payload;
    expect(handled.session.title).toBe("Feature");
    expect(handled.status).toBe("completed");
    expect(handled.reply).toBe("Fixed it");
    expect(handled.prs[0].number).toBe(1);
    expect(svc.pending.size).toBe(0);
    expect(host.collections.get("pr-follow-pending")?.size ?? 0).toBe(0);
    off.forEach((d) => d());
  });

  it("reach the session on the PR's branch, and skip archived and muted ones", async () => {
    const { world, host, links, svc } = fake();
    host.api.git.remotes = async (cwd) => (cwd === "/feature" || cwd === "/other" ? [{ name: "origin", url: "https://github.com/o/r.git" }] : []);
    const tree = (dir: string, branch: string) => ({ cwd: dir, worktree: { repo_root: dir, path: dir, branch } });
    host.state.sessions = [
      session("coder", tree("/feature", "feature"), 1),
      session("idle-worktree", tree("/other", "other"), 1),
      session("old", { archived: true }, 30),
      session("muted", {}, 20),
    ];
    links.prs = { old: [URL1], muted: [URL1] };
    links.muted.add("muted");
    await svc.poll();
    expect(links.recorded).toEqual([{ sessionId: "coder", url: URL1 }]);
    world.reviews.push(review(2, "alice", "CHANGES_REQUESTED", "Rename this"));
    await svc.poll();
    const found: any = host.record.emitted.find((e) => e.name === "follows.activity")!.payload;
    expect(found.session.id).toBe("coder");
    // The PR was found once; the branch without one waits before it is asked again.
    expect(world.heads).toEqual(["feature", "other"]);
  });

  it("find what GitHub's REST lists found", async () => {
    // kind, id, author (null: a deleted account), bot, state, body, path, line, original line
    type Entry = [string, number, string | null, boolean, string, string, string | null, number | null, number | null];
    const big = 6_310_081_535;
    const fixture: Entry[] = [
      ["review", 100, "alice", false, "CHANGES_REQUESTED", "old", null, null, null],
      ["comment", 200, "alice", false, "", "old", "a.rs", 1, 1],
      ["conversation", 300, "carol", false, "", "old", null, null, null],
      // After the first look:
      ["review", 101, "alice", false, "CHANGES_REQUESTED", "Rename", null, null, null],
      ["review", 102, "alice", false, "COMMENTED", " ", null, null, null],
      ["review", 103, "copilot", true, "COMMENTED", "Bot says", null, null, null],
      ["review", 104, "me", false, "COMMENTED", "Mine", null, null, null],
      ["review", 105, "bob", false, "DISMISSED", "x", null, null, null],
      ["review", 106, "bob", false, "APPROVED", "", null, null, null],
      ["review", big, null, false, "COMMENTED", "Ghost", null, null, null],
      ["comment", 201, "alice", false, "", "Typo", "a.rs", 7, 5],
      ["comment", 202, "dave", false, "", "Outdated", "b.rs", null, 12],
      ["comment", 203, "me", false, "", "Fixed", "a.rs", 7, 5],
      ["comment", big + 1, "ci[bot]", true, "", "Lint", null, null, null],
      ["conversation", 301, "carol", false, "", "Any news?", null, null, null],
      ["conversation", 302, "cov", true, "", "Coverage", null, null, null],
      ["conversation", 303, "ci[bot]", false, "", "Build", null, null, null],
      ["conversation", big + 2, "Me", false, "", "Done", null, null, null],
    ];
    const graphql = (e: Entry) => ({ ...row(e[1], e[2], e[5], e[3]), state: e[4], path: e[6], line: e[7], originalLine: e[8] });
    const of = (entries: Entry[], kind: string) => entries.filter((e) => e[0] === kind).map(graphql);
    /** What this service found with GitHub's REST lists, before it read GraphQL. */
    const restItems = (entries: Entry[], seen: [number, number, number], me: string): Activity[] => {
      const byMe = (e: Entry) => (e[2] ?? "").toLowerCase() === me.toLowerCase();
      const item = (e: Entry, state: string): Activity => ({
        kind: e[0],
        id: e[1],
        author: e[2] ?? "",
        state,
        body: e[5],
        url: `https://github.com/o/r/pull/1#x-${e[1]}`,
        path: e[0] === "comment" ? e[6] : null,
        line: e[0] === "comment" ? (e[7] ?? e[8]) : null,
      });
      const items: Activity[] = [];
      for (const e of entries) {
        if (e[0] === "review" && e[1] > seen[0] && !byMe(e) && ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"].includes(e[4]) && !(e[4] === "COMMENTED" && e[5].trim() === "")) {
          items.push(item(e, e[4]));
        }
        if (e[0] === "comment" && e[1] > seen[1] && !byMe(e)) items.push(item(e, ""));
        const bot = e[3] || (e[2] ?? "").endsWith("[bot]");
        if (e[0] === "conversation" && e[1] > seen[2] && !byMe(e) && !bot) items.push(item(e, ""));
      }
      return items.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id - b.id));
    };

    const { world, svc } = fake();
    const fill = (entries: Entry[]) => {
      world.reviews = of(entries, "review");
      world.comments = of(entries, "comment");
      world.conversation = of(entries, "conversation");
    };
    fill(fixture.slice(0, 3));
    expect(await check(svc, null)).toBeNull();
    const k = known(svc)!;
    expect([k.seen_review, k.seen_comment, k.seen_conversation]).toEqual([100, 200, 300]);

    fill(fixture);
    const got = (await check(svc, k))!;
    expect(got.items).toEqual(restItems(fixture, [k.seen_review, k.seen_comment, k.seen_conversation], "me"));
    expect(got.items.map((i) => [i.kind, i.id])).toEqual([
      ["comment", 201],
      ["comment", 202],
      ["comment", big + 1],
      ["conversation", 301],
      ["review", 101],
      ["review", 103],
      ["review", 106],
      ["review", big],
    ]);
    const seen = known(svc)!;
    expect([seen.seen_review, seen.seen_comment, seen.seen_conversation]).toEqual([big, big + 1, big + 2]);
    expect([got.title, got.url]).toEqual(["PR", URL1]);
  });

  it("stop reading while the login is expired, until it works again", async () => {
    const { world, gh, host, links, svc } = fake();
    host.state.sessions = [session("a")];
    links.prs.a = [URL1];
    gh.blockedBy = LOGIN_EXPIRED;
    await svc.poll();
    await svc.poll();
    expect(world.reads).toBe(0);
    gh.blockedBy = null;
    await svc.poll();
    expect(world.reads).toBe(1);
  });

  it("follow only the sessions that did not turn follow-ups off", async () => {
    const { world, host, links, svc } = fake();
    host.state.sessions = [session("a")];
    links.prs.a = [URL1];
    links.muted.add("a");
    await svc.poll();
    expect(world.reads).toBe(0);
    links.muted.delete("a");
    await svc.poll();
    expect(world.reads).toBe(1);
  });

  it("count replies in different threads each as new", async () => {
    const { world, svc } = fake();
    const comment = (id: number, body: string) => ({ ...row(id, "alice", body), path: "a.rs" });
    world.comments = [comment(10, "A")];
    world.threads = [[comment(20, "B")]];
    await check(svc, null);
    const k = known(svc);
    // A reply in the first thread is newer than one in the second, which comes later.
    world.comments.push(comment(40, "A again"));
    world.threads[0].push(comment(30, "B again"));
    const got = (await check(svc, k))!;
    expect(got.items.map((i) => i.id)).toEqual([30, 40]);
    expect(known(svc)!.seen_comment).toBe(40);
  });

  it("record nothing from a read with a gap", async () => {
    const { world, svc } = fake();
    world.conversation = [row(5, "carol", "Hi")];
    await check(svc, null);
    const k = known(svc);
    // GitHub left a comment out of the list, and a later one in.
    world.conversation.push(null, row(7, "carol", "Later"));
    const [checked] = await svc.check([["o/r", 1, k]], "me");
    expect(checked).toBeInstanceOf(Error);
    expect(known(svc)!.seen_conversation).toBe(5);
    world.conversation = world.conversation.filter((c) => c !== null);
    world.conversation.splice(1, 0, row(6, "carol", "Missing"));
    const got = (await check(svc, k))!;
    expect(got.items.map((i) => i.id)).toEqual([6, 7]);
  });

  it("look at a closed PR now and then, and at a merged one no more", async () => {
    const { world, host, links, svc } = fake();
    host.state.sessions = [session("a")];
    links.prs.a = [URL1];
    const age = () => {
      for (const read of svc.reads.values()) read[0] = new Date(Date.parse(read[0]) - 31 * 60_000).toISOString();
    };
    await svc.poll();
    world.state = "CLOSED";
    age();
    await svc.poll();
    expect(world.reads).toBe(2);
    expect(known(svc)!.open).toBe(false);
    await svc.poll();
    expect(world.reads).toBe(2);

    world.state = "OPEN";
    world.reviews.push(review(9, "alice", "CHANGES_REQUESTED", "Reopened; fix this"));
    age();
    await svc.poll();
    expect(world.reads).toBe(3);
    expect(events(host)).toContain("follows.activity");

    world.state = "MERGED";
    age();
    await svc.poll();
    expect(known(svc)!.merged).toBe(true);
    age();
    await svc.poll();
    expect(world.reads).toBe(4);
  });

  it("keep items added while sending queued", () => {
    const item = (id: number) => activity("comment", row(id, "alice", "x"), "");
    const pr = (items: Activity[]): PrActivity => ({ repo: "o/r", number: 1, title: "PR", url: "", items });
    let queue = removeItems([pr([item(1), item(2)])], [pr([item(1)])]);
    expect(queue.length).toBe(1);
    expect(queue[0].items).toEqual([item(2)]);
    queue = removeItems(queue, [pr([item(2)])]);
    expect(queue).toEqual([]);
  });

  it("keep queued activity across a restart", async () => {
    const host = createTestHost({ id: "pull-requests" });
    const start = async () => {
      const svc = new FollowService(host.api, new TestGithub(), testLib(), new Links(host.api), new Tasks());
      await svc.load();
      return svc;
    };
    const item = activity("conversation", row(5, "bob", "Hi"), "");
    await (await start()).editPending("s", (q) => [...q, { repo: "o/r", number: 1, title: "PR", url: "", items: [item] }]);
    expect((await start()).pending.get("s")![0].items).toEqual([item]);
    await (await start()).editPending("s", () => []);
    expect((await start()).pending.size).toBe(0);
  });

  it("report a hand-over that could not be sent", async () => {
    const { host, svc } = fake();
    host.state.sessions = [session("s1")];
    host.api.sessions.send = async () => {
      throw new Error("agent is gone");
    };
    await svc.editPending("s1", () => [{ repo: "o/r", number: 1, title: "PR", url: URL1, items: [activity("conversation", row(5, "bob", "Hi"), "")] }]);
    await svc.flush("s1");
    const handled: any = host.record.emitted.find((e) => e.name === "follows.handled")!.payload;
    expect(handled.status).toBe("failed");
    expect(str(handled, "reply")).toContain("agent is gone");
    expect(svc.pending.size).toBe(0);
    expect(svc.handling.size).toBe(0);
  });
});
