import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HeadlessGameEnvironment } from '../environment/GameEnvironment.ts';
import { playableMaps } from '../environment/profile.ts';
import type { LeagueMember, Registries } from '../environment/profile.ts';
import { interactableKinds, playerLimits, readKnowledgeRegistries } from './registries.ts';
import type { DexSpecies, KnowledgeRegistries, MoveDef, MovePlan } from './registries.ts';
import { DECISION_KINDS, EXTRA_ACTIONS, OFFER_KINDS, VOCAB_VERSION, makeTable } from './vocab.ts';
import type { VocabTable } from './vocab.ts';

/**
 * Game-knowledge export: the running game's own tables written as versioned JSON (docs/game-knowledge.md).
 *
 * Nothing in the datasets is typed by hand. Every value is read from a table of the loaded bundle
 * (src/knowledge/registries.ts), from the game's own lookup functions, or from the player object of a run the game
 * started for that League member. Where the game has no data for something (its logic is code), the dataset says so
 * in `gaps`.
 */
export const KNOWLEDGE_VERSION = 1;

export interface KnowledgeHeader {
  dataset: string;
  /** Game build the data was read from, and the version its release list gives it. */
  build: string;
  gameVersion: string | null;
  /** Version of the export format (KNOWLEDGE_VERSION, or VOCAB_VERSION for the vocabulary). */
  version: number;
  /** sha256 over the bytes of every chunk the game had loaded, in load order (same value as getMetadata().game.bundleSha256). */
  bundleSha256: string;
  /** Language of the names and descriptions (the game localises its tables when it loads). */
  language: string;
  /** Account preset the per-species run values were read under. */
  profile: string;
  /** How each field was obtained. */
  source: Record<string, string>;
  /** What the dataset does not contain because the game has no data for it. */
  gaps: string[];
}

export interface Knowledge {
  species: { header: KnowledgeHeader; species: SpeciesEntry[]; /** Every species of the reference data (enemies, evolved forms): number, key, name, types, family. */ pokedex: { id: number; key: string; name: string; types: string[]; family: number; legendary: boolean }[] };
  moves: { header: KnowledgeHeader; levelUp: Record<string, unknown>; archetypes: Record<string, unknown>; moves: MoveEntry[]; fusions: Record<string, unknown>[] };
  items: { header: KnowledgeHeader; [section: string]: unknown };
  vocab: { header: KnowledgeHeader; tables: Record<string, VocabTable> };
}

export interface SpeciesEntry {
  id: number; key: string; name: string; types: string[]; role: string; rank: string; starter: boolean;
  passive: { id: string; name: string | null; desc: string | null; mods: unknown[]; hooks: string[] };
  kit: { slot: number; move: string; unlockLevel: number }[];
  startingMoves: { move: string; level: number }[];
  /** Moves the level-up offers can contain, per form of the evolution line (keyed by species number). */
  moves: Record<string, { line: { move: string; level: number }[]; shared: { move: string; level: number; from: number[] }[]; any: string[] | null }>;
  evolution: { family: number; line: number[]; nextAtStart: { to: number; level: number } | null; evoLevels: unknown; altForms: { form: number; from: number; at: string }[] };
  reference: { stats: Record<string, number>; bst: number; legendary: boolean; mythical: boolean; baby: boolean };
  run: { maxHp: number; moveSlots: number; vitaminSlots: number; refreshes: number; skips: number; banishes: number; stats: Record<string, number> };
  ultimate: { names: string[]; descs: string[]; type: string | null; class: string | null; durations: number[] } | null;
  signatureFusion: string | null;
}

export interface MoveEntry {
  key: string; id: number; name: string; type: string; class: string; archetype: string;
  damage: number; cooldown: number; count: number; area: number; speed: number; duration: number; pierce: number;
  status: string | null; statusChance: number; drain: number; critBonus: number; flinch: number; power: number | null;
  extra: Record<string, unknown>; desc: string;
  upgradeStats: string[];
  /** League members with the move in their kit / in their level-up line (any form) / able to borrow it from another kit. */
  kitOf: number[]; lineOf: number[]; sharedTo: number[];
  /** The same move as the game defines it for a League member it treats specially (usually the kit's owner). */
  memberVariants: Record<string, unknown>[];
  fusions: string[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const sortNums = (a: Iterable<number>): number[] => [...new Set(a)].sort((x, y) => x - y);
const byKey = <T extends { key: string }>(a: T[]): T[] => [...a].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));

/** Plain JSON copy of a game table entry: functions become the name of the hook they implement and are listed apart. */
function dataOf(v: unknown, depth = 4): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'function' || depth <= 0) return undefined;
  if (Array.isArray(v)) return v.map((x) => dataOf(x, depth - 1)).filter((x) => x !== undefined);
  if (v instanceof Map) return Object.fromEntries([...v.entries()].map(([k, x]) => [String(k), dataOf(x, depth - 1)]));
  if (v instanceof Set) return [...v].map((x) => dataOf(x, depth - 1));
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as object)) { const x = dataOf((v as Record<string, unknown>)[k], depth - 1); if (x !== undefined) out[k] = x; }
  return out;
}
const hooksOf = (v: object): string[] => Object.keys(v).filter((k) => typeof (v as Record<string, unknown>)[k] === 'function').sort();

function moveNumbers(d: MoveDef): Omit<MoveEntry, 'kitOf' | 'lineOf' | 'sharedTo' | 'memberVariants' | 'fusions' | 'upgradeStats'> {
  const known = new Set(['id', 'key', 'name', 'type', 'cls', 'arch', 'dmg', 'cd', 'count', 'area', 'speed', 'dur', 'pierce', 'status', 'statusChance', 'drain', 'critBonus', 'flinch', 'power', 'desc', 'fusion']);
  const extra: Record<string, unknown> = {};
  for (const k of Object.keys(d).sort()) if (!known.has(k)) { const x = dataOf(d[k]); if (x !== undefined) extra[k] = x; }
  return {
    key: d.key, id: d.id, name: d.name, type: d.type, class: d.cls, archetype: d.arch,
    damage: d.dmg, cooldown: d.cd, count: d.count, area: d.area, speed: d.speed, duration: d.dur, pierce: d.pierce,
    status: d.status ?? null, statusChance: d.statusChance, drain: d.drain, critBonus: d.critBonus, flinch: d.flinch, power: num(d.power),
    extra, desc: d.desc,
  };
}

export interface BuildOptions {
  /** Only these League members (for quick checks). The result is then not a complete export and must not be written to data/. */
  only?: number[];
  log?: (line: string) => void;
}

/** Read everything from the running game. Starts one run per League member through the environment's own reset. */
export async function buildKnowledge(env: HeadlessGameEnvironment, options: BuildOptions = {}): Promise<Knowledge> {
  const log = options.log ?? (() => {});
  const members0 = options.only;
  await env.reset({ seed: 1 });
  const sim = env.debug.sim!, reg = env.debug.registries as Registries;
  const K: KnowledgeRegistries = await readKnowledgeRegistries(sim.loader.loaded);
  const md = env.getMetadata();
  const dex = K.dex, meta = sim.app.meta;
  const league: LeagueMember[] = [...reg.league].sort((a, b) => a.id - b.id).filter((m) => !members0 || members0.includes(m.id));
  const inLeague = (id: number): boolean => meta.inLeague(id) === true;
  const moveKey = (id: number): string => { const m = dex.moves.get(id); if (!m) throw new Error(`[knowledge] move id ${id} is not in the game's reference data`); return m.key; };
  const moveId = (key: string): number => { const m = dex.movesByKey.get(key); if (!m) throw new Error(`[knowledge] move "${key}" is not in the game's reference data`); return m.id; };
  const language = /\/assets\/([a-z]{2,3})-[^/]+\.js$/.exec(sim.loader.loaded.find((p) => /\/assets\/(en|es|de|fr|it|ja|ko|pt|ru|zh|zht)-[A-Za-z0-9_]{6,}-/.test(p)) ?? '')?.[1] ?? 'es';

  // ---- one run per League member: the game's own player object is the source of the per-species values ----
  const species: SpeciesEntry[] = [];
  /** move id → definition object → the members whose run returned that object. */
  const defsSeen = new Map<number, Map<MoveDef, number[]>>();
  const kitOf = new Map<number, number[]>(), lineOf = new Map<number, number[]>(), sharedTo = new Map<number, number[]>();
  const push = (m: Map<number, number[]>, k: number, v: number) => { const a = m.get(k); if (a) { if (!a.includes(v)) a.push(v); } else m.set(k, [v]); };
  let MoveClass: (new (def: MoveDef) => { def: MoveDef; level: number; mods: Record<string, number> }) | null = null;
  let limits: { maxMoveLevel: number; maxVitaminLevel: number } | null = null;
  let kinds: string[] = [];
  const signature = new Map<number, string>();
  for (const f of K.fusions) if (f.kind === 'signature' && typeof f.member === 'number') signature.set(f.member, f.key);

  for (const m of league) {
    await env.reset({ seed: 1, species: m.id, map: reg.season.biomes[0], tier: 0 });
    const run = sim.run, p = run.player;
    if (p.speciesId !== m.id || p.roster?.id !== m.id) throw new Error(`[knowledge] the run for League member ${m.id} has player species ${p.speciesId} / roster ${p.roster?.id}`);
    const d: DexSpecies = dex.get(m.id);
    if (!MoveClass) {
      const held = p.moves.find((x: unknown) => !!x);
      if (!held) throw new Error('[knowledge] the player starts without a move: cannot find the game\'s move class');
      MoveClass = held.constructor;
      const names = playerLimits(Object.getPrototypeOf(p));
      limits = { maxMoveLevel: p[names.maxMoveLevel], maxVitaminLevel: p[names.maxVitaminLevel] };
      kinds = interactableKinds(run.interactables);
    }
    // Every move definition, as the game gives it in this member's run.
    for (const id of dex.moves.keys()) {
      const def = K.moveDef(id);
      if (!def) continue;
      let per = defsSeen.get(id);
      if (!per) defsSeen.set(id, per = new Map());
      const list = per.get(def);
      if (list) list.push(m.id); else per.set(def, [m.id]);
    }
    // The evolution line, and the move plan of every form in it.
    const line: number[] = [];
    const walk = (id: number, depth: number) => {
      if (line.includes(id) || !dex.byId.has(id)) return;
      line.push(id);
      if (depth < 4) for (const e of [...dex.evolutionsOf(id), ...(dex.johtoEvolutions.get(id) ?? [])]) walk(e.id, depth + 1);
    };
    walk(m.id, 0);
    const plans: SpeciesEntry['moves'] = {};
    let kit: SpeciesEntry['kit'] = [];
    for (const form of line) {
      const plan: MovePlan = K.movePlan(form, p.roster, dex.get(form).types, inLeague);
      if (form === m.id) kit = plan.kit.map((k, slot) => ({ slot, move: moveKey(k.id), unlockLevel: k.level }));
      plans[String(form)] = {
        line: plan.line.map((x) => ({ move: moveKey(x.id), level: x.level })),
        shared: plan.shared.map((x) => ({ move: moveKey(x.id), level: x.level, from: sortNums(x.from) })),
        any: plan.any ? plan.any.map((x) => moveKey(x.id)).sort() : null,
      };
      for (const x of plan.line) push(lineOf, x.id, m.id);
      for (const x of plan.shared) push(sharedTo, x.id, m.id);
      for (const x of plan.any ?? []) push(lineOf, x.id, m.id);
    }
    if (kit.length !== m.kit.length || kit.some((k, i) => k.move !== m.kit[i])) throw new Error(`[knowledge] League member ${m.id}: the game's move plan gives the kit ${kit.map((k) => k.move).join(', ')}, the League table ${m.kit.join(', ')}`);
    for (const k of m.kit) push(kitOf, moveId(k), m.id);
    const passive = K.passives[m.passive];
    const ult = K.ultimates[String(m.id)];
    const stats: Record<string, number> = {};
    for (const k of Object.keys(p.stats).sort()) if (typeof p.stats[k] === 'number') stats[k] = p.stats[k];
    species.push({
      id: m.id, key: d.key, name: d.name, types: [...d.types], role: m.role, rank: m.rank, starter: !!m.start,
      passive: { id: m.passive, name: passive?.name ?? null, desc: passive?.desc ?? null, mods: (dataOf(passive?.mods ?? []) as unknown[]) ?? [], hooks: passive ? hooksOf(passive) : [] },
      kit,
      startingMoves: p.moves.filter((x: unknown) => !!x).map((x: { def: MoveDef; level: number }) => ({ move: x.def.key, level: x.level })),
      moves: plans,
      evolution: {
        family: d.family, line,
        nextAtStart: run.nextEvo && typeof run.nextEvo.to === 'number' ? { to: run.nextEvo.to, level: run.nextEvo.level } : null,
        evoLevels: dataOf((m as unknown as Record<string, unknown>).evoLevels ?? (m as unknown as Record<string, unknown>).evoLevel ?? null),
        altForms: reg.forms.filter((f) => f.member === m.id).map((f) => ({ form: f.form, from: f.from, at: f.at })),
      },
      reference: { stats: { ...d.stats }, bst: d.bst, legendary: !!d.legendary, mythical: !!d.mythical, baby: !!d.baby },
      run: { maxHp: p.maxHp, moveSlots: p.moveSlots, vitaminSlots: p.vitaminSlots, refreshes: run.rerolls, skips: run.skips, banishes: run.banishes, stats },
      ultimate: ult ? { names: [...ult.names], descs: [...ult.descs], type: ult.type ?? null, class: ult.cls ?? null, durations: [...(ult.dur ?? [])] } : null,
      signatureFusion: signature.get(m.id) ?? null,
    });
    log(`species ${m.id} ${d.name}: kit ${kit.map((k) => k.move).join(', ')}; forms ${line.join(' → ')}; line ${plans[String(m.id)].line.length}, shared ${plans[String(m.id)].shared.length}; max HP ${p.maxHp}`);
  }
  if (!MoveClass || !limits) throw new Error('[knowledge] no League member was read');
  const Move = MoveClass;

  // ---- moves ----
  const fusionsOf = new Map<string, string[]>();
  for (const f of K.fusions) for (const k of f.moves ?? []) fusionsOf.set(k, [...(fusionsOf.get(k) ?? []), f.key]);
  const moves: MoveEntry[] = [];
  for (const [id, per] of defsSeen) {
    // The definition most members get is the general one; a member that gets another object has its own variant.
    const ranked = [...per.entries()].sort((a, b) => b[1].length - a[1].length || a[1][0] - b[1][0]);
    const [general, ...others] = ranked;
    const base = moveNumbers(general[0]);
    const arch = K.archetypes[general[0].arch];
    if (!arch) throw new Error(`[knowledge] move "${general[0].key}" has the archetype "${general[0].arch}", which the archetype table does not have`);
    const variants: Record<string, unknown>[] = [];
    for (const [def, who] of others) {
      const v = moveNumbers(def) as unknown as Record<string, unknown>;
      const diff: Record<string, unknown> = {};
      for (const k of Object.keys(v)) if (JSON.stringify(v[k]) !== JSON.stringify((base as unknown as Record<string, unknown>)[k])) diff[k] = v[k];
      for (const member of who) variants.push({ member, ...diff });
    }
    moves.push({
      ...base, upgradeStats: [...arch.stats],
      kitOf: sortNums(kitOf.get(id) ?? []), lineOf: sortNums(lineOf.get(id) ?? []), sharedTo: sortNums(sharedTo.get(id) ?? []),
      memberVariants: variants.sort((a, b) => (a.member as number) - (b.member as number)),
      fusions: [...(fusionsOf.get(general[0].key) ?? [])].sort(),
    });
  }
  moves.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // Upgrade values: the game's own roll function, called on detached move objects until every stat of the archetype
  // has come up at every rarity. (It draws from Math.random; the values themselves do not depend on the draw.)
  const firstOfArch = new Map<string, MoveDef>();
  for (const [, per] of [...defsSeen].sort((a, b) => a[0] - b[0])) for (const def of per.keys()) if (!firstOfArch.has(def.arch)) firstOfArch.set(def.arch, def);
  const archetypes: Record<string, unknown> = {};
  const upgradesPerRoll: number[] = [];
  for (const key of Object.keys(K.archetypes).sort()) {
    const a = K.archetypes[key];
    const def = firstOfArch.get(key);
    const upgrades: Record<string, { values: number[]; labels: string[] }> = {};
    if (def) {
      K.rarityMultipliers.forEach((mult, rarity) => {
        const seen = new Map<string, { value: number; label: string }>();
        for (let i = 0; i < 2000 && seen.size < a.stats.length; i++) {
          const ups = K.upgradeRoll(new Move(def), mult);
          upgradesPerRoll[rarity] = upgradesPerRoll[rarity] === undefined ? ups.length : Math.max(upgradesPerRoll[rarity], ups.length);
          for (const u of ups) {
            const old = seen.get(u.key);
            if (old && old.value !== u.value) throw new Error(`[knowledge] upgrade of "${u.key}" on archetype "${key}" at rarity ${rarity} gave two values (${old.value}, ${u.value}): the upgrade rules have changed`);
            seen.set(u.key, { value: u.value, label: String(u.label) });
          }
        }
        if (seen.size < a.stats.length) throw new Error(`[knowledge] archetype "${key}": not every upgrade stat came up at rarity ${rarity} (${[...seen.keys()].join(', ')} of ${a.stats.join(', ')})`);
        for (const s of a.stats) { const u = seen.get(s)!; (upgrades[s] ??= { values: [], labels: [] }).values[rarity] = u.value; upgrades[s].labels[rarity] = u.label; }
      });
    }
    archetypes[key] = {
      label: a.label, desc: a.desc, damage: a.dmg, cooldown: a.cd, count: a.count, area: a.area, speed: a.speed, duration: a.dur, pierce: a.pierce,
      upgradeStats: [...a.stats], upgrades: def ? upgrades : null, usedByMoves: def ? moves.filter((mv) => mv.archetype === key).length : 0,
    };
  }
  const probe = new Move(firstOfArch.values().next().value as MoveDef);
  const before = { level: probe.level, dmg: probe.mods.dmg };
  K.upgradeApply(probe, []);
  const levelUp = {
    rarityNames: [...K.rarityNames], rarityMultipliers: [...K.rarityMultipliers], upgradesPerOffer: upgradesPerRoll,
    damageModPerLevel: Math.round((probe.mods.dmg - before.dmg) * 1e9) / 1e9, levelsPerUpgrade: probe.level - before.level,
    startLevel: before.level, maxMoveLevel: limits.maxMoveLevel, maxVitaminLevel: limits.maxVitaminLevel,
  };
  const fusionByKey = new Map([...K.fusionDefs.values()].map((d) => [d.key, d]));
  const fusions = byKey(K.fusions.map((f) => {
    const def = fusionByKey.get(f.key);
    return {
      key: f.key, id: def?.id ?? null, kind: f.kind, name: f.name, desc: f.desc, member: f.member ?? null, ingredients: f.moves ? [...f.moves] : null, pairTypes: f.pair ? dataOf(f.pair) : null,
      type: f.type ?? null, type2: f.type2 ?? null, class: f.cls ?? null, cooldown: num(f.cd), power: num(f.power), hits: num(f.hits), range: num(f.range), status: f.status ?? null, repeats: !!f.repeats,
      definition: def ? { damage: def.dmg, cooldown: def.cd, count: def.count, area: def.area, speed: def.speed, duration: def.dur, pierce: def.pierce, status: def.status ?? null, statusChance: def.statusChance, power: num(def.power) } : null,
    };
  }));

  // ---- items ----
  const shopPrice = new Map(reg.shopItems.map((i) => [i.key, i.price]));
  const items = {
    vitamins: byKey(K.vitamins.map((v) => ({ key: v.key, name: v.name, stat: v.stat, perLevel: v.per, kind: v.kind, desc: v.desc, note: v.note ?? null, extra: dataOf(v.extra ?? []), dice: !!v.dice, maxLevel: limits!.maxVitaminLevel }))),
    heldItems: byKey(K.items.map((i) => ({
      key: i.key, name: dex.items[i.key]?.name ?? null, rarity: i.rarity, rarityName: K.rarityNames[i.rarity] ?? null, desc: i.desc, mods: dataOf(i.mods), tags: [...(i.tags ?? [])],
      maxStack: i.max ?? null, typeBoost: K.typeBoostItems[i.key] ?? null, unlockPriceStardust: shopPrice.get(i.key) ?? null,
    }))),
    relics: byKey(K.relics.map((r) => ({ key: r.key, name: r.name, rarity: r.rarity, rarityName: K.rarityNames[r.rarity] ?? null, mods: dataOf(r.mods), passive: r.passive, desc: r.desc, values: dataOf(r.v ?? {}) }))),
    runBoosts: [...K.boosts].sort((a, b) => (a.id < b.id ? -1 : 1)).map((b) => { const price = K.boostPrices.find((x) => x.id === b.id); return { key: b.id, name: b.name, desc: b.desc, priceStardust: price?.price ?? null, perDay: price?.daily ?? null }; }),
    seals: [...K.seals].sort().map((key) => ({ key })),
    overtimeOfferings: [...K.overtimeOfferings].sort().map((key) => ({ key })),
    overtime: dataOf(K.overtime),
    typeBlessings: Object.keys(K.typeBlessings).sort().map((type) => ({ type, label: K.typeBlessings[type].label, mods: dataOf(K.typeBlessings[type].mods) })),
    powerups: Object.keys(K.powerups).sort().map((key) => ({ key, name: K.powerups[key].name, desc: K.powerups[key].desc, seconds: K.powerups[key].secs })),
    lab: [...reg.lab].sort((a, b) => (a.id < b.id ? -1 : 1)).map((u) => { const x = u as unknown as Record<string, unknown>; return { key: u.id, name: x.name ?? null, desc: x.desc ?? null, max: u.max, stat: x.stat ?? null, perLevel: x.per ?? null }; }),
    friendship: { maxLevel: reg.friendLevel(reg.friendMaxPoints).lv, pointsForMaxLevel: reg.friendMaxPoints, perks: [...reg.friendPerks].sort((a, b) => a.lv - b.lv).map((x) => ({ level: x.lv, key: x.id, name: x.name, desc: x.desc, stat: x.stat ?? null, add: x.add ?? null, uses: x.uses ?? null, ultimateCharge: x.ult ?? null })) },
    shinyPerks: [...reg.shinyPerks].sort((a, b) => a.n - b.n).map((x) => ({ shinies: x.n, name: x.name, desc: x.desc, stat: x.stat ?? null, add: x.add ?? null, charm: !!x.charm, bond: x.bond ?? null })),
    stats: Object.keys(K.stats).sort().map((key) => ({ key, label: K.stats[key][0], kind: K.stats[key][1] })),
    statuses: Object.keys(K.statuses).sort().map((key) => ({ key, label: K.statuses[key] })),
    typeStatus: Object.fromEntries(Object.keys(K.typeStatus).sort().map((t) => [t, K.typeStatus[t]])),
    weather: Object.keys(K.weather).sort().map((key) => ({ key, name: K.weather[key].name, boost: [...K.weather[key].boost], nerf: [...K.weather[key].nerf] })),
    types: { order: [...dex.types.types], chart: dataOf(dex.types.chart) },
    difficultyTiers: dataOf(K.tierTable),
    maps: reg.maps.map((mp) => { const x = mp as unknown as Record<string, unknown>; return { key: mp.id, name: mp.name, playable: playableMaps(reg).some((q) => q.id === mp.id), types: dataOf(x.types ?? []), lateTypes: dataOf(x.late ?? []), weather: dataOf(x.weather ?? []), guardians: dataOf(x.guardians ?? x.bosses ?? []), legendaries: dataOf(x.legendaries ?? []), hasSanctuary: !!x.sanctuary }; }).sort((a, b) => (a.key < b.key ? -1 : 1)),
  };

  // ---- vocabulary ----
  const flagNames = (t: Record<string, number | string>): string[] => Object.keys(t).filter((k) => typeof t[k] === 'number' && Number.isInteger(Math.log2(t[k] as number)));
  const entity: string[] = [
    ...moves.map((mv) => `move:${mv.key}`), ...fusions.map((f) => `move:${f.key}`), ...items.vitamins.map((v) => `vitamin:${v.key}`), ...items.heldItems.map((i) => `item:${i.key}`),
    ...items.relics.map((r) => `relic:${r.key}`), ...items.seals.map((s) => `seal:${s.key}`), ...items.overtimeOfferings.map((o) => `offering:${o.key}`),
    ...dex.pokemon.map((s) => `species:${s.id}`), ...Object.keys(K.stats).map((s) => `stat:${s}`),
  ];
  const tables: Record<string, VocabTable> = {
    species: makeTable(dex.pokemon.map((s) => s.id)),
    type: makeTable(dex.types.types),
    role: makeTable(new Set(reg.league.map((m) => m.role))),
    rank: makeTable(new Set(reg.league.map((m) => m.rank))),
    passive: makeTable(Object.keys(K.passives)),
    move: makeTable([...moves.map((mv) => mv.key), ...fusions.map((f) => f.key)]),
    archetype: makeTable(new Set([...Object.keys(K.archetypes), ...[...K.fusionDefs.values()].map((d) => d.arch)])),
    moveClass: makeTable(new Set(moves.map((mv) => mv.class))),
    status: makeTable(Object.keys(K.statuses)),
    stat: makeTable(Object.keys(K.stats)),
    vitamin: makeTable(items.vitamins.map((v) => v.key)),
    item: makeTable(items.heldItems.map((i) => i.key)),
    relic: makeTable(items.relics.map((r) => r.key)),
    runBoost: makeTable(items.runBoosts.map((b) => b.key)),
    seal: makeTable(K.seals),
    overtimeOffering: makeTable(K.overtimeOfferings),
    offerKind: makeTable(OFFER_KINDS),
    decisionKind: makeTable(DECISION_KINDS),
    extraAction: makeTable(EXTRA_ACTIONS),
    enemyFlag: Object.fromEntries(flagNames(K.enemyFlags).sort((a, b) => (K.enemyFlags[a] as number) - (K.enemyFlags[b] as number)).map((name) => [name, Math.log2(K.enemyFlags[name] as number) + 1])),
    projectileFlag: Object.fromEntries(flagNames(K.projectileFlags).sort((a, b) => (K.projectileFlags[a] as number) - (K.projectileFlags[b] as number)).map((name) => [name, Math.log2(K.projectileFlags[name] as number) + 1])),
    map: makeTable(reg.maps.map((mp) => mp.id)),
    weather: makeTable(Object.keys(K.weather)),
    interactable: makeTable(kinds),
    rarity: Object.fromEntries(K.rarityNames.map((name, i) => [name, i + 1])),
    entity: makeTable(entity),
  };

  const header = (dataset: string, version: number, source: Record<string, string>, gaps: string[]): KnowledgeHeader => ({
    dataset, build: md.game.build, gameVersion: md.game.version, version, bundleSha256: md.game.bundleSha256, language, profile: md.profile.preset, source, gaps,
  });
  const src = (...keys: string[]): string => keys.map((k) => `${k} = ${K.sources[k] ?? reg.sources[k] ?? '?'}`).join('; ');
  return {
    species: {
      header: header('species', KNOWLEDGE_VERSION, {
        'id, role, rank, starter, passive.id, kit[].move, evolution.evoLevels': `the League table (${src('league')})`,
        'key, name, types, reference.*, evolution.family, pokedex[]': `the bundle's reference data (${src('dex')}), loaded by the game from mirror/data/*.json`,
        'passive.name, passive.desc, passive.mods, passive.hooks': `the passive table (${src('passives')}); hooks are the names of the functions an entry carries (their logic is code)`,
        'kit[].unlockLevel, moves.*': `the game's own move-plan function (${src('movePlan')}), called for every form of the evolution line while a run of that League member is loaded; evolution.line is walked with the reference data's evolutionsOf() and its Johto branch table`,
        'startingMoves, run.*, evolution.nextAtStart': `the game's player and run objects immediately after app.startRun() for that member (seed 1, first map of the season, tier 0), under the account preset named in "profile"`,
        'ultimate': `the ultimate table (${src('ultimates')})`,
        'signatureFusion': `the fusion table (${src('fusions')})`,
        'evolution.altForms': `the alternative-form table (${src('forms')})`,
      }, [
        'passive effects beyond passive.mods are code (the hooks listed per passive: tick, dmgTaken, …); only their text description is data',
        'ultimates: names, descriptions, type, class and durations only; damage and shapes are code',
        'run.* depend on the account preset (Lab, friendship) and on the weather the seed gave at second 0; they are not base values of the species',
        'evolution rules during a run (level thresholds per form, branch choices, stones) are decided by code at the time; only the first step (nextAtStart) and the League table\'s own evoLevels field are given',
        'the alternative forms\' passives and ultimates are not joined here (they are in the bundle as tables keyed by form species)',
      ]),
      species,
      pokedex: [...dex.pokemon].sort((a, b) => a.id - b.id).map((s) => ({ id: s.id, key: s.key, name: s.name, types: [...s.types], family: s.family, legendary: !!(s.legendary || s.mythical) })),
    },
    moves: {
      header: header('moves', KNOWLEDGE_VERSION, {
        'moves[]: every number, type, class, archetype, status, desc': `the game's move-definition function (${src('moveDef')}), asked for every id of the reference move list in the run of every League member; the definition most members receive is the entry, the others are memberVariants`,
        'moves[].upgradeStats, archetypes.*': `the archetype table (${src('archetypes')})`,
        'archetypes.*.upgrades': `the game's upgrade-roll function (${src('upgradeRoll')}) called on detached move objects for each rarity multiplier (${src('rarityMultipliers')}) until every stat came up; values[r] is the amount at rarity r, labels[r] the game's own text`,
        'levelUp.damageModPerLevel, levelsPerUpgrade': `the game's upgrade-apply function (${src('upgradeApply')}) called once on a detached move object with no stat upgrades`,
        'levelUp.maxMoveLevel, maxVitaminLevel': 'getters of the live player object, read without the items that raise them',
        'moves[].kitOf / lineOf / sharedTo': 'inverted from the per-species move plans of species.json',
        'fusions[]': `the fusion table (${src('fusions')}) joined with the fusion move definitions (${src('fusionDefs')})`,
      }, [
        'how a move behaves beyond its archetype numbers (projectile pattern details, special cases per move) is code',
        'effective values in a run also depend on player stats, level mods, items and passives; the formulas are code',
        'fusion upgrade options and the highest fusion level are code, not data',
        'the range a move targets at is not a field of the definition (the game computes it per archetype in code)',
        `moves of the reference list the game has no definition for are left out (${[...dex.moves.keys()].length - moves.length} of ${[...dex.moves.keys()].length})`,
      ]),
      levelUp, archetypes, moves, fusions,
    },
    items: {
      header: header('items', KNOWLEDGE_VERSION, {
        vitamins: `the vitamin table (${src('vitamins')})`,
        heldItems: `the held-item table (${src('items')}); name from the reference item list; typeBoost from ${src('typeBoostItems')}; unlockPriceStardust from the Stardust shop (${src('shopItems')})`,
        relics: `the relic table (${src('relics')})`,
        runBoosts: `${src('boosts', 'boostPrices')}`,
        'seals, overtimeOfferings, overtime': `${src('seals', 'overtimeOfferings', 'overtime')}`,
        'typeBlessings, powerups, stats, statuses, typeStatus, weather': `${src('typeBlessings', 'powerups', 'stats', 'statuses', 'typeStatus', 'weather')}`,
        'lab, friendship, shinyPerks': `${src('lab', 'friendPerks', 'friendLevel', 'shinyPerks')}`,
        'types, difficultyTiers, maps': `${src('dex', 'tierTable', 'maps')}`,
      }, [
        'held items: effects beyond mods are code; desc is the game\'s own text. maxStack is null where the table has no "max" (the game\'s code then uses its default limit)',
        'held items: prices in the in-run shop are computed when a stock is drawn and are not in a table',
        'seals and overtime offerings: only the keys are data (effects are code; see docs/game-mechanics.md §1 and §3). Numbers the offerings use are in "overtime"',
        'blessings (altars, totems, dojo prizes) are generated per offer as { label, mods, rarity }; there is no table of blessing keys',
        'relic passives: text and the numbers in "values"; the logic is code',
        'pickup kinds are numbers in the game with no table of names',
      ]),
      ...items,
    },
    vocab: {
      header: header('vocab', VOCAB_VERSION, {
        'species, type': `the reference data (${src('dex')}): every species of the Pokédex, not only League members, because enemies and evolutions use the same numbers`,
        'role, rank, passive, move, archetype, moveClass, vitamin, item, relic, runBoost, seal, overtimeOffering, stat, status, weather, map, rarity': 'the keys of the tables exported in species.json, moves.json and items.json',
        'offerKind, decisionKind, extraAction': 'src/knowledge/vocab.ts and src/environment/types.ts (the environment\'s own names)',
        'enemyFlag, projectileFlag': `${src('enemyFlags', 'projectileFlags')}: the value is the bit position + 1`,
        interactable: 'the kind names the game\'s map-point class compares against in its own source',
        entity: 'one table over move:, vitamin:, item:, relic:, seal:, offering:, species: and stat: keys, for embeddings shared between the build and the offers of a dialog',
      }, [
        'interactable kinds: the game has no table; the list is what its map-point class compares a kind against in its code, so a kind created elsewhere would map to 0, and a few names in it belong to scenery of the same class (arch, fairy, grove, meadow)',
        'role and rarity keys are the game\'s display names in the export language (the League table has no language-independent role key): an export in another language gives other keys',
        'offer kinds: the four kinds of the standard mode\'s level-up generator',
        'blessings and trades have no keys of their own: a blessing is encoded through the stat it changes (stat:<key>)',
      ]),
      tables,
    },
  };
}

/** Stable text of a dataset: fixed key order (insertion order of the builder), one space of indentation, trailing newline. */
export const serialize = (dataset: unknown): string => JSON.stringify(dataset, null, 1) + '\n';

export function writeKnowledge(dir: string, k: Knowledge): Record<string, { path: string; bytes: number }> {
  mkdirSync(dir, { recursive: true });
  const out: Record<string, { path: string; bytes: number }> = {};
  for (const name of ['species', 'moves', 'items', 'vocab'] as const) {
    const path = join(dir, `${name}.json`);
    const text = serialize(k[name]);
    writeFileSync(path, text);
    out[name] = { path, bytes: Buffer.byteLength(text) };
  }
  return out;
}

/** Read an exported dataset back. */
export function readDataset<T>(dir: string, name: 'species' | 'moves' | 'items' | 'vocab'): T {
  return JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as T;
}
