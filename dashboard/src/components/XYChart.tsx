import { useState } from 'react';
import type { PointerEvent } from 'react';
import { niceScale, px } from '../lib/format.ts';
import { useWidth } from './useWidth.ts';

export interface ChartLine { id: string; label: string; color: string; points: { x: number; y: number }[] }
export interface ChartTip { x: number; title: string; rows: { label: string; value: string; color?: string }[] }

interface Props {
  /** What the chart shows, for a reader who cannot see it. */
  label: string;
  height?: number;
  xMax: number;
  yMax?: number;
  formatX: (n: number) => string;
  formatY: (n: number) => string;
  lines: ChartLine[];
  /** Individual observations behind the first line, drawn as dots in its colour. */
  dots?: { x: number; y: number }[];
  /** Horizontal lines to read the data against, each named on the chart. */
  refs?: { y: number; label: string }[];
  /** What to say about the position under the pointer: the x it snaps to, and the values there. */
  tip?: (x: number) => ChartTip | null;
  xTitle?: string;
}

const M = { top: 14, right: 14, bottom: 30, left: 46 };
/** Room to the right of the plot for the names of the reference levels, when the chart is wide enough to spare it. */
const REF_GUTTER = 176;

/**
 * One measure against one horizontal axis, both starting at zero: lines, the observations behind them, and reference
 * levels. A crosshair follows the pointer and names the values under it; two or more lines get a legend.
 */
export function XYChart({ label, height = 280, xMax, yMax, formatX, formatY, lines, dots, refs = [], tip, xTitle }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<ChartTip | null>(null);

  const dataMax = Math.max(1, ...lines.flatMap((l) => l.points.map((p) => p.y)), ...(dots ?? []).map((d) => d.y), ...refs.map((r) => r.y));
  const ys = niceScale(yMax ?? dataMax), xs = niceScale(xMax, width < 520 ? 3 : 5);
  const gutter = refs.length && width >= 620 ? REF_GUTTER : 0;
  const plotW = Math.max(40, width - M.left - M.right - gutter), plotH = height - M.top - M.bottom;
  // The vertical axis is rounded up to a clean number; the horizontal one ends where the data ends.
  const xEnd = Math.max(xMax, 1);
  const X = (v: number) => M.left + (v / xEnd) * plotW, Y = (v: number) => M.top + (1 - v / ys.max) * plotH;
  const yTicks = Array.from({ length: Math.round(ys.max / ys.step) + 1 }, (_, i) => i * ys.step);
  const xTicks = Array.from({ length: Math.floor(xEnd / xs.step) + 1 }, (_, i) => i * xs.step);

  // Reference names go beside the end of their line; without room for that, above the line (below it when the one above is close).
  const sortedRefs = refs.toSorted((a, b) => b.y - a.y);
  const refLabelY: number[] = [];
  sortedRefs.forEach((r, i) => {
    const at = Y(r.y);
    if (gutter) refLabelY.push(i > 0 ? Math.max(at + 4, refLabelY[i - 1] + 14) : at + 4);
    else refLabelY.push(i > 0 && at - Y(sortedRefs[i - 1].y) < 16 ? at + 13 : at - 5);
  });

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!tip) return;
    const box = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - box.left - M.left) / plotW) * xEnd;
    setHover(x < 0 || x > xEnd ? null : tip(x));
  };

  return (
    <div ref={ref} className="relative">
      {lines.length > 1 ? (
        <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
          {lines.map((l) => <li key={l.id} className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4" style={{ background: l.color }} />{l.label}</li>)}
        </ul>
      ) : null}
      <svg width={width} height={height} role="img" aria-label={label} className="block touch-none select-none" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={M.left + plotW} y1={px(Y(t))} y2={px(Y(t))} stroke={t === 0 ? 'var(--axis)' : 'var(--grid)'} strokeWidth="1" />
            <text x={M.left - 8} y={px(Y(t)) + 4} textAnchor="end" className="type-num fill-ink-3 text-[11px]">{formatY(t)}</text>
          </g>
        ))}
        {xTicks.map((t) => <text key={t} x={px(X(t))} y={height - 10} textAnchor={t === 0 ? 'start' : X(t) > M.left + plotW - 16 ? 'end' : 'middle'} className="type-num fill-ink-3 text-[11px]">{formatX(t)}</text>)}

        {sortedRefs.map((r, i) => (
          <g key={r.label}>
            <line x1={M.left} x2={M.left + plotW} y1={px(Y(r.y))} y2={px(Y(r.y))} stroke="var(--ink-3)" strokeWidth="1" />
            {gutter
              ? <text x={M.left + plotW + 8} y={px(refLabelY[i])} className="fill-ink-2 text-[11px]">{r.label}</text>
              : <text x={M.left + plotW - 4} y={px(refLabelY[i])} textAnchor="end" className="fill-ink-2 text-[11px]" paintOrder="stroke" stroke="var(--screen)" strokeWidth="3">{r.label}</text>}
          </g>
        ))}

        {(dots ?? []).map((d, i) => <circle key={i} cx={px(X(d.x))} cy={px(Y(d.y))} r="3.5" fill={lines[0]?.color ?? 'var(--series-1)'} fillOpacity="0.32" stroke="var(--screen)" strokeWidth="1" />)}

        {lines.map((l) => (
          <g key={l.id}>
            <path d={l.points.map((p, i) => `${i ? 'L' : 'M'}${px(X(p.x))} ${px(Y(p.y))}`).join(' ')} fill="none" stroke={l.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            {l.points.length ? <circle cx={px(X(l.points.at(-1)!.x))} cy={px(Y(l.points.at(-1)!.y))} r="4.5" fill={l.color} stroke="var(--screen)" strokeWidth="2" /> : null}
          </g>
        ))}

        {hover ? <line x1={px(X(hover.x))} x2={px(X(hover.x))} y1={M.top} y2={M.top + plotH} stroke="var(--ink-2)" strokeWidth="1" /> : null}
      </svg>
      {xTitle ? <p className="mt-0.5 text-xs text-ink-3" style={{ paddingLeft: M.left }}>{xTitle}</p> : null}
      {hover ? (
        <div className="pointer-events-none absolute top-2 z-10 min-w-40 rounded-[3px] border border-ink bg-housing px-3 py-2 text-xs shadow-none"
          style={X(hover.x) > width / 2 ? { right: width - X(hover.x) + 10 } : { left: X(hover.x) + 10 }}>
          <p className="mb-1 font-semibold">{hover.title}</p>
          <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
            {hover.rows.map((r) => (
              <div key={r.label} className="contents">
                <dt className="flex items-center gap-1.5 text-ink-2">{r.color ? <span className="inline-block size-2 rounded-full" style={{ background: r.color }} /> : null}{r.label}</dt>
                <dd className="type-num text-right">{r.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}
