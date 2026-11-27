import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import clsx from "clsx";
import type { Session } from "../../gen";
import { Modal } from "../Modal";
import { useStore, waitsOnUser } from "../../state/store";
import { workersUnder } from "../../lib/sessionFolder";
import { forestOf } from "../../state/forest";
import { relTime } from "../../lib/platform";
import { stateWord, statusClass } from "../../lib/sessionStatus";

type Scope = "workspace" | "all";

/** A group of the list: the sessions that failed to delete, an orchestrator's workers, the workers whose orchestrator is gone, or the scheduled runs. */
export type CleanupGroup = { key: string; label: string; orchestrator: Session | null; rows: Session[] };

export const FAILED_GROUP = "\u0000failed";
export const SCHEDULED_GROUP = "\u0000scheduled";
const ORPHANS_GROUP = "\u0000orphans";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "Nightly · 27 Nov 03:00": a scheduled run by its task and when it started, in local time. */
export function runLabel(s: Session): string {
  const d = new Date(s.created_at);
  const when = Number.isNaN(d.getTime()) ? "" : ` · ${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${s.scheduled_task_name ?? s.title}${when}`;
}

/** Whether `s` is done enough to delete without asking: it neither works nor waits on the user. */
function finished(s: Session): boolean {
  return s.status !== "running" && !waitsOnUser(s);
}

/**
 * Why `s` may not be deleted from this dialog, or null when it may: deleting
 * an orchestrator, or anything with workers, would take a tree along. Checked
 * for every row, failed ones included, and again right before deleting.
 */
export function cleanupBlocker(s: Session, sessions: Record<string, Session>): string | null {
  if (s.orchestrator) return "It is an orchestrator now; delete it on its own.";
  if (forestOf(sessions).childrenOf(s.id).length > 0) return "It has workers now; delete it on its own.";
  return null;
}

/**
 * What the cleanup dialog lists. Only sessions that are no orchestrator and
 * have no workers are listed, so deleting one never takes a tree along.
 * First, `failedIds` that still exist ("Couldn't delete"), wherever they are
 * now; one that may no longer be deleted here stays listed (see
 * `cleanupBlocker`). Then, for `orchestratorId`, the workers of it and of each orchestrator
 * under it; otherwise, in `workspace` (null for every workspace), a group per
 * orchestrator with workers, most recent first, the workers whose
 * orchestrator is gone, and last the scheduled runs that lead (newest
 * first). Workers in a group are oldest first.
 */
export function cleanupGroups(sessions: Record<string, Session>, orchestratorId: string | null, workspace: string | null, failedIds: string[] = []): CleanupGroup[] {
  const forest = forestOf(sessions);
  const failed = failedIds.map((id) => sessions[id]).filter((s): s is Session => !!s);
  const failedSet = new Set(failed.map((s) => s.id));
  const listable = (s: Session) => !cleanupBlocker(s, sessions) && !failedSet.has(s.id);
  const workersOf = (id: string) => forest.childrenOf(id).filter(listable);
  const ownerLabel = (o: Session) => (o.scheduled_task_id ? runLabel(o) : o.title);
  const groups: CleanupGroup[] = failed.length ? [{ key: FAILED_GROUP, label: "Couldn't delete", orchestrator: null, rows: failed }] : [];
  const byActivity = (a: Session, b: Session) => b.last_activity.localeCompare(a.last_activity) || a.id.localeCompare(b.id);
  if (orchestratorId) {
    const o = sessions[orchestratorId];
    if (!o) return groups;
    for (const owner of [o, ...forest.descendantsOf(o.id)]) {
      const rows = workersOf(owner.id);
      if (rows.length) groups.push({ key: owner.id, label: ownerLabel(owner), orchestrator: owner, rows });
    }
    return groups;
  }
  const all = Object.values(sessions);
  const inScope = (s: Session) => workspace === null || s.workspace === workspace;
  for (const owner of all.filter((o) => inScope(o) && workersOf(o.id).length > 0).sort(byActivity)) {
    groups.push({ key: owner.id, label: ownerLabel(owner), orchestrator: owner, rows: workersOf(owner.id) });
  }
  const leads = all.filter((s) => !forest.parentOf(s.id) && listable(s) && inScope(s));
  const orphans = leads.filter((s) => s.orchestrator_id && !forest.scheduledTaskOf(s)).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  if (orphans.length) groups.push({ key: ORPHANS_GROUP, label: "No orchestrator", orchestrator: null, rows: orphans });
  const runs = leads.filter((s) => forest.scheduledTaskOf(s)).sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
  if (runs.length) groups.push({ key: SCHEDULED_GROUP, label: "Scheduled runs", orchestrator: null, rows: runs });
  return groups;
}

/**
 * The rows checked when the dialog opens, and by "Select finished": idle,
 * finished, failed, exited and archived workers. Not one that works or waits
 * on the user, and nothing of a scheduled run.
 */
export function defaultPicks(groups: CleanupGroup[], sessions: Record<string, Session>): string[] {
  const forest = forestOf(sessions);
  return groups.filter((g) => g.key !== SCHEDULED_GROUP && g.key !== FAILED_GROUP).flatMap((g) => g.rows.filter((s) => finished(s) && !forest.scheduledTaskOf(s)).map((s) => s.id));
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
  const [failed, setFailed] = useState<Record<string, string>>({});
  // Failed sessions stay listed with their reason, wherever they are now.
  const groups = useMemo(() => cleanupGroups(sessions, orchestratorId ?? null, scope === "all" ? null : activeWorkspace, Object.keys(failed)), [sessions, orchestratorId, scope, activeWorkspace, failed]);
  const [picked, setPicked] = useState<string[]>(() => defaultPicks(groups, sessions));
  const [confirming, setConfirming] = useState(false);
  /** While deleting: every session the call deletes, trees included, to count down. */
  const [busy, setBusy] = useState<string[] | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The rows that can be picked: a failed row that became an orchestrator (or got workers) is shown, not picked.
  const listed = useMemo(() => new Set(groups.flatMap((g) => g.rows.filter((s) => !cleanupBlocker(s, sessions)).map((s) => s.id))), [groups, sessions]);
  // Picks of rows that went away (deleted elsewhere, or out of scope) do not count.
  const live = picked.filter((id) => listed.has(id));
  const targets = affected(live, sessions);
  const working = targets.filter((s) => s.status === "running").length;
  const waiting = targets.filter(waitsOnUser).length;
  const toggle = (ids: string[], on: boolean) => setPicked((cur) => (on ? [...new Set([...cur, ...ids])] : cur.filter((id) => !ids.includes(id))));

  const run = async (requested: string[]) => {
    // Checked again right before sending: a session that became an orchestrator since is not deleted with its tree.
    const fresh = useStore.getState().sessions;
    const ids = requested.filter((id) => fresh[id] && !cleanupBlocker(fresh[id], fresh));
    if (!client || !ids.length) return;
    setConfirming(false);
    setError(null);
    setSummary(null);
    setBusy(affected(ids, sessions).map((s) => s.id));
    try {
      const result = await client.deleteSessions(ids);
      const reasons = Object.fromEntries(result.failed.map((f) => [f.id, f.error]));
      if (!result.failed.length) {
        toast(`Deleted ${plural(result.deleted.length, "worker session")}`);
        close();
        return;
      }
      setFailed(reasons);
      // Deleted rows go; failed rows stay checked with their reason. Counts are in sessions, trees included.
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
  const failedIds = Object.keys(failed).filter((id) => sessions[id] && !cleanupBlocker(sessions[id], sessions));
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
          const ids = g.rows.filter((s) => listed.has(s.id)).map((s) => s.id);
          const on = ids.filter((id) => live.includes(id)).length;
          return (
            <div key={g.key} className="cleanup-group" role="group" aria-label={g.label}>
              <label className="cleanup-head">
                <input
                  type="checkbox"
                  data-autofocus={gi === 0 || undefined}
                  disabled={!!busy || !ids.length}
                  checked={ids.length > 0 && on === ids.length}
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
                const blocked = cleanupBlocker(s, sessions);
                const label = s.scheduled_task_id ? runLabel(s) : s.title;
                return (
                  <label key={s.id} className={clsx("cleanup-row", why && "failed")}>
                    <input type="checkbox" disabled={!!busy || !!blocked} checked={live.includes(s.id)} onChange={(e) => toggle([s.id], e.target.checked)} />
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
                    {blocked && <span className="dim cleanup-error">{blocked}</span>}
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
