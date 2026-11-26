/** What is left of one rate limit (`core`, `graphql`, `search`, …) until `reset` (Unix seconds). */
export interface Budget {
  resource: string;
  limit: number;
  remaining: number;
  reset: number;
}

/**
 * How long to wait between polls meant to run every `baseMs`, given the budgets, at `nowSec`:
 * slower as the core and GraphQL budgets run low, and until the reset once one is spent.
 */
export function pace(baseMs: number, budgets: Budget[], nowSec: number): number {
  let out: number | null = null;
  for (const b of budgets) {
    if (b.resource !== "core" && b.resource !== "graphql") continue;
    if (!(b.reset > nowSec && b.limit > 0)) continue;
    const left = b.remaining / b.limit;
    const wait =
      b.remaining === 0 ? Math.max((b.reset - nowSec) * 1000, baseMs)
      : left < 0.1 ? baseMs * 8
      : left < 0.25 ? baseMs * 4
      : left < 0.5 ? baseMs * 2
      : baseMs;
    out = out === null ? wait : Math.max(out, wait);
  }
  return out ?? baseMs;
}
