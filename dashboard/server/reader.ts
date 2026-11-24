import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  BatchInfo, Breakdowns, CheckpointInfo, ChoiceRow, Curve, CurveBin, EpisodeDetail, EpisodeRow, EvaluationDetail, EvaluationInfo, GroupRow, ModelInfo, ModelsView, PickRow,
  RunInfo, SessionInfo, Summary,
} from '../shared/api.ts';
import type { Context } from './context.ts';
import { LITE_COLUMNS, mean, median, scoreOf, seedsLabel, summarize } from './stats.ts';
import type { EpisodeLite } from './stats.ts';

/**
 * Everything the dashboard shows, read from the episode database (docs/storage.md) and the models folder.
 *
 * The database is opened READ-ONLY: this class cannot change a row. It never opens a model file either; of the
 * models folder it reads `stable/current.json`, a run's `config.json`, file names and sizes, and whether a run's STOP
 * file exists.
 * Results are kept until another process commits to the database (`PRAGMA data_version`).
 */

type Row = Record<string, any>;
const LIVE_WINDOW_MS = 10 * 60 * 1000;
const SCRIPTED = new Set(['random', 'idle', 'heuristic']);
const parse = <T = any>(text: unknown, fallback: T): T => { if (typeof text !== 'string') return fallback; try { return JSON.parse(text) as T; } catch { return fallback; } };
const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);
const policyLabel = (p: string): string => (p === 'ppo-train' ? 'model, while training' : p === 'ppo' ? 'model, evaluation' : `${p} baseline`);

export class Reader {
  private db: DatabaseSync | null = null;
  private version = -1;
  private cache = new Map<string, unknown>();
  private names: { species: Record<string, string>; items: Record<string, string> } | null = null;
  private readonly ctx: Context;

  constructor(ctx: Context) { this.ctx = ctx; }

  close(): void { if (this.db?.isOpen) this.db.close(); this.db = null; }

  get exists(): boolean { return existsSync(this.ctx.database); }

  private open(): DatabaseSync | null {
    if (this.db?.isOpen) return this.db;
    if (!this.exists) return null;
    this.db = new DatabaseSync(this.ctx.database, { readOnly: true });
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA query_only = ON;');
    return this.db;
  }

  /** `make(db)` once per state of the database; `empty` when there is no database (or no such table yet). */
  private cached<T>(key: string, empty: T, make: (db: DatabaseSync) => T): T {
    const db = this.open();
    if (!db) return empty;
    const v = Number((db.prepare('PRAGMA data_version').get() as Row).data_version);
    if (v !== this.version) { this.cache.clear(); this.version = v; }
    if (this.cache.has(key)) return this.cache.get(key) as T;
    let out: T;
    try { out = make(db); } catch (e) {
      // A database from before the training tables existed has no such table: that is "nothing yet", not a failure.
      if (/no such table/.test(String((e as Error).message))) out = empty; else throw e;
    }
    this.cache.set(key, out);
    return out;
  }

  private all(db: DatabaseSync, sql: string, ...args: any[]): Row[] { return db.prepare(sql).all(...args) as Row[]; }

  private readText(file: string): string | null { try { return readFileSync(file, 'utf8'); } catch { return null; } }

  // ---------------------------------------------------------------- names

  knowledgeNames(): { species: Record<string, string>; items: Record<string, string> } {
    if (this.names) return this.names;
    const out = { species: {} as Record<string, string>, items: {} as Record<string, string> };
    try {
      for (const build of existsSync(this.ctx.knowledge) ? readdirSync(this.ctx.knowledge) : []) {
        const dir = join(this.ctx.knowledge, build);
        const species = parse<any>(existsSync(join(dir, 'species.json')) ? readFileSync(join(dir, 'species.json'), 'utf8') : null, null);
        for (const p of species?.pokedex ?? []) out.species[p.id] = p.name;
        const items = parse<any>(existsSync(join(dir, 'items.json')) ? readFileSync(join(dir, 'items.json'), 'utf8') : null, null);
        for (const group of ['heldItems', 'vitamins', 'relics']) for (const it of items?.[group] ?? []) out.items[it.key] = it.name;
      }
    } catch { /* names are a nicety: keys are shown instead */ }
    this.names = out;
    return out;
  }

  // ---------------------------------------------------------------- episodes and batches

  /** Every episode's light columns, by batch. */
  private lite(): Map<number, EpisodeLite[]> {
    return this.cached('lite', new Map(), (db) => {
      const by = new Map<number, EpisodeLite[]>();
      for (const r of this.all(db, `SELECT ${LITE_COLUMNS} FROM episodes ORDER BY id`) as unknown as EpisodeLite[]) {
        const list = by.get(r.batch_id);
        if (list) list.push(r); else by.set(r.batch_id, [r]);
      }
      return by;
    });
  }

  private batchRows(): Row[] {
    return this.cached('batchRows', [], (db) => this.all(db, `SELECT id, started_at, finished_at, status, label, policy_name, policy_version, config_json, game_build, game_version,
      profile_preset, reward_version, episodes_planned, error_count, wall_seconds FROM batches ORDER BY id DESC`));
  }

  batches(): BatchInfo[] {
    return this.cached('batches', [], () => {
      const lite = this.lite();
      return this.batchRows().map((b): BatchInfo => {
        const config = parse<any>(b.config_json, {});
        const kind = b.policy_name === 'ppo-train' ? 'training' : b.policy_name === 'ppo' ? 'evaluation' : 'scripted';
        const species: number[] = config.scenarios?.species ?? (config.species != null ? [Number(config.species)] : []);
        return {
          id: b.id, label: b.label, startedAt: b.started_at, finishedAt: b.finished_at, status: b.status, kind, policy: b.policy_name, policyVersion: b.policy_version, species,
          map: config.scenarios?.maps?.[0] ?? config.map ?? null, tier: config.scenarios?.tiers?.[0] ?? config.tier ?? null,
          gameBuild: b.game_build, gameVersion: b.game_version, preset: b.profile_preset, rewardVersion: b.reward_version, planned: b.episodes_planned, errors: b.error_count,
          wallSeconds: b.wall_seconds, seedsLabel: kind === 'training' ? `from ${config.episode_seeds?.first ?? '?'}` : seedsLabel(config.seeds),
          summary: summarize(lite.get(b.id) ?? []),
        };
      });
    });
  }

  // ---------------------------------------------------------------- training runs

  checkpoints(): CheckpointInfo[] {
    return this.cached('checkpoints', [], (db) => this.all(db, `SELECT c.id, r.name run, c.timesteps, c.kind, c.created_at, c.sha256, c.episodes, c.path FROM checkpoints c JOIN training_runs r ON r.id = c.run_id
      ORDER BY c.run_id, c.timesteps`).map((c) => ({ id: c.id, run: c.run, timesteps: c.timesteps, kind: c.kind, createdAt: c.created_at, sha256: c.sha256, episodes: c.episodes, path: c.path })));
  }

  sessions(now = Date.now()): SessionInfo[] {
    const base = this.cached('sessions', [], (db) => {
      const activity = new Map<number, { last: string | null; n: number }>();
      for (const r of this.all(db, 'SELECT batch_id, MAX(finished_at) last, COUNT(*) n FROM episodes GROUP BY batch_id')) activity.set(r.batch_id, { last: r.last, n: r.n });
      const ckpts = this.all(db, 'SELECT session_id, MAX(created_at) last, MAX(timesteps) timesteps FROM checkpoints GROUP BY session_id');
      const lastCkpt = new Map(ckpts.map((c) => [c.session_id, c]));
      return this.all(db, `SELECT s.*, r.name run, b.error_count errors FROM training_sessions s JOIN training_runs r ON r.id = s.run_id JOIN batches b ON b.id = s.batch_id ORDER BY s.id`).map((s) => {
        const a = activity.get(s.batch_id), c = lastCkpt.get(s.id);
        const lastActivityAt = [s.started_at, a?.last, c?.last, s.finished_at].filter(Boolean).sort().at(-1) as string;
        const reached = s.end_timesteps ?? c?.timesteps ?? s.start_timesteps;
        const until = s.finished_at ?? (c?.last && reached === c.timesteps ? c.last : lastActivityAt);
        const seconds = (ms(until) - ms(s.started_at)) / 1000;
        const steps = reached - s.start_timesteps;
        return {
          id: s.id, run: s.run, batchId: s.batch_id, status: s.status, startedAt: s.started_at, finishedAt: s.finished_at, startTimesteps: s.start_timesteps, endTimesteps: s.end_timesteps,
          lastActivityAt, live: false, episodes: a?.n ?? 0, errors: s.errors ?? 0,
          decisionsPerSecond: seconds > 1 && steps > 0 ? steps / seconds : null,
          episodesPerHour: seconds > 1 && a?.n ? (a.n / ((ms(s.finished_at ?? lastActivityAt) - ms(s.started_at)) / 1000)) * 3600 : null,
        } satisfies SessionInfo;
      });
    });
    return base.map((s) => ({ ...s, live: s.status === 'running' && now - ms(s.lastActivityAt) < LIVE_WINDOW_MS }));
  }

  runs(now = Date.now()): RunInfo[] {
    const rows = this.cached('runRows', [], (db) => this.all(db, 'SELECT * FROM training_runs ORDER BY id DESC'));
    const sessions = this.sessions(now), checkpoints = this.checkpoints(), evaluations = this.evaluations();
    return rows.map((r): RunInfo => {
      const config = parse<any>(r.config_json, {}), reward = parse<any>(r.reward_json, {});
      const mine = sessions.filter((s) => s.run === r.name), ckpts = checkpoints.filter((c) => c.run === r.name);
      const last = mine.at(-1);
      const timesteps = Math.max(0, ...ckpts.map((c) => c.timesteps), ...mine.map((s) => s.endTimesteps ?? s.startTimesteps));
      const status: RunInfo['status'] = !last ? 'new' : mine.some((s) => s.live) ? 'running' : last.status === 'running' ? 'stale' : (last.status as RunInfo['status']);
      const withRate = mine.filter((s) => s.decisionsPerSecond != null).at(-1);
      // A resume with a higher total rewrites the run's own config.json, not its row in the database: the file is newer.
      const onDisk = parse<any>(this.readText(join(this.ctx.models, 'runs', r.name, 'config.json')), null);
      const target = Math.max(Number(config.total_timesteps ?? 0), Number(onDisk?.total_timesteps ?? 0));
      return {
        name: r.name, createdAt: r.created_at, algorithm: r.algorithm, rewardVersion: r.reward_version, gameBuild: r.game_build,
        targetTimesteps: target, timesteps, episodes: mine.reduce((n, s) => n + s.episodes, 0), status,
        workers: { envs: Number(config.workers?.envs ?? 0), spares: Number(config.workers?.spares ?? 0) }, device: String(config.device ?? ''),
        scenarios: { species: config.scenarios?.species ?? [], maps: config.scenarios?.maps ?? [], tiers: config.scenarios?.tiers ?? [] },
        stopRequested: existsSync(join(this.ctx.models, 'runs', r.name, 'STOP')),
        sessions: mine, checkpoints: ckpts, evaluations: evaluations.filter((e) => e.run === r.name),
        decisionsPerSecond: withRate?.decisionsPerSecond ?? null, episodesPerHour: withRate?.episodesPerHour ?? null,
        rewardWeights: reward.weights ?? {}, rewardScale: Number(reward.scale ?? 1),
      };
    });
  }

  // ---------------------------------------------------------------- evaluations

  private evaluationRows(): Row[] {
    return this.cached('evaluationRows', [], (db) => this.all(db, 'SELECT e.*, r.name run FROM evaluations e LEFT JOIN training_runs r ON r.id = e.run_id ORDER BY e.id DESC'));
  }

  private toEvaluation(e: Row): EvaluationInfo {
    const lite = this.lite();
    const seeds = parse<number[]>(e.seeds_json, []), stored = parse<any>(e.summary_json, {}), cmp = parse<any>(e.comparison_json, null);
    const empty: Summary = { episodes: 0, kosMean: 0, kosMedian: 0, kosMax: 0, scoreMean: 0, scoreMedian: 0, scoreMax: 0, gameTimeMean: 0, gameTimeMedian: 0, levelMean: 0, completed: 0, died: 0, truncated: 0, invalid: 0, zones: {}, guardians: {}, overtimeStarted: 0, overtimeCashed: 0 };
    const refBatch = /batch (\d+)/.exec(e.reference ?? '');
    const wanted = new Set(seeds);
    const referenceSummary = refBatch ? summarize((lite.get(Number(refBatch[1])) ?? []).filter((r) => wanted.has(r.seed))) : null;
    const isVerdict = cmp ? cmp.verdict !== false : false;
    const note = !cmp ? 'Not compared with anything.' : !isVerdict ? `For information, not a promotion verdict: ${(cmp.not_a_verdict_because ?? []).join('; ')}.` : cmp.why ? String(cmp.why) : null;
    return {
      id: e.id, createdAt: e.created_at, batchId: e.batch_id, run: e.run, timesteps: e.timesteps, modelSha256: e.model_sha256, deterministic: !!e.deterministic,
      seeds: seeds.length, seedsLabel: seedsLabel(seeds), scenario: parse(e.scenario_json, { species: 0, map: '', tier: 0 }),
      summary: summarize(lite.get(e.batch_id) ?? []) ?? empty, reference: e.reference, referenceSummary,
      ratio: cmp?.ratio ?? null, metric: cmp?.metric ?? null, minRatio: cmp?.min_ratio ?? null,
      passed: e.passed == null ? null : !!e.passed, isVerdict, note, perSeed: cmp?.per_seed_by_score ?? null,
      lostToErrors: Number(stored.lost_to_errors ?? 0), rewardMean: stored.reward_mean ?? null, rewardComponents: stored.reward_components_mean ?? null,
    };
  }

  evaluations(): EvaluationInfo[] { return this.cached('evaluations', [], () => this.evaluationRows().map((e) => this.toEvaluation(e))); }

  evaluation(id: number): EvaluationDetail | null {
    return this.cached(`evaluation:${id}`, null, (db) => {
      const row = this.evaluationRows().find((e) => e.id === id);
      if (!row) return null;
      const info = this.toEvaluation(row);
      const lite = this.lite();
      const refBatch = /batch (\d+)/.exec(row.reference ?? '');
      const ref = new Map((refBatch ? lite.get(Number(refBatch[1])) ?? [] : []).map((r) => [r.seed, scoreOf(r)]));
      const rows = this.all(db, `SELECT ${LITE_COLUMNS} FROM episodes WHERE batch_id = ? ORDER BY seed`, row.batch_id).map((r) => ({
        seed: r.seed, episodeId: r.id, score: scoreOf(r as EpisodeLite), kills: r.kills, gameTime: r.game_time, level: r.level, zone: r.zone, endCause: r.end_cause, referenceScore: ref.get(r.seed) ?? null,
      }));
      return { ...info, rows, modelPath: row.model_path };
    });
  }

  // ---------------------------------------------------------------- the training curve of a run

  curve(run: string): Curve | null {
    return this.cached(`curve:${run}`, null, (db) => {
      const r = this.all(db, 'SELECT * FROM training_runs WHERE name = ?', run)[0];
      if (!r) return null;
      const rows = this.all(db, `SELECT e.id, e.batch_id, e.seed, e.species, e.kills, e.overtime_bonus, e.overtime_cashed, e.overtime_started, e.game_time, e.level, e.zone, e.victory, e.terminated,
          e.truncated, e.guardians_defeated, e.end_cause, w.total reward, w.components_json, w.timesteps,
          json_extract(e.counters_json, '$.mapUse') map_use, json_extract(e.counters_json, '$.shopSold') shop_sold, json_extract(e.counters_json, '$.damageTaken') damage_taken
        FROM episodes e JOIN training_sessions s ON s.batch_id = e.batch_id LEFT JOIN episode_rewards w ON w.episode_id = e.id WHERE s.run_id = ? ORDER BY COALESCE(w.timesteps, 0), e.id`, r.id);
      const ckpts = this.checkpoints().filter((c) => c.run === run), sessions = this.sessions().filter((s) => s.run === run);
      const timesteps = Math.max(0, ...ckpts.map((c) => c.timesteps), ...rows.map((x) => x.timesteps ?? 0));
      const components = rows.length ? Object.keys(parse<Record<string, number>>(rows.find((x) => x.components_json)?.components_json, {})) : [];
      const counters = ['mapUse', 'shopSold', 'damageTaken'];

      // Equal-width bins over the decisions trained so far, about eight episodes each, at most 24.
      const n = Math.max(1, Math.min(24, Math.round(rows.length / 8)));
      const width = Math.max(1, timesteps) / n;
      const groups: Row[][] = Array.from({ length: n }, () => []);
      for (const x of rows) groups[Math.min(n - 1, Math.floor((x.timesteps ?? 0) / width))].push(x);
      const bins: CurveBin[] = [];
      groups.forEach((g, i) => {
        if (!g.length) return;
        const scores = g.map((x) => scoreOf(x as EpisodeLite));
        const comp: Record<string, number> = {};
        const parsed = g.map((x) => parse<Record<string, number>>(x.components_json, {}));
        for (const k of components) comp[k] = mean(parsed.map((p) => Number(p[k] ?? 0)));
        bins.push({
          t: (i + 0.5) * width, from: i * width, to: (i + 1) * width, episodes: g.length, scoreMean: mean(scores), scoreMedian: median(scores), kosMean: mean(g.map((x) => x.kills)),
          gameTimeMean: mean(g.map((x) => x.game_time)), levelMean: mean(g.map((x) => x.level)), zoneMean: mean(g.map((x) => x.zone)), completedShare: mean(g.map((x) => (x.victory ? 1 : 0))),
          rewardMean: mean(g.map((x) => Number(x.reward ?? 0))), components: comp,
          counters: { mapUse: mean(g.map((x) => Number(x.map_use ?? 0))), shopSold: mean(g.map((x) => Number(x.shop_sold ?? 0))), damageTaken: mean(g.map((x) => Number(x.damage_taken ?? 0))) },
        });
      });

      const stride = Math.max(1, Math.ceil(rows.length / 800));
      const points = rows.filter((_, i) => i % stride === 0).map((x) => ({ t: x.timesteps ?? 0, score: scoreOf(x as EpisodeLite), gameTime: x.game_time, zone: x.zone, id: x.id }));

      // Scripted baselines on the run's first scenario: for scale, not for a verdict (their seeds are other seeds).
      const config = parse<any>(r.config_json, {});
      const sp = Number(config.scenarios?.species?.[0]), map = config.scenarios?.maps?.[0], tier = config.scenarios?.tiers?.[0];
      const references: Curve['references'] = [];
      for (const policy of ['random', 'heuristic', 'idle']) {
        const fits = this.batches().filter((b) => b.policy === policy && b.status === 'completed' && b.summary && b.species[0] === sp && b.map === map && Number(b.tier) === Number(tier));
        const pick = fits.find((b) => (b.label ?? '').startsWith('baseline')) ?? fits[0];
        if (pick?.summary) references.push({ policy, label: pick.label ?? `batch ${pick.id}`, batchId: pick.id, episodes: pick.summary.episodes, scoreMedian: pick.summary.scoreMedian, scoreMean: pick.summary.scoreMean });
      }

      const throughput: Curve['throughput'] = [];
      for (const s of sessions) {
        let prevT = s.startTimesteps, prevAt = ms(s.startedAt);
        for (const c of this.cached(`ckpt-session:${s.id}`, [], (d) => this.all(d, 'SELECT timesteps, created_at FROM checkpoints WHERE session_id = ? ORDER BY timesteps', s.id))) {
          const seconds = (ms(c.created_at) - prevAt) / 1000;
          if (seconds > 0.5 && c.timesteps > prevT) throughput.push({ t: c.timesteps, at: c.created_at, decisionsPerSecond: (c.timesteps - prevT) / seconds });
          prevT = c.timesteps; prevAt = ms(c.created_at);
        }
      }

      const quarter = Math.max(1, Math.floor(rows.length / 4));
      return {
        run, episodes: rows.length, timesteps, bins, points, references, components, counters, throughput,
        summary: summarize(rows as unknown as EpisodeLite[]),
        firstQuarter: rows.length >= 8 ? summarize(rows.slice(0, quarter) as unknown as EpisodeLite[]) : null,
        lastQuarter: rows.length >= 8 ? summarize(rows.slice(-quarter) as unknown as EpisodeLite[]) : null,
      };
    });
  }

  // ---------------------------------------------------------------- breakdowns

  breakdowns(scope: string | null): Breakdowns {
    const names = this.knowledgeNames();
    const batches = this.batches(), lite = this.lite(), runs = this.runs();
    const scopes: Breakdowns['scopes'] = [
      ...runs.map((r) => ({ id: `run:${r.name}`, label: `Training run ${r.name}`, episodes: r.episodes })),
      ...batches.filter((b) => b.kind !== 'training' && b.summary).map((b) => ({ id: `batch:${b.id}`, label: b.label ?? `Batch ${b.id} (${b.policy})`, episodes: b.summary!.episodes })),
    ];
    const chosen = scopes.find((s) => s.id === scope)?.id ?? scopes[0]?.id ?? '';
    const batchIds = chosen.startsWith('run:') ? runs.find((r) => `run:${r.name}` === chosen)?.sessions.map((s) => s.batchId) ?? [] : chosen ? [Number(chosen.slice(6))] : [];

    const group = (key: (b: BatchInfo) => { key: string; label: string }): GroupRow[] => {
      const acc = new Map<string, { label: string; policy: string; batches: number; rows: EpisodeLite[] }>();
      for (const b of batches) {
        const rows = lite.get(b.id);
        if (!rows?.length) continue;
        // A training batch may hold several Pokémon: group its episodes by the one each was played with.
        const bySpecies = new Map<number, EpisodeLite[]>();
        for (const r of rows) { const l = bySpecies.get(r.species); if (l) l.push(r); else bySpecies.set(r.species, [r]); }
        for (const [species, list] of bySpecies) {
          const k = key({ ...b, species: [species] });
          const id = `${k.key}|${b.policy}`;
          const g = acc.get(id) ?? { label: k.label, policy: policyLabel(b.policy), batches: 0, rows: [] };
          g.batches++; g.rows.push(...list);
          acc.set(id, g);
        }
      }
      return [...acc.entries()].map(([k, g]) => ({ key: k, label: g.label, policy: g.policy, batches: g.batches, summary: summarize(g.rows)! })).sort((a, b) => a.label.localeCompare(b.label) || b.summary.scoreMedian - a.summary.scoreMedian);
    };

    const bySpecies = group((b) => ({ key: String(b.species[0]), label: names.species[b.species[0]] ?? `#${b.species[0]}` }));
    const byVersion = group((b) => ({ key: `${b.gameBuild}`, label: b.gameVersion ? `${b.gameVersion} (${b.gameBuild})` : String(b.gameBuild ?? 'unknown') }));

    const detail = this.cached(`choices:${batchIds.join(',')}`, { choices: [] as ChoiceRow[], picks: [] as PickRow[] }, (db) => {
      if (!batchIds.length) return { choices: [], picks: [] };
      const marks = batchIds.map(() => '?').join(',');
      const rows = this.all(db, `SELECT kills, overtime_bonus, overtime_cashed, end_cause, final_build_json FROM episodes WHERE batch_id IN (${marks})`, ...batchIds);
      const all = rows.map((r) => scoreOf(r as EpisodeLite));
      const held = new Map<string, { kind: ChoiceRow['kind']; key: string; name: string; index: Set<number>; levels: number[] }>();
      rows.forEach((r, i) => {
        const b = parse<any>(r.final_build_json, null);
        if (!b) return;
        const add = (kind: ChoiceRow['kind'], key: string, name: string, level: number | null) => {
          const id = `${kind}:${key}`;
          const h = held.get(id) ?? { kind, key, name, index: new Set<number>(), levels: [] };
          h.index.add(i);
          if (level != null) h.levels.push(level);
          held.set(id, h);
        };
        for (const m of b.moves ?? []) add('move', m.key, m.name ?? m.key, m.level ?? null);
        for (const v of b.vitamins ?? []) add('vitamin', v.key, names.items[v.key] ?? v.key, v.level ?? null);
        for (const it of b.items ?? []) add('item', it.key, names.items[it.key] ?? it.key, it.count ?? null);
        for (const k of b.relics ?? []) add('relic', k, names.items[k] ?? k, null);
      });
      const choices: ChoiceRow[] = [...held.values()].map((h) => {
        const withScores: number[] = [], without: number[] = [];
        all.forEach((s, i) => (h.index.has(i) ? withScores : without).push(s));
        return { kind: h.kind, key: h.key, name: h.name, episodes: withScores.length, share: withScores.length / Math.max(1, all.length), scoreMedianWith: median(withScores), scoreMedianWithout: without.length ? median(without) : null, meanLevel: h.levels.length ? mean(h.levels) : null };
      }).sort((a, b) => b.episodes - a.episodes || b.scoreMedianWith - a.scoreMedianWith);

      const totals = new Map<string, number>();
      const counted = this.all(db, `SELECT d.kind, d.chosen_id, COUNT(*) n, MIN(d.id) example FROM decisions d JOIN episodes e ON e.id = d.episode_id WHERE e.batch_id IN (${marks}) GROUP BY d.kind, d.chosen_id`, ...batchIds);
      for (const c of counted) totals.set(c.kind, (totals.get(c.kind) ?? 0) + c.n);
      const top = counted.sort((a, b) => b.n - a.n).slice(0, 80);
      const picks: PickRow[] = top.map((c) => {
        const ex = this.all(db, 'SELECT options_json, chosen_json FROM decisions WHERE id = ?', c.example)[0];
        const options = parse<any[]>(ex?.options_json, []), picked = parse<any>(ex?.chosen_json, {});
        const label = picked.extra ? `${picked.extra}${picked.target != null ? `: ${options[picked.target]?.label ?? ''}` : ''}` : options[picked.option]?.label || String(c.chosen_id);
        return { kind: c.kind, chosen: c.chosen_id, label: String(label).slice(0, 80), times: c.n, share: c.n / (totals.get(c.kind) ?? c.n) };
      });
      return { choices, picks };
    });

    const scopeRows = batchIds.flatMap((id) => lite.get(id) ?? []);
    return { scopes, scope: chosen, bySpecies, byVersion, choices: detail.choices, picks: detail.picks, scopeSummary: summarize(scopeRows), names: { species: names.species } };
  }

  // ---------------------------------------------------------------- single episodes

  private toEpisodeRow(r: Row): EpisodeRow {
    return {
      id: r.id, batchId: r.batch_id, seed: r.seed, species: r.species, map: r.map, tier: r.tier, endCause: r.end_cause, gameTime: r.game_time, kills: r.kills, score: scoreOf(r as EpisodeLite),
      level: r.level, zone: r.zone, guardians: r.guardians_defeated, victory: !!r.victory, overtimeCashed: !!r.overtime_cashed, overtimeBonus: r.overtime_bonus, decisions: r.decision_count,
      storedDecisions: r.stored ?? 0, finishedAt: r.finished_at, reward: r.reward ?? null,
    };
  }

  episodes(batchId: number, limit = 400): EpisodeRow[] {
    return this.cached(`episodes:${batchId}:${limit}`, [], (db) => this.all(db, `SELECT e.id, e.batch_id, e.seed, e.species, e.map, e.tier, e.end_cause, e.game_time, e.kills, e.overtime_bonus, e.overtime_cashed,
        e.level, e.zone, e.guardians_defeated, e.victory, e.decision_count, e.finished_at, w.total reward, (SELECT COUNT(*) FROM decisions d WHERE d.episode_id = e.id) stored
      FROM episodes e LEFT JOIN episode_rewards w ON w.episode_id = e.id WHERE e.batch_id = ? ORDER BY e.id DESC LIMIT ?`, batchId, limit).map((r) => this.toEpisodeRow(r)));
  }

  episode(id: number): EpisodeDetail | null {
    return this.cached(`episode:${id}`, null, (db) => {
      const r = this.all(db, `SELECT e.*, w.total reward, w.components_json, (SELECT COUNT(*) FROM decisions d WHERE d.episode_id = e.id) stored FROM episodes e LEFT JOIN episode_rewards w ON w.episode_id = e.id WHERE e.id = ?`, id)[0];
      if (!r) return null;
      const batch = this.batches().find((b) => b.id === r.batch_id)!;
      const names = this.knowledgeNames(), b = parse<any>(r.final_build_json, null);
      const timeline = this.all(db, 'SELECT serial, game_time, zone, level, kind, chosen_id, options_json, mask_json, chosen_json FROM decisions WHERE episode_id = ? ORDER BY serial LIMIT 600', id).map((d) => {
        const options = parse<any[]>(d.options_json, []), mask = parse<any>(d.mask_json, {}), picked = parse<any>(d.chosen_json, {});
        const chosen = picked.extra ? `${picked.extra}${picked.target != null ? `: ${options[picked.target]?.label ?? ''}` : ''}` : options[picked.option]?.label || String(d.chosen_id);
        return { serial: d.serial, gameTime: d.game_time, zone: d.zone, level: d.level, kind: d.kind, chosen: String(chosen), options: options.slice(0, 12).map((o, i) => ({ id: String(o.id), label: String(o.label || o.id), valid: mask.options?.[i] !== false })) };
      });
      const ev = batch.kind === 'evaluation' ? this.evaluationRows().find((e) => e.batch_id === r.batch_id) : null;
      return {
        ...this.toEpisodeRow(r), batch,
        build: b ? {
          level: b.level, maxHp: b.maxHp,
          moves: (b.moves ?? []).map((m: any) => ({ name: m.name ?? m.key, key: m.key, level: m.level, type: m.type, damageDone: Number(m.damageDone ?? 0), fusion: !!m.fusion })),
          vitamins: (b.vitamins ?? []).map((v: any) => ({ key: v.key, name: names.items[v.key] ?? v.key, level: v.level })),
          items: (b.items ?? []).map((it: any) => ({ key: it.key, name: names.items[it.key] ?? it.key, count: it.count })),
          relics: (b.relics ?? []).map((k: string) => ({ key: k, name: names.items[k] ?? k })),
        } : null,
        counters: parse(r.counters_json, {}), rewardComponents: parse(r.components_json, null), timeline,
        replay: ev ? { model: ev.model_path, seed: r.seed, deterministic: !!ev.deterministic } : null,
      };
    });
  }

  // ---------------------------------------------------------------- models

  private verdicts(): Map<string, { evaluationId: number; passed: boolean }> {
    const out = new Map<string, { evaluationId: number; passed: boolean }>();
    // Newest first: the first judged evaluation seen for a file is the one the registry's promotion rule looks at.
    for (const e of this.evaluationRows()) if (e.passed != null && !out.has(e.model_sha256)) out.set(e.model_sha256, { evaluationId: e.id, passed: !!e.passed });
    return out;
  }

  modelList(): ModelInfo[] {
    return this.cached('models', [], (db) => {
      const verdicts = this.verdicts();
      return this.all(db, 'SELECT m.*, r.name run FROM models m LEFT JOIN training_runs r ON r.id = m.run_id ORDER BY m.id DESC').map((m): ModelInfo => ({
        id: m.id, role: m.role, createdAt: m.created_at, sha256: m.sha256, run: m.run, timesteps: m.timesteps, evaluationId: m.evaluation_id, note: m.note, path: m.path, verdict: verdicts.get(m.sha256) ?? null,
      }));
    });
  }

  models(): ModelsView {
    const models = this.modelList();
    const stable = models.find((m) => m.role === 'stable') ?? null;
    const pointerFile = join(this.ctx.models, 'stable', 'current.json');
    const pointer = existsSync(pointerFile) ? parse<any>(readFileSync(pointerFile, 'utf8'), null) : null;
    let stableFiles: ModelsView['stableFiles'] = [];
    if (stable && existsSync(stable.path)) {
      try { stableFiles = readdirSync(stable.path).map((name) => ({ name, bytes: statSync(join(stable.path, name)).size })); } catch { /* shown as empty */ }
    }
    const events = this.cached('modelEvents', [], (db) => this.all(db, 'SELECT * FROM model_events ORDER BY id DESC LIMIT 100').map((e) => ({ id: e.id, at: e.at, action: e.action, modelId: e.model_id, previousStableId: e.previous_stable_id, evaluationId: e.evaluation_id, note: e.note })));
    return { stable, pointer, models, events, stableFiles };
  }

  // ---------------------------------------------------------------- totals

  totals(): { trainingEpisodes: number; trainingSteps: number; runs: number; evaluations: number; scriptedEpisodes: number; errors: number; schemaVersion: number | null; builds: { build: string; version: string | null }[] } {
    const runs = this.runs(), batches = this.batches();
    const count = (kind: BatchInfo['kind']) => batches.reduce((n, b) => n + (b.kind === kind ? b.summary?.episodes ?? 0 : 0), 0);
    const builds = new Map<string, string | null>();
    for (const b of batches) if (b.gameBuild) builds.set(b.gameBuild, b.gameVersion);
    const schemaVersion = this.cached<number | null>('schema', null, (db) => Number((db.prepare('SELECT MAX(version) v FROM schema_version').get() as Row).v));
    return {
      trainingEpisodes: count('training'), trainingSteps: runs.reduce((n, r) => n + r.timesteps, 0), runs: runs.length, evaluations: this.evaluations().length, scriptedEpisodes: count('scripted'),
      errors: batches.reduce((n, b) => n + b.errors, 0), schemaVersion, builds: [...builds].map(([build, version]) => ({ build, version })),
    };
  }

  /** The checkpoint folder a `checkpoint:<id>` reference names, from the database (never from the request). */
  checkpointPath(id: number): string | null { return this.checkpoints().find((c) => c.id === id)?.path ?? null; }
}
