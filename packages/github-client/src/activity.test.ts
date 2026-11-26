import { afterEach, expect, it, vi } from "vitest";
import { databaseId } from "./github";
import { due, dueClosed, Memo, Notified, read, SHARED_FOR_MS, type LastRead } from "./activity";
import { fakeGithub } from "./testing/fake";

afterEach(() => vi.useRealTimers());

const thread = (kind: string, url: string, at: string) => ({ updated_at: at, subject: { type: kind, url } });
const minutesBefore = (now: string, m: number) => new Date(Date.parse(now) - m * 60_000).toISOString();

it("tells from notifications which PRs changed", () => {
  const rows = [
    thread("PullRequest", "https://api.github.com/repos/O/R/pulls/1", "2026-10-26T10:10:00Z"),
    thread("Issue", "https://api.github.com/repos/o/r/issues/2", "2026-10-26T10:05:00Z"),
    thread("PullRequest", "https://git.example.com/api/v3/repos/o/r/pulls/3", "2026-10-26T09:00:00Z"),
  ];
  const n = Notified.parse(rows, 50)!;
  expect(n.changed("o/r", 1, "2026-10-26T10:00:00Z")).toBe(true);
  expect(n.changed("o/r", 1, "2026-10-26T10:11:00Z"), "GitHub may not show it yet").toBe(true);
  expect(n.changed("o/r", 1, "2026-10-26T10:30:00Z")).toBe(false);
  expect(n.changed("o/r", 2, "2026-10-26T09:00:00Z"), "issues are not PRs").toBe(false);
  expect(n.changed("o/r", 3, "2026-10-26T08:00:00Z")).toBe(true);
  expect(n.changed("o/r", 4, "2026-01-01T00:00:00Z"), "a short list is complete").toBe(false);

  const full = Notified.parse(rows, 3)!;
  expect(full.changed("o/r", 4, "2026-10-26T08:00:00Z"), "a full page may have left older threads out").toBe(true);
  expect(full.changed("o/r", 4, "2026-10-26T10:00:00Z")).toBe(false);
  expect(Notified.parse({}, 50)).toBeNull();
  expect(Notified.parse([{ subject: {} }], 50), "a row without a time spoils the page").toBeNull();
  // Crosses RPC as JSON.
  const back = Notified.fromJSON(JSON.parse(JSON.stringify(full)))!;
  expect(back.changed("o/r", 4, "2026-10-26T08:00:00Z")).toBe(true);
  expect(back.changed("o/r", 1, "2026-10-26T10:00:00Z")).toBe(true);
});

it("finds a PR due when notified, active or unread for a while", () => {
  const now = "2026-10-26T12:00:00Z";
  const m = (x: number) => minutesBefore(now, x);
  const quiet = new Notified();
  expect(due(null, quiet, "o/r", 1, now), "never read").toBe(true);
  expect(due([m(1), m(1)], quiet, "o/r", 1, now)).toBe(false);
  expect(due([m(5), m(500)], quiet, "o/r", 1, now)).toBe(true);
  const notified = Notified.parse([thread("PullRequest", "https://api.github.com/repos/o/r/pulls/1", "2026-10-26T11:59:30Z")], 50)!;
  expect(due([m(1), m(500)], notified, "o/r", 1, now)).toBe(true);
  expect(due([m(1), m(10)] as LastRead, null, "o/r", 1, now), "without notifications an active PR is read every pass").toBe(true);
  expect(due([m(1), m(120)], null, "o/r", 1, now)).toBe(false);
});

it("reads a closed PR now and then or when notified", () => {
  const now = "2026-10-26T12:00:00Z";
  const m = (x: number) => minutesBefore(now, x);
  const quiet = new Notified();
  expect(dueClosed(null, quiet, "o/r", 1, now)).toBe(true);
  expect(dueClosed(m(10), quiet, "o/r", 1, now)).toBe(false);
  expect(dueClosed(m(10), null, "o/r", 1, now)).toBe(false);
  expect(dueClosed(m(30), quiet, "o/r", 1, now)).toBe(true);
  const reopened = Notified.parse([thread("PullRequest", "https://api.github.com/repos/o/r/pulls/1", "2026-10-26T11:59:00Z")], 50)!;
  expect(dueClosed(m(10), reopened, "o/r", 1, now)).toBe(true);
});

/** Answers the batch query and the page queries for one PR (`o/r#1`). */
function paged(opts: { brokenPage?: boolean; brokenBatch?: boolean; memo?: Memo } = {}) {
  const queries: string[] = [];
  let account = "github.com:alice";
  const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ fullDatabaseId: String(from + i) }));
  const conn = (nodes: unknown[], more: boolean) => ({ pageInfo: { hasPreviousPage: more, startCursor: "c", hasNextPage: more, endCursor: "c" }, nodes });
  const gh = fakeGithub(
    (_method, _path, body) => {
      const query: string = body.query;
      queries.push(query);
      if (query.includes("pr0:pullRequest")) {
        return { data: { r0: { pr0: {
          id: "PR1", state: "OPEN",
          reviews: conn(ids(151, 200), true),
          comments: conn(opts.brokenBatch ? [{ fullDatabaseId: "1" }, null] : ids(1, 3), false),
          reviewThreads: { pageInfo: { hasNextPage: true, endCursor: "t" }, nodes: [{ id: "T1", comments: conn(ids(10, 11), false) }] },
        } } } };
      }
      if (query.includes("reviews(last:100,before:$cursor)")) {
        if (opts.brokenPage) {
          return { data: { node: { reviews: conn([null, ...ids(52, 150)], true) } }, errors: [{ message: "Something went wrong", path: ["node", "reviews", "nodes", 0] }] };
        }
        return { data: { node: { reviews: conn(ids(51, 150), true) } } };
      }
      if (query.includes("reviewThreads(first:50,after:$cursor)")) {
        return { data: { node: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ id: "T2", comments: conn(ids(20, 21), false) }] } } } };
      }
      throw new Error(`unexpected query ${query}`);
    },
    { memo: () => opts.memo ?? null, account: async () => account },
  );
  return { gh, queries, setAccount: (a: string) => { account = a; } };
}
const first = { reviews: null, comments: null, conversation: null };

it("reads older pages down to what was seen, and every thread", async () => {
  const { gh, queries } = paged();
  const one = await read(gh, [["o/r", 1, first]]);
  const node = (one[0] as { node: any }).node;
  expect(node.reviews.nodes.length, "a first look takes the newest page").toBe(50);
  expect(node.reviewThreads.nodes.length, "every thread").toBe(2);

  queries.length = 0;
  const next = await read(gh, [["o/r", 1, { ...first, reviews: 120 }]]);
  const reviews = (next[0] as { node: any }).node.reviews.nodes.map(databaseId);
  expect([reviews[0], reviews.length], "older pages come first").toEqual([51, 150]);
  expect(queries.length, "the batch, one older page of reviews and one more page of threads").toBe(3);
});

it("fails the read on a page with errors or gaps", async () => {
  // The reviews after the gap would pass the missing one by.
  const broken = await read(paged({ brokenPage: true }).gh, [["o/r", 1, { ...first, reviews: 120 }]]);
  expect(broken[0]).toBeInstanceOf(Error);
  // A list with a missing comment is not taken.
  const gap = await read(paged({ brokenBatch: true }).gh, [["o/r", 1, first]]);
  expect(gap[0]).toBeInstanceOf(Error);
  expect((gap[0] as Error).message).toContain("Unable to read o/r#1");
});

it("shares answers per account, aged from when GitHub gave them", async () => {
  const { gh, queries, setAccount } = paged({ memo: new Memo() });
  const prs: Array<[string, number, typeof first]> = [["o/r", 1, first]];
  const batches = () => queries.filter((q) => q.includes("pr0:pullRequest")).length;
  await read(gh, prs);
  expect(batches()).toBe(1);
  await read(gh, prs);
  expect(batches(), "another loop moments later shares the answer").toBe(1);
  setAccount("github.com:bob");
  await read(gh, prs);
  expect(batches(), "another login reads for itself").toBe(2);

  const memo = new Memo();
  const old = new Date(Date.now() - 25_000).toISOString();
  memo.keep("k", 1, old);
  expect(memo.recall("k", SHARED_FOR_MS)).not.toBeNull();
  memo.keep("k", 2, old);
  expect(memo.recall("k", 20_000), "keeping a read again does not make it younger").toBeNull();
});

it("gives each recall its own copy", () => {
  const memo = new Memo();
  memo.keep("k", { a: [1] }, new Date().toISOString());
  const [value] = memo.recall("k", SHARED_FOR_MS)!;
  value.a.push(2);
  expect(memo.recall("k", SHARED_FOR_MS)![0]).toEqual({ a: [1] });
});
