import { useEffect, useMemo, useRef } from "react";
import { Keymap, chordFromEvent, type Binding } from "../lib/keymap";
import { runCommand } from "../lib/commands";
import { useStore } from "../state/store";
import { defaultBindings, groupLabels, vimExtraBindings } from "../keymap/default";
import { isMac } from "../lib/platform";
import { currentCommandContext, isActivatableEl } from "./useCommandContext";

let activeKeymap: Keymap | null = null;
export function getKeymap(): Keymap | null {
  return activeKeymap;
}

export function buildBindings(preset: string, overrides: Binding[]): Binding[] {
  const base = [...defaultBindings, ...(preset === "vim" ? vimExtraBindings : [])];
  // overrides replace bindings for the same command+keys; an override with command "" unbinds keys.
  const out = base.filter((b) => !overrides.some((o) => o.keys === b.keys));
  for (const o of overrides) if (o.command) out.push(o);
  return out;
}

/** Installs the global keydown handler. Mount once at the app root. */
export function useKeyboard() {
  const settings = useStore((s) => s.settings);
  const keymap = useMemo(() => {
    const km = new Keymap(buildBindings(settings.keymapPreset, settings.keymapOverrides), isMac, settings.leader);
    km.setGroupLabels(groupLabels);
    return km;
  }, [settings.keymapPreset, settings.keymapOverrides, settings.leader]);
  const kmRef = useRef(keymap);
  kmRef.current = keymap;
  activeKeymap = keymap;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      // Hint mode and the palette own the keyboard while active.
      if (st.hintMode || st.paletteOpen) return;
      const chord = chordFromEvent(e, isMac);
      if (!chord) return;
      const ctx = currentCommandContext();
      // A focused button / link owns enter and space; that is what the control does natively.
      if ((chord === "enter" || chord === "space") && isActivatableEl(document.activeElement)) return;
      // Dialogs and focused `data-keynav` widgets: only escape and modifier chords
      // reach the keymap; the dialog / widget handles its own keys.
      if ((ctx.dialogOpen || ctx.widgetFocused) && chord !== "escape" && !/(ctrl|cmd|alt)\+/.test(chord) && kmRef.current.pendingPrefix.length === 0) return;
      const res = kmRef.current.handle(chord, ctx, () => st.setWhichKey(null));
      if (res.kind === "none") return;
      e.preventDefault();
      e.stopPropagation();
      if (res.kind === "pending") {
        st.setWhichKey({ prefix: res.prefix, candidates: res.candidates.map((c) => ({ key: c.key, label: c.label })) });
        return;
      }
      st.setWhichKey(null);
      if (res.command === "keymap.cancel") return;
      void runCommand(res.command, res.arg);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
  return keymap;
}
