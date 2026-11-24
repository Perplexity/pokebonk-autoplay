import { px } from '../lib/format.ts';

interface Props { values: number[]; width?: number; height?: number; color?: string; label: string }

/** A trend in a table cell: the line, its last point, and a zero line when the values cross zero. */
export function Sparkline({ values, width = 132, height = 30, color = 'var(--series-1)', label }: Props) {
  if (values.length < 2) return <span className="text-ink-3">–</span>;
  let lo = Math.min(0, ...values), hi = Math.max(0, ...values);
  if (hi === lo) hi = lo + 1;
  const pad = 4;
  const x = (i: number) => pad + (i / (values.length - 1)) * (width - 2 * pad);
  const y = (v: number) => pad + (1 - (v - lo) / (hi - lo)) * (height - 2 * pad);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${px(x(i))} ${px(y(v))}`).join(' ');
  const last = values.length - 1;
  return (
    <svg width={width} height={height} role="img" aria-label={label} className="block">
      <line x1={pad} x2={width - pad} y1={px(y(0))} y2={px(y(0))} stroke="var(--axis)" strokeWidth="1" />
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={px(x(last))} cy={px(y(values[last]))} r="4" fill={color} stroke="var(--screen)" strokeWidth="2" />
    </svg>
  );
}
