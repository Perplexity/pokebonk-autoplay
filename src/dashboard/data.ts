/**
 * What the batch page shows (scripts/dashboard.ts), read from the episode database (docs/storage.md). Reads only:
 * the page never writes to the database, and a batch that is being played is read while the runner writes.
 *
 * Every figure is ranked KOs: a run's own KOs plus its Overtime bonus when Overtime was cashed, and 0 for a run the
 * environment ended as invalid (`idle: …`).
 */
import type { DatabaseSync } from 'node:sqlite';

export interface Stats { n: number; median: number; mean: number; p90: number; best: number; worst: number }

/** p is 0 to 1; interpolated between the two nearest values, as everywhere in docs/results.md. */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const k = (sorted.length - 1) * p, i = Math.floor(k);
  return sorted[i] + (sorted[Math.min(i + 1, sorted.length - 1)] - sorted[i]) * (k - i);
}

export function statsOf(values: number[]): Stats | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  return { n: v.length, median: percentile(v, 0.5), mean: v.reduce((a, b) => a + b, 0) / v.length, p90: percentile(v, 0.9), best: v[v.length - 1], worst: v[0] };
}

export const rankedKos = (e: { kills: number; overtime_bonus: number; overtime_cashed: number; end_cause: string }): number =>
  e.end_cause.startsWith('idle') ? 0 : e.kills + (e.overtime_cashed ? e.overtime_bonus : 0);

export interface BatchRow {
  id: number; label: string; status: string; policy: string; preset: string | null;
  startedAt: string; finishedAt: string | null;
  planned: number; played: number; errors: number;
  /** When the newest of its runs finished: a batch marked running whose last run is hours old has probably been stopped. */
  lastRunAt: string | null;
  /** Seconds of wall time a finished run of this batch took, on average; workers it was given. */
  runSeconds: number | null; workers: number | null;
  stats: Stats | null;
}

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const config = (b: Row): Row => { try { return JSON.parse(String(b.config_json ?? '{}')) as Row; } catch { return {}; } };

function rowOf(b: Row, eps: Row[]): BatchRow {
  const cfg = config(b);
  const walls = eps.map((e) => Number(e.wall_seconds)).filter((w) => w > 0);
  return {
    id: Number(b.id), label: str(b.label) ?? '(no label)', status: String(b.status), policy: `${b.policy_name} ${b.policy_version}`, preset: str(b.profile_preset),
    startedAt: String(b.started_at), finishedAt: str(b.finished_at),
    planned: Number(b.episodes_planned), played: eps.length, errors: Number(b.error_count ?? 0),
    lastRunAt: eps.reduce<string | null>((m, e) => (str(e.finished_at) && (!m || String(e.finished_at) > m) ? String(e.finished_at) : m), null),
    runSeconds: walls.length ? walls.reduce((a, x) => a + x, 0) / walls.length : null, workers: typeof cfg.workers === 'number' ? cfg.workers : null,
    stats: statsOf(eps.map((e) => rankedKos(e as never))),
  };
}

const EPISODE_COLUMNS = 'id, batch_id, seed, kills, overtime_bonus, overtime_cashed, overtime_rounds, end_cause, level, zone, game_time, wall_seconds, finished_at';

/** Every batch, newest first. */
export function batchList(db: DatabaseSync): BatchRow[] {
  const byBatch = new Map<number, Row[]>();
  for (const e of db.prepare(`SELECT ${EPISODE_COLUMNS} FROM episodes`).all() as Row[]) {
    const id = Number(e.batch_id);
    if (!byBatch.has(id)) byBatch.set(id, []);
    byBatch.get(id)!.push(e);
  }
  return (db.prepare('SELECT * FROM batches ORDER BY id DESC').all() as Row[]).map((b) => rowOf(b, byBatch.get(Number(b.id)) ?? []));
}

export interface RunRow { seed: number; rankedKos: number; kills: number; bonus: number; cashed: boolean; round: number; level: number; zone: number; minutes: number; end: string; invalid: boolean }

export interface BatchDetail extends BatchRow {
  /** How it was played: Pokémon, map, tier, the account, and the plan keys it replaced. */
  setup: { species: number | null; map: string | null; tier: number | null; archive: string | null; buildPlan: string | null; plan: Row | null; game: string | null };
  runs: RunRow[];
  /** Seeds it was given that have no run yet. */
  waiting: number[];
}

const runOf = (e: Row): RunRow => ({
  seed: Number(e.seed), rankedKos: rankedKos(e as never), kills: Number(e.kills), bonus: e.overtime_cashed ? Number(e.overtime_bonus) : 0, cashed: !!e.overtime_cashed,
  round: Number(e.overtime_rounds), level: Number(e.level), zone: Number(e.zone), minutes: Math.round(Number(e.game_time) / 6) / 10,
  end: String(e.end_cause), invalid: String(e.end_cause).startsWith('idle'),
});

export function batchDetail(db: DatabaseSync, id: number): BatchDetail | null {
  const b = db.prepare('SELECT * FROM batches WHERE id = ?').get(id) as Row | undefined;
  if (!b) return null;
  const eps = db.prepare(`SELECT ${EPISODE_COLUMNS} FROM episodes WHERE batch_id = ? ORDER BY seed`).all(id) as Row[];
  const cfg = config(b), options = (cfg.policyOptions ?? null) as Row | null;
  const seeds = Array.isArray(cfg.seeds) ? (cfg.seeds as unknown[]).map(Number) : [], have = new Set(eps.map((e) => Number(e.seed)));
  return {
    ...rowOf(b, eps),
    setup: {
      species: typeof cfg.species === 'number' ? cfg.species : null, map: str(cfg.map), tier: typeof cfg.tier === 'number' ? cfg.tier : null,
      archive: str(cfg.archive), buildPlan: str(cfg.buildPlan), plan: options && typeof options.plan === 'object' ? (options.plan as Row) : null,
      game: str(b.game_build) ? `${b.game_build}${str(b.game_version) ? ` (${b.game_version})` : ''}` : null,
    },
    runs: eps.map(runOf),
    waiting: seeds.filter((s) => !have.has(s)),
  };
}

export interface Comparison {
  a: number; b: number;
  /** Seeds both played, and how a's ranked KOs stand against b's on them. */
  seeds: number; same: number; higher: number; lower: number;
  meanDifference: number; medianDifference: number;
  /** Stats of each side over the common seeds only. */
  statsA: Stats | null; statsB: Stats | null;
  pairs: { seed: number; a: number; b: number }[];
}

/** Batch a against batch b on the seeds both played. A summary of two batches, not a paired test (docs/results.md §4). */
export function compareBatches(db: DatabaseSync, a: number, b: number): Comparison | null {
  const [da, dbb] = [batchDetail(db, a), batchDetail(db, b)];
  if (!da || !dbb) return null;
  const other = new Map(dbb.runs.map((r) => [r.seed, r.rankedKos]));
  const pairs = da.runs.filter((r) => other.has(r.seed)).map((r) => ({ seed: r.seed, a: r.rankedKos, b: other.get(r.seed)! }));
  const diffs = pairs.map((p) => p.a - p.b).sort((x, y) => x - y);
  return {
    a, b, seeds: pairs.length, same: pairs.filter((p) => p.a === p.b).length, higher: pairs.filter((p) => p.a > p.b).length, lower: pairs.filter((p) => p.a < p.b).length,
    meanDifference: diffs.length ? diffs.reduce((x, y) => x + y, 0) / diffs.length : NaN, medianDifference: percentile(diffs, 0.5),
    statsA: statsOf(pairs.map((p) => p.a)), statsB: statsOf(pairs.map((p) => p.b)), pairs,
  };
}
