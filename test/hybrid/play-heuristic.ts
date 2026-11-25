/**
 * Helper of manager.test.ts (not a test): plays heuristic2 on one seed in a process of its own (a process holds one
 * game environment) and prints the run's counters as one JSON line.
 *   node test/hybrid/play-heuristic.ts <seed> <game seconds>
 */
import { writeSync } from 'node:fs';
import { createEnvironment } from '../../src/environment/index.ts';
import { makePolicy } from '../../src/runner/policies.ts';

const seed = Number(process.argv[2]), cap = Number(process.argv[3]);
const env = createEnvironment({ map: 'forest', species: 150, tier: 2, ranked: true, archive: 'balanced', maxGameTime: cap });
const policy = makePolicy('heuristic2', env, {});
policy.reset(seed);
let obs = await env.reset({ seed }), steps = 0;
for (;;) {
  const res = await env.step(policy.act(obs));
  obs = res.observation; steps++;
  if (res.terminated || res.truncated) { writeSync(1, JSON.stringify({ steps, end: res.info.endCause, counters: res.info.counters }) + '\n'); break; }
}
await env.close();
process.exit(0);
