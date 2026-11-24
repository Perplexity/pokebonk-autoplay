/**
 * Are two stored batches the same episodes? The check behind "a result does not depend on which worker played it, in
 * which order, or how many workers there were" (docs/baseline.md §4).
 *
 *   node scripts/compare-batches.ts --a=3 --b=4 [--db=<file>]
 *
 * For every seed both batches played, every column of `episodes` is compared except the ones that say where and how
 * fast it was played (ids, wall and reset seconds, worker id / pid / episode number / memory, wall-clock stamps), and
 * every row of `decisions` (all columns but the ids). The two batches must have been played by the same policy code on
 * the same environment (policy version, policy options, build, bundle, shims, preset, rules, rates, species, map,
 * tier, time cap); otherwise the comparison is refused.
 *
 * Exit code: 0 identical, 1 different (the differences are printed), 2 not comparable or bad arguments.
 */
import { resolve } from 'node:path';
import { DEFAULT_DATABASE, EpisodeStore } from '../src/storage/database.ts';

type Row = Record<string, unknown>;
const args = new Map<string, string>();
for (const a of process.argv.slice(2)) { const m = /^--([\w-]+)(?:=(.*))?$/.exec(a); if (m) args.set(m[1], m[2] ?? 'true'); }
const say = (s = '') => process.stdout.write(s + '\n');
const stop = (msg: string): never => { process.stderr.write(`compare-batches: ${msg}\n`); process.exit(2); };
if (!args.has('a') || !args.has('b')) stop('needs --a=<batch id> --b=<batch id>');

/** Columns that describe where and how fast an episode was played, not what happened in it. */
export const NOT_COMPARED = ['id', 'batch_id', 'wall_seconds', 'reset_seconds', 'worker_id', 'worker_pid', 'worker_episode', 'worker_rss_mb', 'started_at', 'finished_at'];
const SAME_SETUP = ['policy_name', 'policy_version', 'game_build', 'bundle_sha256', 'shim_hash', 'observation_schema', 'action_schema', 'decision_schema', 'snapshot_schema', 'profile_preset', 'ranked', 'hz', 'action_repeat'];
const SAME_CONFIG = ['species', 'map', 'tier', 'ranked', 'maxGameTime', 'policyOptions'];

const store = EpisodeStore.open(args.has('db') ? resolve(args.get('db')!) : DEFAULT_DATABASE);
let code = 0;
try {
  const [a, b] = [Number(args.get('a')), Number(args.get('b'))].map((id) => store.batch(id) ?? stop(`no batch ${id} in ${store.path}`));
  const cfgA = JSON.parse(String(a.config_json)) as Row, cfgB = JSON.parse(String(b.config_json)) as Row;
  const setup = [...SAME_SETUP.filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k]} / ${b[k]}`), ...SAME_CONFIG.filter((k) => JSON.stringify(cfgA[k] ?? null) !== JSON.stringify(cfgB[k] ?? null)).map((k) => `config.${k}: ${JSON.stringify(cfgA[k])} / ${JSON.stringify(cfgB[k])}`)];
  if (setup.length) stop(`batches ${a.id} and ${b.id} were not played the same way, so they cannot be expected to agree:\n  ${setup.join('\n  ')}`);

  const epsA = new Map(store.episodes(Number(a.id)).map((r) => [Number(r.seed), r])), epsB = new Map(store.episodes(Number(b.id)).map((r) => [Number(r.seed), r]));
  const seeds = [...epsA.keys()].filter((s) => epsB.has(s)).sort((x, y) => x - y);
  if (!seeds.length) stop(`batches ${a.id} and ${b.id} have no seed in common`);
  const only = (x: Map<number, Row>, y: Map<number, Row>) => [...x.keys()].filter((s) => !y.has(s));
  say(`batch ${a.id} (${cfgA.workers} worker(s), ${epsA.size} episodes) against batch ${b.id} (${cfgB.workers} worker(s), ${epsB.size} episodes): ${a.policy_name} ${a.policy_version}, preset ${a.profile_preset}, build ${a.game_build}`);
  say(`${seeds.length} seed(s) in common${only(epsA, epsB).length ? `; only in ${a.id}: ${only(epsA, epsB).join(',')}` : ''}${only(epsB, epsA).length ? `; only in ${b.id}: ${only(epsB, epsA).join(',')}` : ''}`);

  let different = 0, columns = 0, decisions = 0, simSteps = 0;
  for (const seed of seeds) {
    const x = epsA.get(seed)!, y = epsB.get(seed)!;
    const diffs: string[] = [];
    const keys = Object.keys(x).filter((k) => !NOT_COMPARED.includes(k));
    columns = keys.length;
    for (const k of keys) if (x[k] !== y[k]) diffs.push(`${k}: ${String(x[k]).slice(0, 120)} / ${String(y[k]).slice(0, 120)}`);
    const dx = store.decisions(Number(x.id)), dy = store.decisions(Number(y.id));
    if (dx.length !== dy.length) diffs.push(`decisions: ${dx.length} / ${dy.length}`);
    for (let i = 0; i < Math.min(dx.length, dy.length); i++) {
      const bad = Object.keys(dx[i]).filter((k) => k !== 'id' && k !== 'episode_id' && dx[i][k] !== dy[i][k]);
      if (bad.length) { diffs.push(`decision ${dx[i].serial} (${dx[i].kind} at ${Number(dx[i].game_time).toFixed(2)} s): ${bad.join(', ')} differ`); break; }
    }
    decisions += dx.length; simSteps += Number(x.sim_steps);
    if (diffs.length) { different++; say(`seed ${seed}: DIFFERENT (worker ${x.worker_id}/${x.worker_episode} against ${y.worker_id}/${y.worker_episode})`); for (const d of diffs.slice(0, 12)) say(`    ${d}`); }
    else if (args.has('verbose')) say(`seed ${seed}: identical (${Number(x.game_time).toFixed(1)} s, ${x.kills} KOs, ${x.sim_steps} simulation steps, ${dx.length} decisions; worker ${x.worker_id}/${x.worker_episode} against ${y.worker_id}/${y.worker_episode})`);
  }
  say(different ? `${different} of ${seeds.length} seed(s) DIFFER` : `identical: ${seeds.length} episode(s), ${columns} columns each (all but ${NOT_COMPARED.join(', ')}), ${decisions} decisions, ${simSteps} simulation steps`);
  code = different ? 1 : 0;
} finally { store.close(); }
process.exit(code);
