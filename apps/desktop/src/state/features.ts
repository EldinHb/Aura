import { create } from "zustand";
import type { Feature, SpecialistSuggestion } from "../gen";

/**
 * Feature owner id → its feature, as the daemon last announced it: loaded on
 * connect, then kept current by `feature_updated` events.
 */
export const useFeatures = create<{ features: Record<string, Feature> }>(() => ({ features: {} }));

export function setFeatures(list: Feature[]) {
  useFeatures.setState({ features: Object.fromEntries(list.map((f) => [f.owner_id, f])) });
}

export function setFeature(f: Feature) {
  useFeatures.setState((s) => ({ features: { ...s.features, [f.owner_id]: f } }));
}

export function dropFeature(ownerId: string) {
  useFeatures.setState((s) => {
    if (!(ownerId in s.features)) return s;
    const { [ownerId]: _gone, ...rest } = s.features;
    return { features: rest };
  });
}

/** The feature `ownerId` owns, once known. */
export function useFeature(ownerId: string | null | undefined): Feature | undefined {
  return useFeatures((s) => (ownerId ? s.features[ownerId] : undefined));
}

/**
 * The specialists Aura suggested from repeated ad-hoc work, pending and
 * resolved: loaded on connect, then kept current by
 * `specialist_suggestions_updated` events. They belong to no feature.
 */
export const useRoleSuggestions = create<{ suggestions: SpecialistSuggestion[] }>(() => ({ suggestions: [] }));

export function setRoleSuggestions(suggestions: SpecialistSuggestion[]) {
  useRoleSuggestions.setState({ suggestions });
}

/** One suggestion Aura found, by id. */
export function useRoleSuggestion(id: string): SpecialistSuggestion | undefined {
  return useRoleSuggestions((s) => s.suggestions.find((x) => x.id === id));
}
