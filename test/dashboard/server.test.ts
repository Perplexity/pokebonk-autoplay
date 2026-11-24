import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createApp } from '../../dashboard/server/app.ts';
import type { App } from '../../dashboard/server/app.ts';
import type { ActionResult, Breakdowns, Curve, EpisodeDetail, EvaluationDetail, Meta, ModelsView, Overview, RunInfo } from '../../dashboard/shared/api.ts';
import { EpisodeStore } from '../../src/storage/database.ts';

// The dashboard's server against a database built here and a stand-in for the Python command lines: a script that
// writes down the arguments it was started with. No game process and no Python is started by these tests; what the
// real command lines do is tested where they live (python/tests).

const dir = mkdtempSync(join(tmpdir(), 'pokebonk-dashboard-'));
const database = join(dir, 'data', 'pokebonk.sqlite'), models = join(dir, 'models'), calls = join(dir, 'calls.jsonl'), fake = join(dir, 'fake-python.mjs');
const now = new Date().toISOString(), earlier = '2026-11-01T10:00:00.000Z';
const SHA = { stable: 'a'.repeat(64), passed: 'c'.repeat(64), unjudged: 'd'.repeat(64), retired: 'e'.repeat(64) };
let app: App, base = '';

writeFileSync(fake, `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_PYTHON_CALLS, JSON.stringify(args) + '\\n');
const say = (o) => process.stdout.write(typeof o === 'string' ? o + '\\n' : JSON.stringify(o) + '\\n');
if (args[0] === '-c') {
  say({ training: { envs: 5, spares: 2, totalTimesteps: 2000000, checkpointEvery: 100000, species: [150], rewardFile: 'reward-v2.yaml', device: 'cpu' },
        evaluation: { seeds: '900001-900050', species: 150, map: 'forest', tier: 0, envs: 5, metric: 'score_median', minRatio: 1, firstReference: 'heldout-x-random', promotionSeeds: '900001-900050' } });
} else if (args[1] === 'pokebonk_rl.watch') {
  say({ t: 'start', model: 'm', sha256: 'f'.repeat(64), run: 'alpha', timesteps: 1000, seed: 5, scenario: { species: 150, map: 'forest', tier: 0 }, deterministic: true, speed: 0 });
  say({ t: 'frame', time: 1, zone: 1, kills: 3, level: 2, hp: 90, maxHp: 100, x: 0, z: 0, phase: 'play', enemies: 1, near: [[1, 2, 0.5, 0]], boss: null, points: [], hazards: [], shots: [], decision: null, action: { move: 1, buttons: [], choice: null }, bounds: 100 });
  say({ t: 'end', kills: 3, score: 3, gameTime: 1, level: 2, zone: 1, endCause: 'died', steps: 20 });
} else if (args[1] === 'pokebonk_rl.registry') {
  say('the registry was asked to ' + args.slice(6).join(' '));
} else {
  say('started');
  await new Promise((done) => setTimeout(done, Number(process.env.FAKE_PYTHON_HOLD_MS ?? 100)));
}
`);

function build(): void {
  const store = EpisodeStore.open(database);
  const db = store.db;
  const batch = (label: string, policy: string, status: string, config: unknown) => Number(db.prepare(`INSERT INTO batches (started_at, finished_at, status, label, policy_name, policy_version, config_json, game_build,
    game_version, profile_preset, hz, action_repeat, reward_version, host_json, episodes_planned, wall_seconds) VALUES (?, ?, ?, ?, ?, 'v1', ?, 'buildx', '0.1.2', 'preset', 60, 3, 'v2', '{}', 3, 10)`)
    .run(earlier, status === 'running' ? null : earlier, status, label, policy, JSON.stringify(config)).lastInsertRowid);
  const episode = (batchId: number, seed: number, kills: number, over: { victory?: boolean; bonus?: number; cashed?: boolean; moves?: string[]; at?: string; cause?: string } = {}) => Number(db.prepare(`INSERT INTO episodes (batch_id, seed, species, final_species,
    map, tier, ranked, end_cause, end_how, terminated, truncated, victory, game_time, kills, overtime_started, overtime_bonus, overtime_rounds, overtime_cashed, level, zone, guardians_defeated, legendaries_defeated, seals_kept,
    steps, sim_steps, decision_count, wall_seconds, reset_seconds, final_build_json, counters_json, record_json, blocked_network, worker_id, worker_pid, worker_episode, worker_rss_mb, started_at, finished_at)
    VALUES (?, ?, 150, 150, 'forest', 0, 1, ?, 'died', 1, 0, ?, 100, ?, ?, ?, 0, ?, 10, 1, 0, 0, 0, 100, 300, 1, 5, 1, ?, ?, NULL, 0, 1, 1, 1, 500, ?, ?)`)
    .run(batchId, seed, over.cause ?? (over.victory ? 'won (victory)' : 'died'), over.victory ? 1 : 0, kills, over.bonus ? 1 : 0, over.bonus ?? 0, over.cashed ? 1 : 0,
      JSON.stringify({ level: 10, maxHp: 100, moves: (over.moves ?? ['tackle']).map((key) => ({ key, name: key, level: 2, type: 'normal', damageDone: 10, fusion: false })), vitamins: [{ key: 'calcium', level: 3 }], items: [], relics: [] }),
      JSON.stringify({ mapUse: 2, shopSold: 0, damageTaken: 5 }), over.at ?? earlier, over.at ?? earlier).lastInsertRowid);

  const scripted = batch('baseline-x-random', 'random', 'completed', { seeds: [1, 2, 3], species: 150, map: 'forest', tier: 0 });
  const ep1 = episode(scripted, 1, 100);
  episode(scripted, 2, 200, { bonus: 50, cashed: true, moves: ['tackle', 'swift'] });
  episode(scripted, 3, 300, { bonus: 999, cashed: false });
  db.prepare(`INSERT INTO decisions (episode_id, serial, step, game_time, zone, level, kind, method, options_json, context_json, mask_json, chosen_json, chosen_id) VALUES (?, 1, 5, 2.5, 1, 2, 'levelup', 'showLevelUp', ?, '{}', ?, ?, 'upMove:m1')`)
    .run(ep1, JSON.stringify([{ id: 'upMove:m1', label: 'Tackle +1' }, { id: 'newVit:v2', label: 'Calcium' }]), JSON.stringify({ options: [true, true] }), JSON.stringify({ type: 'choice', option: 0 }));

  const trainConfig = (total: number, envs: number, spares: number) => ({ total_timesteps: total, workers: { envs, spares }, device: 'cpu', scenarios: { species: [150], maps: ['forest'], tiers: [0] }, episode_seeds: { first: 1000000 } });
  const run = (name: string, total: number, envs: number, spares: number) => Number(db.prepare(`INSERT INTO training_runs (name, created_at, algorithm, config_json, reward_version, reward_json, observation_layout_hash, action_layout_hash, game_build, dir)
    VALUES (?, ?, 'MaskablePPO', ?, 'v2', ?, 'o', 'a', 'buildx', ?)`).run(name, earlier, JSON.stringify(trainConfig(total, envs, spares)), JSON.stringify({ version: 'v2', scale: 0.01, weights: { ko: 1, death: -100 } }), join(models, 'runs', name)).lastInsertRowid);
  const alpha = run('alpha', 1000, 1, 1), beta = run('beta', 5000, 8, 2);
  const alphaBatch = batch('train:alpha', 'ppo-train', 'completed', trainConfig(1000, 1, 1)), betaBatch = batch('train:beta', 'ppo-train', 'running', trainConfig(5000, 8, 2));
  const alphaSession = Number(db.prepare(`INSERT INTO training_sessions (run_id, batch_id, started_at, finished_at, status, start_timesteps, end_timesteps, host_json) VALUES (?, ?, '2026-11-01T10:00:00.000Z', '2026-11-01T10:00:10.000Z', 'completed', 0, 1000, '{}')`).run(alpha, alphaBatch).lastInsertRowid);
  const betaSession = Number(db.prepare(`INSERT INTO training_sessions (run_id, batch_id, started_at, status, start_timesteps, host_json) VALUES (?, ?, ?, 'running', 0, '{}')`).run(beta, betaBatch, now).lastInsertRowid);
  const checkpoint = (runId: number, session: number, name: string, t: number, kind: string, at: string, sha: string) => db.prepare('INSERT INTO checkpoints (run_id, session_id, created_at, kind, timesteps, episodes, path, sha256) VALUES (?, ?, ?, ?, ?, 2, ?, ?)')
    .run(runId, session, at, kind, t, join(models, 'runs', name, 'checkpoints', `ckpt_${String(t).padStart(12, '0')}`), sha);
  checkpoint(alpha, alphaSession, 'alpha', 500, 'periodic', '2026-11-01T10:00:05.000Z', 'b'.repeat(64));
  checkpoint(alpha, alphaSession, 'alpha', 1000, 'final', '2026-11-01T10:00:10.000Z', SHA.passed);
  checkpoint(beta, betaSession, 'beta', 100, 'periodic', now, 'f'.repeat(64));
  [[1000000, 10, 250], [1000001, 400, 500], [1000002, 20, 750], [1000003, 800, 1000]].forEach(([seed, kills, t]) => {
    const id = episode(alphaBatch, seed, kills);
    db.prepare(`INSERT INTO episode_rewards (episode_id, reward_version, total, components_json, raw_json, timesteps) VALUES (?, 'v2', ?, ?, '{}', ?)`).run(id, kills * 0.01 - 1, JSON.stringify({ ko: kills * 0.01, death: -1 }), t);
  });
  episode(betaBatch, 1000000, 5, { at: now });
  episode(betaBatch, 1000001, 999, { at: now, cause: 'idle: no KO and no movement for 30 s of game time' });

  const evalBatch = batch('eval:cccccccccccc', 'ppo', 'completed', { seeds: [1, 2, 3], scenario: { species: 150, map: 'forest', tier: 0 }, species: 150, map: 'forest', tier: 0 });
  episode(evalBatch, 1, 150); episode(evalBatch, 2, 260); episode(evalBatch, 3, 50, { victory: true });
  const evaluation = Number(db.prepare(`INSERT INTO evaluations (created_at, batch_id, model_path, model_sha256, run_id, timesteps, deterministic, seeds_json, scenario_json, summary_json, reference, comparison_json, passed)
    VALUES (?, ?, ?, ?, ?, 1000, 1, '[1,2,3]', '{"species":150,"map":"forest","tier":0}', '{"lost_to_errors":0}', ?, ?, 1)`)
    .run(earlier, evalBatch, join(models, 'runs', 'alpha', 'checkpoints', 'ckpt_000000001000'), SHA.passed, alpha, `batch ${scripted} (baseline-x-random)`,
      JSON.stringify({ ratio: 1.2, metric: 'score_median', min_ratio: 1, passed: true, verdict: true, per_seed_by_score: { wins: 2, losses: 1, ties: 0 } })).lastInsertRowid);

  const model = (role: string, sha: string, folder: string, evaluationId: number | null) => db.prepare('INSERT INTO models (role, created_at, path, sha256, run_id, timesteps, evaluation_id) VALUES (?, ?, ?, ?, ?, 1000, ?)')
    .run(role, earlier, join(models, folder), sha, alpha, evaluationId);
  model('stable', SHA.stable, 'stable/0001-aaaaaaaaaaaa', null);
  model('candidate', SHA.passed, 'candidates/0002-cccccccccccc', null);
  model('candidate', SHA.unjudged, 'candidates/0003-dddddddddddd', null);
  model('retired', SHA.retired, 'stable/0004-eeeeeeeeeeee', evaluation);
  store.close();

  for (const folder of ['stable/0001-aaaaaaaaaaaa', 'stable/0004-eeeeeeeeeeee', 'candidates/0002-cccccccccccc']) {
    mkdirSync(join(models, folder), { recursive: true });
    writeFileSync(join(models, folder, 'model.zip'), `the weights of ${folder}`);
    writeFileSync(join(models, folder, 'state.json'), JSON.stringify({ folder }));
  }
  writeFileSync(join(models, 'stable', 'current.json'), JSON.stringify({ model_id: 1, path: join(models, 'stable/0001-aaaaaaaaaaaa'), sha256: SHA.stable, promoted_at: earlier }));
  mkdirSync(join(models, 'runs', 'beta'), { recursive: true });
}

/** Every file under a folder with the hash of its content. */
function fingerprint(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => { for (const name of readdirSync(d)) { const p = join(d, name); if (statSync(p).isDirectory()) walk(p); else out[relative(root, p)] = createHash('sha256').update(readFileSync(p)).digest('hex'); } };
  walk(root);
  return out;
}

const get = async <T>(path: string): Promise<T> => { const r = await fetch(base + path); assert.equal(r.status, 200, `${path} answered ${r.status}`); return (await r.json()) as T; };
const post = async (path: string, body: unknown, headers: Record<string, string> = { 'X-Pokebonk-Dashboard': '1' }): Promise<ActionResult & { status: number }> => {
  const r = await fetch(`${base}/api/actions/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { ...((await r.json()) as ActionResult), status: r.status };
};
const recorded = (): string[][] => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);
const lastCall = (module: string): string[] => recorded().filter((c) => c[1] === module).at(-1) ?? [];
const settle = async (): Promise<void> => { for (let i = 0; i < 100 && app.jobs.running().length; i++) await new Promise((done) => setTimeout(done, 50)); };

before(async () => {
  build();
  process.env.FAKE_PYTHON_CALLS = calls;
  app = createApp({ repo: dir, database, models, python: process.execPath, pythonArgs: [fake], port: 0, dist: join(dir, 'not-built'), gameProcessBudget: 12 });
  base = `http://127.0.0.1:${await app.listen()}`;
});
after(async () => { await app.close(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* a temp folder left behind is not a test failure */ } });

test('the figures of the specification are served: totals, throughput, checkpoints, evaluation, status', async () => {
  const o = await get<Overview>('/api/overview');
  assert.equal(o.totals.trainingEpisodes, 6);
  assert.equal(o.totals.trainingSteps, 1100, 'alpha reached 1000 decisions, beta 100');
  assert.equal(o.totals.runs, 2);
  assert.equal(o.totals.scriptedEpisodes, 3);
  assert.equal(o.status.state, 'training', 'beta is marked running and showed life a moment ago');
  assert.match(o.status.headline, /Training beta: 100 of 5,000 decisions/);
  assert.equal(o.latestCheckpoint?.run, 'beta');
  assert.equal(o.stable?.id, 1);
  assert.deepEqual(o.candidates.map((m) => m.id).sort(), [2, 3]);
  assert.deepEqual(o.builds, [{ build: 'buildx', version: '0.1.2' }]);

  const runs = await get<RunInfo[]>('/api/runs');
  const alpha = runs.find((r) => r.name === 'alpha')!, beta = runs.find((r) => r.name === 'beta')!;
  assert.equal(alpha.status, 'completed');
  assert.equal(alpha.decisionsPerSecond, 100, '1000 decisions in 10 s');
  assert.equal(alpha.checkpoints.length, 2);
  assert.equal(beta.status, 'running');
  assert.deepEqual(beta.workers, { envs: 8, spares: 2 });

  const e = o.latestEvaluation!;
  // Scores 150, 260, 50: mean, median and best, and one of three runs completed.
  assert.deepEqual([e.summary.scoreMedian, Math.round(e.summary.scoreMean), e.summary.scoreMax, e.summary.completed], [150, 153, 260, 1]);
  // The reference on the same seeds: 100, 200 + 50 (overtime cashed), 300 (a bonus that was not cashed does not count).
  assert.deepEqual([e.referenceSummary?.scoreMedian, e.referenceSummary?.scoreMax], [250, 300]);
  assert.equal(e.passed, true);
  assert.equal(e.isVerdict, true);
});

test('a run\'s curve, the breakdowns and a stored episode', async () => {
  const c = await get<Curve>('/api/runs/alpha/curve');
  assert.equal(c.episodes, 4);
  assert.deepEqual(c.points.map((p) => [p.t, p.score]), [[250, 10], [500, 400], [750, 20], [1000, 800]]);
  assert.deepEqual(c.components, ['ko', 'death']);
  assert.equal(c.bins.reduce((n, b) => n + b.episodes, 0), 4);
  assert.deepEqual(c.references.map((r) => [r.policy, r.scoreMedian]), [['random', 250]]);
  assert.deepEqual(c.throughput.map((t) => t.decisionsPerSecond), [100, 100]);

  // A run ended for standing still is invalid: its 999 KOs are still its KOs, its score is 0.
  const beta = await get<Curve>('/api/runs/beta/curve');
  assert.deepEqual([beta.summary?.episodes, beta.summary?.invalid, beta.summary?.kosMax, beta.summary?.scoreMax], [2, 1, 999, 5]);
  assert.deepEqual(beta.points.map((p) => p.score).sort((x, y) => x - y), [0, 5]);
  assert.equal(c.summary?.invalid, 0);

  const b = await get<Breakdowns>('/api/breakdowns?scope=batch:1');
  assert.deepEqual(b.bySpecies.map((g) => [g.policy, g.summary.episodes]).sort(), [['model, evaluation', 3], ['model, while training', 6], ['random baseline', 3]]);
  assert.equal(b.byVersion[0].label, '0.1.2 (buildx)');
  const swift = b.choices.find((x) => x.key === 'swift')!, tackle = b.choices.find((x) => x.key === 'tackle')!;
  assert.deepEqual([swift.episodes, swift.scoreMedianWith, swift.scoreMedianWithout], [1, 250, 200], 'swift was held in the one episode that scored 250; the others scored 100 and 300');
  assert.deepEqual([tackle.episodes, tackle.scoreMedianWithout], [3, null]);
  assert.deepEqual(b.picks, [{ kind: 'levelup', chosen: 'upMove:m1', label: 'Tackle +1', times: 1, share: 1 }]);

  const ev = await get<EvaluationDetail>('/api/evaluations/1');
  assert.deepEqual(ev.rows.map((r) => [r.seed, r.score, r.referenceScore]), [[1, 150, 100], [2, 260, 250], [3, 50, 300]]);
  const ep = await get<EpisodeDetail>('/api/episodes/1');
  assert.equal(ep.timeline[0].chosen, 'Tackle +1');
  assert.equal(ep.replay, null, 'a scripted episode has no model file to play again');
  assert.equal((await get<EpisodeDetail>(`/api/episodes/${ev.rows[0].episodeId}`)).replay?.seed, 1);
});

test('the database cannot be written through the dashboard\'s connection', () => {
  const db = (app.reader as unknown as { open(): { exec(sql: string): void } }).open();
  assert.throws(() => db.exec('DELETE FROM episodes'), /readonly|read-only|query_only/i);
  assert.throws(() => db.exec("UPDATE models SET role = 'stable'"), /readonly|read-only|query_only/i);
});

test('only this machine, and only this page, is answered', async () => {
  const fromHost = (host: string) => new Promise<number>((done, fail) => {
    const r = request(`${base}/api/overview`, { headers: { Host: host } }, (res) => { res.resume(); done(res.statusCode ?? 0); });
    r.on('error', fail); r.end();
  });
  assert.equal(await fromHost('evil.example'), 403, 'a name that was rebound to this machine');
  assert.equal(await fromHost(new URL(base).host), 200);
  assert.equal((await post('train/stop', { run: 'beta' }, {})).status, 403, 'a post without the page\'s header');
  assert.equal((await post('train/stop', { run: 'beta' }, { 'X-Pokebonk-Dashboard': '1', Origin: 'https://evil.example' })).status, 403, 'a post from another site');
  assert.equal(existsSync(join(models, 'runs', 'beta', 'STOP')), false);
  const r = await fetch(`${base}/api/overview`);
  assert.equal(r.headers.get('access-control-allow-origin'), null, 'no other origin is ever allowed to read the answers');
});

test('training: start, stop and resume become the trainer\'s own command line, after the checks', async () => {
  // beta (8 + 2 game processes) is training: there is no room for another run of that size.
  let r = await post('train/start', { name: 'gamma', envs: 8, spares: 2, timesteps: 50000 });
  assert.equal(r.ok, false);
  assert.match(r.message, /needs 10 game processes; 10 of 12 are in use by training run beta/);
  assert.match((await post('train/start', { name: '../evil', envs: 1, spares: 0, timesteps: 50000 })).message, /A run name is/);
  assert.match((await post('train/start', { name: 'alpha', envs: 1, spares: 0, timesteps: 50000 })).message, /A run named alpha exists/);
  assert.match((await post('train/start', { name: 'gamma', envs: 12, spares: 4, timesteps: 50000 })).message, /this machine's limit is 12/);
  assert.match((await post('train/start', { name: 'gamma', envs: 1, spares: 0, timesteps: 5 })).message, /Decisions to train must be a whole number/);
  assert.deepEqual(lastCall('pokebonk_rl.train'), [], 'nothing was started by the refused requests');

  r = await post('train/start', { name: 'gamma', envs: 1, spares: 1, timesteps: 50000 });
  assert.equal(r.ok, true, r.message);
  await settle();
  assert.deepEqual(lastCall('pokebonk_rl.train'), ['-m', 'pokebonk_rl.train', '--config', 'configs/training.yaml', '--name', 'gamma', '--timesteps', '50000', '--set', 'workers.envs=1', '--set', 'workers.spares=1',
    '--set', `paths.database=${database}`, '--set', `paths.models=${models}`]);
  assert.equal(app.jobs.get(r.job!.id)?.state, 'succeeded');
  assert.match(app.jobs.logTail(r.job!.id), /started/);

  // Stop: the trainer's documented STOP file, in the run's own folder, and only for a run that is training.
  assert.match((await post('train/stop', { run: 'alpha' })).message, /alpha is not training right now/);
  assert.match((await post('train/stop', { run: '../../etc' })).message, /no such training run/);
  r = await post('train/stop', { run: 'beta' });
  assert.equal(r.ok, true, r.message);
  assert.equal(existsSync(join(models, 'runs', 'beta', 'STOP')), true);
  assert.equal((await get<RunInfo[]>('/api/runs')).find((x) => x.name === 'beta')!.stopRequested, true);

  // Resume: a finished run needs a higher total, and a run that is training cannot be resumed.
  assert.match((await post('train/resume', { run: 'beta' })).message, /beta is training right now/);
  assert.match((await post('train/resume', { run: 'alpha' })).message, /has reached its 1,000 decisions/);
  assert.match((await post('train/resume', { run: 'alpha', timesteps: 900 })).message, /The new total of decisions must be a whole number from 1,001/);
  r = await post('train/resume', { run: 'alpha', timesteps: 3000 });
  assert.equal(r.ok, true, r.message);
  await settle();
  assert.deepEqual(lastCall('pokebonk_rl.train'), ['-m', 'pokebonk_rl.train', '--resume', 'alpha', '--timesteps', '3000', '--models', models]);
});

test('evaluation: the model is named from what the database knows, never from a path in the request', async () => {
  const meta = await get<Meta>('/api/meta');
  assert.equal(meta.defaults?.evaluation.envs, 5);
  assert.ok(meta.modelChoices.some((c) => c.ref === 'stable') && meta.modelChoices.some((c) => c.ref === 'candidate:2') && meta.modelChoices.some((c) => c.ref === 'alpha'));
  assert.deepEqual(meta.references.map((x) => x.label), ['baseline-x-random']);

  for (const model of ['/etc/passwd', '../models/stable/0001-aaaaaaaaaaaa', 'candidate:99', 'checkpoint:99', 'nobody', '']) {
    const r = await post('evaluate', { model });
    assert.equal(r.ok, false, `"${model}" must be refused`);
  }
  assert.match((await post('evaluate', { model: 'alpha', seeds: '1-3; rm -rf /' })).message, /Seeds are written like/);
  assert.match((await post('evaluate', { model: 'alpha', reference: 'made-up' })).message, /Compare with a stored batch/);
  assert.deepEqual(lastCall('pokebonk_rl.evaluate'), []);

  // beta holds 10 of the 12 game processes: an evaluation (5) does not fit beside it.
  assert.match((await post('evaluate', { model: 'alpha' })).message, /An evaluation needs 5 game processes/);
  const db = new (await import('node:sqlite')).DatabaseSync(database);
  db.exec("UPDATE training_sessions SET status = 'interrupted', finished_at = started_at WHERE status = 'running'");
  db.close();

  let r = await post('evaluate', { model: 'checkpoint:1', seeds: '1-3', reference: 'baseline-x-random' });
  assert.equal(r.ok, true, r.message);
  await settle();
  assert.deepEqual(lastCall('pokebonk_rl.evaluate').slice(0, 8), ['-m', 'pokebonk_rl.evaluate', '--model', join(models, 'runs', 'alpha', 'checkpoints', 'ckpt_000000000500'), '--seeds', '1-3', '--reference', 'baseline-x-random']);
  r = await post('evaluate', { model: 'candidate:2' });
  assert.equal(r.ok, true, r.message);
  await settle();
  assert.deepEqual(lastCall('pokebonk_rl.evaluate').slice(0, 4), ['-m', 'pokebonk_rl.evaluate', '--model', 'candidate:2'], 'no seeds and no reference: the promotion rule decides both');
});

test('promotion and rollback need the typed words and a passed verdict, and nothing here touches a stable model\'s files', async () => {
  const before = fingerprint(join(models, 'stable'));
  const registry = () => recorded().filter((c) => c[1] === 'pokebonk_rl.registry').map((c) => c.slice(6));

  assert.match((await post('models/promote', { candidate: 2 })).message, /type "promote 2" exactly/);
  assert.match((await post('models/promote', { candidate: 2, confirm: 'promote 3' })).message, /type "promote 2" exactly/);
  assert.match((await post('models/promote', { candidate: 3, confirm: 'promote 3' })).message, /no passed evaluation/);
  assert.match((await post('models/promote', { candidate: 1, confirm: 'promote 1' })).message, /Model 1 is not a candidate/);
  assert.match((await post('models/rollback', { to: 4 })).message, /type "roll back to 4" exactly/);
  assert.match((await post('models/rollback', { to: 2, confirm: 'roll back to 2' })).message, /not a retired stable model/);
  assert.match((await post('models/register', { model: 'stable' })).message, /already registered/);
  assert.deepEqual(registry(), [], 'no refused request reached the registry');

  let r = await post('models/promote', { candidate: 2, confirm: 'promote 2' });
  assert.equal(r.ok, true, r.message);
  r = await post('models/rollback', { to: 4, confirm: 'roll back to 4' });
  assert.equal(r.ok, true, r.message);
  r = await post('models/register', { model: 'checkpoint:2' });
  assert.equal(r.ok, true, r.message);
  // The dashboard's whole part in each of them: the registry's command, with its own --yes.
  assert.deepEqual(registry(), [
    ['promote', '--candidate', '2', '--yes', '--note', 'promoted from the dashboard'],
    ['rollback', '--to', '4', '--yes', '--note', 'rolled back from the dashboard'],
    ['register', '--model', join(models, 'runs', 'alpha', 'checkpoints', 'ckpt_000000001000')],
  ]);

  // Every page and every button has been used by now. The stable folders are byte for byte what they were, and the
  // only file that appeared anywhere under models/ is the STOP file of the run that was asked to stop.
  for (const path of ['/api/models', '/api/overview', '/api/history', '/api/breakdowns', '/api/evaluations', '/api/runs']) await get(path);
  assert.deepEqual(fingerprint(join(models, 'stable')), before);
  const view = await get<ModelsView>('/api/models');
  assert.equal(view.stable?.id, 1);
  assert.deepEqual(view.stableFiles.map((f) => f.name).sort(), ['model.zip', 'state.json']);
  assert.deepEqual(Object.keys(fingerprint(models)).filter((p) => !p.startsWith('stable') && !p.startsWith('candidates')), [join('runs', 'beta', 'STOP')]);
});

test('a watched session is passed on to the page line by line', async () => {
  assert.match((await post('watch/start', { model: 'alpha', seed: -1 })).message, /The seed must be a whole number/);
  assert.match((await post('watch/start', { episode: 1 })).message, /Only episodes played by a stored model/);
  const r = await post('watch/start', { model: 'alpha', seed: 5, speed: 0 });
  assert.equal(r.ok, true, r.message);
  await settle();
  assert.deepEqual(lastCall('pokebonk_rl.watch').slice(0, 8), ['-m', 'pokebonk_rl.watch', '--model', 'alpha', '--seed', '5', '--speed', '0']);
  // A page that starts listening afterwards still learns what was played and how it ended.
  const stream = await fetch(`${base}/api/watch/stream`);
  const reader = stream.body!.getReader();
  let text = '';
  for (let i = 0; i < 20 && !text.includes('"t":"closed"'); i++) text += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.match(text, /"t":"start".*"seed":5/);
  assert.match(text, /"t":"closed"/);
  const state = await get<{ active: boolean; ended: { kills: number } | null }>('/api/watch');
  assert.deepEqual([state.active, state.ended?.kills], [false, 3]);
});
