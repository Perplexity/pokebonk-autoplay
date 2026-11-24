/**
 * Unattended episode runner over the headless environment (no browser, no network).
 *
 *   node scripts/run-episodes.ts --policy=heuristic --episodes=30 --workers=4
 *   node scripts/run-episodes.ts --policy=idle --episodes=3 --seed=100 --species=25 --map=coast --tier=1
 *   node scripts/run-episodes.ts --policy=random --episodes=2 --max-time=300      safety cap on the run clock (truncated)
 *   node scripts/run-episodes.ts --policy=random --classic                        Classic instead of Ranked rules
 *
 * The parent process starts --workers worker processes (one environment each), hands out the seeds, and writes every
 * result to the SQLite database (docs/storage.md). It never loads the game itself.
 *
 * Options
 *   --policy=random|idle|heuristic     --episodes=N     --seed=S (episode i plays seed S + i)     --seeds=3,7,19 (explicit)
 *   --workers=K (default 1)            --species=<dex>  --map=<id>  --tier=0..2  --classic
 *   --max-time=<game seconds, 0 = none>   --action-repeat=3   --hz=60
 *   --max-idle=<game seconds>          end an episode as invalid after this long without a KO and without movement
 *   --max-ko-gap=<game seconds>        end an episode as invalid after this long without a KO (boss fights do not count)
 *                                      (default: no such rule; training and evaluation use 30)
 *   --recycle-after=8                  episodes per worker process before it is replaced by a fresh one (memory growth).
 *                                      1 = every episode in a fresh process (loads the game once per episode)
 *   --recycle-rss=1500                 … or as soon as it reports more resident memory than this (MB)
 *   --episode-timeout=1800             wall seconds for one episode before its worker is killed and the seed recorded as an error
 *   --db=<file>   (default data/pokebonk.sqlite)        --no-db
 *   --jsonl[=<folder>]                 also write <folder, default data/runs>/<timestamp>/episodes.jsonl and metadata.json
 *   --label=<text>                     stored with the batch
 *   --policy-options=<json>            the policy's own settings, stored with the batch (heuristic: {"tuning":{…},"heuristic":{…}})
 *   --quiet                            no line per episode
 *
 * Exit code: 0 when every episode was played and stored, 1 when anything failed (errors are in the `errors` table and
 * on stderr), 2 for a bad command line, 130 when interrupted.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BATCH, runBatch, validateConfig } from '../src/runner/pool.ts';
import type { BatchConfig } from '../src/runner/pool.ts';
import { summarize, summaryLines } from '../src/runner/report.ts';
import type { EpisodeRow } from '../src/runner/report.ts';
import { DEFAULT_DATABASE, EpisodeStore } from '../src/storage/database.ts';
import type { EpisodeRecord } from '../src/storage/records.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KNOWN = new Set(['policy', 'episodes', 'seed', 'seeds', 'workers', 'species', 'map', 'tier', 'classic', 'max-time', 'max-idle', 'max-ko-gap', 'action-repeat', 'hz', 'recycle-after', 'recycle-rss', 'episode-timeout', 'db', 'no-db', 'jsonl', 'out', 'label', 'quiet', 'policy-options']);
const args = new Map<string, string>();
const say = (s = '') => process.stdout.write(s + '\n');
const usage = (msg: string): never => { process.stderr.write(`run-episodes: ${msg}\n`); process.exit(2); };
for (const a of process.argv.slice(2)) {
  const m = /^--([\w-]+)(?:=(.*))?$/.exec(a);
  if (!m || !KNOWN.has(m[1])) usage(`unknown argument "${a}" (see the header of scripts/run-episodes.ts)`);
  else args.set(m[1], m[2] ?? 'true');
}
const num = (k: string, d: number): number => {
  if (!args.has(k)) return d;
  const v = Number(args.get(k));
  if (!Number.isFinite(v)) usage(`--${k} needs a number, got "${args.get(k)}"`);
  return v;
};

const config: BatchConfig = {
  ...DEFAULT_BATCH,
  policy: args.get('policy') ?? DEFAULT_BATCH.policy, episodes: num('episodes', 1), seed: num('seed', 1), workers: num('workers', 1),
  ...(args.has('seeds') ? { seeds: args.get('seeds')!.split(',').map(Number) } : {}),
  species: num('species', DEFAULT_BATCH.species), map: args.get('map') ?? DEFAULT_BATCH.map, tier: num('tier', DEFAULT_BATCH.tier), ranked: !args.has('classic'),
  maxGameTime: num('max-time', 0), ...(args.has('max-idle') ? { maxIdleGameTime: num('max-idle', 0) } : {}), ...(args.has('max-ko-gap') ? { maxKoGapGameTime: num('max-ko-gap', 0) } : {}), hz: num('hz', 60), actionRepeat: num('action-repeat', 3),
  recycleAfter: num('recycle-after', DEFAULT_BATCH.recycleAfter), recycleRssMB: num('recycle-rss', DEFAULT_BATCH.recycleRssMB), episodeTimeoutSec: num('episode-timeout', DEFAULT_BATCH.episodeTimeoutSec),
  label: args.get('label') ?? null,
  ...(args.has('policy-options') ? { policyOptions: JSON.parse(args.get('policy-options')!) as Record<string, unknown> } : {}),
};
try { validateConfig(config); } catch (e) { usage((e as Error).message); }

const store = args.has('no-db') ? undefined : EpisodeStore.open(args.has('db') ? resolve(ROOT, args.get('db')!) : DEFAULT_DATABASE);
let jsonlDir: string | null = null;
if (args.has('jsonl') || args.has('out')) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const base = args.get('out') ?? (args.get('jsonl') !== 'true' ? args.get('jsonl')! : join('data', 'runs'));
  jsonlDir = join(resolve(ROOT, base), stamp);
  mkdirSync(jsonlDir, { recursive: true });
}

const quiet = args.has('quiet');
const pad = (v: unknown, n: number) => String(v).padStart(n);
const line = (e: EpisodeRecord): string =>
  `${pad(e.seed, 6)}  ${pad(e.species, 7)}  ${e.map.padEnd(9)}  ${pad(e.tier, 4)}  ${pad(e.gameTime.toFixed(1), 9)}  ${pad(e.kills, 6)}  ${pad(e.level, 5)}  ${pad(e.zone, 4)}  ${pad(e.guardiansDefeated, 5)}  ${e.endCause.padEnd(34).slice(0, 34)}  ${pad(e.steps, 6)}  ${pad(e.wallSeconds.toFixed(1), 7)}  ${pad((e.simSteps / e.wallSeconds).toFixed(0), 7)}  ${pad(`${e.worker.id}/${e.worker.episode}`, 6)}  ${pad(e.worker.rssMB, 5)}`;

const interrupt = new AbortController();
process.on('SIGINT', () => { process.stderr.write('\ninterrupted: stopping the workers\n'); interrupt.abort(); });

let code = 0;
try {
  const result = await runBatch(config, {
    store, signal: interrupt.signal,
    onStart: ({ batchId, seeds, policyVersion }) => {
      say(`policy ${config.policy} (${policyVersion}), ${seeds.length} episode(s), seeds ${seeds.length > 6 ? `${seeds[0]}…${seeds[seeds.length - 1]}` : seeds.join(',')}, ${config.workers} worker(s), species ${config.species} on ${config.map} tier ${config.tier}, ${config.ranked ? 'Ranked' : 'Classic'} rules`);
      say(`${store ? `database ${store.path}, batch ${batchId}` : 'not stored (--no-db)'}${jsonlDir ? `; JSONL in ${jsonlDir}` : ''}`);
      if (!quiet) say('  seed  species  map        tier  game time     KOs  level  zone  guard  cause of end                         steps   wall s  steps/s  worker    MB');
    },
    onMetadata: (m) => {
      if (jsonlDir) writeFileSync(join(jsonlDir, 'metadata.json'), JSON.stringify(m.full, null, 2));
      say(`game build ${m.gameBuild} (${m.gameVersion ?? '?'}), profile preset ${m.profilePreset}, schemas obs ${m.observationSchema} / action ${m.actionSchema} / decision ${m.decisionSchema}`);
    },
    onEpisode: (e) => {
      if (!quiet) say(line(e));
      if (jsonlDir) appendFileSync(join(jsonlDir, 'episodes.jsonl'), JSON.stringify({ policy: config.policy, ...e }) + '\n');
      if (e.blockedNetwork.length) process.stderr.write(`seed ${e.seed}: ${e.blockedNetwork.length} blocked network attempt(s): ${e.blockedNetwork.slice(0, 3).join('; ')}\n`);
    },
    onError: (e) => { process.stderr.write(`ERROR [${e.kind}] ${e.message}\n${typeof e.details.stack === 'string' ? e.details.stack.split('\n').slice(0, 12).join('\n') + '\n' : ''}`); },
    // (With one episode per process every worker is "recycled": not worth a line each.)
    onWorker: (w) => { if (!quiet && w.what !== 'started' && w.what !== 'exited' && !(w.what === 'recycled' && config.recycleAfter === 1)) say(`        worker ${w.workerId} ${w.what}: ${w.detail}`); },
  });

  const rows: EpisodeRow[] = result.episodes.map((e) => ({
    seed: e.seed, kills: e.kills, game_time: e.gameTime, level: e.level, zone: e.zone, guardians_defeated: e.guardiansDefeated, legendaries_defeated: e.legendariesDefeated,
    end_cause: e.endCause, victory: e.victory ? 1 : 0, overtime_started: e.overtime.started ? 1 : 0, overtime_bonus: e.overtime.bonus, overtime_cashed: e.overtime.cashed ? 1 : 0, sim_steps: e.simSteps, wall_seconds: e.wallSeconds,
  }));
  say();
  say(`batch ${result.batchId ?? '(not stored)'} ${result.status}: ${result.episodes.length}/${result.seeds.length} episodes, ${result.errors.length} error(s), ${result.wallSeconds.toFixed(1)} s wall`);
  if (rows.length) for (const l of summaryLines(summarize(rows))) say(`  ${l}`);
  say(`  throughput     ${result.episodesPerHour.toFixed(0)} episodes/hour, ${result.simStepsPerSecond.toFixed(0)} simulation steps/s over all workers (${result.simSteps} steps); ${result.workersStarted} worker process(es) started, peak worker memory ${result.peakWorkerRssMB} MB`);
  code = result.status === 'completed' ? 0 : result.status === 'interrupted' ? 130 : 1;
} catch (e) {
  process.stderr.write(`run-episodes failed: ${(e as Error)?.stack ?? e}\n`);
  code = 1;
}
store?.close();
process.exit(code);
