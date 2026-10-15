const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3_600], ["minute", 60]];
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "3 hours ago", "yesterday", "just now"; empty for a missing or invalid time. */
export function timeAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const seconds = Math.round((t - now) / 1000);
  for (const [unit, size] of UNITS) if (Math.abs(seconds) >= size) return relative.format(Math.trunc(seconds / size), unit);
  return "just now";
}

/** The full local date and time, for a tooltip. */
export function exactTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : new Date(t).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
}
