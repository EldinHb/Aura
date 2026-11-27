import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import clsx from "clsx";
import type { Session } from "../../gen";
import { Modal } from "../Modal";
import { useStore, waitsOnUser } from "../../state/store";
import { workersUnder } from "../../lib/sessionFolder";
import { relTime } from "../../lib/platform";
import { stateWord, statusClass } from "../../lib/sessionStatus";

type Scope = "workspace" | "all";

/** A group of the list: an orchestrator's direct workers, the workers whose orchestrator is gone, or the scheduled runs. */
export type CleanupGroup = { key: string; label: string; orchestrator: Session | null; rows: Session[] };

/** Whether `s` (with everything under it) is done enough to delete without asking: nothing works or waits on the user. */
function finished(s: Session, sessions: Record<string, Session>): boolean {
  return [s, ...workersUnder(s.id, sessions)].every((x) => x.status !== "running" && !waitsOnUser(x));
}

/**
 * What the cleanup dialog lists. For `orchestratorId`, that orchestrator's
 * direct workers. Otherwise, in `workspace` (null for every workspace): one
 * group per top-level orchestrator with workers, most recent first; the
 * workers whose orchestrator is gone; and last the top-level scheduled runs,
 * newest first. Workers in a group are oldest first.
 */
export function cleanupGroups(sessions: Record<string, Session>, orchestratorId: string | null, workspace: string | null): CleanupGroup[] {
  const all = Object.values(sessions);
  const oldest = (a: Session, b: Session) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
  const workersOf = (id: string) => all.filter((w) => w.orchestrator_id === id).sort(oldest);
  if (orchestratorId) {
    const o = sessions[orchestratorId];
    return o ? [{ key: o.id, label: o.title, orchestrator: o, rows: workersOf(o.id) }].filter((g) => g.rows.length > 0) : [];
  }
  const inScope = (s: Session) => workspace === null || s.workspace === workspace;
  const scheduledRun = (s: Session): boolean => !!s.scheduled_task_id || (!!s.orchestrator_id && !!sessions[s.orchestrator_id] && scheduledRun(sessions[s.orchestrator_id]));
  const groups: CleanupGroup[] = all
    .filter((o) => !o.orchestrator_id && !scheduledRun(o) && inScope(o) && all.some((w) => w.orchestrator_id === o.id))
    .sort((a, b) => b.last_activity.localeCompare(a.last_activity) || a.id.localeCompare(b.id))
    .map((o) => ({ key: o.id, label: o.title, orchestrator: o, rows: workersOf(o.id) }));
  const orphans = all.filter((w) => w.orchestrator_id && !sessions[w.orchestrator_id] && inScope(w)).sort(oldest);
  if (orphans.length) groups.push({ key: "\u0000orphans", label: "No orchestrator", orchestrator: null, rows: orphans });
  const runs = all.filter((s) => s.scheduled_task_id && !s.orchestrator_id && inScope(s)).sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
  if (runs.length) groups.push({ key: "\u0000scheduled", label: "Scheduled runs", orchestrator: null, rows: runs });
  return groups;
}

/**
 * The rows checked when the dialog opens, and by "Select finished": idle,
 * finished, failed, exited and archived workers. Not a worker that works or
 * waits on the user (nor a sub-orchestrator whose tree does), and never a
 * scheduled run.
 */
export function defaultPicks(groups: CleanupGroup[], sessions: Record<string, Session>): string[] {
  return groups.filter((g) => g.key !== "\u0000scheduled").flatMap((g) => g.rows.filter((s) => finished(s, sessions)).map((s) => s.id));
}

/** Every session deleting `ids` deletes: each one with its workers. */
function affected(ids: string[], sessions: Record<string, Session>): Session[] {
  const out = new Map<string, Session>();
  for (const id of ids) {
    const s = sessions[id];
    if (!s) continue;
    out.set(s.id, s);
    for (const w of workersUnder(s.id, sessions)) out.set(w.id, w);
  }
  return [...out.values()];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Bulk-delete worker sessions, of one orchestrator or of a workspace, with one confirmation. */
export function WorkersCleanupDialog({ orchestratorId, scope: initialScope = "workspace" }: { orchestratorId?: string; scope?: Scope }) {
  const sessions = useStore((s) => s.sessions);
  const client = useStore((s) => s.client);
  const close = useStore((s) => s.closeDialog);
  const toast = useStore((s) => s.toast);
  const confirmDelete = useStore((s) => s.settings.confirmDelete);
  const activeWorkspace = useStore((s) => (s.workspaces.length ? s.activeWorkspace : null));
  const hasWorkspaces = useStore((s) => s.workspaces.length > 1);
  const [scope, setScope] = useState<Scope>(initialScope);
  const groups = useMemo(() => cleanupGroups(sessions, orchestratorId ?? null, scope === "all" ? null : activeWorkspace), [sessions, orchestratorId, scope, activeWorkspace]);
  const [picked, setPicked] = useState<string[]>(() => defaultPicks(groups, sessions));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<string[] | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const listed = useMemo(() => new Set(groups.flatMap((g) => g.rows.map((s) => s.id))), [groups]);
  // Picks of rows that went away (deleted elsewhere, or out of scope) do not count.
  const live = picked.filter((id) => listed.has(id));
  const targets = affected(live, sessions);
  const working = targets.filter((s) => s.status === "running").length;
  const waiting = targets.filter(waitsOnUser).length;
  const toggle = (ids: string[], on: boolean) => setPicked((cur) => (on ? [...new Set([...cur, ...ids])] : cur.filter((id) => !ids.includes(id))));

  const run = async (ids: string[]) => {
    if (!client || !ids.length) return;
    setConfirming(false);
    setError(null);
    setSummary(null);
    setBusy(ids);
    try {
      const result = await client.deleteSessions(ids);
      const reasons = Object.fromEntries(result.failed.map((f) => [f.id, f.error]));
      if (!result.failed.length) {
        toast(`Deleted ${plural(result.deleted.length, "worker session")}`);
        close();
        return;
      }
      setFailed(reasons);
      // Deleted rows go; failed rows stay checked with their reason.
      setPicked(result.failed.map((f) => f.id));
      setSummary(`Deleted ${result.deleted.length}. ${result.failed.length} couldn't be deleted.`);
    } catch (e) {
      // Nothing is taken out here; the list follows the daemon's session events.
      setError(`Couldn't delete: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };
  const start = () => {
    if (!live.length || busy) return;
    if (confirmDelete) setConfirming(true);
    else void run(live);
  };

  // Up and down move between the checkboxes; ⌘A checks every row shown.
  const onListKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const boxes = [...e.currentTarget.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
    const i = boxes.indexOf(document.activeElement as HTMLInputElement);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") toggle([...listed], true);
    else if (e.key === "ArrowDown") boxes[Math.min(boxes.length - 1, i + 1)]?.focus();
    else if (e.key === "ArrowUp") boxes[Math.max(0, i - 1)]?.focus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const title = orchestratorId ? `Clean up the workers of ${sessions[orchestratorId]?.title ?? "this orchestrator"}` : "Clean up worker sessions";
  const scopeToggle = !orchestratorId && hasWorkspaces && (
    <select className="cleanup-scope" aria-label="Which workspaces" value={scope} disabled={!!busy} onChange={(e) => {
      // Rows new to the list start with the defaults.
      const next = e.target.value as Scope;
      setScope(next);
      setPicked(defaultPicks(cleanupGroups(sessions, null, next === "all" ? null : activeWorkspace), sessions));
    }}>
      <option value="workspace">This workspace</option>
      <option value="all">All workspaces</option>
    </select>
  );

  if (confirming) {
    const n = targets.length;
    const extra = [
      working > 0 && `${working === 1 ? "1 of them is" : `${working} of them are`} still working and will be stopped.`,
      waiting > 0 && `${waiting === 1 ? "1 waits on you; its question will be discarded." : `${waiting} wait on you; their questions will be discarded.`}`,
    ].filter(Boolean).join(" ");
    return (
      <Modal
        key="confirm"
        title={`Delete ${plural(n, "worker session")}`}
        width={460}
        onClose={() => setConfirming(false)}
        footer={
          <>
            <button type="button" className="btn" data-command="dialog.cancel" data-autofocus onClick={() => setConfirming(false)}>Cancel</button>
            <button type="button" className="btn danger" data-command="dialog.confirm" onClick={() => void run(live)}>Delete</button>
          </>
        }
      >
        <p style={{ margin: 0, lineHeight: 1.5 }}>
          Delete {plural(n, "session")} and their history from Aura? The providers' own transcripts, worktrees and branches are kept.{extra ? ` ${extra}` : ""}
        </p>
      </Modal>
    );
  }

  if (!groups.length && !summary) {
    return (
      <Modal title={<><span>{title}</span>{scopeToggle && <span style={{ marginLeft: "auto" }}>{scopeToggle}</span>}</>} width={460} footer={<button type="button" className="btn" data-command="dialog.cancel" data-autofocus onClick={close}>Close</button>}>
        <div className="empty" style={{ height: "auto", padding: 12 }}>
          <span>No worker sessions to clean up.</span>
          <span className="dim">Workers appear here when an orchestrator starts sessions.</span>
        </div>
      </Modal>
    );
  }

  const deleting = busy ? busy.filter((id) => !sessions[id]).length : 0;
  const failedIds = Object.keys(failed).filter((id) => sessions[id]);
  return (
    <Modal
      key="list"
      title={<><span>{title}</span>{scopeToggle && <span style={{ marginLeft: "auto" }}>{scopeToggle}</span>}</>}
      width={640}
      className="workers-cleanup"
      onClose={busy ? () => {} : close}
      onSubmit={start}
      footer={
        <>
          <span className="dim grow">Worktrees and branches are kept.</span>
          {summary ? (
            <>
              <button type="button" className="btn" data-command="dialog.cancel" onClick={close}>Close</button>
              <button type="button" className="btn danger" data-command="workers-cleanup.retry" disabled={!!busy || !failedIds.length} onClick={() => void run(failedIds)}>Retry failed</button>
            </>
          ) : (
            <>
              <button type="button" className="btn" data-command="dialog.cancel" disabled={!!busy} onClick={close}>Cancel</button>
              <button type="button" className="btn danger" data-command="dialog.confirm" disabled={!!busy || !live.length} title={live.length ? undefined : "Select sessions to delete."} onClick={start}>
                {busy ? `Deleting ${deleting} of ${busy.length}…` : `Delete ${plural(targets.length, "session")}`} <kbd>⌘↩</kbd>
              </button>
            </>
          )}
        </>
      }
    >
      <p className="dim" style={{ marginTop: 0 }}>Delete worker sessions that agents started. Orchestrators are kept.</p>
      <div className="cleanup-tools">
        <button type="button" className="btn small" data-command="workers-cleanup.select-finished" disabled={!!busy} onClick={() => setPicked(defaultPicks(groups, sessions))}>Select finished</button>
        <button type="button" className="btn small" data-command="workers-cleanup.select-none" disabled={!!busy} onClick={() => setPicked([])}>Select none</button>
      </div>
      {summary && <p role="alert" className="err-text">{summary}</p>}
      {error && <p role="alert" className="err-text">{error}</p>}
      <div className="cleanup-list" onKeyDown={onListKey} role="group" aria-label="Worker sessions">
        {groups.map((g, gi) => {
          const ids = g.rows.map((s) => s.id);
          const on = ids.filter((id) => live.includes(id)).length;
          return (
            <div key={g.key} className="cleanup-group" role="group" aria-label={g.label}>
              <label className="cleanup-head">
                <input
                  type="checkbox"
                  data-autofocus={gi === 0 || undefined}
                  disabled={!!busy}
                  checked={on === ids.length}
                  ref={(el) => { if (el) el.indeterminate = on > 0 && on < ids.length; }}
                  onChange={(e) => toggle(ids, e.target.checked)}
                />
                <span className="grow">
                  {g.label}
                  {g.orchestrator && <span className="dim"> (orchestrator)</span>}
                  <span className="dim"> · {on} of {ids.length} selected</span>
                </span>
              </label>
              {g.rows.map((s) => {
                const under = workersUnder(s.id, sessions).length;
                const why = failed[s.id];
                const label = g.key === "\u0000scheduled" ? `${s.scheduled_task_name ?? s.title} · ${new Date(s.created_at).toLocaleString()}` : s.title;
                return (
                  <label key={s.id} className={clsx("cleanup-row", why && "failed")}>
                    <input type="checkbox" disabled={!!busy} checked={live.includes(s.id)} onChange={(e) => toggle([s.id], e.target.checked)} />
                    <span className={clsx("dot", statusClass(s))} aria-hidden />
                    <span className="grow cleanup-title">
                      {label}
                      {s.specialist_name && s.specialist_name !== s.title && <span className="chip specialist">{s.specialist_name}</span>}
                      {under > 0 && <span className="dim"> (+{plural(under, "worker")})</span>}
                    </span>
                    {waitsOnUser(s) && <span className="chip warn">waiting on you</span>}
                    {/* A waiting row says so in its chip; the others in words here. */}
                    <span className="dim cleanup-state">{waitsOnUser(s) ? relTime(s.last_activity) : `${stateWord(s)} · ${relTime(s.last_activity)}`}</span>
                    {why && <span className="err-text cleanup-error">{why}</span>}
                  </label>
                );
              })}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
