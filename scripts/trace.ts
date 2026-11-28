/**
 * One run of the player with a readable trace: the zone's state, what the player intends, every dialog it answers and
 * why, the moves it holds, and how the run ended. For looking at behaviour; batches are scripts/run-episodes.ts.
 *
 *   node scripts/trace.ts --seed=3
 *   node scripts/trace.ts --seed=28 --from=900 --max-time=1300 --plan='{"leaveHp":0.5}'
 *
 * Options: --seed  --species=150  --map=forest  --tier=2  --max-time=<game s, default 7200>
 *          --archive=stack-2 | none   --build-plan=kit-1 | none   (the account the run is played on)
 *          --plan=<json>   keys of the plan to replace (src/player/plan.ts)
 *          --from=<game s> print nothing before this moment     --levelups  also print every level-up answer
 *          --hp=<from>-<to> between these game seconds, a line every half second: HP, hits, enemies near
 */
import { writeSync } from 'node:fs';
import { createEnvironment } from '../src/environment/index.ts';
import type { StepResult } from '../src/environment/index.ts';
import { E_FLAGS, E_X, E_Z, EF } from '../src/observations/snapshot.ts';
import { accountOptions } from '../src/player/plan.ts';
import { hordeHit, playerPolicy } from '../src/player/policy.ts';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) { const m = /^--([\w-]+)(?:=(.*))?$/.exec(a); if (m) args.set(m[1], m[2] ?? 'true'); }
const num = (k: string, d: number) => (args.has(k) ? Number(args.get(k)) : d);
const say = (s: string) => writeSync(1, s + '\n');
const seed = num('seed', 1), from = num('from', 0), hpWindow = (args.get('hp') ?? '').split('-').map(Number);

const env = createEnvironment({
  species: num('species', 150), map: args.get('map') ?? 'forest', tier: num('tier', 2), ranked: true, maxGameTime: num('max-time', 7200),
  ...accountOptions(num('species', 150), { ...(args.has('archive') ? { archive: args.get('archive')! } : {}), ...(args.has('build-plan') ? { buildPlan: args.get('build-plan')! } : {}) }),
});
let obs = await env.reset({ seed });
const events: string[] = [];
const policy = playerPolicy({
  planRoute: (x, z) => env.planRoute(x, z),
  build: env.getMetadata().game.build,
  plan: args.has('plan') ? JSON.parse(args.get('plan')!) : undefined,
  onEvent: (e) => { if (e.t >= from && (args.has('levelups') || !/^choice:levelup/.test(e.what))) events.push(`${Math.round(e.t)}s ${e.what}: ${e.detail}`); },
});
policy.reset(seed);
const movesOf = (o: typeof obs): string => o.state.build.moves.map((m) => (m ? `${m.key}${m.linked ? '+' + m.linked : ''}:${m.level}` : '-')).join(' | ');
let res: StepResult | null = null, last = '', lastMoves = '', nextHp = 0, lastHp = 0;
for (;;) {
  const s = obs.snapshot, st = obs.state;
  const sig = `zone ${s.stage} guardian ${s.bossSpawned ? (st.stageCleared ? 'fallen' : 'awake') : 'asleep'}${st.zone.finalSwarm ? ', final swarm' : ''}${st.overtime.live ? `, Overtime round ${st.overtime.round}` : ''}`;
  if (sig !== last && s.t >= from) say(`## ${Math.round(s.t)}s (zone clock ${Math.round(s.stageTime)}s) level ${s.player.level}, HP ${Math.round(s.player.hp)} of ${Math.round(s.player.maxHp)}, ${s.kills} KOs: ${sig}`);
  last = sig;
  const mv = movesOf(obs);
  if (mv !== lastMoves && s.t >= from) say(`   moves: ${mv}`);
  lastMoves = mv;
  while (events.length) say('    ' + events.shift());
  if (hpWindow.length === 2 && s.t >= hpWindow[0] && s.t <= hpWindow[1] && (s.t >= nextHp || s.player.hp < lastHp - 1)) {
    nextHp = s.t + 0.5;
    const d = (s.enemies?.list ?? []).filter((e) => !(e[E_FLAGS] & (EF.Capture | EF.Object))).map((e) => Math.hypot(e[E_X] - s.player.x, e[E_Z] - s.player.z));
    const within = (r: number) => d.filter((x) => x <= r).length;
    say(`      ${s.t.toFixed(1)}s HP ${Math.round(s.player.hp)}/${Math.round(s.player.maxHp)}${s.player.hp < lastHp - 1 ? ` HIT -${Math.round(lastHp - s.player.hp)}` : ''} | enemies ${d.length}, within 2 m ${within(2)}, 4 m ${within(4)}, 8 m ${within(8)} | a hit of the horde ${hordeHit(s).toFixed(2)} of max HP | ${policy.state.intent}: ${policy.state.note}`);
  }
  lastHp = s.player.hp;
  res = await env.step(policy.act(obs));
  if (res.terminated || res.truncated) break;
  obs = res.observation;
}
const info = res.info, ot = info.overtime;
say(`END ${info.endCause ?? 'unknown'}: ranked KOs ${info.kills + (ot?.cashed ? ot.bonus : 0)} (${info.kills} of its own, Overtime round ${ot?.round ?? 0}, bonus ${ot?.bonus ?? 0}), ${Math.round(info.time)} s, level ${info.level}`);
say(`moves: ${movesOf(res.observation)}`);
say(`vitamins: ${res.observation.state.build.vitamins.map((v) => `${v.key}:${v.level}`).join(', ')}`);
await env.close();
process.exit(0);
