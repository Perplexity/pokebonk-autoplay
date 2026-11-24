import { useState } from 'react';
import type { PointerEvent } from 'react';
import type { ActionResult, EvaluationDetail, EvaluationInfo, Meta } from '../../shared/api.ts';
import { EvaluateDialog } from '../components/dialogs.tsx';
import { Figure } from '../components/Figure.tsx';
import { Notice } from '../components/Notice.tsx';
import { Empty, Failure, Loading, Screen } from '../components/Screen.tsx';
import { useWidth } from '../components/useWidth.ts';
import { useApi } from '../lib/api.ts';
import { compact, gameClock, niceScale, num, num2, percent, px, shortHash, when } from '../lib/format.ts';
import { go, href } from '../lib/route.ts';

const verdictWords = (e: EvaluationInfo): string => (e.passed === true ? 'Passed' : e.passed === false ? 'Not passed' : e.ratio != null ? 'For information' : 'Not compared');
const verdictColor = (e: EvaluationInfo): string => (e.passed === true ? 'var(--good)' : e.passed === false ? 'var(--critical)' : 'transparent');

function Verdict({ e }: { e: EvaluationInfo }) {
  return (
    <span className="flex items-center gap-2 whitespace-nowrap">
      <span className="lamp" style={{ background: verdictColor(e), borderColor: e.passed == null ? 'var(--ink-3)' : verdictColor(e) }} />{verdictWords(e)}
    </span>
  );
}

// ---------------------------------------------------------------- seed by seed

const M = { top: 12, right: 12, bottom: 28, left: 46 };

/** The model's score and the reference's on every seed, joined by a line: the longer the line, the bigger the difference. */
function SeedChart({ rows, referenceName }: { rows: EvaluationDetail['rows']; referenceName: string | null }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = 280, plotW = Math.max(40, width - M.left - M.right), plotH = height - M.top - M.bottom;
  const scale = niceScale(Math.max(1, ...rows.map((r) => Math.max(r.score, r.referenceScore ?? 0))));
  const X = (i: number) => M.left + ((i + 0.5) / rows.length) * plotW, Y = (v: number) => M.top + (1 - v / scale.max) * plotH;
  const ticks = Array.from({ length: Math.round(scale.max / scale.step) + 1 }, (_, i) => i * scale.step);
  const hasRef = rows.some((r) => r.referenceScore != null);
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const i = Math.floor(((e.clientX - e.currentTarget.getBoundingClientRect().left - M.left) / plotW) * rows.length);
    setHover(i >= 0 && i < rows.length ? i : null);
  };
  const h = hover != null ? rows[hover] : null;
  return (
    <div ref={ref} className="relative">
      <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
        <li className="flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-full bg-series-1" />Model</li>
        {hasRef ? <li className="flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-full bg-series-2" />{referenceName ?? 'Reference'}</li> : null}
      </ul>
      <svg width={width} height={height} role="img" aria-label="Score on every seed, model against reference" className="block touch-none" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={M.left + plotW} y1={px(Y(t))} y2={px(Y(t))} stroke={t === 0 ? 'var(--axis)' : 'var(--grid)'} strokeWidth="1" />
            <text x={M.left - 8} y={px(Y(t)) + 4} textAnchor="end" className="type-num fill-ink-3 text-[11px]">{compact(t)}</text>
          </g>
        ))}
        {hover != null ? <rect x={px(X(hover) - plotW / rows.length / 2)} y={M.top} width={px(plotW / rows.length)} height={plotH} fill="var(--screen-2)" /> : null}
        {rows.map((r, i) => (
          <g key={r.seed}>
            {r.referenceScore != null ? <line x1={px(X(i))} x2={px(X(i))} y1={px(Y(r.score))} y2={px(Y(r.referenceScore))} stroke="var(--ink-3)" strokeWidth="1" /> : null}
            {r.referenceScore != null ? <circle cx={px(X(i))} cy={px(Y(r.referenceScore))} r="4" fill="var(--series-2)" stroke="var(--screen)" strokeWidth="1.5" /> : null}
            <circle cx={px(X(i))} cy={px(Y(r.score))} r="4" fill="var(--series-1)" stroke="var(--screen)" strokeWidth="1.5" />
          </g>
        ))}
        <text x={M.left} y={height - 8} className="type-num fill-ink-3 text-[11px]">seed {rows[0]?.seed}</text>
        <text x={M.left + plotW} y={height - 8} textAnchor="end" className="type-num fill-ink-3 text-[11px]">seed {rows.at(-1)?.seed}</text>
      </svg>
      {h && hover != null ? (
        <div className="pointer-events-none absolute top-8 z-10 rounded-[3px] border border-ink bg-housing px-3 py-2 text-xs" style={X(hover) > width / 2 ? { right: width - X(hover) + 14 } : { left: X(hover) + 14 }}>
          <p className="mb-1 font-semibold">Seed {h.seed}</p>
          <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
            <dt className="flex items-center gap-1.5 text-ink-2"><span className="inline-block size-2 rounded-full bg-series-1" />Model</dt><dd className="type-num text-right">{num(h.score)}</dd>
            {h.referenceScore != null ? <><dt className="flex items-center gap-1.5 text-ink-2"><span className="inline-block size-2 rounded-full bg-series-2" />Reference</dt><dd className="type-num text-right">{num(h.referenceScore)}</dd></> : null}
            <dt className="text-ink-2">Game time</dt><dd className="type-num text-right">{gameClock(h.gameTime)}</dd>
            <dt className="text-ink-2">Ended</dt><dd className="text-right">{h.endCause}</dd>
          </dl>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- one evaluation

function Detail({ id }: { id: number }) {
  const { data: e, error } = useApi<EvaluationDetail>(`/evaluations/${id}`, 30_000);
  const [table, setTable] = useState(false);
  if (error) return <Failure error={error} />;
  if (!e) return <Loading what={`evaluation ${id}`} />;
  const s = e.summary, r = e.referenceSummary;
  return (
    <div className="grid grid-cols-1 gap-5">
      <header>
        <p><a className="btn btn-quiet -ml-1.5" href={href('evaluations')}>All evaluations</a></p>
        <h1 className="type-display mt-1">Evaluation {e.id}</h1>
        <p className="mt-2 max-w-[80ch] text-base text-ink-2">
          {e.run ?? 'A model'} at {num(e.timesteps)} decisions (file {shortHash(e.modelSha256)}), on seeds {e.seedsLabel}, {e.deterministic ? 'taking its most probable action' : 'sampling its actions'}, {when(e.createdAt)}.
        </p>
      </header>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 xl:grid-cols-6">
        <Figure label="Median score" value={num(s.scoreMedian)} detail={r ? `reference ${num(r.scoreMedian)}` : undefined} />
        <Figure label="Mean score" value={num(s.scoreMean)} detail={r ? `reference ${num(r.scoreMean)}` : undefined} />
        <Figure label="Best score" value={num(s.scoreMax)} detail={r ? `reference ${num(r.scoreMax)}` : undefined} />
        <Figure label="Runs completed" value={percent(s.completed / Math.max(1, s.episodes))} detail={`${s.completed} of ${s.episodes}${r ? `, reference ${r.completed}` : ''}`} />
        <Figure label="Mean game time" value={gameClock(s.gameTimeMean)} detail={r ? `reference ${gameClock(r.gameTimeMean)}` : undefined} />
        <Figure label="Against the reference" value={e.ratio != null ? `${num2(e.ratio)} ×` : '–'} detail={e.perSeed ? `better on ${e.perSeed.wins} seeds, worse on ${e.perSeed.losses}` : undefined} />
      </dl>
      <Screen title="The comparison">
        <p className="flex items-center gap-2 text-base font-semibold"><Verdict e={e} /></p>
        <p className="mt-2 max-w-[80ch] text-ink-2">
          {e.reference ? <>Compared with {e.reference}. </> : null}
          {e.ratio != null && e.metric ? <>The rule: the model's {e.metric.replace('_', ' ')} divided by the reference's must reach {num2(e.minRatio)}; it is {num2(e.ratio)}. </> : null}
          {e.note ?? ''}{s.invalid ? ` ${s.invalid} of ${s.episodes} runs were ended for standing still (no KO and no movement for 30 game seconds): they are invalid and score 0.` : ''}{e.lostToErrors ? ` ${e.lostToErrors} episodes were lost to errors.` : ''}
        </p>
      </Screen>
      <Screen title="Seed by seed" actions={<button type="button" className="btn btn-quiet" aria-pressed={table} onClick={() => setTable((t) => !t)}>{table ? 'Show the chart' : 'Show as a table'}</button>}>
        {table ? (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead><tr><th className="num">Seed</th><th className="num">Score</th><th className="num">Reference</th><th className="num">Game time</th><th className="num">Level</th><th className="num">Zone</th><th>Ended</th></tr></thead>
              <tbody>{e.rows.map((row) => (
                <tr key={row.seed} className="is-link" onClick={() => go('episode', row.episodeId)}>
                  <td className="num type-num"><a href={href('episode', row.episodeId)}>{row.seed}</a></td><td className="num type-num">{num(row.score)}</td><td className="num type-num">{num(row.referenceScore)}</td>
                  <td className="num type-num">{gameClock(row.gameTime)}</td><td className="num type-num">{row.level}</td><td className="num type-num">{row.zone}</td><td>{row.endCause}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <SeedChart rows={e.rows} referenceName={e.reference} />}
      </Screen>
    </div>
  );
}

// ---------------------------------------------------------------- two evaluations side by side

function Compare({ list, a, b }: { list: EvaluationInfo[]; a: number; b: number }) {
  const left = useApi<EvaluationDetail>(`/evaluations/${a}`, 60_000), right = useApi<EvaluationDetail>(`/evaluations/${b}`, 60_000);
  const pick = (side: 'a' | 'b', id: string) => go('evaluations', null, side === 'a' ? { a: id, b } : { a, b: id });
  const A = left.data, B = right.data;
  let wins = 0, losses = 0, shared = 0;
  if (A && B) {
    const other = new Map(B.rows.map((r) => [r.seed, r.score]));
    for (const r of A.rows) { const o = other.get(r.seed); if (o == null) continue; shared++; if (r.score > o) wins++; else if (r.score < o) losses++; }
  }
  const name = (e: EvaluationInfo) => `Evaluation ${e.id}: ${e.run ?? 'model'} at ${compact(e.timesteps ?? 0)}, seeds ${e.seedsLabel}`;
  const row = (label: string, f: (e: EvaluationDetail) => string) => <tr><td>{label}</td><td className="num type-num">{A ? f(A) : '…'}</td><td className="num type-num">{B ? f(B) : '…'}</td></tr>;
  return (
    <Screen title="Two evaluations side by side" note="Choose a candidate's evaluation and the stable model's to compare them on the seeds both played.">
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <label className="field"><span>First</span><select value={a} onChange={(e) => pick('a', e.target.value)}>{list.map((e) => <option key={e.id} value={e.id}>{name(e)}</option>)}</select></label>
        <label className="field"><span>Second</span><select value={b} onChange={(e) => pick('b', e.target.value)}>{list.map((e) => <option key={e.id} value={e.id}>{name(e)}</option>)}</select></label>
      </div>
      <table className="data-table">
        <thead><tr><th>Figure</th><th className="num">First</th><th className="num">Second</th></tr></thead>
        <tbody>
          {row('Median score', (e) => num(e.summary.scoreMedian))}{row('Mean score', (e) => num(e.summary.scoreMean))}{row('Best score', (e) => num(e.summary.scoreMax))}
          {row('Runs completed', (e) => `${e.summary.completed} of ${e.summary.episodes}`)}{row('Mean game time', (e) => gameClock(e.summary.gameTimeMean))}{row('Mean level', (e) => num(e.summary.levelMean))}
        </tbody>
      </table>
      {A && B ? <p className="mt-3 text-ink-2">{shared ? `On the ${shared} seeds both played, the first is better on ${wins} and worse on ${losses}.` : 'They share no seed, so they cannot be compared seed by seed.'}</p> : null}
    </Screen>
  );
}

// ---------------------------------------------------------------- the view

export default function Evaluations({ arg, query }: { arg: string | null; query: URLSearchParams }) {
  const { data: list, error } = useApi<EvaluationInfo[]>('/evaluations', 10_000);
  const meta = useApi<Meta>('/meta', 30_000);
  const [dialog, setDialog] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  if (arg && /^\d+$/.test(arg)) return <Detail id={Number(arg)} />;
  if (error) return <Failure error={error} />;
  if (!list) return <Loading what="the evaluations" />;
  const a = Number(query.get('a')), b = Number(query.get('b'));
  return (
    <div className="grid grid-cols-1 gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="type-display">Evaluations</h1>
          <p className="mt-2 max-w-[76ch] text-base text-ink-2">A model file plays fixed seeds once each. Only an evaluation on the held-out seeds, against the reference the promotion rule names, is a verdict; every other is stored for information.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setDialog(true)}>Run an evaluation</button>
      </header>
      <Notice result={result} onDismiss={() => setResult(null)} />
      <Screen title="Every evaluation">
        {list.length ? (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead><tr><th className="num">No.</th><th>When</th><th>Model</th><th>Seeds</th><th className="num">Median</th><th className="num">Mean</th><th className="num">Best</th><th className="num">Completed</th><th className="num">Against reference</th><th>Result</th></tr></thead>
              <tbody>{list.map((e) => (
                <tr key={e.id} className="is-link" onClick={() => go('evaluations', e.id)}>
                  <td className="num type-num"><a href={href('evaluations', e.id)}>{e.id}</a></td><td className="whitespace-nowrap">{when(e.createdAt)}</td>
                  <td>{e.run ?? shortHash(e.modelSha256)} <span className="type-num text-ink-2">at {compact(e.timesteps ?? 0)}</span></td><td className="type-num">{e.seedsLabel}</td>
                  <td className="num type-num">{num(e.summary.scoreMedian)}</td><td className="num type-num">{num(e.summary.scoreMean)}</td><td className="num type-num">{num(e.summary.scoreMax)}</td>
                  <td className="num type-num">{percent(e.summary.completed / Math.max(1, e.summary.episodes))}</td><td className="num type-num">{e.ratio != null ? `${num2(e.ratio)} ×` : '–'}</td><td><Verdict e={e} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <Empty action={<button type="button" className="btn" onClick={() => setDialog(true)}>Run an evaluation</button>}>No model has been evaluated yet.</Empty>}
      </Screen>
      {list.length >= 2 ? <Compare list={list} a={list.some((e) => e.id === a) ? a : list[0].id} b={list.some((e) => e.id === b) ? b : list[1].id} /> : null}
      <EvaluateDialog open={dialog} onClose={() => setDialog(false)} onResult={setResult} meta={meta.data} model={null} />
    </div>
  );
}
