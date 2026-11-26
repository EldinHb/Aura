import { createContext, useContext } from "react";

/**
 * Whether the main-area tab a component is in is the one shown. Every open tab
 * stays mounted (hidden) so it keeps its state; what drives app-wide state, such
 * as the transcript's keyboard handle, only does so while its tab is active.
 * True outside tabs (a detached session window, tests).
 */
export const TabActiveContext = createContext(true);

export function useTabActive(): boolean {
  return useContext(TabActiveContext);
}
