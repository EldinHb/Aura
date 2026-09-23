import { create } from "zustand";
import type { ImageInput } from "../gen";

export type ComposerDraft = { text: string; images: ImageInput[]; start: number; end: number; sending: boolean };
export const emptyDraft: ComposerDraft = { text: "", images: [], start: 0, end: 0, sending: false };
export const useComposerDrafts = create<{ drafts: Record<string, ComposerDraft> }>(() => ({ drafts: {} }));
export function updateDraft(id: string, update: (draft: ComposerDraft) => Partial<ComposerDraft>) {
  useComposerDrafts.setState((state) => {
    const draft = state.drafts[id] ?? emptyDraft;
    return { drafts: { ...state.drafts, [id]: { ...draft, ...update(draft) } } };
  });
}
