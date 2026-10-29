import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import type { Project, Specialist, SpecialistInput } from "../../gen";
import { useStore } from "../../state/store";
import { SpecialistFields, blankSpecialist, slugOf, specialistInput } from "../SpecialistFields";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Whether two forms say the same. */
const same = (a: SpecialistInput, b: SpecialistInput) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The specialists feature owners hire, globally or for one project. In a
 * project, its own specialists replace the global ones with the same id;
 * saving a global one there makes such a copy.
 */
export function SpecialistsTab() {
  const client = useStore((s) => s.client);
  const toast = useStore((s) => s.toast);
  const [scope, setScope] = useState<"global" | "project">("global");
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState("");
  const [list, setList] = useState<Specialist[] | null>(null);
  const [hidden, setHidden] = useState<Specialist[]>([]);
  const [error, setError] = useState<string | null>(null);
  // The specialist open in the editor, by id; "" for a new one.
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<SpecialistInput | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const where = scope === "project" ? project || null : null;

  useEffect(() => {
    client?.projects().then(
      (ps) => {
        setProjects(ps);
        setProject((p) => p || ps.find((x) => x.repo)?.path || ps[0]?.path || "");
      },
      () => setProjects([]),
    );
  }, [client]);

  const reload = useCallback(async () => {
    if (!client) return;
    if (scope === "project" && !project) {
      setList([]);
      return;
    }
    try {
      const [all, gone] = await Promise.all([client.specialists(where), scope === "global" ? client.hiddenSpecialists() : Promise.resolve([])]);
      setList(all);
      setHidden(gone);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [client, scope, project, where]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const current = useMemo(() => (open ? list?.find((s) => s.id === open) : undefined), [list, open]);
  // The form as it is saved: in a project, a global specialist saved there becomes the project's own copy.
  const base = useMemo<SpecialistInput | null>(() => {
    if (open === "") return { ...blankSpecialist(), scope: where ? "project" : "global", project: where };
    if (!current) return null;
    const input = specialistInput(current);
    return where ? { ...input, scope: "project", project: where } : input;
  }, [open, current, where]);

  const edit = (id: string | null) => {
    setOpen(id);
    setConfirming(false);
    setDraft(null);
  };
  const form = draft ?? base;
  const dirty = !!form && !!base && !same(form, base);

  const run = async (f: () => Promise<unknown>, done: string, then?: () => void) => {
    setBusy(true);
    try {
      await f();
      toast(done);
      then?.();
      await reload();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    if (!client || !form) return;
    const id = form.id.trim() || slugOf(form.name);
    void run(() => client.saveSpecialist({ ...form, id }), `Saved ${form.name || id}`, () => edit(id));
  };

  if (error) return <div className="err-text">{error}</div>;
  if (!client) return <div className="dim">Loading…</div>;
  const overridesGlobal = !!current && !!where && current.scope === "global";
  return (
    <div className="specialists-tab">
      <p className="dim prompt-help">
        Feature owners staff their teams with these specialists: each worker hired as one gets its instructions in its system prompt and works on its preferred agent, model and effort unless the owner names others. A project's own specialists replace global ones with the same id for work in that project.
      </p>
      <div className="specialists-scope">
        <div className="radio-row" role="radiogroup" aria-label="Scope">
          {(["global", "project"] as const).map((s, i) => (
            <button key={s} type="button" role="radio" aria-checked={scope === s} className={clsx("btn small", scope === s && "primary")} data-hint data-autofocus={i === 0 || undefined} onClick={() => { setScope(s); edit(null); }}>
              {s === "global" ? "Global" : "Project"}
            </button>
          ))}
        </div>
        {scope === "project" && (
          <select aria-label="Project" value={project} onChange={(e) => { setProject(e.target.value); edit(null); }}>
            {projects.length === 0 && <option value="">No projects yet</option>}
            {projects.map((p) => (
              <option key={p.path} value={p.path}>
                {p.path}
                {p.repo ? "" : " (folder)"}
              </option>
            ))}
          </select>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" className="btn small" data-command="specialists.new" disabled={scope === "project" && !project} onClick={() => edit("")}>
          New specialist
        </button>
      </div>
      <div className="specialists-body">
        <div className="list specialists-list" role="listbox" aria-label="Specialists">
          {list === null && <div className="dim">Loading…</div>}
          {list?.length === 0 && <div className="dim list-empty">{scope === "project" && !project ? "Aura knows no projects yet." : "No specialists."}</div>}
          {list?.map((s) => (
            <button key={`${s.scope}:${s.id}`} type="button" role="option" aria-selected={open === s.id} className={clsx("list-item", open === s.id && "active")} data-hint onClick={() => edit(s.id)}>
              <span className="grow">
                {s.name}
                {s.role && <span className="dim specialist-role"> · {s.role}</span>}
              </span>
              {scope === "project" && <span className={clsx("chip", s.scope === "project" && "accent")}>{s.scope === "project" ? "this project" : "global"}</span>}
              {s.built_in && <span className="chip">{s.customized ? "edited" : "built-in"}</span>}
            </button>
          ))}
          {hidden.length > 0 && (
            <>
              <div className="section-title">Deleted built-ins</div>
              {hidden.map((s) => (
                <div key={s.id} className="list-item static">
                  <span className="grow dim">{s.name}</span>
                  <button type="button" className="btn small" data-hint disabled={busy} onClick={() => void run(() => client.resetSpecialist(s.id), `Restored ${s.name}`)}>
                    Restore
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
        <div
          className="specialist-editor"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && dirty) {
              e.preventDefault();
              e.stopPropagation();
              save();
            }
          }}
        >
          {!form ? (
            <div className="dim">Pick a specialist to edit it, or make a new one.</div>
          ) : (
            <>
              <h4 className="section-head">
                {open === "" ? "New specialist" : form.name}
                {overridesGlobal && <span className="dim"> · global; saving makes this project's own copy</span>}
                {current?.scope === "project" && where && <span className="dim"> · this project's own</span>}
              </h4>
              <SpecialistFields key={`${scope}:${open}`} value={form} onChange={setDraft} idLocked={open !== ""} autofocus={open === ""} />
              <div className="prompt-actions">
                {current && !confirming && !overridesGlobal && (
                  <button type="button" className="btn small" data-hint disabled={busy} onClick={() => setConfirming(true)}>
                    {current.scope === "project" ? "Delete this project's copy…" : "Delete…"}
                  </button>
                )}
                {current && confirming && (
                  <>
                    <span className="dim">{current.built_in ? "Delete it? Reset brings it back." : "Delete it for good?"}</span>
                    <button type="button" className="btn small danger" data-hint disabled={busy} onClick={() => void run(() => client.deleteSpecialist(current.id, current.scope, current.project), `Deleted ${current.name}`, () => edit(null))}>
                      Delete
                    </button>
                    <button type="button" className="btn small" data-hint onClick={() => setConfirming(false)}>
                      Cancel
                    </button>
                  </>
                )}
                {current?.built_in && current.customized && !where && (
                  <button type="button" className="btn small" data-hint disabled={busy} onClick={() => void run(() => client.resetSpecialist(current.id), `${current.name} reset to Aura's version`, () => setDraft(null))}>
                    Reset to Aura's version
                  </button>
                )}
                <span style={{ flex: 1 }} />
                {(dirty || open === "") && (
                  <>
                    <button type="button" className="btn small" data-hint onClick={() => (open === "" ? edit(null) : setDraft(null))}>
                      Discard
                    </button>
                    <button type="button" className="btn small primary" data-hint disabled={busy || !form.name.trim() || !form.instructions.trim()} onClick={save}>
                      Save <kbd>⌘↩</kbd>
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
