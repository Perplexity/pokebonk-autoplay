import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choiceActionProblem, keysForMove, playActionProblem } from '../../src/environment/GameEnvironment.ts';
import { plain } from '../../src/environment/dialogs.ts';
import { idlePolicy, randomPolicy, validChoices } from '../../src/environment/policies.ts';
import { MOVES, MOVE_VECTORS } from '../../src/environment/types.ts';
import type { ChoiceMask, Observation, PlayMask } from '../../src/environment/types.ts';

// Pure logic of the environment: no game is loaded in this file.

const PLAY: PlayMask = { phase: 'play', move: MOVES.map(() => true), jump: true, dash: true, ultimate: false, interact: false, form: false, incense: false, fuse: false };
const LEVELUP: ChoiceMask = { phase: 'choice', options: [true, true, false], extras: { refresh: true, skip: false, banish: [true, false, true], banishKit: [false, false, false] } };

test('play actions: every direction by name or index, buttons only when the mask allows them', () => {
  for (const [i, name] of MOVES.entries()) {
    assert.equal(playActionProblem({ type: 'play', move: name }, PLAY), null);
    assert.equal(playActionProblem({ type: 'play', move: i }, PLAY), null);
  }
  assert.equal(playActionProblem({ type: 'play', move: 'n', jump: true, dash: true }, PLAY), null);
  assert.match(playActionProblem({ type: 'play', move: 'n', ultimate: true }, PLAY)!, /ultimate is masked/);
  assert.match(playActionProblem({ type: 'play', move: 'n', interact: true }, PLAY)!, /interact is masked/);
  assert.equal(playActionProblem({ type: 'play', move: 'n', ultimate: false, interact: false }, PLAY), null);
});

test('play actions: malformed input is named, never mapped to something else', () => {
  assert.match(playActionProblem({ type: 'play', move: 9 }, PLAY)!, /not one of/);
  assert.match(playActionProblem({ type: 'play', move: -1 }, PLAY)!, /not one of/);
  assert.match(playActionProblem({ type: 'play', move: 1.5 }, PLAY)!, /not one of/);
  assert.match(playActionProblem({ type: 'play', move: 'up' as never }, PLAY)!, /not one of/);
  assert.match(playActionProblem({ type: 'play', move: 0, jump: 1 as never }, PLAY)!, /jump must be a boolean/);
  assert.match(playActionProblem({ type: 'play', move: 0, fire: true } as never, PLAY)!, /unknown field "fire"/);
});

test('choice actions: options and extras are checked against the mask', () => {
  assert.equal(choiceActionProblem({ type: 'choice', option: 0 }, LEVELUP), null);
  assert.match(choiceActionProblem({ type: 'choice', option: 2 }, LEVELUP)!, /option 2 is masked/);
  assert.match(choiceActionProblem({ type: 'choice', option: 3 }, LEVELUP)!, /out of range/);
  assert.match(choiceActionProblem({ type: 'choice', option: -1 }, LEVELUP)!, /out of range/);
  assert.equal(choiceActionProblem({ type: 'choice', extra: 'refresh' }, LEVELUP), null);
  assert.match(choiceActionProblem({ type: 'choice', extra: 'skip' }, LEVELUP)!, /"skip" is masked/);
  assert.match(choiceActionProblem({ type: 'choice', extra: 'sell' }, LEVELUP)!, /no extra action "sell"/);
  assert.match(choiceActionProblem({ type: 'choice', extra: 'refresh', target: 0 }, LEVELUP)!, /takes no target/);
});

test('choice actions: targeted extras need a valid target', () => {
  assert.equal(choiceActionProblem({ type: 'choice', extra: 'banish', target: 0 }, LEVELUP), null);
  assert.match(choiceActionProblem({ type: 'choice', extra: 'banish' }, LEVELUP)!, /needs a target/);
  assert.match(choiceActionProblem({ type: 'choice', extra: 'banish', target: 1 }, LEVELUP)!, /on option 1 is masked/);
  assert.match(choiceActionProblem({ type: 'choice', extra: 'banish', target: 3 }, LEVELUP)!, /needs a target/);
  assert.match(choiceActionProblem({ type: 'choice', extra: 'banishKit', target: 0 }, LEVELUP)!, /masked/);
  assert.match(choiceActionProblem({ type: 'choice' } as never, LEVELUP)!, /exactly one of/);
  assert.match(choiceActionProblem({ type: 'choice', option: 0, extra: 'refresh' } as never, LEVELUP)!, /exactly one of/);
});

test('validChoices lists exactly what the mask allows', () => {
  assert.deepEqual(validChoices(LEVELUP), [
    { type: 'choice', option: 0 }, { type: 'choice', option: 1 },
    { type: 'choice', extra: 'banish', target: 0 }, { type: 'choice', extra: 'banish', target: 2 },
    { type: 'choice', extra: 'refresh' },
  ]);
  for (const a of validChoices(LEVELUP)) assert.equal(choiceActionProblem(a, LEVELUP), null);
});

test('movement keys follow the camera yaw (forward is (-sin yaw, -cos yaw))', () => {
  assert.deepEqual(keysForMove(null, 0), []);
  assert.deepEqual(keysForMove(MOVE_VECTORS.n, 0), ['KeyW']);
  assert.deepEqual(keysForMove(MOVE_VECTORS.e, 0), ['KeyD']);
  assert.deepEqual(keysForMove(MOVE_VECTORS.s, 0), ['KeyS']);
  assert.deepEqual(keysForMove(MOVE_VECTORS.w, 0), ['KeyA']);
  assert.deepEqual(keysForMove(MOVE_VECTORS.ne, 0), ['KeyW', 'KeyD']);
  // Camera turned a quarter: the same world direction needs another key.
  assert.deepEqual(keysForMove(MOVE_VECTORS.n, Math.PI / 2), ['KeyD']);
  assert.deepEqual(keysForMove(MOVE_VECTORS.n, Math.PI), ['KeyS']);
});

test('plain() copies data and drops everything that could reach a live object', () => {
  const live = { run: { secret: 1 }, el: { nodeType: 1 }, name: 'x', n: 2, bad: NaN, fn: () => 1, list: [1, { a: 1, f() { return 2; } }], map: new Map([['k', 3]]), set: new Set([4]), node: { nodeType: 1, x: 1 } };
  const copy = plain(live) as Record<string, unknown>;
  assert.deepEqual(copy, { name: 'x', n: 2, bad: null, list: [1, { a: 1 }], map: { k: 3 }, set: [4], node: null });
  (copy.list as unknown[]).push(9);
  assert.equal(live.list.length, 2);
});

test('baseline policies only produce valid actions', () => {
  const obsPlay = { phase: 'play', mask: PLAY, decision: null } as unknown as Observation;
  const obsChoice = { phase: 'choice', mask: LEVELUP, decision: { kind: 'levelup' } } as unknown as Observation;
  const random = randomPolicy(), idle = idlePolicy();
  random.reset(7);
  const seen = new Set<string>();
  for (let i = 0; i < 400; i++) {
    const a = random.act(obsPlay);
    assert.equal(a.type, 'play');
    if (a.type === 'play') { assert.equal(playActionProblem(a, PLAY), null); seen.add(String(a.move)); }
    const c = random.act(obsChoice);
    if (c.type === 'choice') assert.equal(choiceActionProblem(c, LEVELUP), null);
  }
  assert.equal(seen.size, MOVES.length, 'the random policy uses every direction');
  assert.deepEqual(idle.act(obsPlay), { type: 'play', move: 0 });
  assert.deepEqual(idle.act(obsChoice), { type: 'choice', option: 0 });
  // Same seed, same stream.
  const a = randomPolicy(), b = randomPolicy();
  a.reset(3); b.reset(3);
  for (let i = 0; i < 50; i++) assert.deepEqual(a.act(obsPlay), b.act(obsPlay));
});
