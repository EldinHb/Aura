import { describe, expect, it } from "vitest";
import { collectPulls, parsePr, sessionTree, type SessionPrs } from "./collect";
import { session } from "../test/fixtures";

const none: SessionPrs = { linked: [], pulls: [], branch: null };

describe("sessionTree", () => {
  const sessions = [
    session("lead", { orchestrator: true }),
    session("w1", { orchestrator_id: "lead", orchestrator: true }),
    session("w2", { orchestrator_id: "lead" }),
    session("w1a", { orchestrator_id: "w1" }),
    session("other"),
    session("other-worker", { orchestrator_id: "other" }),
  ];

  it("holds the session and its workers at any depth, root first", () => {
    expect(sessionTree(sessions, "lead").map((t) => [t.session.id, t.worker])).toEqual([
      ["lead", false], ["w1", true], ["w2", true], ["w1a", true],
    ]);
  });

  it("starting at a worker holds only its own subtree", () => {
    expect(sessionTree(sessions, "w1").map((t) => t.session.id)).toEqual(["w1", "w1a"]);
  });

  it("is empty for an unknown session and survives a cycle", () => {
    expect(sessionTree(sessions, "nope")).toEqual([]);
    const loop = [session("a", { orchestrator_id: "b" }), session("b", { orchestrator_id: "a" })];
    expect(sessionTree(loop, "a").map((t) => t.session.id)).toEqual(["a", "b"]);
  });
});

describe("parsePr", () => {
  it("canonicalises github.com PR URLs and refuses others", () => {
    expect(parsePr("https://github.com/acme/api/pull/42/files#diff")).toEqual({ url: "https://github.com/acme/api/pull/42", repo: "acme/api", number: 42 });
    expect(parsePr("https://github.com/acme/api/issues/42")).toBeNull();
    expect(parsePr("https://gitlab.com/acme/api/pull/42")).toBeNull();
    expect(parsePr("https://github.com/acme/api/pull/0")).toBeNull();
  });
});

describe("collectPulls", () => {
  it("deduplicates by URL across the tree, keeping every session it came from", () => {
    const tree = sessionTree([
      session("lead", { title: "Lead" }),
      session("w1", { title: "Worker one", orchestrator_id: "lead" }),
      session("deep", { title: "Deep worker", orchestrator_id: "w1" }),
    ], "lead");
    const prs: Record<string, SessionPrs> = {
      lead: { linked: ["https://github.com/acme/api/pull/1"], pulls: [], branch: null },
      w1: { linked: [], pulls: ["https://github.com/ACME/api/pull/1"], branch: "https://github.com/acme/web/pull/7" },
      // Depth 2, linked, from its pulls and from its branch: one source.
      deep: { linked: ["https://github.com/acme/api/pull/9"], pulls: ["https://github.com/acme/api/pull/9"], branch: "https://github.com/acme/api/pull/9" },
    };
    const refs = collectPulls(tree, (id) => prs[id] ?? none);
    expect(refs.map((r) => [r.url, r.sources.map((s) => `${s.title}${s.worker ? " (worker)" : ""}`)])).toEqual([
      ["https://github.com/acme/api/pull/1", ["Lead", "Worker one (worker)"]],
      ["https://github.com/acme/web/pull/7", ["Worker one (worker)"]],
      ["https://github.com/acme/api/pull/9", ["Deep worker (worker)"]],
    ]);
  });

  it("skips what is not a PR URL", () => {
    const tree = sessionTree([session("a")], "a");
    expect(collectPulls(tree, () => ({ linked: ["https://github.com/acme/api/issues/3"], pulls: ["nonsense"], branch: null }))).toEqual([]);
  });
});
