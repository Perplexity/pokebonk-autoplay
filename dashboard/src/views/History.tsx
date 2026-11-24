import type { BatchInfo, EpisodeRow } from '../../shared/api.ts';
import { Empty, Failure, Loading, Screen } from '../components/Screen.tsx';
import { useApi } from '../lib/api.ts';
import { duration, gameClock, num, percent, when } from '../lib/format.ts';
import { go, href } from '../lib/route.ts';

const KIND: Record<BatchInfo['kind'], string> = { training: 'Training', evaluation: 'Evaluation', scripted: 'Scripted baseline' };
const STATUS: Record<string, string> = { running: 'Running', completed: 'Completed', failed: 'Failed', interrupted: 'Interrupted' };

function BatchEpisodes({ batch }: { batch: BatchInfo }) {
  const { data, error } = useApi<EpisodeRow[]>(`/episodes?batch=${batch.id}`, batch.status === 'running' ? 10_000 : 120_000);
  if (error) return <Failure error={error} />;
  if (!data) return <Loading what="the episodes" />;
  return (
    <div className="grid grid-cols-1 gap-5">
      <header>
        <p><a className="btn btn-quiet -ml-1.5" href={href('history')}>All of the history</a></p>
        <h1 className="type-display mt-1 break-words">{batch.label ?? `Batch ${batch.id}`}</h1>
        <p className="mt-2 max-w-[80ch] text-base text-ink-2">
          {KIND[batch.kind]}, {batch.policy} {batch.policyVersion}, game {batch.gameVersion ?? '?'} ({batch.gameBuild ?? '?'}), account preset {batch.preset ?? '?'}, started {when(batch.startedAt)}.
          {batch.errors ? ` ${batch.errors} episode${batch.errors === 1 ? ' was' : 's were'} lost to errors.` : ''}
        </p>
      </header>
      <Screen title={data.length === 400 ? 'The newest 400 episodes' : `${data.length} episodes`}>
        {data.length ? (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead><tr><th className="num">Seed</th><th className="num">Score</th><th className="num">KOs</th><th className="num">Game time</th><th className="num">Level</th><th className="num">Zone</th><th className="num">Guardians</th><th className="num">Dialogs</th><th>Ended</th><th>Finished</th></tr></thead>
              <tbody>{data.map((e) => (
                <tr key={e.id} className="is-link" onClick={() => go('episode', e.id)}>
                  <td className="num type-num"><a href={href('episode', e.id)}>{e.seed}</a></td><td className="num type-num">{num(e.score)}</td><td className="num type-num">{num(e.kills)}</td><td className="num type-num">{gameClock(e.gameTime)}</td>
                  <td className="num type-num">{e.level}</td><td className="num type-num">{e.zone}</td><td className="num type-num">{e.guardians}</td><td className="num type-num">{e.decisions}</td><td>{e.endCause}</td><td className="whitespace-nowrap">{when(e.finishedAt)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <Empty>No episode of this batch has finished yet.</Empty>}
      </Screen>
    </div>
  );
}

export default function History({ arg }: { arg: string | null }) {
  const { data, error } = useApi<BatchInfo[]>('/history', 10_000);
  if (error && !data) return <Failure error={error} />;
  if (!data) return <Loading what="the history" />;
  const batch = arg ? data.find((b) => String(b.id) === arg) : null;
  if (batch) return <BatchEpisodes batch={batch} />;
  return (
    <div className="grid grid-cols-1 gap-5">
      <header>
        <h1 className="type-display">History</h1>
        <p className="mt-2 max-w-[76ch] text-base text-ink-2">Every batch of episodes in the database, newest first: training sessions, evaluations and the scripted baselines. Open one for its episodes.</p>
      </header>
      <Screen title="Recent runs">
        {data.length ? (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead><tr><th className="num">No.</th><th>What</th><th>Kind</th><th>Started</th><th className="num">Episodes</th><th className="num">Median score</th><th className="num">Best</th><th className="num">Completed</th><th className="num">Mean game time</th><th className="num">Took</th><th>State</th></tr></thead>
              <tbody>{data.map((b) => (
                <tr key={b.id} className="is-link" onClick={() => go('history', b.id)}>
                  <td className="num type-num">{b.id}</td><td><a className="font-semibold" href={href('history', b.id)}>{b.label ?? `${b.policy} batch`}</a><span className="block text-xs text-ink-2">seeds {b.seedsLabel}</span></td><td>{KIND[b.kind]}</td>
                  <td className="whitespace-nowrap">{when(b.startedAt)}</td><td className="num type-num">{num(b.summary?.episodes ?? 0)}</td><td className="num type-num">{num(b.summary?.scoreMedian)}</td><td className="num type-num">{num(b.summary?.scoreMax)}</td>
                  <td className="num type-num">{b.summary ? percent(b.summary.completed / b.summary.episodes) : '–'}</td><td className="num type-num">{b.summary ? gameClock(b.summary.gameTimeMean) : '–'}</td><td className="num type-num">{duration(b.wallSeconds)}</td>
                  <td className="whitespace-nowrap">{STATUS[b.status] ?? b.status}{b.errors ? `, ${b.errors} lost` : ''}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <Empty>Nothing has been played into this database yet.</Empty>}
      </Screen>
    </div>
  );
}
