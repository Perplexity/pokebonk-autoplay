/**
 * One episode of the heuristic baseline with a readable trace: what it intends, every dialog it answers and why, the
 * state of each guardian fight, and how the run ended. For looking at behaviour, not for collecting data (that is
 * scripts/run-episodes.ts).
 *
 *   node scripts/heuristic-trace.ts --seed=3
 *   node scripts/heuristic-trace.ts --seed=3 --species=25 --map=coast --tier=1 --max-time=900 --quiet
 *
 * Options: --seed  --species  --map  --tier  --max-time=<game s>  --quiet (decisions and milestones only)
 *          --decisions=<file.jsonl> (append every decision with the answer given: fixtures for tests)
 *          --tuning=<json> (brain tuning overrides)  --heuristic=<json> (lifecycle overrides)
 *          --watch=<intent> (every fifth step of that intent in detail)  --effects=all (also what level-up picks changed)
 */
import { appendFileSync } from 'node:fs';
import { createEnvironment } from '../src/environment/index.ts';
import type { StepResult } from '../src/environment/index.ts';
import { heuristicPolicy } from '../src/agents/heuristic/index.ts';
import { real } from '../src/sim/clock.ts';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) { const m = /^--([\w-]+)(?:=(.*))?$/.exec(a); if (m) args.set(m[1], m[2] ?? 'true'); }
const num = (k: string, d: number) => (args.has(k) ? Number(args.get(k)) : d);
const say = (s: string) => process.stdout.write(s + '\n');
const quiet = args.has('quiet');

const env = createEnvironment({ species: num('species', 155), map: args.get('map') ?? 'forest', tier: num('tier', 0), maxGameTime: num('max-time', 0) });
const seed = num('seed', 1);
let obs = await env.reset({ seed });
const BIG = /boss|wake|portal|cash|leash|flee|capture|visit/;
let lastSmall = -99;
const policy = heuristicPolicy({
  planRoute: (x, z) => env.planRoute(x, z),
  tuning: args.has('tuning') ? JSON.parse(args.get('tuning')!) : undefined,
  heuristic: args.has('heuristic') ? JSON.parse(args.get('heuristic')!) : undefined,
  onEvent: (e) => {
    const s = obs.snapshot;
    const head = `[${e.t.toFixed(1).padStart(7)}s z${s.stage} lv${String(s.player.level).padStart(2)} hp${String(Math.round((s.player.hp / Math.max(1, s.player.maxHp)) * 100)).padStart(3)}% ko${String(s.kills).padStart(5)}]`;
    if (e.what.startsWith('choice:')) { if (!quiet || !/levelup|item/.test(e.what)) say(`${head} ${e.what}  ${e.detail}`); return; }
    if (quiet && !BIG.test(e.what)) return;
    if (!BIG.test(e.what)) { if (e.t - lastSmall < 5) return; lastSmall = e.t; }
    say(`${head} ${e.what}  ${e.detail}`);
  },
});
policy.reset(seed);
const t0 = real.performanceNow();
let res: StepResult | null = null, zone = 0, bossLog = -99, hpLog = 0, minHp = 1;
const kinds: Record<string, number> = {};
for (;;) {
  const s = obs.snapshot;
  if (s.stage !== zone) { zone = s.stage; say(`=== zone ${zone} at ${s.t.toFixed(1)} s: level ${s.player.level}, ${s.kills} KOs, moves ${s.player.moves.map((m) => `${m.name} ${m.level}`).join(', ')}`); }
  if (obs.phase === 'play') {
    const live = s.boss && s.bossSpawned && !s.stageCleared ? s.boss : null;
    if (live && s.t - bossLog >= 5) { bossLog = s.t; say(`    guardian ${live.name} ${Math.round((live.hp / Math.max(1, live.maxHp)) * 100)}% (${Math.round(live.hp)}/${Math.round(live.maxHp)}) fight ${live.fightT.toFixed(0)} s · me ${Math.round(s.player.hp)}/${Math.round(s.player.maxHp)} · ${s.enemies.count} enemies · ${policy.state.intent}`); }
    minHp = Math.min(minHp, s.player.hp / Math.max(1, s.player.maxHp));
    if (!quiet && s.t - hpLog >= 30) { hpLog = s.t; say(`    t=${s.t.toFixed(0)} zone ${s.stage} (${s.stageTime.toFixed(0)} s) lv ${s.player.level} hp ${Math.round(s.player.hp)}/${Math.round(s.player.maxHp)} (min ${Math.round(minHp * 100)}%) KOs ${s.kills} enemies ${s.enemies.count} ult ${Math.round(s.ult.charge * 100)}% · ${policy.state.intent}: ${policy.state.note}`); minHp = 1; }
  }
  const action = policy.act(obs);
  // --watch=<intent>: every fifth step of that intent in detail (where the player is, what is near, what was pressed).
  if (obs.phase === 'play' && args.get('watch') === policy.state.intent && obs.step % 5 === 0) {
    const near = [...s.points].sort((a, b) => a.d - b.d).slice(0, 3).map((q) => `${q.kind}${q.used ? '(used)' : ''} ${q.d.toFixed(1)} m`).join(', ');
    say(`      [${s.t.toFixed(2)}] at (${s.player.x.toFixed(1)}, ${s.player.z.toFixed(1)}) hp ${Math.round(s.player.hp)} grounded ${s.player.grounded} · near: ${near} · n3 ${s.enemies.list.filter((e) => Math.hypot(e[1] - s.player.x, e[2] - s.player.z) < 3.5).length} · hazards ${s.hazards.length}${s.hazards.length ? ` (${[...new Set(s.hazards.map((h) => h.kind))].join(',')}; nearest ${Math.min(...s.hazards.map((h) => Math.hypot(h.x - s.player.x, h.z - s.player.z) - h.r)).toFixed(1)} m)` : ''} shots ${s.shots.length} waves ${s.waves.length} · portal at ${s.points.filter((q) => q.kind === 'portal').map((q) => `(${q.x}, ${q.z})`).join('')} · mask.interact ${(obs.mask as { interact?: boolean }).interact} · ${JSON.stringify(action)} · ${policy.state.note}`);
  }
  if (obs.phase === 'choice') {
    kinds[obs.decision!.kind] = (kinds[obs.decision!.kind] ?? 0) + 1;
    if (args.has('decisions')) appendFileSync(args.get('decisions')!, JSON.stringify({ seed, t: s.t, zone: s.stage, level: s.player.level, decision: obs.decision, mask: obs.mask, action, player: { hp: s.player.hp, maxHp: s.player.maxHp, moves: s.player.moves, moveSlots: s.player.moveSlots, vitamins: s.player.vitamins, vitaminSlots: s.player.vitaminSlots, items: s.player.items, species: s.player.species }, gold: s.gold }) + '\n');
  }
  const before = obs;
  res = await env.step(action);
  obs = res.observation;
  // What answering a dialog changed (level-ups aside, unless --effects=all): the evidence that the answer reached the game.
  if (before.phase === 'choice' && (args.get('effects') === 'all' || !/^(levelup)$/.test(before.decision!.kind))) {
    const a = before.snapshot, b = obs.snapshot, diff: string[] = [];
    const maps = (name: string, x: Record<string, number>, y: Record<string, number>) => { for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) if ((x[k] ?? 0) !== (y[k] ?? 0)) diff.push(`${name}.${k} ${x[k] ?? 0}→${y[k] ?? 0}`); };
    maps('items', a.player.items, b.player.items); maps('vitamins', a.player.vitamins, b.player.vitamins);
    maps('moves', Object.fromEntries(a.player.moves.map((m) => [m.key, m.level])), Object.fromEntries(b.player.moves.map((m) => [m.key, m.level])));
    maps('stats', a.player.stats, b.player.stats);
    for (const k of ['gold', 'stage', 'bossSpawned', 'stageCleared', 'pendingLevels', 'state'] as const) if (a[k] !== b[k]) diff.push(`${k} ${a[k]}→${b[k]}`);
    for (const k of ['species', 'level', 'maxHp', 'moveSlots', 'vitaminSlots'] as const) if (a.player[k] !== b.player[k]) diff.push(`player.${k} ${a.player[k]}→${b.player[k]}`);
    if (!!a.boss !== !!b.boss) diff.push(`boss ${a.boss?.name ?? 'none'}→${b.boss?.name ?? 'none'}`);
    const next = obs.phase === 'choice' ? ` · next dialog: ${obs.decision!.kind}` : '';
    say(`        effect of ${before.decision!.kind} ← ${JSON.stringify(action)}: ${diff.join(', ') || 'no change in the observation'}${next} · overtime ${res.info.overtime?.live ? `live, round ${res.info.overtime.round}` : 'off'}`);
  }
  if (res.terminated || res.truncated) break;
}
const wall = (real.performanceNow() - t0) / 1000, info = res.info, s = obs.snapshot;
say(`END ${info.endCause}: ${info.time.toFixed(1)} s, ${info.kills} KOs, level ${info.level}, zone ${info.zone}, overtime ${JSON.stringify(info.overtime)}, seals kept ${info.sealsKept}`);
say(`    moves ${s.player.moves.map((m) => `${m.name} ${m.level}`).join(', ')} · vitamins ${JSON.stringify(s.player.vitamins)} · items ${JSON.stringify(s.player.items)}`);
say(`    decisions ${JSON.stringify(kinds)} · ${obs.step} steps, ${obs.simStep} sim steps in ${wall.toFixed(1)} s wall (${(obs.simStep / wall).toFixed(0)} steps/s)`);
if (info.end) { const r = info.end.record as Record<string, any>; say(`    record: bosses ${r.bosses}, legendaries ${r.legendaries}, splits ${JSON.stringify(r.splits)}, ot ${JSON.stringify(r.ot)}, end ${JSON.stringify(r.end)}`); }
await env.close();
process.exit(0);
