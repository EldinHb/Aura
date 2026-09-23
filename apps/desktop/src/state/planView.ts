import { create } from "zustand";

type PlanView = { open: boolean; selectedId?: string };
function loadViews(): Record<string, PlanView> {
  try {
    const saved = JSON.parse(localStorage.getItem("aura.plan-views.v1") ?? "{}");
    return Object.fromEntries(Object.entries(saved).filter(([, value]) => value && typeof value === "object" && "open" in value && typeof value.open === "boolean"
      && (!("selectedId" in value) || typeof value.selectedId === "string"))) as Record<string, PlanView>;
  } catch { return {}; }
}
export const usePlanViews = create<{ views: Record<string, PlanView> }>(() => ({ views: loadViews() }));
export function setPlanView(sessionId: string, patch: Partial<PlanView>) {
  usePlanViews.setState((state) => ({ views: { ...state.views, [sessionId]: { ...(state.views[sessionId] ?? { open: true }), ...patch } } }));
  try { localStorage.setItem("aura.plan-views.v1", JSON.stringify(usePlanViews.getState().views)); } catch { /* Keep the view usable when storage is unavailable. */ }
}
