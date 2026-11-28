import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEnvironment } from '../../src/environment/index.ts';

test('preset unlocked-v4: an unknown archive name is refused before anything is loaded', () => {
  assert.throws(() => createEnvironment({ species: 150, archive: 'everything' }), /unknown archive "everything": use one of empty, loose, balanced, narrow/);
});

test('preset unlocked-v5: an unknown build plan, or one for the starter account, is refused before anything is loaded', () => {
  assert.throws(() => createEnvironment({ species: 150, buildPlan: 'kit-0' }), /unknown build plan "kit-0": use one of kit-1/);
  assert.throws(() => createEnvironment({ species: 150, buildPlan: 'kit-1', profile: 'starter' }), /a build plan needs the unlocked profile/);
});
