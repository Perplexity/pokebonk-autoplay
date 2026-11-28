import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { EpisodeStore } from '../../src/storage/database.ts';
import type { BatchInput, BatchMetadata, EpisodeRecord } from '../../src/storage/records.ts';
import { batchDetail, batchList, compareBatches, percentile, rankedKos, statsOf } from '../../src/dashboard/data.ts';

// The batch page's figures, from a database written by the runner's own store and read back read-only. No game.

const BATCH: BatchInput = {
  label: 'unit test', policyName: 'player', policyVersion: '3+abc', config: { episodes: 3, seed: 1, workers: 2 }, hz: 60, actionRepeat: 3, rewardVersion: null,
  host: { platform: 'test', logicalCpus: 12 }, episodesPlanned: 3, startedAt: '2026-01-01T00:00:00.000Z',
};
const METADATA: BatchMetadata = {
  gameBuild: 'mwsewi0r', gameVersion: '0.10.26', bundleSha256: 'a'.repeat(64), shimHash: 'b'.repeat(64), observationSchema: 1, actionSchema: 1, decisionSchema: 1, snapshotSchema: 1,
  profilePreset: 'unlocked-v5:stack-2:kit-1', ranked: true, full: {},
};
function episode(seed: number, kills: number, over: Partial<EpisodeRecord> = {}): EpisodeRecord {
  return {
    seed, species: 150, finalSpecies: 150, map: 'forest', tier: 2, ranked: true, terminated: true, truncated: false, endCause: 'died', endHow: 'died', victory: false,
    gameTime: 600, kills, overtime: { started: false, bonus: 0, rounds: 0, cashed: false }, level: 25, zone: 2, guardiansDefeated: 1, legendariesDefeated: 0, sealsKept: 0,
    steps: 100, simSteps: 300, wallSeconds: 20, resetSeconds: 1,
    finalBuild: { species: 150, startSpecies: 150, evoStage: 0, passive: 'x', level: 25, maxHp: 100, moveSlots: 4, moves: [], vitaminSlots: 5, vitamins: [], items: [], relics: [], refreshes: 0, skips: 0, banishes: 0, revives: 0, stats: {} },
    counters: { kills }, record: {}, blockedNetwork: [], decisions: [],
    worker: { id: 1, pid: 1, episode: 1, rssMB: 100 }, startedAt: '2026-01-01T00:00:01.000Z', finishedAt: `2026-01-01T00:0${seed}:00.000Z`,
    ...over,
  } as EpisodeRecord;
}
const cashed = (bonus: number, rounds: number) => ({ endCause: 'won (victory), overtime cashed', victory: true, overtime: { started: true, bonus, rounds, cashed: true } });

function fixture(): { path: string; db: DatabaseSync; ids: { done: number; other: number; playing: number; empty: number }; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pokebonk-dashboard-'));
  const path = join(dir, 'test.sqlite'), store = EpisodeStore.open(path);
  const batch = (label: string, cfg: Record<string, unknown>, eps: EpisodeRecord[], end: 'completed' | 'interrupted' | null): number => {
    const id = store.createBatch({ ...BATCH, label, config: { ...BATCH.config, species: 150, map: 'forest', tier: 2, ...cfg } });
    if (eps.length) store.setBatchMetadata(id, METADATA);
    for (const e of eps) store.insertEpisode(id, e);
    if (end) store.finishBatch(id, { status: end, finishedAt: '2026-01-01T01:00:00.000Z', wallSeconds: 3600 });
    return id;
  };
  const ids = {
    // Seed 2 cashes a bonus, seed 3 loses its bonus, seed 4 was ended as invalid.
    done: batch('plan', { seeds: [1, 2, 3, 4], archive: 'stack-2', buildPlan: 'kit-1', policyOptions: { plan: { rifts: true } } },
      [episode(1, 1000), episode(2, 3000, cashed(9000, 18)), episode(3, 2000, { endCause: 'won (victory), overtime lost', overtime: { started: true, bonus: 5000, rounds: 15, cashed: false } }), episode(4, 700, { endCause: 'idle: no KO for 30 s of game time' })], 'completed'),
    other: batch('before', { seeds: [1, 2, 3] }, [episode(1, 1000), episode(2, 2000, cashed(4000, 16)), episode(3, 2500), episode(9, 50)], 'completed'),
    playing: batch('now', { seeds: [1, 2, 3], workers: 2 }, [episode(2, 500)], null),
    empty: batch('stopped', { seeds: [1, 2] }, [], 'interrupted'),
  };
  store.close();
  const db = new DatabaseSync(path, { readOnly: true });
  return { path, db, ids, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('ranked KOs: own KOs, plus the bonus only when cashed, and 0 for a run ended as invalid; the percentile is interpolated', () => {
  assert.equal(rankedKos({ kills: 3000, overtime_bonus: 9000, overtime_cashed: 1, end_cause: 'won (victory), overtime cashed' }), 12000);
  assert.equal(rankedKos({ kills: 2000, overtime_bonus: 5000, overtime_cashed: 0, end_cause: 'won (victory), overtime lost' }), 2000);
  assert.equal(rankedKos({ kills: 700, overtime_bonus: 0, overtime_cashed: 0, end_cause: 'idle: no KO for 30 s of game time' }), 0);
  assert.equal(percentile([10, 20, 30, 40], 0.5), 25);
  assert.equal(percentile([10, 20, 30, 40], 0.9), 37);
  assert.equal(percentile([7], 0.9), 7);
  assert.equal(statsOf([]), null);
  assert.deepEqual(statsOf([40, 10, 30, 20]), { n: 4, median: 25, mean: 25, p90: 37, best: 40, worst: 10 });
});

test('the list: every batch newest first, with what was played, its figures and when its last run finished', () => {
  const f = fixture();
  try {
    const list = batchList(f.db);
    assert.deepEqual(list.map((b) => b.id), [f.ids.empty, f.ids.playing, f.ids.other, f.ids.done]);
    const done = list.find((b) => b.id === f.ids.done)!;
    assert.deepEqual([done.label, done.status, done.planned, done.played, done.policy, done.preset], ['plan', 'completed', 3, 4, 'player 3+abc', 'unlocked-v5:stack-2:kit-1']);
    assert.deepEqual({ ...done.stats!, p90: Math.round(done.stats!.p90) }, { n: 4, median: 1500, mean: 3750, p90: 9000, best: 12000, worst: 0 });
    assert.equal(done.lastRunAt, '2026-01-01T00:04:00.000Z');
    const playing = list.find((b) => b.id === f.ids.playing)!;
    assert.deepEqual([playing.status, playing.played, playing.finishedAt, playing.runSeconds, playing.workers], ['running', 1, null, 20, 2]);
    const empty = list.find((b) => b.id === f.ids.empty)!;
    assert.deepEqual([empty.status, empty.played, empty.stats, empty.lastRunAt, empty.preset], ['interrupted', 0, null, null, null]);
  } finally { f.done(); }
});

test('one batch: how it was played, its runs by seed, and the seeds that have no run yet', () => {
  const f = fixture();
  try {
    const d = batchDetail(f.db, f.ids.done)!;
    assert.deepEqual(d.setup, { species: 150, map: 'forest', tier: 2, archive: 'stack-2', buildPlan: 'kit-1', plan: { rifts: true }, game: 'mwsewi0r (0.10.26)' });
    assert.deepEqual(d.runs.map((r) => [r.seed, r.rankedKos, r.bonus, r.cashed, r.round, r.invalid]), [[1, 1000, 0, false, 0, false], [2, 12000, 9000, true, 18, false], [3, 2000, 0, false, 15, false], [4, 0, 0, false, 0, true]]);
    assert.equal(d.runs[0].minutes, 10);
    assert.deepEqual(d.waiting, []);
    const playing = batchDetail(f.db, f.ids.playing)!;
    assert.deepEqual(playing.waiting, [1, 3]);
    assert.deepEqual(playing.setup.plan, null);
    assert.equal(batchDetail(f.db, 999), null);
  } finally { f.done(); }
});

test('one batch against another: only the seeds both played, counted and summed', () => {
  const f = fixture();
  try {
    const c = compareBatches(f.db, f.ids.done, f.ids.other)!;
    assert.deepEqual(c.pairs, [{ seed: 1, a: 1000, b: 1000 }, { seed: 2, a: 12000, b: 6000 }, { seed: 3, a: 2000, b: 2500 }]);
    assert.deepEqual([c.seeds, c.same, c.higher, c.lower], [3, 1, 1, 1]);
    assert.equal(c.meanDifference, (0 + 6000 - 500) / 3);
    assert.equal(c.medianDifference, 0);
    assert.deepEqual([c.statsA!.n, c.statsA!.best, c.statsB!.best], [3, 12000, 6000]);
    const none = compareBatches(f.db, f.ids.done, f.ids.empty)!;
    assert.deepEqual([none.seeds, none.statsA, Number.isNaN(none.meanDifference)], [0, null, true]);
    assert.equal(compareBatches(f.db, f.ids.done, 999), null);
  } finally { f.done(); }
});

test('the server: the page, the three readings as JSON, and nothing else; it listens on this machine only', async () => {
  const f = fixture();
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'dashboard.ts');
  const child = spawn(process.execPath, [script, '--port=0', `--db=${f.path}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const line = await new Promise<string>((ok, bad) => {
      let out = '';
      child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); if (out.includes('\n')) ok(out); });
      child.on('exit', (code) => bad(new Error(`the server stopped (exit ${code})`)));
      setTimeout(() => bad(new Error('the server did not start')), 15000).unref();
    });
    const base = /http:\/\/127\.0\.0\.1:\d+/.exec(line)![0];
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    const html = await page.text();
    assert.match(html, /<title>Batches<\/title>/);
    assert.doesNotMatch(html, /(src|href)="https?:/, 'the page loads nothing from anywhere else');
    const list = await (await fetch(`${base}/api/batches`)).json() as { batches: { id: number }[] };
    assert.equal(list.batches.length, 4);
    const one = await (await fetch(`${base}/api/batch?id=${f.ids.done}`)).json() as { batch: { runs: unknown[] } };
    assert.equal(one.batch.runs.length, 4);
    const cmp = await (await fetch(`${base}/api/compare?a=${f.ids.done}&b=${f.ids.other}`)).json() as { seeds: number };
    assert.equal(cmp.seeds, 3);
    assert.equal((await fetch(`${base}/api/batch?id=999`)).status, 404);
    assert.equal((await fetch(`${base}/api/batch?id=x`)).status, 404);
    assert.equal((await fetch(`${base}/api/compare?a=1`)).status, 404);
    assert.equal((await fetch(`${base}/nothing`)).status, 404);
    assert.equal((await fetch(`${base}/api/batches`, { method: 'POST' })).status, 405);
  } finally { child.kill(); f.done(); }
});
