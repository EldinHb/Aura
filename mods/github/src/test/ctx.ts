// A UiApi for tests: rpc answers from a function; registrations are recorded.
import { vi } from "vitest";
import type { UiApi } from "@aura/mod-sdk/ui";
import { createTestHost } from "@aura/mod-sdk/testing";
import { activate } from "../daemon";
import { setCtx } from "../ui/ctx";

/**
 * A UiApi whose rpc reaches this mod's real daemon half on a test host, with its
 * notifications delivered to `ctx.on` listeners. `answer` may take a call first
 * (return undefined to pass it on).
 */
export function daemonCtx(answer: Answer = () => undefined, core?: (method: string, params: any) => unknown) {
  const host = createTestHost({ id: "github" });
  let deliver: (name: string, payload: unknown) => void = () => {};
  const emit = host.api.emit;
  host.api.emit = (name, payload) => {
    emit(name, payload);
    deliver(name, JSON.parse(JSON.stringify(payload ?? null)));
  };
  activate(host.api);
  const fake = fakeCtx(async (name, params) => {
    const own = await answer(name, params);
    return own !== undefined ? own : host.call(name, params);
  }, core);
  deliver = fake.emit;
  return { ...fake, host };
}

export type Answer = (name: string, params: any) => unknown;

export function fakeCtx(answer: Answer, core: (method: string, params: any) => unknown = () => null) {
  const registered: Array<{ kind: string; def: any }> = [];
  const listeners = new Map<string, Array<(payload: any) => void>>();
  const reg = (kind: string) => (def: any) => {
    registered.push({ kind, def });
    return () => {};
  };
  const rpc = vi.fn(async (name: string, params?: unknown) => answer(name, params));
  const call = vi.fn(async (method: string, params?: unknown) => core(method, params));
  const openDialog = vi.fn();
  const ctx = {
    mod: { id: "github", version: "test" },
    window: "main",
    rpc,
    call: vi.fn(),
    on: (name: string, fn: (payload: any) => void) => {
      listeners.set(name, [...(listeners.get(name) ?? []), fn]);
      return () => {};
    },
    onMod: () => () => {},
    onConnection: () => () => {},
    client: { call },
    storage: { get: () => undefined, set: () => {}, delete: () => {} },
    settings: { get: () => null as never, set: async () => {}, onChange: () => () => {} },
    commands: { register: reg("command"), run: () => {} },
    keys: { bind: reg("key"), group: reg("keyGroup") },
    context: { set: () => {} },
    ui: new Proxy({}, { get: (_t, kind: string) => reg(kind) }),
    openView: () => {},
    closeView: () => {},
    activeView: () => null,
    openDialog,
    notify: () => {},
    toast: () => {},
    confirm: async () => true,
    onNotificationClick: () => () => {},
    suppressTurnToast: () => () => {},
  } as unknown as UiApi;
  setCtx(ctx);
  return {
    ctx,
    rpc,
    call,
    openDialog,
    registered,
    emit: (name: string, payload: unknown) => listeners.get(name)?.forEach((fn) => fn(payload)),
  };
}
