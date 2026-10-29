import { useEffect, useState } from "react";
import clsx from "clsx";
import type { DeliveryReport, Item, Meeting, Project, SpecialistInput, SpecialistSuggestion, UserQuestion } from "../../gen";
import { useStore } from "../../state/store";
import { useFeature, useRoleSuggestion } from "../../state/features";
import { CHECKPOINT_LABEL, attendeesLine, featureCard, isLive, meetingState, teamWork } from "../../lib/features";
import { openTeam } from "../../state/workerThreads";
import { SpecialistFields } from "../../components/SpecialistFields";
import { Markdown } from "./MarkdownView";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * A card a feature owner put in its chat: a decision for the user, its
 * delivery report, a specialist it proposes or Aura found in repeated work,
 * or a meeting. It shows the record as it is now, so an answered question
 * shows its answer.
 */
export function FeatureCard({ item, cursor, onCursor }: { item: Item; cursor: boolean; onCursor: (id: string) => void }) {
  const ref = featureCard(item);
  const feature = useFeature(item.session_id);
  const cwd = useStore((s) => s.sessions[item.session_id]?.cwd);
  if (!ref) return null;
  const frame = (body: React.ReactNode, kind: string) => (
    <div className={clsx("card feature-card", kind, cursor && "cursor")} data-item-id={item.id} data-hint onClick={() => onCursor(item.id)}>
      {body}
    </div>
  );
  if (ref.kind === "role_suggestion") return <RoleSuggestionCard item={item} id={ref.id} cursor={cursor} onCursor={onCursor} />;
  if (!feature) return frame(<div className="dim">{item.text || "Loading the feature…"}</div>, ref.kind);
  switch (ref.kind) {
    case "decision": {
      const q = feature.questions.find((x) => x.id === ref.id);
      return q ? frame(<DecisionBody ownerId={item.session_id} q={q} cwd={cwd} />, clsx("decision", !q.answer && !q.withdrawn && "open")) : frame(<div className="dim">{item.text}</div>, "decision");
    }
    case "report":
      return feature.report ? frame(<ReportBody report={feature.report} cwd={cwd} />, "report") : frame(<div className="dim">The report is gone.</div>, "report");
    case "suggestion": {
      const s = feature.suggestions.find((x) => x.id === ref.id);
      const resolve = (accept: boolean, specialist: SpecialistInput | null) => useStore.getState().client?.resolveSuggestion(item.session_id, s!.id, accept, specialist);
      return s ? frame(<SuggestionBody s={s} ownerId={item.session_id} ownerCwd={cwd} onResolve={resolve} />, "suggestion") : frame(<div className="dim">{item.text}</div>, "suggestion");
    }
    case "meeting": {
      const m = teamWork(feature).meetings.find((x) => x.id === ref.id);
      return m ? frame(<MeetingLine ownerId={item.session_id} m={m} />, "meeting") : frame(<div className="dim">{item.text}</div>, "meeting");
    }
  }
}

/** A specialist Aura found in the team's repeated ad-hoc work, kept with the user's other suggestions. */
function RoleSuggestionCard({ item, id, cursor, onCursor }: { item: Item; id: string; cursor: boolean; onCursor: (id: string) => void }) {
  const s = useRoleSuggestion(id);
  const cwd = useStore((st) => st.sessions[item.session_id]?.cwd);
  const resolve = (accept: boolean, specialist: SpecialistInput | null) => useStore.getState().client?.resolveRoleSuggestion(id, accept, specialist);
  return (
    <div className={clsx("card feature-card suggestion", cursor && "cursor")} data-item-id={item.id} data-hint onClick={() => onCursor(item.id)}>
      {s ? <SuggestionBody s={s} ownerId={item.session_id} ownerCwd={cwd} onResolve={resolve} /> : <div className="dim">{item.text}</div>}
    </div>
  );
}

/** One line for a meeting the owner held: what it is about and how far it got. The answers are in the Team tab. */
function MeetingLine({ ownerId, m }: { ownerId: string; m: Meeting }) {
  const open = m.status === "collecting" || m.status === "waiting_on_chair";
  const what = isLive(m) ? "Live meeting" : "Meeting";
  return (
    <div className="card-head meeting-line">
      <span className={clsx("dot", m.status === "collecting" ? "info pulse" : m.status === "waiting_on_chair" ? "info" : m.status === "complete" ? "ok" : "warn")} />
      <span>{open ? what : `${what} held`}: {m.topic}</span>
      <span className="dim">{m.status === "collecting" || isLive(m) ? meetingState(m) : attendeesLine(m)}</span>
      <span className="spacer" />
      <button type="button" className="btn small" data-command="orchestrator.team" onClick={(e) => { e.stopPropagation(); openTeam(ownerId, m.id); }}>
        Open in Team
      </button>
    </div>
  );
}

/** A question for the user: the options with the recommended one marked, and room for words of their own. */
export function DecisionBody({ ownerId, q, cwd }: { ownerId: string; q: UserQuestion; cwd?: string }) {
  const client = useStore((s) => s.client);
  const toast = useStore((s) => s.toast);
  const [picked, setPicked] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const open = !q.answer && !q.withdrawn;
  const ready = !!picked || !!text.trim();
  const answer = async () => {
    if (!client || !ready || busy) return;
    setBusy(true);
    try {
      await client.answerQuestion(ownerId, q.id, picked, text);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const head = q.kind === "checkpoint" ? `Checkpoint review${q.checkpoint ? ` · ${CHECKPOINT_LABEL[q.checkpoint].toLowerCase()}` : ""}` : q.kind === "irreversible" ? "Needs your yes" : "Decision for you";
  return (
    <>
      <div className="card-head">
        <span className={clsx("dot", open ? "info pulse" : "ok")} />
        <span>{head}</span>
        <span className="spacer" />
        <span className="dim">{open ? "from the feature owner" : q.withdrawn ? "withdrawn" : "answered"}</span>
      </div>
      <div className="feature-question">{q.question}</div>
      {q.context && (
        <div className="card-desc">
          <Markdown text={q.context} cwd={cwd} />
        </div>
      )}
      {open ? (
        <>
          {q.options.length > 0 && (
            <div className="options" role="radiogroup" aria-label={q.question}>
              {q.options.map((o) => (
                <button key={o.label} type="button" role="radio" aria-checked={picked === o.label} className={clsx("option", picked === o.label && "picked")} data-hint onClick={(e) => { e.stopPropagation(); setPicked(picked === o.label ? null : o.label); }}>
                  <span className="option-box">{picked === o.label ? "◉" : "○"}</span>
                  <span className="option-label">{o.label}</span>
                  {q.recommended === o.label && <span className="chip recommended">recommended</span>}
                  {o.description && <span className="dim option-desc">{o.description}</span>}
                </button>
              ))}
            </div>
          )}
          <input
            type="text"
            className="other-input"
            aria-label="Your answer"
            value={text}
            placeholder={q.kind === "checkpoint" ? "Say what to change (only Approve, or a plain “approve”, lets the work go on)" : q.options.length ? "Add a note, or answer in your own words" : "Your answer"}
            onClick={(e) => e.stopPropagation()}
            data-hint
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                void answer();
              }
            }}
          />
          <div className="actions">
            <button type="button" className="btn small primary" data-command="feature.answer" disabled={!ready || busy} onClick={(e) => { e.stopPropagation(); void answer(); }}>
              {busy ? "Sending…" : "Answer"} <kbd>↩</kbd>
            </button>
          </div>
        </>
      ) : q.answer ? (
        <div className="feature-answer">
          <span className="dim">You answered:</span> {q.answer.option && <strong>{q.answer.option}</strong>}
          {q.answer.option && q.answer.text ? " · " : ""}
          {q.answer.text}
        </div>
      ) : (
        <div className="dim">Withdrawn without an answer when the feature was delivered.</div>
      )}
    </>
  );
}

/** What the user gets when the feature is done: what, why, how and where to test. */
export function ReportBody({ report, cwd }: { report: DeliveryReport; cwd?: string }) {
  const parts: [string, string][] = [
    ["What was done", report.what],
    ["Why", report.why],
    ["How to test", report.how_to_test],
    ["Where to test", report.where_to_test],
    ["Notes", report.notes],
  ];
  return (
    <>
      <div className="card-head">
        <span className="dot ok" />
        <span>Feature delivered</span>
        <span className="spacer" />
        <span className="dim">{new Date(report.delivered_at).toLocaleString()}</span>
      </div>
      {parts
        .filter(([, text]) => text.trim())
        .map(([label, text]) => (
          <div key={label} className="report-part">
            <div className="report-label">{label}</div>
            <Markdown text={text} cwd={cwd} />
          </div>
        ))}
    </>
  );
}

/** The project of the folder `cwd` among the known ones: the longest root it lies in. */
function projectOf(cwd: string | undefined, projects: Project[]): string | null {
  if (!cwd) return null;
  const match = projects.filter((p) => cwd === p.path || cwd.startsWith(`${p.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
  return match?.path ?? null;
}

/**
 * A specialist the owner proposes, or Aura found in repeated ad-hoc work:
 * accept it for everyone or one project, edit it first, or dismiss it. One
 * Aura found says which briefs it found the role in, and starts on the
 * scope they suggest.
 */
export function SuggestionBody({ s, ownerId, ownerCwd, onResolve }: { s: SpecialistSuggestion; ownerId?: string; ownerCwd?: string; onResolve: (accept: boolean, specialist: SpecialistInput | null) => Promise<unknown> | undefined }) {
  const client = useStore((st) => st.client);
  const toast = useStore((st) => st.toast);
  const folderless = useStore((st) => (ownerId ? !!st.sessions[ownerId]?.folderless : true));
  const found = (s.evidence ?? []).length > 0;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<SpecialistInput>(s.specialist);
  const [projects, setProjects] = useState<Project[]>([]);
  const [scope, setScope] = useState<string>("global");
  const [busy, setBusy] = useState(false);
  const pending = s.status === "pending";
  useEffect(() => {
    if (!pending || !client) return;
    let cancelled = false;
    client.projects().then(
      (ps) => {
        if (cancelled) return;
        setProjects(ps);
        // Found in one project's work, it is suggested for that project;
        // otherwise the owner's own project is the likely home of what it needs.
        const own = found ? (s.specialist.scope === "project" ? s.specialist.project : null) : folderless ? null : projectOf(ownerCwd, ps);
        if (own) setScope(own);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [client, pending, ownerCwd, folderless, found, s.specialist.scope, s.specialist.project]);
  const resolve = async (accept: boolean) => {
    if (!client || busy) return;
    setBusy(true);
    try {
      const specialist: SpecialistInput | null = accept ? { ...(editing ? draft : s.specialist), scope: scope === "global" ? "global" : "project", project: scope === "global" ? null : scope } : null;
      await onResolve(accept, specialist);
      toast(accept ? `Specialist “${(specialist ?? s.specialist).name}” added` : "Suggestion dismissed");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const sp = editing ? draft : s.specialist;
  return (
    <>
      <div className="card-head">
        <span className={clsx("dot", pending ? "info" : s.status === "accepted" ? "ok" : "")} />
        <span>{found ? "Specialist suggested from repeated work" : "New specialist proposed"}: {sp.name}</span>
        <span className="spacer" />
        <span className="dim">{pending ? (found ? "found by Aura" : "from the feature owner") : s.status === "accepted" ? `accepted as ${s.accepted_id ?? sp.id}` : "dismissed"}</span>
      </div>
      {sp.role && <div className="feature-question">{sp.role}</div>}
      {sp.description && <div className="card-desc">{sp.description}</div>}
      {s.reason && (
        <div className="card-desc">
          <span className="dim">Why:</span> {s.reason}
        </div>
      )}
      {found && (
        <details className="suggestion-evidence" onClick={(e) => e.stopPropagation()} data-hint>
          <summary>Seen in {s.evidence.length} ad-hoc briefs</summary>
          <ul>
            {s.evidence.map((e) => (
              <li key={`${e.owner_id}:${e.worker_id}`}>
                {e.summary}
                <span className="dim">
                  {" "}
                  · {e.feature || "a feature"}
                  {e.project && ` · ${e.project}`}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {editing ? (
        <div className="card-edit" onClick={(e) => e.stopPropagation()} data-hint>
          <SpecialistFields value={draft} onChange={setDraft} autofocus />
        </div>
      ) : (
        <details className="suggestion-instructions" onClick={(e) => e.stopPropagation()} data-hint>
          <summary>Instructions</summary>
          <Markdown text={sp.instructions} />
        </details>
      )}
      {pending && (
        <div className="actions">
          <select aria-label="Where the specialist applies" value={scope} onClick={(e) => e.stopPropagation()} data-hint onChange={(e) => setScope(e.target.value)}>
            <option value="global">For every project</option>
            {projects
              .filter((p) => p.repo || p.path === scope)
              .map((p) => (
                <option key={p.path} value={p.path}>
                  Only for {p.path}
                </option>
              ))}
          </select>
          <button type="button" className="btn small primary" data-command="feature.accept-suggestion" disabled={busy} onClick={(e) => { e.stopPropagation(); void resolve(true); }}>
            Accept
          </button>
          <button type="button" className="btn small" data-command="feature.edit-suggestion" disabled={busy} onClick={(e) => { e.stopPropagation(); setDraft(s.specialist); setEditing(!editing); }}>
            {editing ? "Undo edits" : "Edit"}
          </button>
          <button type="button" className="btn small" data-command="feature.dismiss-suggestion" disabled={busy} onClick={(e) => { e.stopPropagation(); void resolve(false); }}>
            Dismiss
          </button>
        </div>
      )}
    </>
  );
}
