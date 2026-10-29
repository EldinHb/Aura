import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import type { Autonomy, Feature, Meeting, OneOnOne, Session } from "../gen";
import { useStore } from "../state/store";
import { useFeature } from "../state/features";
import { useWorkerThreads } from "../state/workerThreads";
import { statusClass } from "../lib/sessionStatus";
import { exactTime, timeAgo } from "../lib/time";
import { ATTENDEE_LABEL, STATUS_LABEL, describeAutonomy, isLive, liveRounds, meetingState, oneOnOneLabel, teamWork } from "../lib/features";
import { MeetingModePicker } from "../components/MeetingModePicker";
import { Markdown } from "./transcript/MarkdownView";
import { ReportBody } from "./transcript/FeatureCards";
import { agentLine } from "./WorkerThreads";

function When({ at }: { at: string | null | undefined }) {
  if (!at) return null;
  return <span className="dim" title={exactTime(at)}>{timeAgo(at)}</span>;
}

/** "working", "idle", "waiting on you", as a member's session is now. */
function memberStatus(s: Session | undefined): string {
  if (!s) return "deleted";
  if (s.archived) return "archived";
  if (s.status === "running") return "working";
  if (s.status === "waiting_approval" || s.status === "waiting_input") return "waiting on you";
  return s.status === "error" ? "failed" : s.status;
}

/**
 * A feature owner's team at work, opened only when the user picks the Team
 * tab: the feature, its members, their meetings and one-on-ones, the
 * decisions and the delivery report. Everything is read from the feature
 * record, so it costs the agents nothing.
 */
export function TeamView({ ownerId }: { ownerId: string }) {
  const feature = useFeature(ownerId);
  const owner = useStore((st) => st.sessions[ownerId]);
  const client = useStore((st) => st.client);
  const focusMeeting = useWorkerThreads((s) => s.views[ownerId]?.meeting);
  const [global, setGlobal] = useState<Autonomy | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    client?.autonomy().then(setGlobal, () => {});
  }, [client]);

  // Opened from a meeting's card: show that meeting.
  useEffect(() => {
    if (!focusMeeting) return;
    bodyRef.current?.querySelector(`[data-meeting="${focusMeeting}"]`)?.scrollIntoView({ block: "start" });
  }, [focusMeeting, feature?.meetings?.length]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = bodyRef.current;
    if (!el || e.metaKey || e.ctrlKey || e.altKey || e.target !== el) return;
    const by = e.key === "j" ? 60 : e.key === "k" ? -60 : e.key === "d" ? el.clientHeight / 2 : e.key === "u" ? -el.clientHeight / 2 : 0;
    if (by) {
      e.preventDefault();
      el.scrollBy({ top: by });
    } else if (e.key === "G") el.scrollTop = el.scrollHeight;
    else if (e.key === "g") el.scrollTop = 0;
  };

  if (!feature) {
    return (
      <div className="team-view">
        <div className="team-body">
          <div className="dim transcript-loading">Loading the feature…</div>
        </div>
      </div>
    );
  }
  const autonomy = feature.autonomy ?? global;
  const { meetings, oneOnOnes } = teamWork(feature);
  return (
    <div className="team-view">
      <div className="team-body" ref={bodyRef} tabIndex={0} onKeyDown={onKeyDown} aria-label="Team">
        <section className="team-section team-feature">
          <div className="team-feature-head">
            <span className="name">{owner?.title ?? "Feature"}</span>
            <span className="chip">{STATUS_LABEL[feature.status]}</span>
            <span className="dim">autonomy: {autonomy ? describeAutonomy(autonomy) : "…"}{!feature.autonomy && " (setting)"}</span>
            <span className="spacer" />
            <label className="dim team-meeting-mode">
              meetings <MeetingModePicker ownerId={ownerId} feature={feature} />
            </label>
          </div>
          <div className="team-goal">{feature.goal || <span className="dim">No goal given yet; the owner asks for one.</span>}</div>
        </section>
        <Members ownerId={ownerId} feature={feature} />
        <Meetings ownerId={ownerId} meetings={meetings} feature={feature} focus={focusMeeting} cwd={owner?.cwd} />
        <OneOnOnes list={oneOnOnes} cwd={owner?.cwd} />
        <Decisions feature={feature} />
        {feature.report && (
          <section className="team-section">
            <h4 className="section-head">Delivery report <When at={feature.report.delivered_at} /></h4>
            <div className="card feature-card report team-report">
              <ReportBody report={feature.report} cwd={owner?.cwd} />
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function Members({ ownerId, feature }: { ownerId: string; feature: Feature }) {
  const sessions = useStore((st) => st.sessions);
  const providers = useStore((st) => st.providers);
  const select = useStore((st) => st.select);
  return (
    <section className="team-section">
      <h4 className="section-head">Members <span className="dim">{feature.team.length}</span></h4>
      {feature.team.length === 0 && <div className="list-empty">Nobody yet. The owner hires specialists as it plans the work.</div>}
      <div className="team-members" role="list">
        {feature.team.map((m) => {
          const s = sessions[m.worker_id];
          return (
            <div key={m.worker_id} className={clsx("team-member", !s && "gone")} role="listitem">
              <span className={clsx("dot", s && statusClass(s))} />
              <span className="grow">
                <span className="team-member-name">{s?.title ?? m.name}</span>
                <span className="dim">
                  {m.specialist_id ? (m.name !== (s?.title ?? m.name) ? `${m.name} · ` : "") : "ad-hoc · "}
                  {m.role && `${m.role} · `}
                  {s ? agentLine(s, providers) : "session deleted"}
                </span>
              </span>
              {m.meeting && <span className="chip">guest of {m.meeting}</span>}
              <span className="dim">{memberStatus(s)}</span>
              {s && s.orchestrator_id === ownerId && (
                <button type="button" className="btn small" data-hint data-command="orchestrator.open-worker" onClick={() => select(s.id)}>
                  Open ↗
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Meetings({ ownerId, meetings, feature, focus, cwd }: { ownerId: string; meetings: Meeting[]; feature: Feature; focus?: string; cwd?: string }) {
  const latest = meetings.at(-1)?.id;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (meetings.length === 0) return null;
  return (
    <section className="team-section">
      <h4 className="section-head">Meetings <span className="dim">{meetings.length}</span></h4>
      {[...meetings].reverse().map((m) => {
        const shown = open[m.id] ?? (m.id === focus || (!focus && m.id === latest));
        const outcome = feature.decisions.filter((d) => d.meeting_id === m.id || m.decision_ids.includes(d.id));
        return (
          <div key={`${ownerId}:${m.id}`} className={clsx("team-entry meeting", m.status)} data-meeting={m.id}>
            <button type="button" className="team-entry-head" data-hint aria-expanded={shown} onClick={() => setOpen((o) => ({ ...o, [m.id]: !shown }))}>
              <span className={clsx("dot", m.status === "collecting" ? "info pulse" : m.status === "waiting_on_chair" ? "info" : m.status === "complete" ? "ok" : "warn")} />
              <span className="name">{m.topic}</span>
              {isLive(m) && <span className="chip accent">live</span>}
              <span className="dim">{meetingState(m)} · {m.attendees.map((a) => a.name).join(", ")}</span>
              <span className="spacer" />
              <When at={m.started_at} />
              <span className="dim">{shown ? "▾" : "▸"}</span>
            </button>
            {shown && (
              <div className="team-entry-body">
                <div className="team-label">Question</div>
                <Markdown text={m.agenda} cwd={cwd} />
                {m.context && (
                  <details className="team-context">
                    <summary>Context</summary>
                    <Markdown text={m.context} cwd={cwd} />
                  </details>
                )}
                {isLive(m) ? <LiveThread m={m} cwd={cwd} /> : m.attendees.map((a, i) => (
                  <div key={`${a.worker_id}:${i}`} className={clsx("team-contribution", a.status)}>
                    <div className="thread-head">
                      <span className="name">{a.name}</span>
                      {a.role && <span className="dim">{a.role}</span>}
                      {a.guest && <span className="chip">guest</span>}
                      <span className="spacer" />
                      <span className="dim">{ATTENDEE_LABEL[a.status]}</span>
                      <When at={a.answered_at} />
                    </div>
                    {a.answer ? <Markdown text={a.answer} cwd={cwd} /> : a.missing ? <div className="dim">{a.missing}</div> : null}
                  </div>
                ))}
                <div className="team-label">Outcome</div>
                {m.outcome && <Markdown text={m.outcome} cwd={cwd} />}
                {outcome.length > 0 ? (
                  <ul className="team-outcome">
                    {outcome.map((d) => (
                      <li key={d.id}>
                        {d.decision}
                        {d.rationale && <span className="dim"> — {d.rationale}</span>}
                      </li>
                    ))}
                  </ul>
                ) : m.outcome ? null : (
                  <div className="dim">{m.status === "collecting" ? (isLive(m) ? "The round is under way." : "Waiting for the answers.") : m.status === "waiting_on_chair" ? "The owner reads the round, then continues or closes the meeting." : "No decision recorded from it yet."}</div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

/** What a turn in a live meeting is now, in a word or two. */
const TURN_LABEL: Record<Meeting["attendees"][number]["status"], string> = {
  invited: "next, once free",
  asked: "speaking",
  answered: "",
  missing: "no turn",
  late: "spoke late",
};

/** A live meeting as the thread it is: round by round, the owner's steer, then each attendee in turn. */
function LiveThread({ m, cwd }: { m: Meeting; cwd?: string }) {
  const rounds = liveRounds(m);
  return (
    <div className="live-thread" aria-label={`Thread of ${m.topic}`}>
      {rounds.map((r) => (
        <div key={r.round} className="live-round">
          <div className="team-label">
            Round {r.round} of {m.max_rounds}
          </div>
          {r.steer && (
            <div className="team-contribution chair">
              <div className="thread-head">
                <span className="name">{r.steer.name}</span>
                <span className="chip">chair</span>
                <span className="spacer" />
                <When at={r.steer.at} />
              </div>
              {r.steer.text && <Markdown text={r.steer.text} cwd={cwd} />}
            </div>
          )}
          {r.turns.map((t) => (
            <div key={`${t.round}:${t.worker_id}`} className={clsx("team-contribution", t.status)}>
              <div className="thread-head">
                <span className="name">{t.name}</span>
                {t.role && <span className="dim">{t.role}</span>}
                <span className="spacer" />
                {TURN_LABEL[t.status] && <span className="dim">{TURN_LABEL[t.status]}</span>}
                <When at={t.at} />
              </div>
              {t.text ? <Markdown text={t.text} cwd={cwd} /> : t.missing ? <div className="dim">{t.missing}</div> : null}
            </div>
          ))}
        </div>
      ))}
      {rounds.length === 0 && <div className="dim">Nobody has spoken yet.</div>}
    </div>
  );
}

function OneOnOnes({ list, cwd }: { list: OneOnOne[]; cwd?: string }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (list.length === 0) return null;
  return (
    <section className="team-section">
      <h4 className="section-head">One-on-ones <span className="dim">{list.length}</span></h4>
      {[...list].reverse().map((a) => {
        const shown = open[a.id] ?? a.status === "open";
        return (
          <div key={a.id} className={clsx("team-entry one-on-one", a.status)}>
            <button type="button" className="team-entry-head" data-hint aria-expanded={shown} onClick={() => setOpen((o) => ({ ...o, [a.id]: !shown }))}>
              <span className={clsx("dot", a.status === "open" ? "info pulse" : a.status === "answered" ? "ok" : "warn")} />
              <span className="name">{oneOnOneLabel(a)}</span>
              <span className="dim team-question-line">{a.question}</span>
              <span className="spacer" />
              <span className="dim">{a.status === "open" ? "waiting" : a.status}</span>
              <When at={a.asked_at} />
              <span className="dim">{shown ? "▾" : "▸"}</span>
            </button>
            {shown && (
              <div className="team-entry-body">
                <div className="team-label">Question</div>
                <Markdown text={a.question} cwd={cwd} />
                {a.answer && (
                  <>
                    <div className="team-label">Answer</div>
                    <Markdown text={a.answer} cwd={cwd} />
                  </>
                )}
                {a.error && <div className="dim">No answer: {a.error}</div>}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

function Decisions({ feature }: { feature: Feature }) {
  return (
    <section className="team-section">
      <h4 className="section-head">Decisions <span className="dim">{feature.decisions.length}</span></h4>
      {feature.decisions.length === 0 ? (
        <div className="list-empty">None recorded yet.</div>
      ) : (
        <ol className="team-decisions">
          {[...feature.decisions].reverse().map((d) => (
            <li key={d.id}>
              <span className="grow">
                <span>{d.decision}</span>
                {d.rationale && <span className="dim"> — {d.rationale}</span>}
              </span>
              {d.meeting_id && <span className="chip">from {d.meeting_id}</span>}
              <span className="chip">{d.decided_by === "user" ? "you" : "owner"}</span>
              <When at={d.at} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
