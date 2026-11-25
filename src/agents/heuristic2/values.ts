import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { knowledgeDir } from '../../knowledge/load.ts';

/**
 * What an item, a vitamin or a stat is worth to a build, computed from the game's own effect data (the knowledge
 * export in data/game-knowledge/<build>/: `mods`, `typeBoost`, vitamin `stat` / `perLevel`, and the effect text for
 * the items whose effect is not a stat). Nothing here is a list of "good items": the numbers follow from a build
 * DIRECTION, a set of weights per stat (configs of the heuristic carry them, versioned), and from the kit of the
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

/** The default direction: special / psychic damage, with healing and max HP alongside, and experience and Pokédollars because they become both. */
export const DIRECTION_V1: Direction = {
  version: 'special-sustain-1',
  mul: {
    damage: 1, special: 1, physical: 1, attackSpeed: 0.9, area: 0.45, duration: 0.2, eliteDamage: 0.25, statusDamage: 0.1, statusChance: 0.08, superEffective: 0.2, projSpeed: 0.05, critDamage: 0.5,
    maxHp: 0.8, healing: 0.7, regen: 0.15, powerup: 0.5, xpGain: 0.8, gold: 0.45, moveSpeed: 0.25, jumpHeight: 0, knockback: 0.02, enemyAmount: 0.35, eliteSpawn: 0.1, difficulty: 0.35,
  },
  add: {
    critChance: 110, megaCrit: 60, critDamage: 45, projectiles: 12, bounces: 3, maxHp: 0.4, regen: 4, armor: 0.8, evasion: 60, lifesteal: 250, overheal: 20, shieldMax: 0.3, thorns: 0.02, luck: 0.25, pickupRange: 1, extraJumps: 1, flinch: 5, damage: 100, special: 100,
  },
  typeBoost: 100 * Math.log(1.4),
  text: [
    { pattern: 'survive a lethal hit|revive|you come back|second life', worth: 60, why: 'a second life' },
    { pattern: 'can go up \\d+ more levels|can level up \\d+ more times', worth: 55, why: 'raises a level cap' },
    { pattern: 'you heal|heals you|chance to heal|heal you for', worth: 30, why: 'heals' },
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

export interface Knowledge { items: Map<string, ItemInfo>; vitamins: Map<string, VitaminInfo>; moves: Map<string, MoveInfo>; movesById: Map<number, MoveInfo>; kitOf(species: number): string[] }

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
  return { items, vitamins, moves, movesById, kitOf: (id) => kits.get(id) ?? [] };
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
export function itemWorth(item: ItemInfo, kit: Kit, d: Direction = DIRECTION_V1): Worth {
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
export function vitaminWorth(v: VitaminInfo, kit: Kit, d: Direction = DIRECTION_V1): Worth {
  const out: Worth = { value: 0, risk: 0, why: [] };
  if (v.dice) { out.value = 6; out.why.push('a random stat 6.0'); return out; }
  modWorth(v.kind === 'mul' ? { stat: v.stat, mul: 1 + v.perLevel } : { stat: v.stat, add: v.perLevel }, kit, d, out);
  // A vitamin's side effects are written as the increase per level (0.06 = +6 %).
  for (const m of v.extra) modWorth(m.mul != null && m.mul < 1 ? { stat: m.stat, mul: 1 + m.mul } : m, kit, d, out);
  return out;
}

/** The archive versions of preset unlocked-v4: how many of the least valuable items each takes out of the pool. */
export const ARCHIVES: Record<string, number> = { empty: 0, loose: 20, balanced: 40, narrow: 105 };

/**
 * The item archive of a preset: the `count` least valuable items for the kit, never more than the account's slots,
 * never an item worth `keepAbove` or more, and items of risk only when `archiveRisk` says so.
 */
export function itemArchive(k: Knowledge, kit: Kit, opts: { count: number; slots: number; keepAbove?: number; archiveRisk?: boolean; direction?: Direction }): string[] {
  const d = opts.direction ?? DIRECTION_V1, keepAbove = opts.keepAbove ?? 8;
  const scored = [...k.items.values()].map((it) => { const w = itemWorth(it, kit, d); return { key: it.key, v: w.value + (opts.archiveRisk ? 0 : Math.max(0, w.risk)) }; });
  scored.sort((a, b) => a.v - b.v || a.key.localeCompare(b.key));
  return scored.filter((s) => s.v < keepAbove).slice(0, Math.max(0, Math.min(opts.count, opts.slots))).map((s) => s.key);
}
