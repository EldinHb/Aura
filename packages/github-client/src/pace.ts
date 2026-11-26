/** What is left of one rate limit (`core`, `graphql`, `search`, …) until `reset` (Unix seconds). */
export interface Budget {
  resource: string;
  limit: number;
  remaining: number;
  reset: number;
}

/** How long to wait between polls meant to run every `baseMs`, given the budgets, at `nowSec`. */
export function pace(baseMs: number, budgets: Budget[], nowSec: number): number {
  throw new Error("not ported yet: pace");
}
