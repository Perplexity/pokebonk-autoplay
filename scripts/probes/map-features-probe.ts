/**
 * Read-only look at the run objects behind the map features (slot machine, dojo, Hypno, Bill's machine, rifts, Max
 * form): which fields exist and what they hold in a live run. It plays the heuristic baseline and prints; it changes
 * nothing in the game and stores nothing.
 *
 *   node scripts/probes/map-features-probe.ts [--seed=1] [--to=120] [--species=150]
 */
import { createEnvironment } from '../../src/environment/index.ts';
import { heuristicPolicy } from '../../src/agents/heuristic/index.ts';
import { resolveGameFns } from '../../src/environment/gamefns.ts';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) { const m = /^--([\w-]+)(?:=(.*))?$/.exec(a); if (m) args.set(m[1], m[2] ?? 'true'); }
const num = (k: string, d: number) => (args.has(k) ? Number(args.get(k)) : d);
const say = (s: string) => process.stdout.write(s + '\n');
const env = createEnvironment({ maxGameTime: num('to', 120), species: num('species', 150), map: 'forest', tier: 0 });
const seed = num('seed', 1);
let obs = await env.reset({ seed });
const sim = env.debug.sim as any;
const fns = await resolveGameFns(sim.loader.loaded, sim.pb.Run);
say('game functions: ' + JSON.stringify(fns.sources, null, 1));

const policy = heuristicPolicy({ planRoute: (x, z) => env.planRoute(x, z) });
policy.reset(seed);
const kinds = (v: any) => (v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).slice(0, 60).map((k) => [k, v[k] === null ? 'null' : Array.isArray(v[k]) ? `array(${v[k].length})` : v[k] instanceof Map ? `map(${v[k].size})` : typeof v[k] === 'object' ? 'object' : typeof v[k] === 'function' ? 'fn' : v[k]])) : v);
let dumped = false;
for (;;) {
  const res = await env.step(policy.act(obs));
  obs = res.observation;
  const run = sim.run;
  if (!dumped && run.time > num('at', 30) && obs.phase === 'play') {
    dumped = true;
    say('stats: ' + JSON.stringify(kinds(run.stats)));
    say('econ: ' + JSON.stringify(kinds(run.econ)));
    say('shop: ' + JSON.stringify(kinds(run.shop)));
    say('slots: ' + JSON.stringify({ slotSpins: run.slotSpins, slotDry: run.slotDry, slotPrizes: run.slotPrizes, slotSpent: run.slotSpent, slotLocal: run.slotLocal }));
    say('incense: ' + run.incense + ' rifts: ' + JSON.stringify(kinds(run.rifts)));
    say('rifts getters: ' + JSON.stringify({ enabled: run.rifts.enabled, incenseOn: run.rifts.incenseOn, fuseOn: run.rifts.fuseOn, canFuse: run.rifts.canFuse, isInside: run.rifts.isInside, useBlock: run.rifts.useBlock(false), useBlockFused: run.rifts.useBlock(true) }));
    const f = run.forms;
    say('forms: ' + JSON.stringify({ charges: f.charges, ready: f.ready, locked: f.locked, on: f.on, active: f.active, options: f.options(), choice: f.choice() }));
    say('dojo: ' + JSON.stringify(kinds(run.dojo)) + ' dojoStat ' + run.dojoStat + ' lessonAt ' + run.lessonAt);
    const byKind: Record<string, number[]> = {};
    for (const p of run.interactables.list) { const b = (byKind[p.kind] ??= [0, 0]); b[0]++; if (p.used) b[1]++; }
    say('map points (kind: [count, used]): ' + JSON.stringify(byKind));
    const sample = run.interactables.list.find((p: any) => p.kind === 'dojo') ?? run.interactables.list[0];
    say('a map point: ' + JSON.stringify(kinds(sample)) + ' data ' + JSON.stringify(kinds(sample?.data)));
    say('lesson: ready ' + fns.lessonReady(run) + ' key ' + fns.lessonKey(run));
    for (const belt of [1, 2, 3]) {
      const prizes = fns.dojoPrizes(run, belt);
      say(`dojo prizes belt ${belt}: ${prizes.length} → ` + JSON.stringify(prizes.slice(0, 3)) + ' stats ' + prizes.map((p: any) => p.mods[0].stat).join(','));
    }
    for (const key of ['wave', 'rush', 'circle', 'chain', 'elites', 'statue', 'race', 'master']) {
      try { say(`dojo params ${key}: ` + JSON.stringify(fns.dojoParams(run, { key, belt: 2 }))); } catch (e) { say(`dojo params ${key}: ${(e as Error).message}`); }
    }
    say('sell prices by rarity: ' + [0, 1, 2, 3, 4].map((r) => fns.sellPrice(run, r)).join(', ') + '; items table ' + fns.items.size);
    say('move prices: ' + run.player.moves.filter(Boolean).map((m: any) => `${m.def.key ?? m.def.name}:${fns.movePrice(run, m)}`).join(', '));
    say('player moves fields: ' + JSON.stringify(kinds(run.player.moves.find(Boolean))));
    say('counters: ' + JSON.stringify(res.info.counters));
  }
  if (res.terminated || res.truncated) break;
}
say('end: ' + JSON.stringify(obs.state.counters));
await env.close();
