/**
 * CHEATING PROBE. Not an agent, not part of the environment, never used for training.
 *
 * It exists to reach situations no baseline policy survives to (guardians, the sanctuary, overtime) so that what the game
 * does there can be observed: the facts marked [V*] in docs/game-mechanics.md. It drives the environment like an agent
 * (reset / step / decisions), and additionally writes to game objects directly: full heal every step, teleport to map
 * points, guardian HP set to 1.
 *
 *   node scripts/probes/lifecycle-cheat-probe.ts --seed=1 --path=sanct --seals=all --rounds=3 --exit=portal
 *   node scripts/probes/lifecycle-cheat-probe.ts --seed=2 --path=direct --seals=none --rounds=1 --exit=die
 *   node scripts/probes/lifecycle-cheat-probe.ts --seed=2 --path=sanct --seals=none --exit=leaveNoOt
 *   … --digest [--before=77,78]     print a digest of every step (same seed: fresh process vs. after other episodes)
 *
 * Options: --path=sanct|direct  --seals=all|none  --rounds=N (overtime rounds before leaving)  --exit=portal|die|leaveNoOt
 *          --wake=<zone seconds before waking a guardian, default 20>  --map  --species  --tier  --ranked=0|1  --budget=<wall s>
 */
import { createHash } from 'node:crypto';
import { createEnvironment, validChoices } from '../../src/environment/index.ts';
import type { Action, ChoiceMask, Observation, PlayMask } from '../../src/environment/index.ts';
import { real } from '../../src/sim/clock.ts';
const args = new Map<string, string>();
for (const a of process.argv.slice(2)) { const m = /^--([\w-]+)(?:=(.*))?$/.exec(a); if (m) args.set(m[1], m[2] ?? 'true'); }
const num = (k: string, d: number) => (args.has(k) ? Number(args.get(k)) : d);
const say = (s: string) => process.stdout.write(s + '\n');
const PATH = args.get('path') ?? 'sanct', SEALS = args.get('seals') ?? 'all', ROUNDS = num('rounds', 3), EXIT = args.get('exit') ?? 'portal', WAKE = num('wake', 20);
const env = createEnvironment({ map: args.get('map') ?? 'forest', species: num('species', 155), tier: num('tier', 0), ranked: num('ranked', 1) === 1 });
const before = (args.get('before') ?? '').split(',').filter(Boolean).map(Number);
for (const s of before) { let o = await env.reset({ seed: s }); for (let i = 0; i < 200; i++) { const r = await env.step(o.phase === 'choice' ? validChoices(o.mask as ChoiceMask)[0] : { type: 'play', move: 1 + (i % 8) }); o = r.observation; if (r.terminated) break; } }
const seed = num('seed', 1);
let obs: Observation = await env.reset({ seed });
const run = () => env.debug.sim!.run;
const hash = createHash('sha256');
const seen = new Set<string>();
const log = (s: string) => say(`[t=${run().time.toFixed(1)} z${run().stage} zt=${run().stageTime.toFixed(0)} k=${run().stats.kills} L${run().player.level}] ${s}`);
const tp = (x: number, z: number) => { const p = run().player; p.pos.x = x; p.pos.z = z; p.pos.y = run().terrain.height(x, z); p.vel.set(0, 0, 0); };
let lastStage = 0, interactCd = 0, otRoundSeen = -1, res: any = null, steps = 0, portalTries = 0;
const t0 = real.performanceNow();
function choose(o: Observation): Action {
  const d = o.decision!, mask = o.mask as ChoiceMask;
  if (!seen.has(d.kind)) { seen.add(d.kind); log(`DIALOG ${d.kind} (${d.method}) "${d.title}" options=${JSON.stringify(d.options.map((x) => x.id))} extras=${JSON.stringify(Object.keys(d.extras))} ctx=${JSON.stringify(d.context).slice(0, 300)} mask=${JSON.stringify(mask).slice(0, 200)}`); }
  const pick = (id: string): Action => ({ type: 'choice', option: d.options.findIndex((x) => x.id === id) });
  switch (d.kind) {
    case 'seals': return SEALS === 'all' ? { type: 'choice', option: d.options.length - 1 } : pick('none');
    case 'sanctuaryPath': return pick(PATH);
    case 'leaveSanctuary': return pick(EXIT === 'leaveNoOt' ? 'leave' : 'ot');
    case 'overtimeStart': return { type: 'choice', option: 0 };
    case 'overtimeOffer': return { type: 'choice', option: 0 };
    case 'shop': case 'dojo': case 'slots': case 'forget': case 'fusion': return { type: 'choice', extra: 'leave' };
    default: { const v = validChoices(mask); return v[0]; }
  }
}
for (;;) {
  const r = run();
  if (args.has('digest')) hash.update(JSON.stringify([obs.step, obs.simStep, obs.snapshot.t, obs.snapshot.player.x, obs.snapshot.player.z, obs.snapshot.player.hp, obs.snapshot.kills, obs.snapshot.player.level, obs.snapshot.enemies.count, env.debug.sim!.entropy.mathCalls(), obs.phase, obs.decision?.kind ?? null, obs.decision?.options.map((x) => x.id) ?? null]));
  if (res?.terminated || res?.truncated) break;
  let action: Action;
  if (obs.phase === 'choice') action = choose(obs);
  else {
    const p = r.player, ot = r.overtime;
    if (!(EXIT === 'die' && ot.live && ot.round >= ROUNDS)) p.hp = p.maxHp; // CHEAT: full heal
    if (r.stage !== lastStage) { lastStage = r.stage; log(`ZONE ${r.stage} begins: sanctuary=${!!r.sanctuary} points=${JSON.stringify([...new Set(r.interactables.list.map((i: any) => i.kind))])} weather=${r.weather} liveCap=${r.liveCap}`); }
    if (ot.live && ot.round !== otRoundSeen) { otRoundSeen = ot.round; log(`OVERTIME round ${ot.round + 1}: secs=${ot.secs.toFixed(1)} mult=${ot.mult(ot.round)} bonus=${ot.bonus} drain=${ot.drain} alive=${r.enemies.count}`); }
    const pts: any[] = r.interactables.list;
    const mask = obs.mask as PlayMask;
    let interact = false;
    interactCd--;
    const B = r.boss, E = r.enemies;
    if (B?.alive && typeof B.bossIndex === 'number' && B.bossIndex >= 0 && E.alive[B.bossIndex] && !B.immune && E.hp[B.bossIndex] > 1) { E.hp[B.bossIndex] = 1; log(`CHEAT guardian ${B.name ?? E.species[B.bossIndex]} hp := 1`); }
    const goTo = (kind: string, pred: (i: any) => boolean = () => true) => {
      const it = pts.find((i) => i.kind === kind && pred(i));
      if (!it) return false;
      const rr = Number(it.r) || 2; if (Math.hypot(p.pos.x - it.x, p.pos.z - it.z) > Math.max(1.2, rr * 0.9)) { tp(it.x + Math.max(0.8, rr * 0.6), it.z); return true; }
      if (mask.interact && interactCd <= 0) { interact = true; interactCd = 8; }
      return true;
    };
    if (ot.live) {
      if (EXIT === 'portal' && ot.round >= ROUNDS) { if (goTo('portal') && interact) log('→ portal during overtime (cash)'); }
    } else if (r.regionCleared && !ot.over) {
      if (EXIT === 'leaveNoOt') { goTo('portal'); }
      else if (!goTo('shrine', (i) => i.data?.ot && !i.used)) { /* the shrine relights 4.5 s after the kill */ }
    } else if (r.stageCleared || (ot.over && r.state === 'play')) {
      if (goTo('portal') && interact && ++portalTries % 5 === 1) log('→ portal');
    } else if (!r.bossSpawned && r.stageTime >= WAKE) {
      if ((goTo('boss', (i) => !i.used) || goTo('shrine', (i) => !i.used)) && interact) log('→ guardian altar / sanctuary shrine');
    }
    action = { type: 'play', move: interact ? 0 : (r.stage === 4 && !ot.live ? 0 : 1 + (Math.floor(r.time / 3) % 8)), interact };
  }
  res = await env.step(action);
  obs = res.observation;
  if (++steps > 400000 || real.performanceNow() - t0 > num('budget', 150) * 1000) { log('probe stopped: budget'); break; }
}
const info = res?.info;
say(`END after ${steps} env steps, ${((real.performanceNow() - t0) / 1000).toFixed(1)} s wall: terminated=${res?.terminated} cause="${info?.endCause}" time=${info?.time?.toFixed(1)} kills=${info?.kills} zone=${info?.zone} overtime=${JSON.stringify(info?.overtime)} sealsKept=${info?.sealsKept}`);
if (info?.end) { const rec = info.end.record; say('RECORD ' + JSON.stringify({ victory: rec.victory, stage: rec.stage, time: rec.time, kills: rec.kills, level: rec.level, bosses: rec.bosses, legendaries: rec.legendaries, splits: rec.splits, mode: rec.mode, ot: rec.ot, seals: rec.seals, end: rec.end, clearSpecies: rec.clearSpecies }).slice(0, 1500)); }
say('dialogs seen: ' + JSON.stringify(env.debug.dialogsSeen) + ' governor: ' + JSON.stringify(env.getMetadata().governor) + ' gameErrors: ' + JSON.stringify(env.debug.sim!.browser.gameErrors).slice(0, 500));
if (args.has('digest')) say('DIGEST ' + hash.digest('hex'));
await env.close();
process.exit(0);
