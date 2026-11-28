import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { arch, cpus, freemem, platform, release, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EpisodeStore } from '../storage/database.ts';
import type { BatchMetadata, EpisodeRecord, ErrorKind, ErrorRecord } from '../storage/records.ts';
import type { EpisodeProgress } from './episode.ts';
import { POLICY_NAMES, policyVersion, validatePolicyOptions } from './policies.ts';
import type { FromWorker, ToWorker, WorkerInit } from './protocol.ts';

/**
 * The unattended runner: a parent process that plays a list of seeds on K worker processes.
 *
 *   - one environment per worker process; the parent never loads the game and is the only writer of the database;
 *   - seeds are handed out one at a time; with the default `recycleAfter: 1` an episode is a function of its seed and
 *     the batch settings: which worker plays it, in which order and how many workers there are does not change it;
 *   - `recycleAfter` is how many episodes a worker process plays before a fresh one replaces it. The default is 1:
 *     EVERY EPISODE IN A FRESH PROCESS, about a second more per episode. A reused process does not replay an episode:
 *     the game's virtual wall clock keeps running from one episode to the next and its value changes play (the fifth
 *     dependence on process history found, 2026-11-25, on runs strong enough to last ten minutes in a zone:
 *     docs/environment.md §3). With a larger value an episode is still a real one, but its seed no longer names it;
 *   - a worker is also replaced as soon as it reports more than `recycleRssMB`;
 *   - an episode that throws is recorded in `errors` and its worker is replaced; a worker that delivers nothing for
 *     `episodeTimeoutSec` of wall time is killed and recorded; a worker that dies is recorded. The batch goes on.
 *     Nothing is retried: a failed seed stays failed and the batch ends with status `failed`.
 */

export interface BatchConfig {
  policy: string;
  /** The policy's own settings, stored with the batch (player: `{ plan }`, keys of the plan to replace). Default: none. */
  policyOptions?: Record<string, unknown>;
  /** Number of episodes; episode i plays seed `seed + i`. Ignored when `seeds` is given. */
  episodes: number;
  seed: number;
  /** Explicit seeds, in the order they are handed out. */
  seeds?: number[];
  workers: number;
  species: number;
  map: string;
  tier: number;
  ranked: boolean;
  /** Safety cap on the run clock in game seconds (0 = none): reaching it ends the episode as `truncated`. */
  maxGameTime: number;
  /** The rule against standing still (GameEnvironmentOptions.maxIdleGameTime); absent or 0: no such rule. */
  maxIdleGameTime?: number;
  /** The rule against going without a KO (GameEnvironmentOptions.maxKoGapGameTime); absent or 0: no such rule. */
  maxKoGapGameTime?: number;
  /** The opening's grace for that rule (GameEnvironmentOptions.koGapGraceGameTime); absent or 0: none. */
  koGapGraceGameTime?: number;
  /** Preset unlocked-v4: the item archive version (GameEnvironmentOptions.archive); absent: unlocked-v3. */
  archive?: string;
  /** Preset unlocked-v5: the account's build plan for the species (GameEnvironmentOptions.buildPlan); absent: none. */
  buildPlan?: string;
  hz: number;
  actionRepeat: number;
  /** Episodes a worker plays before it is replaced by a fresh process (memory growth). 1: every episode in a fresh process. */
  recycleAfter: number;
  /** A worker reporting more resident memory than this after an episode is replaced too. */
  recycleRssMB: number;
  /** Wall-clock seconds a worker may take for one episode (reset included) before it is killed. */
  episodeTimeoutSec: number;
  label: string | null;
  /** TEST ONLY (src/runner/protocol.ts). */
  faults?: WorkerInit['faults'];
}

export const DEFAULT_BATCH: BatchConfig = {
  policy: 'random', episodes: 1, seed: 1, workers: 1, species: 155, map: 'forest', tier: 0, ranked: true, maxGameTime: 0, hz: 60, actionRepeat: 3,
  recycleAfter: 1, recycleRssMB: 1500, episodeTimeoutSec: 5400, label: null,
};

export interface BatchHooks {
  /** Episodes, decisions and errors are written here as they arrive. Without it nothing is stored. */
  store?: EpisodeStore;
  onStart?(info: { batchId: number | null; seeds: number[]; policyVersion: string }): void;
  onMetadata?(metadata: BatchMetadata): void;
  onEpisode?(record: EpisodeRecord, episodeId: number | null): void;
  onError?(error: ErrorRecord): void;
  onWorker?(event: { workerId: number; pid: number | undefined; what: 'started' | 'recycled' | 'killed' | 'exited'; detail: string }): void;
  /** Aborting stops handing out seeds, kills the workers and ends the batch as `interrupted`. */
  signal?: AbortSignal;
}

export interface BatchResult {
  batchId: number | null;
  status: 'completed' | 'failed' | 'interrupted';
  policyVersion: string;
  seeds: number[];
  episodes: EpisodeRecord[];
  errors: ErrorRecord[];
  metadata: BatchMetadata | null;
  wallSeconds: number;
  /** Simulation steps of all episodes, and the same per second of batch wall time (resets, process starts and idle workers included). */
  simSteps: number;
  simStepsPerSecond: number;
  episodesPerHour: number;
  workersStarted: number;
  /** Largest resident memory any worker reported after an episode, in MB. */
  peakWorkerRssMB: number;
}

const WORKER_FILE = join(dirname(fileURLToPath(import.meta.url)), 'worker.ts');
/** Wall-clock seconds a new worker has to say it is ready. */
const START_TIMEOUT_SEC = 120;
/** Fields of the environment's metadata every worker of one batch must agree on. */
const MUST_MATCH = ['gameBuild', 'gameVersion', 'bundleSha256', 'shimHash', 'observationSchema', 'actionSchema', 'decisionSchema', 'snapshotSchema', 'profilePreset', 'ranked'] as const;

export function hostInfo(): Record<string, unknown> {
  const c = cpus();
  return { platform: platform(), release: release(), arch: arch(), cpu: c[0]?.model ?? 'unknown', logicalCpus: c.length, totalMemoryMB: Math.round(totalmem() / 1048576), freeMemoryMB: Math.round(freemem() / 1048576), node: process.version };
}

export function validateConfig(c: BatchConfig): void {
  const int = (v: number, min: number, what: string) => { if (!Number.isInteger(v) || v < min) throw new Error(`${what} must be an integer of at least ${min}, got ${v}`); };
  if (!POLICY_NAMES.includes(c.policy)) throw new Error(`unknown policy "${c.policy}": use one of ${POLICY_NAMES.join(', ')}`);
  validatePolicyOptions(c.policy, c.policyOptions ?? {});
  if (c.seeds) { if (!c.seeds.length) throw new Error('seeds: the list is empty'); for (const s of c.seeds) int(s, 0, 'a seed'); if (new Set(c.seeds).size !== c.seeds.length) throw new Error('seeds: the list has duplicates'); }
  else { int(c.episodes, 1, 'episodes'); int(c.seed, 0, 'seed'); }
  int(c.workers, 1, 'workers'); int(c.recycleAfter, 1, 'recycle-after'); int(c.species, 1, 'species'); int(c.tier, 0, 'tier'); int(c.hz, 20, 'hz'); int(c.actionRepeat, 1, 'action-repeat');
  if (!(c.maxGameTime >= 0)) throw new Error(`max-time must be 0 (none) or a positive number of game seconds, got ${c.maxGameTime}`);
  if (!(c.episodeTimeoutSec > 0)) throw new Error(`episode-timeout must be a positive number of seconds, got ${c.episodeTimeoutSec}`);
  if (!(c.recycleRssMB > 0)) throw new Error(`recycle-rss must be a positive number of MB, got ${c.recycleRssMB}`);
}

interface Slot {
  id: number;
  child: ChildProcess;
  ready: boolean;
  played: number;
  /** The seed being played, with its watchdog. */
  seed: number | null;
  timer: NodeJS.Timeout | null;
  seedStartedAt: number;
  progress: EpisodeProgress | null;
  /** Tail of what the process wrote to stderr / stdout: part of the details of an error. */
  output: string;
  /** Why the parent ended it, when it did. */
  ending: 'recycle' | 'done' | 'killed' | 'failed' | null;
}

export async function runBatch(config: BatchConfig, hooks: BatchHooks = {}): Promise<BatchResult> {
  validateConfig(config);
  const seeds = config.seeds ? [...config.seeds] : Array.from({ length: config.episodes }, (_v, i) => config.seed + i);
  const version = policyVersion(config.policy);
  const store = hooks.store;
  const t0 = performance.now();
  const now = () => new Date().toISOString();
  const batchId = store ? store.createBatch({
    label: config.label, policyName: config.policy, policyVersion: version, config: { ...config, seeds }, hz: config.hz, actionRepeat: config.actionRepeat,
    rewardVersion: null, host: hostInfo(), episodesPlanned: seeds.length, startedAt: now(),
  }) : null;
  hooks.onStart?.({ batchId, seeds, policyVersion: version });

  const queue = [...seeds];
  const episodes: EpisodeRecord[] = [], errors: ErrorRecord[] = [];
  const slots = new Set<Slot>();
  let metadata: BatchMetadata | null = null, workersStarted = 0, startFailures = 0, aborted = false, peakRss = 0;
  let finish!: () => void, abort!: (e: Error) => void;
  const done = new Promise<void>((res, rej) => { finish = res; abort = rej; });

  const recordError = (kind: ErrorKind, slot: Slot | null, seed: number | null, message: string, details: Record<string, unknown>): void => {
    const e: ErrorRecord = { kind, seed, workerId: slot?.id ?? null, message, details: { ...details, ...(slot ? { workerOutput: slot.output.slice(-4000), lastProgress: slot.progress, episodesPlayedByWorker: slot.played } : {}) }, occurredAt: now() };
    errors.push(e);
    if (store && batchId !== null) store.insertError(batchId, e);
    hooks.onError?.(e);
  };

  const maybeFinish = (): void => { if (slots.size === 0 && (queue.length === 0 || aborted)) finish(); };

  const assign = (slot: Slot): void => {
    if (aborted || queue.length === 0) { slot.ending = 'done'; send(slot, { type: 'shutdown' }); return; }
    const seed = queue.shift()!;
    slot.seed = seed; slot.progress = null; slot.seedStartedAt = performance.now();
    slot.timer = setTimeout(() => {
      // Deliberately a kill, not a request: a worker that hangs may be stuck in a loop that never yields.
      slot.ending = 'killed';
      recordError('worker-timeout', slot, seed, `seed ${seed}: no result after ${config.episodeTimeoutSec} s of wall time; the worker was killed`, { timeoutSec: config.episodeTimeoutSec });
      hooks.onWorker?.({ workerId: slot.id, pid: slot.child.pid, what: 'killed', detail: `seed ${seed} timed out` });
      slot.seed = null;
      slot.child.kill('SIGKILL');
    }, config.episodeTimeoutSec * 1000);
    send(slot, { type: 'episode', seed });
  };

  const send = (slot: Slot, msg: ToWorker): void => { if (slot.child.connected) slot.child.send(msg); };

  const spawn = (): void => {
    const id = ++workersStarted;
    // No inherited exec arguments: the worker is a plain `node worker.ts` (TypeScript by type stripping), whatever flags
    // the parent was started with (a test runner's, for one).
    const child = fork(WORKER_FILE, [], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const slot: Slot = { id, child, ready: false, played: 0, seed: null, timer: null, seedStartedAt: 0, progress: null, output: '', ending: null };
    slots.add(slot);
    const keep = (chunk: Buffer) => { slot.output = (slot.output + chunk.toString('utf8')).slice(-8000); };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const startTimer = setTimeout(() => { if (!slot.ready) { slot.ending = 'failed'; recordError('worker-start', slot, null, `worker ${id} was not ready after ${START_TIMEOUT_SEC} s`, {}); child.kill('SIGKILL'); } }, START_TIMEOUT_SEC * 1000);

    child.on('message', (raw) => {
      const msg = raw as FromWorker;
      try {
        if (msg.type === 'ready') { slot.ready = true; clearTimeout(startTimer); startFailures = 0; hooks.onWorker?.({ workerId: id, pid: child.pid, what: 'started', detail: '' }); assign(slot); }
        else if (msg.type === 'progress') slot.progress = msg.progress;
        else if (msg.type === 'episode') {
          if (slot.timer) clearTimeout(slot.timer);
          slot.timer = null; slot.seed = null; slot.played++;
          if (msg.metadata) {
            if (!metadata) { metadata = msg.metadata; if (store && batchId !== null) store.setBatchMetadata(batchId, metadata); hooks.onMetadata?.(metadata); }
            else {
              const differ = MUST_MATCH.filter((k) => metadata![k] !== msg.metadata![k]);
              if (differ.length) recordError('metadata-mismatch', slot, msg.record.seed, `worker ${id} runs a different environment than the batch's first worker (${differ.join(', ')})`, Object.fromEntries(differ.map((k) => [k, { batch: metadata![k], worker: msg.metadata![k] }])));
            }
          }
          const rec = msg.record;
          episodes.push(rec);
          peakRss = Math.max(peakRss, rec.worker.rssMB);
          const episodeId = store && batchId !== null ? store.insertEpisode(batchId, rec) : null;
          hooks.onEpisode?.(rec, episodeId);
          if (slot.played >= config.recycleAfter || rec.worker.rssMB > config.recycleRssMB) {
            slot.ending = queue.length && !aborted ? 'recycle' : 'done';
            if (slot.ending === 'recycle') hooks.onWorker?.({ workerId: id, pid: child.pid, what: 'recycled', detail: `after ${slot.played} episodes, ${rec.worker.rssMB} MB` });
            send(slot, { type: 'shutdown' });
          } else assign(slot);
        } else if (msg.type === 'error') {
          if (slot.timer) clearTimeout(slot.timer);
          slot.timer = null; slot.ending = 'failed';
          // A worker that fails before it is ready (its environment or policy could not be built) will fail again.
          if (!slot.ready) startFailures++;
          // The seed that is lost is the one this process was handed; the worker says which one it thought it was playing.
          recordError('episode-error', slot, slot.seed ?? msg.seed, `${msg.name}: ${msg.message}`, { name: msg.name, stack: msg.stack, environment: msg.details, seedReportedByWorker: msg.seed, policy: config.policy, species: config.species, map: config.map, tier: config.tier });
          slot.seed = null;
        }
      } catch (e) { abort(e as Error); }
    });

    child.on('exit', (code, signal) => {
      clearTimeout(startTimer);
      if (slot.timer) clearTimeout(slot.timer);
      slots.delete(slot);
      try {
        if (slot.ending === null) {
          // Nobody asked it to go. Whatever it was playing is lost, and said so.
          if (!slot.ready) startFailures++;
          recordError(slot.ready ? 'worker-exit' : 'worker-start', slot, slot.seed, `worker ${id} exited unexpectedly (code ${code}, signal ${signal})${slot.seed !== null ? ` while playing seed ${slot.seed}` : ''}`, { code, signal });
        }
        hooks.onWorker?.({ workerId: id, pid: child.pid, what: 'exited', detail: `code ${code}${signal ? `, signal ${signal}` : ''}${slot.ending ? ` (${slot.ending})` : ''}` });
        if (startFailures >= 3) { aborted = true; recordError('runner', null, null, 'three workers in a row failed to start: the batch is stopped', { remainingSeeds: [...queue] }); }
        if (!aborted && queue.length > 0) spawn();
        maybeFinish();
      } catch (e) { abort(e as Error); }
    });
    child.on('error', (e) => { slot.output += `\n[fork error] ${e.message}`; });

    send(slot, { type: 'init', workerId: id, policy: config.policy, policyOptions: config.policyOptions ?? {}, env: { hz: config.hz, actionRepeat: config.actionRepeat, maxGameTime: config.maxGameTime, maxIdleGameTime: config.maxIdleGameTime ?? 0, maxKoGapGameTime: config.maxKoGapGameTime ?? 0, koGapGraceGameTime: config.koGapGraceGameTime ?? 0, ...(config.archive != null ? { archive: config.archive } : {}), ...(config.buildPlan != null ? { buildPlan: config.buildPlan } : {}), species: config.species, map: config.map, tier: config.tier, ranked: config.ranked }, ...(config.faults ? { faults: config.faults } : {}) });
  };

  const onAbort = (): void => {
    aborted = true;
    for (const slot of slots) { slot.ending ??= 'killed'; if (slot.timer) clearTimeout(slot.timer); slot.child.kill('SIGKILL'); }
    maybeFinish();
  };
  if (hooks.signal?.aborted) aborted = true;
  hooks.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    if (!aborted) for (let i = 0; i < Math.min(config.workers, seeds.length); i++) spawn();
    maybeFinish();
    await done;
  } catch (e) {
    for (const slot of slots) { slot.ending ??= 'killed'; slot.child.kill('SIGKILL'); }
    recordError('runner', null, null, `the runner itself failed: ${(e as Error).message}`, { stack: String((e as Error).stack) });
    if (store && batchId !== null) store.finishBatch(batchId, { status: 'failed', finishedAt: now(), wallSeconds: (performance.now() - t0) / 1000 });
    throw e;
  } finally {
    hooks.signal?.removeEventListener('abort', onAbort);
  }

  const wallSeconds = (performance.now() - t0) / 1000;
  const status: BatchResult['status'] = aborted && hooks.signal?.aborted ? 'interrupted' : errors.length || episodes.length !== seeds.length ? 'failed' : 'completed';
  if (store && batchId !== null) store.finishBatch(batchId, { status, finishedAt: now(), wallSeconds });
  const simSteps = episodes.reduce((a, e) => a + e.simSteps, 0);
  return {
    batchId, status, policyVersion: version, seeds, episodes, errors, metadata, wallSeconds, simSteps,
    simStepsPerSecond: simSteps / wallSeconds, episodesPerHour: (episodes.length / wallSeconds) * 3600, workersStarted, peakWorkerRssMB: peakRss,
  };
}
