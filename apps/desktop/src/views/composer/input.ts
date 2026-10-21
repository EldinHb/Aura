/**
 * What the composer needs from its text field, in either mode: the plain
 * markdown textarea or the rich editor.
 */
export type ComposerInput = {
  element: () => HTMLElement | null;
  focus: () => void;
  /** The caret's line up to the caret, and whether the caret is on the first or last line. */
  caret: () => { before: string; firstLine: boolean; lastLine: boolean };
  /** Replaces the `length` characters before the caret with `text`, the caret after it. */
  replaceBeforeCaret: (length: number, text: string) => void;
};

/** The parts of a key event the composer reads, from React or the editor. */
export type KeyLike = {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing?: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
};
