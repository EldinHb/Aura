import { useMemo, useState } from "react";
import type { Session, Workspace } from "../../gen";
import { Modal, KeyList, useListNav } from "../Modal";
import { useStore, isLeader, selectVisibleSessions } from "../../state/store";
import { useSchedules } from "../../features/schedules/state";
import { workersUnder } from "../../lib/sessionFolder";
import { filterItems } from "../palette";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Why `name` cannot name a workspace (other than `selfId`), or null when it can. */
export function workspaceNameError(name: string, workspaces: Workspace[], selfId?: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Name can't be empty.";
  if (trimmed.length > 40) return "Names are at most 40 characters.";
  if (workspaces.some((w) => w.id !== selfId && w.name.toLowerCase() === trimmed.toLowerCase())) return "A workspace with this name already exists.";
  return null;
}

/** Put a workspace the daemon returned into the list now, ahead of its `workspaces_changed` event. */
function remember(w: Workspace) {
  const st = useStore.getState();
  const list = st.workspaces.some((x) => x.id === w.id) ? st.workspaces.map((x) => (x.id === w.id ? w : x)) : [...st.workspaces, w];
  st.setWorkspaces(list);
}

/**
 * Create a workspace and switch to it, or rename workspace `id`. With
 * `moveSessionId` (from "Move to workspace… → New workspace…"), the new
 * workspace gets that session instead, and the toast offers to go there.
 */
export function WorkspaceEditDialog({ id, moveSessionId }: { id?: string; moveSessionId?: string }) {
  const workspaces = useStore((s) => s.workspaces);
  const client = useStore((s) => s.client);
  const closeDialog = useStore((s) => s.closeDialog);
  const current = id ? workspaces.find((w) => w.id === id) : undefined;
  const [value, setValue] = useState(current?.name ?? "");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const invalid = workspaceNameError(value, workspaces, id);
  const shownError = error ?? (touched || value ? invalid : null);
  const save = async () => {
    setTouched(true);
    if (invalid || !client || busy) return;
    setBusy(true);
    try {
      const w = id ? await client.renameWorkspace(id, value.trim()) : await client.createWorkspace(value.trim());
      remember(w);
      closeDialog();
      const moving = moveSessionId ? useStore.getState().sessions[moveSessionId] : undefined;
      if (!id && moving) await moveTo(moving, w).catch((e: unknown) => useStore.getState().toast(message(e), "error"));
      else if (!id) useStore.getState().switchWorkspace(w.id);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={id ? "Rename workspace" : "New workspace"}
      width={460}
      footer={
        <>
          <button type="button" className="btn" data-command="dialog.cancel" onClick={closeDialog}>Cancel</button>
          <button type="button" className="btn primary" data-command="dialog.confirm" disabled={!!invalid || busy} onClick={() => void save()}>{id ? "Rename" : "Create"} <kbd>↩</kbd></button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="workspace-name">Name</label>
        <input
          id="workspace-name"
          type="text"
          data-autofocus
          maxLength={60}
          placeholder="e.g. Client X, Aura, Research"
          value={value}
          aria-invalid={!!shownError}
          aria-describedby={shownError ? "workspace-name-error" : undefined}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          onFocus={(e) => e.target.select()}
          onBlur={() => setTouched(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            }
          }}
        />
        {shownError && <p id="workspace-name-error" role="alert" className="err-text">{shownError}</p>}
      </div>
    </Modal>
  );
}

/** Sessions (archived ones too) and scheduled tasks in workspace `id`. */
function useHeld(id: string): { sessions: number; tasks: number } {
  const sessions = useStore((s) => Object.values(s.sessions).filter((x) => x.workspace === id).length);
  const tasks = useSchedules((s) => s.tasks.filter((t) => t.workspace === id).length);
  return { sessions, tasks };
}

/** Delete workspace `id` (moving `moveTo` in, or nothing when empty) and leave it if it was the active one. */
export async function deleteWorkspace(id: string, moveTo: string | null) {
  const st = useStore.getState();
  if (!st.client) throw new Error("not connected to the daemon");
  const left = await st.client.deleteWorkspace(id, moveTo);
  const name = st.workspaces.find((w) => w.id === id)?.name ?? "workspace";
  const wasActive = st.activeWorkspace === id;
  st.setWorkspaces(left);
  if (wasActive) useStore.getState().switchWorkspace(moveTo ?? left[0]?.id ?? "");
  st.toast(`Deleted the workspace “${name}”`);
}

/** Open the right confirmation for deleting workspace `id`: a plain one when it is empty, else the move-to dialog. */
export function confirmDeleteWorkspace(id: string) {
  const st = useStore.getState();
  const w = st.workspaces.find((x) => x.id === id);
  if (!w) return;
  if (st.workspaces.length < 2) {
    st.toast("Aura needs at least one workspace", "warn");
    return;
  }
  const held = Object.values(st.sessions).some((s) => s.workspace === id) || useSchedules.getState().tasks.some((t) => t.workspace === id);
  if (held) {
    st.openDialog({ kind: "workspace-delete", id });
    return;
  }
  st.openDialog({
    kind: "confirm",
    title: "Delete workspace",
    message: `Delete the workspace “${w.name}”? It has no sessions.`,
    confirmLabel: "Delete",
    danger: true,
    onConfirm: () => void deleteWorkspace(id, null).catch((e: unknown) => useStore.getState().toast(message(e), "error")),
  });
}

/** Delete a workspace that holds sessions or scheduled tasks: they move to the workspace picked here first. */
export function WorkspaceDeleteDialog({ id }: { id: string }) {
  const workspaces = useStore((s) => s.workspaces);
  const closeDialog = useStore((s) => s.closeDialog);
  const w = workspaces.find((x) => x.id === id);
  const others = workspaces.filter((x) => x.id !== id);
  const [target, setTarget] = useState(others[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const held = useHeld(id);
  const parts = [held.sessions && `${held.sessions} ${held.sessions === 1 ? "session" : "sessions"}`, held.tasks && `${held.tasks} scheduled ${held.tasks === 1 ? "task" : "tasks"}`].filter(Boolean);
  const run = async () => {
    if (!target || busy) return;
    setBusy(true);
    try {
      await deleteWorkspace(id, target);
      closeDialog();
    } catch (e) {
      setError(`Couldn't delete: ${message(e)}`);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Delete “${w?.name ?? ""}”`}
      width={460}
      onSubmit={() => void run()}
      footer={
        <>
          <button type="button" className="btn" data-command="dialog.cancel" onClick={closeDialog}>Cancel</button>
          <button type="button" className="btn danger" data-command="dialog.confirm" disabled={!target || busy} onClick={() => void run()}>{busy ? "Moving…" : "Move and delete"} <kbd>⌘↩</kbd></button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="workspace-move-to">It holds {parts.join(" and ") || "nothing"}. Move them to:</label>
        <select id="workspace-move-to" data-autofocus value={target} onChange={(e) => setTarget(e.target.value)}>
          {others.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </div>
      <p className="dim">No session is deleted.</p>
      {error && <p role="alert" className="err-text">{error}</p>}
    </Modal>
  );
}

/** Move `session` with its workers to workspace `to`; the toast offers to go there. */
async function moveTo(session: Session, to: Workspace) {
  const st = useStore.getState();
  if (!st.client) throw new Error("not connected to the daemon");
  // The next row in this workspace takes the selection when the moved one was selected.
  const visible = st.selectedId === session.id ? selectVisibleSessions(st) : [];
  const at = visible.findIndex((s) => s.id === session.id);
  const next = at >= 0 ? visible[at + 1] ?? visible[at - 1] : undefined;
  const moved = await st.client.setWorkspace(session.id, to.id);
  for (const s of moved) useStore.getState().upsertSession(s);
  if (next) useStore.getState().select(next.id);
  st.toast(`Moved “${session.title}” to ${to.name}`, "info", { label: "Go there", run: () => useStore.getState().select(session.id) });
}

/** Pick the workspace to move a leader and its workers to, or make a new one. */
export function WorkspaceMoveDialog({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const sessions = useStore((s) => s.sessions);
  const workspaces = useStore((s) => s.workspaces);
  const closeDialog = useStore((s) => s.closeDialog);
  const toast = useStore((s) => s.toast);
  const [q, setQ] = useState("");
  const options = useMemo(() => [...workspaces.filter((w) => w.id !== session?.workspace), null], [workspaces, session]);
  const filtered = useMemo(() => filterItems(options, q, (w) => w?.name ?? "New workspace"), [options, q]);
  const workers = session ? workersUnder(session.id, sessions).length : 0;
  const pick = async (i: number) => {
    const w = filtered[i];
    if (!session) return;
    if (w === null) {
      useStore.getState().openDialog({ kind: "workspace-edit", moveSessionId: session.id });
      return;
    }
    if (!w) return;
    closeDialog();
    try {
      await moveTo(session, w);
    } catch (e) {
      toast(message(e), "error");
    }
  };
  const nav = useListNav(filtered.length, (i) => void pick(i));
  if (!session) return null;
  return (
    <Modal title={`Move to workspace · ${session.title}`} width={480} onKeyDown={(e) => nav.onKeyDown(e)}>
      {workers > 0 && <p className="dim" style={{ marginTop: 0 }}>Moves {session.title} and its {workers} {workers === 1 ? "worker" : "workers"}.</p>}
      <input type="text" data-autofocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" aria-label="Filter workspaces" />
      <div style={{ marginTop: 8 }}>
        <KeyList
          items={filtered.map((w) => ({ id: w?.id ?? "__new", command: "picker.apply", render: <span className="grow">{w ? w.name : "New workspace…"}</span> }))}
          index={nav.index}
          onSelect={nav.setIndex}
          onActivate={(i) => void pick(i)}
          empty="No other workspace"
        />
      </div>
    </Modal>
  );
}

/** Pick a top-level session from another workspace to move into the active one. */
export function WorkspaceGatherDialog() {
  const sessions = useStore((s) => s.sessions);
  const workspaces = useStore((s) => s.workspaces);
  const active = useStore((s) => s.activeWorkspace);
  const closeDialog = useStore((s) => s.closeDialog);
  const toast = useStore((s) => s.toast);
  const [q, setQ] = useState("");
  const names = useMemo(() => new Map(workspaces.map((w) => [w.id, w.name])), [workspaces]);
  const options = useMemo(
    () => Object.values(sessions).filter((s) => s.workspace !== active && isLeader(s, sessions)).sort((a, b) => b.last_activity.localeCompare(a.last_activity)),
    [sessions, active],
  );
  const filtered = useMemo(() => filterItems(options, q, (s) => `${s.title} ${names.get(s.workspace) ?? ""}`), [options, q, names]);
  const here = workspaces.find((w) => w.id === active);
  const pick = async (i: number) => {
    const s = filtered[i];
    if (!s || !here) return;
    try {
      const st = useStore.getState();
      if (!st.client) throw new Error("not connected to the daemon");
      for (const moved of await st.client.setWorkspace(s.id, here.id)) useStore.getState().upsertSession(moved);
      toast(`Moved “${s.title}” to ${here.name}`);
    } catch (e) {
      toast(message(e), "error");
    }
  };
  const nav = useListNav(filtered.length, (i) => void pick(i));
  return (
    <Modal
      title={`Move sessions to ${here?.name ?? "this workspace"}`}
      width={560}
      onKeyDown={(e) => nav.onKeyDown(e)}
      footer={<button type="button" className="btn" data-command="dialog.cancel" onClick={closeDialog}>Done</button>}
    >
      <p className="dim" style={{ marginTop: 0 }}>Enter moves a session here with its workers. Pick as many as you like.</p>
      <input type="text" data-autofocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" aria-label="Filter sessions" />
      <div style={{ marginTop: 8 }}>
        <KeyList
          items={filtered.map((s) => ({
            id: s.id,
            command: "picker.apply",
            render: (
              <>
                <span className="grow">{s.title}</span>
                <span className="dim">{names.get(s.workspace) ?? ""}</span>
              </>
            ),
          }))}
          index={nav.index}
          onSelect={nav.setIndex}
          onActivate={(i) => void pick(i)}
          empty="No sessions in other workspaces"
        />
      </div>
    </Modal>
  );
}
