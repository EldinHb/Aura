import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { ModalC } from "../../components/ModalC";
import { useStore } from "../../state/store";
import { useGroups } from "../../state/groups";
import { providerChoices } from "../../lib/acp";
import { exactTime } from "../../lib/time";
import type { Autonomy, ClearHistory, ModelInfo, Project, ScheduledRun, ScheduledTask, Weekday } from "../../gen";
import { AutonomyPicker } from "../../components/AutonomyPicker";
import { describeAutonomy } from "../../lib/features";
import { openRunSession, schedules, useSchedules } from "./state";
import {
  describeSchedule, draftError, draftOfTask, folderless, formatWhen, inputOf, newDraft, orchestrates, RESULT_LABEL, RUN_AS, scheduleError, scheduleOf,
  TRIGGER_LABEL, UNITS, WEEKDAYS, type ScheduleDraft, type TaskDraft, type Unit,
} from "./schedule";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The scheduled tasks: a list on the left, the chosen task's editor and history on the right. */
export function SchedulesDialog({ taskId, create }: { taskId?: string; create?: boolean }) {
  const { tasks, loaded, error } = useSchedules();
  const [selected, setSelected] = useState<string | null>(create ? null : taskId ?? null);
  const [creating, setCreating] = useState(!!create);
  const listRef = useRef<HTMLDivElement>(null);
  // A task deleted elsewhere (an orchestrator, another window) is no longer selected.
  const current = tasks.find((t) => t.id === selected) ?? null;
  useEffect(() => {
    if (!creating && !current && tasks.length > 0 && loaded) setSelected(tasks[0].id);
  }, [creating, current, tasks, loaded]);

  const pick = (id: string) => { setCreating(false); setSelected(id); };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const i = tasks.findIndex((t) => t.id === current?.id);
    if (e.key === "ArrowDown" || e.key === "j") { const t = tasks[Math.min(tasks.length - 1, i + 1)]; if (t) pick(t.id); }
    else if (e.key === "ArrowUp" || e.key === "k") { const t = tasks[Math.max(0, i - 1)]; if (t) pick(t.id); }
    else if (e.key === "n") setCreating(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".list-item.active")?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  return (
    <ModalC
      title={<>
        <span>Scheduled tasks</span>
        <span style={{ flex: 1 }} />
        <span className="dim" style={{ fontWeight: 400, fontSize: 11 }}><kbd>↑</kbd> <kbd>↓</kbd> pick · <kbd>n</kbd> new · <kbd>⌘↩</kbd> save</span>
      </>}
      width="min(1080px, 94vw)"
      height="84vh"
      onKeyDown={onKeyDown}
      className="schedules-modal"
    >
      <div className="schedules-layout">
        <aside className="schedules-list" aria-label="Scheduled tasks">
          <button type="button" className={clsx("btn small", creating && "primary")} data-command="schedules.new" data-autofocus={!create && !taskId ? true : undefined} onClick={() => setCreating(true)}>+ New task <kbd>n</kbd></button>
          {error && <p className="schedules-error" role="status">{error}</p>}
          <div className="schedules-rows" ref={listRef} role="listbox" aria-label="Tasks">
            {loaded && tasks.length === 0 && <p className="dim schedules-empty">No scheduled tasks yet. A task starts a new session with its prompt each time its schedule comes round, also when the Aura window is closed.</p>}
            {tasks.map((t) => (
              <button key={t.id} type="button" role="option" aria-selected={!creating && t.id === current?.id} className={clsx("list-item schedule-row", !creating && t.id === current?.id && "active", !t.enabled && "off")} data-hint tabIndex={-1} onClick={() => pick(t.id)}>
                <span className="schedule-row-body">
                  <span className="schedule-row-title">
                    <span className="grow">{t.name}</span>
                    {t.run_as === "feature_owner" ? <span className="feature-owner-mark" role="img" aria-label="Runs as a feature owner" title="Runs as a feature owner" />
                      : t.run_as === "orchestrator" && <span className="orchestrator-mark" role="img" aria-label="Runs as an orchestrator" title="Runs as an orchestrator" />}
                    {t.last_run && <span className={clsx("run-dot", t.last_run.result)} title={`Last run: ${RESULT_LABEL[t.last_run.result]}`} />}
                    {!t.enabled && <span className="chip">off</span>}
                  </span>
                  <span className="dim">{describeSchedule(t.schedule)}</span>
                  <span className="dim">{t.enabled ? (t.next_run ? `next ${formatWhen(t.next_run)}` : "no next run") : "disabled"}</span>
                </span>
              </button>
            ))}
          </div>
        </aside>
        <section className="schedules-detail">
          {creating ? (
            <TaskEditor key="new" task={null} onSaved={(t) => pick(t.id)} />
          ) : current ? (
            <TaskEditor key={current.id} task={current} onSaved={() => {}} />
          ) : (
            <div className="empty" style={{ height: "auto", padding: 40 }}>
              <span>Pick a task, or create one with <kbd>n</kbd>.</span>
            </div>
          )}
        </section>
      </div>
    </ModalC>
  );
}

/** Edit a task (or a new one), with its actions and history. */
function TaskEditor({ task, onSaved }: { task: ScheduledTask | null; onSaved: (t: ScheduledTask) => void }) {
  const client = useStore((s) => s.client);
  const providers = useStore((s) => s.providers);
  const settings = useStore((s) => s.settings);
  const sessionsById = useStore((s) => s.sessions);
  const toast = useStore((s) => s.toast);
  const agents = useMemo(() => providerChoices(providers).filter((c) => c.kind !== "terminal"), [providers]);
  const agentOf = (key: string) => agents.find((c) => c.key === key)?.agent ?? key;
  const defaultAgent = agents.find((c) => c.key === settings.defaultProvider) ?? agents[0];
  const [draft, setDraft] = useState<TaskDraft>(() => task ? draftOfTask(task) : newDraft(defaultAgent ? agentOf(defaultAgent.key) : "", settings.defaultCwd));
  const saved = useMemo(() => (task ? JSON.stringify(inputOf(draftOfTask(task))) : null), [task]);
  const dirty = !task || JSON.stringify(inputOf(draft)) !== saved;
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = <K extends keyof TaskDraft>(k: K, v: TaskDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setSchedule = (patch: Partial<ScheduleDraft>) => setDraft((d) => ({ ...d, schedule: { ...d.schedule, ...patch } }));

  // A task changed elsewhere (an orchestrator, a run) shows the change when nothing here is unsaved.
  const [base, setBase] = useState(saved);
  useEffect(() => {
    if (saved === base) return;
    setBase(saved);
    if (task && JSON.stringify(inputOf(draft)) === base) setDraft(draftOfTask(task));
  }, [saved]); // eslint-disable-line react-hooks/exhaustive-deps

  // The agent as a choice: claude, codex or an ACP agent's id.
  const choice = agents.find((c) => (c.kind === "acp" ? c.agent : c.kind) === draft.agent);
  const provider = choice?.kind ?? (draft.agent === "claude" || draft.agent === "codex" ? draft.agent : "acp");
  const caps = providers.find((p) => p.kind === provider)?.capabilities;
  const [models, setModels] = useState<ModelInfo[]>([]);
  useEffect(() => {
    if (!client || provider === "acp") { setModels([]); return; }
    client.models(provider).then(setModels, () => setModels([]));
  }, [client, provider]);
  const model = models.find((m) => m.id === draft.model) ?? (draft.model ? undefined : models.find((m) => m.is_default));
  const efforts = model ? model.efforts : provider === "codex" ? ["low", "medium", "high", "xhigh"] : ["low", "medium", "high", "xhigh", "max"];

  const [projects, setProjects] = useState<Project[]>([]);
  useEffect(() => { client?.projects().then(setProjects, () => {}); }, [client]);
  const [repo, setRepo] = useState<string | null>(null);
  // Asked at once for the folder the task has; typed folders wait for a pause.
  const typed = useRef(false);
  useEffect(() => {
    const cwd = draft.cwd.trim();
    if (!client || !cwd.startsWith("/")) { setRepo(null); return; }
    let cancelled = false;
    const delay = typed.current ? 250 : 0;
    typed.current = true;
    const t = setTimeout(() => client.gitRepoRoot(cwd).then((r) => !cancelled && setRepo(r), () => !cancelled && setRepo(null)), delay);
    return () => { cancelled = true; clearTimeout(t); };
  }, [client, draft.cwd]);
  const { names: groups } = useGroups();
  // What a feature owner without an autonomy of its own follows.
  const [globalAutonomy, setGlobalAutonomy] = useState<Autonomy | null>(null);
  const owns = draft.run_as === "feature_owner";
  useEffect(() => { if (owns) client?.autonomy().then(setGlobalAutonomy, () => {}); }, [client, owns]);
  const noFolder = folderless(draft);

  // When it would run, as the daemon works it out.
  const schedule = useMemo(() => scheduleOf(draft.schedule), [draft.schedule]);
  const invalid = scheduleError(draft.schedule);
  const unchangedSchedule = !!task && JSON.stringify(schedule) === JSON.stringify(task.schedule);
  const [preview, setPreview] = useState<string[] | null>(null);
  useEffect(() => {
    if (invalid || unchangedSchedule) { setPreview(null); return; }
    let cancelled = false;
    const t = setTimeout(() => schedules.preview(schedule, 3).then((p) => !cancelled && setPreview(p), () => !cancelled && setPreview(null)), 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [schedule, invalid, unchangedSchedule]);

  const problem = draftError(draft);
  const save = useCallback(async () => {
    if (busy || problem || !dirty) return;
    setBusy(true);
    try {
      const t = task ? await schedules.update(task.id, inputOf(draft)) : await schedules.create(inputOf(draft));
      await useSchedules.getState().refresh();
      toast(task ? `Saved “${t.name}”` : `Created “${t.name}”${t.next_run ? `: first run ${formatWhen(t.next_run)}` : ""}`);
      if (task) setDraft(draftOfTask(t));
      onSaved(t);
    } catch (e) { toast(message(e), "error"); }
    finally { setBusy(false); }
  }, [busy, problem, dirty, task, draft, toast, onSaved]);

  const act = async (what: () => Promise<unknown>) => {
    try { await what(); await useSchedules.getState().refresh(); } catch (e) { toast(message(e), "error"); }
  };
  const runNow = () => task && act(async () => {
    const run = await schedules.run(task.id);
    if (run.result === "started") toast(`Started “${run.session_title}”`);
    else toast(`${RESULT_LABEL[run.result]}: ${run.message ?? ""}`, run.result === "failed" ? "error" : "warn");
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  const unit = UNITS.find((u) => u.unit === draft.schedule.unit)!;
  return (
    <div className="schedule-editor">
      <div className="schedule-editor-head">
        <h3>{task ? task.name : "New scheduled task"}</h3>
        {task?.created_by && <span className="chip orchestrator" title="Created by an orchestrator through its tools">by {task.created_by.orchestrator_title}</span>}
        <span style={{ flex: 1 }} />
        {task && <>
          <button type="button" className="btn small" data-command="schedules.run-now" disabled={busy} onClick={() => void runNow()} title="Start a session now; the schedule stays as it is">▶ Run now</button>
          <button type="button" className="btn small" data-command="schedules.toggle" onClick={() => void act(() => schedules.setEnabled(task.id, !task.enabled))}>{task.enabled ? "Disable" : "Enable"}</button>
          {confirmDelete ? <>
            <button type="button" className="btn small danger" data-command="schedules.delete" onClick={() => void act(() => schedules.remove(task.id))}>Delete task and history</button>
            <button type="button" className="btn small" data-command="schedules.delete-cancel" onClick={() => setConfirmDelete(false)}>Keep</button>
          </> : <button type="button" className="btn small" data-command="schedules.delete" onClick={() => setConfirmDelete(true)}>Delete…</button>}
        </>}
      </div>
      {task && (
        <p className="schedule-status">
          {task.enabled ? (task.next_run ? <>Next run <strong title={exactTime(task.next_run)}>{formatWhen(task.next_run)}</strong> · </> : null) : <>Disabled · </>}
          {describeSchedule(task.schedule)}
        </p>
      )}

      <div className="two-col">
        <div className="field">
          <label htmlFor="schedule-name">Name</label>
          <input id="schedule-name" type="text" value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="Nightly dependency check" data-autofocus={!task ? true : undefined} />
        </div>
        <div className="field">
          <label htmlFor="schedule-group">Group (optional)</label>
          <input id="schedule-group" type="text" list="aura-groups-schedule" value={draft.group} onChange={(e) => set("group", e.target.value)} />
          <datalist id="aura-groups-schedule">{groups.map((g) => <option key={g} value={g} />)}</datalist>
        </div>
      </div>
      <div className="field">
        <label htmlFor="schedule-prompt">Prompt</label>
        <textarea id="schedule-prompt" rows={5} value={draft.prompt} onChange={(e) => set("prompt", e.target.value)} placeholder="The first message of every session this task starts: a complete brief." />
      </div>

      <div className="field">
        <label>Agent</label>
        <div className="radio-row" role="radiogroup" aria-label="Agent">
          {agents.map((c) => {
            const value = c.kind === "acp" ? c.agent! : c.kind;
            return (
              <button key={c.key} type="button" role="radio" aria-checked={draft.agent === value} className={clsx("btn", draft.agent === value && "primary")} data-command="schedules.agent"
                onClick={() => setDraft((d) => ({ ...d, agent: value, model: "", effort: "", permission_mode: "", sandbox_mode: "" }))}>
                {c.label}{c.kind === "acp" && <span className="dim">ACP</span>}
              </button>
            );
          })}
          {!choice && draft.agent && <span className="chip warn" title="Not available on this machine right now">{draft.agent} (not available)</span>}
          {agents.length === 0 && <span className="dim">No agents detected.</span>}
        </div>
      </div>
      <div className="field">
        <label id="schedule-run-as-label">Each run starts</label>
        <div className="radio-row" role="radiogroup" aria-labelledby="schedule-run-as-label">
          {RUN_AS.map((r) => (
            <button key={r.value} type="button" role="radio" aria-checked={draft.run_as === r.value} className={clsx("btn", draft.run_as === r.value && "primary")} data-command="schedules.run-as" title={r.help} onClick={() => set("run_as", r.value)}>
              {r.value === "orchestrator" && <span className="orchestrator-mark" aria-hidden />}
              {r.value === "feature_owner" && <span className="feature-owner-mark" aria-hidden />}
              {r.label}
            </button>
          ))}
        </div>
        <span className="dim schedule-note">{RUN_AS.find((r) => r.value === draft.run_as)!.help}{orchestrates(draft) ? " It gets the same instructions and tools as one you start by hand, and its workers are its own." : ""}</span>
      </div>
      {owns && (
        <>
          <div className="field">
            <label htmlFor="schedule-goal">Feature goal</label>
            <textarea id="schedule-goal" rows={3} value={draft.feature_goal} onChange={(e) => set("feature_goal", e.target.value)} placeholder="What should the feature do, for whom, and why?" />
          </div>
          <div className="field">
            <label>
              <input type="checkbox" checked={!!draft.autonomy} onChange={(e) => set("autonomy", e.target.checked ? (globalAutonomy ?? { level: "blocking_decisions", checkpoints: ["after_design", "before_implementation", "before_delivery"] }) : null)} style={{ marginRight: 6 }} />
              Own autonomy for this feature {!draft.autonomy && globalAutonomy && <span className="dim">· otherwise {describeAutonomy(globalAutonomy)}, from Settings → Orchestrators</span>}
            </label>
            {draft.autonomy && <AutonomyPicker name="schedule-autonomy" value={draft.autonomy} onChange={(a) => set("autonomy", a)} />}
          </div>
        </>
      )}
      {provider === "acp" ? (
        <p className="dim schedule-note">The ACP agent starts with its own default model and mode.</p>
      ) : (
        <div className="schedule-grid">
          <div className="field">
            <label htmlFor="schedule-model">Model</label>
            <select id="schedule-model" value={draft.model} onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value, effort: "" }))}>
              <option value="">agent default</option>
              {draft.model && !models.some((m) => m.id === draft.model) && <option value={draft.model}>{draft.model}</option>}
              {models.map((m) => <option key={m.id} value={m.id}>{m.display_name || m.id}{m.is_default ? " (default)" : ""}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="schedule-effort">Effort</label>
            <select id="schedule-effort" value={draft.effort} onChange={(e) => set("effort", e.target.value)} disabled={efforts.length === 0}>
              <option value="">{efforts.length === 0 ? "not supported" : `default${model?.default_effort ? ` (${model.default_effort})` : ""}`}</option>
              {draft.effort && !efforts.includes(draft.effort) && <option value={draft.effort}>{draft.effort}</option>}
              {efforts.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="schedule-permission">Permission mode</label>
            <select id="schedule-permission" value={draft.permission_mode} onChange={(e) => set("permission_mode", e.target.value)}>
              <option value="">agent default</option>
              {draft.permission_mode && !(caps?.permission_modes ?? []).includes(draft.permission_mode) && <option value={draft.permission_mode}>{draft.permission_mode}</option>}
              {(caps?.permission_modes ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          {((caps?.sandbox_modes.length ?? 0) > 0 || draft.sandbox_mode) && (
            <div className="field">
              <label htmlFor="schedule-sandbox">Sandbox</label>
              <select id="schedule-sandbox" value={draft.sandbox_mode} onChange={(e) => set("sandbox_mode", e.target.value)}>
                <option value="">agent default</option>
                {draft.sandbox_mode && !(caps?.sandbox_modes ?? []).includes(draft.sandbox_mode) && <option value={draft.sandbox_mode}>{draft.sandbox_mode}</option>}
                {(caps?.sandbox_modes ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          )}
        </div>
      )}

      {noFolder ? (
        <div className="field">
          <label>Folder or repository</label>
          <div className="no-folder">
            <span className="dim">None: each run gets a directory of its own, and the {owns ? "feature owner" : "orchestrator"} names a folder for each worker.</span>
            <button type="button" className="btn small" data-command="schedules.folder" onClick={() => set("no_folder", false)}>Use a folder</button>
          </div>
        </div>
      ) : (
      <div className="field">
        <label htmlFor="schedule-cwd">
          Folder or repository {repo && <span className="chip">⎇ git repo</span>}
          {orchestrates(draft) && <button type="button" className="btn small folder-toggle" data-command="schedules.folder" onClick={() => set("no_folder", true)}>No folder</button>}
        </label>
        <input id="schedule-cwd" type="text" list="aura-projects-schedule" value={draft.cwd} onChange={(e) => set("cwd", e.target.value)} placeholder="/Users/you/Projects/app" spellCheck={false} autoComplete="off" />
        <datalist id="aura-projects-schedule">{projects.map((p) => <option key={p.path} value={p.path} />)}</datalist>
      </div>
      )}
      {!noFolder && <label className="check-row">
        <input type="checkbox" checked={draft.worktree} disabled={!repo && !draft.worktree} onChange={(e) => set("worktree", e.target.checked)} />
        Each run in a new git worktree, on a branch of its own{!repo && !draft.worktree && <span className="dim"> (the folder is not a git repository)</span>}
      </label>}
      {draft.worktree && !noFolder && (
        <div className="field">
          <label htmlFor="schedule-branch">Branch name starts with</label>
          <input id="schedule-branch" type="text" value={draft.branch_prefix} onChange={(e) => set("branch_prefix", e.target.value.replace(/\s/g, "-"))} placeholder={`scheduled/${draft.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "task"}`} spellCheck={false} />
          <span className="dim schedule-note">Each run's branch ends in its date and time, e.g. <code>{(draft.branch_prefix.trim() || "scheduled/…")}-20261118-090000</code>.</span>
        </div>
      )}

      <fieldset className="schedule-when">
        <legend>Schedule</legend>
        <div className="schedule-when-row">
          <span>Every</span>
          <input aria-label="Every" type="number" min={1} max={unit.max} value={draft.schedule.every} onChange={(e) => setSchedule({ every: Math.floor(Number(e.target.value)) })} className="schedule-every" />
          <select aria-label="Unit" value={draft.schedule.unit} onChange={(e) => setSchedule({ unit: e.target.value as Unit })}>
            {UNITS.map((u) => <option key={u.unit} value={u.unit}>{draft.schedule.every === 1 ? u.one : u.many}</option>)}
          </select>
          {draft.schedule.unit === "months" && <>
            <span>on day</span>
            <input aria-label="Day of the month" type="number" min={1} max={31} value={draft.schedule.day} onChange={(e) => setSchedule({ day: Math.floor(Number(e.target.value)) })} className="schedule-every" />
          </>}
          {draft.schedule.unit !== "minutes" && draft.schedule.unit !== "hours" && <>
            <span>at</span>
            <input aria-label="Time of day" type="time" value={draft.schedule.at} onChange={(e) => setSchedule({ at: e.target.value })} className="schedule-time" />
          </>}
        </div>
        {draft.schedule.unit === "weeks" && (
          <div className="radio-row schedule-days" role="group" aria-label="Days of the week">
            {WEEKDAYS.map((w) => {
              const on = draft.schedule.weekdays.includes(w.day);
              return (
                <button key={w.day} type="button" aria-pressed={on} title={w.long} className={clsx("btn small", on && "primary")} data-command="schedules.weekday"
                  onClick={() => setSchedule({ weekdays: on ? draft.schedule.weekdays.filter((d) => d !== w.day) : [...draft.schedule.weekdays, w.day] as Weekday[] })}>
                  {w.short}
                </button>
              );
            })}
          </div>
        )}
        <p className="dim schedule-note">
          {draft.schedule.unit === "minutes" || draft.schedule.unit === "hours"
            ? "Counted from when you save the schedule, in elapsed time, also across clock changes."
            : draft.schedule.unit === "months" && draft.schedule.day > 28
              ? `In months without a ${draft.schedule.day}${draft.schedule.day === 31 ? "st" : "th"} it runs on the last day. Times are your local time; a time the clock skips runs when it jumps.`
              : "Your local time. A time the clock skips when daylight saving time starts runs when it jumps; a time that comes twice runs once."}
        </p>
        {invalid ? <p className="schedule-problem" role="status">{invalid}</p>
          : preview && <p className="schedule-preview">Next runs: {preview.map((p) => formatWhen(p)).join(" · ")}</p>}
      </fieldset>

      <div className="schedule-grid">
        <div className="field">
          <label htmlFor="schedule-missed">Runs missed while Aura was not running</label>
          <select id="schedule-missed" value={draft.missed} onChange={(e) => set("missed", e.target.value as TaskDraft["missed"])}>
            <option value="run_once">Run once when Aura is back</option>
            <option value="skip">Skip them</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="schedule-overlap">While the previous run still works</label>
          <select id="schedule-overlap" value={draft.allow_overlap ? "overlap" : "skip"} onChange={(e) => set("allow_overlap", e.target.value === "overlap")}>
            <option value="skip">Skip the run</option>
            <option value="overlap">Start another session</option>
          </select>
        </div>
      </div>
      <label className="check-row">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => set("enabled", e.target.checked)} /> Enabled
      </label>

      <div className="schedule-save">
        {problem && dirty && <span className="dim">{problem}</span>}
        <span style={{ flex: 1 }} />
        {task && dirty && <button type="button" className="btn small" data-command="schedules.revert" onClick={() => setDraft(draftOfTask(task))}>Revert</button>}
        <button type="button" className="btn primary" data-command="schedules.save" disabled={busy || !!problem || !dirty} onClick={() => void save()}>
          {busy ? "Saving…" : task ? "Save" : "Create"} <kbd>⌘↩</kbd>
        </button>
      </div>

      {task && <History task={task} sessionsById={sessionsById} />}
    </div>
  );
}

function History({ task, sessionsById }: { task: ScheduledTask; sessionsById: Record<string, unknown> }) {
  const version = useSchedules((s) => s.version);
  const [runs, setRuns] = useState<ScheduledRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    schedules.runs(task.id, 50).then((r) => { if (!cancelled) { setRuns(r); setError(null); } }, (e) => !cancelled && setError(message(e)));
    return () => { cancelled = true; };
  }, [task.id, version]);
  const toast = useStore((s) => s.toast);
  const [clearing, setClearing] = useState(false);
  const [only, setOnly] = useState<ClearHistory>("failed_and_skipped");
  const clear = async () => {
    try {
      const { removed } = await schedules.clearHistory(task.id, only);
      await useSchedules.getState().refresh();
      toast(removed === 0 ? "Nothing to clear" : `Cleared ${removed} ${removed === 1 ? "entry" : "entries"}`);
      setClearing(false);
    } catch (e) { toast(message(e), "error"); }
  };
  const counts = { failed: runs?.filter((r) => r.result === "failed").length ?? 0, skipped: runs?.filter((r) => r.result === "skipped").length ?? 0 };
  return (
    <section className="schedule-history" aria-label="Run history">
      <div className="schedule-history-head">
        <h4>History</h4>
        <span style={{ flex: 1 }} />
        {runs && runs.length > 0 && (clearing ? (
          <span className="schedule-clear" role="group" aria-label="Clear history">
            <select aria-label="Entries to clear" value={only} onChange={(e) => setOnly(e.target.value as ClearHistory)}>
              <option value="failed_and_skipped">Failed and skipped ({counts.failed + counts.skipped})</option>
              <option value="failed">Failed ({counts.failed})</option>
              <option value="skipped">Skipped ({counts.skipped})</option>
              <option value="all">All entries ({runs.length})</option>
            </select>
            <button type="button" className="btn small danger" data-command="schedules.clear-history" onClick={() => void clear()}>Clear</button>
            <button type="button" className="btn small" data-command="schedules.clear-history-cancel" onClick={() => setClearing(false)}>Cancel</button>
          </span>
        ) : (
          <button type="button" className="btn small" data-command="schedules.clear-history" title="Remove entries from this history; the sessions runs started are kept" onClick={() => setClearing(true)}>Clear history…</button>
        ))}
      </div>
      {error && <p className="schedules-error">{error}</p>}
      {runs && runs.length === 0 && <p className="dim">It has not run yet.</p>}
      {runs && runs.length > 0 && (
        <ul>
          {runs.map((r) => {
            const exists = !!r.session_id && !!sessionsById[r.session_id];
            return (
              <li key={r.id} className="schedule-run">
                <span className="schedule-run-when" title={exactTime(r.at)}>{formatWhen(r.at)}</span>
                <span className={clsx("chip run-result", r.result)}>{RESULT_LABEL[r.result]}</span>
                <span className="dim">{TRIGGER_LABEL[r.trigger]}</span>
                <span className="grow schedule-run-text">
                  {r.session_id && (exists
                    ? <button type="button" className="link" data-command="schedules.open-session" onClick={() => openRunSession(r.session_id!)}>{r.session_title ?? "Open session"}</button>
                    : <span className="dim" title="The session was deleted">{r.session_title ?? "deleted session"}</span>)}
                  {r.message && <span className="schedule-run-message">{r.message}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
