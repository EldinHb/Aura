// The UI half's `ctx`, for the stores and components it activates.
import type { UiApi } from "@aura/mod-sdk/ui";

let current: UiApi | null = null;

export function setCtx(ctx: UiApi | null): void {
  current = ctx;
}

export function getCtx(): UiApi | null {
  return current;
}

/** Call this mod's daemon half. Rejects while the mod is not active. */
export function rpc<T = any>(name: string, params?: unknown): Promise<T> {
  if (!current) return Promise.reject(new Error("The GitHub mod is not active"));
  return current.rpc<T>(name, params);
}

/** Aura's core RPC client (for core methods such as git.branch_status). */
export function coreCall<T = any>(method: string, params?: unknown): Promise<T> {
  if (!current) return Promise.reject(new Error("The GitHub mod is not active"));
  return current.client.call<T>(method, params);
}
