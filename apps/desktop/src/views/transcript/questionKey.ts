import { useShortcut } from "../../hooks/useKeyboard";
import { useStore } from "../../state/store";

/**
 * The key that takes the keyboard to a waiting question, as the keymap binds it. From the message box and the
 * transcript that is Escape (`ui.escape` moves to the main region, where the question comes first); from anywhere
 * else Escape stays put, so it is the "focus transcript" binding. Null when neither is bound.
 */
export function useQuestionKey(): string | null {
  const region = useStore((s) => s.focus);
  const escape = useShortcut("ui.escape");
  const main = useShortcut("focus.main");
  const key = region === "composer" || region === "main" ? (escape ?? main) : main;
  // The macOS glyph for a lone Escape (⎋) is easy to miss in a hint that has to be read at a glance.
  return key === "⎋" ? "Esc" : key;
}
