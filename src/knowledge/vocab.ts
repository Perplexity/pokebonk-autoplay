import type { DecisionKind, ExtraAction } from '../environment/types.ts';

/**
 * Vocabularies: a stable integer for every categorical key an observation can carry (species, moves, items, …).
 *
 * Rules, so that an index means the same thing in every process and in Python:
 *   - index 0 of every table is reserved for "none / unknown";
 *   - the keys of a table are sorted (numeric keys numerically, the others by UTF-16 code unit) and numbered from 1;
 *   - a table only changes when the game build or VOCAB_VERSION changes; both are in the file's header.
 */
/** 2: decision kinds `dojoPrize`, `lesson`, `shopSell`. */
export const VOCAB_VERSION = 2;

/** Every dialog kind the environment raises. Kept in step with `DecisionKind` by the type check below. */
export const DECISION_KINDS = [
  'levelup', 'evolution', 'item', 'itemChoice', 'blessing', 'seals', 'sanctuaryPath', 'leaveSanctuary', 'overtimeStart', 'overtimeOffer',
  'trade', 'shop', 'ditto', 'party', 'shinySwap', 'relic', 'dojo', 'dojoPrize', 'slots', 'forget', 'lesson', 'fusion', 'shopSell',
] as const satisfies readonly DecisionKind[];
/** Kinds of fusion recipe at Bill's machine (the game's own `kind` of a recipe). */
export const FUSION_KINDS = ['signature', 'reaction', 'type', 'glitch'] as const;
/** Every extra action a dialog can offer. Kept in step with `ExtraAction` by the type check below. */
export const EXTRA_ACTIONS = ['refresh', 'skip', 'banish', 'banishKit', 'take', 'sell', 'decline', 'leave', 'confirm', 'reroll'] as const satisfies readonly ExtraAction[];
/** Kinds of level-up offer the game's offer generator produces in the standard mode. */
export const OFFER_KINDS = ['newMove', 'upMove', 'newVit', 'upVit'] as const;

type Missing<All, Listed> = Exclude<All, Listed> extends never ? true : { missing: Exclude<All, Listed> };
const decisionKindsComplete: Missing<DecisionKind, (typeof DECISION_KINDS)[number]> = true;
const extraActionsComplete: Missing<ExtraAction, (typeof EXTRA_ACTIONS)[number]> = true;
void decisionKindsComplete; void extraActionsComplete;

export type VocabTable = Record<string, number>;

/** Sorted keys → indexes 1…n. Throws on a duplicate or empty key: a vocabulary must be unambiguous. */
export function makeTable(keys: Iterable<string | number>): VocabTable {
  const list = [...keys].map(String);
  const seen = new Set<string>();
  for (const k of list) {
    if (!k) throw new Error('[vocab] empty key');
    if (seen.has(k)) throw new Error(`[vocab] duplicate key "${k}"`);
    seen.add(k);
  }
  const numeric = list.every((k) => /^\d+$/.test(k));
  list.sort(numeric ? (a, b) => Number(a) - Number(b) : (a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out: VocabTable = {};
  list.forEach((k, i) => { out[k] = i + 1; });
  return out;
}

/** Number of indexes a table uses, the reserved 0 included (the size an embedding or one-hot needs). */
export const tableSize = (t: VocabTable): number => Object.keys(t).length + 1;

/** Index of a key, 0 when the key is absent, null or unknown. */
export const indexOf = (t: VocabTable, key: string | number | null | undefined): number => (key === null || key === undefined ? 0 : t[String(key)] ?? 0);
