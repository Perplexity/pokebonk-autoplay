import { useState } from 'react';
import type { ActionResult, CheckpointInfo, EpisodeDetail, RunInfo } from '../../shared/api.ts';
import { Figure } from '../components/Figure.tsx';
import { Notice } from '../components/Notice.tsx';
import { Empty, Failure, Loading, Screen } from '../components/Screen.tsx';
import { act, useApi } from '../lib/api.ts';
import { gameClock, KIND_NAMES, num, num1, percent, REWARD_NAMES } from '../lib/format.ts';
import { go, href } from '../lib/route.ts';

const COUNTERS: [string, string][] = [
  ['damageDealt', 'Damage dealt'], ['damageTaken', 'Damage taken'], ['hits', 'Hits taken'], ['dodges', 'Dodges'], ['ultimatesUsed', 'Ultimates used'], ['alphasDefeated', 'Alphas beaten'],
  ['goldEarned', 'Pokédollars earned'], ['goldSpent', 'Pokédollars spent'], ['mapUse', 'Uses of the map'], ['pointsUsed', 'Map points used'], ['shopBought', 'Shop purchases'], ['shopSold', 'Items sold in the shop'],
  ['slotSpins', 'Slot-machine spins'], ['riftsCleared', 'Rifts cleared'], ['formsUsed', 'Max forms used'], ['captured', 'Pokémon caught'],
];

/**
 * The checkpoint of the episode's run that was the model when the episode ended: the newest one saved before that, or
 * the run's first when the episode ended before any was saved.
 */
function checkpointFor(e: EpisodeDetail, runs: RunInfo[] | undefined): CheckpointInfo | null {
  const run = runs?.find((r) => r.sessions.some((s) => s.batchId === e.batchId));
  if (!run?.checkpoints.length) return null;
  let best: CheckpointInfo | null = null, first = run.checkpoints[0];
  for (const c of run.checkpoints) {
    if (c.timesteps < first.timesteps) first = c;
    if (c.createdAt <= e.finishedAt && (!best || c.timesteps > best.timesteps)) best = c;
  }
  return best ?? first;
}

export default function Episode({ arg }: { arg: string | null }) {
  const { data: e, error } = useApi<EpisodeDetail>(arg && /^\d+$/.test(arg) ? `/episodes/${arg}` : null, 300_000);
  const training = e?.batch.kind === 'training';
  const runs = useApi<RunInfo[]>(training ? '/runs' : null, 30_000);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [starting, setStarting] = useState(false);
  if (error) return <Failure error={error} />;
  if (!e) return <Loading what="the episode" />;
  const moves = e.build?.moves ?? [], damage = moves.reduce((n, m) => n + m.damageDone, 0);
  const checkpoint = training ? checkpointFor(e, runs.data) : null;
  // An evaluation's episode is played again exactly. A training episode was not recorded move by move: its seed is
  // played again by the checkpoint its run had at the time.
  const watch = async () => {
    setStarting(true);
    const r = await act('watch/start', e.replay ? { episode: e.id, speed: 4 }
      : { model: `checkpoint:${checkpoint!.id}`, seed: e.seed, speed: 4, stochastic: true, species: e.species, map: e.map, tier: e.tier });
    setStarting(false);
    if (r.ok) go('watch', null, e.replay ? { episode: e.id } : { like: e.id, model: `checkpoint:${checkpoint!.id}`, seed: e.seed });
    else setResult(r);
  };
  const canWatch = !!e.replay || !!checkpoint;
  const watchNote = e.replay ? 'Played again from its own model file and seed: the same episode, move for move.'
    : checkpoint ? `Training episodes are not recorded move by move. This plays the same seed again with the model its run had then (the checkpoint at ${num(checkpoint.timesteps)} decisions), with sampled actions as in training: the same map and start, not the same run.`
    : training ? (runs.data ? 'Its run has no checkpoint to play it with yet: the first is saved after about 100,000 decisions.' : '')
    : 'A scripted baseline cannot be watched again yet: the watcher plays stored models only.';
  return (
    <div className="grid grid-cols-1 gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p><a className="btn btn-quiet -ml-1.5" href={href('history', e.batchId)}>{e.batch.label ?? `Batch ${e.batchId}`}</a></p>
          <h1 className="type-display mt-1">Seed {e.seed}</h1>
          <p className="mt-2 text-base text-ink-2">Episode {e.id}, {e.map} tier {e.tier}, played by {e.batch.policy}. It ended: {e.endCause}.</p>
        </div>
        <div className="grid max-w-[46ch] justify-items-start gap-2 sm:justify-items-end sm:text-right">
          {canWatch ? <button type="button" className="btn btn-primary" disabled={starting} onClick={() => void watch()}>{starting ? 'Starting the game' : e.replay ? 'Watch the replay' : 'Watch this seed again'}</button> : null}
          {watchNote ? <p className="text-sm text-ink-2">{watchNote}</p> : null}
        </div>
      </header>
      <Notice result={result} onDismiss={() => setResult(null)} />
      <dl className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 xl:grid-cols-6">
        <Figure label="Score" value={num(e.score)} detail={e.overtimeCashed ? `${num(e.kills)} KOs and ${num(e.overtimeBonus)} overtime bonus` : `${num(e.kills)} KOs`} />
        <Figure label="Game time" value={gameClock(e.gameTime)} />
        <Figure label="Level" value={e.level} />
        <Figure label="Zone reached" value={e.zone === 4 ? 'Sanctuary' : e.zone} detail={`${e.guardians} guardian${e.guardians === 1 ? '' : 's'} beaten`} />
        <Figure label="Dialogs answered" value={num(e.decisions)} detail={e.storedDecisions ? 'all stored' : 'not stored for this batch'} />
        <Figure label="Reward" value={e.reward != null ? num1(e.reward) : '–'} detail={e.reward != null ? `as the learner is paid (${e.batch.rewardVersion})` : 'no reward was computed'} />
      </dl>

      <div className="grid gap-5 lg:grid-cols-2">
        <Screen title="The build it ended with">
          {e.build ? (
            <>
              <table className="data-table">
                <thead><tr><th>Move</th><th>Type</th><th className="num">Level</th><th className="num">Share of the damage</th></tr></thead>
                <tbody>{moves.map((m) => (
                  <tr key={m.key}><td className="font-semibold">{m.name}{m.fusion ? ' (fusion)' : ''}</td><td>{m.type}</td><td className="num type-num">{m.level}</td><td className="num type-num">{damage ? percent(m.damageDone / damage) : '–'}</td></tr>
                ))}</tbody>
              </table>
              <dl className="mt-4 grid gap-2">
                <div><dt className="type-label">Vitamins</dt><dd>{e.build.vitamins.length ? e.build.vitamins.map((v) => `${v.name} ${v.level}`).join(', ') : 'None'}</dd></div>
                <div><dt className="type-label">Held items</dt><dd>{e.build.items.length ? e.build.items.map((i) => (i.count > 1 ? `${i.name} × ${i.count}` : i.name)).join(', ') : 'None'}</dd></div>
                <div><dt className="type-label">Relics</dt><dd>{e.build.relics.length ? e.build.relics.map((r) => r.name).join(', ') : 'None'}</dd></div>
              </dl>
            </>
          ) : <Empty>The final build was not stored.</Empty>}
        </Screen>
        <Screen title="What it did">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5">
            {COUNTERS.filter(([k]) => e.counters[k] != null).map(([k, label]) => (
              <div key={k} className="flex justify-between gap-3 border-b border-grid pb-1"><dt className="text-ink-2">{label}</dt><dd className="type-num">{num(e.counters[k])}</dd></div>
            ))}
          </dl>
          {e.rewardComponents ? (
            <>
              <h3 className="type-label mt-5 mb-2">Reward by component, as paid to the learner</h3>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5">
                {Object.entries(e.rewardComponents).filter(([, v]) => v !== 0).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3 border-b border-grid pb-1"><dt className="text-ink-2">{REWARD_NAMES[k] ?? k}</dt><dd className="type-num">{num1(v)}</dd></div>
                ))}
              </dl>
            </>
          ) : null}
        </Screen>
      </div>

      <Screen title="Every dialog it answered" note={e.timeline.length ? undefined : 'The answers of this episode were not stored: training episodes keep them only when store_decisions is on.'}>
        {e.timeline.length ? (
          <ol className="max-h-[36rem] overflow-auto">
            {e.timeline.map((d) => (
              <li key={d.serial} className="grid grid-cols-[4.5rem_1fr] gap-x-3 border-b border-grid py-1.5 [content-visibility:auto] [contain-intrinsic-size:auto_2.5rem]">
                <span className="type-num text-ink-2">{gameClock(d.gameTime)}</span>
                <span>
                  <span className="font-semibold">{KIND_NAMES[d.kind] ?? d.kind}:</span> {d.chosen}
                  <span className="block text-xs text-ink-2">Zone {d.zone}, level {d.level}. Offered: {d.options.map((o) => o.label).join(', ') || 'nothing to choose from'}</span>
                </span>
              </li>
            ))}
          </ol>
        ) : null}
      </Screen>
    </div>
  );
}
