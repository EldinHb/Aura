/**
 * Registries mods contribute to: UI slots, keybindings, which-key labels and
 * `when` context. Core components render a slot with `useSlot(slots.x)`.
 * Everything a mod registers is removed again when the mod is unloaded.
 */
import { useSyncExternalStore } from "react";
import type { ComponentType } from "react";
import type { Session } from "../gen";
import type { Binding } from "../lib/keymap";

export type Entry<T> = T & { modId: string; key: string; order: number };

export class Registry<T> {
  private items: Entry<T>[] = [];
  private listeners = new Set<() => void>();

  register(modId: string, id: string, item: T & { order?: number }): () => void {
    const key = `${modId}:${id}`;
    const entry = { order: 100, ...item, modId, key } as Entry<T>;
    this.items = [...this.items.filter((i) => i.key !== key), entry].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
    this.emit();
    return () => {
      const before = this.items.length;
      this.items = this.items.filter((i) => i !== entry);
      if (this.items.length !== before) this.emit();
    };
  }

  list(): Entry<T>[] {
    return this.items;
  }

  get(modId: string, id: string): Entry<T> | undefined {
    return this.items.find((i) => i.key === `${modId}:${id}`);
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  private emit() {
    for (const l of [...this.listeners]) l();
  }
}

export function useSlot<T>(r: Registry<T>): Entry<T>[] {
  return useSyncExternalStore(r.subscribe, () => r.list(), () => r.list());
}

type Comp<P> = { component: ComponentType<P> };

export const slots = {
  sidebarSection: new Registry<Comp<{ focused: boolean }> & { title?: string }>(),
  inspectorSection: new Registry<Comp<{ session: Session }>>(),
  sessionRowChips: new Registry<Comp<{ session: Session; selected: boolean }>>(),
  branchDecoration: new Registry<Comp<{ cwd: string; status: unknown; place: "statusbar" | "inspector" | "row"; session: Session | null }>>(),
  statusBarItem: new Registry<Comp<Record<string, never>>>(),
  settingsTab: new Registry<Comp<Record<string, never>> & { title: string }>(),
  newSessionField: new Registry<Comp<{ cwd: string | null; onChange(c: { prompt?: string; data?: unknown } | null): void }>>(),
  inboxRenderer: new Registry<Comp<{ item: InboxItem }> & { open?(item: InboxItem): void }>(),
  transcriptLinks: new Registry<{ detect(text: string, session: Session): TranscriptLink[] }>(),
  view: new Registry<Comp<{ props: unknown; close(): void; active?: boolean }> & { title: string }>(),
  dialog: new Registry<Comp<{ props: unknown; close(): void }>>(),
  keybinding: new Registry<{ binding: Binding }>(),
  keyGroup: new Registry<{ prefix: string; label: string }>(),
  turnToastFilter: new Registry<{ suppress(session: Session): boolean }>(),
  notificationClick: new Registry<{ handle(target: unknown): void }>(),
};

export type InboxItem = { id: string; title: string; detail?: string; at: string; unread: boolean; data?: unknown };
export type TranscriptLink = { label: string; url: string; kind: string };

/** `when` context keys set by mods ("mod.<id>.<key>"). */
const context = new Map<string, unknown>();
const contextListeners = new Set<() => void>();
export function setModContext(key: string, value: unknown) {
  if (value === null || value === undefined || value === false) context.delete(key);
  else context.set(key, value);
  for (const l of [...contextListeners]) l();
}
export function modContext(key: string): unknown {
  return context.get(key);
}
export function clearModContext(modId: string) {
  for (const k of [...context.keys()]) if (k.startsWith(`mod.${modId}.`)) context.delete(k);
  for (const l of [...contextListeners]) l();
}
