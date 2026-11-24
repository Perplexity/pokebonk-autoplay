import { createHash } from 'node:crypto';
import { MOVES, PLAY_BUTTONS } from '../environment/types.ts';
import type { Action, ActionMask, ChoiceAction, ChoiceMask, ExtraAction, PlayAction, PlayMask } from '../environment/types.ts';

/**
 * Action codec: one flat MultiDiscrete action for both phases, with a mask per dimension.
 *
 *   dimension   size   meaning
 *   move        9      index into MOVES (0 = stand still, 1–8 = n, ne, e, se, s, sw, w, nw; world-relative)
 *   jump        2      0 = no, 1 = press
 *   dash        2
 *   ultimate    2
 *   interact    2
 *   form        2      Max form
 *   incense     2      open a rift
 *   fuse        2      open a fused rift
 *   choice      C      0 = no choice (the only valid value in the play phase)
 *                      1 … OPTION_SLOTS                  take option i − 1 of the open dialog
 *                      then one index per UNTARGETED_EXTRAS entry (refresh, skip, take, sell, decline, leave, confirm, reroll)
 *                      then TARGET_SLOTS indexes per TARGETED_EXTRAS entry (banish option t, banishKit option t)
 *
 * In the play phase the choice dimension allows only 0; in the choice phase the play dimensions allow only 0 and
 * the choice dimension never allows 0. In the "over" phase nothing is valid: the mask allows only the zeros so that a
 * sampler does not fail, and decoding throws.
 *
 * A dialog with more options than OPTION_SLOTS (or a targeted extra over more than TARGET_SLOTS options) cannot be
 * expressed: every function here throws `ActionSpaceOverflowError` for it. Nothing is ever truncated.
 */
/** 2: the buttons form, incense and fuse; 64 option slots (were 48). */
export const ACTION_ENCODING_VERSION = 2;

/**
 * Option slots. The dialogs of src/environment/dialogs.ts have few options (the 8 subsets of three seals, relic cards ×
 * three slots, up to 4 level-up offers, the dojo's 21 prizes) except Ditto and the shop's sell list, which have one
 * option per distinct held item: at most the 142 items of the game. The most distinct items a stored run has held is
 * 15; a dialog beyond the slots is an error.
 */
export const OPTION_SLOTS = 64;
/** Options a targeted extra can aim at. Only the level-up dialog has targeted extras; it has at most 4 offers (Lab "fourth option"). */
export const TARGET_SLOTS = 8;
export const UNTARGETED_EXTRAS = ['refresh', 'skip', 'take', 'sell', 'decline', 'leave', 'confirm', 'reroll'] as const satisfies readonly ExtraAction[];
export const TARGETED_EXTRAS = ['banish', 'banishKit'] as const satisfies readonly ExtraAction[];

export const CHOICE_NONE = 0;
export const CHOICE_OPTION_BASE = 1;
export const CHOICE_EXTRA_BASE = CHOICE_OPTION_BASE + OPTION_SLOTS;
export const CHOICE_TARGET_BASE = CHOICE_EXTRA_BASE + UNTARGETED_EXTRAS.length;
export const CHOICE_SIZE = CHOICE_TARGET_BASE + TARGETED_EXTRAS.length * TARGET_SLOTS;

export const ACTION_DIMS = [
  { name: 'move', size: MOVES.length },
  ...PLAY_BUTTONS.map((name) => ({ name, size: 2 })),
  { name: 'choice', size: CHOICE_SIZE },
] as const;
export const ACTION_NVEC: readonly number[] = ACTION_DIMS.map((d) => d.size);
/** Start of each dimension inside the concatenated mask. */
export const MASK_OFFSETS: readonly number[] = ACTION_NVEC.map((_, i) => ACTION_NVEC.slice(0, i).reduce((a, b) => a + b, 0));
export const MASK_SIZE = ACTION_NVEC.reduce((a, b) => a + b, 0);

const D_MOVE = 0, D_BUTTON = 1, D_CHOICE = D_BUTTON + PLAY_BUTTONS.length;
const PLAY_DIMS = Array.from({ length: D_CHOICE }, (_, i) => i);

export class ActionSpaceOverflowError extends Error {
  constructor(message: string) { super(message); this.name = 'ActionSpaceOverflowError'; }
}
export class ActionCodecError extends Error {
  constructor(message: string) { super(message); this.name = 'ActionCodecError'; }
}

export interface ActionLayout {
  version: number;
  nvec: number[];
  dims: { name: string; size: number; maskOffset: number; values: string[] }[];
  maskSize: number;
  optionSlots: number;
  targetSlots: number;
  hash: string;
}

/** The action layout as data: what Python builds its MultiDiscrete space and its mask slices from. */
export function actionLayout(): ActionLayout {
  const choice: string[] = ['none'];
  for (let i = 0; i < OPTION_SLOTS; i++) choice.push(`option:${i}`);
  for (const e of UNTARGETED_EXTRAS) choice.push(`extra:${e}`);
  for (const e of TARGETED_EXTRAS) for (let t = 0; t < TARGET_SLOTS; t++) choice.push(`extra:${e}:${t}`);
  const values: string[][] = [[...MOVES], ...PLAY_BUTTONS.map(() => ['no', 'press']), choice];
  const body = {
    version: ACTION_ENCODING_VERSION, nvec: [...ACTION_NVEC],
    dims: ACTION_DIMS.map((d, i) => ({ name: d.name, size: d.size, maskOffset: MASK_OFFSETS[i], values: values[i] })),
    maskSize: MASK_SIZE, optionSlots: OPTION_SLOTS, targetSlots: TARGET_SLOTS,
  };
  return { ...body, hash: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}

/** Throws when the dialog behind a choice mask does not fit the fixed slots. */
function checkFits(mask: ChoiceMask, what: string): void {
  if (mask.options.length > OPTION_SLOTS) throw new ActionSpaceOverflowError(`${what}: the dialog has ${mask.options.length} options, the action space has ${OPTION_SLOTS} option slots`);
  for (const [extra, m] of Object.entries(mask.extras)) {
    if (Array.isArray(m)) {
      if (!(TARGETED_EXTRAS as readonly string[]).includes(extra)) throw new ActionCodecError(`${what}: the dialog aims the extra action "${extra}" at an option; the action space has targets only for ${TARGETED_EXTRAS.join(', ')}`);
      if (m.length > TARGET_SLOTS) throw new ActionSpaceOverflowError(`${what}: the extra action "${extra}" can aim at ${m.length} options, the action space has ${TARGET_SLOTS} target slots`);
    } else if (!(UNTARGETED_EXTRAS as readonly string[]).includes(extra)) {
      throw new ActionCodecError(`${what}: the dialog has the untargeted extra action "${extra}", which the action space does not have (${UNTARGETED_EXTRAS.join(', ')})`);
    }
  }
}

/** Concatenated per-dimension masks (1 = allowed), MASK_SIZE bytes, from an observation's mask. */
export function encodeMask(observation: { mask: Readonly<ActionMask> }): Uint8Array {
  const out = new Uint8Array(MASK_SIZE);
  const mask = observation.mask;
  if (mask.phase === 'play') {
    const m = mask as PlayMask;
    for (let i = 0; i < MOVES.length; i++) out[MASK_OFFSETS[D_MOVE] + i] = m.move[i] ? 1 : 0;
    PLAY_BUTTONS.forEach((b, i) => { out[MASK_OFFSETS[D_BUTTON + i]] = 1; out[MASK_OFFSETS[D_BUTTON + i] + 1] = m[b] ? 1 : 0; });
    out[MASK_OFFSETS[D_CHOICE] + CHOICE_NONE] = 1;
    return out;
  }
  // Choice and over: the play dimensions allow only their no-op.
  for (const dim of PLAY_DIMS) out[MASK_OFFSETS[dim]] = 1;
  const base = MASK_OFFSETS[D_CHOICE];
  if (mask.phase === 'over') { out[base + CHOICE_NONE] = 1; return out; }
  const m = mask as ChoiceMask;
  checkFits(m, 'encodeMask');
  m.options.forEach((ok, i) => { if (ok) out[base + CHOICE_OPTION_BASE + i] = 1; });
  UNTARGETED_EXTRAS.forEach((e, i) => { if (m.extras[e] === true) out[base + CHOICE_EXTRA_BASE + i] = 1; });
  TARGETED_EXTRAS.forEach((e, k) => {
    const t = m.extras[e];
    if (Array.isArray(t)) t.forEach((ok, i) => { if (ok) out[base + CHOICE_TARGET_BASE + k * TARGET_SLOTS + i] = 1; });
  });
  return out;
}

/** The choice action a choice index stands for (no validity check against the mask: the environment does that). */
export function choiceFromIndex(index: number): ChoiceAction {
  if (!Number.isInteger(index) || index <= CHOICE_NONE || index >= CHOICE_SIZE) throw new ActionCodecError(`choice index ${index} is not a choice (valid: 1–${CHOICE_SIZE - 1})`);
  if (index < CHOICE_EXTRA_BASE) return { type: 'choice', option: index - CHOICE_OPTION_BASE };
  if (index < CHOICE_TARGET_BASE) return { type: 'choice', extra: UNTARGETED_EXTRAS[index - CHOICE_EXTRA_BASE] };
  const k = index - CHOICE_TARGET_BASE;
  return { type: 'choice', extra: TARGETED_EXTRAS[Math.floor(k / TARGET_SLOTS)], target: k % TARGET_SLOTS };
}

/** The choice index of a choice action. */
export function indexFromChoice(action: ChoiceAction): number {
  if ('option' in action) {
    if (!Number.isInteger(action.option) || action.option < 0) throw new ActionCodecError(`option ${action.option} is not an option index`);
    if (action.option >= OPTION_SLOTS) throw new ActionSpaceOverflowError(`option ${action.option} is beyond the ${OPTION_SLOTS} option slots of the action space`);
    return CHOICE_OPTION_BASE + action.option;
  }
  const t = (TARGETED_EXTRAS as readonly string[]).indexOf(action.extra);
  if (action.target !== undefined) {
    if (t < 0) throw new ActionCodecError(`the extra action "${action.extra}" takes no target in the action space`);
    if (!Number.isInteger(action.target) || action.target < 0) throw new ActionCodecError(`target ${action.target} is not an option index`);
    if (action.target >= TARGET_SLOTS) throw new ActionSpaceOverflowError(`target ${action.target} is beyond the ${TARGET_SLOTS} target slots of the action space`);
    return CHOICE_TARGET_BASE + t * TARGET_SLOTS + action.target;
  }
  const u = (UNTARGETED_EXTRAS as readonly string[]).indexOf(action.extra);
  if (u < 0) throw new ActionCodecError(t >= 0 ? `the extra action "${action.extra}" needs a target` : `the action space has no extra action "${action.extra}"`);
  return CHOICE_EXTRA_BASE + u;
}

/**
 * Action vector → environment action for the observation's phase. Checks the vector's shape, ranges and phase rules
 * (a play vector must carry choice 0, a choice vector must carry play no-ops); whether the action is allowed by the
 * mask is the environment's check, so a masked action reaches it and is rejected or penalised there, never remapped.
 */
export function decodeAction(vector: ArrayLike<number>, observation: { phase: string; mask: Readonly<ActionMask> }): Action {
  if (vector.length !== ACTION_NVEC.length) throw new ActionCodecError(`an action vector has ${ACTION_NVEC.length} entries, got ${vector.length}`);
  for (let i = 0; i < ACTION_NVEC.length; i++) {
    const v = vector[i];
    if (!Number.isInteger(v) || v < 0 || v >= ACTION_NVEC[i]) throw new ActionCodecError(`action entry ${i} (${ACTION_DIMS[i].name}) is ${v}; valid: 0–${ACTION_NVEC[i] - 1}`);
  }
  if (observation.phase === 'over') throw new ActionCodecError('the episode is over: there is no action to decode');
  if (observation.phase === 'play') {
    if (vector[D_CHOICE] !== CHOICE_NONE) throw new ActionCodecError(`the choice entry must be 0 in the play phase, got ${vector[D_CHOICE]}`);
    const play: PlayAction = { type: 'play', move: MOVES[vector[D_MOVE]] };
    PLAY_BUTTONS.forEach((b, i) => { play[b] = vector[D_BUTTON + i] === 1; });
    return play;
  }
  for (const dim of PLAY_DIMS) if (vector[dim] !== 0) throw new ActionCodecError(`the ${ACTION_DIMS[dim].name} entry must be 0 in the choice phase, got ${vector[dim]}`);
  if (vector[D_CHOICE] === CHOICE_NONE) throw new ActionCodecError('the choice entry is 0 (no choice) in the choice phase');
  checkFits(observation.mask as ChoiceMask, 'decodeAction');
  return choiceFromIndex(vector[D_CHOICE]);
}

/** Environment action → action vector (the inverse of decodeAction). */
export function encodeAction(action: Action, observation?: { mask: Readonly<ActionMask> }): Int32Array {
  const out = new Int32Array(ACTION_NVEC.length);
  if (action.type === 'play') {
    const m = typeof action.move === 'number' ? action.move : MOVES.indexOf(action.move);
    if (!Number.isInteger(m) || m < 0 || m >= MOVES.length) throw new ActionCodecError(`move ${JSON.stringify(action.move)} is not one of ${MOVES.join(', ')}`);
    out[D_MOVE] = m;
    PLAY_BUTTONS.forEach((b, i) => { out[D_BUTTON + i] = action[b] ? 1 : 0; });
    return out;
  }
  if (observation?.mask.phase === 'choice') checkFits(observation.mask as ChoiceMask, 'encodeAction');
  out[D_CHOICE] = indexFromChoice(action);
  return out;
}

/** True when the mask allows every entry of the vector. */
export function maskAllows(mask: Uint8Array, vector: ArrayLike<number>): boolean {
  for (let i = 0; i < ACTION_NVEC.length; i++) if (!mask[MASK_OFFSETS[i] + vector[i]]) return false;
  return true;
}
