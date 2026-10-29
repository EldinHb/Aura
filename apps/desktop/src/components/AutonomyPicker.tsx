import type { Autonomy, AutonomyLevel } from "../gen";
import { CHECKPOINT_LABEL, CHECKPOINTS } from "../lib/features";

const LEVELS: { level: AutonomyLevel; label: string; help: string }[] = [
  { level: "autonomous", label: "Autonomous", help: "Decides everything itself and logs its decisions. Asks only before irreversible or outward-facing actions: merging, pushing, publishing, deleting, contacting people." },
  { level: "blocking_decisions", label: "Blocking decisions", help: "Decides what it can; asks you only when a decision is yours and the work cannot go on well without it." },
  { level: "checkpoints", label: "Checkpoints", help: "As blocking decisions, and stops for your review at the checkpoints you choose. Delivery is refused until you approve the delivery checkpoint." },
];

/** How much a feature owner decides on its own, with the checkpoints it stops at. */
export function AutonomyPicker({ value, onChange, name, autofocus }: { value: Autonomy; onChange: (a: Autonomy) => void; name: string; autofocus?: boolean }) {
  return (
    <div className="autonomy-picker" role="radiogroup" aria-label="Autonomy">
      {LEVELS.map((l, i) => (
        <label key={l.level} className="check-row autonomy-level">
          <input type="radio" name={name} data-autofocus={(autofocus && i === 0) || undefined} checked={value.level === l.level} onChange={() => onChange({ ...value, level: l.level })} />
          <span>
            <strong>{l.label}</strong> <span className="dim">{l.help}</span>
          </span>
        </label>
      ))}
      {value.level === "checkpoints" && (
        <div className="autonomy-checkpoints">
          {CHECKPOINTS.map((c) => (
            <label key={c} className="check-row">
              <input
                type="checkbox"
                checked={value.checkpoints.includes(c)}
                onChange={(e) => onChange({ ...value, checkpoints: e.target.checked ? CHECKPOINTS.filter((x) => x === c || value.checkpoints.includes(x)) : value.checkpoints.filter((x) => x !== c) })}
              />{" "}
              {CHECKPOINT_LABEL[c]}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
