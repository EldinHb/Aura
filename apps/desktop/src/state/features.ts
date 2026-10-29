import { create } from "zustand";
import type { Feature } from "../gen";

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
