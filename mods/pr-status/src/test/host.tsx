// A stand-in for "@aura/host" in this mod's UI tests (see vitest.config.ts): Aura's store with
// the fields the mod reads, and a plain ExternalLink.
import type { ComponentProps } from "react";
import { create } from "zustand";

export const useStore = create<{ selectedId: string | null; select: (id: string | null) => void; sessions: Record<string, { title: string }> }>((set) => ({
  selectedId: null,
  sessions: {},
  select: (selectedId) => set({ selectedId }),
}));

/** URLs opened in the system browser. */
export const opened: string[] = [];

export function ExternalLink({ href, children, ...props }: ComponentProps<"a"> & { href: string }) {
  return (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer"
      onClick={(event) => {
        event.preventDefault();
        opened.push(href);
      }}>
      {children}
    </a>
  );
}

/** Markdown as plain text: the tests check what is said, Aura's renderer does the rest. */
export function Markdown({ text }: { text: string; cwd?: string }) {
  return <div className="md">{text}</div>;
}

export * as diff from "../../../../apps/desktop/src/components/diff/parse";
export { timeAgo, exactTime } from "../../../../apps/desktop/src/lib/time";
