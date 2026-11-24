import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { ActionResult, Meta } from '../shared/api.ts';
import { REPO } from './context.ts';
import type { Context } from './context.ts';
import type { Jobs } from './jobs.ts';
import type { Reader } from './reader.ts';

/**
 * What the dashboard's buttons do. Every action is validated here and then handed to one of the project's own
 * command lines; the dashboard has no code of its own that trains, evaluates, registers, promotes or rolls back.
 *
 * About the stable model: this file never touches `models/stable`. A promotion or rollback is the command
 * `python -m pokebonk_rl.registry promote | rollback --yes`, whose rules (python/pokebonk_rl/registry.py) copy and
 * never overwrite, move or delete, and refuse a candidate without a passed evaluation. The only file the dashboard
 * itself writes under `models/` is a run's `STOP` file, the trainer's documented way of being asked to stop.
 */

export class ActionError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

const RUN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SEEDS = /^\d+(-\d+)?(,\d+(-\d+)?)*$/;

const int = (v: unknown, what: string, min: number, max: number): number => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw new ActionError(`${what} must be a whole number from ${min.toLocaleString('en')} to ${max.toLocaleString('en')}.`);
  return n;
};

export class Actions {
  private defaults: Meta['defaults'] | undefined;
  private readonly ctx: Context;
  private readonly reader: Reader;
  private readonly jobs: Jobs;

  constructor(ctx: Context, reader: Reader, jobs: Jobs) { this.ctx = ctx; this.reader = reader; this.jobs = jobs; }

  // ---------------------------------------------------------------- what the forms need

  /** The defaults of configs/training.yaml and configs/evaluation.yaml, read by the project's own loader (once). */
  async configDefaults(): Promise<Meta['defaults']> {
    if (this.defaults !== undefined) return this.defaults;
    const code = [
      'import json',
      'from pokebonk_rl import config as c',
      't = c.load(c.REPO / "configs" / "training.yaml", c.TRAINING_DEFAULTS)',
      'e = c.load(c.REPO / "configs" / "evaluation.yaml", c.EVALUATION_DEFAULTS)',
      'print(json.dumps({"training": {"envs": t["workers"]["envs"], "spares": t["workers"]["spares"], "totalTimesteps": t["total_timesteps"], "checkpointEvery": t["checkpoint_every_timesteps"],',
      '  "species": t["scenarios"]["species"], "rewardFile": t["reward_file"], "device": t["device"]},',
      ' "evaluation": {"seeds": str(e["seeds"]), "species": e["scenario"]["species"], "map": e["scenario"]["map"], "tier": e["scenario"]["tier"], "envs": e["workers"]["envs"],',
      '  "metric": e["promotion"]["metric"], "minRatio": e["promotion"]["min_ratio"], "firstReference": e["promotion"]["first_reference"], "promotionSeeds": str(e["promotion"]["seeds"])}}))',
    ].join('\n');
    this.defaults = await new Promise<Meta['defaults']>((done) => {
      if (!existsSync(this.ctx.python)) return done(null);
      execFile(this.ctx.python, [...this.ctx.pythonArgs, '-c', code], { cwd: this.ctx.repo, timeout: 20_000 }, (error, stdout) => {
        if (error) return done(null);
        try { done(JSON.parse(stdout) as Meta['defaults']); } catch { done(null); }
      });
    });
    return this.defaults;
  }

  async meta(): Promise<Meta> {
    const defaults = await this.configDefaults();
    const runs = this.reader.runs(), models = this.reader.modelList();
    const taken = new Set(runs.map((r) => r.name));
    // "mewtwo-v2-01" → "mewtwo-v2-02": the newest run's name with its number raised, else a dated name.
    let suggestedRunName = `run-${new Date().toISOString().slice(0, 10)}`;
    const numbered = /^(.*?)(\d+)$/.exec(runs[0]?.name ?? '');
    if (numbered) {
      for (let n = Number(numbered[2]) + 1; ; n++) {
        suggestedRunName = numbered[1] + String(n).padStart(numbered[2].length, '0');
        if (!taken.has(suggestedRunName)) break;
      }
    }
    const modelChoices: Meta['modelChoices'] = [];
    const stable = models.find((m) => m.role === 'stable');
    if (stable) modelChoices.push({ ref: 'stable', label: 'Stable model', detail: `model ${stable.id}, ${stable.sha256.slice(0, 12)}` });
    for (const m of models) if (m.role === 'candidate') modelChoices.push({ ref: `candidate:${m.id}`, label: `Candidate ${m.id}`, detail: `${m.run ?? 'unknown run'} at ${(m.timesteps ?? 0).toLocaleString('en')} decisions` });
    for (const r of runs) {
      const newest = r.checkpoints.at(-1);
      if (newest) modelChoices.push({ ref: r.name, label: `${r.name}, newest checkpoint`, detail: `${newest.timesteps.toLocaleString('en')} decisions` });
    }
    for (const c of (runs[0]?.checkpoints ?? []).toReversed().slice(1, 40)) modelChoices.push({ ref: `checkpoint:${c.id}`, label: `${c.run} at ${c.timesteps.toLocaleString('en')}`, detail: c.kind });
    const references: Meta['references'] = this.reader.batches()
      .filter((b) => b.kind === 'scripted' && b.status === 'completed' && b.label)
      .map((b) => ({ label: b.label!, batchId: b.id, policy: b.policy, seedsLabel: b.seedsLabel, species: b.species }));
    const index = join(this.ctx.dist, 'index.html');
    return {
      repo: this.ctx.repo, pythonFound: existsSync(this.ctx.python), builtAt: existsSync(index) ? statSync(index).mtime.toISOString() : null, defaults,
      gameProcessBudget: this.ctx.gameProcessBudget, suggestedRunName, references, modelChoices,
    };
  }

  // ---------------------------------------------------------------- checks shared by the actions

  private requirePython(): void {
    if (!existsSync(this.ctx.python)) throw new ActionError(`No Python environment at ${this.ctx.python}. Create it first (README: "Offline reinforcement learning").`, 409);
  }

  /** Game processes in use: the dashboard's own jobs, and training sessions somebody started in a terminal. */
  private processesInUse(): { count: number; what: string[] } {
    const jobs = this.jobs.running();
    const what = jobs.filter((j) => j.gameProcesses > 0).map((j) => j.title);
    let count = jobs.reduce((n, j) => n + j.gameProcesses, 0);
    const mine = new Set(jobs.map((j) => j.run).filter(Boolean));
    for (const r of this.reader.runs()) {
      if (r.status === 'running' && !mine.has(r.name)) { count += r.workers.envs + r.workers.spares; what.push(`training run ${r.name} (started outside the dashboard)`); }
    }
    return { count, what };
  }

  private requireRoom(needed: number, forWhat: string): void {
    const used = this.processesInUse();
    if (used.count + needed > this.ctx.gameProcessBudget) {
      throw new ActionError(`${forWhat} needs ${needed} game processes; ${used.count} of ${this.ctx.gameProcessBudget} are in use by ${used.what.join(' and ')}. Stop that first, or wait for it to finish.`, 409);
    }
  }

  /** Paths are passed on only when the dashboard was started on other folders than the project's own. */
  private pathOverrides(): string[] {
    const out: string[] = [];
    if (this.ctx.database !== resolve(REPO, 'data', 'pokebonk.sqlite') || this.ctx.repo !== REPO) out.push('--set', `paths.database=${this.ctx.database}`);
    if (this.ctx.models !== resolve(REPO, 'models') || this.ctx.repo !== REPO) out.push('--set', `paths.models=${this.ctx.models}`);
    return out;
  }

  /** A model reference the command lines understand, built from what the database knows (never a path from the request). */
  private modelRef(value: unknown, allowCandidate = true): { ref: string; label: string } {
    const v = String(value ?? '');
    if (v === 'stable') {
      if (!this.reader.modelList().some((m) => m.role === 'stable')) throw new ActionError('There is no stable model yet.');
      return { ref: 'stable', label: 'the stable model' };
    }
    const cand = /^candidate:(\d+)$/.exec(v);
    if (cand) {
      if (!allowCandidate) throw new ActionError('That model is already registered.');
      if (!this.reader.modelList().some((m) => m.id === Number(cand[1]) && m.role === 'candidate')) throw new ActionError(`Model ${cand[1]} is not a candidate.`);
      return { ref: v, label: `candidate ${cand[1]}` };
    }
    const ckpt = /^checkpoint:(\d+)$/.exec(v);
    if (ckpt) {
      const path = this.reader.checkpointPath(Number(ckpt[1]));
      if (!path) throw new ActionError(`There is no checkpoint ${ckpt[1]}.`);
      const c = this.reader.checkpoints().find((x) => x.id === Number(ckpt[1]))!;
      return { ref: path, label: `${c.run} at ${c.timesteps.toLocaleString('en')} decisions` };
    }
    const run = this.reader.runs().find((r) => r.name === v);
    if (!run) throw new ActionError('Choose a model: a training run, a checkpoint, a candidate or the stable model.');
    if (!run.checkpoints.length) throw new ActionError(`The run ${run.name} has no checkpoint yet.`);
    return { ref: run.name, label: `the newest checkpoint of ${run.name}` };
  }

  // ---------------------------------------------------------------- training

  async startTraining(body: Record<string, unknown>): Promise<ActionResult> {
    this.requirePython();
    const name = String(body.name ?? '').trim();
    if (!RUN_NAME.test(name)) throw new ActionError('A run name is 1 to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit.');
    if (this.reader.runs().some((r) => r.name === name) || existsSync(join(this.ctx.models, 'runs', name))) throw new ActionError(`A run named ${name} exists. A run name is used once: choose another, or resume that run.`, 409);
    const budget = this.ctx.gameProcessBudget;
    const envs = int(body.envs, 'Game processes', 1, budget), spares = int(body.spares, 'Spare processes', 0, 4);
    if (envs + spares > budget) throw new ActionError(`${envs} game processes and ${spares} spares are ${envs + spares}; this machine's limit is ${budget}.`);
    const timesteps = int(body.timesteps, 'Decisions to train', 1_000, 2_000_000_000);
    this.requireRoom(envs + spares, 'Training');
    const args = ['-m', 'pokebonk_rl.train', '--config', 'configs/training.yaml', '--name', name, '--timesteps', String(timesteps), '--set', `workers.envs=${envs}`, '--set', `workers.spares=${spares}`, ...this.pathOverrides()];
    const { job } = this.jobs.start({ kind: 'train', title: `training run ${name}`, args, run: name, gameProcesses: envs + spares, detached: true });
    return { ok: true, message: `Training ${name} started with ${envs} game process${envs === 1 ? '' : 'es'} and ${spares} spare${spares === 1 ? '' : 's'}.`, job };
  }

  /** Ask a running trainer to stop: it finishes the step it is in, writes a checkpoint and exits. */
  async stopTraining(body: Record<string, unknown>): Promise<ActionResult> {
    const run = this.reader.runs().find((r) => r.name === String(body.run ?? ''));
    if (!run) throw new ActionError('There is no such training run.');
    const job = this.jobs.running().find((j) => j.run === run.name && (j.kind === 'train' || j.kind === 'resume'));
    if (run.status !== 'running' && !job) throw new ActionError(`${run.name} is not training right now.`, 409);
    const dir = resolve(this.ctx.models, 'runs', run.name);
    if (!dir.startsWith(resolve(this.ctx.models, 'runs') + sep)) throw new ActionError('That run is outside the models folder.');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'STOP'), `requested from the dashboard at ${new Date().toISOString()}\n`);
    return { ok: true, message: `Stop requested. ${run.name} finishes its current step, saves a checkpoint and exits; it can be resumed from there.` };
  }

  async resumeTraining(body: Record<string, unknown>): Promise<ActionResult> {
    this.requirePython();
    const run = this.reader.runs().find((r) => r.name === String(body.run ?? ''));
    if (!run) throw new ActionError('There is no such training run.');
    if (run.status === 'running' || this.jobs.running().some((j) => j.run === run.name && j.kind !== 'evaluate')) throw new ActionError(`${run.name} is training right now.`, 409);
    if (!run.checkpoints.length) throw new ActionError(`${run.name} has no checkpoint to resume from.`, 409);
    const args = ['-m', 'pokebonk_rl.train', '--resume', run.name];
    if (body.timesteps != null && body.timesteps !== '') {
      const total = int(body.timesteps, 'The new total of decisions', run.timesteps + 1, 2_000_000_000);
      if (total < run.targetTimesteps) throw new ActionError(`The total can only be raised: ${run.name} is set to ${run.targetTimesteps.toLocaleString('en')} decisions.`);
      args.push('--timesteps', String(total));
    } else if (run.timesteps >= run.targetTimesteps) {
      throw new ActionError(`${run.name} has reached its ${run.targetTimesteps.toLocaleString('en')} decisions. Give a higher total to train further.`);
    }
    if (this.ctx.models !== resolve(REPO, 'models') || this.ctx.repo !== REPO) args.push('--models', this.ctx.models);
    const needed = run.workers.envs + run.workers.spares;
    this.requireRoom(needed, 'Resuming');
    const { job } = this.jobs.start({ kind: 'resume', title: `training run ${run.name} (resumed)`, args, run: run.name, gameProcesses: needed, detached: true });
    return { ok: true, message: `${run.name} resumes from its newest checkpoint at ${run.timesteps.toLocaleString('en')} decisions.`, job };
  }

  // ---------------------------------------------------------------- evaluation

  async evaluate(body: Record<string, unknown>): Promise<ActionResult> {
    this.requirePython();
    const model = this.modelRef(body.model);
    const args = ['-m', 'pokebonk_rl.evaluate', '--model', model.ref];
    let what = 'the held-out seeds, for a promotion verdict';
    if (body.seeds != null && body.seeds !== '') {
      const seeds = String(body.seeds).replace(/\s+/g, '');
      if (!SEEDS.test(seeds) || seeds.length > 200) throw new ActionError('Seeds are written like 1-30 or 1-5,9.');
      args.push('--seeds', seeds);
      what = `seeds ${seeds}`;
    }
    if (body.reference != null && body.reference !== '') {
      const reference = String(body.reference);
      const known = reference === 'none' || reference === 'stable' || this.reader.batches().some((b) => b.label === reference || String(b.id) === reference);
      if (!known) throw new ActionError('Compare with a stored batch, the stable model, or nothing.');
      args.push('--reference', reference);
    }
    if (body.stochastic === true) args.push('--stochastic');
    args.push(...this.pathOverrides());
    const envs = (await this.configDefaults())?.evaluation.envs ?? 5;
    this.requireRoom(envs, 'An evaluation');
    const { job } = this.jobs.start({ kind: 'evaluate', title: `evaluation of ${model.label}`, args, gameProcesses: envs, detached: true });
    return { ok: true, message: `Evaluating ${model.label} on ${what}.`, job };
  }

  // ---------------------------------------------------------------- the model registry

  private registry(...rest: string[]): string[] { return ['-m', 'pokebonk_rl.registry', '--database', this.ctx.database, '--models', this.ctx.models, ...rest]; }

  private async registryJob(kind: 'register' | 'promote' | 'rollback', title: string, args: string[], done: string): Promise<ActionResult> {
    const job = await this.jobs.runToEnd({ kind, title, args });
    const tail = this.jobs.logTail(job.id, 2000).trim().split('\n').at(-1) ?? '';
    if (job.state !== 'succeeded') return { ok: false, message: tail || `${title} did not finish (exit code ${job.exitCode}).`, job };
    return { ok: true, message: tail || done, job };
  }

  async register(body: Record<string, unknown>): Promise<ActionResult> {
    this.requirePython();
    const model = this.modelRef(body.model, false);
    if (model.ref === 'stable') throw new ActionError('The stable model is already registered.');
    return this.registryJob('register', `registering ${model.label}`, this.registry('register', '--model', model.ref), 'Registered as a candidate.');
  }

  async promote(body: Record<string, unknown>): Promise<ActionResult> {
    this.requirePython();
    const id = int(body.candidate, 'The candidate', 1, 1_000_000_000);
    const cand = this.reader.modelList().find((m) => m.id === id);
    if (!cand || cand.role !== 'candidate') throw new ActionError(`Model ${id} is not a candidate.`);
    if (body.confirm !== `promote ${id}`) throw new ActionError(`To promote, type "promote ${id}" exactly.`);
    if (!cand.verdict?.passed) throw new ActionError(`Candidate ${id} has no passed evaluation on the held-out seeds as its newest verdict. Evaluate it first.`, 409);
    return this.registryJob('promote', `promoting candidate ${id}`, this.registry('promote', '--candidate', String(id), '--yes', '--note', 'promoted from the dashboard'), `Candidate ${id} is now the stable model.`);
  }

  async rollback(body: Record<string, unknown>): Promise<ActionResult> {
    this.requirePython();
    const id = int(body.to, 'The model', 1, 1_000_000_000);
    const target = this.reader.modelList().find((m) => m.id === id);
    if (!target || target.role !== 'retired') throw new ActionError(`Model ${id} is not a retired stable model.`);
    if (body.confirm !== `roll back to ${id}`) throw new ActionError(`To roll back, type "roll back to ${id}" exactly.`);
    return this.registryJob('rollback', `rolling back to model ${id}`, this.registry('rollback', '--to', String(id), '--yes', '--note', 'rolled back from the dashboard'), `Model ${id} is the stable model again.`);
  }

  // ---------------------------------------------------------------- watching

  /** The arguments of a watch session (python -m pokebonk_rl.watch), after the same checks as the other actions. */
  watchArgs(body: Record<string, unknown>): { args: string[]; title: string } {
    this.requirePython();
    // An episode stored by an evaluation is watched again from its own model file and seed.
    let ref: string, label: string;
    if (body.episode != null) {
      const ep = this.reader.episode(int(body.episode, 'The episode', 1, 2_000_000_000));
      if (!ep?.replay) throw new ActionError('Only episodes played by a stored model in an evaluation can be watched again.');
      ref = ep.replay.model; label = `episode ${ep.id} (seed ${ep.seed})`;
      body = { ...body, seed: ep.seed, stochastic: !ep.replay.deterministic, species: ep.species, map: ep.map, tier: ep.tier };
    } else ({ ref, label } = this.modelRef(body.model));
    const seed = int(body.seed, 'The seed', 0, 4_294_967_295);
    const speed = body.speed == null ? 4 : int(body.speed, 'Speed', 0, 64);
    this.requireRoom(1, 'Watching');
    const args = ['-m', 'pokebonk_rl.watch', '--model', ref, '--seed', String(seed), '--speed', String(speed)];
    if (body.stochastic === true) args.push('--stochastic');
    if (body.species != null) args.push('--species', String(int(body.species, 'The Pokémon', 1, 2000)));
    if (typeof body.map === 'string' && /^[a-z0-9_-]{1,40}$/i.test(body.map)) args.push('--map', body.map);
    if (body.tier != null) args.push('--tier', String(int(body.tier, 'The tier', 0, 2)));
    args.push(...this.pathOverrides());
    return { args, title: `watching ${label} on seed ${seed}` };
  }
}
