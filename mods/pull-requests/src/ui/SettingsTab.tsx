/**
 * Settings → Pull requests: the PR settings formerly in the General tab of Aura's settings
 * (pull filters, PR change kinds), and the merge choices the PR page remembers.
 */
import { PULL_CHANGE_KINDS } from "./reviews/changes";
import { pullFilterError } from "./reviews/state";
import { defaultPrSettings, usePrSettings } from "./settings";

const MERGE_METHODS: { value: string; label: string }[] = [
  { value: "", label: "The repository's default" },
  { value: "merge", label: "Create a merge commit" },
  { value: "squash", label: "Squash and merge" },
  { value: "rebase", label: "Rebase and merge" },
];

export function PullSettingsTab() {
  const settings = usePrSettings();
  const set = settings.set;
  return (
    <div className="settings-grid">
      <div className="field wide">
        <label>Pull request changes in the inbox and notifications</label>
        {PULL_CHANGE_KINDS.map(({ kind, label }) => (
          <label key={kind} className="check-row">
            <input type="checkbox" checked={!settings.pullChangesMuted.includes(kind)} onChange={(e) => set({ pullChangesMuted: e.target.checked ? settings.pullChangesMuted.filter((k) => k !== kind) : [...settings.pullChangesMuted, kind] })} /> {label}
          </label>
        ))}
      </div>
      <div className="field wide">
        <label htmlFor="pull-filters">Hide pull requests matching (one rule per line)</label>
        <textarea id="pull-filters" rows={4} spellCheck={false} className="mono" value={settings.pullFilters.join("\n")} placeholder="author:dependabot" onChange={(e) => set({ pullFilters: e.target.value.split("\n") })} />
        {settings.pullFilters.map(pullFilterError).filter(Boolean).map((error) => <div key={error} className="dim" style={{ fontSize: 11, color: "var(--warn)" }}>{error}</div>)}
        <div className="dim" style={{ fontSize: 11 }}>
          <span className="mono">author:</span>, <span className="mono">label:</span>, <span className="mono">repo:</span>, <span className="mono">title:</span> or <span className="mono">draft</span>; <span className="mono">*</span> matches anything, e.g. <span className="mono">repo:acme/*</span>. Matching PRs are listed with Show hidden.
        </div>
      </div>
      <div className="field">
        <label htmlFor="pull-merge-method">Merge method</label>
        <select id="pull-merge-method" value={settings.mergeMethod} onChange={(e) => set({ mergeMethod: e.target.value })}>
          {MERGE_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
        <div className="dim" style={{ fontSize: 11 }}>Used when the repository allows it; the PR page remembers the last one chosen.</div>
      </div>
      <label className="check-row">
        <input type="checkbox" checked={settings.deleteBranchAfterMerge} onChange={(e) => set({ deleteBranchAfterMerge: e.target.checked })} /> Delete the branch on GitHub after merging
      </label>
      <div>
        <button type="button" className="btn" data-hint onClick={() => set(defaultPrSettings)}>Reset to defaults</button>
      </div>
    </div>
  );
}
