/**
 * Small SVG charts for the usage views. Colors come from the theme's
 * variables, so they follow light and dark; every bar and point has a
 * <title> for its exact value.
 */
import { useState } from "react";

/** Series colors, in order; the last one is for "other". */
export const SERIES = ["var(--md-primary)", "var(--md-tertiary)", "var(--agent-codex)", "var(--info)", "var(--warn)", "var(--ok)", "var(--fg-dim)"];

export type Stack = { key: string; label: string; segments: { key: string; value: number }[]; title?: string };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/** Bars per x (days, turns), each stacked by series. `colors` maps a series key to its color. */
export function StackedBars({
  stacks, colors, format, height = 180, onPick, picked, ariaLabel,
}: {
  stacks: Stack[];
  colors: Record<string, string>;
  format: (v: number) => string;
  height?: number;
  onPick?: (key: string) => void;
  picked?: string | null;
  ariaLabel: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const width = 640;
  const pad = { l: 44, r: 8, t: 8, b: 22 };
  const max = niceMax(Math.max(0, ...stacks.map((s) => s.segments.reduce((a, x) => a + x.value, 0))));
  const n = Math.max(1, stacks.length);
  const slot = (width - pad.l - pad.r) / n;
  const bw = Math.max(2, Math.min(28, slot * 0.7));
  const y = (v: number) => pad.t + (height - pad.t - pad.b) * (1 - v / max);
  const every = Math.ceil(n / 10);
  return (
    <svg className="usage-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} preserveAspectRatio="none">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line className="grid" x1={pad.l} x2={width - pad.r} y1={y(max * f)} y2={y(max * f)} />
          <text className="axis" x={pad.l - 6} y={y(max * f) + 3} textAnchor="end">{format(max * f)}</text>
        </g>
      ))}
      {stacks.map((s, i) => {
        const x = pad.l + slot * i + (slot - bw) / 2;
        let acc = 0;
        const total = s.segments.reduce((a, x) => a + x.value, 0);
        const active = hover === s.key || picked === s.key;
        return (
          <g data-hint key={s.key} className={active ? "bar active" : "bar"} onMouseEnter={() => setHover(s.key)} onMouseLeave={() => setHover(null)}
            onClick={onPick ? () => onPick(s.key) : undefined} style={onPick ? { cursor: "pointer" } : undefined}>
            <title>{s.title ?? `${s.label}: ${format(total)}`}</title>
            <rect className="hit" x={pad.l + slot * i} y={pad.t} width={slot} height={height - pad.t - pad.b} />
            {s.segments.map((seg) => {
              const y0 = y(acc);
              acc += seg.value;
              const h = Math.max(0, y0 - y(acc));
              return h > 0 ? <rect key={seg.key} x={x} y={y(acc)} width={bw} height={h} rx={bw > 6 ? 2 : 0} fill={colors[seg.key] ?? SERIES[SERIES.length - 1]} /> : null;
            })}
            {i % every === 0 && <text className="axis" x={x + bw / 2} y={height - 6} textAnchor="middle">{s.label}</text>}
          </g>
        );
      })}
    </svg>
  );
}

/** A line over x = 0..n-1, optionally with a ceiling (a context window). */
export function LineChart({
  points, format, ceiling, height = 160, ariaLabel, labels,
}: {
  points: (number | null)[];
  format: (v: number) => string;
  ceiling?: number | null;
  height?: number;
  ariaLabel: string;
  labels?: string[];
}) {
  const width = 640;
  const pad = { l: 44, r: 8, t: 8, b: 18 };
  const values = points.filter((p): p is number => p !== null);
  const max = niceMax(Math.max(ceiling ?? 0, ...values, 1));
  const n = points.length;
  const x = (i: number) => pad.l + (n <= 1 ? 0 : ((width - pad.l - pad.r) * i) / (n - 1));
  const y = (v: number) => pad.t + (height - pad.t - pad.b) * (1 - v / max);
  const path = points
    .map((p, i) => (p === null ? null : `${x(i).toFixed(1)},${y(p).toFixed(1)}`))
    .reduce<string[]>((segs, pt, i) => {
      if (pt === null) return segs;
      const prev = points[i - 1];
      segs.push(`${i === 0 || prev === null ? "M" : "L"}${pt}`);
      return segs;
    }, [])
    .join(" ");
  const last = values.length ? values[values.length - 1] : null;
  return (
    <svg className="usage-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} preserveAspectRatio="none">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line className="grid" x1={pad.l} x2={width - pad.r} y1={y(max * f)} y2={y(max * f)} />
          <text className="axis" x={pad.l - 6} y={y(max * f) + 3} textAnchor="end">{format(max * f)}</text>
        </g>
      ))}
      {ceiling ? <line className="ceiling" x1={pad.l} x2={width - pad.r} y1={y(ceiling)} y2={y(ceiling)}><title>window {format(ceiling)}</title></line> : null}
      {path && <path className="line" d={path} />}
      {points.map((p, i) => (p === null ? null : (
        <circle key={i} className="point" cx={x(i)} cy={y(p)} r={n > 60 ? 1.5 : 3}>
          <title>{`${labels?.[i] ?? `turn ${i + 1}`}: ${format(p)}${ceiling ? ` (${Math.round((p / ceiling) * 100)}% of the window)` : ""}`}</title>
        </circle>
      )))}
      {last !== null && <text className="axis" x={width - pad.r} y={height - 4} textAnchor="end">{n} turn{n === 1 ? "" : "s"}</text>}
    </svg>
  );
}

/** A horizontal share bar, e.g. the split by model. */
export function ShareBar({ parts, colors, format }: { parts: { key: string; label: string; value: number }[]; colors: Record<string, string>; format: (v: number) => string }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (total <= 0) return null;
  return (
    <div className="usage-share" role="img" aria-label={parts.map((p) => `${p.label} ${format(p.value)}`).join(", ")}>
      {parts.map((p) => p.value > 0 && (
        <span key={p.key} style={{ flexGrow: p.value, background: colors[p.key] ?? SERIES[SERIES.length - 1] }} title={`${p.label}: ${format(p.value)} (${Math.round((p.value / total) * 100)}%)`} />
      ))}
    </div>
  );
}

export function Legend({ items, colors }: { items: { key: string; label: string }[]; colors: Record<string, string> }) {
  return (
    <div className="usage-legend">
      {items.map((i) => (
        <span key={i.key}><i style={{ background: colors[i.key] ?? SERIES[SERIES.length - 1] }} />{i.label}</span>
      ))}
    </div>
  );
}

/** Colors for series keys, largest first; past the palette everything is "other". */
export function colorsFor(keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  keys.forEach((k, i) => { out[k] = SERIES[Math.min(i, SERIES.length - 1)]; });
  return out;
}
