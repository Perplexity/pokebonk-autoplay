import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { EpisodeStore, SCHEMA_VERSION, loadMigrations } from '../../src/storage/database.ts';
import type { BatchInput, BatchMetadata, EpisodeRecord, ErrorRecord } from '../../src/storage/records.ts';
import { NO_PRESET, groupByPreset, lifecycleEnd, stat, summarize } from '../../src/runner/report.ts';
import type { EpisodeRow, Wake } from '../../src/runner/report.ts';

// The episode database on a temporary file: no game is loaded here.

function tempDb(): { path: string; dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pokebonk-storage-'));
  return { path: join(dir, 'test.sqlite'), dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const BATCH: BatchInput = {
  label: 'unit test', policyName: 'heuristic', policyVersion: '1+abc', config: { episodes: 2, seed: 5, workers: 2 }, hz: 60, actionRepeat: 3, rewardVersion: null,
  host: { platform: 'test', logicalCpus: 12 }, episodesPlanned: 2, startedAt: '2026-01-01T00:00:00.000Z',
};
const METADATA: BatchMetadata = {
  gameBuild: 'mwsewi0r', gameVersion: '0.10.26', bundleSha256: 'a'.repeat(64), shimHash: 'b'.repeat(64), observationSchema: 1, actionSchema: 1, decisionSchema: 1, snapshotSchema: 1,
  profilePreset: 'unlocked-v2', ranked: true, full: { game: { build: 'mwsewi0r' }, instrumentation: ['x'] },
};
function episode(seed: number, over: Partial<EpisodeRecord> = {}): EpisodeRecord {
  return {
    seed, species: 155, finalSpecies: 156, map: 'forest', tier: 0, ranked: true, terminated: true, truncated: false, endCause: 'died', endHow: 'died', victory: false,
    gameTime: 375.2, kills: 1016, overtime: { started: false, bonus: 0, rounds: 0, cashed: false }, level: 25, zone: 2, guardiansDefeated: 1, legendariesDefeated: 0, sealsKept: 0,
    steps: 7583, simSteps: 23344, wallSeconds: 21.1, resetSeconds: 1.6,
    finalBuild: {
      species: 156, startSpecies: 155, evoStage: 1, passive: 'heat-haze', level: 25, maxHp: 197, moveSlots: 4,
      moves: [{ slot: 0, key: 'temper-flare', id: 915, name: 'Temper Flare', level: 8, type: 'fire', arch: 'cone', cls: 'physical', damageDone: 123456, fusion: false, linked: null }],
      vitaminSlots: 5, vitamins: [{ key: 'iron', level: 2 }], items: [{ key: 'max-elixir', count: 1 }], relics: [], refreshes: 7, skips: 9, banishes: 8, revives: 1, stats: { damage: 1.3 },
    },
    counters: { kills: 1016, damageDealt: 250000, damageTaken: 499, hits: 10 },
    record: { victory: false, kills: 1016, bosses: 1, end: { how: 'died', by: 'boss' } }, blockedNetwork: [],
    decisions: [
      { serial: 1, step: 600, gameTime: 29.8, zone: 1, level: 2, kind: 'levelup', method: 'showLevelUp', options: [{ id: 'newMove:m915', label: 'm915', data: { kind: 'newMove', id: 915 } }, { id: 'newVit:viron', label: 'viron', data: { kind: 'newVit', vit: 'iron' } }], context: { rerolls: 8 }, mask: { phase: 'choice', options: [true, true], extras: { refresh: true } }, chosen: { type: 'choice', option: 0 }, chosenId: 'newMove:m915' },
      { serial: 2, step: 5240, gameTime: 262.2, zone: 1, level: 18, kind: 'seals', method: 'showSeals', options: [{ id: 'none', label: 'wake without seals', data: { seals: [] } }], context: { species: 55 }, mask: { phase: 'choice', options: [true], extras: { decline: true } }, chosen: { type: 'choice', extra: 'decline' }, chosenId: 'extra:decline' },
    ],
    worker: { id: 3, pid: 4242, episode: 2, rssMB: 640 }, startedAt: '2026-01-01T00:00:01.000Z', finishedAt: '2026-01-01T00:00:23.000Z',
    ...over,
  };
}
const ERROR: ErrorRecord = { kind: 'episode-error', seed: 6, workerId: 2, message: 'UnknownSituationError: unhandled dialog', details: { stack: 'at x', environment: { seed: 6, step: 91 } }, occurredAt: '2026-01-01T00:00:30.000Z' };

test('a new database gets the current schema, recorded in schema_version, and is reopened without migrating again', () => {
  const t = tempDb();
  try {
    const store = EpisodeStore.open(t.path);
    assert.equal(store.schemaVersion(), SCHEMA_VERSION);
    const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    for (const name of ['batches', 'decisions', 'episodes', 'errors', 'schema_version']) assert.ok(tables.includes(name), `table ${name}`);
    const applied = store.db.prepare('SELECT version, name, applied_at FROM schema_version ORDER BY version').all() as { version: number; name: string; applied_at: string }[];
    assert.deepEqual(applied.map((r) => r.version), loadMigrations().map((m) => m.version));
    assert.match(applied[0].applied_at, /^\d{4}-\d\d-\d\dT/);
    store.close();
    const again = EpisodeStore.open(t.path);
    assert.equal((again.db.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as { n: number }).n, applied.length);
    again.close();
  } finally { t.done(); }
});

test('a batch, its metadata, an episode with its decisions and an error are stored and read back', () => {
  const t = tempDb();
  try {
    const store = EpisodeStore.open(t.path);
    const batchId = store.createBatch(BATCH);
    let b = store.batch(batchId)!;
    assert.equal(b.status, 'running');
    assert.equal(b.game_build, null, 'the build is not known before a worker has loaded the game');
    assert.equal(b.reward_version, null);
    assert.deepEqual(JSON.parse(String(b.config_json)), BATCH.config);

    store.setBatchMetadata(batchId, METADATA);
    const episodeId = store.insertEpisode(batchId, episode(5));
    store.insertError(batchId, ERROR);
    store.finishBatch(batchId, { status: 'failed', finishedAt: '2026-01-01T00:01:00.000Z', wallSeconds: 60 });

    b = store.batch(batchId)!;
    assert.deepEqual([b.status, b.game_build, b.game_version, b.profile_preset, b.observation_schema, b.action_schema, b.decision_schema, b.hz, b.action_repeat, b.ranked, b.episodes_planned, b.episodes_done, b.error_count, b.wall_seconds],
      ['failed', 'mwsewi0r', '0.10.26', 'unlocked-v2', 1, 1, 1, 60, 3, 1, 2, 1, 1, 60]);
    assert.equal(b.bundle_sha256, METADATA.bundleSha256);
    assert.equal(b.shim_hash, METADATA.shimHash);
    assert.deepEqual(JSON.parse(String(b.metadata_json)), METADATA.full);

    const [e] = store.episodes(batchId);
    assert.equal(e.id, episodeId);
    assert.deepEqual([e.seed, e.species, e.final_species, e.map, e.tier, e.ranked, e.end_cause, e.end_how, e.victory, e.kills, e.level, e.zone, e.guardians_defeated, e.seals_kept, e.steps, e.sim_steps, e.decision_count, e.blocked_network, e.worker_id],
      [5, 155, 156, 'forest', 0, 1, 'died', 'died', 0, 1016, 25, 2, 1, 0, 7583, 23344, 2, 0, 3]);
    assert.equal(e.game_time, 375.2);
    assert.deepEqual(JSON.parse(String(e.final_build_json)).moves[0], { slot: 0, key: 'temper-flare', id: 915, name: 'Temper Flare', level: 8, type: 'fire', arch: 'cone', cls: 'physical', damageDone: 123456, fusion: false, linked: null });
    assert.deepEqual(JSON.parse(String(e.final_build_json)).vitamins, [{ key: 'iron', level: 2 }]);
    assert.equal(JSON.parse(String(e.counters_json)).damageTaken, 499);
    assert.equal(JSON.parse(String(e.record_json)).end.by, 'boss');

    const ds = store.decisions(episodeId);
    assert.deepEqual(ds.map((d) => [d.serial, d.kind, d.zone, d.level, d.chosen_id]), [[1, 'levelup', 1, 2, 'newMove:m915'], [2, 'seals', 1, 18, 'extra:decline']]);
    assert.deepEqual(JSON.parse(String(ds[0].options_json))[1].data, { kind: 'newVit', vit: 'iron' });
    assert.deepEqual(JSON.parse(String(ds[1].chosen_json)), { type: 'choice', extra: 'decline' });

    const [err] = store.errors(batchId);
    assert.deepEqual([err.kind, err.seed, err.worker_id, err.episode_id, err.message], ['episode-error', 6, 2, null, ERROR.message]);
    assert.equal(JSON.parse(String(err.details_json)).environment.step, 91);
    store.close();
  } finally { t.done(); }
});

test('an episode is stored atomically: a second episode with the same seed in the batch is refused and leaves nothing behind', () => {
  const t = tempDb();
  try {
    const store = EpisodeStore.open(t.path);
    const batchId = store.createBatch(BATCH);
    store.insertEpisode(batchId, episode(5));
    assert.throws(() => store.insertEpisode(batchId, episode(5)), /UNIQUE/);
    // A decision that cannot be stored (duplicate serial) takes its episode with it.
    const bad = episode(6);
    bad.decisions[1].serial = 1;
    assert.throws(() => store.insertEpisode(batchId, bad), /UNIQUE/);
    assert.equal(store.episodes(batchId).length, 1);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n, 2);
    assert.equal(store.batch(batchId)!.episodes_done, 1);
    // The same seed in another batch is fine.
    const other = store.createBatch(BATCH);
    store.insertEpisode(other, episode(5, { truncated: true, terminated: false, endCause: 'truncated: game time reached the cap of 60 s', endHow: null, record: null }));
    assert.equal(store.episodes(other)[0].record_json, null);
    // Foreign keys are enforced.
    assert.throws(() => store.insertEpisode(9999, episode(7)), /FOREIGN KEY/);
    store.close();
  } finally { t.done(); }
});

test('migrations: applied in order, each in a transaction; a database from newer code is refused', () => {
  const t = tempDb();
  try {
    const real = loadMigrations();
    const extra = [...real, { version: real.length + 1, name: 'add_note', sql: 'ALTER TABLE batches ADD COLUMN note TEXT;' }];
    EpisodeStore.open(t.path).close();
    const upgraded = EpisodeStore.open(t.path, { migrations: extra });
    assert.equal(upgraded.schemaVersion(), real.length + 1);
    const id = upgraded.createBatch(BATCH);
    upgraded.db.prepare('UPDATE batches SET note = ? WHERE id = ?').run('kept', id);
    upgraded.close();
    assert.throws(() => EpisodeStore.open(t.path), /schema version \d+, this code knows up to/);

    // A migration that fails changes nothing and names itself.
    const t2 = tempDb();
    try {
      const broken = [...real, { version: real.length + 1, name: 'broken', sql: 'CREATE TABLE extra (a INTEGER); INSERT INTO no_such_table VALUES (1);' }];
      assert.throws(() => EpisodeStore.open(t2.path, { migrations: broken }), /migration \d+_broken failed/);
      const raw = new DatabaseSync(t2.path);
      assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'extra'").get() as { n: number }).n, 0);
      assert.equal((raw.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v, real.length);
      raw.close();
    } finally { t2.done(); }
  } finally { t.done(); }
});

test('summary statistics of a batch: mean, median, min, max, zones, guardians and causes of end', () => {
  assert.deepEqual(stat([4, 1, 3, 2]), { n: 4, mean: 2.5, median: 2.5, min: 1, max: 4 });
  assert.deepEqual(stat([5, 1, 3]), { n: 3, mean: 3, median: 3, min: 1, max: 5 });
  assert.equal(stat([]).n, 0);
  const row = (o: Partial<EpisodeRow>): EpisodeRow => ({ seed: 1, kills: 100, game_time: 60, level: 5, zone: 1, guardians_defeated: 0, legendaries_defeated: 0, end_cause: 'died', victory: 0, overtime_started: 0, overtime_bonus: 0, overtime_cashed: 0, sim_steps: 3600, wall_seconds: 3, ...o });
  const s = summarize([
    row({}), row({ kills: 300, zone: 2, guardians_defeated: 1 }),
    row({ kills: 1000, zone: 4, guardians_defeated: 3, legendaries_defeated: 1, end_cause: 'won (victory), overtime cashed', victory: 1, overtime_started: 1, overtime_bonus: 500, overtime_cashed: 1 }),
    row({ kills: 200, zone: 4, guardians_defeated: 3, end_cause: 'won (victory), overtime lost', victory: 1, overtime_started: 1, overtime_bonus: 900 }),
    row({ kills: 50, end_cause: 'truncated: game time reached the cap of 60 s' }),
  ]);
  assert.equal(s.episodes, 5);
  assert.deepEqual([s.kills.mean, s.kills.median, s.kills.min, s.kills.max], [330, 200, 50, 1000]);
  assert.equal(s.killsWithBonus.max, 1500, 'a cashed bonus counts, a lost one does not');
  assert.equal(s.killsWithBonus.mean, 430);
  assert.deepEqual(s.reachedZone, { 1: 2, 2: 1, 4: 2 });
  assert.deepEqual(s.beatGuardians, { 0: 2, 1: 1, 3: 2 });
  assert.deepEqual([s.legendaries, s.overtimeStarted, s.overtimeCashed, s.victories], [1, 2, 1, 2]);
  assert.deepEqual(s.causes, { died: 2, 'won (victory), overtime cashed': 1, 'won (victory), overtime lost': 1, truncated: 1 });
});

test('where an episode ended in the lifecycle: the fight it was lost in, or before the wake / after the fall', () => {
  const row = (o: Partial<EpisodeRow>) => ({ end_cause: 'died', victory: 0, zone: 1, guardians_defeated: 0, legendaries_defeated: 0, ...o });
  const wake = (zone: number): Wake => ({ zone, gameTime: zone * 100, level: zone * 10 });
  assert.equal(lifecycleEnd(row({}), []), 'fainted in zone 1 before waking the zone-1 guardian');
  assert.equal(lifecycleEnd(row({}), [wake(1)]), 'fainted fighting the zone-1 guardian');
  assert.equal(lifecycleEnd(row({ guardians_defeated: 1 }), [wake(1)]), 'fainted in zone 1 after the zone-1 guardian fell, before the portal');
  assert.equal(lifecycleEnd(row({ zone: 2, guardians_defeated: 1 }), [wake(1)]), 'fainted in zone 2 before waking the zone-2 guardian');
  assert.equal(lifecycleEnd(row({ zone: 2, guardians_defeated: 1 }), [wake(1), wake(2)]), 'fainted fighting the zone-2 guardian');
  assert.equal(lifecycleEnd(row({ zone: 4, guardians_defeated: 3 }), [wake(1), wake(2), wake(3)]), 'fainted in zone 4 before waking the legendary');
  assert.equal(lifecycleEnd(row({ zone: 4, guardians_defeated: 3 }), [wake(1), wake(2), wake(3), wake(4)]), 'fainted fighting the legendary');
  assert.equal(lifecycleEnd(row({ zone: 4, guardians_defeated: 3, legendaries_defeated: 1, victory: 1, end_cause: 'won (victory), overtime lost' }), [wake(1), wake(2), wake(3), wake(4)]), 'won (victory), overtime lost');
  assert.equal(lifecycleEnd(row({ end_cause: 'truncated: game time reached the cap of 60 s' }), [wake(1)]), 'truncated');
});

test('reports keep account presets apart: batches are grouped by the preset stored with them', () => {
  const batches = [{ id: 1, profile_preset: 'unlocked-v2' }, { id: 2, profile_preset: 'unlocked-v3' }, { id: 3, profile_preset: 'unlocked-v2' }, { id: 4, profile_preset: null }, { id: 5 }];
  assert.deepEqual(groupByPreset(batches).map((g) => [g.preset, g.batches.map((b) => b.id)]), [['unlocked-v2', [1, 3]], ['unlocked-v3', [2]], [NO_PRESET, [4, 5]]]);
  assert.deepEqual(groupByPreset([]), []);
  assert.equal(groupByPreset([{ profile_preset: 'unlocked-v3' }, { profile_preset: 'unlocked-v3' }]).length, 1, 'one preset: one group, nothing to keep apart');
});

test('the report script refuses to print batches of different presets together unless told to', () => {
  const t = tempDb();
  try {
    const store = EpisodeStore.open(t.path);
    for (const preset of ['unlocked-v2', 'unlocked-v3']) {
      const id = store.createBatch(BATCH);
      store.setBatchMetadata(id, { ...METADATA, profilePreset: preset });
      store.insertEpisode(id, episode(5));
      store.finishBatch(id, { status: 'completed', finishedAt: '2026-01-01T00:01:00.000Z', wallSeconds: 60 });
    }
    store.close();
    const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'baseline-report.ts');
    const run = (...args: string[]) => spawnSync(process.execPath, [script, `--db=${t.path}`, ...args], { encoding: 'utf8' });
    const mixed = run();
    assert.equal(mixed.status, 2);
    assert.match(mixed.stderr, /2 account presets \(unlocked-v2: batches 1; unlocked-v3: batches 2\)/);
    assert.equal(mixed.stdout, '', 'nothing is printed');
    const one = run('--preset=unlocked-v3', '--markdown');
    assert.equal(one.status, 0, one.stderr);
    assert.match(one.stdout, /Account preset unlocked-v3/);
    assert.doesNotMatch(one.stdout, /unlocked-v2/);
    assert.match(one.stdout, /\| 2 unit test \| heuristic 1\+abc \|.*\| unlocked-v3 \| 1\/2 \| 1016 \/ 1016 \/ 1016 \/ 1016 \|/);
    const all = run('--all-presets');
    assert.equal(all.status, 0, all.stderr);
    assert.match(all.stdout, /=== Account preset unlocked-v2 ===[\s\S]*preset unlocked-v2[\s\S]*=== Account preset unlocked-v3 ===[\s\S]*preset unlocked-v3/);
  } finally { t.done(); }
});

test('comparing two batches: identical episodes, a difference in one column or one decision, and batches that cannot be compared', () => {
  const t = tempDb();
  try {
    const store = EpisodeStore.open(t.path);
    const batch = (m: Partial<BatchMetadata>, eps: EpisodeRecord[], cfg: Record<string, unknown> = {}): number => {
      const id = store.createBatch({ ...BATCH, config: { ...BATCH.config, species: 155, map: 'forest', tier: 0, ranked: true, maxGameTime: 0, ...cfg } });
      store.setBatchMetadata(id, { ...METADATA, ...m });
      for (const e of eps) store.insertEpisode(id, e);
      store.finishBatch(id, { status: 'completed', finishedAt: '2026-01-01T00:01:00.000Z', wallSeconds: 60 });
      return id;
    };
    // Where and how fast an episode was played is not part of what it is.
    const elsewhere = (e: EpisodeRecord): EpisodeRecord => ({ ...e, wallSeconds: 99, resetSeconds: 7, worker: { id: 9, pid: 1, episode: 4, rssMB: 900 }, startedAt: '2026-02-02T00:00:00.000Z', finishedAt: '2026-02-02T00:01:00.000Z' });
    const a = batch({}, [episode(5), episode(6)]);
    const same = batch({}, [elsewhere(episode(6)), elsewhere(episode(5)), episode(7)], { workers: 1 });
    const kills = batch({}, [episode(5), episode(6, { kills: 1017 })]);
    const pick = episode(6);
    pick.decisions = [pick.decisions[0], { ...pick.decisions[1], chosen: { type: 'choice', option: 0 }, chosenId: 'none' }];
    const decision = batch({}, [episode(5), pick]);
    const preset = batch({ profilePreset: 'unlocked-v3' }, [episode(5)]);
    const species = batch({}, [episode(5)], { species: 25 });
    const other = batch({}, [episode(8)]);
    store.close();
    const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'compare-batches.ts');
    const run = (x: number, y: number) => spawnSync(process.execPath, [script, `--db=${t.path}`, `--a=${x}`, `--b=${y}`], { encoding: 'utf8' });

    const ok = run(a, same);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /2 seed\(s\) in common; only in \d+: 7/);
    assert.match(ok.stdout, /identical: 2 episode\(s\), 30 columns each/);
    const k = run(a, kills);
    assert.equal(k.status, 1);
    assert.match(k.stdout, /seed 6: DIFFERENT[\s\S]*kills: 1016 \/ 1017[\s\S]*1 of 2 seed\(s\) DIFFER/);
    const d = run(a, decision);
    assert.equal(d.status, 1);
    assert.match(d.stdout, /seed 6: DIFFERENT[\s\S]*decision 2 \(seals at 262\.20 s\): chosen_json, chosen_id differ/);
    for (const [id, what] of [[preset, /profile_preset: unlocked-v2 \/ unlocked-v3/], [species, /config\.species: 155 \/ 25/], [other, /no seed in common/]] as const) {
      const r = run(a, id);
      assert.equal(r.status, 2, r.stdout);
      assert.match(r.stderr, what);
      assert.equal(r.stdout, '');
    }
    assert.equal(run(a, 999).status, 2);
  } finally { t.done(); }
});
