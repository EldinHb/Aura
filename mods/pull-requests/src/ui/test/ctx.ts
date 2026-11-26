// A stand-in `ctx` (UiApi) for the mod's UI tests: storage in a Map, daemon calls through
// vi.fn mocks, notifications delivered with `emit`, and the views, dialogs and toasts it
// was asked to show recorded for the test to read.
import { vi } from "vitest";
import type { CommandDef, KeyBindingDef, UiApi } from "@aura/mod-sdk/ui";
import { setCtx } from "../ctx";

type Fn = (payload: any) => void;

export function fakeCtx() {
  const listeners = new Map<string, Set<Fn>>();
  const connection = new Set<(state: "open" | "closed" | "connecting") => void>();
  const clicks = new Set<(target: any) => void>();
  const suppressors = new Set<(session: any) => boolean>();
  const storage = new Map<string, unknown>();
  const toasts: { message: string; level?: string }[] = [];
  const dialogs: { id: string; props: any }[] = [];
  const context = new Map<string, unknown>();
  const commands = new Map<string, CommandDef>();
  const bindings: KeyBindingDef[] = [];
  const slots: Record<string, unknown[]> = {};
  let view: { id: string; props: any } | null = null;
  const rpc = vi.fn(async (_method: string, _params?: unknown): Promise<any> => undefined);
  const call = vi.fn(async (_mod: string, _method: string, _params?: unknown): Promise<any> => []);
  const confirm = vi.fn(async () => true);
  const settings = vi.fn(async () => {});
  const slot = (name: string) => (def: unknown) => { (slots[name] ??= []).push(def); return () => { slots[name] = slots[name].filter((d) => d !== def); }; };
  const on = (map: Map<string, Set<Fn>>, name: string, fn: Fn) => {
    if (!map.has(name)) map.set(name, new Set());
    map.get(name)!.add(fn);
    return () => { map.get(name)!.delete(fn); };
  };
  const api: UiApi = {
    mod: { id: "pull-requests", version: "1.0.0" },
    rpc: (name, params) => rpc(name, params),
    call: (mod, name, params) => call(mod, name, params),
    on: (name, fn) => on(listeners, name, fn),
    onMod: (mod, name, fn) => on(listeners, `${mod}:${name}`, fn),
    onConnection: (fn) => { connection.add(fn); return () => { connection.delete(fn); }; },
    client: { call: async () => undefined as any },
    storage: {
      get: (key) => storage.get(key) as any,
      set: (key, value) => { storage.set(key, value); },
      delete: (key) => { storage.delete(key); },
    },
    settings: { get: () => null as any, set: settings, onChange: () => () => {} },
    commands: {
      register: (cmd) => { const id = cmd.id.startsWith("pull-requests.") ? cmd.id : `pull-requests.${cmd.id}`; commands.set(id, { ...cmd, id }); return () => { commands.delete(id); }; },
      run: (id, arg) => { void commands.get(id)?.run(arg); },
    },
    keys: { bind: (b) => { bindings.push(b); return () => {}; }, group: () => () => {} },
    context: { set: (key, value) => { context.set(key, value); } },
    ui: {
      sidebarSection: slot("sidebarSection"), inspectorSection: slot("inspectorSection"), sessionRowChips: slot("sessionRowChips"),
      branchDecoration: slot("branchDecoration"), statusBarItem: slot("statusBarItem"), settingsTab: slot("settingsTab"),
      newSessionField: slot("newSessionField"), inboxRenderer: slot("inboxRenderer"), transcriptLinks: slot("transcriptLinks"),
      view: slot("view"), dialog: slot("dialog"),
    },
    openView: (id, props) => { view = { id, props }; },
    closeView: () => { view = null; },
    activeView: () => view,
    openDialog: (id, props) => { dialogs.push({ id, props }); },
    toast: (message, level) => { toasts.push({ message, level }); },
    confirm,
    onNotificationClick: (fn) => { clicks.add(fn); return () => { clicks.delete(fn); }; },
    suppressTurnToast: (fn) => { suppressors.add(fn); return () => { suppressors.delete(fn); }; },
  };
  return {
    api, rpc, call, confirm, settings, storage, toasts, dialogs, context, commands, bindings, slots,
    view: () => view,
    /** Deliver notification `name` of the mod's daemon half. */
    emit: (name: string, payload: unknown = {}) => { for (const fn of [...(listeners.get(name) ?? [])]) fn(payload); },
    connect: (state: "open" | "closed" | "connecting" = "open") => { for (const fn of [...connection]) fn(state); },
    clickNotification: (target: unknown) => { for (const fn of [...clicks]) fn(target); },
    suppressed: (session: unknown) => [...suppressors].some((fn) => fn(session)),
  };
}

export type FakeCtx = ReturnType<typeof fakeCtx>;

/** A fresh fake, set as the mod's ctx. */
export function installFakeCtx(): FakeCtx {
  const fake = fakeCtx();
  setCtx(fake.api);
  return fake;
}
