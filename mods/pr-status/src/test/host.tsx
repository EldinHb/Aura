// A stand-in for "@aura/host" in this mod's UI tests (see vitest.config.ts): Aura's store with
// the fields the mod reads, and a plain ExternalLink.
import type { ComponentProps } from "react";
import { create } from "zustand";

export const useStore = create<{ selectedId: string | null; select: (id: string | null) => void }>((set) => ({
  selectedId: null,
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
