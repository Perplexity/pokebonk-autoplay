import assert from 'node:assert/strict';
import { test } from 'node:test';
import { archiveOf, kitOf, loadValuationKnowledge } from '../../src/player/values.ts';
import { createEnvironment } from '../../src/environment/index.ts';

test('preset unlocked-v4: the game adopts the item archive, within the account\'s slots, and takes the items out of the run\'s pool', async () => {
  const env = createEnvironment({ species: 150, map: 'forest', tier: 2, archive: 'stack-2', maxGameTime: 5 });
  try {
    await env.reset({ seed: 1 });
    const run: any = env.debug.sim!.run, profile = run.meta.profile;
    const knowledge = loadValuationKnowledge('mwsewi0r');
    const slots = 5 * profile.lab.archive + profile.itemsOwned.length;
    const expected = archiveOf('stack-2', knowledge, kitOf(knowledge, 150), slots);
    assert.equal(slots, 105);
    assert.equal(env.getMetadata().profile.preset, 'unlocked-v4:stack-2');
    assert.deepEqual(profile.itemsOff, expected);
    assert.ok(expected.length > 20 && expected.length <= slots);
    assert.equal(run.itemsOff.size, expected.length, 'the run took the archive');
    assert.equal(run.itemInPool(expected[0]), false);
    assert.equal(run.itemInPool('twisted-spoon'), true);
    // No build plan: no favourites and no move switched off, as before unlocked-v5.
    assert.deepEqual([run.favs, [...run.movesOff], profile.movesOff], [[], [], {}]);
    // The profile is the same after another reset: the archive is part of the preset, not of an episode.
    await env.reset({ seed: 2 });
    assert.deepEqual(env.debug.sim!.run.meta.profile.itemsOff, expected);
  } finally { await env.close(); }
});
