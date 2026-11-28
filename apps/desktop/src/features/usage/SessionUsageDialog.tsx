import { useEffect, useMemo, useState } from "react";
import { ModalC } from "../../components/ModalC";
import { useStore } from "../../state/store";
import type { SessionUsage } from "../../gen";
import { colorsFor, Legend, LineChart, ShareBar, StackedBars } from "./charts";
import { cacheHitRate, fmtCost, fmtPct, fmtTokens, totalTokens } from "./format";
import { openUsage, usage } from "./state";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const TOKEN_KINDS = [
  { key: "input", label: "input" }, { key: "output", label: "output" }, { key: "read", label: "cache read" }, { key: "write", label: "cache write" },
];
const TOKEN_COLORS: Record<string, string> = { input: "var(--md-primary)", output: "var(--md-tertiary)", read: "var(--ok)", write: "var(--info)" };

/** One session's usage, turn by turn; an orchestrator's with its workers. */
export function SessionUsageDialog({ sessionId }: { sessionId: string }) {
  const client = useStore((s) => s.client);
  const session = useStore((s) => s.sessions[sessionId]);
  const select = useStore((s) => s.select);
  const closeDialog = useStore((s) => s.closeDialog);
  const orchestrates = !!session?.orchestrator || !!session?.feature_owner;
  const [data, setData] = useState<SessionUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    // Workers count whenever there may be any: also for a deleted session, which only its records know.
    usage.session(sessionId, orchestrates || !session)
      .then((u) => !cancelled && setData(u))
      .catch((e) => !cancelled && setError(message(e)));
    return () => { cancelled = true; };
  }, [client, sessionId, orchestrates, session]);

  const turns = useMemo(() => data?.turns ?? [], [data]);
  const ctxWindow = turns.reduce<number | null>((w, t) => t.contextWindow ?? w, null);
  const stacks = useMemo(() => turns.map((t, i) => ({
    key: t.turnId,
    label: String(i + 1),
    segments: [
      { key: "input", value: t.inputTokens }, { key: "output", value: t.outputTokens },
      { key: "read", value: t.cacheReadTokens }, { key: "write", value: t.cacheWriteTokens },
    ],
    title: `Turn ${i + 1} · ${new Date(t.at).toLocaleString()}${t.model ? ` · ${t.model}` : ""}\n${fmtTokens(t.inputTokens)} in · ${fmtTokens(t.outputTokens)} out · ${fmtTokens(t.cacheReadTokens)} cache read · ${fmtTokens(t.cacheWriteTokens)} cache write\n${fmtCost(t.costUsd, t.estimated)}`,
  })), [turns]);
  const modelColors = useMemo(() => colorsFor((data?.models ?? []).map((m) => m.key)), [data]);
  const own = data?.totals;
  const all = data?.allTotals;
  const withWorkers = !!data && data.workers.length > 0;

  const open = (id: string) => {
    if (!useStore.getState().sessions[id]) return;
    closeDialog();
    select(id);
  };
  return (
    <ModalC
      title={<>
        <span>Usage · {data?.title ?? session?.title ?? "session"}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn small" data-command="usage.open" onClick={() => openUsage()}>All usage…</button>
      </>}
      width="min(980px, 94vw)"
      height="86vh"
      className="usage-modal"
    >
      <div className="usage-body">
        {error && <p className="usage-error">Could not load usage: {error}</p>}
        {!data && !error && <p className="dim">Loading…</p>}
        {own && all && (
          <div className="usage-cards">
            <div className="usage-card">
              <div className="usage-card-label">Cost{withWorkers ? " with workers" : ""}</div>
              <div className="usage-card-value">{fmtCost(all.costUsd, all.estimatedCostUsd > 0)}</div>
              <div className="usage-card-foot dim">{withWorkers ? `${fmtCost(own.costUsd, own.estimatedCostUsd > 0)} itself` : all.unpricedTurns > 0 ? `${all.unpricedTurns} turns tokens only` : " "}</div>
            </div>
            <div className="usage-card">
              <div className="usage-card-label">Tokens</div>
              <div className="usage-card-value">{fmtTokens(totalTokens(all))}</div>
              <div className="usage-card-foot dim">{fmtTokens(all.inputTokens)} in · {fmtTokens(all.outputTokens)} out · {fmtTokens(all.cachedInputTokens)} cache</div>
            </div>
            <div className="usage-card">
              <div className="usage-card-label">Cache hit rate</div>
              <div className="usage-card-value">{fmtPct(cacheHitRate(all))}</div>
              <div className="usage-card-foot dim">reads of all input</div>
            </div>
            <div className="usage-card">
              <div className="usage-card-label">Turns</div>
              <div className="usage-card-value">{all.turns}</div>
              <div className="usage-card-foot dim">{withWorkers ? `${own.turns} its own` : " "}</div>
            </div>
          </div>
        )}
        {data && turns.length === 0 && <div className="usage-empty dim">This session has no turns with usage of its own yet.</div>}
        {turns.length > 0 && (
          <>
            <section className="usage-section">
              <div className="usage-section-head"><h4>Context after each turn</h4><span style={{ flex: 1 }} />{ctxWindow && <span className="dim">window {fmtTokens(ctxWindow)}</span>}</div>
              <LineChart points={turns.map((t) => t.contextUsed)} ceiling={ctxWindow} format={fmtTokens} ariaLabel="Context used after each turn" labels={turns.map((_, i) => `turn ${i + 1}`)} />
            </section>
            <section className="usage-section">
              <div className="usage-section-head"><h4>Tokens per turn</h4></div>
              <StackedBars stacks={stacks} colors={TOKEN_COLORS} format={fmtTokens} ariaLabel="Tokens per turn" height={150} />
              <Legend items={TOKEN_KINDS} colors={TOKEN_COLORS} />
            </section>
          </>
        )}
        {data && data.models.length > 0 && (
          <section className="usage-section">
            <div className="usage-section-head"><h4>By model</h4></div>
            <ShareBar parts={data.models.map((m) => ({ key: m.key, label: m.label, value: m.totals.costUsd > 0 ? m.totals.costUsd : totalTokens(m.totals) }))} colors={modelColors} format={(v) => (all && all.costUsd > 0 ? fmtCost(v) : fmtTokens(v))} />
            <table className="usage-table">
              <tbody>
                {data.models.map((m) => (
                  <tr key={m.key || "default"}>
                    <td className="label"><i className="usage-swatch" style={{ background: modelColors[m.key] }} />{m.label}</td>
                    <td className="num">{fmtCost(m.totals.costUsd, m.totals.estimatedCostUsd > 0)}</td>
                    <td className="num">{fmtTokens(totalTokens(m.totals))}</td>
                    <td className="num">{m.totals.turns} turns</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        {withWorkers && (
          <section className="usage-section">
            <div className="usage-section-head"><h4>Workers</h4><span className="dim">each with its own workers</span></div>
            <table className="usage-table">
              <tbody>
                {data!.workers.map((w) => {
                  const live = !!useStore.getState().sessions[w.key];
                  return (
                    <tr key={w.key} className={live ? "clickable" : undefined}>
                      <td className="label">
                        {live ? <button data-hint type="button" className="linkish" onClick={() => openUsage(w.key)} title="Its usage">{w.label}</button> : <>{w.label}<span className="dim"> · deleted</span></>}
                      </td>
                      <td className="num">{fmtCost(w.totals.costUsd, w.totals.estimatedCostUsd > 0)}</td>
                      <td className="num">{fmtTokens(totalTokens(w.totals))}</td>
                      <td className="num">{w.totals.turns} turns</td>
                      <td className="num">{live && <button data-hint type="button" className="btn small" onClick={() => open(w.key)}>Open</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </ModalC>
  );
}
