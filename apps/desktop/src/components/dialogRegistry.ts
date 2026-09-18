/**
 * Registry for dialog kinds implemented outside the overlay layer (settings,
 * search, inbox, diff). Views call `registerDialog` at module load; Overlays
 * renders whatever is registered and a placeholder otherwise.
 */
import type { ComponentType } from "react";
import type { Dialog } from "../state/store";

type Kind = Dialog["kind"];
const registry = new Map<Kind, ComponentType<{ dialog: Dialog }>>();
const listeners = new Set<() => void>();

export function registerDialog(kind: Kind, component: ComponentType<{ dialog: Dialog }>) {
  registry.set(kind, component);
  for (const l of listeners) l();
}
export function getDialog(kind: Kind) {
  return registry.get(kind);
}
export function onDialogsChanged(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
