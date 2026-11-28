import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { knowledgeDir } from '../knowledge/load.ts';

/**
 * What an item, a vitamin or a stat is worth to a build, computed from the game's own effect data (the knowledge
 * export in data/game-knowledge/<build>/: `mods`, `typeBoost`, vitamin `stat` / `perLevel`, and the effect text for
 * the items whose effect is not a stat). Nothing here is a list of "good items": the numbers follow from a build
 * DIRECTION, a set of weights per stat (the plan carries it), and from the kit of the
 * Pokémon (which damage class and which types its moves have).
 *
 * Unit: roughly "per cent of the build's strength". A multiplier m of a stat with weight w is worth 100·w·ln(m).
 */

export interface StatMod { stat: string; add?: number; mul?: number }
export interface ItemInfo { key: string; name: string; rarity: number; desc: string; mods: StatMod[]; tags: string[]; maxStack: number | null; typeBoost: string | null; shop: boolean }
export interface VitaminInfo { key: string; name: string; stat: string; perLevel: number; kind: string; desc: string; dice: boolean; maxLevel: number; extra: StatMod[] }
export interface MoveInfo { key: string; id: number; type: string; class: string; archetype: string; damage: number; cooldown: number }
export interface Kit { /** share of the kit's moves that are special (0–1) */ special: number; /** share of the kit's moves per type */ types: Record<string, number> }

export interface Direction {
  version: string;
  /** Weight of a multiplier of the stat (worth 100·w·ln(m)). `special` and `physical` are multiplied by the kit's share of that class. */
  mul: Record<string, number>;
  /** Worth of +1 of the stat when the effect is an addition. */
  add: Record<string, number>;
  /** Worth of a type bonus (×1.4 for moves of one type) per share of the kit that has the type. */
  typeBoost: number;
  /** Effects without a stat, found in the effect text: pattern → worth. The first matching pattern of a group counts. */
  text: { pattern: string; worth: number; why: string }[];
  /** Stats that make the horde bigger or stronger: their worth is counted only when the plan says the build can take it. */
  risk: string[];
}

/**
 * The direction (version `luck-experience-1`). Damage is the yardstick. Luck, experience and Pokédollars stand at
 * what they were measured to be worth against it (tier 2, Mewtwo, seeds 1 to 30, one stat of the build multiplied
 * from the first second by a cheating probe: luck ×3 gave ×2.8 of the score, experience ×5 gave ×2.4, Pokédollars ×5
 * gave ×1.8, damage ×10 gave ×1.5; armor ×3 and healing ×5 gave nothing). Armor, healing, regeneration and the other
 * ways of taking a hit stand at a fraction: the plan takes no hit while it still kills, and leaves or cashes when it
 * no longer does.
 */
export const DIRECTION: Direction = {
  version: 'luck-experience-1',
  mul: {
    damage: 1, special: 1, physical: 1, attackSpeed: 0.9, area: 0.45, duration: 0.2, eliteDamage: 0.25, statusDamage: 0.1, statusChance: 0.08, superEffective: 0.2, projSpeed: 0.05, critDamage: 0.5,
    maxHp: 0.5, healing: 0.15, regen: 0.05, powerup: 0.5, xpGain: 1.7, gold: 1.5, moveSpeed: 0.25, jumpHeight: 0, knockback: 0.02, enemyAmount: 0.35, eliteSpawn: 0.1, difficulty: 0.35,
  },
  add: {
    critChance: 110, megaCrit: 60, critDamage: 45, projectiles: 12, bounces: 3, maxHp: 0.25, regen: 1, armor: 0.15, evasion: 20, lifesteal: 60, overheal: 5, shieldMax: 0.1, thorns: 0.02, luck: 1.2, pickupRange: 1, extraJumps: 1, flinch: 5, damage: 100, special: 100,
  },
  typeBoost: 100 * Math.log(1.4),
  text: [
    { pattern: 'survive a lethal hit|revive|you come back|second life', worth: 60, why: 'a second life' },
    { pattern: 'can go up \\d+ more levels|can level up \\d+ more times', worth: 55, why: 'raises a level cap' },
    { pattern: 'you heal|heals you|chance to heal|heal you for', worth: 10, why: 'heals' },
    { pattern: 'fall instantly|instantly (ko|defeat)|finish(es)? (off )?enem', worth: 22, why: 'finishes weakened enemies' },
    { pattern: 'grows with your (level|armor)|every \\d+(\\.\\d+)? s (it |you |lightning )', worth: 14, why: 'a damage source of its own' },
    { pattern: 'charge you \\d+% less|more (unown altars?|poké balls)|one more relic|\\+1 slot', worth: 15, why: 'economy or map' },
    { pattern: 'fully (shields|block)|invulnerable', worth: 14, why: 'blocks hits' },
    { pattern: 'support alphas?', worth: 8, why: 'allies' },
    { pattern: 'ultimate', worth: 10, why: 'ultimate' },
    { pattern: 'stun|root|freez|paralyz|sleep|charm|curses', worth: 6, why: 'control' },
  ],
  risk: ['enemyAmount', 'eliteSpawn', 'difficulty'],
};

export interface Knowledge {
  items: Map<string, ItemInfo>; vitamins: Map<string, VitaminInfo>; moves: Map<string, MoveInfo>; movesById: Map<number, MoveInfo>; kitOf(species: number): string[];
  /**
   * The moves a free slot of the species can be offered besides its kit: of its own line, and of other League members;
   * and the level of the Pokémon from which each can be offered (the game's own rule: a move of the line learnt at
   * level n from level (n − 10) / 2.6, a move of another member from the level its slot in that member's kit opens).
   */
  learnable(species: number): { line: string[]; shared: string[]; from: Record<string, number> };
}

/** The knowledge export of a game build, as the valuation needs it. */
export function loadValuationKnowledge(build: string, dir = knowledgeDir(build)): Knowledge {
  const read = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const it = read('items.json'), mv = read('moves.json'), sp = read('species.json');
  const items = new Map<string, ItemInfo>(it.heldItems.map((x: any) => [x.key, { key: x.key, name: x.name, rarity: x.rarity, desc: String(x.desc ?? ''), mods: x.mods ?? [], tags: x.tags ?? [], maxStack: x.maxStack ?? null, typeBoost: x.typeBoost ?? null, shop: x.unlockPriceStardust != null }]));
  const vitamins = new Map<string, VitaminInfo>(it.vitamins.map((x: any) => [x.key, { key: x.key, name: x.name, stat: x.stat, perLevel: x.perLevel, kind: x.kind, desc: String(x.desc ?? ''), dice: !!x.dice, maxLevel: x.maxLevel ?? 10, extra: x.extra ?? [] }]));
  const moves = new Map<string, MoveInfo>(mv.moves.map((x: any) => [x.key, { key: x.key, id: x.id, type: x.type, class: x.class, archetype: x.archetype, damage: x.damage, cooldown: x.cooldown }]));
  const movesById = new Map<number, MoveInfo>([...moves.values()].map((m) => [m.id, m]));
  const species: any[] = Array.isArray(sp.species) ? sp.species : Object.values(sp.species);
  const kits = new Map<number, string[]>(species.map((s) => [s.id, (s.kit ?? []).map((k: any) => (typeof k === 'string' ? k : k.move))]));
  const keys = (list: any): string[] => (Array.isArray(list) ? list : []).map((x: any) => String(x.move));
  const pools = new Map<number, { line: string[]; shared: string[]; from: Record<string, number> }>(species.map((s) => {
    const m = s.moves?.[String(s.id)] ?? {}, from: Record<string, number> = {};
    for (const x of Array.isArray(m.line) ? m.line : []) from[String(x.move)] = Math.max(1, Math.ceil((Number(x.level) - 10) / 2.6));
    for (const x of Array.isArray(m.shared) ? m.shared : []) from[String(x.move)] = Math.max(1, Number(x.level) || 1);
    return [s.id, { line: keys(m.line), shared: keys(m.shared), from }];
  }));
  return { items, vitamins, moves, movesById, kitOf: (id) => kits.get(id) ?? [], learnable: (id) => pools.get(id) ?? { line: [], shared: [], from: {} } };
}

/** The kit's damage classes and types, from the moves the Pokémon's own kit has. */
export function kitOf(k: Knowledge, species: number): Kit {
  const moves = k.kitOf(species).map((key) => k.moves.get(key)).filter((m): m is MoveInfo => !!m && m.damage > 0);
  const n = Math.max(1, moves.length), types: Record<string, number> = {};
  for (const m of moves) types[m.type] = (types[m.type] ?? 0) + 1 / n;
  return { special: moves.filter((m) => m.class === 'special').length / n, types };
}

export interface Worth { value: number; risk: number; why: string[] }

/** Share of an unconditional effect that a conditional one is counted as. */
const CONDITIONAL = 0.6;

/** The damage multiplier an effect text promises, as an expected value where it gives a chance; 1 when it promises none. */
export function textMultiplier(text: string): number {
  const num = (x: string) => Number(x);
  const chance = /(\d+(?:\.\d+)?)% chance[^.]*?×(\d+(?:\.\d+)?) damage/.exec(text);
  if (chance) return 1 + (num(chance[1]) / 100) * (num(chance[2]) - 1);
  const upTo = /up to ×(\d+(?:\.\d+)?)/.exec(text) ?? /up to \+(\d+(?:\.\d+)?)%/.exec(text);
  if (upTo && /damage/.test(text)) return upTo[0].includes('×') ? num(upTo[1]) : 1 + num(upTo[1]) / 100;
  const times = /×(\d+(?:\.\d+)?) damage/.exec(text) ?? /damage ×(\d+(?:\.\d+)?)/.exec(text) ?? /deal ×(\d+(?:\.\d+)?)/.exec(text);
  if (times) return num(times[1]);
  const plus = /\+(\d+(?:\.\d+)?)% damage(?! taken)/.exec(text);
  return plus ? 1 + num(plus[1]) / 100 : 1;
}

function modWorth(m: StatMod, kit: Kit, d: Direction, out: Worth): void {
  const classShare = m.stat === 'special' ? kit.special : m.stat === 'physical' ? 1 - kit.special : 1;
  let v = 0;
  if (m.mul != null && m.mul > 0) v += 100 * (d.mul[m.stat] ?? 0) * Math.log(m.mul) * classShare;
  if (m.add != null) v += (d.add[m.stat] ?? 0) * m.add * classShare;
  if (!v) return;
  if (d.risk.includes(m.stat)) { out.risk += v; out.why.push(`${m.stat} (risk) ${v.toFixed(1)}`); } else { out.value += v; out.why.push(`${m.stat} ${v.toFixed(1)}`); }
}

/** Worth of one more of an item. `risk` is the part that is only worth it while the build can take a bigger horde. */
export function itemWorth(item: ItemInfo, kit: Kit, d: Direction = DIRECTION): Worth {
  const out: Worth = { value: 0, risk: 0, why: [] };
  for (const m of item.mods) modWorth(m, kit, d, out);
  if (item.typeBoost) { const v = d.typeBoost * (kit.types[item.typeBoost] ?? 0); if (v) { out.value += v; out.why.push(`${item.typeBoost} moves ${v.toFixed(1)}`); } }
  const text = item.desc.toLowerCase();
  // A damage multiplier written in the text ("×1.2 damage to …", "up to ×1.35", "+2% damage … up to +40%", "3% chance …
  // ×8 damage"): it holds under a condition, so it counts for part of what an unconditional one would.
  if (!item.typeBoost) {
    const m = textMultiplier(text);
    if (m > 1) { const v = 100 * (d.mul.damage ?? 0) * Math.log(m) * CONDITIONAL; out.value += v; out.why.push(`×${m.toFixed(2)} damage under a condition ${v.toFixed(1)}`); }
  }
  const aspd = /\+(\d+(?:\.\d+)?)% attack speed/.exec(text);
  if (aspd && !item.mods.some((x) => x.stat === 'attackSpeed')) { const up = /attack speed[^.]*up to \+(\d+(?:\.\d+)?)%/.exec(text); const v = 100 * (d.mul.attackSpeed ?? 0) * Math.log(1 + Number((up ?? aspd)[1]) / 100) * CONDITIONAL; out.value += v; out.why.push(`attack speed under a condition ${v.toFixed(1)}`); }
  // Effects that are not a number: the first rule that matches.
  for (const rule of d.text) {
    if (!new RegExp(rule.pattern).test(text)) continue;
    out.value += rule.worth; out.why.push(`${rule.why} ${rule.worth.toFixed(1)}`);
    break;
  }
  // What the text says it costs.
  if (/you take ×1\.\d+ damage|more damage taken/.test(text)) { out.value -= 10; out.why.push('more damage taken -10.0'); }
  return out;
}

/** Worth of one level of a vitamin. */
export function vitaminWorth(v: VitaminInfo, kit: Kit, d: Direction = DIRECTION): Worth {
  const out: Worth = { value: 0, risk: 0, why: [] };
  if (v.dice) { out.value = 6; out.why.push('a random stat 6.0'); return out; }
  modWorth(v.kind === 'mul' ? { stat: v.stat, mul: 1 + v.perLevel } : { stat: v.stat, add: v.perLevel }, kit, d, out);
  // A vitamin's side effects are written as the increase per level (0.06 = +6 %).
  for (const m of v.extra) modWorth(m.mul != null && m.mul < 1 ? { stat: m.stat, mul: 1 + m.mul } : m, kit, d, out);
  return out;
}

/** How many times more an item that stacks without a limit of its own is worth keeping in the pool. */
const STACK_BONUS = 3;

/**
 * The item archive `stack-2`: what the account takes out of the pool for this kit. As many items as the account has
 * slots for, the least valuable first, where an item that cannot be stacked without limit counts for a third: what
 * stays in the pool is what the direction values highly and what can be held ten times. (A leaderboard Mewtwo held
 * 308 items of 71 kinds, ten each of the multipliers; a smaller pool offers the same item more often.)
 */
export const ARCHIVE_NAMES: string[] = ['stack-2'];

/** The items an archive takes out of the pool for this kit, never more than the account's slots. */
export function archiveOf(name: string, k: Knowledge, kit: Kit, slots: number): string[] {
  if (name !== 'stack-2') throw new Error(`unknown archive "${name}": use one of ${ARCHIVE_NAMES.join(', ')}`);
  const scored = [...k.items.values()].map((it) => { const w = itemWorth(it, kit, DIRECTION); return { key: it.key, v: (w.value + Math.max(0, w.risk)) * (it.maxStack == null ? STACK_BONUS : 1) }; });
  scored.sort((a, b) => a.v - b.v || a.key.localeCompare(b.key));
  return scored.slice(0, Math.max(0, slots)).map((x) => x.key);
}
