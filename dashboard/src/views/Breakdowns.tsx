import { useState, useTransition } from 'react';
import type { Breakdowns as BreakdownsData, ChoiceRow, GroupRow } from '../../shared/api.ts';
import { Empty, Failure, Loading, Screen } from '../components/Screen.tsx';
import { useApi } from '../lib/api.ts';
import { gameClock, KIND_NAMES, num, num1, percent } from '../lib/format.ts';

const KINDS: { id: ChoiceRow['kind']; label: string }[] = [{ id: 'move', label: 'Moves' }, { id: 'vitamin', label: 'Vitamins' }, { id: 'item', label: 'Held items' }, { id: 'relic', label: 'Relics' }];

/** A number with a thin bar behind it, so a column can be read by length as well as by digits. */
function Meter({ value, max }: { value: number; max: number }) {
  return (
    <span className="flex items-center justify-end gap-2">
      <span className="hidden h-2 w-24 sm:block" aria-hidden="true"><span className="block h-2 rounded-r-[3px] bg-series-1" style={{ width: `${Math.max(1, (value / Math.max(1, max)) * 100)}%` }} /></span>
      <span className="type-num w-16 text-right">{num(value)}</span>
    </span>
  );
}

function GroupTable({ rows, first }: { rows: GroupRow[]; first: string }) {
  const max = Math.max(1, ...rows.map((r) => r.summary.scoreMedian));
  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <thead><tr><th>{first}</th><th>Played by</th><th className="num">Episodes</th><th className="num">Median score</th><th className="num">Mean</th><th className="num">Best</th><th className="num">Completed</th><th className="num">Mean game time</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.key}>
            <td className="font-semibold">{r.label}</td><td>{r.policy}</td><td className="num type-num">{num(r.summary.episodes)}</td><td className="num"><Meter value={r.summary.scoreMedian} max={max} /></td>
            <td className="num type-num">{num(r.summary.scoreMean)}</td><td className="num type-num">{num(r.summary.scoreMax)}</td><td className="num type-num">{percent(r.summary.completed / r.summary.episodes)}</td>
            <td className="num type-num">{gameClock(r.summary.gameTimeMean)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

/** The difference between two medians as a bar from a centre line: right and blue when higher, left and red when lower. */
function Difference({ value, span }: { value: number | null; span: number }) {
  if (value == null) return <span className="text-ink-3">–</span>;
  const w = Math.min(50, (Math.abs(value) / Math.max(1, span)) * 50);
  return (
    <span className="flex items-center justify-end gap-2">
      <span className="relative hidden h-2 w-28 sm:block" aria-hidden="true">
        <span className="absolute inset-y-[-3px] left-1/2 w-px bg-axis" />
        <span className="absolute h-2" style={value >= 0 ? { left: '50%', width: `${w}%`, background: 'var(--series-1)', borderRadius: '0 3px 3px 0' } : { right: '50%', width: `${w}%`, background: 'var(--critical)', borderRadius: '3px 0 0 3px' }} />
      </span>
      <span className="type-num w-16 text-right">{value > 0 ? '+' : value < 0 ? '−' : ''}{num(Math.abs(value))}</span>
    </span>
  );
}

function ChoiceTable({ rows, total }: { rows: ChoiceRow[]; total: number }) {
  const span = Math.max(1, ...rows.map((r) => (r.scoreMedianWithout == null ? 0 : Math.abs(r.scoreMedianWith - r.scoreMedianWithout))));
  return (
    <div className="max-h-[32rem] overflow-auto">
      <table className="data-table">
        <thead className="sticky top-0 bg-screen"><tr><th>Held at the end</th><th className="num">Episodes</th><th className="num">Share</th><th className="num">Mean level</th><th className="num">Median score with it</th><th className="num">Without it</th><th className="num">Difference</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.key}>
            <td>{r.name}</td><td className="num type-num">{r.episodes}</td><td className="num type-num">{percent(r.episodes / Math.max(1, total))}</td><td className="num type-num">{r.meanLevel != null ? num1(r.meanLevel) : '–'}</td>
            <td className="num type-num">{num(r.scoreMedianWith)}</td><td className="num type-num">{num(r.scoreMedianWithout)}</td>
            <td className="num"><Difference value={r.scoreMedianWithout == null ? null : r.scoreMedianWith - r.scoreMedianWithout} span={span} /></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export default function Breakdowns() {
  const [scope, setScope] = useState<string | null>(null);
  const [kind, setKind] = useState<ChoiceRow['kind']>('move');
  const [pending, startTransition] = useTransition();
  const { data, error } = useApi<BreakdownsData>(`/breakdowns${scope ? `?scope=${encodeURIComponent(scope)}` : ''}`, 30_000);
  if (error && !data) return <Failure error={error} />;
  if (!data) return <Loading what="the episodes" />;
  const choices = data.choices.filter((c) => c.kind === kind), total = data.scopeSummary?.episodes ?? 0;
  return (
    <div className="grid grid-cols-1 gap-5">
      <header>
        <h1 className="type-display">Breakdowns</h1>
        <p className="mt-2 max-w-[76ch] text-base text-ink-2">The same scores, split by who was played, by the version of the game, and by what a run ended up holding.</p>
      </header>
      <Screen title="By Pokémon" note="Every stored episode, grouped by the Pokémon it started with and by who played it. Episodes played while training use sampled actions; evaluations use the most probable one.">
        {data.bySpecies.length ? <GroupTable rows={data.bySpecies} first="Pokémon" /> : <Empty>No episode is stored yet.</Empty>}
      </Screen>
      <Screen title="By game version" note="Results of different builds are not comparable with each other: the game's numbers change between them.">
        {data.byVersion.length ? <GroupTable rows={data.byVersion} first="Game version" /> : <Empty>No episode is stored yet.</Empty>}
      </Screen>
      <Screen title="By what the run ended with"
        actions={(
          <label className="flex items-center gap-2 text-ink-2"><span>Episodes of</span>
            <select className="max-w-64 rounded-[3px] border border-axis bg-screen px-2 py-1" value={data.scope} onChange={(e) => startTransition(() => setScope(e.target.value))}>
              {data.scopes.map((s) => <option key={s.id} value={s.id}>{s.label} ({s.episodes})</option>)}
            </select></label>
        )}
        note={<>Median score of the episodes that ended holding each thing, against those that did not. Read it with care: a long run collects more of everything, so what is common in high-scoring runs is not shown to have caused the score.</>}>
        <div role="tablist" aria-label="Kind of thing" className="mb-3 flex gap-1 border-b border-grid">
          {KINDS.map((k) => (
            <button key={k.id} type="button" role="tab" aria-selected={kind === k.id} onClick={() => setKind(k.id)}
              className={`-mb-px border-b-2 px-2.5 py-1.5 font-semibold ${kind === k.id ? 'border-action text-ink' : 'border-transparent text-ink-2 hover:text-ink'}`}>
              {k.label} <span className="type-num text-ink-3">{data.choices.filter((c) => c.kind === k.id).length}</span>
            </button>
          ))}
        </div>
        <div className={pending ? 'opacity-60' : ''}>
          {choices.length ? <ChoiceTable rows={choices} total={total} /> : <Empty>No episode of this selection ended holding any.</Empty>}
        </div>
      </Screen>
      <Screen title="What was picked in dialogs" note="The most frequent answers, with their share of all answers to that kind of dialog. Stored for scripted batches and evaluations; training episodes store them only when store_decisions is on.">
        {data.picks.length ? (
          <div className="max-h-[28rem] overflow-auto">
            <table className="data-table">
              <thead className="sticky top-0 bg-screen"><tr><th>Dialog</th><th>Answer</th><th className="num">Times</th><th className="num">Share of that dialog</th></tr></thead>
              <tbody>{data.picks.map((p) => (
                <tr key={`${p.kind}:${p.chosen}`}><td>{KIND_NAMES[p.kind] ?? p.kind}</td><td>{p.label}</td><td className="num type-num">{num(p.times)}</td><td className="num type-num">{percent(p.share)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        ) : <Empty>This selection stored no dialog answers. Choose a scripted batch or an evaluation above to see what was picked.</Empty>}
      </Screen>
    </div>
  );
}
