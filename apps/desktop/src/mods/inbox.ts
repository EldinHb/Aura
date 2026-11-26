/** What mods put in Aura's inbox (`aura.inbox.set`), per mod. */
import { create } from "zustand";
import type { InboxItem } from "./registry";

export const useModInbox = create<{ items: Array<{ modId: string; items: InboxItem[] }> }>(() => ({ items: [] }));

export function unreadModItems(items = useModInbox.getState().items): number {
  return items.reduce((n, m) => n + m.items.filter((i) => i.unread).length, 0);
}
