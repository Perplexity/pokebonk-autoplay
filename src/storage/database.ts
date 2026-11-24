import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { BatchInput, BatchMetadata, EpisodeRecord, ErrorRecord } from './records.ts';

/**
 * The episode database: one SQLite file (default data/pokebonk.sqlite), written by the runner's parent process only.
 * Schema and conventions: docs/storage.md. Schema changes are plain SQL files in ./migrations, applied in order and
 * recorded in `schema_version`; a file written by newer code than this is refused.
 *
 * Built on Node's own `node:sqlite`, so there is no native dependency; a Python trainer reads and writes the same file
 * with the standard `sqlite3` module.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DATABASE = resolve(HERE, '..', '..', 'data', 'pokebonk.sqlite');
const MIGRATIONS_DIR = join(HERE, 'migrations');

export interface Migration { version: number; name: string; sql: string }

/** The migration files, in order. Their names are `NNN_description.sql`; versions must be 1, 2, 3 … without gaps. */
export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const out = readdirSync(dir).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort().map((f) => ({ version: Number(f.slice(0, 3)), name: f.slice(4, -4), sql: readFileSync(join(dir, f), 'utf8') }));
  out.forEach((m, i) => { if (m.version !== i + 1) throw new Error(`[storage] migration files must be numbered 001, 002, …: found ${m.version} at position ${i + 1}`); });
  if (!out.length) throw new Error(`[storage] no migration files in ${dir}`);
  return out;
}

/** The schema version this code writes. */
export const SCHEMA_VERSION = loadMigrations().length;

type Row = Record<string, unknown>;
const bool = (v: boolean): number => (v ? 1 : 0);
const json = (v: unknown): string => JSON.stringify(v);

export interface OpenOptions {
  /** Migrations to apply instead of the ones on disk (tests). */
  migrations?: Migration[];
}

export class EpisodeStore {
  readonly path: string;
  readonly db: DatabaseSync;

  private constructor(path: string, db: DatabaseSync) { this.path = path; this.db = db; }

  /** Open (creating the file and its folder when needed) and bring the schema up to date. */
  static open(path: string = DEFAULT_DATABASE, options: OpenOptions = {}): EpisodeStore {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    const db = new DatabaseSync(path);
    try {
      // WAL: a reader (the trainer, a notebook) does not block the runner and is not blocked by it.
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000;');
      migrate(db, options.migrations ?? loadMigrations());
    } catch (e) { db.close(); throw e; }
    return new EpisodeStore(path, db);
  }

  close(): void { if (this.db.isOpen) this.db.close(); }

  /** Highest applied schema version. */
  schemaVersion(): number { return Number((this.db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as Row).v); }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); this.db.exec('COMMIT'); return out; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // ------------------------------------------------------------------ batches

  createBatch(b: BatchInput): number {
    const r = this.db.prepare(`INSERT INTO batches (started_at, label, policy_name, policy_version, config_json, hz, action_repeat, reward_version, host_json, episodes_planned)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(b.startedAt, b.label, b.policyName, b.policyVersion, json(b.config), b.hz, b.actionRepeat, b.rewardVersion, json(b.host), b.episodesPlanned);
    return Number(r.lastInsertRowid);
  }

  /** What the environment reported about itself (known once the first worker has loaded the game). */
  setBatchMetadata(batchId: number, m: BatchMetadata): void {
    this.db.prepare(`UPDATE batches SET game_build = ?, game_version = ?, bundle_sha256 = ?, shim_hash = ?, observation_schema = ?, action_schema = ?, decision_schema = ?,
      snapshot_schema = ?, profile_preset = ?, ranked = ?, metadata_json = ? WHERE id = ?`).run(
      m.gameBuild, m.gameVersion, m.bundleSha256, m.shimHash, m.observationSchema, m.actionSchema, m.decisionSchema, m.snapshotSchema, m.profilePreset, bool(m.ranked), json(m.full), batchId);
  }

  finishBatch(batchId: number, end: { status: 'completed' | 'failed' | 'interrupted'; finishedAt: string; wallSeconds: number }): void {
    this.db.prepare(`UPDATE batches SET status = ?, finished_at = ?, wall_seconds = ?,
      episodes_done = (SELECT COUNT(*) FROM episodes WHERE batch_id = batches.id), error_count = (SELECT COUNT(*) FROM errors WHERE batch_id = batches.id) WHERE id = ?`)
      .run(end.status, end.finishedAt, end.wallSeconds, batchId);
  }

  // ------------------------------------------------------------------ episodes, decisions, errors

  /** One episode with all its decisions, atomically. Returns the episode id. */
  insertEpisode(batchId: number, e: EpisodeRecord): number {
    return this.tx(() => {
      const r = this.db.prepare(`INSERT INTO episodes (batch_id, seed, species, final_species, map, tier, ranked, end_cause, end_how, terminated, truncated, victory, game_time, kills,
        overtime_started, overtime_bonus, overtime_rounds, overtime_cashed, level, zone, guardians_defeated, legendaries_defeated, seals_kept, steps, sim_steps, decision_count,
        wall_seconds, reset_seconds, final_build_json, counters_json, record_json, blocked_network, blocked_network_json, worker_id, worker_pid, worker_episode, worker_rss_mb, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        batchId, e.seed, e.species, e.finalSpecies, e.map, e.tier, bool(e.ranked), e.endCause, e.endHow, bool(e.terminated), bool(e.truncated), bool(e.victory), e.gameTime, e.kills,
        bool(e.overtime.started), e.overtime.bonus, e.overtime.rounds, bool(e.overtime.cashed), e.level, e.zone, e.guardiansDefeated, e.legendariesDefeated, e.sealsKept, e.steps, e.simSteps, e.decisions.length,
        e.wallSeconds, e.resetSeconds, json(e.finalBuild), json(e.counters), e.record ? json(e.record) : null, e.blockedNetwork.length, e.blockedNetwork.length ? json(e.blockedNetwork) : null,
        e.worker.id, e.worker.pid, e.worker.episode, e.worker.rssMB, e.startedAt, e.finishedAt);
      const id = Number(r.lastInsertRowid);
      const ins = this.db.prepare(`INSERT INTO decisions (episode_id, serial, step, game_time, zone, level, kind, method, options_json, context_json, mask_json, chosen_json, chosen_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const d of e.decisions) ins.run(id, d.serial, d.step, d.gameTime, d.zone, d.level, d.kind, d.method, json(d.options), json(d.context), json(d.mask), json(d.chosen), d.chosenId);
      this.db.prepare('UPDATE batches SET episodes_done = episodes_done + 1 WHERE id = ?').run(batchId);
      return id;
    });
  }

  insertError(batchId: number, e: ErrorRecord, episodeId: number | null = null): number {
    return this.tx(() => {
      const r = this.db.prepare('INSERT INTO errors (batch_id, episode_id, seed, worker_id, kind, occurred_at, message, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(batchId, episodeId, e.seed, e.workerId, e.kind, e.occurredAt, e.message, json(e.details));
      this.db.prepare('UPDATE batches SET error_count = error_count + 1 WHERE id = ?').run(batchId);
      return Number(r.lastInsertRowid);
    });
  }

  // ------------------------------------------------------------------ reading (reports, tests)

  batch(batchId: number): Row | undefined { return this.db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId) as Row | undefined; }
  episodes(batchId: number): Row[] { return this.db.prepare('SELECT * FROM episodes WHERE batch_id = ? ORDER BY seed').all(batchId) as Row[]; }
  decisions(episodeId: number): Row[] { return this.db.prepare('SELECT * FROM decisions WHERE episode_id = ? ORDER BY serial').all(episodeId) as Row[]; }
  errors(batchId: number): Row[] { return this.db.prepare('SELECT * FROM errors WHERE batch_id = ? ORDER BY id').all(batchId) as Row[]; }
}

function migrate(db: DatabaseSync, migrations: Migration[]): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const have = Number((db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version').get() as Row).v);
  const newest = migrations[migrations.length - 1].version;
  if (have > newest) throw new Error(`[storage] the database is at schema version ${have}, this code knows up to ${newest}: update the code, do not write with an older runner`);
  for (const m of migrations) {
    if (m.version <= have) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`[storage] migration ${String(m.version).padStart(3, '0')}_${m.name} failed: ${(e as Error).message}`);
    }
  }
}
