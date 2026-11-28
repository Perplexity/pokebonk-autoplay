import type { Action as BrainAction, Vec } from './brain/movement.ts';
import { MOVES } from '../environment/types.ts';
import type { Move, PlayAction, PlayMask } from '../environment/types.ts';

/**
 * The brain (src/bot/brain/movement.ts) decides a free heading on the ground and four buttons; the environment takes
 * one of eight world directions and the same four buttons, each allowed only while the mask says so.
 */

/** sin 22.5°, a hair lower: a heading exactly between two of the eight directions goes to the diagonal. */
const HALF_SECTOR = Math.sin(Math.PI / 8) - 1e-9;

/** The nearest of the eight world directions to a heading (+x is east, −z is north), or `none` for no heading. */
export function nearestMove(v: Vec | null): Move {
  if (!v) return 'none';
  const l = Math.hypot(v.x, v.z);
  if (!(l > 1e-9)) return 'none';
  const x = v.x / l, z = v.z / l;
  const ew = x > HALF_SECTOR ? 'e' : x < -HALF_SECTOR ? 'w' : '';
  const ns = z > HALF_SECTOR ? 's' : z < -HALF_SECTOR ? 'n' : '';
  return (ns + ew) as Move;
}

/** What the adapter had to leave out because the mask forbids it right now. */
export interface Dropped { ultimate: boolean; interact: boolean; move: boolean }

/** A brain action as a valid play action for this mask. Never asks for a masked button or direction. */
export function toPlayAction(a: BrainAction, mask: PlayMask): { action: PlayAction; dropped: Dropped } {
  let move = nearestMove(a.move);
  const dropped: Dropped = { ultimate: a.ult && !mask.ultimate, interact: a.interact && !mask.interact, move: false };
  if (!mask.move[MOVES.indexOf(move)]) { dropped.move = true; move = 'none'; }
  const action: PlayAction = { type: 'play', move };
  if (a.jump && mask.jump) action.jump = true;
  if (a.dash && mask.dash) action.dash = true;
  if (a.ult && mask.ultimate) action.ultimate = true;
  if (a.interact && mask.interact) action.interact = true;
  return { action, dropped };
}
