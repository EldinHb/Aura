import { useEffect, useState } from "react";
import type { Autonomy, Session } from "../gen";
import { useStore } from "../state/store";
import { useFeature } from "../state/features";
import { STATUS_LABEL, describeAutonomy, openQuestions } from "../lib/features";
import { AutonomyPicker } from "../components/AutonomyPicker";
import { MeetingModePicker } from "../components/MeetingModePicker";
import { openTeam } from "../state/workerThreads";

/** "none yet", "3 members, 2 specialists" */
function teamLabel(members: number, specialists: number): string {
  if (members === 0) return "none yet";
  const people = members === 1 ? "1 member" : `${members} members`;
  if (specialists === 0) return people;
  return `${people}, ${specialists === 1 ? "1 specialist" : `${specialists} specialists`}`;
}

/** A feature owner's feature: goal, status, autonomy, and its decisions so far. */
export function FeatureSection({ s }: { s: Session }) {
  const feature = useFeature(s.id);
  const client = useStore((st) => st.client);
  const toast = useStore((st) => st.toast);
  const [global, setGlobal] = useState<Autonomy | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    client?.autonomy().then(setGlobal, () => {});
  }, [client, feature?.autonomy]);
  if (!feature) return null;
  const setAutonomy = async (a: Autonomy | null) => {
    if (!client) return;
    try {
      await client.setFeatureAutonomy(s.id, a);
      toast(a ? "This feature has its own autonomy now" : "This feature follows the autonomy setting again");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };
  const open = openQuestions(feature);
  const effective = feature.autonomy ?? global;
  return (
    <div className="inspector-section feature-section">
      <h4 className="section-head">
        Feature
        <span className="chip">{STATUS_LABEL[feature.status]}</span>
      </h4>
      <div className="feature-goal">{feature.goal || <span className="dim">No goal given yet; the owner asks for one.</span>}</div>
      <div className="kv">
        <span className="k">autonomy</span>
        <span className="v">
          {effective ? describeAutonomy(effective) : "…"}
          {!feature.autonomy && <span className="dim"> (setting)</span>}{" "}
          <button type="button" className="linkish" data-hint onClick={() => setEditing(!editing)}>
            {editing ? "done" : "change"}
          </button>
        </span>
        <span className="k">meetings</span>
        <span className="v">
          <MeetingModePicker ownerId={s.id} feature={feature} />
        </span>
        <span className="k">team</span>
        <span className="v">
          {teamLabel(feature.team.length, feature.team.filter((m) => m.specialist_id).length)}{" "}
          <button type="button" className="linkish" data-hint data-command="orchestrator.team" onClick={() => openTeam(s.id)}>
            Team ↗
          </button>
        </span>
        <span className="k">decisions</span>
        <span className="v">{feature.decisions.length}</span>
        {open.length > 0 && (
          <>
            <span className="k">waiting on you</span>
            <span className="v">{open.map((q) => q.question).join(" · ")}</span>
          </>
        )}
      </div>
      {editing && (
        <div className="feature-autonomy">
          <label className="check-row">
            <input type="checkbox" checked={!!feature.autonomy} onChange={(e) => void setAutonomy(e.target.checked ? (feature.autonomy ?? global) : null)} /> Own autonomy for this feature
          </label>
          {feature.autonomy && <AutonomyPicker name={`autonomy-${s.id}`} value={feature.autonomy} onChange={(a) => void setAutonomy(a)} />}
        </div>
      )}
      {feature.decisions.length > 0 && (
        <details className="feature-decisions">
          <summary>Decision log</summary>
          <ol>
            {feature.decisions.map((d) => (
              <li key={d.id}>
                <span>{d.decision}</span>
                {d.rationale && <span className="dim"> — {d.rationale}</span>}
                <span className="chip">{d.decided_by === "user" ? "you" : "owner"}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
