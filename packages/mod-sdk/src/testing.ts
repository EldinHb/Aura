// An in-memory stand-in for the daemon API, for unit tests of a mod's daemon
// half under vitest/Node. Everything is local: storage lives in Maps, and
// HTTP, processes, git, sessions and agents answer from handlers the test sets.
//
//   const host = createTestHost({ id: "github" });
//   host.http.route((req) => ({ status: 200, body: { login: "me" } }));
//   await activate(host.api);
//   expect(await host.call("account")).toEqual(...);
import type {
  AgentRunOptions,
  AgentRunResult,
  Caller,
  Collection,
  DaemonActivate,
  DaemonApi,
  Disposer,
  HttpResponse,
  InboxItem,
  Json,
  ProcessResult,
  ToolDef,
} from "./daemon";
import type { CoreEvent, Session } from "./core";

export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}
export type HttpHandler = (
  req: HttpRequest,
) =>
  | { status?: number; headers?: Record<string, string>; body?: unknown }
  | undefined
  | Promise<{ status?: number; headers?: Record<string, string>; body?: unknown } | undefined>;
export type ProcessHandler = (
  bin: string,
  args: string[],
  opts: { cwd?: string; stdin?: string; env?: Record<string, string | null> },
) => Partial<ProcessResult> | undefined | Promise<Partial<ProcessResult> | undefined>;

class HostError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function createTestHost(opts: { id: string; settings?: Record<string, Json>; dataDir?: string } = { id: "test" }) {
  const id = opts.id;
  const kv = new Map<string, unknown>();
  const collections = new Map<string, Map<string, unknown>>();
  const sessionData = new Map<string, Map<string, unknown>>();
  const settings: Record<string, Json> = { ...(opts.settings ?? {}) };
  const settingListeners = new Set<(k: string, v: Json) => void>();
  const handlers = new Map<string, (params: any, caller: Caller) => unknown>();
  const eventListeners = new Set<{ type: string; fn: (e: any) => void }>();
  const modListeners = new Set<{ modId: string; name: string; fn: (p: any) => void }>();
  const tools = new Map<string, { def: ToolDef; fn: (args: any, ctx: { sessionId: string }) => unknown }>();
  const httpHandlers: HttpHandler[] = [];
  const processHandlers: ProcessHandler[] = [];
  const modCalls = new Map<string, (name: string, params: any) => unknown>();
  const files = new Map<string, string>();
  const cancelled: string[] = [];
  const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

  const record = {
    emitted: [] as Array<{ name: string; payload: unknown }>,
    notifications: [] as Array<{ title: string; body?: string; target?: Json }>,
    inbox: [] as InboxItem[],
    sent: [] as Array<{ id: string; text: string; whenFree: boolean }>,
    created: [] as unknown[],
    http: [] as HttpRequest[],
    processes: [] as Array<{ bin: string; args: string[]; cwd?: string; stdin?: string }>,
    agentRuns: [] as AgentRunOptions[],
  };
  const state = {
    sessions: [] as Session[],
    lastReplies: new Map<string, string>(),
    agent: (async () => ({ output: null, text: "", modelId: null })) as (o: AgentRunOptions) => Promise<AgentRunResult>,
    git: (async () => "") as (cwd: string, args: string[]) => Promise<string>,
  };

  const collection = <T,>(name: string): Collection<T> => {
    const m = collections.get(name) ?? new Map<string, unknown>();
    collections.set(name, m);
    return {
      get: async (k) => clone(m.get(k)) as T | undefined,
      put: async (k, doc) => void m.set(k, clone(doc)),
      delete: async (k) => void m.delete(k),
      all: async () => [...m.entries()].map(([k, v]) => [k, clone(v) as T]),
      clear: async () => m.clear(),
    };
  };

  const api: DaemonApi = {
    mod: { id, version: "0.0.0-test", dataDir: opts.dataDir ?? `/tmp/aura-test/${id}`, platform: "linux" },
    rpc: {
      handle(name, fn) {
        handlers.set(name, fn);
        return () => handlers.delete(name);
      },
    },
    emit(name, payload) {
      record.emitted.push({ name, payload: clone(payload) });
    },
    storage: {
      kv: {
        get: async (k) => clone(kv.get(k)) as any,
        set: async (k, v) => void kv.set(k, clone(v)),
        delete: async (k) => void kv.delete(k),
        keys: async (prefix = "") => [...kv.keys()].filter((k) => k.startsWith(prefix)),
      },
      collection,
    },
    settings: {
      get: (k) => settings[k] as any,
      all: () => ({ ...settings }),
      set: async (k, v) => {
        settings[k] = clone(v) as Json;
        settingListeners.forEach((l) => l(k, settings[k]));
      },
      onChange(fn) {
        settingListeners.add(fn);
        return () => settingListeners.delete(fn);
      },
    },
    events: {
      on(type, fn) {
        const entry = { type: type as string, fn: fn as (e: any) => void };
        eventListeners.add(entry);
        return () => eventListeners.delete(entry);
      },
    },
    sessions: {
      list: async () => clone(state.sessions),
      get: async (sid) => clone(state.sessions.find((s) => s.id === sid) ?? null),
      lastReply: async (sid) => state.lastReplies.get(sid) ?? null,
      create: async (o) => {
        record.created.push(clone(o));
        const s = { id: `s${record.created.length}`, ...(o as object) } as unknown as Session;
        state.sessions.push(s);
        return s;
      },
      send: async (sid, text, o) => void record.sent.push({ id: sid, text, whenFree: !!o?.whenFree }),
      interrupt: async () => {},
      stop: async () => {},
      data(sid) {
        const m = sessionData.get(sid) ?? new Map<string, unknown>();
        sessionData.set(sid, m);
        return {
          get: async (k) => clone(m.get(k)) as any,
          set: async (k, v) => void m.set(k, clone(v)),
          delete: async (k) => void m.delete(k),
          all: async () => Object.fromEntries([...m.entries()].map(([k, v]) => [k, clone(v)])) as Record<string, Json>,
        };
      },
      withData: async (key) =>
        [...sessionData.entries()].filter(([, m]) => m.has(key)).map(([sid, m]) => [sid, clone(m.get(key))] as [string, any]),
    },
    git: {
      repoRoot: async (cwd) => cwd,
      mainRepoRoot: async (cwd) => cwd,
      currentBranch: async () => "main",
      remotes: async () => [],
      branchStatus: async () => ({}),
      run: (cwd, args) => state.git(cwd, args),
    },
    process: {
      async run(bin, args, o = {}) {
        record.processes.push({ bin, args, cwd: o.cwd, stdin: o.stdin });
        for (const h of processHandlers) {
          const r = await h(bin, args, o);
          if (r) return { code: 0, stdout: "", stderr: "", ...r };
        }
        throw new HostError("unavailable", `no test handler for ${bin} ${args.join(" ")}`);
      },
    },
    http: {
      async fetch(url, init = {}) {
        const req: HttpRequest = { url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body };
        record.http.push(req);
        for (const h of httpHandlers) {
          const r = await h(req);
          if (!r) continue;
          const status = r.status ?? 200;
          const text = typeof r.body === "string" ? r.body : r.body === undefined ? "" : JSON.stringify(r.body);
          const res: HttpResponse = {
            status,
            ok: status >= 200 && status < 300,
            headers: Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
            text,
            json: () => JSON.parse(text),
            cached: false,
          };
          return res;
        }
        throw new HostError("unavailable", `no test handler for ${req.method} ${url}`);
      },
    },
    agents: {
      providers: async () => [{ kind: "claude", available: true, version: "test" }],
      models: async () => [],
      cancel: async (runId) => {
        cancelled.push(runId);
        return true;
      },
      runOnce: async (o) => {
        record.agentRuns.push(o);
        return state.agent(o);
      },
    },
    fs: {
      exists: async (p) => files.has(p) || [...files.keys()].some((k) => k.startsWith(`${p}/`)),
      readText: async (p) => {
        if (!files.has(p)) throw new HostError("not_found", `${p} does not exist`);
        return files.get(p)!;
      },
      writeText: async (p, text) => void files.set(p, String(text)),
      mkdir: async () => {},
      remove: async (p) => {
        for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`)) files.delete(k);
      },
      rename: async (p, to) => {
        for (const [k, v] of [...files.entries()]) {
          if (k === p || k.startsWith(`${p}/`)) {
            files.delete(k);
            files.set(to + k.slice(p.length), v);
          }
        }
      },
      list: async (p) => {
        const names = new Map<string, boolean>();
        for (const k of files.keys()) {
          if (!k.startsWith(`${p}/`)) continue;
          const [name, ...rest] = k.slice(p.length + 1).split("/");
          names.set(name, rest.length > 0 || names.get(name) === true);
        }
        return [...names].map(([name, dir]) => ({ name, dir }));
      },
    },
    orchestrator: {
      tool(def, fn) {
        tools.set(def.name, { def, fn });
        return () => tools.delete(def.name);
      },
    },
    mods: {
      call: async (modId, name, params) => {
        const h = modCalls.get(modId);
        if (!h) throw new HostError("not_found", `mod ${modId} is not available`);
        return clone(await h(name, params)) as any;
      },
      on(modId, name, fn) {
        const entry = { modId, name, fn };
        modListeners.add(entry);
        return () => modListeners.delete(entry);
      },
    },
    inbox: {
      set: async (items) => {
        record.inbox = clone(items);
      },
    },
    notify(o) {
      record.notifications.push(clone(o));
    },
  };

  return {
    api,
    record,
    state,
    /** Call an `aura.rpc.handle` method as the desktop would. */
    async call<T = any>(name: string, params?: unknown, caller: Caller = { kind: "user" }): Promise<T> {
      const h = handlers.get(name);
      if (!h) throw new HostError("not_found", `mod.${id}.${name} is not handled`);
      return clone(await h(clone(params), caller)) as T;
    },
    handled: () => [...handlers.keys()],
    /** Deliver a core event to `aura.events.on` listeners. */
    fire(event: CoreEvent) {
      for (const l of [...eventListeners]) if (l.type === "*" || l.type === event.type) l.fn(clone(event));
    },
    /** Deliver another mod's notification to `aura.mods.on` listeners. */
    fireMod(modId: string, name: string, payload?: unknown) {
      for (const l of [...modListeners]) if (l.modId === modId && l.name === name) l.fn(clone(payload));
    },
    /** Answer `aura.mods.call(modId, …)`. */
    provideMod(modId: string, fn: (name: string, params: any) => unknown) {
      modCalls.set(modId, fn);
    },
    tool: async (name: string, args: unknown, sessionId = "orchestrator") => {
      const t = tools.get(name);
      if (!t) throw new HostError("not_found", `tool ${name} is not registered`);
      return clone(await t.fn(clone(args), { sessionId }));
    },
    tools: () => [...tools.values()].map((t) => t.def),
    http: { route: (h: HttpHandler) => void httpHandlers.push(h) },
    process: { route: (h: ProcessHandler) => void processHandlers.push(h) },
    kv,
    files,
    cancelled,
    collections,
    sessionData,
    async activate(activate: DaemonActivate) {
      return activate(api);
    },
  };
}

export type TestHost = ReturnType<typeof createTestHost>;
export type { Disposer };
