# Workspaces, the status rail, and worker cleanup — design spec

Status: design, for implementation. Branch `feature/workspaces`, based on Aura 0.4.0.

## 1. Problem and goals

All sessions sit in one sidebar list (sectioned by state: *Waiting for you*,
*Working*, *Idle*, see `categoryOf` in `apps/desktop/src/state/store.ts`).
With several lines of work and orchestrators spawning workers, the user loses
track of which session is which.

Goals:

1. **Workspaces**: named containers the user works in. The sidebar shows one
   workspace at a time.
2. **Status rail**: a compact, always-visible block under the list that shows
   what needs the user, and what is idle, in *other* workspaces. Clicking a row
   jumps to it.
3. **Scheduled runs kept apart**: sessions started by a scheduled task never
   appear in *Waiting for you* / *Working* / *Idle*, neither in the list nor in
   the rail. They have their own clearly separated *Scheduled* section.
4. **Worker cleanup**: bulk-delete the worker sessions that agents started
   (`orchestrator_id` set), with one confirmation.

Non-goals: per-workspace settings, providers, or prompts. Nesting workspaces.
Changing what a group (`Session.group`) means.

## 2. Information architecture

```
Workspace  (new; every session is in exactly one)
 └─ Group  (existing Session.group, optional; unchanged)
     └─ Orchestrator → workers → sub-workers  (existing nesting)
Scheduled task  (existing; gets a workspace)
 └─ its runs (sessions with scheduled_task_id, plus workers under them)
```

- A **workspace** is `{ id, name, created_at, position }`. Names are unique
  (case-insensitive) and trimmed, 1–40 characters.
- `Session.workspace: string` (a workspace id). Required after migration.
- **Workers inherit** their orchestrator's workspace at creation (the same place
  where they already inherit `group`, `crates/aura-core/src/manager/orchestrator.rs`).
  Moving an orchestrator moves its whole tree (§4.6), so an orchestra never
  spans two workspaces.
- **Scheduled runs belong to the task's workspace.** `ScheduledTask.workspace`
  is set to the active workspace when the task is created, can be changed in
  the Schedules dialog, and is stamped onto each run. The *Scheduled* tab shows
  only the active workspace's runs. The rail's *Scheduled* block (§5.4) shows
  runs from every workspace.
- **Groups stay global.** Group names are shared across workspaces. The group
  picker suggests groups used in the current workspace first.
- **Active workspace** is UI state per window, saved in `localStorage`
  (`aura.workspace`), like `sidebarTab`. If the saved id is gone, fall back to
  the first workspace.

"Scheduled run" means: `scheduledTaskOf(s, sessions) !== null`. That is,
`scheduled_task_id` is set on the session or on one of its orchestrators, so
workers of a scheduled orchestrator count as part of the run. This is the
rule `tabOf` already uses.

## 3. Sidebar layout

```
┌───────────────────────────────┐
│ ▾ Aura client work      ● 2 ⋯ │  ← workspace switcher (new)
│ [Filter sessions  /    ] [ + ]│  ← existing head
│ [ Sessions | Scheduled ]      │  ← existing tabs, scoped to the workspace
│ WAITING FOR YOU               │
│  ● Fix login bug        2  1  │  ← existing list, active workspace only
│ WORKING …                     │
│ IDLE …                        │
│            (scrolls)          │
├───────────────────────────────┤  ← divider, rail is pinned (does not scroll)
│ ELSEWHERE                     │  ← status rail (new)
│  NEEDS YOU                    │
│   ● Review PR #12  · Infra  1 │
│   ● Spike caching  · R&D      │
│   + 3 more                    │
│  IDLE · 5                  ▸  │  ← folded by default
│ ─────────────                 │
│ SCHEDULED RUNS                │  ← separate block, own heading
│   ● Nightly deps · 03:00 ⚠    │
├───────────────────────────────┤
│ Scheduled tasks 4  next 03:00 │  ← existing ScheduleSidebar line
│ (mod sections)                │
└───────────────────────────────┘
```

The rail sits between the scrolling list and the existing `ScheduleSidebar`
line, so the bottom of the sidebar holds "everything outside the current
view".

### Current behaviour this builds on (checked in code)

- The Sessions tab already leaves scheduled runs out: `tabOf` puts them on the
  *Scheduled* tab, sectioned per task (`TASK_SECTION`), newest first. The
  state sections never contain them. **Keep that.**
- The Scheduled tab's button shows a pending badge, an attention marker, and a
  working dot while the tab is not shown (`selectTabActivity`). **Keep that,
  scoped to the active workspace.**
- The inbox (`⌘I`) still lists approvals and questions from scheduled runs. It
  is a queue of things to answer, not a status panel, so this is unchanged.

## 4. Workspace switcher

### 4.1 The control

One row at the top of the sidebar, above the filter:

- **Name button** (`▾ <name>`, truncated with a tooltip showing the full name).
  Opens the workspace menu. Accessible name: "Workspace: <name>. Switch
  workspace".
- **Other-workspaces summary**: if another workspace has something waiting,
  show the most urgent attention marker plus a badge with the summed
  `pending_count` across other workspaces. Use the same marker and badge
  components as `SidebarTabs`. Tooltip: "Other workspaces: 3 waiting on you".
  Scheduled runs are not counted here.
- **`⋯` button**: the workspace actions menu (rename, delete, clean up
  workers, new workspace).

### 4.2 Workspace menu (switch)

A listbox popover anchored to the name button. Keyboard: ↑/↓ to move, Enter to
switch, type-ahead filtering, Esc to close and return focus to the button.

Each row shows: name, session count (dim), working dot, attention marker,
pending badge. These follow `SectionHeading`'s folded style and exclude
scheduled runs. The active workspace is checked (✓ plus
`aria-selected`). Rows 1–9 show `⌃1`–`⌃9` hints. At the bottom: a divider,
then **New workspace…**.

Switching:

1. Sets the active workspace.
2. Selects the session last selected in that workspace (remembered per
   workspace in `localStorage`). If there is none, selects the first visible
   row. If the workspace is empty, shows the empty state (§4.8).
3. Clears the sidebar filter. Keeps the sidebar tab.
4. Main-area tabs: open tabs of sessions from other workspaces stay open. A
   tab is a session, not a view of the workspace. Products like VS Code also
   keep editors open across folder switches. The tab label gets a dim
   workspace suffix when its session is not in the active workspace.

`⌘1–9` (`session.select-nth`), `⌘[`/`⌘]`, and sidebar arrow navigation work
within the active workspace only, because they index `selectVisibleSessions`.
`⌘K` still searches every session. Picking one from another workspace switches
to that workspace (same rule as the rail, §5.3).

### 4.3 Create

Entry points: switcher menu **New workspace…**, `⋯` menu, the palette command
"Workspace: New…", or `leader k n`.

Dialog (reuse the `RenameDialog` shape):

- Title: **New workspace**
- Field label: **Name**, placeholder `e.g. Client X, Aura, Research`
- Buttons: **Create** (primary, disabled while the name is empty or
  duplicate), **Cancel**
- Inline errors: "A workspace with this name already exists." /
  "Name can't be empty."

On create: switch to the new workspace, which shows its empty state.

### 4.4 Rename

From `⋯ → Rename workspace…`, the palette command "Workspace: Rename…", or
`leader k r`. Same dialog: title **Rename workspace**, field prefilled and
selected, primary button **Rename**. Same validation as create.

### 4.5 Delete

From `⋯ → Delete workspace…`, the palette command, or `leader k d`. Disabled
(with tooltip "Aura needs at least one workspace") when only one workspace
exists.

- **Empty workspace**: use the `confirm` dialog. Title **Delete workspace**,
  message: "Delete the workspace “<name>”? It has no sessions." Button
  **Delete**.
- **Workspace with sessions or scheduled tasks**: a small dialog.
  - Title: **Delete “<name>”**
  - Text: "It holds 7 sessions and 1 scheduled task. Move them to:"
    `[workspace select, default: the first other workspace]`
  - Buttons: **Move and delete** (danger), **Cancel**
  - Sessions are **never deleted** by deleting a workspace. That keeps "no data
    loss" simple. Deleting the sessions is the cleanup flow's job, or the
    existing per-session delete.

After deletion, if it was the active workspace, switch to the target.

### 4.6 Move a session to another workspace

- Command **"Move to workspace…"** (`session.move-workspace`, `leader s v`,
  when `hasSelection`). Opens a `PickerDialog` listing the other workspaces
  plus **New workspace…**.
- On a **worker**, the command is disabled with the hint "Workers stay with
  their orchestrator. Move the orchestrator." This keeps orchestras whole.
- On an **orchestrator**, it moves the whole tree. The picker subtitle says
  "Moves <title> and its N workers."
- Archived sessions can be moved.
- After moving: toast "Moved “<title>” to <workspace>" with the action
  **Go there**. The selection moves to the next row in the current workspace.
- Drag-and-drop onto the switcher: not in v1 (see open question Q4).

### 4.7 Keyboard

| Keys | Command | Notes |
|---|---|---|
| `mod+shift+k` | `workspace.switch` | Opens the switcher menu. Free in `keymap/default.ts`. |
| `ctrl+1`–`ctrl+9` | `workspace.go-nth` | `mod`+digit selects sessions and `alt`+digit selects tabs, so ctrl is the free modifier (on macOS, ⌃ is distinct from ⌘). |
| `leader k` | group "Workspace" in WhichKey | `k` is free. `w` (inspector) and `s` are taken. |
| `leader k k` | switch | |
| `leader k n` | new | |
| `leader k r` | rename | |
| `leader k d` | delete | |
| `leader k c` | clean up workers (§6) | |
| `leader s v` | move session to workspace | `v` is free in the `s` group. |
| `leader o x` | clean up this orchestrator's workers | Next to Chat/Workers/Team. |

Every command is also in the palette, group "Workspace".

### 4.8 Empty states

- **Empty workspace, Sessions tab**: "No sessions in <name> yet." / "Press
  ⌘N to start one here." / button **Move sessions here…**, which opens a
  picker of sessions from other workspaces (top-level only).
- **Empty Scheduled tab**: keep today's copy, plus " in <name>".
- **Filter with no match**: today's "No sessions match." Add a secondary
  line when matches exist elsewhere: "3 match in other workspaces — ⌘K to
  search all."

## 5. Status rail

### 5.1 What is in it

It shows **other workspaces only.** The active workspace already shows these
same states as its own sections directly above, so repeating them would spend
the rail's few rows on duplicates. (This narrows the brief's "from any
workspace"; see open question Q1.)

Heading: **Elsewhere**. It is hidden entirely when there is exactly one
workspace. The *Scheduled runs* block (§5.4) is then still shown on its own.

| Block | Qualifies | Excludes |
|---|---|---|
| **Needs you** | `categoryOf(s) === "waiting"`: `pending_count > 0`, `waiting_approval` / `waiting_input`, or `attention` set (done / failed / waiting since last looked). Same rule as the list. | archived; scheduled runs |
| **Idle** | `categoryOf(s) === "idle"` | archived; scheduled runs; workers whose orchestrator is also idle (they show as `+N` on the orchestrator's row, like a collapsed orchestra) |
| Working | not listed. The count shows only on the switcher menu rows. | |

Rows are compact single lines: status dot · title · dim `· <workspace>` ·
attention marker · pending badge · relative time. They reuse the
`session-row` classes, without the second line.

### 5.2 Order, cap, overflow

- **Needs you**: ordered by urgency first (pending approvals/questions, then
  `attention: waiting`, then `failed`, then `done`), then most recent
  `last_activity`. Cap at **5 rows**, then a **"+ N more"** row that expands
  the block in place (and collapses with "Show less"). The cap stops the rail
  from pushing the list off-screen. The list region keeps a minimum of about
  40% of the sidebar height. Past that, the rail scrolls internally.
- **Idle**: a heading only, **folded by default** ("Idle · 5 ▸"). It reuses
  `SectionHeading`, and the fold state is remembered under
  `groupKey("rail", "idle")`. Unfolded, it is ordered by `last_activity`,
  most recent first, with the same 5-row cap and "+ N more".
- **When empty**: the *Needs you* block shows the single dim line "Nothing
  needs you elsewhere." The *Idle* block is hidden when its count is 0. The
  rail always keeps its heading, so the user learns where to look.

### 5.3 Interaction

- Click, or Enter on a focused row: switch to that row's workspace, select
  the session, and focus main. This is the same as `select(id)` plus a
  workspace switch. Opening clears its attention as today
  (`useMarkViewedSeen`), so it drops out of *Needs you*.
- Keyboard: the rail is part of the sidebar region. ↓ past the last list row
  moves into the rail, and ↑ moves back. Arrow-key **Home/End stay within
  the list**, so `⌘1–9` numbering is not disturbed. Rail rows have no digit
  hints.
- Rows carry `data-hint` for hint mode.
- Screen readers: the rail is `role="group"` with `aria-label="Other
  workspaces"`. Each row's label reads "<title>, <workspace>, <state>".
- New items arriving do not steal focus or re-order the row under the
  keyboard cursor while it is focused. Re-ordering is applied on blur.

### 5.4 Scheduled runs block

Scheduled runs are their own thing. Here they get a separately headed block
under a divider, never mixed into *Needs you* or *Idle*.

- Heading: **Scheduled runs**. Clicking the heading switches to the
  *Scheduled* tab.
- Lists runs from **every** workspace (including the active one) that are
  **working** or **need the user** (`categoryOf` is `waiting` or `working`).
  Idle, finished, and seen runs are not listed; the Scheduled tab has them.
- Row: dot · **task name** · dim run time (`03:00`, or relative time) ·
  workspace suffix if not the active workspace · attention marker · pending
  badge. Ordered: needs-you first (same urgency order as §5.2), then working
  by start time.
- Cap at 3 rows, then "+ N more", which opens the Scheduled tab.
- **When nothing qualifies**: the block is hidden. The `ScheduleSidebar` line
  ("Scheduled tasks 4 · next 03:00") right below already says scheduled work
  exists.
- Click a row: switch to its workspace, show the Scheduled tab, and select
  the run.

## 6. Worker cleanup

### 6.1 Entry points

| Where | Scope |
|---|---|
| Palette **"Clean up worker sessions…"** (`workers.cleanup`), `leader k c`, `⋯` workspace menu | all orchestrators in the **active workspace**. The dialog has a scope toggle "This workspace / All workspaces". |
| Palette **"Clean up this orchestrator's workers…"** (`workers.cleanup-orchestrator`, `when: hasSelection,orchestrator`), `leader o x` | the selected orchestrator only |
| Workers panel (`views/WorkerThreads.tsx`) header button **Clean up…** | that orchestrator |
| Sidebar orchestrator row: **"Clean up workers"** in the hover actions, when it has workers | that orchestrator |

There is no right-click context menu in Aura today. Do not add one just for
this feature; the entries above cover it.

### 6.2 The dialog

Reuse the shape of `GitCleanupDialog` (`components/dialogs/GitCleanupDialog.tsx`):
a checkbox list, footer actions, and an inline error.

```
Clean up worker sessions                          [This workspace ▾]
Delete worker sessions that agents started. Orchestrators are kept.

[☑] Feature: login revamp (orchestrator) · 4 of 5 selected   [Select finished]
    ☑ ○ UX designer        idle · 2 h ago
    ☑ ✓ Backend dev        finished · 3 h ago
    ☐ ● Frontend dev       working · now
    ☑ ✕ Tester             failed · 1 d ago
    ☑ ○ Researcher (+2 workers)   idle · 1 d ago
[☐] Scheduled runs · 0 of 6 selected
    ☐ Nightly deps · 03:00 today       finished
    …

         Worktrees and branches are kept.
         [Cancel]                            [Delete 4 sessions]
```

- **Groups**:
  - One group per orchestrator, ordered by most recent activity. The
    orchestrator's own row is a group header with a tri-state checkbox; it is
    never itself selectable for deletion.
  - Under it come its direct workers (`orchestrator_id === id`), oldest first
    (same as `useWorkers`).
  - **Sub-orchestrators** (a worker that orchestrates) are listed as a worker
    with "(+N workers)". Selecting one deletes its tree, which is existing
    daemon behaviour (see Q2).
  - Orphaned workers, whose orchestrator was deleted or failed to delete, go
    in a group **"No orchestrator"**.
- **Scheduled runs** are a separate last group, **"Scheduled runs"**. They are
  shown only in the global entry point, not in the per-orchestrator one. It
  lists top-level runs (their workers go with them, shown as "+N"), grouped
  by task name in the label, newest first. **Never preselected.**
- **Row**: status dot · title (specialist name if hired) · state word (idle /
  finished / failed / working / waiting on you / archived) · relative
  `last_activity`. State is always shown as a word too, so it is not carried
  by colour alone.
- **Defaults** (preselected):
  - idle, finished (`attention: done` or idle with no attention), failed,
    exited, error, and archived.
  - **Not preselected**: `running`; anything waiting on the user
    (`pending_count > 0`, `waiting_*`, `attention: waiting`); and all
    scheduled runs.
  - Waiting rows get a warning chip "waiting on you". Deleting one discards
    its open question or approval.
- **Bulk helpers**: the header checkbox per group; **Select finished**
  (re-applies the defaults); **Select none**.
- **Footer**: hint "Worktrees and branches are kept." Primary button **Delete
  N sessions** (danger style, disabled at 0). When the selection includes
  sub-orchestrator trees, the count includes their workers: "Delete 7
  sessions".
- Keyboard: Tab moves into the list, ↑/↓ move between rows, Space toggles,
  `⌘A` selects all visible, Enter on the primary button. Focus starts on the
  first group header.
- The list updates live. A worker that starts running while the dialog is
  open keeps its checkbox state but gets the "working" word. On delete it is
  still deleted if checked, because the user's choice stands. The
  confirmation (§6.3) shows the count of working sessions.

### 6.3 Confirmation

One confirm step, using the existing `confirm` dialog kind. It is skipped
when `settings.confirmDelete` is off, the same as `session.delete`.

- Title: **Delete N worker sessions**
- Message: "Delete N sessions and their history from Aura? The providers' own
  transcripts, worktrees and branches are kept." Then, when it applies, add a
  sentence: "2 of them are still working and will be stopped." /
  "1 waits on you; its question will be discarded."
- Buttons: **Delete** (danger), **Cancel** (default focus).

### 6.4 Result, errors, partial failure

- The dialog stays open with a busy state ("Deleting 3 of 7…"). It calls a
  bulk RPC (§9) that deletes each session independently and reports per id.
  `remove_worktree: false` throughout.
- **All succeeded**: the dialog closes. Toast: "Deleted 7 worker sessions".
- **Partial failure**: the dialog stays open. Deleted rows disappear, and
  failed rows stay checked with the reason inline in error colour (e.g.
  "Couldn't stop the process: …"). Banner: "Deleted 5. 2 couldn't be
  deleted." Buttons: **Retry failed**, **Close**.
- **Daemon unreachable / RPC error**: inline error "Couldn't delete: <message>".
  Nothing is removed client-side; the list re-syncs from session events.
- If the selected session or an open tab is deleted, it follows existing
  delete behaviour (the tab closes, and the selection moves).

### 6.5 Empty states

- No workers at all (in scope): "No worker sessions to clean up." / "Workers
  appear here when an orchestrator starts sessions." Single button **Close**.
- Workers exist but none finished (nothing preselected): the list is shown;
  the primary button is disabled with the tooltip "Select sessions to
  delete."
- Per-orchestrator entry with no workers: the command is disabled (its
  `when` requires workers), so the dialog never opens empty from there.

## 7. Migration and default workspace

- On daemon start, if no workspace exists, create **"Default"**
  (renameable, deletable once another exists). Every session with no
  `workspace` gets its id, and so does every scheduled task. This is
  idempotent; sessions are stored as a JSON column in the `sessions` table (`crates/aura-store`), so it is a serde
  default plus a one-time backfill, with no table change. Workspaces
  themselves live in `feature_records` under a new namespace (like `GROUPS`),
  or a new `workspaces` table via migration v5 — engineers' choice; the
  feature-record route needs no migration.
- No session changes group, order, pin, or archive state. On first launch the
  sidebar looks exactly as before, plus the switcher row reading "Default".
  The rail heading is hidden while only one workspace exists.
- Old clients against a new daemon ignore the extra field. A new client
  against an old daemon (`workspace.list` is unknown) hides the switcher and
  rail and treats everything as one workspace.
- Sessions created with no workspace (API callers, imports, old MCP tools) get
  the **daemon's** last-used workspace (see Q3), else Default.

## 8. Edge cases

- **New session** (`⌘N`, import, fork, new terminal): goes into the active
  workspace. `NewSessionDialog` shows "in <workspace>" in its subtitle. A
  fork goes to the source session's workspace.
- **Orchestrator starts a worker**: the worker inherits the orchestrator's
  workspace, even if the user is viewing another one. Its arrival shows in
  the rail if it needs the user.
- **Feature owners** and their team are all one orchestra, so they share one
  workspace.
- **Scheduled task fires** while its workspace is deleted: by then the task
  was moved (§4.5). If its workspace id is unknown anyway, the run goes to
  Default.
- **Long names**: workspace names are truncated with an ellipsis in the
  switcher, the rail suffix (max ~12ch), and tab suffixes, with the full name
  in a tooltip. Titles are truncated as today.
- **Many workspaces** (>9): the menu scrolls and type-ahead filters; only
  1–9 get `ctrl+digit`.
- **Archived sessions**: hidden from the rail; shown in the list only with
  "show archived", as today; offered in cleanup, preselected.
- **Multiple windows**: each window has its own active workspace. The
  workspace list syncs via daemon events.
- **Notification / waiting sound** for a session in another workspace: still
  plays (`state/waitingSound.ts`). Clicking the OS notification switches the
  workspace.
- **Inbox**: lists items from every workspace and scheduled runs. Each row
  gets a dim workspace label. Answering does not switch the workspace.

## 9. Implementation map

### Daemon (Rust)

- `crates/aura-core/src/types.rs`:
  - `Session.workspace: String` (serde default `""`, backfilled to Default at
    load).
  - New `Workspace { id, name, created_at, position }`, with `#[derive(TS)]`
    so it is exported to `apps/desktop/src/gen/Workspace.ts`.
  - `CreateSessionOpts.workspace: Option<String>`.
  - `ScheduledTask.workspace` / `ScheduledTaskInput.workspace`.
  - `BulkDeleteResult { deleted: Vec<String>, failed: Vec<(String, String)> }`.
- `crates/aura-core/src/manager.rs`:
  - Workspace registry next to the group registry (around `set_group` /
    `list_groups`): `list_workspaces`, `create_workspace`,
    `rename_workspace`, `delete_workspace(id, move_to)`,
    `set_session_workspace(id, ws)`, which also moves the tree via
    `with_workers`.
  - Default and backfill at startup, next to the existing `remember_group`
    pass.
  - `delete_many(ids, remove_worktree=false) -> BulkDeleteResult`, built on
    `delete` per id. A tree already deleted under an earlier id is skipped,
    not counted as failed.
- `crates/aura-core/src/manager/orchestrator.rs`: when creating a worker,
  copy `workspace` from the orchestrator (next to `group: orch.group.clone()`).
- `crates/aura-core/src/schedules.rs`: stamp `task.workspace` on runs (next to
  `group: task.group.clone()`).
- `crates/aura-rpc/src/server.rs`: new methods `workspace.list`,
  `workspace.create`, `workspace.rename`, `workspace.delete`,
  `session.set_workspace`, `session.delete_many`. New event
  `workspaces_changed`, or reuse a generic registry event if one exists.
  `session.create` honours `workspace`.
- Tests: `crates/aura-core/tests/manager.rs` cover backfill, worker
  inheritance, tree move, delete-with-move, and bulk delete with partial
  failure.

### Desktop (TS)

- `apps/desktop/src/lib/rpc.ts`: client methods for the above.
- `state/store.ts`:
  - `activeWorkspace` (persisted like `sidebarTab`), `workspaces`, and
    `lastSelectedByWorkspace`.
  - Filter `selectSessionSections` by `s.workspace === activeWorkspace`. This
    automatically scopes `⌘1–9`, `selectTabActivity`, and arrow navigation.
    `selectListedSessions` (⌘K) stays unscoped.
  - `select(id)` switches the workspace when needed.
  - New selectors `selectRail(st, viewedId)` and `selectScheduledRail(st)`,
    and per-workspace activity for the switcher.
  - New dialog kinds `workspace-edit`, `workspace-delete`,
    `workers-cleanup { orchestratorId?, scope }`.
- New `components/WorkspaceSwitcher.tsx`, `components/StatusRail.tsx`, and
  `components/dialogs/WorkersCleanupDialog.tsx` (+ tests next to them).
  Register them in `dialogRegistry.ts`.
- `components/Sidebar.tsx`: mount the switcher above `sidebar-head` and the
  rail between `session-list` and `ScheduleSidebar`; extend arrow navigation
  into the rail; add the empty-state copy (§4.8); add the "Clean up workers"
  row action on orchestrators.
- `commands/core.ts`: `workspace.*`, `session.move-workspace`,
  `workers.cleanup`, `workers.cleanup-orchestrator`.
  `keymap/default.ts`: the bindings in §4.7. WhichKey: label the `leader k`
  group "Workspace".
- `features/schedules/SchedulesDialog.tsx`: a **Workspace** select on the task
  form, defaulting to the active workspace.
- `components/dialogs/NewSessionDialog.tsx`: send the `workspace`; show the
  subtitle.
- `components/MainTabs.tsx`: workspace suffix on tabs of other workspaces.
- `components/dialogs/InboxDialog.tsx`: workspace label per row.
- Docs: `docs/protocol` for the new RPCs; README/help overlay for the
  shortcuts.

## 10. Open questions (with recommendation)

- **Q1. Should the rail repeat the active workspace's waiting/idle sessions?**
  The brief says "any workspace". Recommendation: **no, other workspaces
  only**. The list directly above is already sectioned by the same states.
  The exception is scheduled runs, which are shown from every workspace,
  because the Sessions list does not show them.
- **Q2. Sub-orchestrators in cleanup.** The brief says orchestrators are never
  listed. A worker that orchestrates is both. Recommendation: **list it as a
  worker with "(+N workers)", not preselected unless its whole tree is
  finished**. Top-level orchestrators are never listed.
- **Q3. Where do API/MCP-created sessions without a workspace go?**
  Recommendation: **the workspace most recently active in any window**. The
  daemon tracks it via a `workspace.touch` call on switch. This beats always
  using Default, which would silently scatter sessions.
- **Q4. Drag a session row onto the switcher to move it?** Recommendation:
  **not in v1**. The command, the picker, and the empty-state "Move sessions
  here…" cover moving. Drag adds a drop-target mode to the switcher for
  little gain. (Eldin decides.)
- **Q5. Should Idle in the rail be folded by default?** Recommendation:
  **yes**. Idle grows unbounded until cleanup. The count alone tells the user
  it is there.
