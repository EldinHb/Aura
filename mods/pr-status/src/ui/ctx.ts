// The UI half's `ctx`, for the hooks and components it activates.
import type { UiApi } from "@aura/mod-sdk/ui";

let current: UiApi | null = null;

export function setCtx(ctx: UiApi | null): void {
  current = ctx;
}

export function getCtx(): UiApi | null {
  return current;
}
