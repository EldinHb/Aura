// Runs in every mod's QuickJS context before the mod's daemon.js. Builds the
// `aura` API and the web-ish globals on two native functions:
//   __aura_sync(op, json) -> json        answered at once
//   __aura_async(id, op, json)           answered later by __aura_dispatch("complete", …)
// and receives everything from the host through __aura_dispatch(kind, json).
(function () {
  "use strict";
  const g = globalThis;
  const sync = g.__aura_sync;
  const asyncOp = g.__aura_async;
  delete g.__aura_sync;
  delete g.__aura_async;

  const callSync = (op, args) => {
    const out = sync(op, JSON.stringify(args === undefined ? null : args));
    const r = JSON.parse(out);
    if (r.ok) return r.value;
    throw hostError(r.error);
  };

  function hostError(e) {
    const err = new Error(e && e.message ? e.message : String(e));
    err.name = "HostError";
    err.code = (e && e.code) || "failed";
    if (e && e.data !== undefined) err.data = e.data;
    return err;
  }

  let nextOp = 1;
  const pending = new Map();
  const call = (op, args) =>
    new Promise((resolve, reject) => {
      const id = nextOp++;
      pending.set(id, { resolve, reject });
      asyncOp(id, op, JSON.stringify(args === undefined ? null : args));
    });

  const toError = (e) => {
    if (e && typeof e === "object") {
      const out = { message: String(e.message || e), code: typeof e.code === "string" ? e.code : "failed" };
      if (e.data !== undefined) out.data = e.data;
      if (e.stack) out.stack = String(e.stack);
      return out;
    }
    return { message: String(e), code: "failed" };
  };

  const fmt = (args) =>
    args
      .map((a) => {
        if (typeof a === "string") return a;
        if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ");
  const log = (level) => (...args) => callSync("log", { level, message: fmt(args) });
  g.console = { log: log("info"), info: log("info"), debug: log("debug"), warn: log("warn"), error: log("error"), trace: log("debug") };

  const report = (what, e) => console.error(`${what}:`, e);

  // ---- timers ----------------------------------------------------------------
  let nextTimer = 1;
  const timers = new Map();
  function schedule(fn, ms, args, repeat) {
    const id = nextTimer++;
    const delay = Math.max(0, Number(ms) || 0);
    const tick = () => {
      const t = timers.get(id);
      if (!t) return;
      call("sleep", { ms: delay }).then(() => {
        if (!timers.has(id)) return;
        if (!repeat) timers.delete(id);
        try {
          fn(...args);
        } catch (e) {
          report("timer callback failed", e);
        }
        if (repeat && timers.has(id)) tick();
      });
    };
    timers.set(id, true);
    tick();
    return id;
  }
  g.setTimeout = (fn, ms, ...args) => schedule(fn, ms, args, false);
  g.setInterval = (fn, ms, ...args) => schedule(fn, ms, args, true);
  g.clearTimeout = g.clearInterval = (id) => void timers.delete(id);
  g.queueMicrotask = (fn) => void Promise.resolve().then(fn);
  g.structuredClone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  // ---- small web globals QuickJS lacks ------------------------------------------
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  g.btoa = (s) => {
    s = String(s);
    let out = "";
    for (let i = 0; i < s.length; i += 3) {
      const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
      if (a > 255 || b > 255 || c > 255) throw new Error("btoa: character out of range");
      const n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < s.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < s.length ? B64[n & 63] : "=");
    }
    return out;
  };
  g.atob = (s) => {
    s = String(s).replace(/[\s=]+/g, "");
    let out = "", bits = 0, acc = 0;
    for (const ch of s) {
      const v = B64.indexOf(ch);
      if (v < 0) throw new Error("atob: invalid character");
      acc = (acc << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out += String.fromCharCode((acc >> bits) & 255);
      }
    }
    return out;
  };
  if (!g.TextEncoder) {
    g.TextEncoder = class {
      get encoding() { return "utf-8"; }
      encode(s = "") {
        const bin = unescape(encodeURIComponent(String(s)));
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      }
    };
  }
  if (!g.TextDecoder) {
    g.TextDecoder = class {
      get encoding() { return "utf-8"; }
      decode(bytes) {
        if (!bytes) return "";
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer || bytes);
        let bin = "";
        for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
        try {
          return decodeURIComponent(escape(bin));
        } catch {
          return bin;
        }
      }
    };
  }
  g.crypto = g.crypto || {};
  g.crypto.randomUUID = () => callSync("uuid");
  if (!g.URLSearchParams) {
    g.URLSearchParams = class {
      constructor(init) {
        this._p = [];
        if (typeof init === "string") {
          for (const part of init.replace(/^\?/, "").split("&")) {
            if (!part) continue;
            const [k, v = ""] = part.split("=");
            this._p.push([decodeURIComponent(k.replace(/\+/g, " ")), decodeURIComponent(v.replace(/\+/g, " "))]);
          }
        } else if (init && typeof init === "object") {
          for (const [k, v] of Array.isArray(init) ? init : Object.entries(init)) this._p.push([String(k), String(v)]);
        }
      }
      get(k) { const e = this._p.find(([a]) => a === k); return e ? e[1] : null; }
      getAll(k) { return this._p.filter(([a]) => a === k).map(([, b]) => b); }
      has(k) { return this._p.some(([a]) => a === k); }
      set(k, v) { this.delete(k); this._p.push([k, String(v)]); }
      append(k, v) { this._p.push([k, String(v)]); }
      delete(k) { this._p = this._p.filter(([a]) => a !== k); }
      entries() { return this._p[Symbol.iterator](); }
      [Symbol.iterator]() { return this._p[Symbol.iterator](); }
      forEach(fn) { this._p.forEach(([k, v]) => fn(v, k, this)); }
      toString() { return this._p.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&"); }
    };
  }
  if (!g.URL) {
    const RE = /^([a-z][a-z0-9+.-]*:)\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/?#]*)(?::(\d+))?([^?#]*)(\?[^#]*)?(#.*)?$/i;
    g.URL = class {
      constructor(url, base) {
        let s = String(url);
        if (base !== undefined && !/^[a-z][a-z0-9+.-]*:/i.test(s)) {
          const b = new g.URL(base);
          s = s.startsWith("/") ? `${b.origin}${s}` : `${b.origin}${b.pathname.replace(/[^/]*$/, "")}${s}`;
        }
        const m = RE.exec(s);
        if (!m) throw new TypeError(`Invalid URL: ${url}`);
        this.protocol = m[1].toLowerCase();
        this.username = m[2] || "";
        this.password = m[3] || "";
        this.hostname = (m[4] || "").toLowerCase();
        this.port = m[5] || "";
        this.pathname = m[6] || "/";
        this.search = m[7] && m[7] !== "?" ? m[7] : "";
        this.hash = m[8] && m[8] !== "#" ? m[8] : "";
        this.searchParams = new g.URLSearchParams(this.search);
      }
      get host() { return this.port ? `${this.hostname}:${this.port}` : this.hostname; }
      get origin() { return `${this.protocol}//${this.host}`; }
      get href() {
        const q = this.searchParams.toString();
        return `${this.origin}${this.pathname}${q ? `?${q}` : ""}${this.hash}`;
      }
      toString() { return this.href; }
      toJSON() { return this.href; }
    };
  }

  // ---- the aura API ----------------------------------------------------------------
  const info = callSync("info");
  const rpcHandlers = new Map();
  const eventListeners = new Map(); // type -> Set<fn>
  const modListeners = new Map(); // "mod\u0000name" -> Set<fn>
  const settingListeners = new Set();
  const tools = new Map(); // name -> {def, fn}
  const progress = new Map(); // run id -> fn
  let settings = info.settings || {};

  const disposer = (fn) => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      fn();
    };
  };
  const syncEventTypes = () => callSync("events.subscribe", { types: [...eventListeners.keys()] });
  const syncModSubs = () => callSync("mods.subscribe", { subs: [...modListeners.keys()].map((k) => k.split("\u0000")) });
  const syncTools = () => callSync("tools.set", { tools: [...tools.values()].map((t) => t.def) });

  const collection = (name) => ({
    get: (id) => call("collection.get", { name, id }).then((v) => (v === null ? undefined : v)),
    put: (id, doc) => call("collection.put", { name, id, doc }),
    delete: (id) => call("collection.delete", { name, id }),
    all: () => call("collection.all", { name }),
    clear: () => call("collection.clear", { name }),
  });

  const aura = {
    mod: Object.freeze({ id: info.id, version: info.version, dataDir: info.dataDir, platform: info.platform }),
    rpc: {
      handle(name, fn) {
        if (typeof fn !== "function") throw new TypeError("aura.rpc.handle needs a function");
        rpcHandlers.set(String(name), fn);
        return disposer(() => rpcHandlers.get(name) === fn && rpcHandlers.delete(name));
      },
    },
    emit(name, payload) {
      callSync("emit", { name: String(name), payload: payload === undefined ? null : payload });
    },
    storage: {
      kv: {
        get: (key) => call("kv.get", { key }).then((v) => (v === null ? undefined : v)),
        set: (key, value) => call("kv.set", { key, value: value === undefined ? null : value }),
        delete: (key) => call("kv.delete", { key }),
        keys: (prefix) => call("kv.keys", { prefix: prefix || "" }),
      },
      collection,
    },
    settings: {
      get: (key) => settings[key],
      all: () => ({ ...settings }),
      set: (key, value) => call("settings.set", { key, value: value === undefined ? null : value }),
      onChange(fn) {
        settingListeners.add(fn);
        return disposer(() => settingListeners.delete(fn));
      },
    },
    events: {
      on(type, fn) {
        const set = eventListeners.get(type) || new Set();
        set.add(fn);
        eventListeners.set(type, set);
        syncEventTypes();
        return disposer(() => {
          set.delete(fn);
          if (!set.size) eventListeners.delete(type);
          syncEventTypes();
        });
      },
    },
    sessions: {
      list: () => call("sessions.list"),
      get: (id) => call("sessions.get", { id }),
      lastReply: (id) => call("sessions.lastReply", { id }),
      create: (opts) => call("sessions.create", { opts }),
      send: (id, text, opts) => call("sessions.send", { id, text, whenFree: !!(opts && opts.whenFree) }),
      interrupt: (id) => call("sessions.interrupt", { id }),
      stop: (id) => call("sessions.stop", { id }),
      data: (id) => ({
        get: (key) => call("sessionData.get", { id, key }).then((v) => (v === null ? undefined : v)),
        set: (key, value) => call("sessionData.set", { id, key, value: value === undefined ? null : value }),
        delete: (key) => call("sessionData.delete", { id, key }),
        all: () => call("sessionData.all", { id }),
      }),
      withData: (key) => call("sessionData.with", { key }),
    },
    git: {
      repoRoot: (cwd) => call("git.repoRoot", { cwd }),
      mainRepoRoot: (cwd) => call("git.mainRepoRoot", { cwd }),
      currentBranch: (cwd) => call("git.currentBranch", { cwd }),
      remotes: (cwd) => call("git.remotes", { cwd }),
      branchStatus: (cwd) => call("git.branchStatus", { cwd }),
      run: (cwd, args, opts) =>
        call("git.run", { cwd, args, okCodes: (opts && opts.okCodes) || [], timeoutMs: opts && opts.timeoutMs, env: opts && opts.env, stdin: opts && opts.stdin }),
    },
    fs: {
      exists: (path) => call("fs.exists", { path }),
      readText: (path) => call("fs.readText", { path }),
      writeText: (path, text) => call("fs.writeText", { path, text: String(text) }),
      mkdir: (path) => call("fs.mkdir", { path }),
      remove: (path) => call("fs.remove", { path }),
      rename: (path, to) => call("fs.rename", { path, to }),
      list: (path) => call("fs.list", { path }),
    },
    process: {
      run: (bin, args, opts) => call("process.run", { bin, args: args || [], ...(opts || {}) }),
    },
    http: {
      fetch: (url, init) =>
        call("http.fetch", { url: String(url), ...(init || {}) }).then((r) => ({
          ...r,
          json() {
            return JSON.parse(r.text);
          },
        })),
    },
    agents: {
      providers: () => call("agents.providers"),
      models: (provider) => call("agents.models", { provider }),
      runOnce(opts) {
        const { onProgress, ...rest } = opts || {};
        const runId = nextOp++;
        if (typeof onProgress === "function") progress.set(runId, onProgress);
        return call("agents.runOnce", { ...rest, runId, progress: typeof onProgress === "function" }).finally(() => progress.delete(runId));
      },
      cancel: (id) => call("agents.cancel", { id: String(id) }),
    },
    orchestrator: {
      tool(def, fn) {
        if (!def || !/^[a-z0-9_]+$/.test(def.name)) throw new TypeError("tool names are [a-z0-9_]+");
        const d = { name: def.name, description: def.description || "", inputSchema: def.inputSchema || { type: "object" } };
        if (def.annotations) d.annotations = def.annotations;
        tools.set(def.name, { def: d, fn });
        syncTools();
        return disposer(() => {
          tools.delete(def.name);
          syncTools();
        });
      },
    },
    mods: {
      call: (modId, name, params) => call("mods.call", { modId, name, params: params === undefined ? null : params }),
      on(modId, name, fn) {
        const key = `${modId}\u0000${name}`;
        const set = modListeners.get(key) || new Set();
        set.add(fn);
        modListeners.set(key, set);
        syncModSubs();
        return disposer(() => {
          set.delete(fn);
          if (!set.size) modListeners.delete(key);
          syncModSubs();
        });
      },
    },
    inbox: {
      set: (items) => call("inbox.set", { items: items || [] }),
    },
    notify(opts) {
      callSync("notify", { title: String((opts && opts.title) || ""), body: opts && opts.body, target: opts && opts.target });
    },
  };
  Object.freeze(aura.rpc);

  const each = (set, arg, what) => {
    if (!set) return;
    for (const fn of [...set]) {
      try {
        const r = fn(arg);
        if (r && typeof r.then === "function") r.then(undefined, (e) => report(what, e));
      } catch (e) {
        report(what, e);
      }
    }
  };

  // ---- host → mod ----------------------------------------------------------------
  g.__aura_dispatch = (kind, json) => {
    const msg = JSON.parse(json);
    switch (kind) {
      case "complete": {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(hostError(msg.error));
        return;
      }
      case "call": {
        const reply = (ok, v) => callSync("reply", ok ? { id: msg.id, ok: true, value: v === undefined ? null : v } : { id: msg.id, ok: false, error: toError(v) });
        if (msg.name === "__tool") {
          const t = tools.get(msg.params.name);
          if (!t) return reply(false, { code: "not_found", message: `no tool ${msg.params.name}` });
          Promise.resolve()
            .then(() => t.fn(msg.params.args || {}, { sessionId: msg.params.sessionId }))
            .then((v) => reply(true, v), (e) => reply(false, e));
          return;
        }
        const h = rpcHandlers.get(msg.name);
        if (!h) return reply(false, { code: "not_found", message: `mod.${info.id}.${msg.name} is not a method` });
        Promise.resolve()
          .then(() => h(msg.params, msg.caller))
          .then((v) => reply(true, v), (e) => reply(false, e));
        return;
      }
      case "event":
        each(eventListeners.get(msg.type), msg, `listener for ${msg.type} failed`);
        each(eventListeners.get("*"), msg, "listener for core events failed");
        return;
      case "modEvent":
        each(modListeners.get(`${msg.modId}\u0000${msg.name}`), msg.payload, `listener for ${msg.modId}.${msg.name} failed`);
        return;
      case "settings":
        settings = msg.all || settings;
        for (const fn of [...settingListeners]) {
          try {
            fn(msg.key, msg.value);
          } catch (e) {
            report("settings listener failed", e);
          }
        }
        return;
      case "progress": {
        const fn = progress.get(msg.runId);
        if (fn) {
          try {
            fn(msg.line);
          } catch (e) {
            report("progress listener failed", e);
          }
        }
        return;
      }
    }
  };

  let deactivate = null;
  g.__aura_activate = (mod) => {
    const activate = mod && (typeof mod === "function" ? mod : mod.default);
    if (typeof activate !== "function") throw new Error("daemon.js must default-export activate(aura)");
    return Promise.resolve(activate(aura)).then((d) => {
      if (typeof d === "function") deactivate = d;
    });
  };
  g.__aura_deactivate = () => {
    timers.clear();
    const d = deactivate;
    deactivate = null;
    return Promise.resolve(d ? d() : undefined);
  };
})();
