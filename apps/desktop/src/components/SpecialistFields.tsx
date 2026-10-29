import type { Specialist, SpecialistInput } from "../gen";

/** A new specialist's empty form. */
export const blankSpecialist = (): SpecialistInput => ({ id: "", name: "", role: "", description: "", instructions: "", agent: null, model: null, effort: null, scope: "global", project: null });

/** The editable part of a specialist. */
export const specialistInput = (s: Specialist): SpecialistInput => ({
  id: s.id,
  name: s.name,
  role: s.role,
  description: s.description,
  instructions: s.instructions,
  agent: s.agent,
  model: s.model,
  effort: s.effort,
  scope: s.scope,
  project: s.project,
});

/** `UX designer` -> `ux-designer`, as the daemon makes ids. */
export const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");

/**
 * The fields of a specialist: who it is, its instructions and the agent,
 * model and effort it prefers. `idLocked` once it exists: the id is how
 * feature owners hire it.
 */
export function SpecialistFields({ value, onChange, idLocked, autofocus }: { value: SpecialistInput; onChange: (v: SpecialistInput) => void; idLocked?: boolean; autofocus?: boolean }) {
  const set = <K extends keyof SpecialistInput>(k: K, v: SpecialistInput[K]) => onChange({ ...value, [k]: v });
  const opt = (v: string) => (v.trim() ? v : null);
  return (
    <div className="specialist-fields">
      <div className="two-col">
        <div className="field">
          <label htmlFor="specialist-name">Name</label>
          <input id="specialist-name" type="text" data-autofocus={autofocus || undefined} value={value.name} placeholder="Data engineer" onChange={(e) => set("name", e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="specialist-id">Id {idLocked && <span className="dim">· feature owners hire it by this</span>}</label>
          <input id="specialist-id" type="text" className="mono" value={value.id} readOnly={idLocked} placeholder={slugOf(value.name) || "data-engineer"} spellCheck={false} onChange={(e) => set("id", e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="specialist-role">Role</label>
        <input id="specialist-role" type="text" value={value.role} placeholder="Builds data pipelines" onChange={(e) => set("role", e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="specialist-description">What it is good at</label>
        <input id="specialist-description" type="text" value={value.description} placeholder="For the feature owner choosing whom to hire" onChange={(e) => set("description", e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="specialist-instructions">Instructions (markdown, added to the system prompt of every worker hired as it)</label>
        <textarea id="specialist-instructions" className="prompt-input" rows={12} value={value.instructions} placeholder={"Its role, the standards it works to, what it delivers and how it reports."} onChange={(e) => set("instructions", e.target.value)} />
      </div>
      <div className="three-col">
        <div className="field">
          <label htmlFor="specialist-agent">Preferred agent</label>
          <input id="specialist-agent" type="text" className="mono" value={value.agent ?? ""} placeholder="the owner's" spellCheck={false} onChange={(e) => set("agent", opt(e.target.value))} />
        </div>
        <div className="field">
          <label htmlFor="specialist-model">Model</label>
          <input id="specialist-model" type="text" className="mono" value={value.model ?? ""} placeholder="default" spellCheck={false} onChange={(e) => set("model", opt(e.target.value))} />
        </div>
        <div className="field">
          <label htmlFor="specialist-effort">Effort</label>
          <input id="specialist-effort" type="text" className="mono" value={value.effort ?? ""} placeholder="default" spellCheck={false} onChange={(e) => set("effort", opt(e.target.value))} />
        </div>
      </div>
    </div>
  );
}
