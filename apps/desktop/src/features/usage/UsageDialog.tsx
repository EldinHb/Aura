import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { ModalC } from "../../components/ModalC";
import { useStore } from "../../state/store";
import { Markdown } from "../../views/transcript/MarkdownView";
import type { UsageGroup, UsageGroupBy, UsageReport, UsageSummary } from "../../gen";
import { colorsFor, Legend, StackedBars, type Stack } from "./charts";
import {
  cacheHitRate, change, dayLabel, days, fmtCost, fmtPct, fmtTokens, period, previous, totalTokens, type Period, type PeriodKey,
} from "./format";
import { openUsage, usage, useUsageReports } from "./state";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "today", label: "Today" }, { key: "7d", label: "7 days" }, { key: "30d", label: "30 days" }, { key: "custom", label: "Custom" },
];
const TABLES: { key: UsageGroupBy; label: string }[] = [
  { key: "session", label: "Sessions" }, { key: "feature", label: "Features" }, { key: "project", label: "Projects" }, { key: "model", label: "Models" }, { key: "agent", label: "Agents" },
];
type Metric = "cost" | "tokens";

type Data = { days: UsageSummary; before: UsageSummary; tables: Partial<Record<UsageGroupBy, UsageSummary>> };

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The global usage dashboard: a period, its totals against the one before, a chart per day and the biggest spenders. */
export function UsageDialog() {
  const client = useStore((s) => s.client);
  const [periodKey, setPeriodKey] = useState<PeriodKey>("7d");
  const [custom, setCustom] = useState(() => ({ from: isoDay(new Date(Date.now() - 13 * 86_400_000)), to: isoDay(new Date()) }));
  const [metric, setMetric] = useState<Metric>("cost");
  const [stackBy, setStackBy] = useState<"model" | "agent">("model");
  const [table, setTable] = useState<UsageGroupBy>("session");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const p = useMemo(() => period(periodKey, new Date(), custom), [periodKey, custom]);
  const seen = useUsageReports((s) => s.seen);
  useEffect(() => seen(), [seen]);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setLoading(true);
    const prev = previous(p);
    Promise.all([
      usage.summary({ from: p.from, to: p.to, groupBy: "day", splitBy: stackBy }),
      usage.summary({ from: prev.from, to: prev.to, groupBy: "agent" }),
      ...TABLES.map((t) => usage.summary({ from: p.from, to: p.to, groupBy: t.key, limit: 10 })),
    ])
      .then(([daysSummary, before, ...tables]) => {
        if (cancelled) return;
        setData({ days: daysSummary, before, tables: Object.fromEntries(TABLES.map((t, i) => [t.key, tables[i]])) });
        setError(null);
      })
      .catch((e) => !cancelled && setError(message(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [client, p, stackBy]);

  // Any cost at all? Without one (Codex with unknown prices, say) the chart shows tokens.
  const hasCost = (data?.days.totals.costUsd ?? 0) > 0;
  const shown: Metric = hasCost ? metric : "tokens";
  const value = (g: UsageGroup) => (shown === "cost" ? g.totals.costUsd : totalTokens(g.totals));
  const fmt = (v: number) => (shown === "cost" ? fmtCost(v) : fmtTokens(v));

  const { stacks, series } = useMemo(() => {
    if (!data) return { stacks: [] as Stack[], series: [] as { key: string; label: string }[] };
    const sums = new Map<string, { label: string; v: number }>();
    for (const d of data.days.groups) for (const part of d.parts) {
      const cur = sums.get(part.key) ?? { label: part.label, v: 0 };
      cur.v += value(part);
      sums.set(part.key, cur);
    }
    const series = [...sums.entries()].sort((a, b) => b[1].v - a[1].v).map(([key, s]) => ({ key, label: s.label }));
    const long = data.days.groups.length > 14;
    const stacks = data.days.groups.map((d) => ({
      key: d.key,
      label: dayLabel(d.key, long),
      segments: series.map((s) => ({ key: s.key, value: d.parts.find((x) => x.key === s.key) ? value(d.parts.find((x) => x.key === s.key)!) : 0 })),
      title: `${dayLabel(d.key, true)}: ${fmt(value(d))}${d.parts.length ? "\n" + d.parts.map((x) => `${x.label}: ${fmt(value(x))}`).join("\n") : ""}`,
    }));
    return { stacks, series };
  }, [data, shown]); // eslint-disable-line react-hooks/exhaustive-deps
  const colors = useMemo(() => colorsFor(series.map((s) => s.key)), [series]);

  const t = data?.days.totals;
  const b = data?.before.totals;
  return (
    <ModalC
      title={<>
        <span>Usage and cost</span>
        <span style={{ flex: 1 }} />
        <span className="dim" style={{ fontWeight: 400, fontSize: 11 }}>Costs with ~ are estimates from list prices</span>
      </>}
      width="min(1120px, 95vw)"
      height="88vh"
      className="usage-modal"
    >
      <div className="usage-body">
        <div className="usage-toolbar">
          <div className="radio-row" role="radiogroup" aria-label="Period">
            {PERIODS.map((x) => (
              <button key={x.key} type="button" role="radio" aria-checked={periodKey === x.key} className={clsx("btn small", periodKey === x.key && "primary")} data-command="usage.period" onClick={() => setPeriodKey(x.key)}>{x.label}</button>
            ))}
          </div>
          {periodKey === "custom" && (
            <span className="usage-range">
              <input type="date" aria-label="From" value={custom.from} max={custom.to} onChange={(e) => e.target.value && setCustom((c) => ({ ...c, from: e.target.value }))} />
              <span className="dim">to</span>
              <input type="date" aria-label="To" value={custom.to} min={custom.from} onChange={(e) => e.target.value && setCustom((c) => ({ ...c, to: e.target.value }))} />
            </span>
          )}
          <span style={{ flex: 1 }} />
          {loading && <span className="dim">Loading…</span>}
        </div>
        {error && <p className="usage-error">Could not load usage: {error}</p>}
        {t && b && (
          <div className="usage-cards">
            <StatCard label="Cost" value={fmtCost(t.costUsd)} delta={change(t.costUsd, b.costUsd)} lowerIsBetter
              note={t.estimatedCostUsd > 0 ? `${fmtCost(t.estimatedCostUsd, true)} estimated` : t.unpricedTurns > 0 ? `${t.unpricedTurns} turns tokens only` : "as reported"} />
            <StatCard label="Tokens" value={fmtTokens(totalTokens(t))} delta={change(totalTokens(t), totalTokens(b))} lowerIsBetter
              note={`${fmtTokens(t.inputTokens)} in · ${fmtTokens(t.outputTokens)} out · ${fmtTokens(t.cachedInputTokens)} cache`} />
            <StatCard label="Turns" value={String(t.turns)} delta={change(t.turns, b.turns)} note={`${days(p)} day${days(p) === 1 ? "" : "s"}`} />
            <StatCard label="Cache hit rate" value={fmtPct(cacheHitRate(t))} note={`before: ${fmtPct(cacheHitRate(b))}`} />
          </div>
        )}
        {data && (
          <section className="usage-section">
            <div className="usage-section-head">
              <h4>{shown === "cost" ? "Cost" : "Tokens"} per day</h4>
              <span style={{ flex: 1 }} />
              {hasCost && (
                <div className="radio-row" role="radiogroup" aria-label="Metric">
                  {(["cost", "tokens"] as Metric[]).map((m) => (
                    <button data-hint key={m} type="button" role="radio" aria-checked={metric === m} className={clsx("btn small", metric === m && "primary")} onClick={() => setMetric(m)}>{m === "cost" ? "Cost" : "Tokens"}</button>
                  ))}
                </div>
              )}
              <label className="dim usage-by">by{" "}
                <select value={stackBy} onChange={(e) => setStackBy(e.target.value as "model" | "agent")}>
                  <option value="model">model</option>
                  <option value="agent">agent</option>
                </select>
              </label>
            </div>
            {data.days.totals.turns === 0 ? <div className="usage-empty dim">No agent turns in this period.</div> : (
              <>
                <StackedBars stacks={stacks} colors={colors} format={fmt} ariaLabel={`${shown} per day`} />
                <Legend items={series} colors={colors} />
              </>
            )}
          </section>
        )}
        {data && (
          <div className="usage-columns">
            <section className="usage-section">
              <div className="tabs" role="tablist">
                {TABLES.map((x) => (
                  <button data-hint key={x.key} type="button" role="tab" aria-selected={table === x.key} className={clsx("tab", table === x.key && "active")} onClick={() => setTable(x.key)}>{x.label}</button>
                ))}
              </div>
              <TopTable summary={data.tables[table]} by={table} total={t ? (shown === "cost" ? t.costUsd : totalTokens(t)) : 0} value={value} />
            </section>
            <SummaryPanel current={p} />
          </div>
        )}
      </div>
    </ModalC>
  );
}

/** `lowerIsBetter` colors a change (spend going down is good); without it a change is neutral. */
function StatCard({ label, value, delta, note, lowerIsBetter }: { label: string; value: string; delta?: ReturnType<typeof change>; note?: string; lowerIsBetter?: boolean }) {
  const tone = !delta || delta.dir === "flat" || lowerIsBetter === undefined ? "neutral" : (delta.dir === "down") === lowerIsBetter ? "good" : "bad";
  return (
    <div className="usage-card">
      <div className="usage-card-label">{label}</div>
      <div className="usage-card-value">{value}</div>
      <div className="usage-card-foot">
        {delta && <span className={clsx("usage-delta", delta.dir, tone)} title="against the period of the same length before">{delta.text}</span>}
        {note && <span className="dim">{note}</span>}
      </div>
    </div>
  );
}

function TopTable({ summary, by, total, value }: { summary?: UsageSummary; by: UsageGroupBy; total: number; value: (g: UsageGroup) => number }) {
  const sessions = useStore((s) => s.sessions);
  if (!summary) return null;
  if (summary.groups.length === 0) return <div className="usage-empty dim">Nothing in this period.</div>;
  // A session, or a feature (its owner's session, with the team), opens its own dashboard.
  const drill = (g: UsageGroup) => (by === "session" || (by === "feature" && g.key) ? () => openUsage(g.key) : undefined);
  return (
    <table className="usage-table">
      <thead>
        <tr><th>{TABLES.find((x) => x.key === by)?.label.replace(/s$/, "")}</th><th className="num">Cost</th><th className="num">Tokens</th><th className="num">Turns</th><th className="share">Share</th></tr>
      </thead>
      <tbody>
        {summary.groups.map((g) => {
          const open = drill(g);
          const share = total > 0 ? value(g) / total : 0;
          const gone = by === "session" && !sessions[g.key];
          return (
            <tr data-hint key={g.key || "none"} className={clsx(open && "clickable")} onClick={open} tabIndex={open ? 0 : undefined} onKeyDown={open ? (e) => { if (e.key === "Enter") open(); } : undefined}>
              <td className="label" title={by === "project" ? g.key : g.label}>
                {g.label}{gone && <span className="dim"> · deleted</span>}
              </td>
              <td className="num">{fmtCost(g.totals.costUsd, g.totals.estimatedCostUsd > 0)}{g.totals.unpricedTurns > 0 && g.totals.costUsd === 0 ? <span className="dim"> tokens only</span> : null}</td>
              <td className="num">{fmtTokens(totalTokens(g.totals))}</td>
              <td className="num">{g.totals.turns}</td>
              <td className="share"><span className="usage-share-bar"><span style={{ width: `${Math.round(share * 100)}%` }} /></span><span className="dim">{Math.round(share * 100)}%</span></td>
            </tr>
          );
        })}
        {summary.more > 0 && <tr><td colSpan={5} className="dim">and {summary.more} more</td></tr>}
      </tbody>
    </table>
  );
}

const SUMMARY_PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "today", label: "Today" }, { key: "yesterday", label: "Yesterday" }, { key: "week", label: "This week" },
];

/** A written summary of a period, made by the daemon from the data alone, to read and copy. */
function SummaryPanel({ current }: { current: Period }) {
  const toast = useStore((s) => s.toast);
  const openDialog = useStore((s) => s.openDialog);
  const latest = useUsageReports((s) => s.latest);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [busy, setBusy] = useState(false);
  const write = async (p: Period) => {
    setBusy(true);
    try { setReport(await usage.report(p.from, p.to, p.label)); }
    catch (e) { toast(message(e), "error"); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    if (!report) return;
    await navigator.clipboard.writeText(report.markdown);
    toast("Summary copied as Markdown");
  };
  return (
    <section className="usage-section usage-summary">
      <div className="usage-section-head">
        <h4>Summary</h4>
        <span style={{ flex: 1 }} />
        {report && <button type="button" className="btn small" data-command="usage.copy-summary" onClick={() => void copy()}>Copy Markdown</button>}
      </div>
      <div className="radio-row">
        {SUMMARY_PERIODS.map((x) => (
          <button key={x.key} type="button" className="btn small" disabled={busy} data-command="usage.write-summary" onClick={() => void write(period(x.key))}>{x.label}</button>
        ))}
        <button data-hint type="button" className="btn small" disabled={busy} onClick={() => void write(current)} title="The period the dashboard shows">{current.label}</button>
        {latest && <button data-hint type="button" className="btn small" onClick={() => setReport(latest)} title={`Written ${new Date(latest.generatedAt).toLocaleString()}`}>Latest daily</button>}
      </div>
      {report ? <div className="usage-report"><Markdown text={report.markdown} /></div> : (
        <p className="dim usage-empty">
          Pick a period for a summary: totals, cost, the biggest sessions and features, and what changed against the period before.
          {" "}Aura can write one every day: <button data-hint type="button" className="linkish" onClick={() => openDialog({ kind: "settings", tab: "usage" })}>Settings → Usage</button>.
        </p>
      )}
    </section>
  );
}
