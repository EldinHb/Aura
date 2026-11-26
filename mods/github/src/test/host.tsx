// A stand-in for "@aura/host" in this mod's UI tests (see vitest.config.ts): Aura's store
// with the fields the mod reads, and plain versions of the components it renders.
import type { ComponentProps, ReactNode } from "react";
import { create } from "zustand";

type AnyState = Record<string, any>;

export const useStore = create<AnyState>((set) => ({
  client: null,
  connection: "open",
  sessions: {},
  transcripts: {},
  selectedId: null,
  dialog: { kind: "none" },
  openDialog: (dialog: unknown) => set({ dialog }),
  closeDialog: () => set({ dialog: { kind: "none" } }),
  toast: () => {},
}));

/** URLs opened in the system browser. */
export const opened: string[] = [];

export function openExternal(url: string) {
  opened.push(url);
}

export function ExternalLink({ href, children, ...props }: ComponentProps<"a"> & { href: string }) {
  return (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer" data-hint
      onClick={(event) => {
        event.preventDefault();
        openExternal(href);
      }}>
      {children}
    </a>
  );
}

export function Modal({ title, children, footer, onClose }: { title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number; onClose?: () => void }) {
  return (
    <div role="dialog" aria-label={typeof title === "string" ? title : undefined}>
      <h2>{title}</h2>
      {children}
      {footer}
      <button type="button" data-testid="modal-close" onClick={onClose} hidden />
    </div>
  );
}

/** An empty transcript, as Aura's store makes one. */
export function emptyTranscript() {
  return { loaded: false, loading: false, lastSeq: 0, turns: [], order: [], items: {} };
}
