import { percent } from '../lib/format.ts';

interface Part { label: string; value: number }
interface Props { parts: Part[]; label: string }

const STEPS = ['var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)'];

/** One whole split into ordered parts (episodes by the zone they reached): a thin bar and a legend that carries the numbers. */
export function SegmentedBar({ parts, label }: Props) {
  const total = parts.reduce((n, p) => n + p.value, 0);
  if (!total) return <span className="text-ink-3">–</span>;
  const shown = parts.filter((p) => p.value > 0);
  return (
    <div>
      <div className="flex h-2 gap-0.5 overflow-hidden rounded-full" role="img" aria-label={`${label}: ${parts.map((p) => `${p.label} ${p.value}`).join(', ')}`}>
        {shown.map((p) => <div key={p.label} style={{ flexGrow: p.value, background: STEPS[Math.min(STEPS.length - 1, parts.indexOf(p))] }} title={`${p.label}: ${p.value} (${percent(p.value / total)})`} />)}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
        {parts.map((p, i) => (
          <li key={p.label} className="flex items-center gap-1.5">
            <span className="inline-block size-2 rounded-sm" style={{ background: STEPS[Math.min(STEPS.length - 1, i)] }} />
            {p.label} <span className="type-num text-ink">{p.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
