import { useEffect, useState } from "react";
import type { Turn } from "../../gen";
import { compactLine, fmtCost, fmtPct, fmtTokens, turnLine } from "./format";
import { useTurnUsage } from "./state";

/** Load a session's turn usage once its transcript shows; later turns refresh it (see `useUsageSync`). */
export function useSessionTurnUsage(sessionId: string) {
  const loaded = useTurnUsage((s) => !!s.bySession[sessionId]);
  useEffect(() => {
    if (!loaded) void useTurnUsage.getState().load(sessionId);
  }, [sessionId, loaded]);
}

/** What a turn spent, under its reply: one dim line, a click away from the detail. */
export function TurnUsageLine({ sessionId, turn }: { sessionId: string; turn: Turn }) {
  const record = useTurnUsage((s) => s.bySession[sessionId]?.turns.find((t) => t.turnId === turn.id));
  const [open, setOpen] = useState(false);
  const line = turnLine(record, turn.usage);
  if (!line) return null;
  return (
    <span className="turn-usage">
      <button type="button" className="turn-usage-line" aria-expanded={open} data-command="transcript.turn-usage" onClick={() => setOpen((o) => !o)} title="What this turn spent">
        {compactLine(line)}
      </button>
      {open && (
        <span className="turn-usage-detail" role="group" aria-label="Turn usage">
          <span><b>{fmtTokens(line.input)}</b> input</span>
          <span><b>{fmtTokens(line.output)}</b> output</span>
          <span><b>{fmtTokens(line.cacheRead)}</b> cache read</span>
          <span><b>{fmtTokens(line.cacheWrite)}</b> cache write</span>
          {line.contextUsed !== null && (
            <span><b>{fmtTokens(line.contextUsed)}</b>{line.contextWindow ? ` of ${fmtTokens(line.contextWindow)} (${fmtPct(line.contextUsed / line.contextWindow)})` : ""} context after</span>
          )}
          <span><b>{fmtCost(line.cost, line.estimated)}</b> {line.cost === null ? "no known price" : line.estimated ? "estimated" : "reported"}</span>
        </span>
      )}
    </span>
  );
}
