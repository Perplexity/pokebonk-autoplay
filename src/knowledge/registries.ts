import { ORIGIN } from '../sim/net.ts';

/**
 * The game's own data tables and helper functions, found among the exports of the chunks the running bundle has
 * loaded. Same technique and same rule as src/environment/profile.ts: export names are minified and change with every
 * build, so each table is recognised by its shape (and each function by what its source does) and must match exactly
 * one export. Anything else means the build changed and stops the export: nothing is guessed.
 *
 * Everything here is read. No table is modified and no function with side effects is called (the three functions
 * below are the game's own pure lookups; see scripts/export-knowledge.ts for how they are used).
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Map) && !(v instanceof Set);
const allObjs = (v: unknown): v is Obj[] => Array.isArray(v) && v.length > 0 && v.every(isObj);
const values = (v: Obj): unknown[] => Object.values(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string');

export interface StatMod { stat: string; add?: number; mul?: number }
export interface Vitamin { key: string; name: string; icon: string; stat: string; per: number; kind: string; desc: string; note?: string; extra?: { stat: string; mul: number }[]; dice?: boolean }
export interface HeldItem { key: string; rarity: number; desc: string; mods: StatMod[]; tags?: string[]; max?: number }
export interface Relic { key: string; rarity: number; name: string; mods: StatMod[]; passive: string; desc: string; v?: Record<string, number> }
export interface Archetype { dmg: number; cd: number; count: number; area: number; speed: number; dur: number; pierce: number; label: string; desc: string; stats: string[] }
export interface Passive { name: string; desc: string; mods?: StatMod[]; [hook: string]: unknown }
export interface Fusion { key: string; kind: string; name: string; desc: string; member?: number; moves?: string[]; pair?: string[][]; type?: string; type2?: string; cls?: string; cd?: number; power?: number; hits?: number; range?: number; status?: string; repeats?: boolean }
export interface MoveDef {
  id: number; key: string; name: string; type: string; cls: string; arch: string; dmg: number; cd: number; count: number; area: number; speed: number; dur: number; pierce: number;
  status: string | null; statusChance: number; drain: number; critBonus: number; flinch: number; power?: number; desc: string; [extra: string]: unknown;
}
/** What the game's own "move plan" function returns for a species: its kit, its line (level-up moves) and the kits it can borrow from. */
export interface MovePlan {
  kit: { id: number; level: number }[];
  line: { id: number; level: number }[];
  shared: { id: number; level: number; from: number[]; open: boolean }[];
  /** Only for the member whose passive lets it learn any move. */
  any: { id: number; level: number }[] | null;
}
export interface DexSpecies {
  id: number; key: string; name: string; types: string[]; stats: Record<string, number>; bst: number; legendary: boolean; mythical: boolean; baby: boolean;
  evoFrom: number | null; evoLevel: number | null; evoStage: number; family: number;
}
/** The bundle's reference data object. */
export interface Dex {
  pokemon: DexSpecies[];
  byId: Map<number, DexSpecies>;
  moves: Map<number, { id: number; key: string; name: string; type: string; cls: string; power: number | null }>;
  movesByKey: Map<string, { id: number; key: string }>;
  items: Record<string, { id: number; name: string; desc: string }>;
  types: { types: string[]; names: Record<string, string>; chart: number[][] };
  johtoEvolutions: Map<number, { id: number }[]>;
  get(id: number): DexSpecies;
  evolutionsOf(id: number): DexSpecies[];
  root(id: number): DexSpecies;
}

export interface KnowledgeRegistries {
  vitamins: Vitamin[];
  items: HeldItem[];
  relics: Relic[];
  /** Held-item key → the type whose moves it boosts. */
  typeBoostItems: Record<string, string>;
  /** Run boosts (the consumable bag): descriptions, and Stardust prices. Not used by the environment (runs start with none). */
  boosts: { id: string; name: string; desc: string }[];
  boostPrices: { id: string; price: number; daily: number }[];
  seals: string[];
  overtimeOfferings: string[];
  overtime: Record<string, unknown>;
  tierTable: Record<string, number[]>;
  weather: Record<string, { name: string; boost: string[]; nerf: string[] }>;
  rarityMultipliers: number[];
  rarityNames: string[];
  archetypes: Record<string, Archetype>;
  passives: Record<string, Passive>;
  /** Alternative-form passives, keyed by the form's species number. */
  formPassives: Record<string, { desc: string; mods: StatMod[] }>;
  /** Ultimate definitions keyed by League member (and, separately, by alternative form). */
  ultimates: Record<string, { names: string[]; descs: string[]; type?: string; cls?: string; dur?: number[] }>;
  formUltimates: Record<string, { names: string[]; descs: string[]; type?: string; cls?: string; dur?: number[] }>;
  fusions: Fusion[];
  fusionDefs: Map<number, MoveDef>;
  statuses: Record<string, string>;
  typeStatus: Record<string, string | null>;
  enemyFlags: Record<string, number | string>;
  projectileFlags: Record<string, number | string>;
  typeBlessings: Record<string, { label: string; mods: StatMod[] }>;
  powerups: Record<string, { name: string; desc: string; secs: number }>;
  stats: Record<string, [string, string]>;
  dex: Dex;
  /** The game's move definition for a generic move id, for the League member of the current run (null: not in the game). */
  moveDef: (id: number) => MoveDef | null;
  /** The game's move plan (the League screen's "moves this Pokémon can get"). */
  movePlan: (species: number, member: unknown, types: string[], inLeague: (member: number) => boolean) => MovePlan;
  /** The game's upgrade roll: which stats an upgrade of this move improves, and by how much, at a rarity multiplier. Draws from Math.random. */
  upgradeRoll: (move: unknown, rarityMultiplier: number) => { key: string; value: number; label: string }[];
  /** The game's "apply an upgrade to a move" function (level + 1). Only ever called on detached move objects. */
  upgradeApply: (move: unknown, ups: { key: string; value: number }[]) => void;
  /** Where each one was found: `<chunk file>#<export name>`. */
  sources: Record<string, string>;
}

const TYPE_COUNT = 18;

const SHAPES: Record<string, (v: unknown) => boolean> = {
  vitamins: (v) => allObjs(v) && v.every((o) => typeof o.key === 'string' && typeof o.name === 'string' && typeof o.icon === 'string' && typeof o.stat === 'string' && typeof o.per === 'number' && typeof o.kind === 'string'),
  items: (v) => allObjs(v) && v.length > 50 && v.every((o) => typeof o.key === 'string' && typeof o.rarity === 'number' && typeof o.desc === 'string' && Array.isArray(o.mods) && !('passive' in o) && !('name' in o)),
  relics: (v) => allObjs(v) && v.every((o) => typeof o.key === 'string' && typeof o.rarity === 'number' && typeof o.name === 'string' && typeof o.passive === 'string' && typeof o.desc === 'string' && Array.isArray(o.mods)),
  typeBoostItems: (v) => isObj(v) && Object.keys(v).length === TYPE_COUNT && values(v).every((t) => typeof t === 'string' && /^[a-z]+$/.test(t)) && new Set(values(v)).size === TYPE_COUNT && values(v).includes('fire') && Object.keys(v).every((k) => !values(v).includes(k)),
  boosts: (v) => allObjs(v) && v.every((o) => typeof o.id === 'string' && typeof o.name === 'string' && typeof o.desc === 'string' && Object.keys(o).length === 3),
  boostPrices: (v) => allObjs(v) && v.every((o) => typeof o.id === 'string' && typeof o.price === 'number' && typeof o.daily === 'number' && Object.keys(o).length === 3),
  seals: (v) => strings(v) && v.includes('fury') && v.includes('clock'),
  overtimeOfferings: (v) => strings(v) && v.includes('dique') && v.includes('pleamar'),
  overtime: (v) => isObj(v) && typeof v.roundSecs === 'number' && typeof v.maxRounds === 'number' && Array.isArray(v.mult),
  tierTable: (v) => isObj(v) && ['hp', 'dmg', 'speed', 'amount', 'kills', 'level'].every((k) => Array.isArray(v[k])) && new Set(values(v).filter(Array.isArray).map((a) => (a as unknown[]).length)).size === 1,
  weather: (v) => isObj(v) && Object.keys(v).length > 1 && values(v).every((w) => isObj(w) && typeof w.name === 'string' && Array.isArray(w.boost) && Array.isArray(w.nerf)),
  rarityMultipliers: (v) => Array.isArray(v) && v.length === 5 && v.every((x) => typeof x === 'number') && v[0] === 1 && v.every((x, i) => i === 0 || x > v[i - 1]) && v[4] < 5,
  rarityNames: (v) => strings(v) && v.length === 5 && v[0].toLowerCase() === 'common',
  archetypes: (v) => isObj(v) && Object.keys(v).length > 10 && values(v).every((a) => isObj(a) && typeof a.dmg === 'number' && typeof a.cd === 'number' && typeof a.label === 'string' && typeof a.desc === 'string' && strings(a.stats)),
  passives: (v) => isObj(v) && Object.keys(v).length > 100 && values(v).every((a) => isObj(a) && typeof a.desc === 'string') && values(v).some((a) => isObj(a) && typeof a.name === 'string' && Array.isArray(a.mods)),
  formPassives: (v) => isObj(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => /^\d+$/.test(k)) && values(v).every((a) => isObj(a) && typeof a.desc === 'string' && Array.isArray(a.mods) && !('name' in a)),
  ultimates: (v) => isObj(v) && Object.keys(v).length > 100 && Object.keys(v).every((k) => /^\d+$/.test(k)) && values(v).every((a) => isObj(a) && strings(a.names) && strings(a.descs)),
  formUltimates: (v) => isObj(v) && Object.keys(v).length > 0 && Object.keys(v).length <= 100 && Object.keys(v).every((k) => /^\d+$/.test(k)) && values(v).every((a) => isObj(a) && strings(a.names) && strings(a.descs)),
  fusions: (v) => allObjs(v) && v.length > 20 && v.every((o) => typeof o.key === 'string' && typeof o.kind === 'string' && typeof o.name === 'string' && typeof o.desc === 'string' && typeof o.cast === 'function'),
  fusionDefs: (v) => v instanceof Map && v.size > 0 && [...v.values()].every((d) => isObj(d) && typeof d.key === 'string' && typeof d.arch === 'string' && isObj(d.fusion)),
  statuses: (v) => isObj(v) && typeof v.burn === 'string' && typeof v.poison === 'string' && typeof v.paralysis === 'string' && values(v).every((x) => typeof x === 'string'),
  typeStatus: (v) => isObj(v) && Object.keys(v).length === TYPE_COUNT && 'fire' in v && 'normal' in v && values(v).every((x) => x === null || typeof x === 'string') && values(v).some((x) => x === null),
  enemyFlags: (v) => isObj(v) && typeof v.Elite === 'number' && typeof v.Alpha === 'number' && typeof v.Boss === 'number' && typeof v.Ranged === 'number',
  projectileFlags: (v) => isObj(v) && typeof v.Hostile === 'number' && typeof v.Homing === 'number',
  typeBlessings: (v) => isObj(v) && Object.keys(v).length === TYPE_COUNT && 'fire' in v && values(v).every((b) => isObj(b) && typeof b.label === 'string' && Array.isArray(b.mods)),
  powerups: (v) => isObj(v) && Object.keys(v).length > 0 && values(v).every((b) => isObj(b) && typeof b.name === 'string' && typeof b.desc === 'string' && typeof b.secs === 'number' && typeof b.col === 'number'),
  stats: (v) => isObj(v) && Object.keys(v).length > 20 && 'maxHp' in v && values(v).every((s) => Array.isArray(s) && s.length === 2 && s.every((x) => typeof x === 'string')),
  dex: (v) => isObj(v) && Array.isArray(v.pokemon) && v.byId instanceof Map && v.moves instanceof Map && v.movesByKey instanceof Map && 'learnsets' in v && 'typeIndex' in v,
};

const FUNCTIONS: Record<string, RegExp[]> = {
  // function X(e){return Y(e,Z)}: the definition of move id e for the League member of the current run.
  moveDef: [/^function [\w$]+\(e\)\{return [\w$]+\(e,[\w$]+\)\}$/],
  movePlan: [/passive===`mew`/, /shared:\[\.\.\.[\w$]+\.values\(\)\]/, /roster:[\w$]+\}/],
  upgradeRoll: [/\.stats\.slice\(\)/, />=1\.6\?3:2/, /Math\.random\(\)/],
  upgradeApply: [/\.level\+\+,[\w$]+\.mods\.dmg\+=/],
};

/** Keys whose table several chunks may carry as separate, identical copies: all copies must be deep-equal. */
const MAY_REPEAT = new Set(['rarityNames']);

export async function readKnowledgeRegistries(loaded: string[]): Promise<KnowledgeRegistries> {
  const hits: Record<string, { value: unknown; where: string }[]> = {};
  const add = (key: string, value: unknown, where: string) => { if (!(hits[key] ??= []).some((h) => h.value === value)) hits[key].push({ value, where }); };
  for (const path of loaded) {
    // Same URL the game imported: the module is already evaluated, this only hands back its namespace object.
    const mod = (await import(`${ORIGIN}${path}`)) as Obj;
    const file = path.split('/').pop();
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value === 'function') {
        const src = Function.prototype.toString.call(value);
        for (const [key, tests] of Object.entries(FUNCTIONS)) if (tests.every((re) => re.test(src))) add(key, value, `${file}#${name}`);
        continue;
      }
      for (const [key, test] of Object.entries(SHAPES)) {
        let ok = false;
        try { ok = test(value); } catch { ok = false; }
        if (ok) add(key, value, `${file}#${name}`);
      }
    }
  }
  const sources: Record<string, string> = {};
  const one = <T>(key: string): T => {
    let h = hits[key] ?? [];
    if (MAY_REPEAT.has(key) && h.length > 1 && h.every((x) => JSON.stringify(x.value) === JSON.stringify(h[0].value))) h = [h[0]];
    if (h.length !== 1) throw new Error(`[knowledge] game table "${key}": expected exactly one matching export in the bundle, found ${h.length}${h.length ? ` (${h.map((x) => x.where).join(', ')})` : ''}. The game build has changed; re-validate src/knowledge/registries.ts.`);
    sources[key] = h[0].where;
    return h[0].value as T;
  };
  const out = {} as Record<string, unknown>;
  for (const key of Object.keys(SHAPES)) out[key] = one(key);
  // The move-definition lookup is a one-line wrapper; other chunks have wrappers of the same form. The one meant is the
  // one exported by the chunk that also exports the reference data it reads.
  const dexChunk = sources.dex.split('#')[0];
  hits.moveDef = (hits.moveDef ?? []).filter((h) => h.where.split('#')[0] === dexChunk);
  for (const key of Object.keys(FUNCTIONS)) out[key] = one(key);
  out.sources = sources;
  return out as unknown as KnowledgeRegistries;
}

/**
 * Names of minified members of the game's player object that the export reads, found by what their source does.
 * `proto` is the prototype of the live player object.
 */
export function playerLimits(proto: object): { maxMoveLevel: string; maxVitaminLevel: string } {
  const find = (what: string, re: RegExp): string => {
    const found: string[] = [];
    for (const name of Object.getOwnPropertyNames(proto)) {
      const d = Object.getOwnPropertyDescriptor(proto, name);
      if (d?.get && re.test(Function.prototype.toString.call(d.get))) found.push(name);
    }
    if (found.length !== 1) throw new Error(`[knowledge] could not identify the player's "${what}" getter: ${found.length} candidates. The game build has changed; re-validate src/knowledge/registries.ts.`);
    return found[0];
  };
  return {
    maxMoveLevel: find('highest move level', /\{return \d+\+\(this\.items\.has\(`tm-case`\)\?\d+:0\)\}/),
    maxVitaminLevel: find('highest vitamin level', /\{return \d+\+\(this\.items\.has\(`max-ether`\)\?\d+:0\)\}/),
  };
}

/**
 * Every interactable kind the game's own map-point class names in its source (`kind === "…"` comparisons and `case`
 * labels). The game keeps no table of kinds; this list is the set its code distinguishes.
 */
export function interactableKinds(interactables: object): string[] {
  const kinds = new Set<string>();
  const proto = Object.getPrototypeOf(interactables) as Record<string, unknown>;
  // `label` (the prompt shown next to a point) and `interactNow` (what the interact key does) switch over the kind.
  for (const name of ['label', 'interactNow']) if (typeof proto[name] !== 'function') throw new Error(`[knowledge] the game's map-point class has no method "${name}": the game build has changed; re-validate src/knowledge/registries.ts.`);
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue; // its source is the whole class
    const d = Object.getOwnPropertyDescriptor(proto, name);
    const f = d?.value ?? d?.get;
    if (typeof f !== 'function') continue;
    const src = Function.prototype.toString.call(f);
    for (const m of src.matchAll(/\.kind===`([\w-]+)`/g)) kinds.add(m[1]);
    for (const m of src.matchAll(/this\.add\(`([\w-]+)`,/g)) kinds.add(m[1]);
    if (name === 'label' || name === 'interactNow') for (const m of src.matchAll(/case`([\w-]+)`:/g)) kinds.add(m[1]);
  }
  if (kinds.size < 10) throw new Error(`[knowledge] only ${kinds.size} interactable kinds found in the game's map-point class: the game build has changed; re-validate src/knowledge/registries.ts.`);
  return [...kinds].sort();
}
