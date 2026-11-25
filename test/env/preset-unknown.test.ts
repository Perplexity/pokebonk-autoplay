import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEnvironment } from '../../src/environment/index.ts';

test('preset unlocked-v4: an unknown archive name is refused before anything is loaded', () => {
  assert.throws(() => createEnvironment({ species: 150, archive: 'everything' }), /unknown archive "everything": use one of empty, loose, balanced, narrow/);
});
