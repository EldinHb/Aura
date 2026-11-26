import type { PullRequest } from "@aura/github-client";
import { relTime, setFocus, useStore } from "../host";
import { flattenPullSessions, usePullSessions, type PullSession, type Session } from "./sessions";

/** The tone of a session's status dot, as Aura's sidebar shows it. */
function statusClass(s: Session): string {
  switch (s.status) {
    case "running": return "info pulse";
    case "waiting_approval":
    case "waiting_input": return "warn pulse";
    case "error": return "err";
    case "exited": return "";
    default: return "ok";
  }
}

/** Open a session as its sidebar row does; archived ones are revealed in the sidebar first. */
function openSession(session: Session) {
  const store = useStore.getState();
  if (session.archived && !store.showArchived) store.setShowArchived(true);
  // Selecting a session closes the PR page in Aura's main area.
  store.select(session.id);
  setFocus("main");
}

function describe(entry: PullSession): string {
  const { session } = entry;
  return `${session.title}${session.archived ? " (archived)" : ""}\n${entry.direct ? "Worked on this PR" : "Its workers worked on this PR"}`;
}

function SessionRow({ entry, depth = 0 }: { entry: PullSession; depth?: number }) {
  const { session } = entry;
  return <>
    <button className={`pr-session-row ${depth ? "worker" : ""} ${session.archived ? "archived" : ""}`} data-hint data-session-id={session.id}
      style={depth ? { paddingLeft: 6 + 16 * depth } : undefined} title={describe(entry)} onClick={() => openSession(session)}>
      <span className={`dot ${statusClass(session)}`} />
      <span className="title">{session.title}</span>
      {session.archived && <span className="chip">archived</span>}
      {session.orchestrator && <span className="chip orchestrator">{session.feature_owner ? "owner" : "orch"}</span>}
      {!entry.direct && <span className="chip" title="Its workers worked on this PR">workers</span>}
      <span className="spacer" />
      <span className={`chip ${session.provider}`}>{session.agent ?? session.provider}</span>
      <span className="pr-muted">{session.status.replace(/_/g, " ")}</span>
      <span className="pr-muted" title={new Date(session.last_activity).toLocaleString()}>{relTime(session.last_activity)}</span>
    </button>
    {entry.workers.map((w) => <SessionRow key={w.session.id} entry={w} depth={depth + 1} />)}
  </>;
}

/** The sessions that worked on the PR, on its page. Nothing when there are none. */
export function PullSessions({ pull }: { pull: PullRequest }) {
  const entries = usePullSessions(pull);
  if (!entries.length) return null;
  return <section className="pr-sessions" aria-label="Sessions">
    <div className="pr-sessions-heading">Sessions <span className="badge">{flattenPullSessions(entries).length}</span></div>
    {entries.map((entry) => <SessionRow key={entry.session.id} entry={entry} />)}
  </section>;
}

/** How many sessions worked on the PR, for its row in the PR list. */
export function PullSessionCount({ pull }: { pull: PullRequest }) {
  const all = flattenPullSessions(usePullSessions(pull));
  const count = all.length;
  if (!count) return null;
  const titles = all.map((e) => `${e.session.title}${e.session.archived ? " (archived)" : ""}`);
  return <span className="chip pr-session-count" title={`Sessions on this PR:\n${titles.join("\n")}`}>{count} session{count === 1 ? "" : "s"}</span>;
}
