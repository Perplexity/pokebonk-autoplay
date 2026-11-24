import { useState } from 'react';
import type { ActionResult, Curve, EvaluationInfo, Meta, ModelsView, Overview as OverviewData, RunInfo } from '../../shared/api.ts';
import { EvaluateDialog, ResumeDialog, StartTrainingDialog } from '../components/dialogs.tsx';
import { Figure } from '../components/Figure.tsx';
import { JobList } from '../components/JobList.tsx';
import { Notice } from '../components/Notice.tsx';
import { RunRoute } from '../components/RunRoute.tsx';
import { Empty, Failure, Loading, Screen } from '../components/Screen.tsx';
import { SegmentedBar } from '../components/SegmentedBar.tsx';
import { Sparkline } from '../components/Sparkline.tsx';
import { XYChart } from '../components/XYChart.tsx';
import type { ChartTip } from '../components/XYChart.tsx';
import { act, useApi } from '../lib/api.ts';
import { ago, compact, duration, gameClock, num, num1, num2, percent, REWARD_NAMES, shortHash, when } from '../lib/format.ts';
import { go, href } from '../lib/route.ts';

type Dialog = 'start' | 'resume' | 'evaluate' | null;

const POLICY_NAMES: Record<string, string> = { random: 'random play', heuristic: 'scripted heuristic', idle: 'standing still' };

// ---------------------------------------------------------------- score per episode

function ScoreScreen({ curve, run }: { curve: Curve; run: RunInfo }) {
  const [table, setTable] = useState(false);
  const tip = (x: number): ChartTip | null => {
    const bin = curve.bins.find((b) => x >= b.from && x < b.to) ?? null;
    if (!bin) return null;
    return {
      x: bin.t, title: `${compact(bin.from)} to ${compact(bin.to)} decisions`,
      rows: [
        { label: 'Episodes', value: num(bin.episodes) },
        { label: 'Median score', value: num(bin.scoreMedian), color: 'var(--series-1)' },
        { label: 'Mean score', value: num(bin.scoreMean) },
        { label: 'Mean game time', value: gameClock(bin.gameTimeMean) },
      ],
    };
  };
  const first = curve.firstQuarter, last = curve.lastQuarter, random = curve.references.find((r) => r.policy === 'random');
  return (
    <Screen title="Score per training episode" className="lg:col-span-2"
      actions={<button type="button" className="btn btn-quiet" aria-pressed={table} onClick={() => setTable((t) => !t)}>{table ? 'Show the chart' : 'Show as a table'}</button>}
      note={<>Score is KOs plus the overtime bonus when it was cashed: what the ranking counts. Each dot is one episode played while training, with sampled actions; the line is the median of the episodes that ended in each stretch. The level lines are the median scores of the scripted baselines on the development seeds.</>}>
      {table ? (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead><tr><th>Decisions trained</th><th className="num">Episodes</th><th className="num">Median score</th><th className="num">Mean score</th><th className="num">Mean game time</th><th className="num">Mean level</th></tr></thead>
            <tbody>{curve.bins.map((b) => (
              <tr key={b.from}><td className="type-num">{compact(b.from)} to {compact(b.to)}</td><td className="num type-num">{b.episodes}</td><td className="num type-num">{num(b.scoreMedian)}</td><td className="num type-num">{num(b.scoreMean)}</td>
                <td className="num type-num">{gameClock(b.gameTimeMean)}</td><td className="num type-num">{num1(b.levelMean)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      ) : (
        <XYChart label={`Score per training episode of ${run.name} against decisions trained`} height={300} xMax={Math.max(curve.timesteps, 1)} formatX={compact} formatY={compact} xTitle="decisions trained"
          lines={[{ id: 'median', label: 'Median score', color: 'var(--series-1)', points: curve.bins.map((b) => ({ x: b.t, y: b.scoreMedian })) }]}
          dots={curve.points.map((p) => ({ x: p.t, y: p.score }))}
          refs={curve.references.map((r) => ({ y: r.scoreMedian, label: `${POLICY_NAMES[r.policy] ?? r.policy}: ${num(r.scoreMedian)}` }))} tip={tip} />
      )}
      {first && last ? (
        <p className="mt-3 max-w-[78ch] text-ink-2">
          The most recent quarter of episodes has a median of <strong className="font-semibold text-ink">{num(last.scoreMedian)}</strong>, the first quarter {num(first.scoreMedian)}
          {random ? <>; random play on the development seeds has {num(random.scoreMedian)}</> : null}. Those are {last.episodes} episodes each, on other seeds than the baselines: a direction, not a verdict.
        </p>
      ) : null}
    </Screen>
  );
}

// ---------------------------------------------------------------- evaluation

function EvaluationScreen({ evaluation, hasCheckpoint, onEvaluate }: { evaluation: EvaluationInfo | null; hasCheckpoint: boolean; onEvaluate: () => void }) {
  const run = <button type="button" className="btn" onClick={onEvaluate} disabled={!hasCheckpoint}>Run an evaluation</button>;
  if (!evaluation) {
    return (
      <Screen title="Evaluation">
        <Empty action={run}>No model has been evaluated yet. An evaluation plays fixed seeds with the model's most probable action and compares the result with a stored baseline, seed by seed.</Empty>
      </Screen>
    );
  }
  const s = evaluation.summary, ref = evaluation.referenceSummary;
  const verdict = evaluation.passed === true ? 'Passed the promotion rule' : evaluation.passed === false ? 'Did not pass the promotion rule' : 'For information';
  return (
    <Screen title="Latest evaluation" actions={run}>
      <p className="mb-3 text-ink-2">{evaluation.run ?? 'A model'} at {num(evaluation.timesteps)} decisions, seeds {evaluation.seedsLabel}, {ago(evaluation.createdAt)}.</p>
      <dl className="grid grid-cols-3 gap-3">
        <Figure label="Median score" value={num(s.scoreMedian)} detail={ref ? `reference ${num(ref.scoreMedian)}` : undefined} />
        <Figure label="Mean score" value={num(s.scoreMean)} detail={ref ? `reference ${num(ref.scoreMean)}` : undefined} />
        <Figure label="Best score" value={num(s.scoreMax)} detail={ref ? `reference ${num(ref.scoreMax)}` : undefined} />
      </dl>
      <dl className="mt-4 grid gap-1.5">
        <div className="flex justify-between gap-4"><dt className="text-ink-2">Runs completed</dt><dd className="type-num">{s.completed} of {s.episodes} ({percent(s.completed / Math.max(1, s.episodes))})</dd></div>
        <div className="flex justify-between gap-4"><dt className="text-ink-2">Mean game time</dt><dd className="type-num">{gameClock(s.gameTimeMean)}</dd></div>
        <div className="flex justify-between gap-4"><dt className="text-ink-2">Invalid, stood still</dt><dd className="type-num">{s.invalid} of {s.episodes}</dd></div>
        {evaluation.ratio != null ? <div className="flex justify-between gap-4"><dt className="text-ink-2">Against the reference</dt><dd className="type-num">{num2(evaluation.ratio)} × ({num2(evaluation.minRatio)} needed)</dd></div> : null}
      </dl>
      <p className="mt-3 flex items-center gap-2 font-semibold">
        <span className="lamp" style={{ background: evaluation.passed === true ? 'var(--good)' : evaluation.passed === false ? 'var(--critical)' : 'transparent', borderColor: evaluation.passed === true ? 'var(--good)' : evaluation.passed === false ? 'var(--critical)' : 'var(--ink-3)' }} />
        {verdict}
      </p>
      {evaluation.note ? <p className="mt-1 text-ink-2">{evaluation.note}</p> : null}
      <p className="mt-3"><a className="btn btn-quiet -ml-1.5" href={href('evaluations', evaluation.id)}>Open evaluation {evaluation.id}</a></p>
    </Screen>
  );
}

// ---------------------------------------------------------------- reward, progression, throughput

function RewardScreen({ curve, run }: { curve: Curve; run: RunInfo }) {
  const last = curve.bins.at(-1);
  const scale = run.rewardScale || 1;
  return (
    <Screen title="Reward components" note={<>Reward {run.rewardVersion}, per episode, in KOs' worth (one KO pays 1). KOs and overtime are the objective itself; the rest are hints.</>}>
      {last ? (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead><tr><th>Paid for</th><th className="num">Each</th><th>Over the run</th><th className="num">Latest</th></tr></thead>
            <tbody>
              {curve.components.map((k) => (
                <tr key={k}>
                  <td>{REWARD_NAMES[k] ?? k}</td>
                  <td className="num type-num">{run.rewardWeights[k] != null ? num(run.rewardWeights[k]) : '–'}</td>
                  <td><Sparkline values={curve.bins.map((b) => b.components[k] / scale)} label={`${REWARD_NAMES[k] ?? k} per episode over the run`} /></td>
                  <td className="num type-num">{num(last.components[k] / scale)}</td>
                </tr>
              ))}
              <tr><td className="font-semibold">Total</td><td /><td><Sparkline values={curve.bins.map((b) => b.rewardMean / scale)} label="Total reward per episode over the run" /></td><td className="num type-num font-semibold">{num(last.rewardMean / scale)}</td></tr>
            </tbody>
          </table>
        </div>
      ) : <Empty>No training episode has finished yet.</Empty>}
    </Screen>
  );
}

function ProgressionScreen({ curve }: { curve: Curve }) {
  const s = curve.summary, recent = curve.lastQuarter ?? curve.summary, last = curve.bins.at(-1);
  if (!s || !recent) return <Screen title="Survival and progression"><Empty>No training episode has finished yet.</Empty></Screen>;
  const beat = Object.entries(s.guardians).reduce((n, [k, v]) => n + (Number(k) > 0 ? v : 0), 0);
  return (
    <Screen title="Survival and progression" note={<>All {s.episodes} training episodes of the run; "recent" is the last quarter of them.</>}>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-4">
        <Figure label="Mean game time" value={gameClock(s.gameTimeMean)} detail={`recent ${gameClock(recent.gameTimeMean)}`} />
        <Figure label="Mean level" value={num1(s.levelMean)} detail={`recent ${num1(recent.levelMean)}`} />
        <Figure label="Runs completed" value={percent(s.completed / s.episodes)} detail={`${s.completed} of ${s.episodes} episodes`} />
        <Figure label="Beat a guardian" value={percent(beat / s.episodes)} detail={`${beat} of ${s.episodes} episodes`} />
      </dl>
      <h3 className="type-label mt-5 mb-2">Episodes by the zone they ended in</h3>
      <SegmentedBar label="Episodes by the zone they ended in" parts={['1', '2', '3', '4'].map((z) => ({ label: z === '4' ? 'Sanctuary' : `Zone ${z}`, value: s.zones[z] ?? 0 }))} />
      <p className="mt-4 text-ink-2">
        Ended for standing still (no KO and no movement for 30 game seconds; such a run is invalid and scores 0): <span className="type-num text-ink">{s.invalid} of {s.episodes}</span>
        {recent !== s ? <>, recently <span className="type-num text-ink">{recent.invalid} of {recent.episodes}</span></> : null}.
      </p>
      {last ? <p className="mt-2 text-ink-2">Map uses per episode, latest stretch: <span className="type-num text-ink">{num1(last.counters.mapUse)}</span>. Items sold in the shop: <span className="type-num text-ink">{num1(last.counters.shopSold)}</span>.</p> : null}
    </Screen>
  );
}

function ThroughputScreen({ curve, run }: { curve: Curve; run: RunInfo }) {
  const rates = curve.throughput.map((t) => t.decisionsPerSecond);
  const wall = run.sessions.reduce((n, s) => n + ((s.finishedAt ? Date.parse(s.finishedAt) : Date.parse(s.lastActivityAt)) - Date.parse(s.startedAt)) / 1000, 0);
  return (
    <Screen title="Throughput" note={<>{run.workers.envs} game processes and {run.workers.spares} spares on {run.device.toUpperCase() || 'the CPU'}. 20 decisions are one second of game time.</>}>
      <dl className="grid grid-cols-2 gap-3">
        <Figure label="Decisions a second" value={num(run.decisionsPerSecond)} detail={rates.length ? `${num(Math.min(...rates))} to ${num(Math.max(...rates))} between checkpoints` : undefined} />
        <Figure label="Episodes an hour" value={num(run.episodesPerHour)} detail={`${duration(wall)} of training`} />
      </dl>
      {rates.length > 1 ? <><h3 className="type-label mt-5 mb-1">Decisions a second, checkpoint to checkpoint</h3><Sparkline values={rates} width={260} height={44} label="Decisions a second between checkpoints" /></> : null}
    </Screen>
  );
}

// ---------------------------------------------------------------- the view

export default function Overview() {
  const overview = useApi<OverviewData>('/overview', 5_000);
  const runs = useApi<RunInfo[]>('/runs', 5_000);
  const meta = useApi<Meta>('/meta', 30_000);
  const models = useApi<ModelsView>('/models', 15_000);
  const [picked, setPicked] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [evaluateModel, setEvaluateModel] = useState<string | null>(null);
  const [checkpoint, setCheckpoint] = useState<number | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);

  const o = overview.data, list = runs.data ?? [];
  const run = list.find((r) => r.name === (picked ?? o?.focusRun)) ?? list[0] ?? null;
  const curve = useApi<Curve>(run ? `/runs/${encodeURIComponent(run.name)}/curve` : null, run?.status === 'running' ? 10_000 : 60_000);

  if (overview.error && !o) return <Failure error={overview.error} />;
  if (!o) return <Loading what="the database" />;

  const training = o.status.state === 'training', busy = o.status.state !== 'idle';
  const selected = run?.checkpoints.find((c) => c.id === checkpoint) ?? null;
  const openEvaluate = (model: string | null) => { setEvaluateModel(model); setDialog('evaluate'); };
  const send = async (path: string, body: Record<string, unknown>) => setResult(await act(path, body));

  return (
    <div className="grid grid-cols-1 gap-5">
      <header className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
        <div className="min-w-0">
          <h1 className="type-display break-words">{run ? run.name : 'No training run yet'}</h1>
          <p className="mt-2 flex items-center gap-2 text-base">
            <span className={`lamp ${training ? 'lamp-on' : busy ? 'lamp-busy' : ''}`} />
            <span>{o.status.headline}</span>
          </p>
          {list.length > 1 ? (
            <label className="mt-2 flex items-center gap-2 text-ink-2"><span>Showing run</span>
              <select className="rounded-[3px] border border-axis bg-screen px-2 py-1" value={run?.name ?? ''} onChange={(e) => { setPicked(e.target.value); setCheckpoint(null); }}>
                {list.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
              </select></label>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {run && run.status === 'running'
            ? <button type="button" className="btn" disabled={run.stopRequested} onClick={() => void send('train/stop', { run: run.name })}>{run.stopRequested ? 'Stopping after this step…' : 'Stop and save a checkpoint'}</button>
            : run && run.checkpoints.length ? <button type="button" className="btn" onClick={() => setDialog('resume')}>Resume training</button> : null}
          <button type="button" className="btn" disabled={!run?.checkpoints.length} onClick={() => openEvaluate(run?.name ?? null)}>Run an evaluation</button>
          <button type="button" className="btn btn-primary" onClick={() => setDialog('start')}>Start a training run</button>
        </div>
      </header>

      <Notice result={result} onDismiss={() => setResult(null)} />

      {!o.database.exists ? (
        <Screen title="Nothing recorded yet"><Empty>There is no database at {o.database.path}. It is created by the first batch of episodes or the first training run.</Empty></Screen>
      ) : null}

      {run ? (
        <section className="screen px-2 pt-3 pb-2 sm:px-3" aria-label="The run and its checkpoints">
          <RunRoute run={run} models={models.data?.models ?? []} selected={checkpoint} onSelect={setCheckpoint} />
          <div className="flex min-h-9 flex-wrap items-center gap-x-5 gap-y-2 border-t border-grid px-3 pt-2 pb-1">
            {selected ? (
              <>
                <span>Checkpoint at <strong className="type-num font-semibold">{num(selected.timesteps)}</strong> decisions</span>
                <span className="text-ink-2">{selected.episodes} episodes, saved {when(selected.createdAt)}, file {shortHash(selected.sha256)}</span>
                <span className="ml-auto flex flex-wrap gap-2">
                  <button type="button" className="btn btn-quiet" onClick={() => openEvaluate(`checkpoint:${selected.id}`)}>Evaluate it</button>
                  <button type="button" className="btn btn-quiet" onClick={() => go('watch', null, { model: `checkpoint:${selected.id}` })}>Watch it play</button>
                  <button type="button" className="btn btn-quiet" onClick={() => void send('models/register', { model: `checkpoint:${selected.id}` })}>Register as a candidate</button>
                </span>
              </>
            ) : (
              <span className="text-ink-2">{run.checkpoints.length ? `${run.checkpoints.length} checkpoints. Select one to evaluate it, watch it play or register it as a candidate.` : 'The first checkpoint appears on this line when it is written.'}</span>
            )}
          </div>
        </section>
      ) : (
        <Screen title="Start here"><Empty action={<button type="button" className="btn btn-primary" onClick={() => setDialog('start')}>Start a training run</button>}>
          Nothing has been trained in this database. A training run plays the local, offline copy of the game in several processes and learns from it.</Empty></Screen>
      )}

      <dl className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 xl:grid-cols-6">
        <Figure label="Training episodes" value={num(o.totals.trainingEpisodes)} detail={o.totals.runs === 1 ? 'in 1 run' : `in ${o.totals.runs} runs`} />
        <Figure label="Decisions trained" value={compact(o.totals.trainingSteps)} detail={run ? `${num(run.timesteps)} in this run` : undefined} />
        <Figure label="Decisions a second" value={num(run?.decisionsPerSecond)} detail={run?.episodesPerHour ? `${num(run.episodesPerHour)} episodes an hour` : undefined} />
        <Figure label="Latest checkpoint" value={o.latestCheckpoint ? compact(o.latestCheckpoint.timesteps) : '–'} detail={o.latestCheckpoint ? `${shortHash(o.latestCheckpoint.sha256)}, ${ago(o.latestCheckpoint.createdAt)}` : 'none written yet'} />
        <Figure label="Stable model" value={o.stable ? `Model ${o.stable.id}` : 'None'} detail={o.stable ? `${shortHash(o.stable.sha256)} from ${o.stable.run ?? 'an unknown run'}` : `${o.candidates.length} candidate${o.candidates.length === 1 ? '' : 's'} registered`} />
        <Figure label="Game" value={o.builds[0]?.version ?? '–'} detail={o.builds[0] ? `build ${o.builds[0].build}${o.builds.length > 1 ? ` and ${o.builds.length - 1} more` : ''}` : undefined} />
      </dl>

      {run ? (
        curve.data ? (
          <>
            <div className="grid items-start gap-5 lg:grid-cols-3">
              <ScoreScreen curve={curve.data} run={run} />
              <EvaluationScreen evaluation={run.evaluations[0] ?? null} hasCheckpoint={run.checkpoints.length > 0} onEvaluate={() => openEvaluate(run.name)} />
            </div>
            <div className="grid items-start gap-5 lg:grid-cols-3">
              <RewardScreen curve={curve.data} run={run} />
              <ProgressionScreen curve={curve.data} />
              <ThroughputScreen curve={curve.data} run={run} />
            </div>
          </>
        ) : curve.error ? <Failure error={curve.error} /> : <Loading what="the run's episodes" />
      ) : null}

      {o.status.jobs.length ? <Screen title="Started from this dashboard"><JobList jobs={o.status.jobs} /></Screen> : null}

      <StartTrainingDialog open={dialog === 'start'} onClose={() => setDialog(null)} onResult={setResult} meta={meta.data} lastRun={list[0] ?? null} />
      {run ? <ResumeDialog open={dialog === 'resume'} onClose={() => setDialog(null)} onResult={setResult} run={run} /> : null}
      <EvaluateDialog open={dialog === 'evaluate'} onClose={() => setDialog(null)} onResult={setResult} meta={meta.data} model={evaluateModel} />
    </div>
  );
}
