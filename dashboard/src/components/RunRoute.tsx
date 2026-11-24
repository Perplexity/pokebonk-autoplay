import type { KeyboardEvent } from 'react';
import type { CheckpointInfo, ModelInfo, RunInfo } from '../../shared/api.ts';
import { compact, num, px } from '../lib/format.ts';
import { go } from '../lib/route.ts';
import { useWidth } from './useWidth.ts';

interface Props { run: RunInfo; models: ModelInfo[]; selected: number | null; onSelect: (id: number | null) => void }

const PAD = 18;
const onKey = (fn: () => void) => (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };

/**
 * The run as a route: the decisions trained so far as a track, every checkpoint a stop on it, evaluations pinned
 * above the stop they were made at, registered models named below. A stop can be selected to act on it.
 */
export function RunRoute({ run, models, selected, onSelect }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>(960);
  // Room above the track only when there is an evaluation to pin there, below it only when a model is named there.
  const pinned = run.evaluations.some((e) => e.timesteps != null), named = models.some((m) => m.run === run.name && m.timesteps != null && m.role !== 'retired');
  const TRACK = pinned ? 70 : 24, H = TRACK + (named ? 62 : 38);
  const end = Math.max(run.targetTimesteps, run.timesteps, 1);
  const plot = Math.max(80, width - 2 * PAD);
  const X = (t: number) => PAD + (t / end) * plot;
  const r = Math.max(2.5, Math.min(6, plot / Math.max(1, run.checkpoints.length) / 2.6));
  const marks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * run.targetTimesteps);
  const mine = models.filter((m) => m.run === run.name && m.timesteps != null && m.role !== 'retired');
  const shape = (c: CheckpointInfo, active: boolean) => {
    const cx = px(X(c.timesteps)), fill = active ? 'var(--action)' : c.kind === 'interrupt' ? 'var(--screen)' : 'var(--ink)';
    const stroke = active ? 'var(--action)' : 'var(--ink)';
    return c.kind === 'final'
      ? <rect x={cx - r - 1} y={TRACK - r - 1} width={2 * r + 2} height={2 * r + 2} transform={`rotate(45 ${cx} ${TRACK})`} fill={fill} stroke="var(--screen)" strokeWidth="2" />
      : <circle cx={cx} cy={TRACK} r={r} fill={fill} stroke={c.kind === 'interrupt' ? stroke : 'var(--screen)'} strokeWidth="2" />;
  };
  return (
    <div ref={ref}>
      <svg width={width} height={H} role="group" aria-label={`Run ${run.name}: ${num(run.timesteps)} of ${num(run.targetTimesteps)} decisions, ${run.checkpoints.length} checkpoints`} className="block">
        <line x1={PAD} x2={px(X(end))} y1={TRACK} y2={TRACK} stroke="var(--axis)" strokeWidth="3" strokeLinecap="round" />
        <line x1={PAD} x2={px(X(run.timesteps))} y1={TRACK} y2={TRACK} stroke="var(--ink)" strokeWidth="3" strokeLinecap="round" />
        {marks.map((t, i) => (
          <g key={i}>
            <line x1={px(X(t))} x2={px(X(t))} y1={TRACK + 10} y2={TRACK + 15} stroke="var(--axis)" strokeWidth="1" />
            <text x={px(X(t))} y={TRACK + 28} textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'} className="type-num fill-ink-3 text-[11px]">{i === 4 ? `target ${compact(t)}` : compact(t)}</text>
          </g>
        ))}

        {run.evaluations.filter((e) => e.timesteps != null).map((e) => {
          const cx = px(X(e.timesteps!));
          const color = e.passed === true ? 'var(--good)' : e.passed === false ? 'var(--critical)' : 'var(--ink-3)';
          const verdict = e.passed === true ? 'passed' : e.passed === false ? 'not passed' : 'for information';
          return (
            <g key={e.id} role="link" tabIndex={0} className="cursor-pointer" onClick={() => go('evaluations', e.id)} onKeyDown={onKey(() => go('evaluations', e.id))}
              aria-label={`Evaluation ${e.id} at ${num(e.timesteps)} decisions: median score ${num(e.summary.scoreMedian)}, ${verdict}`}>
              <title>{`Evaluation ${e.id}: median score ${num(e.summary.scoreMedian)} on seeds ${e.seedsLabel} (${verdict})`}</title>
              <line x1={cx} x2={cx} y1={TRACK - r - 3} y2={34} stroke={color} strokeWidth="1.5" />
              <circle cx={cx} cy={28} r="6" fill={color} stroke="var(--screen)" strokeWidth="2" />
              <text x={cx} y={14} textAnchor="middle" className="type-num fill-ink text-[11px]">{compact(e.summary.scoreMedian)}</text>
            </g>
          );
        })}

        {run.checkpoints.map((c) => (
          <g key={c.id} role="button" tabIndex={0} aria-pressed={selected === c.id} className="cursor-pointer outline-offset-4"
            aria-label={`Checkpoint at ${num(c.timesteps)} decisions${c.kind === 'final' ? ', final' : c.kind === 'interrupt' ? ', saved on stop' : ''}`}
            onClick={() => onSelect(selected === c.id ? null : c.id)} onKeyDown={onKey(() => onSelect(selected === c.id ? null : c.id))}>
            <title>{`${num(c.timesteps)} decisions, ${c.episodes} episodes${c.kind === 'final' ? ' (final)' : c.kind === 'interrupt' ? ' (saved on stop)' : ''}`}</title>
            <rect x={px(X(c.timesteps)) - Math.max(r, 7)} y={TRACK - 12} width={2 * Math.max(r, 7)} height={24} fill="transparent" />
            {shape(c, selected === c.id)}
          </g>
        ))}

        {mine.map((m) => (
          <g key={m.id}>
            <line x1={px(X(m.timesteps!))} x2={px(X(m.timesteps!))} y1={TRACK + r + 3} y2={TRACK + 38} stroke={m.role === 'stable' ? 'var(--action)' : 'var(--ink-3)'} strokeWidth="1.5" />
            <text x={px(X(m.timesteps!))} y={TRACK + 52} textAnchor={X(m.timesteps!) > width - 90 ? 'end' : X(m.timesteps!) < 90 ? 'start' : 'middle'}
              className={`text-[12px] font-semibold ${m.role === 'stable' ? 'fill-action' : 'fill-ink-2'}`}>{m.role === 'stable' ? `stable model ${m.id}` : `candidate ${m.id}`}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}
