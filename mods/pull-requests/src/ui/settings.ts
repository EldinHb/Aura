/**
 * The mod's own settings, formerly in Aura's UiSettings: which PRs the sidebar hides, which
 * kinds of PR change are announced, and the merge choices. Kept in `ctx.storage`.
 */
import { create } from "zustand";
import { ctx, store, stored } from "./ctx";

export type PrSettings = {
  /** Rules that hide pull requests from the sidebar (see `pullFilter`). */
  pullFilters: string[];
  /** Kinds of pull request change (see `PULL_CHANGE_KINDS`) left out of the inbox and notifications. */
  pullChangesMuted: string[];
  /** The merge method last chosen; empty for the repository's default. */
  mergeMethod: string;
  deleteBranchAfterMerge: boolean;
};

export const defaultPrSettings: PrSettings = { pullFilters: ["author:dependabot"], pullChangesMuted: [], mergeMethod: "", deleteBranchAfterMerge: true };

const KEYS = Object.keys(defaultPrSettings) as (keyof PrSettings)[];

type SettingsState = PrSettings & {
  /** Read the stored values; called on activate. */
  load: () => void;
  set: (patch: Partial<PrSettings>) => void;
};

const valid = (key: keyof PrSettings, value: unknown) =>
  Array.isArray(defaultPrSettings[key]) ? Array.isArray(value) && value.every((v) => typeof v === "string") : typeof value === typeof defaultPrSettings[key];

export const usePrSettings = create<SettingsState>((set) => ({
  ...defaultPrSettings,
  load: () => {
    const loaded: Partial<PrSettings> = {};
    for (const key of KEYS) {
      const value = stored<unknown>(key, undefined);
      if (value !== undefined && valid(key, value)) Object.assign(loaded, { [key]: value });
    }
    set({ ...defaultPrSettings, ...loaded });
  },
  set: (patch) => {
    for (const [key, value] of Object.entries(patch)) store(key, value);
    if (patch.pullChangesMuted) shareMuted(patch.pullChangesMuted);
    set(patch);
  },
}));

/**
 * The daemon half mirrors unread changes into Aura's inbox and cannot read this storage.
 * SDK-GAP: there is no UI-to-daemon setting other than the manifest's `settings`; this
 * offers the muted kinds there too, for a manifest that declares `pullChangesMuted`.
 */
function shareMuted(muted: string[]) {
  try { void ctx().settings.set("pullChangesMuted", muted).catch(() => {}); } catch { /* not active */ }
}
