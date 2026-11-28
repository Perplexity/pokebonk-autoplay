import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPlanOf } from '../../src/player/kit.ts';
import { loadValuationKnowledge } from '../../src/player/values.ts';
import { createEnvironment } from '../../src/environment/index.ts';

test('preset unlocked-v5: the game adopts the build plan: its favourites, each with the top chance, and the moves switched off', async () => {
  const env = createEnvironment({ species: 150, map: 'forest', tier: 2, archive: 'stack-2', buildPlan: 'kit-1', maxGameTime: 5 });
  try {
    await env.reset({ seed: 1 });
    const knowledge = loadValuationKnowledge('mwsewi0r'), want = buildPlanOf('kit-1', 150, knowledge);
    const check = () => {
      const run: any = env.debug.sim!.run;
      assert.deepEqual(run.favs.map((f: any) => f.id), want.favs, 'the run\'s favourites, in the plan\'s order');
      assert.deepEqual(run.favs.map((f: any) => f.pct), [15, 15, 15, 15], 'the Lab\'s Affinity is at its top level: 15 % each');
      assert.deepEqual([...run.movesOff], want.movesOff);
      assert.deepEqual(run.meta.profile.movesOff, { 150: want.movesOff });
    };
    check();
    assert.equal(env.getMetadata().profile.preset, 'unlocked-v5:stack-2:kit-1');
    // The plan is part of the preset, not of an episode.
    await env.reset({ seed: 2 });
    check();
  } finally { await env.close(); }
});
