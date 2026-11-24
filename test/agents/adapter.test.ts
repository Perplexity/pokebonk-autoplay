import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearestMove, toPlayAction } from '../../src/agents/heuristic/adapter.ts';
import type { Action as BrainAction } from '../../src/bot/brain/movement.ts';
import { playActionProblem } from '../../src/environment/GameEnvironment.ts';
import { MOVES, MOVE_VECTORS } from '../../src/environment/types.ts';
import type { Move, PlayMask } from '../../src/environment/types.ts';

// The brain's free heading and buttons → a valid play action of the environment. No game is loaded here.

const OPEN: PlayMask = { phase: 'play', move: MOVES.map(() => true), jump: true, dash: true, ultimate: true, interact: true, form: false, incense: false, fuse: false };
const brain = (over: Partial<BrainAction>): BrainAction => ({ move: null, dash: false, jump: false, ult: false, interact: false, intent: 'test', note: '', ...over });

test('a heading maps to the nearest of the eight world directions', () => {
  assert.equal(nearestMove(null), 'none');
  assert.equal(nearestMove({ x: 0, z: 0 }), 'none');
  // Each direction maps to itself, at any length.
  for (const name of MOVES) {
    const v = MOVE_VECTORS[name];
    if (!v) continue;
    assert.equal(nearestMove(v), name);
    assert.equal(nearestMove({ x: v.x * 7.5, z: v.z * 7.5 }), name);
  }
  // Every heading goes to the direction with the largest dot product (checked every 3° off the sector borders).
  for (let deg = 1; deg < 360; deg += 3) {
    if (Math.abs(((deg + 22.5) % 45) - 0) < 1.6 || Math.abs(((deg + 22.5) % 45) - 45) < 1.6) continue;
    const a = (deg * Math.PI) / 180, v = { x: Math.cos(a), z: Math.sin(a) };
    let best: Move = 'none', bestDot = -Infinity;
    for (const name of MOVES) { const m = MOVE_VECTORS[name]; if (!m) continue; const d = m.x * v.x + m.z * v.z; if (d > bestDot) { bestDot = d; best = name; } }
    assert.equal(nearestMove(v), best, `${deg}°`);
  }
  // −z is north, +x is east.
  assert.equal(nearestMove({ x: 0, z: -1 }), 'n');
  assert.equal(nearestMove({ x: 1, z: 0 }), 'e');
  assert.equal(nearestMove({ x: -3, z: 3 }), 'sw');
});

test('the brain\'s sixteen headings: the eight in-between ones go to the diagonal, as in the browser harness', () => {
  const got = Array.from({ length: 16 }, (_v, k) => nearestMove({ x: Math.cos((k * Math.PI) / 8), z: Math.sin((k * Math.PI) / 8) }));
  assert.deepEqual(got, ['e', 'se', 'se', 'se', 's', 'sw', 'sw', 'sw', 'w', 'nw', 'nw', 'nw', 'n', 'ne', 'ne', 'ne']);
});

test('buttons are passed on only while the mask allows them, and the result is always a valid action', () => {
  const all = brain({ move: { x: 1, z: 0 }, dash: true, jump: true, ult: true, interact: true });
  const open = toPlayAction(all, OPEN);
  assert.deepEqual(open.action, { type: 'play', move: 'e', jump: true, dash: true, ultimate: true, interact: true });
  assert.deepEqual(open.dropped, { ultimate: false, interact: false, move: false });
  assert.equal(playActionProblem(open.action, OPEN), null);

  const shut: PlayMask = { ...OPEN, ultimate: false, interact: false };
  const masked = toPlayAction(all, shut);
  assert.deepEqual(masked.action, { type: 'play', move: 'e', jump: true, dash: true });
  assert.deepEqual(masked.dropped, { ultimate: true, interact: true, move: false });
  assert.equal(playActionProblem(masked.action, shut), null);

  // Nothing asked: nothing pressed.
  assert.deepEqual(toPlayAction(brain({}), OPEN).action, { type: 'play', move: 'none' });

  // A masked direction is not replaced by another one: the player stands still and the adapter says so.
  const noEast: PlayMask = { ...OPEN, move: MOVES.map((m) => m !== 'e') };
  const blocked = toPlayAction(brain({ move: { x: 1, z: 0 } }), noEast);
  assert.deepEqual(blocked.action, { type: 'play', move: 'none' });
  assert.equal(blocked.dropped.move, true);
  assert.equal(playActionProblem(blocked.action, noEast), null);

  // Every combination of wishes and masks gives an action the environment accepts.
  for (let bits = 0; bits < 256; bits++) {
    const a = brain({ move: bits & 1 ? { x: -0.4, z: 0.9 } : null, dash: !!(bits & 2), jump: !!(bits & 4), ult: !!(bits & 8), interact: !!(bits & 16) });
    const mask: PlayMask = { ...OPEN, ultimate: !!(bits & 32), interact: !!(bits & 64), jump: true, dash: true };
    assert.equal(playActionProblem(toPlayAction(a, mask).action, mask), null);
  }
});
