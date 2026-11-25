import { ORIGIN } from '../sim/net.ts';

/**
 * The "fresh account with everything unlocked" preset, built from the running game's own registries.
 *
 * Nothing here is a hand-typed list. The registries are module exports of the bundle's chunks (League members, Lab
 * upgrades, the Stardust item shop, maps, alternative forms, difficulty tiers, the season's map list). Their export
 * names are minified and change with every build, so each one is found by its shape and must match exactly one
 * export; anything else is a build change and stops the environment.
 *
 * What the preset contains, and the game's own check that confirms each part (`verifyUnlocked`):
 *
 *   League        every member id in `league` (+ its family in `unlocked`, `captured`)   meta.inLeague(id)
 *   Lab           every upgrade at its registry `max` level                              meta.lab(id) === max
 *   Items         every Stardust-shop item key in `itemsOwned`                           meta.itemInPool(key)
 *   Maps          every map of the season's list in `biomes` at the highest tier index   meta.biomeTier(id) === tiers - 1
 *                 (the map registry also holds the arenas of other modes: Tower, Expedition, Boss Rush. The game
 *                 reports those as not selectable whatever the profile says, and they are left out.)
 *   Forms         every alternative form in `johtoForms`                                 meta.hasForm(form)
 *   Friendship    every League member at the top friendship level: `friendship[member]`  meta.friendship(id).max
 *                 = the fewest points the game's own level function calls the maximum
 *   Research      every Pokédex family at its research goal: `research[family]`          meta.researchDone(family),
 *                                                                                        meta.researched().length
 *
 *   Shinies       the complete shiny collection (owner's decision): `shinies` = every     meta.shinyPerks() has every
 *                 species the game's own shiny rules can produce (`shinyCollection`)     tier, meta.hasShinyCharm(),
 *                                                                                        meta.shinyBond(), and no family
 *                                                                                        is left for the game's own
 *                                                                                        "not collected yet" test
 *
 * "Complete" for the shiny collection comes from the two rules the game itself has (the game shows no total):
 *   - wild shinies: its own eligibility test for a wild shiny is "inside the season's Pokédex range, has an animated
 *     sprite, not legendary, not mythical". Its zone pools hold evolved forms as well as base forms, and a caught
 *     shiny is recorded by its own species number, so every species passing that test is in the collection;
 *   - legendary shinies: only the species of its legendary-shiny list can appear shiny (`legendShinies`).
 * Legendary or mythical species outside that list cannot be shiny by either rule and are not in the collection.
 * What a complete collection changes in a run: all five perks; a wild shiny is still drawn (the game falls back to the
 * whole zone pool when no family is new), but every one is a repeat; a legendary shiny becomes rarer (the game divides
 * its chance by the number of listed legendaries already owned).
 *
 * What it deliberately leaves at the fresh-account value: Stardust (0), run history, counters, quests, cosmetics
 * (including the titles friendship levels award and the shiny skins) and the consumable bag (run boosts). (The
 * Pokédex `seen` list is not set here either: the game fills it itself, for every species of an unlocked family,
 * when it adopts the profile.) See docs/game-mechanics.md §6.
 */

/** Version of the unlocked preset: reported by `getMetadata().profile.preset`; store it with recorded episodes. */
export const UNLOCKED_PRESET = 'unlocked-v3';

export interface LeagueMember { id: number; start?: boolean; role: string; passive: string; kit: string[]; rank: string }
export interface LabUpgrade { id: string; max: number }
export interface ShopItem { key: string; price: number }
export interface GameMap { id: string; name: string }
export interface AltForm { form: number; member: number; from: number; at: string }
export interface FriendPerk { lv: number; id: string; name: string; desc: string; stat?: string; add?: number; uses?: string; ult?: number }
export interface ShinyPerk { n: number; name: string; desc: string; stat?: string; add?: number; charm?: boolean; bond?: number }
/** The bundle's species rules object: Pokédex membership, family of a species, research goal of a family. */
export interface DexRules { has(species: number): boolean; family(species: number): number; researchGoal(family: number): number; familyTypes(family: number): string[]; legendary(species: number): boolean }
/** The bundle's reference data object (species, generic moves, learnsets, type chart). Only the part used here. */
export interface DexData {
  pokemon: { id: number; name: string; types: string[]; legendary?: boolean; mythical?: boolean }[];
  byId: Map<number, { id: number; legendary?: boolean; mythical?: boolean }>;
  /** Base form of a species' evolution line. */
  root(species: number): { id: number };
  /** The species has an animated sprite sheet (the game requires it of a wild shiny). */
  hasAnimated(species: number): boolean;
}

export interface Registries {
  /** Friendship: the perks by level, the game's own points → level function, and the points of the top level. */
  friendPerks: FriendPerk[];
  friendLevel: (points: number) => { lv: number; max: boolean };
  friendMaxPoints: number;
  /** Perks of the shiny collection, by number of shinies owned. */
  shinyPerks: ShinyPerk[];
  /** The game's "is this species number inside the season's Pokédex" test. Pure. */
  dexRange: (species: number) => boolean;
  /** The only legendary / mythical species the game lets appear shiny (its legendary-shiny list). */
  legendShinies: number[];
  dexRules: DexRules;
  dex: DexData;
  league: LeagueMember[];
  lab: LabUpgrade[];
  shopItems: ShopItem[];
  maps: GameMap[];
  forms: AltForm[];
  /** Number of difficulty tiers (tier indexes are 0 … tiers - 1). */
  tiers: number;
  season: { season: number; name: string; biomes: string[] };
  /**
   * The game's own general-purpose random generator: one module-level object (`range`, `pick`, `chance`, `shuffle`…)
   * with its 32-bit state in the field `s`. The bundle seeds it once, when the module loads, from the clock and
   * Math.random, and never again: weather, spawn positions and many rolls draw from it across runs. The environment
   * sets `s` at defined points of an episode (see GameEnvironment.reseed) so that an episode does not depend on what
   * the process did before.
   */
  rng: { s: number };
  /** The bundle's own release list (newest first): its first entry names this build and its version. */
  releases: { version: string; build?: string; date?: string }[];
  /** Where each registry was found: `<chunk file>#<export name>`. */
  sources: Record<string, string>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Map) && !(v instanceof Set);
const allObjs = (v: unknown): v is Record<string, unknown>[] => Array.isArray(v) && v.length > 0 && v.every(isObj);

/** One shape test per registry. Each must match exactly one export of the loaded chunks. */
const SHAPES: Record<Exclude<keyof Registries, 'sources' | 'tiers' | 'friendLevel' | 'friendMaxPoints' | 'dexRange' | 'legendShinies'> | 'tierTable' | 'speciesLists', (v: unknown) => boolean> = {
  // Candidates for the legendary-shiny list: short arrays of whole numbers. Which one it is needs the reference data
  // (every entry a legendary or mythical species), so it is settled in readRegistries.
  speciesLists: (v) => Array.isArray(v) && v.length >= 2 && v.length <= 32 && v.every((x) => Number.isInteger(x) && x > 0),
  friendPerks: (v) => allObjs(v) && v.every((p) => typeof p.lv === 'number' && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.desc === 'string' && typeof p.icon === 'string') && v.some((p) => typeof p.uses === 'string'),
  shinyPerks: (v) => allObjs(v) && v.every((p) => typeof p.n === 'number' && typeof p.name === 'string' && typeof p.desc === 'string') && v.some((p) => p.charm === true),
  dexRules: (v) => isObj(v) && ['has', 'family', 'researchGoal', 'familyTypes', 'legendary'].every((k) => typeof v[k] === 'function'),
  dex: (v) => isObj(v) && Array.isArray(v.pokemon) && v.byId instanceof Map && v.moves instanceof Map && v.movesByKey instanceof Map && 'learnsets' in v && 'typeIndex' in v,
  releases: (v) => allObjs(v) && typeof v[0].version === 'string' && typeof v[0].build === 'string' && v.every((r) => typeof r.version === 'string' && 'notes' in r),
  rng: (v) => isObj(v) && typeof v.s === 'number' && Object.keys(v).length === 1 && ['next', 'range', 'pick', 'chance', 'shuffle', 'scoped'].every((k) => typeof (v as Record<string, unknown>)[k] === 'function'),
  league: (v) => allObjs(v) && v.every((m) => typeof m.id === 'number' && typeof m.role === 'string' && typeof m.passive === 'string' && Array.isArray(m.kit) && typeof m.rank === 'string'),
  lab: (v) => allObjs(v) && v.every((u) => typeof u.id === 'string' && typeof u.max === 'number' && typeof u.cost === 'function'),
  shopItems: (v) => allObjs(v) && v.length > 1 && v.every((i) => typeof i.key === 'string' && typeof i.price === 'number' && Object.keys(i).length === 2),
  maps: (v) => allObjs(v) && v.every((m) => typeof m.id === 'string' && typeof m.name === 'string' && Array.isArray(m.bosses) && 'sky' in m),
  forms: (v) => allObjs(v) && v.every((f) => typeof f.form === 'number' && typeof f.member === 'number' && typeof f.from === 'number' && typeof f.at === 'string' && Object.keys(f).length === 4),
  season: (v) => isObj(v) && typeof v.season === 'number' && typeof v.name === 'string' && Array.isArray(v.biomes) && 'maxDex' in v,
  tierTable: (v) => isObj(v) && ['hp', 'dmg', 'speed', 'amount', 'kills', 'level'].every((k) => Array.isArray(v[k])) && new Set(Object.values(v).filter(Array.isArray).map((a) => (a as unknown[]).length)).size === 1,
};

/**
 * Exported functions the preset needs, found by what their source does (the names are minified). Each must match
 * exactly one function export.
 */
const FUNCTIONS: Record<'friendLevel' | 'dexRange', RegExp> = {
  /** points → { lv, xp, into, need, frac, max }: the friendship level a number of friendship points gives. Pure. */
  friendLevel: /\{lv:[\w$]+,xp:[\w$]+,into:[\w$]+,need:[\w$]+,frac:[^,]+,max:[\w$]+\}/,
  /** species number → inside the season's Pokédex (`e => e > 0 && e <= (preview ? season.nextDex : season.maxDex)`). Pure. */
  dexRange: /^([\w$]+)=>\1>0&&\1<=\([\w$]+\?[\w$]+\.nextDex:[\w$]+\.maxDex\)$/,
};

/** Read the registries from the chunks the game has loaded (`loaded` = their URL paths, e.g. `/assets/x.js`). */
export async function readRegistries(loaded: string[]): Promise<Registries> {
  const hits: Record<string, { value: unknown; where: string }[]> = {};
  for (const path of loaded) {
    // Same URL the game imported: the module is already evaluated, this only hands back its namespace object.
    const mod = (await import(`${ORIGIN}${path}`)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value === 'function') {
        const src = Function.prototype.toString.call(value);
        for (const [key, re] of Object.entries(FUNCTIONS))
          if (re.test(src) && !(hits[key] ??= []).some((h) => h.value === value)) hits[key].push({ value, where: `${path.split('/').pop()}#${name}` });
        continue;
      }
      for (const [key, test] of Object.entries(SHAPES)) {
        let ok = false;
        try { ok = test(value); } catch { ok = false; }
        if (ok && !(hits[key] ??= []).some((h) => h.value === value)) hits[key].push({ value, where: `${path.split('/').pop()}#${name}` });
      }
    }
  }
  const one = <T>(key: string): { value: T; where: string } => {
    const h = hits[key] ?? [];
    if (h.length !== 1) throw new Error(`[environment] game registry "${key}": expected exactly one matching export in the bundle, found ${h.length}${h.length ? ` (${h.map((x) => x.where).join(', ')})` : ''}. The game build has changed; re-validate src/environment/profile.ts.`);
    return h[0] as { value: T; where: string };
  };
  const league = one<LeagueMember[]>('league'), lab = one<LabUpgrade[]>('lab'), shopItems = one<ShopItem[]>('shopItems');
  const maps = one<GameMap[]>('maps'), forms = one<AltForm[]>('forms'), season = one<Registries['season']>('season');
  const tierTable = one<Record<string, unknown[]>>('tierTable');
  const rng = one<{ s: number }>('rng');
  const releases = one<Registries['releases']>('releases');
  const friendPerks = one<FriendPerk[]>('friendPerks'), shinyPerks = one<ShinyPerk[]>('shinyPerks'), dexRules = one<DexRules>('dexRules'), dex = one<DexData>('dex');
  const friendLevel = one<Registries['friendLevel']>('friendLevel');
  const dexRange = one<Registries['dexRange']>('dexRange');
  // The legendary-shiny list: the one exported list of species numbers whose entries are all legendary or mythical.
  const isLegend = (id: number): boolean => { const s = dex.value.byId.get(id); return !!s && !!(s.legendary || s.mythical); };
  hits.legendShinies = (hits.speciesLists ?? []).filter((h) => (h.value as number[]).every(isLegend));
  const legendShinies = one<number[]>('legendShinies');
  // The fewest points the game's own function calls the top level: double until it says "max", then bisect.
  const isMax = (points: number): boolean => friendLevel.value(points).max === true;
  if (isMax(0)) throw new Error('[environment] the game reports friendship at its maximum with 0 points: the friendship rules have changed; re-validate src/environment/profile.ts.');
  let hi = 1;
  while (!isMax(hi)) { hi *= 2; if (hi > 2 ** 40) throw new Error('[environment] the game\'s friendship level function never reports the maximum: the friendship rules have changed; re-validate src/environment/profile.ts.'); }
  let lo = hi / 2;
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (isMax(mid)) hi = mid; else lo = mid; }
  return {
    friendPerks: friendPerks.value, friendLevel: friendLevel.value, friendMaxPoints: hi, shinyPerks: shinyPerks.value, dexRules: dexRules.value, dex: dex.value,
    dexRange: dexRange.value, legendShinies: [...legendShinies.value],
    league: league.value, lab: lab.value, shopItems: shopItems.value, maps: maps.value, forms: forms.value, season: season.value,
    tiers: (tierTable.value.hp as unknown[]).length,
    rng: rng.value,
    releases: releases.value,
    sources: { rng: rng.where, releases: releases.where, league: league.where, lab: lab.where, shopItems: shopItems.where, maps: maps.where, forms: forms.where, season: season.where, tiers: tierTable.where, friendPerks: friendPerks.where, friendLevel: friendLevel.where, shinyPerks: shinyPerks.where, dexRules: dexRules.where, dex: dex.where, dexRange: dexRange.where, legendShinies: legendShinies.where },
  };
}

/**
 * The unlocked profile, as a function of a fresh profile (what POST /dev/unlock returns).
 * `family` is the game's own species → family mapping (`meta.family`).
 */
export function unlockedProfile(fresh: Record<string, any>, reg: Registries, family: (species: number) => number): Record<string, any> {
  const p = structuredClone(fresh);
  const at = Number(p.created) || 0;
  p.league = reg.league.map((m) => m.id);
  p.unlocked = [...new Set(reg.league.map((m) => family(m.id)))];
  p.captured = Object.fromEntries(p.unlocked.map((f: number) => [f, at]));
  p.lab = Object.fromEntries(reg.lab.map((u) => [u.id, u.max]));
  p.itemsOwned = reg.shopItems.map((i) => i.key);
  p.biomes = Object.fromEntries(playableMaps(reg).map((m) => [m.id, reg.tiers - 1]));
  p.johtoForms = reg.forms.map((f) => f.form);
  // Friendship is kept per League member (the game maps a species to the member of its family): the top level for all.
  p.friendship = Object.fromEntries(reg.league.map((m) => [m.id, reg.friendMaxPoints]));
  // Research is kept per family: each at the goal the game computes for it.
  p.research = Object.fromEntries(researchFamilies(reg).map((f) => [f, reg.dexRules.researchGoal(f)]));
  // The complete shiny collection (see the note at the top of this file for what "complete" is taken from).
  p.shinies = shinyCollection(reg);
  return p;
}

/**
 * Every species the game's own shiny rules can produce, in ascending order: species inside the season's Pokédex
 * range with an animated sprite that are neither legendary nor mythical (its wild-shiny test), and the species of
 * its legendary-shiny list.
 */
export function shinyCollection(reg: Registries): number[] {
  const out: number[] = [];
  for (const s of reg.dex.pokemon) {
    if (!reg.dexRange(s.id)) continue;
    const legend = !!(s.legendary || s.mythical);
    if (legend ? reg.legendShinies.includes(s.id) : reg.dex.hasAnimated(s.id)) out.push(s.id);
  }
  return out.sort((a, b) => a - b);
}

/**
 * The families the game would still call "not collected" for a list of shinies, by its own test: base forms inside
 * the Pokédex range with an animated sprite, not legendary or mythical, whose base form is not the base form of any
 * entry. (The same expression as the fallback of its wild-shiny spawn.) Empty for a complete collection.
 */
export function shinyFamiliesLeft(reg: Registries, shinies: number[]): number[] {
  const have = new Set(shinies.map((id) => reg.dex.root(id).id));
  return reg.dex.pokemon
    .filter((s) => reg.dexRange(s.id) && !s.legendary && !s.mythical && reg.dex.root(s.id).id === s.id && reg.dex.hasAnimated(s.id) && !have.has(s.id))
    .map((s) => s.id);
}

/** Every Pokédex family the game keeps research for, in ascending order. */
export function researchFamilies(reg: Registries): number[] {
  const out = new Set<number>();
  for (const s of reg.dex.pokemon) {
    if (!reg.dexRules.has(s.id)) continue;
    const f = reg.dexRules.family(s.id);
    if (reg.dexRules.familyTypes(f).length > 0) out.add(f);
  }
  return [...out].sort((a, b) => a - b);
}

/** The maps a standard (Classic / Ranked) run can be started on: the registry's maps that are in the season's list. */
export function playableMaps(reg: Registries): GameMap[] { return reg.maps.filter((m) => reg.season.biomes.includes(m.id)); }

export interface UnlockCheck { ok: boolean; problems: string[]; summary: Record<string, unknown> }

/** Ask the game's own profile object (`app.meta`) whether everything in the registries is unlocked. */
/**
 * `archived` (preset unlocked-v4): item keys the preset took out of the pool on purpose. An owned shop item among
 * them must be OUT of the pool by the game's own test, every other one in it.
 */
export function verifyUnlocked(meta: any, reg: Registries, archived: readonly string[] = []): UnlockCheck {
  const problems: string[] = [];
  const bad = <T>(what: string, list: T[], ok: (x: T) => boolean, name: (x: T) => string) => {
    const missing = list.filter((x) => { try { return !ok(x); } catch { return true; } });
    if (missing.length) problems.push(`${what}: ${missing.length} of ${list.length} not unlocked (${missing.slice(0, 6).map(name).join(', ')}${missing.length > 6 ? ', …' : ''})`);
    return list.length - missing.length;
  };
  const league = bad('League (meta.inLeague)', reg.league, (m) => meta.inLeague(m.id) === true, (m) => String(m.id));
  const lab = bad('Lab (meta.lab)', reg.lab, (u) => meta.lab(u.id) === u.max, (u) => u.id);
  const items = bad('Items (meta.itemInPool)', reg.shopItems, (i) => meta.itemInPool(i.key) === !archived.includes(i.key), (i) => i.key);
  const playable = playableMaps(reg);
  const maps = bad('Maps (meta.biomeTier)', playable, (m) => meta.biomeTier(m.id) === reg.tiers - 1, (m) => m.id);
  const forms = bad('Forms (meta.hasForm)', reg.forms, (f) => meta.hasForm(f.form) === true, (f) => String(f.form));
  const topLevel = reg.friendLevel(reg.friendMaxPoints).lv;
  const friends = bad('Friendship (meta.friendship)', reg.league, (m) => { const f = meta.friendship(m.id); return f.max === true && f.lv === topLevel; }, (m) => String(m.id));
  const families = researchFamilies(reg);
  const research = bad('Research (meta.researchDone)', families, (f) => meta.researchDone(f) === true, (f) => String(f));
  const researched: unknown[] = meta.researched();
  if (researched.length !== families.length) problems.push(`Research (meta.researched): the game counts ${researched.length} completed families, the preset has ${families.length}`);
  // Shiny collection: every perk tier active as the game computes it, and nothing left for its own "new family" test.
  const collection = shinyCollection(reg);
  const shinyHave: ShinyPerk[] = meta.shinyPerks();
  if (shinyHave.length !== reg.shinyPerks.length) problems.push(`Shiny perks (meta.shinyPerks): ${shinyHave.length} of ${reg.shinyPerks.length} tiers active with ${meta.shinyCount()} shinies`);
  const topBond = Math.max(0, ...reg.shinyPerks.map((p) => p.bond ?? 0));
  if (meta.hasShinyCharm() !== true) problems.push('Shiny Charm (meta.hasShinyCharm): not active');
  if (meta.shinyBond() !== topBond) problems.push(`Shiny partner bond (meta.shinyBond): ${meta.shinyBond()}, the perk table's highest is ${topBond}`);
  const owned: number[] = meta.profile.shinies;
  const shinies = bad('Shiny collection (profile.shinies)', collection, (id) => owned.includes(id), (id) => String(id));
  if (meta.shinyCount() !== collection.length) problems.push(`Shiny collection (meta.shinyCount): the game counts ${meta.shinyCount()}, the preset has ${collection.length}`);
  const left = shinyFamiliesLeft(reg, owned);
  if (left.length) problems.push(`Shiny collection: ${left.length} families are still new by the game's own test (${left.slice(0, 6).join(', ')}${left.length > 6 ? ', …' : ''})`);
  return {
    ok: problems.length === 0, problems,
    summary: {
      leagueMembers: `${league}/${reg.league.length}`, labUpgradesAtMax: `${lab}/${reg.lab.length}`, shopItemsOwned: `${items}/${reg.shopItems.length}`,
      mapsAtTopTier: `${maps}/${playable.length}`, maps: playable.map((m) => m.id), otherModeArenas: reg.maps.filter((m) => !playable.includes(m)).map((m) => m.id), topTier: reg.tiers - 1, altForms: `${forms}/${reg.forms.length}`,
      friendshipAtMax: `${friends}/${reg.league.length}`, friendshipLevel: topLevel, friendshipPoints: reg.friendMaxPoints,
      researchComplete: `${research}/${families.length}`,
      shinyPerks: `${shinyHave.length}/${reg.shinyPerks.length}`,
      shinyCollection: `${shinies}/${collection.length}`, shinyCharm: meta.hasShinyCharm() === true, shinyBond: meta.shinyBond(), shinyFamiliesLeft: left.length,
      shinyLegendaries: [...reg.legendShinies],
      shinyNotCollectable: reg.dex.pokemon.filter((s) => reg.dexRange(s.id) && !collection.includes(s.id)).map((s) => s.id),
      preset: UNLOCKED_PRESET, registries: reg.sources,
    },
  };
}
