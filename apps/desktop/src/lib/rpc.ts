/**
 * JSON-RPC over WebSocket client for the Aura daemon.
 * Text frames: requests/responses/notifications. Binary frames: PTY bytes
 * `[kind:1][session_id:36][payload]` (kind 1 = output, 2 = input).
 */
import type {
  ApprovalDecision,
  CreateSessionOpts,
  Event,
  Input,
  ModelInfo,
  NativeSession,
  ProviderInfo,
  ProviderKind,
  SearchHit,
  Session,
  SystemPrompts,
  SessionMode,
  Setting,
  SlashCommand,
  StoredEvent,
  UserInputResponse,
  DirEntry,
  FileStatus,
  DiffStat,
  LogEntry,
  Worktree,
  CleanupReport,
  CleanupResult,
  Approval,
  UserInputRequest,
  DaemonInfo,
  Group,
  RepoIssue,
  BranchStatus,
  BranchPull,
} from "../gen";

export const FRAME_PTY_OUTPUT = 1;
export const FRAME_PTY_INPUT = 2;
const SESSION_ID_LEN = 36;

export type ConnectionState = "connecting" | "open" | "closed";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string };

export class RpcError extends Error {
  constructor(message: string, public code: number) {
    super(message);
  }
}

export class RpcClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private inflight = new Map<number, Pending>();
  private notificationListeners = new Set<(method: string, params: unknown) => void>();
  onNotification(listener: (method: string, params: unknown) => void) {
    this.notificationListeners.add(listener);
    return () => { this.notificationListeners.delete(listener); };
  }

  private eventListeners = new Set<(ev: Event) => void>();
  private ptyListeners = new Map<string, Set<(data: Uint8Array) => void>>();
  private stateListeners = new Set<(s: ConnectionState) => void>();
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  state: ConnectionState = "closed";
  private closedByUser = false;
  private backoff = 250;

  constructor(private port: number, private token: string) {}

  connect(): Promise<void> {
    this.closedByUser = false;
    return new Promise((resolve, reject) => {
      this.setState("connecting");
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws?token=${encodeURIComponent(this.token)}`);
      ws.binaryType = "arraybuffer";
      let settled = false;
      ws.onopen = () => {
        settled = true;
        this.backoff = 250;
        this.setState("open");
        resolve();
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error("websocket connection failed"));
        }
      };
      ws.onclose = () => {
        this.setState("closed");
        for (const p of this.inflight.values()) p.reject(new Error("connection closed"));
        this.inflight.clear();
        if (!this.closedByUser) this.scheduleReconnect();
      };
      ws.onmessage = (m) => this.onMessage(m);
      this.ws = ws;
    });
  }

  private scheduleReconnect() {
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 5000);
    setTimeout(() => {
      if (!this.closedByUser) this.connect().catch(() => {});
    }, delay);
  }

  close() {
    this.closedByUser = true;
    this.ws?.close();
  }

  private setState(s: ConnectionState) {
    this.state = s;
    for (const l of this.stateListeners) l(s);
  }

  onState(l: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(l);
    return () => {
      this.stateListeners.delete(l);
    };
  }

  onEvent(l: (ev: Event) => void): () => void {
    this.eventListeners.add(l);
    return () => {
      this.eventListeners.delete(l);
    };
  }

  onPty(sessionId: string, l: (data: Uint8Array) => void): () => void {
    let set = this.ptyListeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.ptyListeners.set(sessionId, set);
    }
    set.add(l);
    return () => {
      set!.delete(l);
    };
  }

  private onMessage(m: MessageEvent) {
    if (typeof m.data === "string") {
      let v: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };
      try {
        v = JSON.parse(m.data);
      } catch {
        return;
      }
      if (v.method) {
        for (const listener of this.notificationListeners) listener(v.method, v.params);
        if (v.method === "event") for (const l of this.eventListeners) l(v.params as Event);
        return;
      }
      if (typeof v.id === "number") {
        const p = this.inflight.get(v.id);
        if (!p) return;
        this.inflight.delete(v.id);
        if (v.error) p.reject(new RpcError(v.error.message, v.error.code));
        else p.resolve(v.result);
      }
    } else if (m.data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(m.data);
      if (bytes.length < 1 + SESSION_ID_LEN || bytes[0] !== FRAME_PTY_OUTPUT) return;
      const sid = this.decoder.decode(bytes.subarray(1, 1 + SESSION_ID_LEN)).trim();
      const payload = bytes.subarray(1 + SESSION_ID_LEN);
      const set = this.ptyListeners.get(sid);
      if (set) for (const l of set) l(payload);
    }
  }

  call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("not connected"));
        return;
      }
      const id = this.nextId++;
      this.inflight.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  ptyInput(sessionId: string, data: string | Uint8Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const payload = typeof data === "string" ? this.encoder.encode(data) : data;
    const frame = new Uint8Array(1 + SESSION_ID_LEN + payload.length);
    frame[0] = FRAME_PTY_INPUT;
    const idBytes = this.encoder.encode(sessionId.padEnd(SESSION_ID_LEN, " ").slice(0, SESSION_ID_LEN));
    frame.set(idBytes, 1);
    frame.set(payload, 1 + SESSION_ID_LEN);
    this.ws.send(frame);
  }

  // ---- typed API -----------------------------------------------------------

  daemonInfo() {
    return this.call<DaemonInfo>("daemon.info");
  }
  providers() {
    return this.call<ProviderInfo[]>("provider.list");
  }
  nativeSessions(provider: ProviderKind) {
    return this.call<NativeSession[]>("provider.native_sessions", { provider });
  }
  models(provider: ProviderKind) {
    return this.call<ModelInfo[]>("provider.models", { provider });
  }
  commands(provider: ProviderKind, cwd: string) {
    return this.call<SlashCommand[]>("provider.commands", { provider, cwd });
  }
  sessions() {
    return this.call<Session[]>("session.list");
  }
  session(id: string) {
    return this.call<Session>("session.get", { id });
  }
  createSession(opts: Partial<CreateSessionOpts> & { provider: ProviderKind; cwd: string }) {
    return this.call<Session>("session.create", opts);
  }
  fork(id: string) {
    return this.call<Session>("session.fork", { id });
  }
  send(id: string, input: Partial<Input> & { text: string }) {
    return this.call<boolean>("session.send", { id, input });
  }
  interrupt(id: string) {
    return this.call<boolean>("session.interrupt", { id });
  }
  /** Dismiss the notices of one session, or of all sessions without an id. */
  clearNotices(id?: string) {
    return this.call<boolean>("session.clear_notices", id ? { id } : {});
  }
  respondApproval(id: string, approval_id: string, decision: ApprovalDecision) {
    return this.call<boolean>("session.respond_approval", { id, approval_id, decision });
  }
  respondInput(id: string, response: UserInputResponse) {
    return this.call<boolean>("session.respond_input", { id, response });
  }
  set(id: string, setting: Setting) {
    return this.call<boolean>("session.set", { id, setting });
  }
  action(id: string, name: string, params: unknown = {}) {
    return this.call<unknown>("session.action", { id, name, params });
  }
  rename(id: string, title: string) {
    return this.call<Session>("session.rename", { id, title });
  }
  /** This session's own system prompt; `null` removes it. */
  setSystemPrompt(id: string, prompt: string | null) {
    return this.call<Session>("session.set_system_prompt", { id, prompt });
  }
  systemPrompts() {
    return this.call<SystemPrompts>("prompts.get");
  }
  /** `null` goes back to Aura's default global prompt. */
  setGlobalPrompt(prompt: string | null) {
    return this.call<SystemPrompts>("prompts.set_global", { prompt });
  }
  /** `agent`: `claude`, `codex` or `acp:<agent id>`. `null` removes its prompt. */
  setAgentPrompt(agent: string, prompt: string | null) {
    return this.call<SystemPrompts>("prompts.set_agent", { agent, prompt });
  }
  /** The complete system prompt the session's agent starts with. */
  effectivePrompt(id: string) {
    return this.call<string | null>("prompts.preview", { id });
  }
  setGroup(id: string, group: string | null) {
    return this.call<Session>("session.set_group", { id, group });
  }
  groups() {
    return this.call<Group[]>("group.list");
  }
  /** The group last used in the repository containing `cwd`, if any. */
  groupForDir(cwd: string) {
    return this.call<string | null>("group.for_dir", { cwd });
  }
  /** Forget a group and take its sessions out of it. */
  deleteGroup(name: string) {
    return this.call<boolean>("group.delete", { name });
  }
  setPinned(id: string, pinned: boolean) {
    return this.call<Session>("session.set_pinned", { id, pinned });
  }
  setArchived(id: string, archived: boolean) {
    return this.call<Session>("session.set_archived", { id, archived });
  }
  stop(id: string) {
    return this.call<boolean>("session.stop", { id });
  }
  restart(id: string) {
    return this.call<Session>("session.restart", { id });
  }
  deleteSession(id: string, remove_worktree = false) {
    return this.call<boolean>("session.delete", { id, remove_worktree });
  }
  switchMode(id: string, mode: SessionMode) {
    return this.call<Session>("session.switch_mode", { id, mode });
  }
  history(id: string, after_seq = 0, limit = 5000) {
    return this.call<StoredEvent[]>("session.history", { id, after_seq, limit });
  }
  pending() {
    return this.call<{ approvals: Approval[]; inputs: UserInputRequest[] }>("session.pending");
  }
  ptyAttach(id: string) {
    return this.call<{ scrollback: string }>("pty.attach", { id });
  }
  ptyDetach(id: string) {
    return this.call<boolean>("pty.detach", { id });
  }
  ptyResize(id: string, cols: number, rows: number) {
    return this.call<boolean>("pty.resize", { id, cols, rows });
  }
  search(query: string, limit = 50) {
    return this.call<SearchHit[]>("search", { query, limit });
  }
  getSetting(key: string) {
    return this.call<string | null>("settings.get", { key });
  }
  setSetting(key: string, value: string) {
    return this.call<boolean>("settings.set", { key, value });
  }
  home() {
    return this.call<string | null>("fs.home");
  }
  listDir(path: string, show_hidden = false) {
    return this.call<DirEntry[]>("fs.list_dir", { path, show_hidden });
  }
  searchFiles(cwd: string, query: string, limit = 30) {
    return this.call<string[]>("fs.search_files", { cwd, query, limit });
  }
  gitRepoRoot(cwd: string) {
    return this.call<string | null>("git.repo_root", { cwd });
  }
  githubIssues(repo: string, query = "") {
    return this.call<RepoIssue[]>("github.issues", { repo, query });
  }
  githubBranchPull(repo: string, head_repo: string, branch: string) {
    return this.call<BranchPull | null>("github.branch_pull", { repo, head_repo, branch });
  }
  gitBranchStatus(cwd: string) {
    return this.call<BranchStatus | null>("git.branch_status", { cwd });
  }
  gitGithubRepo(cwd: string) {
    return this.call<string | null>("git.github_repo", { cwd });
  }
  gitStatus(cwd: string) {
    return this.call<FileStatus[]>("git.status", { cwd });
  }
  gitDiff(cwd: string, opts: { path?: string; staged?: boolean; base?: string } = {}) {
    return this.call<string>("git.diff", { cwd, ...opts });
  }
  gitDiffStat(cwd: string, base?: string) {
    return this.call<DiffStat[]>("git.diff_stat", { cwd, base });
  }
  gitBranches(cwd: string) {
    return this.call<string[]>("git.branches", { cwd });
  }
  gitCurrentBranch(cwd: string) {
    return this.call<string>("git.current_branch", { cwd });
  }
  gitCommit(cwd: string, message: string, all = true) {
    return this.call<string>("git.commit", { cwd, message, all });
  }
  gitPush(cwd: string, set_upstream = true) {
    return this.call<string>("git.push", { cwd, set_upstream });
  }
  gitLog(cwd: string, limit = 20) {
    return this.call<LogEntry[]>("git.log", { cwd, limit });
  }
  gitWorktrees(cwd: string) {
    return this.call<Worktree[]>("git.worktrees", { cwd });
  }
  gitMainRepoRoot(cwd: string) {
    return this.call<string | null>("git.main_repo_root", { cwd });
  }
  /** Stale local branches; `fetch` prunes deleted remote branches first, which takes a network round trip. */
  gitCleanupCandidates(cwd: string, fetch = true) {
    return this.call<CleanupReport>("git.cleanup_candidates", { cwd, fetch });
  }
  gitCleanup(cwd: string, branches: string[], prune_worktrees: boolean) {
    return this.call<CleanupResult>("git.cleanup", { cwd, branches, prune_worktrees });
  }
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
