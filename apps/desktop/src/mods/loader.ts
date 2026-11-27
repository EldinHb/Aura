/**
 * Loads mods' UI halves into this window and gives each its `ctx` (the UiApi
 * of packages/mod-sdk/src/ui.ts). A UI half is fetched from the daemon
 * (`mods.ui_source`), imported from a blob: URL, and activated; unloading it
 * disposes everything it registered.
 */
import { create } from "zustand";
import { useEffect } from "react";
import { useStore } from "../state/store";
import { onOpenSessionsChange, openSessionIds } from "./openSessions";
import { openModView } from "./views";
import { registerCommand, runCommand } from "../lib/commands";
import { desktopNotify, onModNotificationClick } from "../lib/notify";
import { RpcError, type RpcClient } from "../lib/rpc";
import type { Session } from "../gen";
import { clearModContext, setModContext, slots, type InboxItem, type Registry } from "./registry";
import { installHostModules } from "./host";
import { useModInbox } from "./inbox";

export { useModInbox };

export type ModStatus = { state: "stopped" | "disabled" | "needs_approval" | "starting" | "running" | "failed"; error?: string };
export type ModInfo = {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  source: "bundled" | "user" | "dev";
  dir: string;
  status: ModStatus;
  enabled: boolean;
  approved: boolean;
  hasUi: boolean;
  hasDaemon: boolean;
  permissions: Record<string, unknown>;
  dependsOn: Record<string, string>;
  settings: Array<{ key: string; type: string; label: string; description?: string; default?: unknown; options?: Array<{ value: string; label: string }> }>;
  settingValues: Record<string, unknown>;
  broken?: boolean;
};

/** What a mod passes to a `ctx.ui.*` slot: the slot's item plus its id. */
type Def<R> = R extends Registry<infer T> ? T & { id: string; order?: number } : never;

type Loaded = { version: string; js: string; css: string | null; dispose: () => void; uiError?: string };

export const useMods = create<{ mods: ModInfo[]; uiErrors: Record<string, string>; loaded: string[] }>(() => ({
  mods: [],
  uiErrors: {},
  loaded: [],
}));

async function refreshInbox() {
  try {
    useModInbox.setState({ items: await client().call<Array<{ modId: string; items: InboxItem[] }>>("mods.inbox") });
  } catch {
    /* an older daemon */
  }
}

const loaded = new Map<string, Loaded>();
const settingListeners = new Map<string, Set<(key: string, value: unknown) => void>>();

function client(): RpcClient {
  const c = useStore.getState().client;
  if (!c) throw new Error("Aura is not connected to its daemon");
  return c;
}

/** An RPC error from a mod as the mod threw it: its string code and data. */
function modError(e: unknown): Error {
  if (e instanceof RpcError && e.data && typeof e.data === "object") {
    const d = e.data as { code?: string; data?: unknown };
    const err = new Error(e.message) as Error & { code?: string; data?: unknown };
    err.code = d.code;
    if (d.data !== undefined && d.data !== null) err.data = d.data;
    return err;
  }
  return e instanceof Error ? e : new Error(String(e));
}

function callMod<T>(modId: string, name: string, params?: unknown): Promise<T> {
  return client()
    .call<T>(`mod.${modId}.${name}`, params ?? {})
    .catch((e) => {
      throw modError(e);
    });
}

function makeCtx(info: ModInfo, track: (d: () => void) => () => void) {
  const id = info.id;
  const reg = <T,>(r: Registry<T>, key: string, item: T & { order?: number }) => track(r.register(id, key, item));
  let seq = 0;
  const storageKey = (k: string) => `aura.mod.${id}.${k}`;
  const onNote = (method: string, fn: (p: unknown) => void) =>
    track(client().onNotification((m, p) => {
      if (m === method) {
        try {
          fn(p);
        } catch (e) {
          console.error(`[mod ${id}] ${method} listener failed`, e);
        }
      }
    }));
  return {
    mod: { id, version: info.version },
    rpc: <T,>(name: string, params?: unknown) => callMod<T>(id, name, params),
    call: <T,>(modId: string, name: string, params?: unknown) => callMod<T>(modId, name, params),
    on: (name: string, fn: (p: unknown) => void) => onNote(`mod.${id}.${name}`, fn),
    onMod: (modId: string, name: string, fn: (p: unknown) => void) => onNote(`mod.${modId}.${name}`, fn),
    onConnection: (fn: (s: "open" | "closed" | "connecting") => void) =>
      track(client().onState((s) => fn(s as "open" | "closed" | "connecting"))),
    client: { call: <T,>(method: string, params?: unknown) => client().call<T>(method, params ?? {}) },
    storage: {
      get<T>(key: string): T | undefined {
        try {
          const raw = localStorage.getItem(storageKey(key));
          return raw === null ? undefined : (JSON.parse(raw) as T);
        } catch {
          return undefined;
        }
      },
      set(key: string, value: unknown) {
        try {
          localStorage.setItem(storageKey(key), JSON.stringify(value));
        } catch {
          /* storage full or unavailable */
        }
      },
      delete(key: string) {
        try {
          localStorage.removeItem(storageKey(key));
        } catch {
          /* ignore */
        }
      },
    },
    settings: {
      get: <T,>(key: string) => (useMods.getState().mods.find((m) => m.id === id)?.settingValues ?? {})[key] as T,
      set: (key: string, value: unknown) => client().call<void>("mods.settings.set", { id, key, value }),
      onChange(fn: (key: string, value: unknown) => void) {
        const set = settingListeners.get(id) ?? new Set();
        set.add(fn);
        settingListeners.set(id, set);
        return track(() => set.delete(fn));
      },
    },
    sessions: {
      open: () => openSessionIds(),
      onOpenChange: (fn: (ids: string[]) => void) => track(onOpenSessionsChange(fn)),
    },
    commands: {
      register(cmd: { id: string; title: string; group: string; keywords?: string[]; when?: string; hidden?: boolean; run: (arg?: unknown) => void | Promise<void> }) {
        const full = cmd.id.startsWith(`${id}.`) ? cmd.id : `${id}.${cmd.id}`;
        return track(registerCommand({ ...cmd, id: full }));
      },
      run: (cmdId: string, arg?: unknown) => runCommand(cmdId, arg),
    },
    keys: {
      bind: (binding: { keys: string; command: string; when?: string; arg?: unknown; label?: string }) =>
        reg(slots.keybinding, `k${seq++}`, { binding }),
      group: (prefix: string, label: string) => reg(slots.keyGroup, `g${seq++}`, { prefix, label }),
    },
    context: { set: (key: string, value: unknown) => setModContext(`mod.${id}.${key}`, value) },
    ui: {
      sidebarSection: (d: Def<typeof slots.sidebarSection>) => reg(slots.sidebarSection, d.id, d),
      inspectorSection: (d: Def<typeof slots.inspectorSection>) => reg(slots.inspectorSection, d.id, d),
      sessionRowChips: (d: Def<typeof slots.sessionRowChips>) => reg(slots.sessionRowChips, d.id, d),
      branchDecoration: (d: Def<typeof slots.branchDecoration>) => reg(slots.branchDecoration, d.id, d),
      statusBarItem: (d: Def<typeof slots.statusBarItem>) => reg(slots.statusBarItem, d.id, d),
      settingsTab: (d: Def<typeof slots.settingsTab>) => reg(slots.settingsTab, d.id, d),
      newSessionField: (d: Def<typeof slots.newSessionField>) => reg(slots.newSessionField, d.id, d),
      inboxRenderer: (d: Def<typeof slots.inboxRenderer>) => reg(slots.inboxRenderer, "inbox", d),
      transcriptLinks: (d: Def<typeof slots.transcriptLinks>) => reg(slots.transcriptLinks, d.id, d),
      view: (d: Def<typeof slots.view>) => reg(slots.view, d.id, d),
      dialog: (d: Def<typeof slots.dialog>) => reg(slots.dialog, d.id, d),
    },
    openView: (viewId: string, props?: unknown, opts?: { preview?: boolean }) => openModView(id, viewId, props, opts),
    closeView: () => {
      const v = useStore.getState().modView;
      if (v?.modId === id) useStore.getState().closeModView();
    },
    activeView: () => {
      const v = useStore.getState().modView;
      return v && v.modId === id ? { id: v.id, props: v.props } : null;
    },
    openDialog: (dialogId: string, props?: unknown) => useStore.getState().openDialog({ kind: "mod", modId: id, id: dialogId, props }),
    window: (new URLSearchParams(location.search).get("window") === "session" ? "session" : "main") as "main" | "session",
    notify: (title: string, body?: string, target?: unknown) =>
      void desktopNotify(title, body ?? "", target === undefined || target === null ? undefined : { __mod: id, target }),
    toast: (message: string, level?: "info" | "warn" | "error") => useStore.getState().toast(message, level),
    confirm: (o: { title: string; message: string; danger?: boolean }) =>
      new Promise<boolean>((resolve) => {
        let done = false;
        const finish = (v: boolean) => {
          if (!done) {
            done = true;
            off();
            resolve(v);
          }
        };
        useStore.getState().openDialog({ kind: "confirm", title: o.title, message: o.message, danger: o.danger, onConfirm: () => finish(true) });
        const opened = useStore.getState().dialog;
        const off = useStore.subscribe((s) => {
          if (s.dialog !== opened) finish(false);
        });
      }),
    onNotificationClick: (fn: (target: unknown) => void) => reg(slots.notificationClick, `n${seq++}`, { handle: fn }),
    suppressTurnToast: (fn: (s: Session) => boolean) => reg(slots.turnToastFilter, `t${seq++}`, { suppress: fn }),
  };
}

async function load(info: ModInfo) {
  const src = await client().call<{ js: string | null; css: string | null; version: string }>("mods.ui_source", { id: info.id });
  const old = loaded.get(info.id);
  if (old && old.js === src.js && old.css === src.css) return;
  // A new version takes over the old one's tabs.
  if (old) unload(info.id, false);
  if (!src.js) return;
  const disposers: Array<() => void> = [];
  const track = (d: () => void) => {
    disposers.push(d);
    return () => {
      const i = disposers.indexOf(d);
      if (i >= 0) disposers.splice(i, 1);
      d();
    };
  };
  let style: HTMLStyleElement | null = null;
  if (src.css) {
    style = document.createElement("style");
    style.dataset.mod = info.id;
    style.textContent = src.css;
    document.head.appendChild(style);
  }
  const entry: Loaded = {
    version: src.version,
    js: src.js,
    css: src.css,
    dispose: () => {
      for (const d of disposers.splice(0).reverse()) {
        try {
          d();
        } catch (e) {
          console.error(`[mod ${info.id}] dispose failed`, e);
        }
      }
      clearModContext(info.id);
      style?.remove();
    },
  };
  loaded.set(info.id, entry);
  const url = URL.createObjectURL(new Blob([src.js], { type: "text/javascript" }));
  try {
    const module = await import(/* @vite-ignore */ url);
    const activate = module.default;
    if (typeof activate !== "function") throw new Error("ui.js must default-export activate(ctx)");
    const deactivate = activate(makeCtx(info, track));
    if (typeof deactivate === "function") disposers.unshift(deactivate);
    useMods.setState((s) => {
      const { [info.id]: _, ...rest } = s.uiErrors;
      return { uiErrors: rest, loaded: [...loaded.keys()] };
    });
  } catch (e) {
    console.error(`[mod ${info.id}] failed to load its UI`, e);
    entry.dispose();
    loaded.delete(info.id);
    useMods.setState((s) => ({ uiErrors: { ...s.uiErrors, [info.id]: String((e as Error)?.message ?? e) }, loaded: [...loaded.keys()] }));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** `closeTabs`: the mod's tabs close too, unless it is being reloaded. */
function unload(id: string, closeTabs = true) {
  const l = loaded.get(id);
  if (!l) return;
  l.dispose();
  loaded.delete(id);
  settingListeners.delete(id);
  if (closeTabs) useStore.getState().closeModTabs(id);
  const d = useStore.getState().dialog;
  if (d.kind === "mod" && d.modId === id) useStore.getState().closeDialog();
  useMods.setState({ loaded: [...loaded.keys()] });
}

let syncing: Promise<void> | null = null;
let again = false;

/** Bring the loaded UI halves in line with the daemon's running mods. */
export async function syncMods(): Promise<void> {
  if (syncing) {
    again = true;
    return syncing;
  }
  syncing = (async () => {
    do {
      again = false;
      let list: ModInfo[];
      try {
        list = await client().call<ModInfo[]>("mods.list");
      } catch {
        return; // An older daemon without mods, or not connected.
      }
      useMods.setState({ mods: list });
      const wanted = new Set(list.filter((m) => m.hasUi && m.status?.state === "running").map((m) => m.id));
      for (const id of [...loaded.keys()]) if (!wanted.has(id)) unload(id);
      // Dependencies first, so a mod's UI can rely on the one it depends on.
      const ordered = [...list].sort((a, b) => (a.dependsOn?.[b.id] ? 1 : b.dependsOn?.[a.id] ? -1 : 0));
      for (const m of ordered) if (wanted.has(m.id)) await load(m).catch((e) => console.error(`[mod ${m.id}]`, e));
    } while (again);
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

/** Mount once at the app root: loads mods when connected and follows changes. */
export function useModLoader() {
  const c = useStore((s) => s.client);
  useEffect(() => {
    if (!c) return;
    installHostModules();
    onModNotificationClick((modId, target) => {
      for (const h of slots.notificationClick.list()) if (h.modId === modId) h.handle(target);
    });
    const offState = c.onState((s) => {
      if (s === "open") {
        void syncMods();
        void refreshInbox();
      }
    });
    const offNote = c.onNotification((method, params) => {
      const p = (params ?? {}) as { modId?: string; title?: unknown; body?: unknown; target?: unknown; key?: string; value?: unknown };
      if (method === "mods.changed") {
        void syncMods();
        void refreshInbox();
      } else if (method === "mods.inbox.changed" || method === "notifications.lagged") void refreshInbox();
      else if (method === "mods.notify") {
        void desktopNotify(String(p.title ?? ""), String(p.body ?? ""), p.target === undefined || p.target === null ? undefined : { __mod: p.modId, target: p.target });
      } else if (method === "mods.settings.changed" && p.modId && p.key) {
        const { modId, key } = p;
        useMods.setState((s) => ({
          mods: s.mods.map((m) => (m.id === modId ? { ...m, settingValues: { ...m.settingValues, [key]: p.value } } : m)),
        }));
        for (const fn of settingListeners.get(modId) ?? []) {
          try {
            fn(key, p.value);
          } catch (e) {
            console.error(e);
          }
        }
      }
    });
    void syncMods();
    void refreshInbox();
    return () => {
      offState();
      offNote();
    };
  }, [c]);
}

/** The daemon's mod methods, for the settings page. */
export const modsApi = {
  enable: (id: string) => client().call("mods.enable", { id }),
  disable: (id: string) => client().call("mods.disable", { id }),
  approve: (id: string) => client().call("mods.approve", { id }),
  reload: (id: string) => client().call("mods.reload", { id }),
  rescan: () => client().call("mods.rescan", {}),
  logs: (id: string) => client().call<string[]>("mods.logs", { id }),
  setSetting: (id: string, key: string, value: unknown) => client().call("mods.settings.set", { id, key, value }),
};
