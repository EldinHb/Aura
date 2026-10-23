import { create } from "zustand";
import type { DraftImage } from "../lib/images";

/**
 * Per-session composer state. In memory only: drafts and their images survive
 * switching sessions, not a reload.
 */
export type ComposerDraft = {
  /** Markdown, in either mode of the composer. */
  text: string;
  images: DraftImage[];
  /** The selection: offsets in `text`, or positions in the rich editor when `richSelection`. */
  start: number;
  end: number;
  richSelection?: boolean;
  /** Messages from this box still on their way to the agent. */
  sending: number;
};
export const emptyDraft: ComposerDraft = { text: "", images: [], start: 0, end: 0, sending: 0 };
export const useComposerDrafts = create<{ drafts: Record<string, ComposerDraft> }>(() => ({ drafts: {} }));
export function updateDraft(id: string, update: (draft: ComposerDraft) => Partial<ComposerDraft>) {
  useComposerDrafts.setState((state) => {
    const draft = state.drafts[id] ?? emptyDraft;
    return { drafts: { ...state.drafts, [id]: { ...draft, ...update(draft) } } };
  });
}
