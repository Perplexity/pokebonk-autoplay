import { createHash } from 'node:crypto';
import { TARGETED_EXTRAS, UNTARGETED_EXTRAS } from '../actions/codec.ts';
import type { ChoiceAction, ChoiceMask } from '../environment/types.ts';

/**
 * The manager's action space (phase 2 of the heuristic + RL refactor): ONE discrete action per decision.
 *
 *   in a dialog   an option, or one of the dialog's extra actions (the same choices as the low-level codec, with more
 *                 option slots: Ditto lists every distinct item held, and strong runs hold more than 64)
 *   in play       a skill: what the heuristic's brain is told to do for the next second or so
 *
 * Ids are APPEND-ONLY. An id never changes its meaning and is never reused: a new skill, a new map point kind or a new
 * extra action of a later patch is added at the end of its list (the choice block has spare ids for that), so a model
 * trained on this table stays valid on a longer one. `MANAGER_ACTION_VERSION` changes only if that rule is broken.
 */
export const MANAGER_ACTION_VERSION = 1;

/** Option slots of a dialog. The game has 142 held items; Ditto and the shop's sell list have one option per distinct item held. */
export const M_OPTION_SLOTS = 144;
export const M_TARGET_SLOTS = 8;
/** Untargeted extras, in id order. Appended to, never reordered (the low-level codec's list at manager version 1). */
export const M_UNTARGETED = ['refresh', 'skip', 'take', 'sell', 'decline', 'leave', 'confirm', 'reroll'] as const;
export const M_TARGETED = ['banish', 'banishKit'] as const;

export const M_OPTION_BASE = 0;
export const M_EXTRA_BASE = M_OPTION_BASE + M_OPTION_SLOTS;
export const M_TARGET_BASE = M_EXTRA_BASE + M_UNTARGETED.length;
const CHOICE_USED = M_TARGET_BASE + M_TARGETED.length * M_TARGET_SLOTS;
/** Ids from the end of the choice actions to here are spare: never allowed, kept for extra actions a later patch adds. */
export const M_PLAY_BASE = 192;

/**
 * Skills that are not "use a map point", in id order.
 *   farm         fight where the brain sees fit (herding, priority targets, experience on the ground, a live guardian);
 *                the portal of a cleared zone is NOT taken and the guardian is NOT woken
 *   near_portal  the same, kept within the plan's leash of the portal ("fight in the ring": a short way out)
 *   wake         walk to the guardian's altar (the sanctuary: the shrine) through the horde, and wake it
 *   portal       a cleared zone: leave it. Overtime: cash it. The sanctuary after the legendary: the way to Overtime
 *   retreat      get away from the horde and heal (a berry within 30 m, else keep running)
 */
export const SKILLS = ['farm', 'near_portal', 'wake', 'portal', 'retreat'] as const;
export type Skill = (typeof SKILLS)[number];

/**
 * Map point kinds a `use:<kind>` skill exists for, in id order: walk to the nearest unused point of that kind through
 * the horde and use it. Not here: `boss`, `shrine` (the skill `wake`), `portal` (`portal`), and `exp`, `rush`, `tower`,
 * which belong to other game modes.
 */
export const USE_KINDS = [
  'freechest', 'chest', 'cursedchest', 'berry', 'slots', 'meowth', 'ditto', 'cage', 'snorlax', 'magnet', 'rhydon', 'cursed', 'greed',
  'altar', 'challenge', 'power', 'rock', 'bill', 'hypno', 'dojo', 'fossil', 'porygon', 'nest', 'arch', 'bonk', 'fairy', 'grove', 'meadow', 'shroom',
] as const;
export type UseKind = (typeof USE_KINDS)[number];
/** Kinds of the vocabulary that deliberately have no `use` skill. */
export const NOT_USED_KINDS = ['boss', 'shrine', 'portal', 'exp', 'rush', 'tower'] as const;

export const M_USE_BASE = M_PLAY_BASE + SKILLS.length;
export const M_ACTIONS = M_USE_BASE + USE_KINDS.length;

export const skillId = (s: Skill): number => M_PLAY_BASE + SKILLS.indexOf(s);
/** The id of `use:<kind>`, or −1 for a kind without one. */
export const useId = (kind: string): number => { const i = (USE_KINDS as readonly string[]).indexOf(kind); return i < 0 ? -1 : M_USE_BASE + i; };

export type ManagerPlay = { skill: Skill } | { skill: 'use'; kind: UseKind };

export class ManagerActionError extends Error {
  constructor(message: string) { super(message); this.name = 'ManagerActionError'; }
}

/** Name of every id ("option:3", "extra:leave", "extra:banish:0", "spare", "skill:farm", "use:chest"). */
export function actionNames(): string[] {
  const out: string[] = [];
  for (let i = 0; i < M_OPTION_SLOTS; i++) out.push(`option:${i}`);
  for (const e of M_UNTARGETED) out.push(`extra:${e}`);
  for (const e of M_TARGETED) for (let t = 0; t < M_TARGET_SLOTS; t++) out.push(`extra:${e}:${t}`);
  while (out.length < M_PLAY_BASE) out.push('spare');
  for (const s of SKILLS) out.push(`skill:${s}`);
  for (const k of USE_KINDS) out.push(`use:${k}`);
  return out;
}

export interface ManagerActionLayout {
  version: number;
  size: number;
  names: string[];
  optionSlots: number;
  targetSlots: number;
  playBase: number;
  useBase: number;
  hash: string;
}

/** The action table as data: what Python builds its Discrete space from. */
export function managerActionLayout(): ManagerActionLayout {
  if (CHOICE_USED > M_PLAY_BASE) throw new ManagerActionError(`the choice actions (${CHOICE_USED}) run into the play actions (from ${M_PLAY_BASE})`);
  const body = { version: MANAGER_ACTION_VERSION, size: M_ACTIONS, names: actionNames(), optionSlots: M_OPTION_SLOTS, targetSlots: M_TARGET_SLOTS, playBase: M_PLAY_BASE, useBase: M_USE_BASE };
  return { ...body, hash: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}

/** The id of a choice action. Throws for an action the table has no id for (nothing is remapped). */
export function idOfChoice(a: ChoiceAction): number {
  if ('option' in a) {
    if (!Number.isInteger(a.option) || a.option < 0) throw new ManagerActionError(`option ${a.option} is not an option index`);
    if (a.option >= M_OPTION_SLOTS) throw new ManagerActionError(`option ${a.option} is beyond the ${M_OPTION_SLOTS} option slots of the manager's action table`);
    return M_OPTION_BASE + a.option;
  }
  const t = (M_TARGETED as readonly string[]).indexOf(a.extra);
  if (a.target !== undefined) {
    if (t < 0) throw new ManagerActionError(`the extra action "${a.extra}" takes no target in the manager's action table`);
    if (!Number.isInteger(a.target) || a.target < 0 || a.target >= M_TARGET_SLOTS) throw new ManagerActionError(`target ${a.target} is outside the ${M_TARGET_SLOTS} target slots`);
    return M_TARGET_BASE + t * M_TARGET_SLOTS + a.target;
  }
  const u = (M_UNTARGETED as readonly string[]).indexOf(a.extra);
  if (u < 0) throw new ManagerActionError(`the manager's action table has no extra action "${a.extra}"`);
  return M_EXTRA_BASE + u;
}

/** The choice action of an id below `M_PLAY_BASE`. */
export function choiceOfId(id: number): ChoiceAction {
  if (!Number.isInteger(id) || id < 0 || id >= CHOICE_USED) throw new ManagerActionError(`action ${id} is not a choice (choices: 0–${CHOICE_USED - 1})`);
  if (id < M_EXTRA_BASE) return { type: 'choice', option: id - M_OPTION_BASE };
  if (id < M_TARGET_BASE) return { type: 'choice', extra: M_UNTARGETED[id - M_EXTRA_BASE] };
  const k = id - M_TARGET_BASE;
  return { type: 'choice', extra: M_TARGETED[Math.floor(k / M_TARGET_SLOTS)], target: k % M_TARGET_SLOTS };
}

/** The skill of an id from `M_PLAY_BASE` on. */
export function playOfId(id: number): ManagerPlay {
  if (!Number.isInteger(id) || id < M_PLAY_BASE || id >= M_ACTIONS) throw new ManagerActionError(`action ${id} is not a skill (skills: ${M_PLAY_BASE}–${M_ACTIONS - 1})`);
  return id < M_USE_BASE ? { skill: SKILLS[id - M_PLAY_BASE] } : { skill: 'use', kind: USE_KINDS[id - M_USE_BASE] };
}

/** The mask of a dialog over the whole table (1 = allowed). Throws when the dialog does not fit: nothing is truncated. */
export function choiceMaskIds(mask: ChoiceMask, out: Uint8Array = new Uint8Array(M_ACTIONS)): Uint8Array {
  if (mask.options.length > M_OPTION_SLOTS) throw new ManagerActionError(`the dialog has ${mask.options.length} options; the manager's action table has ${M_OPTION_SLOTS} option slots`);
  mask.options.forEach((ok, i) => { if (ok) out[M_OPTION_BASE + i] = 1; });
  for (const [extra, m] of Object.entries(mask.extras)) {
    if (Array.isArray(m)) {
      const t = (M_TARGETED as readonly string[]).indexOf(extra);
      if (t < 0) throw new ManagerActionError(`the dialog aims the extra action "${extra}" at an option; the table has targets only for ${M_TARGETED.join(', ')}`);
      if (m.length > M_TARGET_SLOTS) throw new ManagerActionError(`the extra action "${extra}" can aim at ${m.length} options; the table has ${M_TARGET_SLOTS} target slots`);
      m.forEach((ok, i) => { if (ok) out[M_TARGET_BASE + t * M_TARGET_SLOTS + i] = 1; });
    } else if (m === true) {
      const u = (M_UNTARGETED as readonly string[]).indexOf(extra);
      if (u < 0) throw new ManagerActionError(`the dialog has the extra action "${extra}", which the manager's action table does not have`);
      out[M_EXTRA_BASE + u] = 1;
    }
  }
  return out;
}

// The low-level codec's extras at the time this table was written: a difference means the codec grew, and the new
// extra must be APPENDED to the lists above (never inserted).
for (const e of UNTARGETED_EXTRAS) if (!(M_UNTARGETED as readonly string[]).includes(e)) throw new ManagerActionError(`the low-level codec has the extra action "${e}"; append it to M_UNTARGETED`);
for (const e of TARGETED_EXTRAS) if (!(M_TARGETED as readonly string[]).includes(e)) throw new ManagerActionError(`the low-level codec has the targeted extra action "${e}"; append it to M_TARGETED`);
