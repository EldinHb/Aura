// Aura mod API (apiVersion 1), as one file for mods without a build step.
// Generated from Aura's packages/mod-sdk by gen-dts.mjs; do not edit.
//
// Use it from plain JavaScript with JSDoc:
//   /** @param {Aura.DaemonApi} aura */ export default function activate(aura) { ... }
//   /** @param {Aura.UiApi} ctx */      export default function activate(ctx) { ... }
// A jsconfig.json that includes this file gives editors completion and checks.

declare namespace Aura {
  /** React's component type, simplified: a function from props to an element. */
  export type ComponentType<P = {}> = (props: P) => any;

  // ---- Core types (sessions, events) ----
  export type Approval = { id: string, session_id: string, turn_id: string | null, item_id: string | null, kind: ApprovalKind, title: string, description: string | null, 
  /**
   * Kind specific payload: `{ command, cwd }`, `{ changes: [...] }`, `{ tool_name, input }`.
   */
  payload: Record<string, unknown>, options: Array<ApprovalOption>, created_at: string, };

  export type ApprovalDecision = { option: ApprovalOption, 
  /**
   * For `EditInput`: the modified tool input / command.
   */
  updated_input: Record<string, unknown> | null, 
  /**
   * Optional message to the agent (e.g. why declined).
   */
  message: string | null, };

  export type ApprovalKind = "command" | "file_change" | "permission" | "tool" | "generic";

  export type ApprovalOption = "accept" | "accept_for_session" | "decline" | "cancel" | "edit_input";

  export type AttendeeStatus = "invited" | "asked" | "answered" | "missing" | "late";

  /**
   * Why a session wants the user to look at it. Set when the agent stops and
   * kept until the user opens the session (see [`Session::attention`]).
   */
  export type Attention = "done" | "failed" | "waiting";

  /**
   * An autonomy level with the checkpoints it stops at. The checkpoints only
   * apply at [`AutonomyLevel::Checkpoints`].
   */
  export type Autonomy = { level: AutonomyLevel, checkpoints: Array<Checkpoint>, };

  export type AutonomyLevel = "autonomous" | "blocking_decisions" | "checkpoints";

  export type BranchStatus = { 
  /**
   * Checked-out branch; None on a detached HEAD.
   */
  branch: string | null, 
  /**
   * Commit HEAD points at; None before the first commit.
   */
  head: string | null, 
  /**
   * Tracked branch as git shows it, e.g. `origin/feature`.
   */
  upstream: string | null, 
  /**
   * Name of the tracked branch on its remote, e.g. `feature`.
   */
  upstream_branch: string | null, 
  /**
   * `owner/repo` of the GitHub remote the tracked branch lives on.
   */
  upstream_repo: string | null, 
  /**
   * Commits not yet pushed to the tracked branch.
   */
  ahead: number, 
  /**
   * Commits on the tracked branch not yet pulled.
   */
  behind: number, 
  /**
   * Files with uncommitted changes, untracked ones included.
   */
  changed: number, };

  /**
   * A point in a feature's life where the user can ask to review the work.
   */
  export type Checkpoint = "after_design" | "before_implementation" | "before_delivery";

  /**
   * A checkpoint the owner reached.
   */
  export type CheckpointRecord = { checkpoint: Checkpoint, summary: string, at: string, 
  /**
   * The review question, when the user's autonomy setting stops here.
   */
  question_id: string | null, 
  /**
   * The user's verdict on the review: approved, or changes asked for.
   * None while the review is open, and when no review was needed.
   */
  approved: boolean | null, };

  export type CreateSessionOpts = { provider: ProviderKind, 
  /**
   * ACP agent id, required when `provider` is `Acp`.
   */
  agent: string | null, 
  /**
   * Where the session works. Empty for an orchestrator gives it no folder
   * (see [`Session::folderless`]); for other sessions it means the daemon's
   * own directory.
   */
  cwd: string, title: string | null, group: string | null, 
  /**
   * Structured (default for AI providers) or Terminal.
   */
  mode: SessionMode | null, 
  /**
   * argv for terminal sessions. Defaults to the user's shell.
   */
  command: Array<string> | null, model: string | null, effort: string | null, permission_mode: string | null, sandbox_mode: string | null, worktree: WorktreeOpts | null, 
  /**
   * Sent as the first message once the session is up.
   */
  initial_prompt: string | null, 
  /**
   * Resume this native session instead of starting a new one.
   */
  resume_native_id: string | null, 
  /**
   * When resuming, fork into a new native session.
   */
  fork: boolean, 
  /**
   * This session's own system prompt (see [`Session::system_prompt`]).
   */
  system_prompt: string | null, 
  /**
   * See [`Session::orchestrator`].
   */
  orchestrator: boolean, 
  /**
   * See [`Session::orchestrator_id`].
   */
  orchestrator_id: string | null, 
  /**
   * See [`Session::feature_owner`]. Makes the session an orchestrator too.
   */
  feature_owner: boolean, 
  /**
   * For a feature owner: what the feature is for.
   */
  feature_goal: string | null, 
  /**
   * For a feature owner: the feature's own autonomy. None follows the
   * setting for every feature owner.
   */
  autonomy: Autonomy | null, };

  export type DecidedBy = "owner" | "user";

  export type Decision = { id: string, decision: string, rationale: string, decided_by: DecidedBy, 
  /**
   * The question it answered, for the user's decisions.
   */
  question_id: string | null, 
  /**
   * The meeting it came out of.
   */
  meeting_id: string | null, at: string, };

  export type DecisionOption = { label: string, description: string | null, };

  /**
   * What the user gets when the feature is done.
   */
  export type DeliveryReport = { 
  /**
   * What was done.
   */
  what: string, 
  /**
   * Why it was done this way: the decisions that shaped it.
   */
  why: string, 
  /**
   * Steps for the user to try it.
   */
  how_to_test: string, 
  /**
   * Where to test: branch, worktree, URL, screen.
   */
  where_to_test: string, 
  /**
   * Anything else: known limits, follow-ups the user may want.
   */
  notes: string, delivered_at: string, };

  /**
   * Normalized event stream. Every event carries `session_id` so clients can
   * route without inspecting the payload.
   */
  export type Event = { "type": "session_created", session: Session, } | { "type": "session_updated", session: Session, } | { "type": "session_removed", session_id: string, } | { "type": "turn_started", session_id: string, turn: Turn, } | { "type": "turn_completed", session_id: string, turn: Turn, } | { "type": "item_started", session_id: string, item: Item, } | { "type": "item_delta", session_id: string, item_id: string, delta: ItemDelta, } | { "type": "item_completed", session_id: string, item: Item, } | { "type": "approval_requested", session_id: string, approval: Approval, } | { "type": "approval_resolved", session_id: string, approval_id: string, decision: ApprovalDecision, } | { "type": "user_input_requested", session_id: string, request: UserInputRequest, } | { "type": "user_input_resolved", session_id: string, request_id: string, response: UserInputResponse, } | { "type": "notice", session_id: string, level: NoticeLevel, message: string, } | { "type": "provider_info", session_id: string, info: Record<string, unknown>, } | { "type": "native_id", session_id: string, native_id: string, } | { "type": "usage", session_id: string, usage: Usage, } | { "type": "process_exited", session_id: string, exit_code: number | null, message: string | null, } | { "type": "setting_changed", session_id: string, setting: Setting, } | { "type": "notices_cleared", session_id: string, } | { "type": "feature_updated", session_id: string, feature: Feature, } | { "type": "specialist_suggestions_updated", suggestions: Array<SpecialistSuggestion>, };

  export type Feature = { 
  /**
   * The feature owner's session id, which is also the record's id.
   */
  owner_id: string, goal: string, status: FeatureStatus, 
  /**
   * This feature's own autonomy; none follows the setting for all feature owners.
   */
  autonomy: Autonomy | null, 
  /**
   * This feature's own meeting mode; none follows the setting for all feature owners.
   */
  meeting_mode: MeetingMode | null, team: Array<TeamMember>, decisions: Array<Decision>, questions: Array<UserQuestion>, checkpoints: Array<CheckpointRecord>, suggestions: Array<SpecialistSuggestion>, meetings: Array<Meeting>, one_on_ones: Array<OneOnOne>, report: DeliveryReport | null, created_at: string, updated_at: string, 
  /**
   * The last number handed out per id prefix (`q` questions, `d`
   * decisions, `s` suggestions), so an id is never handed out twice, also
   * when a fork leaves out the questions still open.
   */
  counters: Record<string, number>, };

  export type FeatureStatus = "planning" | "in_progress" | "waiting_on_user" | "delivered";

  /**
   * A unit of work inside a turn. `text` accumulates streamed text (message,
   * reasoning). Kind specific structured data lives in `data`:
   *
   * - `command_exec`: `{ command, cwd?, output, exit_code?, duration_ms? }`
   * - `file_change`: `{ changes: [{ path, kind, diff? }] }`
   * - `tool_call`: `{ tool_name, input, result?, is_error? }`
   * - `plan`: `{ steps: [{ step, status }] }` or `{ text }`
   * - `subagent`: `{ description, agent_type? }`
   * - `web_search`: `{ query, results? }`
   * - `mcp_call`: `{ server, tool, input, result?, is_error? }`
   * - `error` / `system`: `{ message, level? }`
   */
  export type Item = { id: string, session_id: string, turn_id: string | null, kind: ItemKind, status: ItemStatus, title: string | null, text: string, data: Record<string, unknown>, 
  /**
   * For items produced by a subagent: the id of the parent `subagent` item.
   */
  parent_id: string | null, started_at: string, ended_at: string | null, };

  export type ItemDelta = { "kind": "text", text: string, } | { "kind": "output", text: string, } | { "kind": "data", data: Record<string, unknown>, };

  export type ItemKind = "user_message" | "agent_message" | "reasoning" | "tool_call" | "command_exec" | "file_change" | "plan" | "subagent" | "web_search" | "mcp_call" | "error" | "system";

  export type ItemStatus = "in_progress" | "completed" | "failed";

  /**
   * A meeting the owner held with `hold_meeting`. Written: every attendee is
   * sent the agenda and answers in writing, and the owner gets all answers in
   * one message from Aura. Live: a thread in rounds the owner chairs, in
   * which the attendees speak in turn (see [`crate::meetings`]).
   */
  export type Meeting = { id: string, topic: string, 
  /**
   * The question the attendees answer.
   */
  agenda: string, context: string, attendees: Array<MeetingAttendee>, status: MeetingStatus, 
  /**
   * The decisions the owner recorded from it: its outcome.
   */
  decision_ids: Array<string>, started_at: string, 
  /**
   * Answers not in by then are missing.
   */
  deadline: string, ended_at: string | null, 
  /**
   * The owner was sent the answers: for a live meeting, those of its
   * latest round.
   */
  delivered: boolean, mode: MeetingMode, 
  /**
   * For a live meeting: the round under way or last held, from 1.
   */
  round: number, 
  /**
   * For a live meeting: the most rounds it may have.
   */
  max_rounds: number, 
  /**
   * For a live meeting: about how many words each turn keeps to.
   */
  turn_words: number, 
  /**
   * For a live meeting: the thread, in order.
   */
  turns: Array<MeetingTurn>, 
  /**
   * What the chair closed the meeting with.
   */
  outcome: string | null, 
  /**
   * For a live meeting: the minutes each round waits for its turns.
   */
  timeout_minutes: number, 
  /**
   * For a live meeting: attendees gone for good (deleted, archived or
   * stopped by the user), who get no more turns.
   */
  left: Array<string>, };

  export type MeetingAttendee = { worker_id: string, 
  /**
   * The team member's name.
   */
  name: string, role: string, 
  /**
   * Hired just for this meeting.
   */
  guest: boolean, status: AttendeeStatus, 
  /**
   * What the attendee wrote: its final reply of the turn that answered.
   */
  answer: string | null, 
  /**
   * Why there is no answer.
   */
  missing: string | null, answered_at: string | null, };

  export type MeetingMode = "written" | "live";

  export type MeetingStatus = "collecting" | "complete" | "incomplete" | "waiting_on_chair";

  /**
   * One entry in a live meeting's thread: an attendee's turn, or the steer
   * with which the chair opens a round after the first.
   */
  export type MeetingTurn = { 
  /**
   * The round, from 1.
   */
  round: number, 
  /**
   * The attendee, or the owner for the chair's steer.
   */
  worker_id: string, name: string, role: string, 
  /**
   * The chair's steer, not an attendee's turn.
   */
  chair: boolean, 
  /**
   * Invited until it is this attendee's turn and it is free; asked once sent.
   */
  status: AttendeeStatus, text: string | null, 
  /**
   * Why there is no turn.
   */
  missing: string | null, at: string | null, };

  export type ModelInfo = { id: string, display_name: string, description: string | null, efforts: Array<string>, default_effort: string | null, is_default: boolean, };

  export type NoticeLevel = "info" | "warn" | "error";

  /**
   * A question one team member put to another, or to the owner, with
   * `ask_teammate` or `ask_owner`.
   */
  export type OneOnOne = { id: string, 
  /**
   * The worker that asked.
   */
  from_id: string, from_name: string, 
  /**
   * The teammate asked, or the owner's id when the owner was asked.
   */
  to_id: string, to_name: string, 
  /**
   * The owner was asked, not a teammate.
   */
  to_owner: boolean, question: string, answer: string | null, 
  /**
   * Why no answer will come.
   */
  error: string | null, status: OneOnOneStatus, asked_at: string, answered_at: string | null, 
  /**
   * The one asked was sent the question.
   */
  sent: boolean, 
  /**
   * The asker was sent the answer, or told none will come.
   */
  delivered: boolean, };

  export type OneOnOneStatus = "open" | "answered" | "failed";

  export type ProviderKind = "claude" | "codex" | "acp" | "terminal";

  export type Question = { id: string, header: string | null, question: string, options: Array<QuestionOption>, multi_select: boolean, allow_free_text: boolean, 
  /**
   * The answer is a secret (a password, a token): typed hidden, and kept
   * out of the stored event log.
   */
  secret: boolean, };

  export type QuestionAnswer = { 
  /**
   * The option the user picked, if any.
   */
  option: string | null, 
  /**
   * What the user wrote, besides or instead of an option.
   */
  text: string, at: string, 
  /**
   * The owner was sent the answer.
   */
  delivered: boolean, };

  export type QuestionKind = "decision" | "irreversible" | "checkpoint";

  export type QuestionOption = { label: string, description: string | null, };

  export type Session = { id: string, provider: ProviderKind, 
  /**
   * For `ProviderKind::Acp`: the id of the ACP agent (see [`AgentInfo`]).
   */
  agent: string | null, 
  /**
   * The provider's own identifier (Claude session id, Codex thread id). None until known.
   */
  native_id: string | null, cwd: string, worktree: WorktreeInfo | null, title: string, group: string | null, status: SessionStatus, mode: SessionMode, model: string | null, effort: string | null, permission_mode: string | null, sandbox_mode: string | null, 
  /**
   * Command for terminal sessions (argv). For structured sessions this is the
   * command used when switching to terminal mode.
   */
  command: Array<string> | null, created_at: string, last_activity: string, archived: boolean, pinned: boolean, usage: Usage, 
  /**
   * Last error message when status == Error.
   */
  last_error: string | null, 
  /**
   * Number of approvals / inputs currently waiting for the user.
   */
  pending_count: number, 
  /**
   * Exit code for exited terminal sessions.
   */
  exit_code: number | null, 
  /**
   * The user's system prompt for this session, added after the global and
   * per-agent prompts. Takes effect the next time the agent starts.
   */
  system_prompt: string | null, 
  /**
   * This session orchestrates other sessions: it gets Aura's orchestration
   * tools and receives a report whenever one of its workers stops.
   */
  orchestrator: boolean, 
  /**
   * The orchestrator that started this session, if any.
   */
  orchestrator_id: string | null, 
  /**
   * An orchestrator that owns one feature end to end (see
   * [`crate::features`]): it gets the feature owner's prompt and tools on
   * top of an orchestrator's. Always an orchestrator too.
   */
  feature_owner: boolean, 
  /**
   * For a worker a feature owner hired as a specialist: the specialist's
   * id, whose instructions the worker's system prompt gets.
   */
  specialist_id: string | null, 
  /**
   * The specialist's name as it was when hired, for labels.
   */
  specialist_name: string | null, 
  /**
   * An orchestrator that belongs to no folder of the user's. It runs in a
   * directory Aura made for it (`cwd`) and names a folder for each worker.
   */
  folderless: boolean, 
  /**
   * What happened since the user last opened the session, if anything.
   * Cleared by [`crate::Manager::mark_seen`]. A `Waiting` one also ends
   * once nothing waits any more, e.g. after an answer from the inbox.
   */
  attention: Attention | null, 
  /**
   * The scheduled task that started this session, if one did. Set by the
   * scheduler (see [`crate::schedules`]); kept after the task is deleted.
   */
  scheduled_task_id: string | null, 
  /**
   * That task's name when it started the session, for labels.
   */
  scheduled_task_name: string | null, };

  export type SessionMode = "structured" | "terminal";

  export type SessionStatus = "idle" | "running" | "waiting_approval" | "waiting_input" | "error" | "exited";

  export type Setting = { "kind": "model", "value": string } | { "kind": "effort", "value": string } | { "kind": "permission_mode", "value": string } | { "kind": "sandbox_mode", "value": string };

  /**
   * A specialist as the user (or an accepted suggestion) saves it. An empty
   * `id` is made from the name.
   */
  export type SpecialistInput = { id: string, name: string, role: string, description: string, instructions: string, agent: string | null, model: string | null, effort: string | null, scope: SpecialistScope, project: string | null, };

  export type SpecialistScope = "global" | "project";

  /**
   * A specialist the owner proposed with `propose_specialist`.
   */
  export type SpecialistSuggestion = { id: string, specialist: SpecialistInput, 
  /**
   * Why the team needs it.
   */
  reason: string, status: SuggestionStatus, 
  /**
   * The id of the specialist created when the user accepted it.
   */
  accepted_id: string | null, created_at: string, resolved_at: string | null, 
  /**
   * The owner was told what became of it.
   */
  delivered: boolean, 
  /**
   * For a suggestion Aura found in repeated ad-hoc work rather than one
   * the owner proposed: the briefs it found the role in.
   */
  evidence: Array<SuggestionEvidence>, 
  /**
   * For a suggestion Aura found: the feature owner whose chat shows it,
   * when it was found for one.
   */
  owner_id: string | null, };

  /**
   * One of the briefs a suggestion was found in.
   */
  export type SuggestionEvidence = { owner_id: string, worker_id: string, 
  /**
   * The feature's goal, shortened.
   */
  feature: string, title: string, summary: string, project: string, };

  export type SuggestionStatus = "pending" | "accepted" | "dismissed";

  /**
   * A worker on the feature's team.
   */
  export type TeamMember = { worker_id: string, 
  /**
   * The specialist it was hired as; none for an ad-hoc worker.
   */
  specialist_id: string | null, 
  /**
   * The specialist's name, or the worker's title for an ad-hoc worker.
   */
  name: string, role: string, 
  /**
   * The specialist's instructions as they were when it was hired, used
   * when the specialist is deleted later.
   */
  instructions: string, hired_at: string, 
  /**
   * Hired as a guest of this meeting, for its input only.
   */
  meeting: string | null, };

  export type Turn = { id: string, session_id: string, status: TurnStatus, started_at: string, ended_at: string | null, usage: Usage | null, error: string | null, };

  export type TurnStatus = "running" | "completed" | "interrupted" | "failed";

  export type Usage = { input_tokens: number, output_tokens: number, cached_input_tokens: number, total_cost_usd: number | null, context_window: number | null, context_used: number | null, 
  /**
   * The token counts are the conversation's running totals as the agent
   * reports them, so a later report can be measured against them. Usage
   * stored before Aura kept totals, and a turn's own usage, lack it.
   */
  running_totals: boolean, };

  export type UserInputRequest = { id: string, session_id: string, turn_id: string | null, item_id: string | null, questions: Array<Question>, created_at: string, };

  export type UserInputResponse = { request_id: string, 
  /**
   * question id -> selected labels / free text
   */
  answers: { [key in string]?: Array<string> }, 
  /**
   * The user dismissed the question without answering; `answers` is empty.
   * Claude is told so in a denied tool result. Codex has no way to say it:
   * it gets no answers, which its own instructions read as "carry on with
   * best judgment, do not ask again".
   */
  declined: boolean, };

  /**
   * A question the owner put to the user with `ask_user` or `checkpoint`.
   */
  export type UserQuestion = { id: string, question: string, 
  /**
   * What the user needs to know to decide.
   */
  context: string, options: Array<DecisionOption>, 
  /**
   * The label of the option the owner recommends.
   */
  recommended: string | null, kind: QuestionKind, 
  /**
   * For a checkpoint review: which one.
   */
  checkpoint: Checkpoint | null, asked_at: string, answer: QuestionAnswer | null, 
  /**
   * No longer open without an answer: the feature was delivered.
   */
  withdrawn: boolean, };

  export type WorktreeInfo = { repo_root: string, path: string, branch: string, };

  export type WorktreeOpts = { 
  /**
   * Branch to create (or reuse) for the worktree.
   */
  branch: string, 
  /**
   * Base ref to branch from. Defaults to HEAD.
   */
  base: string | null, 
  /**
   * Directory in which to create the worktree. Defaults to `<repo>/.aura-worktrees/<branch>`.
   */
  path: string | null, };

  export type CoreEvent = Event;

  // ---- mod.json ----
  // mod.json. aurad validates it (crates/aura-mods/src/manifest.rs); keep the two in step.

  export interface ModPermissions {
    /** Programs the daemon half may run through aura.process.run. */
    process?: string[];
    /** Hosts aura.http.fetch may reach. "*.example.com" matches subdomains. */
    net?: string[];
    sessions?: "none" | "read" | "write";
    git?: boolean;
    agents?: boolean;
    orchestratorTools?: boolean;
    /** Other mods this one may call and listen to. */
    mods?: string[];
  }

  export interface ModSetting {
    key: string;
    type: "string" | "number" | "boolean" | "select" | "string[]";
    label: string;
    description?: string;
    default?: unknown;
    options?: Array<{ value: string; label: string }>;
  }

  export interface ModManifest {
    id: string;
    name: string;
    version: string;
    apiVersion: 1;
    description?: string;
    author?: string;
    daemon?: string;
    ui?: string;
    styles?: string;
    dependsOn?: Record<string, string>;
    permissions?: ModPermissions;
    settings?: ModSetting[];
  }

  // ---- The daemon half: activate(aura: DaemonApi) ----
  // The API a mod's daemon half receives in `activate(aura)`.
  //
  // The daemon half runs inside aurad in a QuickJS runtime of its own. It has
  // no Node APIs and no ambient file or network access: everything goes through
  // `aura`, and what `aura` lets it do is limited by the permissions in mod.json.
  //
  // Available globals besides `aura`: setTimeout/clearTimeout,
  // setInterval/clearInterval, queueMicrotask, console, TextEncoder/TextDecoder,
  // URL, URLSearchParams, atob/btoa, structuredClone, crypto.randomUUID.


  export type Disposer = () => void;
  export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

  /** Who called an `aura.rpc.handle` method. */
  export type Caller =
    | { kind: "user" } // the desktop app or the `aura` CLI
    | { kind: "mod"; id: string } // another mod through aura.mods.call
    | { kind: "session"; sessionId: string }; // an orchestrator tool call

  /** Error thrown by host calls. `code` is stable; `message` is for people. */
  export interface HostError extends Error {
    code:
      | "permission_denied"
      | "not_found"
      | "invalid"
      | "timeout"
      | "failed"
      | "unavailable";
  }

  export interface ModInfo {
    id: string;
    version: string;
    /** `<data dir>/mod-data/<id>/`, created on first use. The mod's own writable directory. */
    dataDir: string;
    /** Platform aurad runs on. */
    platform: "windows" | "macos" | "linux";
  }

  export interface Collection<T = Json> {
    get(id: string): Promise<T | undefined>;
    put(id: string, doc: T): Promise<void>;
    delete(id: string): Promise<void>;
    all(): Promise<Array<[string, T]>>;
    /** Removes every document in the collection. */
    clear(): Promise<void>;
  }

  export interface Storage {
    /** Small values (settings, cursors, snapshots). */
    kv: {
      get<T = Json>(key: string): Promise<T | undefined>;
      set(key: string, value: unknown): Promise<void>;
      delete(key: string): Promise<void>;
      keys(prefix?: string): Promise<string[]>;
    };
    /** Named document collections. */
    collection<T = Json>(name: string): Collection<T>;
  }

  export interface Settings {
    /** Current value of a setting declared in mod.json (its default when unset). */
    get<T = Json>(key: string): T;
    all(): Record<string, Json>;
    set(key: string, value: unknown): Promise<void>;
    onChange(fn: (key: string, value: Json) => void): Disposer;
  }

  export interface SessionData {
    get<T = Json>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    /** Every key this mod stored for the session. */
    all(): Promise<Record<string, Json>>;
  }

  export interface Sessions {
    list(): Promise<Session[]>;
    get(id: string): Promise<Session | null>;
    /** The agent's last complete reply, if any. */
    lastReply(id: string): Promise<string | null>;
    /** Start a session. Needs `sessions: "write"`. */
    create(opts: CreateSessionOpts): Promise<Session>;
    /**
     * Send a message to a session's agent. With `whenFree`, the message is
     * delivered once the agent finishes its current turn (and the call resolves
     * then). Needs `sessions: "write"`.
     */
    send(id: string, text: string, opts?: { whenFree?: boolean }): Promise<void>;
    interrupt(id: string): Promise<void>;
    stop(id: string): Promise<void>;
    /** Data this mod keeps per session; deleted with the session. */
    data(id: string): SessionData;
    /** Session ids that have data from this mod for `key`, with the value. */
    withData<T = Json>(key: string): Promise<Array<[string, T]>>;
  }

  export interface GitRemote {
    name: string;
    url: string;
  }

  export interface Git {
    repoRoot(cwd: string): Promise<string>;
    mainRepoRoot(cwd: string): Promise<string>;
    currentBranch(cwd: string): Promise<string | null>;
    remotes(cwd: string): Promise<GitRemote[]>;
    /** `git.branch_status` from core. */
    branchStatus(cwd: string): Promise<Json>;
    /** Run git with these args in `cwd`. Resolves with stdout; rejects on a non-zero exit. */
    run(
      cwd: string,
      args: string[],
      opts?: { okCodes?: number[]; timeoutMs?: number; env?: Record<string, string | null>; stdin?: string },
    ): Promise<string>;
  }

  /**
   * Files in the mod's own data folder (`aura.mod.dataDir`). Paths are relative
   * to it (or absolute inside it); anything outside is refused.
   */
  export interface Fs {
    exists(path: string): Promise<boolean>;
    readText(path: string): Promise<string>;
    /** Creates missing parent folders. */
    writeText(path: string, text: string): Promise<void>;
    mkdir(path: string): Promise<void>;
    /** A file or a whole folder; nothing when it does not exist. */
    remove(path: string): Promise<void>;
    rename(path: string, to: string): Promise<void>;
    list(path: string): Promise<Array<{ name: string; dir: boolean }>>;
  }

  export interface ProcessResult {
    code: number;
    stdout: string;
    stderr: string;
  }

  export interface Process {
    /**
     * Run a program listed in `permissions.process`, found the way Aura finds
     * CLIs (PATH plus the usual install directories). No window is shown on
     * Windows. Rejects only when the program cannot be started or times out.
     */
    run(
      bin: string,
      args: string[],
      opts?: {
        cwd?: string;
        env?: Record<string, string | null>; // null removes a variable
        stdin?: string;
        timeoutMs?: number; // default 60s
      },
    ): Promise<ProcessResult>;
  }

  export interface HttpResponse {
    status: number;
    ok: boolean;
    headers: Record<string, string>; // lower-case names
    text: string;
    json<T = Json>(): T;
    /** True when the answer came from the ETag cache (`cache: "etag"`). */
    cached: boolean;
  }

  export interface Http {
    /** Requests to hosts listed in `permissions.net`. Bodies are text. */
    fetch(
      url: string,
      init?: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
        timeoutMs?: number; // default 30s
        /** Revalidate with the ETag of an earlier 200 for the same URL and auth. */
        cache?: "etag";
      },
    ): Promise<HttpResponse>;
  }

  export interface AgentRunOptions {
    provider: "claude" | "codex";
    model?: string;
    effort?: string;
    /** Sent on stdin. */
    prompt: string;
    cwd: string;
    /** JSON schema the answer must match. The parsed answer is in `output`. */
    jsonSchema?: Json;
    /**
     * `read-only` (default): the agent may read files only.
     * The agent never gets GitHub credentials, MCP servers or web access.
     */
    access?: "read-only";
    timeoutMs?: number; // default 30 min
    /** Lets `aura.agents.cancel(id)` stop the run (it then rejects with code "cancelled"). */
    id?: string;
    onProgress?: (line: string) => void;
  }

  export interface AgentRunResult {
    /** The schema-constrained answer, when `jsonSchema` was given. */
    output: Json | null;
    /** The agent's final text answer. */
    text: string;
    /** The exact model that ran, when the CLI reports it. */
    modelId: string | null;
  }

  export interface Agents {
    providers(): Promise<Array<{ kind: string; available: boolean; version: string | null }>>;
    models(provider: string): Promise<Json[]>;
    /** One headless agent run. Needs `permissions.agents`. */
    runOnce(opts: AgentRunOptions): Promise<AgentRunResult>;
    /** Stop a run started with this `id`; resolves false when none was running. */
    cancel(id: string): Promise<boolean>;
  }

  export interface ToolDef {
    /** Becomes `<modId>_<name>` for the agent. [a-z0-9_]+ */
    name: string;
    description: string;
    inputSchema: Json;
    /** MCP tool annotations, e.g. { readOnlyHint: true } or { destructiveHint: true }. */
    annotations?: Record<string, Json>;
  }

  export interface Orchestrator {
    /**
     * An MCP tool offered to orchestrator sessions. `fn` gets the calling
     * orchestrator's session id. Needs `permissions.orchestratorTools`.
     */
    tool(def: ToolDef, fn: (args: any, ctx: { sessionId: string }) => unknown): Disposer;
  }

  export interface InboxItem {
    id: string;
    title: string;
    detail?: string;
    /** ISO time. */
    at: string;
    unread: boolean;
    /** Passed to the UI half's inbox renderer when opened. */
    data?: Json;
  }

  export interface DaemonApi {
    readonly mod: ModInfo;
    rpc: {
      /**
       * Expose `mod.<id>.<name>` to the desktop, the CLI and (with permission)
       * other mods. The return value is sent as JSON.
       */
      handle(name: string, fn: (params: any, caller: Caller) => unknown): Disposer;
    };
    /** Broadcast `mod.<id>.<name>` to connected UIs. */
    emit(name: string, payload?: unknown): void;
    storage: Storage;
    settings: Settings;
    events: {
      /** Core events (needs `sessions: "read"`). `"*"` receives all of them. */
      on<K extends CoreEvent["type"] | "*">(
        type: K,
        fn: (event: K extends "*" ? CoreEvent : Extract<CoreEvent, { type: K }>) => void,
      ): Disposer;
    };
    sessions: Sessions;
    git: Git;
    process: Process;
    http: Http;
    agents: Agents;
    fs: Fs;
    orchestrator: Orchestrator;
    mods: {
      /** Call another mod's rpc method. Needs the mod in `permissions.mods`. */
      call<T = Json>(modId: string, name: string, params?: unknown): Promise<T>;
      /** Notifications another mod emits (needs the mod in `permissions.mods`). */
      on(modId: string, name: string, fn: (payload: any) => void): Disposer;
    };
    inbox: {
      /** Replace this mod's items in Aura's inbox. */
      set(items: InboxItem[]): Promise<void>;
    };
    /** A desktop notification. Clicking it calls the UI half's `onNotificationClick` with `target`. */
    notify(opts: { title: string; body?: string; target?: Json }): void;
  }

  /** What `daemon.js` default-exports. May return a deactivate function. */
  export type DaemonActivate = (
    aura: DaemonApi,
  ) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;

  export function defineDaemon(activate: DaemonActivate): DaemonActivate;

  // ---- The UI half: activate(ctx: UiApi) ----
  // The API a mod's UI half receives in `activate(ctx)`.
  //
  // The UI half is an ES module loaded into Aura's window. It shares Aura's
  // React and zustand: import them normally ("react", "zustand"); the SDK's
  // build maps those imports to Aura's own copies. Aura's reusable components
  // and hooks come from "@aura/host" (see ./host.ts).
  //
  // The UI half is NOT sandboxed: it runs with the same rights as Aura's own
  // interface. Keep secrets (tokens) in the daemon half.



  export interface CommandDef {
    /** Prefixed with "<modId>." automatically unless it already is. */
    id: string;
    title: string;
    group: string;
    keywords?: string[];
    /** A `when` expression: comma-separated terms that must all hold, e.g. "focus:sidebar, !inputFocused, mod.github.prSelected". */
    when?: string;
    hidden?: boolean;
    run: (arg?: unknown) => void | Promise<void>;
  }

  export interface KeyBindingDef {
    /** "mod+k", "g p", "leader p r" … */
    keys: string;
    /** Full command id (a mod's own commands are "<modId>.<id>"). */
    command: string;
    when?: string;
    arg?: unknown;
    label?: string;
  }

  /** Props of a sidebar section component. */
  export interface SidebarSectionProps {
    /** Whether keyboard focus is in the sidebar. */
    focused: boolean;
  }

  /** Props of an inspector section; it renders for the selected session. */
  export interface InspectorSectionProps {
    session: Session;
  }

  export interface SessionRowProps {
    session: Session;
    selected: boolean;
  }

  export interface BranchDecorationProps {
    /** Folder of the session the branch status belongs to. */
    cwd: string;
    /** Core's git branch status (`git.branch_status`). */
    status: Json;
    /** "statusbar" | "inspector" | "row" */
    place: "statusbar" | "inspector" | "row";
    session: Session | null;
  }

  export interface NewSessionFieldProps {
    cwd: string | null;
    /** Contribute text that is appended to the new session's first prompt, and links to store. */
    onChange(contribution: { prompt?: string; data?: Json } | null): void;
  }

  export interface ViewProps<P = any> {
    props: P;
    /** Closes the view's tab. */
    close(): void;
    /**
     * Whether the view's tab is the one shown. Views stay mounted while another
     * tab shows (so they keep their state); a view that drives shared state should
     * only do so while active.
     */
    active?: boolean;
  }

  export interface DialogProps<P = any> {
    props: P;
    close(): void;
  }

  export interface InboxItemProps {
    item: { id: string; title: string; detail?: string; at: string; unread: boolean; data?: Json };
  }

  export interface TranscriptLink {
    /** Shown as a chip, e.g. "#123" or "owner/repo#45". */
    label: string;
    url: string;
    kind: string;
  }

  export interface UiApi {
    readonly mod: { id: string; version: string };
    /** Call `mod.<id>.<name>` on this mod's daemon half. */
    rpc<T = any>(name: string, params?: unknown): Promise<T>;
    /** Call another mod's daemon method (`mod.<modId>.<name>`). */
    call<T = any>(modId: string, name: string, params?: unknown): Promise<T>;
    /** Notifications `mod.<id>.<name>` from this mod's daemon half. */
    on(name: string, fn: (payload: any) => void): Disposer;
    /** Notifications from another mod. */
    onMod(modId: string, name: string, fn: (payload: any) => void): Disposer;
    /** Fires with "open" every time the daemon connection (re)opens. */
    onConnection(fn: (state: "open" | "closed" | "connecting") => void): Disposer;
    /** Aura's core RPC client (same object Aura uses). */
    client: { call<T = any>(method: string, params?: unknown): Promise<T> };
    /** localStorage namespaced to "aura.mod.<id>.". */
    storage: {
      get<T = any>(key: string): T | undefined;
      set(key: string, value: unknown): void;
      delete(key: string): void;
    };
    settings: {
      get<T = Json>(key: string): T;
      set(key: string, value: unknown): Promise<void>;
      onChange(fn: (key: string, value: Json) => void): Disposer;
    };

    commands: { register(cmd: CommandDef): Disposer; run(id: string, arg?: unknown): void };
    keys: {
      bind(binding: KeyBindingDef): Disposer;
      /** Which-key label for a sequence prefix, e.g. group("leader p", "Pull requests"). */
      group(prefix: string, label: string): Disposer;
    };
    /** `when` context keys, readable as "mod.<id>.<key>". */
    context: { set(key: string, value: boolean | string | number | null): void };

    ui: {
      sidebarSection(def: { id: string; title?: string; order?: number; component: ComponentType<SidebarSectionProps> }): Disposer;
      inspectorSection(def: { id: string; order?: number; component: ComponentType<InspectorSectionProps> }): Disposer;
      sessionRowChips(def: { id: string; order?: number; component: ComponentType<SessionRowProps> }): Disposer;
      branchDecoration(def: { id: string; component: ComponentType<BranchDecorationProps> }): Disposer;
      statusBarItem(def: { id: string; order?: number; component: ComponentType<{}> }): Disposer;
      settingsTab(def: { id: string; title: string; component: ComponentType<{}> }): Disposer;
      newSessionField(def: { id: string; component: ComponentType<NewSessionFieldProps> }): Disposer;
      inboxRenderer(def: { component: ComponentType<InboxItemProps>; open?(item: InboxItemProps["item"]): void }): Disposer;
      transcriptLinks(def: { id: string; detect(text: string, session: Session): TranscriptLink[] }): Disposer;
      /** A full main-area view, opened with `openView`. */
      view(def: { id: string; title: string; component: ComponentType<ViewProps> }): Disposer;
      dialog(def: { id: string; component: ComponentType<DialogProps> }): Disposer;
    };

    openView(id: string, props?: unknown): void;
    closeView(): void;
    /** The mod view that is open, if it is one of this mod's. */
    activeView(): { id: string; props: any } | null;
    openDialog(id: string, props?: unknown): void;

    /** Which window this UI half runs in: the main one, or a detached session window. Announce things from "main" only. */
    readonly window: "main" | "session";
    /** A desktop notification; clicking it calls `onNotificationClick` with `target`. */
    notify(title: string, body?: string, target?: Json): void;
    toast(message: string, level?: "info" | "warn" | "error"): void;
    confirm(opts: { title: string; message: string; danger?: boolean }): Promise<boolean>;
    /** Called when the user clicks a notification this mod sent with a `target`. */
    onNotificationClick(fn: (target: Json) => void): Disposer;
    /** Ask Aura not to show its own "turn finished" toast for a session (e.g. a mod is handling it). */
    suppressTurnToast(fn: (session: Session) => boolean): Disposer;
  }

  /** What `ui.js` default-exports. May return a deactivate function. */
  export type UiActivate = (ctx: UiApi) => void | (() => void);

  export function defineUi(activate: UiActivate): UiActivate;

  // ---- globalThis.__aura (UI half only) ----
  /** Aura's own building blocks (`globalThis.__aura.modules["@aura/host"]`). */
  export interface AuraHost {
    /** A dialog with Aura's look and keyboard handling. Props: { title, onClose, children, ... } */
    Modal: any;
    /** A keyboard-navigable list. Props: { items, onSelect, ... } */
    KeyList: any;
    /** Hook: arrow-key navigation over a list. */
    useListNav: any;
    /** A compact dialog. */
    ModalC: any;
    /** A link that opens in the user's browser. Props: { href, children } */
    ExternalLink: any;
    /** Renders markdown the way the transcript does. Props: { text } */
    Markdown: any;
    /** Renders a unified diff. */
    DiffRenderer: any;
    /** (iso: string) => string, e.g. "5m". */
    timeAgo: any;
    /** (iso: string) => string. */
    exactTime: any;
    /** boolean. */
    isMac: any;
    /** The platform's modifier key label (⌘ or Ctrl). */
    modLabel: any;
    /** (id: string) => string. */
    shortId: any;
    /** (path: string) => string. */
    basename: any;
    /** (iso: string) => string. */
    relTime: any;
    /** Aura's zustand store (read-only use recommended): useStore((s) => s.sessions). */
    useStore: any;
    /** (region: "sidebar" | "main" | "inspector" | ...) => void. */
    setFocus: any;
    /** (url: string) => void: open a URL in the user's browser. */
    openExternal: any;
    /** Unified diff parsing helpers. */
    diff: any;
  }

  /** What `globalThis.__aura` holds in Aura's window. */
  export interface AuraGlobal {
    modules: {
      /** Aura's React. Use it, never a copy of your own: two Reacts break hooks. */
      react: any;
      "react/jsx-runtime": any;
      "react-dom": any;
      zustand: any;
      "zustand/shallow": any;
      "zustand/react/shallow": any;
      clsx: any;
      "@aura/host": AuraHost;
    };
  }
}

/** Set by Aura in its window before a mod's ui.js runs. Not available in daemon.js. */
declare var __aura: Aura.AuraGlobal;
