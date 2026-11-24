/**
 * Worker process of the episode runner: one headless game environment (the browser shims are global to a process),
 * playing the episodes its parent hands it, one at a time. Started by src/runner/pool.ts with `child_process.fork`;
 * it is not meant to be run by hand.
 *
 * An episode that throws is reported with everything known about it and the worker exits: the parent records the
 * error and starts a fresh worker. Nothing is retried or skipped here.
 */
import { createEnvironment } from '../environment/index.ts';
import type { HeadlessGameEnvironment } from '../environment/GameEnvironment.ts';
import type { Policy } from '../environment/policies.ts';
import { batchMetadata, runEpisode } from './episode.ts';
import { makePolicy } from './policies.ts';
import type { FromWorker, ToWorker, WorkerInit } from './protocol.ts';

if (!process.send) { process.stderr.write('src/runner/worker.ts is started by the runner (scripts/run-episodes.ts), not by hand\n'); process.exit(2); }

const send = (m: FromWorker): Promise<void> => new Promise((done) => { process.send!(m, undefined, undefined, () => done()); });

let init: WorkerInit | null = null;
let env: HeadlessGameEnvironment | null = null;
let policy: Policy | null = null;
let played = 0, busy = false, currentSeed: number | null = null;

async function fail(e: unknown): Promise<never> {
  const err = e instanceof Error ? e : new Error(String(e));
  const details = (err as { details?: unknown }).details;
  await send({
    type: 'error', workerId: init?.workerId ?? -1, seed: currentSeed, name: err.name, message: err.message.split('\n')[0], stack: String(err.stack ?? err.message),
    details: details && typeof details === 'object' ? (JSON.parse(JSON.stringify(details)) as Record<string, unknown>) : null,
  });
  process.exit(1);
}

async function episode(seed: number): Promise<void> {
  if (!init || !env || !policy) throw new Error('worker: an episode was sent before init');
  if (busy) throw new Error(`worker: seed ${seed} was sent while seed ${currentSeed} is still being played`);
  busy = true; currentSeed = seed;
  if (init.faults?.throwSeeds?.includes(seed)) throw new Error(`injected fault: seed ${seed} is configured to throw (test only)`);
  if (init.faults?.hangSeeds?.includes(seed)) for (;;) { /* injected fault: block the event loop (test only) */ }
  const record = await runEpisode(env, policy, { seed }, { id: init.workerId, pid: process.pid, episode: ++played },
    (progress) => { void send({ type: 'progress', workerId: init!.workerId, progress }); });
  const metadata = played === 1 ? { metadata: batchMetadata(env.getMetadata()) } : {};
  // Free before the result leaves: the parent answers it with the next seed, which can arrive before the send callback runs.
  busy = false; currentSeed = null;
  await send({ type: 'episode', workerId: init.workerId, record, ...metadata });
}

process.on('message', (msg: ToWorker) => {
  void (async () => {
    if (msg.type === 'init') {
      init = msg;
      env = createEnvironment({ ...msg.env });
      policy = makePolicy(msg.policy, env, msg.policyOptions);
      await send({ type: 'ready', workerId: msg.workerId, pid: process.pid });
    } else if (msg.type === 'episode') {
      await episode(msg.seed);
    } else if (msg.type === 'shutdown') {
      try { await env?.close(); } catch { /* leaving anyway */ }
      process.exit(0);
    }
  })().catch(fail);
});
// (Unhandled promise rejections are not treated as failures: in a page they are console messages, and the browser
// shims record them as such: src/sim/browser.ts. Everything this file awaits is caught above.)
process.on('uncaughtException', (e) => { void fail(e); });
// The parent is gone: nothing to report to.
process.on('disconnect', () => process.exit(0));
