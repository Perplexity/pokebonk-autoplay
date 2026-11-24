import { ORIGIN } from '../sim/net.ts';

/**
 * The game's own functions behind the dialogs whose buttons carry the logic in the HUD (Hypno, the shop's sell row,
 * the dojo's prize list). The HUD's click handlers call module-level functions of the game chunks; the environment
 * calls the same functions with the same arguments, so that no button is ever built or clicked.
 *
 * Their names are minified. Each is found among the exports of the loaded chunks by what its source does, and must
 * match exactly one function; anything else means the build has changed and is an error.
 */
export interface GameFns {
  /** (run, moveSlot) → Pokédollars paid. Hypno: forget the move in that slot. */
  forgetMove(run: unknown, slot: number): number;
  /** (run, vitaminKey) → Pokédollars paid. Hypno: forget that vitamin. */
  forgetVitamin(run: unknown, key: string): number;
  /** (run) → Hypno's lesson of this zone has not been used yet. Pure. */
  lessonReady(run: unknown): boolean;
  /** (run) → the key the game stores in `run.lessonAt` when the lesson is used ("s<zone>"). Pure. */
  lessonKey(run: unknown): string;
  /** (run, n) → the n offers of Hypno's lesson (draws from the run's roll stream, like a level-up). */
  lessonOffers(run: unknown, n: number): any[];
  /** (run, offer): apply a level-up style offer (new move, move upgrade, vitamin). */
  applyOffer(run: unknown, offer: unknown): void;
  /** (run, move) → what Hypno pays for forgetting it. Pure. */
  movePrice(run: unknown, move: unknown): number;
  /** (run, vitamin) → what Hypno pays for forgetting it. Pure. */
  vitaminPrice(run: unknown, vitamin: unknown): number;
  /** (run) → price of the next slot-machine spin. Pure. */
  slotCost(run: unknown): number;
  /** (run, rarity) → what the shop pays for an item of that rarity. Pure. */
  sellPrice(run: unknown, rarity: number): number;
  /** (run, belt) → the blessings a dojo trial of that belt can be fought for: `{ label, mods: [{ stat, … }], rarity }`. */
  dojoPrizes(run: unknown, belt: number): any[];
  /** (run, trial) → the trial's numbers now: `{ goal, limit, … }` (they follow the run's kill pace and zone). Pure. */
  dojoParams(run: unknown, trial: unknown): Record<string, unknown>;
  /** The game's held-item table: key → `{ rarity, max?, … }`. */
  items: Map<string, { rarity: number; max?: number }>;
  /** Run method that adds Pokédollars (the one every sale in the game goes through). */
  runGainGold: string;
  /** Where each one was found: `<chunk file>#<export name>`, or `Run#<method>`. */
  sources: Record<string, string>;
}

const W = '[\\w$]+';
const re = (s: string): RegExp => new RegExp(s.replaceAll('§', () => W));

/** One source test per exported function. */
const FUNCTIONS: Record<Exclude<keyof GameFns, 'items' | 'runGainGold' | 'sources'>, RegExp> = {
  forgetMove: re('\\.moves\\[§\\];if\\(!§\\)return 0;.*\\.stats\\.forgets\\+\\+'),
  forgetVitamin: re('\\.vitamins\\.get\\(§\\);if\\(!§\\)return 0;.*\\.vitamins\\.delete\\(§\\).*\\.stats\\.forgets\\+\\+'),
  lessonReady: re('^§=>§\\.lessonAt!==§\\(§\\)$'),
  lessonKey: re('^§=>§\\.endless\\?`e`\\+Math\\.floor\\(§\\.time/600\\):`s`\\+§\\.stage$'),
  lessonOffers: re('^function §\\(§,§=3\\)\\{return §\\(§,`lesson`,'),
  applyOffer: re('switch\\(§\\.kind\\)\\{case`newMove`:§\\.§\\(§\\.id\\),§\\.stats\\.movesLearned\\+\\+'),
  movePrice: re('^\\(§,§\\)=>\\(§\\.level\\+\\(§\\.link\\?\\.level\\?\\?0\\)\\)\\*8\\*§\\.stage$'),
  vitaminPrice: re('^\\(§,§\\)=>§\\.level\\*6\\*§\\.stage$'),
  // The exported one-argument wrapper of the price formula (`price(run, spinsAhead)`, which is not exported itself).
  slotCost: re('^function §\\(§\\)\\{return §\\(§,0\\)\\}$'),
  sellPrice: re('^function §\\(§,§\\)\\{let §=§\\*§\\[§\\]\\*§\\(§\\);return Math\\.round\\(Math\\.max\\(\\[10,18,30,50,90\\]\\[§\\]\\*§\\.stage,'),
  dojoPrizes: re('^function §\\(§,§\\)\\{let §=§\\[§\\];return §\\(§\\)\\.filter\\(§=>\\(§\\.min\\?\\?0\\)<=§\\)\\.map\\('),
  dojoParams: re('^\\(§,§\\)=>§\\(§\\.key\\)\\.params\\(§\\.belt,§\\(§\\)\\)$'),
};

const isItemTable = (v: unknown): v is Map<string, { rarity: number }> => {
  if (!(v instanceof Map) || v.size < 50) return false;
  for (const [k, o] of v) if (typeof k !== 'string' || !o || typeof o !== 'object' || typeof (o as any).rarity !== 'number' || !Array.isArray((o as any).mods) || 'passive' in (o as object)) return false;
  return true;
};

/** Find the functions among the exports of the chunks the game has loaded (`loaded` = their URL paths). */
export async function resolveGameFns(loaded: string[], RunClass: { prototype: object }): Promise<GameFns> {
  const hits: Record<string, { value: unknown; where: string }[]> = {};
  const add = (key: string, value: unknown, where: string) => { if (!(hits[key] ??= []).some((h) => h.value === value)) hits[key].push({ value, where }); };
  for (const path of loaded) {
    // Same URL the game imported: the module is already evaluated, this only hands back its namespace object.
    const mod = (await import(`${ORIGIN}${path}`)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      const where = `${path.split('/').pop()}#${name}`;
      if (typeof value === 'function') {
        const src = Function.prototype.toString.call(value);
        for (const [key, test] of Object.entries(FUNCTIONS)) if (test.test(src)) add(key, value, where);
      } else if (isItemTable(value)) add('items', value, where);
    }
  }
  const one = <T>(key: string): { value: T; where: string } => {
    const h = hits[key] ?? [];
    if (h.length !== 1) throw new Error(`[environment] game function "${key}": expected exactly one matching export in the bundle, found ${h.length}${h.length ? ` (${h.map((x) => x.where).join(', ')})` : ''}. The game build has changed; re-validate src/environment/gamefns.ts.`);
    return h[0] as { value: T; where: string };
  };
  const gold: string[] = [];
  for (const name of Object.getOwnPropertyNames(RunClass.prototype)) {
    if (name === 'constructor') continue;
    const d = Object.getOwnPropertyDescriptor(RunClass.prototype, name);
    if (typeof d?.value === 'function' && /^[\w$]+\([\w$]+\)\{let [\w$]+=Math\.round\([\w$]+\);this\.gold\+=[\w$]+,this\.stats\.gold\+=[\w$]+,/.test(Function.prototype.toString.call(d.value))) gold.push(name);
  }
  if (gold.length !== 1) throw new Error(`[environment] could not identify the run's "gain Pokédollars" method: ${gold.length} candidates. The game build has changed; re-validate src/environment/gamefns.ts.`);

  const out = { runGainGold: gold[0], sources: { runGainGold: `Run#${gold[0]}` } } as unknown as GameFns;
  for (const key of [...Object.keys(FUNCTIONS), 'items'] as (keyof GameFns)[]) {
    const h = one<unknown>(key);
    (out as unknown as Record<string, unknown>)[key] = h.value;
    out.sources[key] = h.where;
  }
  return out;
}
