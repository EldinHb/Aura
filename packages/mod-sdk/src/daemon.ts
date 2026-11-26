// The API a mod's daemon half receives in `activate(aura)`.
//
// The daemon half runs inside aurad in a QuickJS runtime of its own. It has
// no Node APIs and no ambient file or network access: everything goes through
// `aura`, and what `aura` lets it do is limited by the permissions in mod.json.
//
// Available globals besides `aura`: setTimeout/clearTimeout,
// setInterval/clearInterval, queueMicrotask, console, TextEncoder/TextDecoder,
// URL, URLSearchParams, atob/btoa, structuredClone, crypto.randomUUID.

import type { CoreEvent, CreateSessionOpts, Session } from "./core";

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
  run(cwd: string, args: string[], opts?: { okCodes?: number[]; timeoutMs?: number }): Promise<string>;
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
}

export interface ToolDef {
  /** Becomes `<modId>_<name>` for the agent. [a-z0-9_]+ */
  name: string;
  description: string;
  inputSchema: Json;
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

export function defineDaemon(activate: DaemonActivate): DaemonActivate {
  return activate;
}
