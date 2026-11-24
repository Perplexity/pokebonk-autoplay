import { useState } from 'react';
import type { ActionResult, ModelInfo, ModelsView } from '../../shared/api.ts';
import { TypedConfirmDialog } from '../components/dialogs.tsx';
import { Notice } from '../components/Notice.tsx';
import { Empty, Failure, Loading, Screen } from '../components/Screen.tsx';
import { act, useApi } from '../lib/api.ts';
import { ago, num, shortHash, when } from '../lib/format.ts';
import { href } from '../lib/route.ts';

type Pending = { kind: 'promote' | 'rollback'; model: ModelInfo } | null;

const verdictText = (m: ModelInfo): string => (m.verdict ? (m.verdict.passed ? `Passed evaluation ${m.verdict.evaluationId}` : `Did not pass evaluation ${m.verdict.evaluationId}`) : 'No verdict yet');

export default function Models() {
  const { data, error } = useApi<ModelsView>('/models', 10_000);
  const [pending, setPending] = useState<Pending>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  if (error && !data) return <Failure error={error} />;
  if (!data) return <Loading what="the registered models" />;
  const candidates = data.models.filter((m) => m.role === 'candidate'), retired = data.models.filter((m) => m.role === 'retired');
  const send = async (path: string, body: Record<string, unknown>) => setResult(await act(path, body));
  const s = data.stable;
  return (
    <div className="grid grid-cols-1 gap-5">
      <header>
        <h1 className="type-display">Models</h1>
        <p className="mt-2 max-w-[80ch] text-base text-ink-2">
          A checkpoint becomes a candidate when it is registered, and the stable model when it is promoted. A promotion copies the candidate into a new folder; no stable model's files are ever overwritten, moved or deleted, here or by the commands this page runs.
        </p>
      </header>
      <Notice result={result} onDismiss={() => setResult(null)} />

      <Screen title="Stable model">
        {s ? (
          <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
            <div className="flex justify-between gap-4"><dt className="text-ink-2">Model</dt><dd className="font-semibold">Model {s.id}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-ink-2">From</dt><dd>{s.run ?? 'unknown run'} at <span className="type-num">{num(s.timesteps)}</span> decisions</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-ink-2">File</dt><dd className="type-num">{shortHash(s.sha256)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-ink-2">Stable since</dt><dd>{when(data.pointer?.promoted_at ?? s.createdAt)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-ink-2">Promoted on</dt><dd>{s.evaluationId ? <a className="text-action underline" href={href('evaluations', s.evaluationId)}>evaluation {s.evaluationId}</a> : '–'}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-ink-2">Folder</dt><dd className="truncate font-mono text-xs" title={s.path}>{s.path.split(/[\\/]/).slice(-2).join('/')} ({data.stableFiles.length} files)</dd></div>
          </dl>
        ) : <Empty>There is no stable model yet. A candidate becomes the first one when an evaluation of it on the held-out seeds passes the promotion rule and it is promoted here.</Empty>}
      </Screen>

      <Screen title="Candidates" note="Promotion needs a passed verdict of exactly this file, and that verdict has to be its newest one.">
        {candidates.length ? (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead><tr><th className="num">No.</th><th>From</th><th>File</th><th>Registered</th><th>Verdict</th><th /></tr></thead>
              <tbody>{candidates.map((m) => (
                <tr key={m.id}>
                  <td className="num type-num">{m.id}</td><td>{m.run ?? 'unknown run'} <span className="type-num text-ink-2">at {num(m.timesteps)}</span></td><td className="type-num">{shortHash(m.sha256)}</td><td>{ago(m.createdAt)}</td>
                  <td>{m.verdict ? <a className="underline" href={href('evaluations', m.verdict.evaluationId)}>{verdictText(m)}</a> : verdictText(m)}</td>
                  <td className="text-right whitespace-nowrap">
                    <button type="button" className="btn btn-quiet" onClick={() => void send('evaluate', { model: `candidate:${m.id}` })}>{s ? 'Evaluate against the stable model' : 'Evaluate for a verdict'}</button>
                    <button type="button" className="btn ml-2" disabled={!m.verdict?.passed} title={m.verdict?.passed ? undefined : 'It needs a passed verdict first'} onClick={() => setPending({ kind: 'promote', model: m })}>Promote</button>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <Empty>No candidate is registered. On the overview, select a checkpoint on the run's route and register it.</Empty>}
      </Screen>

      {retired.length ? (
        <Screen title="Earlier stable models" note="Each keeps its folder. Rolling back points the stable model at one of them again, after checking its file is unchanged.">
          <table className="data-table">
            <thead><tr><th className="num">No.</th><th>From</th><th>File</th><th>Became stable</th><th /></tr></thead>
            <tbody>{retired.map((m) => (
              <tr key={m.id}><td className="num type-num">{m.id}</td><td>{m.run ?? 'unknown run'} <span className="type-num text-ink-2">at {num(m.timesteps)}</span></td><td className="type-num">{shortHash(m.sha256)}</td><td>{when(m.createdAt)}</td>
                <td className="text-right"><button type="button" className="btn" onClick={() => setPending({ kind: 'rollback', model: m })}>Roll back to it</button></td></tr>
            ))}</tbody>
          </table>
        </Screen>
      ) : null}

      <Screen title="What happened to the models">
        {data.events.length ? (
          <ul className="grid gap-1.5">{data.events.map((e) => (
            <li key={e.id} className="flex flex-wrap justify-between gap-x-4 border-b border-grid pb-1.5 last:border-b-0">
              <span>{e.action === 'register' ? `Model ${e.modelId} registered as a candidate` : e.action === 'promote' ? `Model ${e.modelId} promoted to stable${e.previousStableId ? `, replacing model ${e.previousStableId}` : ''}` : `Rolled back to model ${e.modelId}${e.previousStableId ? ` from model ${e.previousStableId}` : ''}`}{e.note ? ` (${e.note})` : ''}</span>
              <span className="text-ink-2">{when(e.at)}</span>
            </li>
          ))}</ul>
        ) : <Empty>Nothing has been registered, promoted or rolled back.</Empty>}
      </Screen>

      {pending?.kind === 'promote' ? (
        <TypedConfirmDialog open onClose={() => setPending(null)} onResult={setResult} title={`Promote candidate ${pending.model.id}`} phrase={`promote ${pending.model.id}`} path="models/promote" body={{ candidate: pending.model.id }} submit="Promote to stable">
          <p>Candidate {pending.model.id} ({shortHash(pending.model.sha256)}, {pending.model.run ?? 'unknown run'} at {num(pending.model.timesteps)} decisions) becomes the stable model.</p>
          <p>{s ? `Model ${s.id} stops being the stable one. Its folder stays where it is, and you can roll back to it.` : 'It will be the first stable model.'}</p>
        </TypedConfirmDialog>
      ) : null}
      {pending?.kind === 'rollback' ? (
        <TypedConfirmDialog open onClose={() => setPending(null)} onResult={setResult} title={`Roll back to model ${pending.model.id}`} phrase={`roll back to ${pending.model.id}`} path="models/rollback" body={{ to: pending.model.id }} submit="Roll back">
          <p>Model {pending.model.id} ({shortHash(pending.model.sha256)}) becomes the stable model again.</p>
          <p>{s ? `Model ${s.id} stops being the stable one and keeps its folder.` : ''}</p>
        </TypedConfirmDialog>
      ) : null}
    </div>
  );
}
