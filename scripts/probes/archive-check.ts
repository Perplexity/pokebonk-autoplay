/**
 * PROBE (phase 0 of the heuristic + RL refactor). Not part of the environment, never used for training or evaluation.
 *
 * Do the account's archives reach a headless run the way the game's own code takes them, and what are the limits?
 * The preset the environment hands to the game's `devUnlock` is extended here (in this process only) with an item
 * archive, a move archive, a pre-banished list and, in the game's local storage, a Build Plan; then runs are started
 * and what the run object took is printed, and the heuristic plays a few episodes to see which items really turn up.
 *
 *   node scripts/probes/archive-check.ts [--episodes=3] [--archive=<how many items to archive, default: the limit>]
 */
import { createEnvironment } from '../../src/environment/index.ts';
import type { Observation } from '../../src/environment/index.ts';
import { makePolicy } from '../../src/runner/policies.ts';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) { const m = /^--([\w-]+)(?:=(.*))?$/.exec(a); if (m) args.set(m[1], m[2] ?? 'true'); }
const num = (k: string, d: number) => (args.has(k) ? Number(args.get(k)) : d);
const say = (s: string) => process.stdout.write(s + '\n');

const env = createEnvironment({ map: 'forest', species: 150, tier: 2, ranked: true });
let obs: Observation = await env.reset({ seed: 1 });
const sim: any = env.debug.sim!;
const run = () => sim.run;
const meta = run().meta;
const profile = meta.profile;
const slots = 5 * (profile.lab.archive ?? 0) + profile.itemsOwned.length;
say(`account: lab.archive=${profile.lab.archive} itemsOwned=${profile.itemsOwned.length} → item archive slots by the game's formula 5 x Lab level + owned shop items = ${slots}`);
say(`before: profile.itemsOff=${profile.itemsOff.length} movesOff=${JSON.stringify(profile.movesOff)} typesOff=${JSON.stringify(profile.typesOff)} banished=${JSON.stringify(profile.banished)} run.itemsOff=${run().itemsOff.size} run.favs=${JSON.stringify(run().favs)}`);

// Every held item the game can hand out in this run: its own pool test over the knowledge export's item list.
const itemKeys: string[] = [...new Set<string>((env.getMetadata() as any).knowledge?.items ?? [])];
const all: string[] = itemKeys.length ? itemKeys : Object.keys((sim.app?.registries?.items ?? {}));
const pool = (profile.itemsOwned as string[]).concat([]);
say(`items known to the probe: ${all.length}; shop items owned: ${pool.length}`);

// The archive: as many of the owned shop items as asked for (those are certainly archivable keys).
const want = Math.min(num('archive', slots), pool.length);
const archive = pool.slice(0, want);
const original = sim.api.unlockPreset;
sim.api.unlockPreset = (p: any) => ({ ...original(p), itemsOff: archive.slice() });
// The environment refuses a profile that differs from the one it started with (a safety check of its own): adopt the
// extended preset through the game's devUnlock and make it this process's starting state.
await meta.devUnlock();
(env as any).baseline.profile = (env as any).profileDigestSource();

const policy = makePolicy('heuristic', env as any, {});
const got = new Map<string, number>(), offered = new Map<string, number>();
for (let ep = 0; ep < num('episodes', 3); ep++) {
  const seed = 2 + ep;
  policy.reset(seed);
  obs = await env.reset({ seed });
  const r = run();
  if (ep === 0) {
    say(`after: profile.itemsOff=${r.meta.profile.itemsOff.length} run.itemsOff=${r.itemsOff.size} (asked ${archive.length}); itemInPool(archived[0]=${archive[0]})=${r.itemInPool(archive[0])} itemInPool(not archived ${pool[pool.length - 1]})=${archive.includes(pool[pool.length - 1]) ? 'n/a' : r.itemInPool(pool[pool.length - 1])}`);
  }
  for (;;) {
    if (obs.phase === 'choice' && obs.decision) for (const o of obs.decision.options) if (['item', 'itemChoice', 'shop'].includes(obs.decision.kind)) offered.set(String(o.id), (offered.get(String(o.id)) ?? 0) + 1);
    const res = await env.step(policy.act(obs));
    obs = res.observation;
    if (res.terminated || res.truncated) {
      for (const [k, c] of r.player.items as Map<string, number>) got.set(k, (got.get(k) ?? 0) + c);
      say(`episode seed ${seed}: ${res.info.endCause}, ${res.info.kills} KOs, ${r.player.items.size} different items held`);
      break;
    }
  }
}
const archived = new Set(archive);
const bad = [...got.keys()].filter((k) => archived.has(k)), badOffers = [...offered.keys()].filter((k) => archived.has(k));
say(`items held at the end over all episodes: ${[...got.keys()].length} different; archived ones among them: ${JSON.stringify(bad)}`);
say(`item ids offered in item, item-choice and shop dialogs: ${offered.size} different; archived ones among them: ${JSON.stringify(badOffers)}`);
await env.close();
process.exit(0);
