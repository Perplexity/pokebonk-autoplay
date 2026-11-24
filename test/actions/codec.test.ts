import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_NVEC, ActionCodecError, ActionSpaceOverflowError, CHOICE_EXTRA_BASE, CHOICE_OPTION_BASE, CHOICE_SIZE, CHOICE_TARGET_BASE, MASK_OFFSETS, MASK_SIZE, OPTION_SLOTS, TARGETED_EXTRAS, TARGET_SLOTS,
  UNTARGETED_EXTRAS, actionLayout, choiceFromIndex, decodeAction, encodeAction, encodeMask, indexFromChoice, maskAllows,
} from '../../src/actions/codec.ts';
import { MOVES, choiceActionProblem, playActionProblem, validChoices } from '../../src/environment/index.ts';
import type { ChoiceMask, PlayMask } from '../../src/environment/index.ts';

// No game: the action codec is a pure function of masks and vectors.

const playMask = (over: Partial<PlayMask> = {}): PlayMask => ({ phase: 'play', move: MOVES.map(() => true), jump: true, dash: true, ultimate: false, interact: false, form: false, incense: false, fuse: false, ...over });
const levelUp: ChoiceMask = { phase: 'choice', options: [true, true, true, true], extras: { refresh: true, skip: false, banish: [true, true, true, true], banishKit: [false, true, false, false] } };
const bits = (mask: Uint8Array, dim: number): number[] => Array.from(mask.subarray(MASK_OFFSETS[dim], MASK_OFFSETS[dim] + ACTION_NVEC[dim]));

test('layout: one MultiDiscrete [9, 2 × 7 buttons, C] with a named value for every index', () => {
  const L = actionLayout();
  assert.deepEqual(L.nvec, [9, 2, 2, 2, 2, 2, 2, 2, CHOICE_SIZE]);
  assert.equal(OPTION_SLOTS, 64);
  assert.equal(CHOICE_SIZE, 1 + OPTION_SLOTS + UNTARGETED_EXTRAS.length + TARGETED_EXTRAS.length * TARGET_SLOTS);
  assert.equal(L.maskSize, MASK_SIZE);
  assert.equal(MASK_SIZE, 9 + 7 * 2 + CHOICE_SIZE);
  assert.deepEqual(L.dims.map((d) => d.name), ['move', 'jump', 'dash', 'ultimate', 'interact', 'form', 'incense', 'fuse', 'choice']);
  for (const d of L.dims) assert.equal(d.values.length, d.size);
  assert.deepEqual(L.dims[0].values, [...MOVES]);
  assert.equal(L.dims[8].values[0], 'none');
  assert.equal(L.dims[8].values[CHOICE_OPTION_BASE], 'option:0');
  assert.equal(L.dims[8].values[CHOICE_EXTRA_BASE], 'extra:refresh');
  assert.equal(L.dims[8].values[CHOICE_TARGET_BASE + TARGET_SLOTS], 'extra:banishKit:0');
  assert.match(L.hash, /^[0-9a-f]{64}$/);
  assert.equal(actionLayout().hash, L.hash, 'the layout hash is a function of the layout alone');
});

test('mask, play phase: the play dimensions follow the game\'s mask and the choice dimension allows only "none"', () => {
  const mask = encodeMask({ mask: playMask({ interact: true }) });
  assert.equal(mask.length, MASK_SIZE);
  assert.deepEqual(bits(mask, 0), MOVES.map(() => 1));
  assert.deepEqual([bits(mask, 1), bits(mask, 2), bits(mask, 3), bits(mask, 4)], [[1, 1], [1, 1], [1, 0], [1, 1]]);
  assert.deepEqual([bits(mask, 5), bits(mask, 6), bits(mask, 7)], [[1, 0], [1, 0], [1, 0]], 'form, incense and fuse are masked');
  assert.deepEqual([5, 6, 7].map((d) => bits(encodeMask({ mask: playMask({ form: true, incense: true, fuse: true }) }), d)), [[1, 1], [1, 1], [1, 1]]);
  const choice = bits(mask, 8);
  assert.equal(choice[0], 1);
  assert.equal(choice.reduce((a, b) => a + b, 0), 1);
  // A masked direction is masked.
  const blocked = playMask(); blocked.move[3] = false;
  assert.equal(bits(encodeMask({ mask: blocked }), 0)[3], 0);
});

test('mask, choice phase: options, untargeted and targeted extras; the play dimensions allow only their no-op', () => {
  const mask = encodeMask({ mask: levelUp });
  for (const dim of [0, 1, 2, 3, 4, 5, 6, 7]) { const b = bits(mask, dim); assert.equal(b[0], 1); assert.equal(b.reduce((a, x) => a + x, 0), 1, `dimension ${dim}`); }
  const choice = bits(mask, 8);
  assert.equal(choice[0], 0, '"no choice" is not valid while a dialog is open');
  const allowed = choice.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  const want = [1, 2, 3, 4, CHOICE_EXTRA_BASE + UNTARGETED_EXTRAS.indexOf('refresh'), CHOICE_TARGET_BASE, CHOICE_TARGET_BASE + 1, CHOICE_TARGET_BASE + 2, CHOICE_TARGET_BASE + 3, CHOICE_TARGET_BASE + TARGET_SLOTS + 1];
  assert.deepEqual(allowed, want);
  // Exactly the actions the environment's own enumeration allows.
  assert.equal(allowed.length, validChoices(levelUp).length);
  for (const i of allowed) assert.equal(choiceActionProblem(choiceFromIndex(i), levelUp), null);
  // The episode is over: only the zeros, so that a sampler does not fail.
  const over = encodeMask({ mask: { phase: 'over' } });
  assert.equal(over.reduce((a, b) => a + b, 0), 9);
});

test('round trip: every play action and every choice index', () => {
  const obs = { phase: 'play', mask: playMask({ ultimate: true, interact: true, form: true, incense: true, fuse: true }) };
  let n = 0;
  for (let move = 0; move < 9; move++) for (let b = 0; b < 128; b++) {
    const v = [move, b & 1, (b >> 1) & 1, (b >> 2) & 1, (b >> 3) & 1, (b >> 4) & 1, (b >> 5) & 1, (b >> 6) & 1, 0];
    const a = decodeAction(v, obs);
    assert.deepEqual(a, { type: 'play', move: MOVES[move], jump: !!(b & 1), dash: !!(b & 2), ultimate: !!(b & 4), interact: !!(b & 8), form: !!(b & 16), incense: !!(b & 32), fuse: !!(b & 64) });
    assert.equal(playActionProblem(a as never, obs.mask), null);
    assert.deepEqual(Array.from(encodeAction(a)), v);
    assert.ok(maskAllows(encodeMask(obs), v));
    n++;
  }
  assert.equal(n, 9 * 128);
  for (let i = 1; i < CHOICE_SIZE; i++) assert.equal(indexFromChoice(choiceFromIndex(i)), i);
  const dialog = { phase: 'choice', mask: levelUp };
  for (const a of validChoices(levelUp)) {
    const v = encodeAction(a, dialog);
    assert.deepEqual(decodeAction(v, dialog), a);
    assert.ok(maskAllows(encodeMask(dialog), v));
  }
  assert.deepEqual(decodeAction([0, 0, 0, 0, 0, 0, 0, 0, CHOICE_TARGET_BASE + TARGET_SLOTS + 1], dialog), { type: 'choice', extra: 'banishKit', target: 1 });
  assert.equal(maskAllows(encodeMask(dialog), [0, 0, 0, 0, 0, 0, 0, 0, CHOICE_EXTRA_BASE + UNTARGETED_EXTRAS.indexOf('skip')]), false, 'a skip with no skips left is masked');
});

test('decode refuses malformed vectors and the wrong phase; it never remaps', () => {
  const play = { phase: 'play', mask: playMask() }, dialog = { phase: 'choice', mask: levelUp };
  assert.throws(() => decodeAction([0, 0, 0], play), ActionCodecError);
  assert.throws(() => decodeAction([9, 0, 0, 0, 0, 0, 0, 0, 0], play), /move\) is 9/);
  assert.throws(() => decodeAction([0, 0, 0, 0, 0, 0, 0, 0, CHOICE_SIZE], play), ActionCodecError);
  assert.throws(() => decodeAction([0, 0.5, 0, 0, 0, 0, 0, 0, 0], play), ActionCodecError);
  assert.throws(() => decodeAction([1, 0, 0, 0, 0, 0, 0, 0, 1], play), /choice entry must be 0 in the play phase/);
  assert.throws(() => decodeAction([1, 0, 0, 0, 0, 0, 0, 0, 1], dialog), /move entry must be 0 in the choice phase/);
  assert.throws(() => decodeAction([0, 0, 0, 0, 0, 0, 0, 0, 0], dialog), /no choice/);
  assert.throws(() => decodeAction([0, 0, 0, 0, 0, 0, 0, 0, 0], { phase: 'over', mask: { phase: 'over' } }), /episode is over/);
  // A masked but well-formed action is decoded as it is: rejecting it is the environment's job.
  assert.deepEqual(decodeAction([0, 0, 0, 1, 0, 0, 0, 0, 0], play), { type: 'play', move: 'none', jump: false, dash: false, ultimate: true, interact: false, form: false, incense: false, fuse: false });
  assert.match(playActionProblem({ type: 'play', move: 'none', incense: true }, play.mask) ?? '', /incense is masked/);
  assert.match(playActionProblem({ type: 'play', move: 'none', ultimate: true }, play.mask) ?? '', /ultimate is masked/);
  assert.throws(() => encodeAction({ type: 'play', move: 11 }), ActionCodecError);
  assert.throws(() => encodeAction({ type: 'choice', extra: 'banish' }), /needs a target/);
  assert.throws(() => encodeAction({ type: 'choice', extra: 'refresh', target: 0 }), /takes no target/);
});

test('a dialog that does not fit the slots is an error everywhere, never a truncation', () => {
  const big: ChoiceMask = { phase: 'choice', options: Array.from({ length: OPTION_SLOTS + 1 }, () => true), extras: { decline: true } };
  assert.throws(() => encodeMask({ mask: big }), ActionSpaceOverflowError);
  assert.throws(() => decodeAction([0, 0, 0, 0, 0, 0, 0, 0, 1], { phase: 'choice', mask: big }), ActionSpaceOverflowError);
  assert.throws(() => encodeAction({ type: 'choice', option: 0 }, { mask: big }), ActionSpaceOverflowError);
  assert.throws(() => encodeAction({ type: 'choice', option: OPTION_SLOTS }), ActionSpaceOverflowError);
  const fits: ChoiceMask = { phase: 'choice', options: Array.from({ length: OPTION_SLOTS }, () => true), extras: { decline: true } };
  assert.equal(bits(encodeMask({ mask: fits }), 8).reduce((a, b) => a + b, 0), OPTION_SLOTS + 1);
  const manyTargets: ChoiceMask = { phase: 'choice', options: Array.from({ length: TARGET_SLOTS + 1 }, () => true), extras: { banish: Array.from({ length: TARGET_SLOTS + 1 }, () => true) } };
  assert.throws(() => encodeMask({ mask: manyTargets }), ActionSpaceOverflowError);
  assert.throws(() => encodeAction({ type: 'choice', extra: 'banish', target: TARGET_SLOTS }), ActionSpaceOverflowError);
  // An extra action the codec has no index for is not dropped either.
  assert.throws(() => encodeMask({ mask: { phase: 'choice', options: [true], extras: { sell: [true] } } }), ActionCodecError);
  assert.throws(() => encodeMask({ mask: { phase: 'choice', options: [true], extras: { banish: true } as never } }), ActionCodecError);
});
