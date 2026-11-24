import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { ActionResult, Meta, RunInfo } from '../../shared/api.ts';
import { act } from '../lib/api.ts';
import { num } from '../lib/format.ts';
import { Modal } from './Modal.tsx';

interface Base { open: boolean; onClose: () => void; onResult: (r: ActionResult) => void }

/** A form in a dialog: it sends once, reports what the server said, and closes when that was a success. */
function ActionForm({ path, body, submit, disabled, children, onClose, onResult }: {
  path: string; body: () => Record<string, unknown>; submit: string; disabled?: boolean; children: ReactNode; onClose: () => void; onResult: (r: ActionResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const result = await act(path, body());
    setBusy(false);
    if (result.ok) { setRefused(null); onResult(result); onClose(); } else setRefused(result.message);
  };
  return (
    <form onSubmit={send} className="grid gap-4">
      {children}
      {refused ? <p role="alert" className="border-l-2 border-critical pl-3 text-critical-ink">{refused}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy || disabled}>{busy ? 'Sending…' : submit}</button>
      </div>
    </form>
  );
}

export function StartTrainingDialog({ open, onClose, onResult, meta, lastRun }: Base & { meta: Meta | undefined; lastRun: RunInfo | null }) {
  const d = meta?.defaults?.training;
  const [name, setName] = useState<string | null>(null);
  const [envs, setEnvs] = useState<string | null>(null);
  const [spares, setSpares] = useState<string | null>(null);
  const [timesteps, setTimesteps] = useState<string | null>(null);
  // Until a field is edited it shows the suggestion: the last run's setting, else the configuration file's.
  const v = {
    name: name ?? meta?.suggestedRunName ?? '', envs: envs ?? String(lastRun?.workers.envs ?? d?.envs ?? 5), spares: spares ?? String(lastRun?.workers.spares ?? d?.spares ?? 2),
    timesteps: timesteps ?? String(d?.totalTimesteps ?? 2_000_000),
  };
  const budget = meta?.gameProcessBudget ?? 12, total = Number(v.envs) + Number(v.spares);
  return (
    <Modal title="Start a training run" open={open} onClose={onClose}>
      <ActionForm path="train/start" submit="Start training" onClose={onClose} onResult={onResult} disabled={total > budget}
        body={() => ({ name: v.name, envs: Number(v.envs), spares: Number(v.spares), timesteps: Number(v.timesteps) })}>
        <p className="text-ink-2">A new model, trained from nothing with configs/training.yaml{d ? ` (reward ${d.rewardFile.replace(/^reward-|\.yaml$/g, '')}, ${d.device.toUpperCase()})` : ''}. It keeps running if you close this page.</p>
        <label className="field"><span>Run name</span><input required value={v.name} onChange={(e) => setName(e.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,63}" /><small>Used once. Letters, digits, dots, dashes, underscores.</small></label>
        <label className="field"><span>Decisions to train</span><input required type="number" min={1000} step={1000} value={v.timesteps} onChange={(e) => setTimesteps(e.target.value)} />
          <small>{lastRun?.decisionsPerSecond ? `About ${Math.max(1, Math.round(Number(v.timesteps) / lastRun.decisionsPerSecond / 60))} minutes at the last run's ${num(lastRun.decisionsPerSecond)} decisions a second.` : '20 decisions are one second of game time.'}</small></label>
        <div className="grid grid-cols-2 gap-3">
          <label className="field"><span>Game processes</span><input required type="number" min={1} max={budget} value={v.envs} onChange={(e) => setEnvs(e.target.value)} /></label>
          <label className="field"><span>Spare processes</span><input required type="number" min={0} max={4} value={v.spares} onChange={(e) => setSpares(e.target.value)} /></label>
        </div>
        <p className={total > budget ? 'text-critical-ink' : 'text-ink-3'}>{total} of this machine's {budget} game processes. Memory is the limit: each one holds about 0.7 GB.</p>
      </ActionForm>
    </Modal>
  );
}

export function ResumeDialog({ open, onClose, onResult, run }: Base & { run: RunInfo }) {
  const reached = run.timesteps >= run.targetTimesteps;
  const [timesteps, setTimesteps] = useState<string | null>(null);
  const value = timesteps ?? (reached ? String(run.targetTimesteps * 2) : '');
  return (
    <Modal title={`Resume ${run.name}`} open={open} onClose={onClose}>
      <ActionForm path="train/resume" submit="Resume training" onClose={onClose} onResult={onResult} body={() => ({ run: run.name, timesteps: value === '' ? null : Number(value) })}>
        <p className="text-ink-2">
          Training continues from the newest checkpoint, at {num(run.timesteps)} decisions, with the run's own settings ({run.workers.envs} game processes and {run.workers.spares} spares).
          {reached ? ` It has reached its ${num(run.targetTimesteps)} decisions, so it needs a higher total.` : ''}
        </p>
        <label className="field"><span>New total of decisions{reached ? '' : ' (optional)'}</span>
          <input type="number" required={reached} min={run.timesteps + 1} step={1000} value={value} placeholder={String(run.targetTimesteps)} onChange={(e) => setTimesteps(e.target.value)} />
          <small>{reached ? 'The total can only be raised.' : `Leave empty to train to the ${num(run.targetTimesteps)} it was set to.`}</small></label>
      </ActionForm>
    </Modal>
  );
}

export function EvaluateDialog({ open, onClose, onResult, meta, model }: Base & { meta: Meta | undefined; model: string | null }) {
  const ev = meta?.defaults?.evaluation;
  const [picked, setPicked] = useState<string | null>(null);
  const [kind, setKind] = useState<'look' | 'verdict'>('look');
  const [reference, setReference] = useState<string | null>(null);
  const choices = meta?.modelChoices ?? [];
  const chosen = picked ?? model ?? choices[0]?.ref ?? '';
  // A look uses the development seeds: the stored baselines whose label starts with "baseline".
  const lookRefs = (meta?.references ?? []).filter((r) => r.label.startsWith('baseline') && (!ev || r.species.includes(ev.species)));
  const look = reference ?? lookRefs.find((r) => r.policy === 'random')?.label ?? lookRefs[0]?.label ?? 'none';
  const lookSeeds = lookRefs.find((r) => r.label === look)?.seedsLabel.replace('–', '-') ?? '1-30';
  return (
    <Modal title="Run an evaluation" open={open} onClose={onClose}>
      <ActionForm path="evaluate" submit="Run evaluation" onClose={onClose} onResult={onResult} disabled={!chosen}
        body={() => (kind === 'verdict' ? { model: chosen } : { model: chosen, seeds: lookSeeds, reference: look })}>
        <label className="field"><span>Model</span>
          <select value={chosen} onChange={(e) => setPicked(e.target.value)}>
            {chosen && !choices.some((c) => c.ref === chosen) ? <option value={chosen}>The selected checkpoint</option> : null}
            {choices.length ? choices.map((c) => <option key={c.ref} value={c.ref}>{c.label} ({c.detail})</option>) : <option value="">No checkpoint yet</option>}
          </select></label>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-[0.8125rem] font-semibold text-ink-2">What for</legend>
          <label className="flex items-start gap-2"><input type="radio" name="kind" className="mt-1" checked={kind === 'look'} onChange={() => setKind('look')} />
            <span><strong className="font-semibold">A look, while tuning.</strong> Development seeds {lookSeeds}. Stored for information; it never authorises a promotion.</span></label>
          <label className="flex items-start gap-2"><input type="radio" name="kind" className="mt-1" checked={kind === 'verdict'} onChange={() => setKind('verdict')} />
            <span><strong className="font-semibold">A promotion verdict.</strong> Held-out seeds {ev?.promotionSeeds ?? ''}, against the stable model when there is one, else {ev?.firstReference ?? 'the first reference'}.
              Do not tune anything on what these seeds show.</span></label>
        </fieldset>
        {kind === 'look' ? (
          <label className="field"><span>Compare with</span>
            <select value={look} onChange={(e) => setReference(e.target.value)}>
              {lookRefs.map((r) => <option key={r.label} value={r.label}>{r.label} (seeds {r.seedsLabel})</option>)}
              <option value="none">Nothing</option>
            </select></label>
        ) : null}
        <p className="text-ink-3">The model plays every seed once, taking its most probable action. It needs {ev?.envs ?? 5} game processes.</p>
      </ActionForm>
    </Modal>
  );
}

/** For the two buttons that change which model is the stable one: the words have to be typed. */
export function TypedConfirmDialog({ open, onClose, onResult, title, phrase, path, body, submit, children }: Base & {
  title: string; phrase: string; path: string; body: Record<string, unknown>; submit: string; children: ReactNode;
}) {
  const [typed, setTyped] = useState('');
  return (
    <Modal title={title} open={open} onClose={onClose}>
      <ActionForm path={path} submit={submit} onClose={onClose} onResult={onResult} disabled={typed !== phrase} body={() => ({ ...body, confirm: typed })}>
        <div className="grid gap-2 text-ink-2">{children}</div>
        <label className="field"><span>Type <strong className="font-semibold text-ink">{phrase}</strong> to confirm</span>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} /></label>
      </ActionForm>
    </Modal>
  );
}
