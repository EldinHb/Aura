import { useEffect, useState } from "react";
import { useStore } from "../../state/store";
import type { DailyUsageSettings } from "../../gen";
import { openUsage, usage } from "./state";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Settings → Usage: the daily summary, and the way to the dashboard. */
export function UsageSettingsTab() {
  const client = useStore((s) => s.client);
  const [daily, setDaily] = useState<DailyUsageSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!client) return;
    usage.daily().then(setDaily, (e) => setError(message(e)));
  }, [client]);
  const save = async (next: DailyUsageSettings) => {
    setDaily(next);
    try {
      setDaily(await usage.setDaily(next));
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <div>
      <div className="field">
        <label>Dashboard</label>
        <div className="dim" style={{ fontSize: 12, marginBottom: 6 }}>
          Tokens and cost of every agent turn, by day, session, feature, project, agent and model. Costs an agent does not report are estimated from list prices; models
          without a known price count in tokens only.
        </div>
        <button type="button" className="btn small" data-command="usage.open" onClick={() => openUsage()}>Open usage and cost…</button>
      </div>
      <div className="field">
        <label>
          <input type="checkbox" checked={!!daily?.enabled} disabled={!daily} onChange={(e) => daily && void save({ ...daily, enabled: e.target.checked })} style={{ marginRight: 6 }} />
          Daily usage summary at{" "}
          <input
            type="time"
            className="usage-time"
            aria-label="Time of the daily summary"
            value={daily?.time ?? "18:00"}
            disabled={!daily}
            onChange={(e) => daily && e.target.value && void save({ ...daily, time: e.target.value })}
          />
        </label>
        <span className="dim" style={{ fontSize: 11 }}>
          Aura writes a summary of the 24 hours before (totals, cost, the biggest sessions and features, what changed) and shows it as a notification here and on paired
          phones. It needs no model: it is made from the data. A time already past today starts tomorrow.
        </span>
        {error && <span className="err-text" style={{ fontSize: 12 }}>{error}</span>}
      </div>
    </div>
  );
}
