import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BATCH, runBatch, validateConfig } from '../../src/runner/pool.ts';
import type { BatchConfig } from '../../src/runner/pool.ts';
import { policyVersion } from '../../src/runner/policies.ts';
import { chosenId, defeated } from '../../src/runner/episode.ts';
import { EpisodeStore } from '../../src/storage/database.ts';
import type { EpisodeRecord } from '../../src/storage/records.ts';

// SLOW GROUP: the end-to-end tests start real worker processes, each of which boots the game headless (about 2 s) and
// plays short capped episodes. The parent (this process) never loads the game.

const dir = mkdtempSync(join(tmpdir(), 'pokebonk-runner-'));
const stores: EpisodeStore[] = [];
const open = (name: string): EpisodeStore => { const s = EpisodeStore.open(join(dir, name)); stores.push(s); return s; };
process.on('exit', () => { for (const s of stores) s.close(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* a temp folder left behind is not a test failure */ } });
const config = (over: Partial<BatchConfig>): BatchConfig => ({ ...DEFAULT_BATCH, policy: 'random', maxGameTime: 25, ...over });
/** What an episode is, without where and how fast it was played. */
const essence = (e: EpisodeRecord) => ({ seed: e.seed, kills: e.kills, gameTime: e.gameTime, steps: e.steps, simSteps: e.simSteps, level: e.level, endCause: e.endCause, decisions: e.decisions.map((d) => [d.serial, d.kind, d.chosenId, d.gameTime]), build: e.finalBuild });

test('configuration is validated before anything starts', () => {
  assert.doesNotThrow(() => validateConfig(config({})));
  assert.throws(() => validateConfig(config({ policy: 'clever' })), /unknown policy "clever"/);
  assert.throws(() => validateConfig(config({ workers: 0 })), /workers must be an integer of at least 1/);
  assert.throws(() => validateConfig(config({ episodes: 1.5 })), /episodes must be an integer/);
  assert.throws(() => validateConfig(config({ seeds: [3, 3] })), /duplicates/);
  assert.throws(() => validateConfig(config({ recycleAfter: 0 })), /recycle-after/);
  assert.throws(() => validateConfig(config({ episodeTimeoutSec: 0 })), /episode-timeout/);
  // A whole run of the current plan was measured at up to 2,026 s of wall time beside eleven others: a limit of 1,800 s
  // cut 4 of 100 runs of a batch, and not at random.
  assert.ok(DEFAULT_BATCH.episodeTimeoutSec >= 5400);
  assert.throws(() => validateConfig(config({ policyOptions: { tuning: {} } })), /policy "random" has no option "tuning"/);
  assert.throws(() => validateConfig(config({ policy: 'player', policyOptions: { speed: 2 } })), /policy "player" has no option "speed" \(it has: plan\)/);
  assert.throws(() => validateConfig(config({ policy: 'player', policyOptions: { plan: 5 } })), /must be an object/);
  assert.doesNotThrow(() => validateConfig(config({ policy: 'player', policyOptions: { plan: { cashHp: 0.4 } } })));
  assert.match(policyVersion('player'), /^\d+\+[0-9a-f]{12}$/);
  assert.equal(policyVersion('random'), policyVersion('random'));
  assert.notEqual(policyVersion('random'), policyVersion('player'));
});

test('episode summaries: the pick in words, and guardians beaten from the run\'s counters', () => {
  const d = { kind: 'levelup', method: 'showLevelUp', title: '', options: [{ id: 'upMove:m915', label: '', data: {} }, { id: 'newVit:vcursed', label: '', data: {} }], extras: {}, context: {}, serial: 1 } as const;
  assert.equal(chosenId(d as never, { type: 'choice', option: 0 }), 'upMove:m915');
  assert.equal(chosenId(d as never, { type: 'choice', extra: 'refresh' }), 'extra:refresh');
  assert.equal(chosenId(d as never, { type: 'choice', extra: 'banish', target: 1 }), 'extra:banish>newVit:vcursed');
  // The game counts guardians and legendaries in one figure, and the legendaries again on their own.
  assert.deepEqual(defeated({ guardiansDefeated: 4, legendariesDefeated: 1 }), { guardians: 3, legendaries: 1 });
  assert.deepEqual(defeated({ guardiansDefeated: 1, legendariesDefeated: 0 }), { guardians: 1, legendaries: 0 });
  assert.deepEqual(defeated({ guardiansDefeated: 0, legendariesDefeated: 0 }), { guardians: 0, legendaries: 0 });
});

test('end to end: two workers play five capped episodes into a database; a recycled worker and a second run with one worker give the same episodes', async () => {
  const store = open('e2e.sqlite');
  const workerEvents: string[] = [];
  // Five seeds on two workers that are replaced after two episodes: at least three worker processes.
  const two = await runBatch(config({ seed: 40, episodes: 5, workers: 2, recycleAfter: 2, label: 'e2e two workers' }), { store, onWorker: (w) => workerEvents.push(w.what) });
  assert.equal(two.status, 'completed');
  assert.deepEqual(two.errors, []);
  assert.deepEqual(two.episodes.map((e) => e.seed).sort((a, b) => a - b), [40, 41, 42, 43, 44]);
  assert.ok(two.workersStarted >= 3, `workers were recycled (started ${two.workersStarted})`);
  assert.ok(workerEvents.includes('recycled'));
  assert.ok(two.simSteps > 0 && two.simStepsPerSecond > 0 && two.episodesPerHour > 0 && two.peakWorkerRssMB > 100);
  for (const e of two.episodes) {
    assert.equal(e.truncated, true);
    assert.match(e.endCause, /^truncated: game time reached the cap of 25 s/);
    assert.ok(e.gameTime >= 25 && e.gameTime < 25.2);
    assert.equal(e.species, 155);
    assert.equal(e.map, 'forest');
    assert.equal(e.record, null);
    assert.deepEqual(e.blockedNetwork, [], 'no network attempt in the worker');
    assert.ok(e.worker.episode >= 1 && e.worker.episode <= 2, 'no worker played more than its two episodes');
    assert.ok(e.finalBuild.moves.length >= 1 && e.finalBuild.moves[0].name.length > 0 && e.finalBuild.startSpecies === 155);
    assert.equal(e.counters.kills, e.kills);
    assert.ok(e.counters.damageDealt >= 0 && e.counters.time > 0);
  }

  // The database has it all.
  const b = store.batch(two.batchId!)!;
  assert.deepEqual([b.status, b.policy_name, b.episodes_planned, b.episodes_done, b.error_count, b.hz, b.action_repeat, b.ranked, b.reward_version], ['completed', 'random', 5, 5, 0, 60, 3, 1, null]);
  assert.equal(b.policy_version, policyVersion('random'));
  assert.equal(b.game_build, two.metadata!.gameBuild);
  assert.match(String(b.bundle_sha256), /^[0-9a-f]{64}$/);
  assert.match(String(b.shim_hash), /^[0-9a-f]{64}$/);
  assert.ok(String(b.profile_preset).length > 0);
  assert.equal(JSON.parse(String(b.metadata_json)).offline.guardInstalled, true);
  assert.equal(JSON.parse(String(b.config_json)).workers, 2);
  const rows = store.episodes(two.batchId!);
  assert.deepEqual(rows.map((r) => r.seed), [40, 41, 42, 43, 44]);
  for (const r of rows) {
    const rec = two.episodes.find((e) => e.seed === r.seed)!;
    assert.deepEqual([r.kills, r.steps, r.sim_steps, r.level, r.decision_count, r.worker_id], [rec.kills, rec.steps, rec.simSteps, rec.level, rec.decisions.length, rec.worker.id]);
    assert.deepEqual(store.decisions(Number(r.id)).map((d) => [d.serial, d.kind, d.chosen_id]), rec.decisions.map((d) => [d.serial, d.kind, d.chosenId]));
  }
  assert.ok(two.episodes.some((e) => e.decisions.length > 0), 'twenty-five seconds are enough for a first level-up somewhere');

  // Same seeds, one worker, no recycling, nothing stored: the same episodes.
  const one = await runBatch(config({ seeds: [44, 42, 40], workers: 1, recycleAfter: 99 }));
  assert.equal(one.status, 'completed');
  assert.equal(one.batchId, null);
  assert.equal(one.workersStarted, 1);
  for (const e of one.episodes) assert.deepEqual(essence(e), essence(two.episodes.find((x) => x.seed === e.seed)!), `seed ${e.seed} does not depend on the worker that plays it`);
  store.close();
});

test('end to end: an episode that throws and a worker that hangs are recorded as errors, and the other seeds are still played', async () => {
  const store = open('faults.sqlite');
  const res = await runBatch(config({ seed: 60, episodes: 5, workers: 2, maxGameTime: 6, episodeTimeoutSec: 20, faults: { throwSeeds: [61], hangSeeds: [63] } }), { store });
  assert.equal(res.status, 'failed');
  assert.deepEqual(res.episodes.map((e) => e.seed).sort((a, b) => a - b), [60, 62, 64], 'the batch went on with fresh workers');
  assert.deepEqual(res.errors.map((e) => [e.kind, e.seed]).sort(), [['episode-error', 61], ['worker-timeout', 63]]);
  assert.ok(res.workersStarted >= 3, 'a failed worker is replaced while seeds are left');

  const b = store.batch(res.batchId!)!;
  assert.deepEqual([b.status, b.episodes_planned, b.episodes_done, b.error_count], ['failed', 5, 3, 2]);
  const errors = store.errors(res.batchId!);
  const thrown = errors.find((e) => e.kind === 'episode-error')!;
  assert.equal(thrown.seed, 61);
  assert.match(String(thrown.message), /injected fault: seed 61/);
  const details = JSON.parse(String(thrown.details_json));
  assert.match(details.stack, /worker\.ts/);
  assert.equal(details.policy, 'random');
  const hung = errors.find((e) => e.kind === 'worker-timeout')!;
  assert.equal(hung.seed, 63);
  assert.match(String(hung.message), /no result after 20 s/);
  assert.ok(Number(hung.worker_id) > 0);
  assert.deepEqual(store.episodes(res.batchId!).map((r) => r.seed), [60, 62, 64]);
  store.close();
});

test('end to end: a batch that is killed (SIGTERM) ends as interrupted in the database, not as running for ever', async () => {
  const path = join(dir, 'killed.sqlite');
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'run-episodes.ts');
  const child = spawn(process.execPath, [script, '--policy=random', '--episodes=2', '--seed=60', '--workers=1', '--max-time=600', `--db=${path}`, '--label=killed', '--quiet'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
  // The batch row exists once the runner names it; the worker is then still loading the game.
  await new Promise<void>((ok, bad) => {
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); if (/batch \d+/.test(out)) ok(); });
    child.on('exit', (code) => bad(new Error(`the runner stopped before it was killed (exit ${code}): ${err}`)));
    setTimeout(() => bad(new Error(`the runner did not start: ${out}${err}`)), 60000).unref();
  });
  const exited = new Promise<number | null>((ok) => child.on('exit', (code) => ok(code)));
  child.kill('SIGTERM');
  assert.equal(await exited, 130, err);
  assert.match(err, /interrupted \(SIGTERM\)/);
  const store = open('killed.sqlite');
  const batch = store.db.prepare('SELECT status, finished_at, episodes_done FROM batches').all() as { status: string; finished_at: string | null; episodes_done: number }[];
  assert.equal(batch.length, 1);
  assert.equal(batch[0].status, 'interrupted');
  assert.ok(batch[0].finished_at, 'the end of the batch was written');
  assert.equal(batch[0].episodes_done, 0);
});
