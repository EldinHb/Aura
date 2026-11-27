/**
 * The orchestration forest of a sessions snapshot: who works under whom,
 * each session's leader and scheduled task, and each leader's roll-up.
 * Built once per `sessions` object (the store replaces it on every change)
 * and kept in a WeakMap, so selectors share it and nothing else (a
 * transcript growing, say) rebuilds it.
 *
 * The structure is the `orchestrator_id` chain, with two repairs: a session
 * whose orchestrator is gone is a root, and a cycle (A under B under A) is
 * broken at its oldest session, which becomes a root. Archived sessions stay
 * in the structure; showing or counting them is the caller's choice.
 */
import type { Session } from "../gen";

export type SessionCategory = "waiting" | "working" | "idle";

export type Forest = {
  /** The orchestrator a session works under, after the repairs; null for a root (a leader). */
  parentOf: (id: string) => Session | null;
  /** Direct workers, archived ones included, oldest first. */
  childrenOf: (id: string) => Session[];
  /** Every session under `id`, archived ones included, depth first, oldest first at each level. */
  descendantsOf: (id: string) => Session[];
  /** `descendantsOf` without archived sessions. A live worker under an archived one is kept. */
  liveDescendantsOf: (id: string) => Session[];
  leaderOf: (s: Session) => Session;
  /** The scheduled task `s` is a run of, or a worker of a run of: its own provenance (`scheduled_task_id`, `scheduled_run`) first, then its ancestors'. */
  scheduledTaskOf: (s: Session) => string | null;
  /** The state a leader's row is sectioned by (see `rollupOf` in the store). */
  rollupOf: (leader: Session) => SessionCategory;
};

const forests = new WeakMap<Record<string, Session>, Forest>();

export function categoryOf(s: Pick<Session, "status" | "attention" | "pending_count">): SessionCategory {
  if (s.pending_count > 0 || s.status === "waiting_approval" || s.status === "waiting_input" || s.attention) return "waiting";
  if (s.status === "running") return "working";
  return "idle";
}

/** Whether `s` waits on the user: a question or approval is open, or it says it waits. Finished or failed is not waiting. */
export function waitsOnUser(s: Pick<Session, "status" | "attention" | "pending_count">): boolean {
  return s.pending_count > 0 || s.status === "waiting_approval" || s.status === "waiting_input" || s.attention === "waiting";
}

/** Oldest first; a session without a creation time (an old daemon, a fixture) sorts by id. */
const older = (a: Session, b: Session) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id);

/** The forest of `sessions`, built on first use and shared until `sessions` is replaced. */
export function forestOf(sessions: Record<string, Session>): Forest {
  const cached = forests.get(sessions);
  if (cached) return cached;
  const list = Object.values(sessions);
  const raw = (s: Session): Session | undefined => (s.orchestrator_id && s.orchestrator_id !== s.id ? sessions[s.orchestrator_id] : undefined);

  // Find the cycles and cut each at its oldest session.
  const cut = new Set<string>();
  const state = new Map<string, 1 | 2>();
  for (const s of list) {
    const path: Session[] = [];
    let cur: Session | undefined = s;
    while (cur && !state.has(cur.id)) {
      state.set(cur.id, 1);
      path.push(cur);
      cur = raw(cur);
    }
    if (cur && state.get(cur.id) === 1) cut.add([...path.slice(path.indexOf(cur))].sort(older)[0].id);
    for (const p of path) state.set(p.id, 2);
  }
  const parent = new Map<string, Session | null>();
  const children = new Map<string, Session[]>();
  for (const s of list) {
    const p = cut.has(s.id) ? null : raw(s) ?? null;
    parent.set(s.id, p);
    if (p) {
      if (!children.has(p.id)) children.set(p.id, []);
      children.get(p.id)!.push(s);
    }
  }
  for (const c of children.values()) c.sort(older);

  const leaders = new Map<string, Session>();
  const leaderOf = (s: Session): Session => {
    const known = leaders.get(s.id);
    if (known) return known;
    const p = parent.get(s.id);
    const l = p ? leaderOf(p) : s;
    leaders.set(s.id, l);
    return l;
  };
  const tasks = new Map<string, string | null>();
  const scheduledTaskOf = (s: Session): string | null => {
    if (tasks.has(s.id)) return tasks.get(s.id)!;
    const p = parent.get(s.id);
    // The run's top session has scheduled_task_id; it and every worker under it carry
    // scheduled_run, also once the run's orchestrator is gone. A daemon from before
    // scheduled_run leaves the orchestrator chain to go by.
    const t = s.scheduled_task_id ?? s.scheduled_run ?? (p ? scheduledTaskOf(p) : null);
    tasks.set(s.id, t);
    return t;
  };
  const descendants = new Map<string, Session[]>();
  const descendantsOf = (id: string): Session[] => {
    const known = descendants.get(id);
    if (known) return known;
    const out: Session[] = [];
    const walk = (pid: string) => {
      for (const c of children.get(pid) ?? []) {
        out.push(c);
        walk(c.id);
      }
    };
    walk(id);
    descendants.set(id, out);
    return out;
  };
  const live = new Map<string, Session[]>();
  const liveDescendantsOf = (id: string): Session[] => {
    const known = live.get(id);
    if (known) return known;
    const out = descendantsOf(id).filter((w) => !w.archived);
    live.set(id, out);
    return out;
  };
  const rollups = new Map<string, SessionCategory>();
  const rollupOf = (leader: Session): SessionCategory => {
    const known = rollups.get(leader.id);
    if (known) return known;
    const tree = liveDescendantsOf(leader.id);
    const r: SessionCategory = categoryOf(leader) === "waiting" || tree.some(waitsOnUser) ? "waiting"
      : leader.status === "running" || tree.some((w) => w.status === "running") ? "working" : "idle";
    rollups.set(leader.id, r);
    return r;
  };
  const forest: Forest = {
    parentOf: (id) => parent.get(id) ?? null,
    childrenOf: (id) => children.get(id) ?? [],
    descendantsOf,
    liveDescendantsOf,
    leaderOf,
    scheduledTaskOf,
    rollupOf,
  };
  forests.set(sessions, forest);
  return forest;
}
