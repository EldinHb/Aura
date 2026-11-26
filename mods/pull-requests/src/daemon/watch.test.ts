import { describe, expect, it } from "vitest";
import { createTestHost } from "@aura/mod-sdk/testing";
import { LOGIN_EXPIRED, TestGithub, testLib } from "./testing";
import { Tasks, str } from "./util";
import { WatchService, logins, watchId } from "./watch";

const review = (id: number, login: string, state: string) => ({
  id,
  user: { login },
  state,
  body: "",
  html_url: `https://github.com/o/r/pull/1#pullrequestreview-${id}`,
  submitted_at: "2026-09-29T10:00:00Z",
});

/** GitHub as of its lists, for o/r#1 by "me". */
function fake() {
  const world = { reviews: [] as any[], state: "", requested: [] as unknown[], reads: 0 };
  const gh = new TestGithub((method, path, body) => {
    const state = world.state;
    if (method === "GET" && path === "repos/o/r/pulls/1") {
      return { title: "PR", html_url: "https://github.com/o/r/pull/1", state: state || "open", merged: state === "merged", user: { login: "me" } };
    }
    if (method === "GET" && path === "repos/o/r/pulls/1/requested_reviewers") return { users: [{ login: "alice" }], teams: [{ slug: "core" }] };
    if (method === "GET" && path.startsWith("repos/o/r/pulls/1/reviews?")) return [...world.reviews];
    if (method === "GET" && path.startsWith("repos/o/r/assignees?")) return [{ login: "me" }, { login: "alice" }, { login: "bob" }];
    if (method === "POST" && path === "repos/o/r/pulls/1/requested_reviewers") {
      world.requested.push(body);
      return {};
    }
  });
  const lib = testLib({
    read: async (_gh, prs) => {
      world.reads++;
      return prs.map(() => ({
        at: new Date().toISOString(),
        node: {
          id: "PR_1",
          title: "PR",
          url: "https://github.com/o/r/pull/1",
          state: (world.state || "OPEN").toUpperCase(),
          author: { login: "me" },
          reviews: {
            nodes: world.reviews.map((r) => ({
              fullDatabaseId: String(r.id),
              state: r.state,
              body: r.body,
              url: r.html_url,
              submittedAt: r.submitted_at,
              author: { __typename: r.user.login.endsWith("[bot]") ? "Bot" : "User", login: r.user.login },
            })),
          },
        },
      }));
    },
  });
  const host = createTestHost({ id: "pull-requests" });
  const svc = new WatchService(host.api, gh, lib, new Tasks());
  const reported = () => {
    const out = host.record.emitted
      .filter((e) => e.name === "watches.review")
      .map((e: any) => [str(e.payload.review, "reviewer"), str(e.payload.review, "state")]);
    host.record.emitted.length = 0;
    return out;
  };
  return { world, gh, svc, host, reported };
}

describe("review watches", () => {
  it("report comment-only reviews and ignore history", async () => {
    const { world, svc, reported } = fake();
    world.reviews.push(review(5, "alice", "APPROVED"));
    const watch = await svc.start("o/r", 1, ["alice"], []);
    expect(watch.seen).toBe(5);
    await svc.poll(false);
    expect(reported()).toEqual([]);

    world.reviews.push(review(6, "bob", "COMMENTED"), review(7, "me", "COMMENTED"), review(8, "alice", "PENDING"));
    await svc.poll(false);
    expect(reported()).toEqual([]);

    world.reviews.push(review(9, "Alice", "COMMENTED"));
    await svc.poll(false);
    expect(reported()).toEqual([["Alice", "COMMENTED"]]);
    expect(svc.list()[0].status).toBe("done");
    expect(svc.list()[0].seen).toBe(9);

    await svc.poll(false);
    expect(reported()).toEqual([]);
  });

  it("wait for every reviewer and request new ones", async () => {
    const { world, svc, reported } = fake();
    const watch = await svc.start("o/r", 1, ["alice"], ["bob", "alice"]);
    expect(watchId("O/R", 1)).toBe("o/r#1");
    expect(watch.reviewers).toEqual(["alice", "bob"]);
    expect(world.requested).toEqual([{ reviewers: ["bob", "alice"] }]);
    world.reviews.push(review(1, "alice", "CHANGES_REQUESTED"));
    await svc.poll(false);
    expect(svc.list()[0].status).toBe("watching");
    world.reviews.push(review(2, "bob", "APPROVED"));
    await svc.poll(false);
    expect(svc.list()[0].status).toBe("done");
    expect(reported()).toEqual([
      ["alice", "CHANGES_REQUESTED"],
      ["bob", "APPROVED"],
    ]);
  });

  it("leave out the author in anyone mode, and close the watch on a merged PR", async () => {
    const { world, svc, reported } = fake();
    await svc.start("o/r", 1, [], []);
    world.reviews.push(review(1, "copilot-pull-request-reviewer[bot]", "COMMENTED"));
    await svc.poll(false);
    expect(svc.list()[0].status).toBe("watching");
    world.state = "merged";
    await svc.poll(false);
    expect(svc.list()[0].status).toBe("closed");
    expect(reported()).toEqual([]);
    await expect(svc.start("o/r", 1, [], [])).rejects.toThrow("no longer open");
  });

  it("list requested, reviewed and requestable people as candidates", async () => {
    const { world, svc } = fake();
    world.reviews.push(review(1, "bob", "COMMENTED"), review(2, "me", "COMMENTED"));
    const v: any = await svc.candidates("o/r", 1);
    expect(v.requested).toEqual(["alice"]);
    expect(v.teams).toEqual(["core"]);
    expect(v.reviewed).toEqual([{ login: "bob", state: "COMMENTED" }]);
    expect(v.candidates).toEqual(["alice", "bob"]);
    expect(v.watch).toBeNull();
  });

  it("stop reading while the login is expired, until it works again", async () => {
    const { world, gh, svc, reported } = fake();
    await svc.start("o/r", 1, ["alice"], []);
    world.reviews.push(review(1, "alice", "APPROVED"));
    gh.blockedBy = LOGIN_EXPIRED;
    await svc.poll(false);
    await svc.poll(true);
    expect(world.reads).toBe(0);
    expect(reported()).toEqual([]);
    gh.blockedBy = null;
    await svc.poll(false);
    expect(reported()).toEqual([["alice", "APPROVED"]]);
  });

  it("do not read a quiet PR every pass", async () => {
    const { world, svc } = fake();
    await svc.start("o/r", 1, ["alice"], []);
    await svc.poll(false);
    expect(world.reads).toBe(1);
    // Last updated long ago, and no notifications to say otherwise.
    svc.reads.get("o/r#1")![1] = new Date(Date.now() - 3 * 3600_000).toISOString();
    await svc.poll(false);
    expect(world.reads).toBe(1);
    await svc.poll(true);
    expect(world.reads).toBe(2);
  });

  it("serve their RPC methods and keep watches across a restart", async () => {
    const { host, svc } = fake();
    const methods = svc.methods();
    await methods["watches.start"]({ repo: "o/r", number: 1, reviewers: ["alice"] });
    expect(host.record.emitted.map((e) => e.name)).toContain("watches.changed");
    await expect(methods["watches.start"]({ repo: "../x", number: 1 })).rejects.toThrow("Invalid repository");
    const again = new WatchService(host.api, svc.gh, svc.lib, new Tasks());
    await again.load();
    expect(again.list().map((w) => w.id)).toEqual(["o/r#1"]);
    expect(host.collections.get("pr-watches")!.has("o/r#1")).toBe(true);
    await methods["watches.remove"]({ id: "o/r#1" });
    expect(await methods["watches.list"]({})).toEqual([]);
  });

  it("reject unsafe logins", () => {
    expect(() => logins(["ok-name", "copilot-pull-request-reviewer[bot]"])).not.toThrow();
    for (const bad of ["", "../x", "a b", "x?y=1"]) expect(() => logins([bad])).toThrow();
  });
});
