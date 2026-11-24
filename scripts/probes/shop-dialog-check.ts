/**
 * Check of the shop dialog against the real game. THIS ONE DOES NOT CHEAT (unlike lifecycle-cheat-probe.ts next to it):
 * it only acts through the environment, as a policy. It is not a baseline and its results are not stored.
 *
 * The heuristic baseline plays (with the shop worth a visit from 60 ₽ on and from further away); at a shop the rule is
 * replaced by: buy the first entry the mask allows, twice; then restock once if the mask allows it; then leave. What
 * each answer changed (Pokédollars, items, the next dialog and its mask) is printed. Evidence for docs/baseline.md §7.
 *
 *   node scripts/probes/shop-dialog-check.ts --seed=27 [--to=<game seconds, default 700>] [--species=155] [--map=forest]
 *
 * Seed 27 (Cyndaquil, forest) meets a shop at 239 s with 265 ₽; many seeds meet none before they end.
 */
import { createEnvironment } from '../../src/environment/index.ts';
import { heuristicPolicy } from '../../src/agents/heuristic/index.ts';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) { const m = /^--([\w-]+)(?:=(.*))?$/.exec(a); if (m) args.set(m[1], m[2] ?? 'true'); }
const num = (k: string, d: number) => (args.has(k) ? Number(args.get(k)) : d);
const say = (s: string) => process.stdout.write(s + '\n');
const env = createEnvironment({ maxGameTime: num('to', 700), species: num('species', 155), map: args.get('map') ?? 'forest', tier: 0 });
const seed = num('seed', 27);
let obs = await env.reset({ seed });
// The shop is visited as soon as there is any gold, so that it is met early.
const policy = heuristicPolicy({ planRoute: (x, z) => env.planRoute(x, z), tuning: { shopGold: 60, visitRange: 60 } });
policy.reset(seed);
let bought = 0, restocked = false, visits = 0;
for (;;) {
  let action = policy.act(obs);
  const d = obs.decision;
  if (obs.phase === 'choice' && d && d.kind === 'shop') {
    const mask = obs.mask as any;
    const first = mask.options.indexOf(true);
    if (bought < 2 && first >= 0) action = { type: 'choice', option: first };
    else if (bought >= 1 && !restocked && mask.extras.reroll) action = { type: 'choice', extra: 'reroll' };
    else action = { type: 'choice', extra: 'leave' };
    const before = obs;
    const res = await env.step(action);
    const after = res.observation;
    const it = (o: any) => JSON.stringify(o.snapshot.player.items);
    say(`[${before.snapshot.t.toFixed(1)}] shop: gold ${before.snapshot.gold}, stock ${d.options.map((o: any) => `${o.id} ${o.data.price}₽${o.data.sold ? ' sold' : ''}`).join(', ')}, mask ${JSON.stringify(mask.options)} reroll ${mask.extras.reroll} (cost ${d.context.rerollCost})`);
    say(`    answer ${JSON.stringify(action)} → gold ${after.snapshot.gold}, items ${it(before)} → ${it(after)}, phase ${after.phase}${after.decision ? `, next dialog ${after.decision.kind}: ${after.decision.options.map((o: any) => `${o.id}${o.data.sold ? ' sold' : ''}`).join(', ')}; mask ${JSON.stringify((after.mask as any).options)}` : ''}, run state ${after.snapshot.state}`);
    if ('option' in action) bought++; else if (action.extra === 'reroll') restocked = true; else { visits++; bought = 0; restocked = false; }
    obs = after;
    if (res.terminated || res.truncated) break;
    if (visits >= 2) break;
    continue;
  }
  const res = await env.step(action);
  obs = res.observation;
  if (res.terminated || res.truncated) { say(`END ${res.info.endCause} t=${res.info.time.toFixed(1)}`); break; }
}
say(`shop visits completed: ${visits}`);
await env.close();
process.exit(0);
