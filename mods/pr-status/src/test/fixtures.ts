// Builders for the daemon tests: sessions, GraphQL PR nodes and a stand-in GitHub transport.
import type { Session } from "@aura/mod-sdk";
import { Notified, type Github } from "@aura/github-client";

export function session(id: string, over: Partial<Session> = {}): Session {
  return {
    id, title: id, provider: "claude", agent: null, native_id: null, cwd: `/code/${id}`, worktree: null, group: null,
    status: "idle", mode: "structured", model: null, effort: null, permission_mode: null, sandbox_mode: null, command: null,
    created_at: "2026-11-27T09:00:00Z", last_activity: "2026-11-27T09:00:00Z", archived: false, pinned: false, last_error: null,
    pending_count: 0, exit_code: null, system_prompt: null, orchestrator: false, orchestrator_id: null, feature_owner: false,
    specialist_id: null, specialist_name: null, folderless: false, attention: null, scheduled_task_id: null, scheduled_task_name: null,
    usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, total_cost_usd: null, context_window: null, context_used: null, running_totals: false },
    ...over,
  } as Session;
}

const review = (login: string, state: string, typename = "User") => ({ state, submittedAt: "2026-11-27T08:00:00Z", author: { __typename: typename, login }, commit: { oid: "abc" } });

/** A PR node as STATUS_FRAGMENT reads it; open, clean, one passing check and no reviews unless told otherwise. */
export function prNode(over: {
  number?: number; title?: string; state?: string; isDraft?: boolean; mergeable?: string; mergeStateStatus?: string; reviewDecision?: string | null;
  author?: string; requested?: Array<[string, string]>; reviews?: Array<[string, string] | [string, string, string]>; opinions?: Array<[string, string]>;
  checks?: any[]; rollup?: string | null;
} = {}) {
  return {
    number: over.number ?? 1,
    title: over.title ?? "A change",
    url: `https://github.com/acme/api/pull/${over.number ?? 1}`,
    state: over.state ?? "OPEN",
    isDraft: over.isDraft ?? false,
    mergeable: over.mergeable ?? "MERGEABLE",
    mergeStateStatus: over.mergeStateStatus ?? "CLEAN",
    reviewDecision: over.reviewDecision ?? null,
    author: { login: over.author ?? "me" },
    reviewRequests: {
      nodes: (over.requested ?? []).map(([type, name]) => ({
        requestedReviewer: type === "Team" ? { __typename: "Team", combinedSlug: name } : { __typename: type, login: name },
      })),
    },
    latestReviews: { nodes: (over.reviews ?? []).map(([login, state, typename]) => review(login, state, typename)) },
    latestOpinionatedReviews: { nodes: (over.opinions ?? []).map(([login, state]) => ({ state, author: { login } })) },
    commits: {
      nodes: [{ commit: { statusCheckRollup: over.rollup === null ? null : {
        state: over.rollup ?? "SUCCESS",
        contexts: { totalCount: (over.checks ?? [run("build")]).length, nodes: over.checks ?? [run("build")] },
      } } }],
    },
  };
}

export const run = (name: string, conclusion: string | null = "SUCCESS", status = "COMPLETED") =>
  ({ __typename: "CheckRun", name, status, conclusion, detailsUrl: `https://ci.example/${name}` });
export const ctxStatus = (context: string, state: string) => ({ __typename: "StatusContext", context, state, targetUrl: null });

/** A transport that answers each batched GraphQL query from `nodes` (by PR number). */
export function fakeGithub(nodes: Record<number, any> = {}) {
  const queries: number[][] = [];
  const paceCalls: number[] = [];
  const state = {
    nodes,
    blocked: null as string | null,
    notified: null as Notified | null,
    pace: (base: number) => base,
    fail: null as Error | null,
  };
  const gh: Github = {
    async request(_method, _path, body: any) {
      const query: string = body.query;
      const data: Record<string, any> = {};
      const asked: number[] = [];
      for (const m of query.matchAll(/(r\d+):repository\(owner:"[^"]+",name:"[^"]+"\)\{((?: pr\d+:pullRequest\(number:\d+\)\{\.\.\.pull\})*)\}/g)) {
        data[m[1]] = {};
        for (const pr of m[2].matchAll(/(pr\d+):pullRequest\(number:(\d+)\)/g)) {
          const n = Number(pr[2]);
          asked.push(n);
          data[m[1]][pr[1]] = state.nodes[n] ?? null;
        }
      }
      queries.push(asked);
      if (state.fail) throw state.fail;
      return { data };
    },
    requestFor: async () => { throw new Error("not used"); },
    diff: async () => "",
    host: () => "github.com",
    account: async () => "github.com:me",
    blocked: async () => state.blocked,
    pace: async (base) => {
      paceCalls.push(base);
      return state.pace(base);
    },
    notified: async () => state.notified,
    memo: () => null,
  };
  return { gh, state, queries, paceCalls };
}

export { Notified };
