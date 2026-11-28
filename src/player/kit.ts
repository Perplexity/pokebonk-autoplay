import { PLAN } from './plan.ts';
import type { Plan } from './plan.ts';
import type { Knowledge } from './values.ts';

/**
 * The build a plan lists for a Pokémon (`plan.builds`), as rules over what is held, and the account's build plan
 * that goes with it.
 * Read in the game (build mwsewi0r):
 *
 *   - Bill's machine works once, and a zone has one (the sanctuary has none). It takes two moves that are both at
 *     level 8 or more and either FUSES them (one new move in one slot; a fusion cannot go into the machine again) or
 *     LINKS them (both keep firing from one slot, each with +15 % damage and one bonus; a linked pair gets no more
 *     upgrades and cannot go into the machine again). A move that only strengthens the Pokémon or sets the weather
 *     (Encore) can be neither fused nor linked, except as an ingredient of the species' own fusion.
 *   - Four slots. The fusion, two linked pairs and one move that cannot be linked are six moves in four slots, and
 *     that takes all three machines of a run: the leaderboard Mewtwo's kit.
 *   - Hypno pays for a forgotten move, any number of times, and gives one lesson a zone for a free slot.
 *   - A level-up with a free slot offers new moves; with none it never does. A move of the species' own kit that is
 *     not held is offered three times as often as anything else until it is banished.
 *   - A TM Case raises the level a move can reach from 8 to 10.
 *
 * `kitState` is a pure function of the held moves and items, the zone and the map points.
 */
/** A held move as the run state lists it (src/observations/state.ts, `build.moves`), with the slot it is in. */
export interface HeldMove { slot: number; key: string; level: number; fusion: boolean; linked: string | null }
export interface MapPoint { kind: string; used: boolean }

export interface KitState {
  /** The plan lists a build for this Pokémon. */
  on: boolean;
  /** The build's two moves to fuse (empty: none) and its other moves, in the plan's order. */
  pair: readonly string[]; wanted: readonly string[];
  /** The plan's fusion is held (or the plan has none to make). */
  fused: boolean;
  /** Kit moves not held, neither in a slot of their own nor linked into one, in the order of preference of this moment. */
  missing: string[];
  /** Those of `missing` a free slot should take now, best first (empty: the free slots are owed to the fusion's moves). */
  takeable: string[];
  /** The held moves, as given. */
  held: readonly HeldMove[];
  /** Slots of held moves the kit has no place for. */
  junk: number[];
  /** Those of `junk` Hypno should forget now. */
  forget: number[];
  /** The level two moves need before the machine is used on them: 8, and 10 while a TM Case is held. */
  cap: number;
  /** What Bill's machine should do with what is held: the two moves to fuse, else the two to link, else nothing. */
  fuse: [string, string] | null;
  link: [string, string] | null;
  /** Machines the run can still use: this zone's while it is unused, and one for every zone after it. */
  machinesLeft: number;
  /** Moves of the species' own kit that the plan's kit has no place for: banished when offered. */
  ownJunk: string[];
  /**
   * The level from which every move of the kit can be offered. Hypno's lesson is not asked for before: turned down,
   * it keeps the same moves for the rest of the zone.
   */
  lessonFrom: number;
}

const OFF: KitState = { on: false, pair: [], wanted: [], fused: true, missing: [], takeable: [], held: [], junk: [], forget: [], cap: 8, fuse: null, link: null, machinesLeft: 0, ownJunk: [], lessonFrom: 1 };
/** Zones with a machine. */
const MACHINE_ZONES = 3;

/** A move Bill's machine can link: not one that only strengthens the Pokémon or sets the weather. */
export const linkable = (key: string, k: Knowledge): boolean => { const a = k.moves.get(key)?.archetype; return a !== 'buff' && a !== 'weather'; };

export function kitState(moves: readonly HeldMove[], slots: number, items: Record<string, number>, species: number, stage: number, points: readonly MapPoint[], plan: Plan, k: Knowledge): KitState {
  const build = plan.builds[species];
  if (!build || (!build.kit.length && !build.fuse.length)) return OFF;
  const cap = 8 + ((items['tm-case'] ?? 0) > 0 ? 2 : 0);
  const held = new Set<string>();
  for (const m of moves) { held.add(m.key); if (m.linked) held.add(m.linked); }
  const pair = build.fuse.length === 2 ? [build.fuse[0], build.fuse[1]] as [string, string] : null;
  const fused = !pair || moves.some((m) => m.fusion);
  const machinesLeft = stage > MACHINE_ZONES ? 0 : MACHINE_ZONES - stage + (points.some((p) => p.kind === 'bill' && !p.used) ? 1 : 0);
  // A move that cannot be linked comes last while a machine is still to come: a slot it holds early is a slot the last
  // pair cannot be learned into. With no machine left it comes first (nothing more will be paired).
  const missingAll = build.kit.filter((key) => !held.has(key));
  const pairs = missingAll.filter((key) => linkable(key, k)), singles = missingAll.filter((key) => !linkable(key, k));
  const missing = machinesLeft > 0 ? [...pairs, ...singles] : [...singles, ...pairs];
  // Until the fusion is made its two moves each need a slot of their own.
  const owed = fused ? 0 : pair!.filter((key) => !held.has(key)).length;
  const takeable = slots - moves.length - owed > 0 ? (machinesLeft > 0 && pairs.length ? pairs : missing) : [];
  const route = new Set<string>([...build.kit, ...(fused ? [] : pair ?? [])]);
  const junk: number[] = [];
  for (const m of moves) if (!m.fusion && !route.has(m.key)) junk.push(m.slot);
  // Forgotten only out of a full set of slots, and only while something is still to be learned in its place: the run
  // is not left short of a move while it waits for an offer.
  const forget = missingAll.length > 0 && moves.length >= slots ? junk : [];
  const ready = (key: string): boolean => moves.some((m) => m.key === key && !m.fusion && !m.linked && m.level >= cap);
  const fuse = pair && !fused && ready(pair[0]) && ready(pair[1]) ? pair : null;
  const linkReady = build.kit.filter((key) => linkable(key, k) && ready(key));
  const link = linkReady.length >= 2 ? [linkReady[0], linkReady[1]] as [string, string] : null;
  const ownJunk = k.kitOf(species).filter((key) => !build.kit.includes(key) && !build.fuse.includes(key));
  const from = k.learnable(species).from, lessonFrom = Math.max(1, ...build.kit.map((key) => from[key] ?? 1));
  return { on: true, pair: build.fuse, wanted: build.kit, fused, missing, takeable, held: moves, junk, forget, cap, fuse, link, machinesLeft, ownJunk, lessonFrom };
}

// ---- the account's build plan -------------------------------------------------------------------------------------

/**
 * A build plan of the account for one League member, as the game keeps it ("Plan de build"): favourite moves, and
 * the moves of the member's pool that are switched off. Read in the game:
 *
 *   - Favourites: at most four with the Lab's Affinity at its top level, each then offered with a chance of 15 % when
 *     a level-up with a free slot draws a move of the member's own line (35 % of level-ups) or of another League
 *     member (50 %), and always shown when drawn. When every move left in the line is a favourite, the line's draw is
 *     always one of them. Hypno's lesson always offers one favourite.
 *   - Moves off: at most 40, never one of the member's own kit, and at least 12 moves of other League members stay
 *     on (the game switches moves back on, in the order of the list, until 12 are).
 *
 * `favourites` and `keep` come from the plan's build for the Pokémon; what is switched off is generated from the
 * game's knowledge export.
 */
export interface BuildPlan { favourites: string[]; keep: string[] }
export const BUILD_PLANS: Record<string, Record<number, BuildPlan>> = {
  // The plan's builds: a Pokémon's favourites, and its kit as the moves kept switched on. The moves the machine can
  // link are the favourites (two machines wait on them); a move that cannot be linked comes last, into a slot that
  // waits for it however long it takes.
  'kit-1': Object.fromEntries(Object.entries(PLAN.builds).map(([id, b]) => [Number(id), { favourites: [...b.favourites], keep: [...b.kit] }])),
};
export const BUILD_PLAN_NAMES = Object.keys(BUILD_PLANS);
export const FAVOURITES_MAX = 4, PLAN_MOVES_MAX = 8, MOVES_OFF_MAX = 40, SHARED_ON_MIN = 12;

/** The build plan `name` for `species` in the game's own terms: move ids of the plan and of its favourites, and the keys switched off. */
export function buildPlanOf(name: string, species: number, k: Knowledge): { moves: number[]; favs: number[]; movesOff: string[] } {
  const plan = BUILD_PLANS[name]?.[species];
  if (!plan) throw new Error(`build plan "${name}" has nothing for species ${species} (plans: ${BUILD_PLAN_NAMES.join(', ') || 'none'})`);
  const { line, shared } = k.learnable(species), pool = new Set([...line, ...shared]);
  const id = (key: string): number => { const m = k.moves.get(key); if (!m || !pool.has(key)) throw new Error(`build plan "${name}": species ${species} cannot be offered "${key}"`); return m.id; };
  if (plan.favourites.length > FAVOURITES_MAX || plan.keep.length > PLAN_MOVES_MAX || plan.favourites.some((key) => !plan.keep.includes(key))) throw new Error(`build plan "${name}": at most ${FAVOURITES_MAX} favourites, all among at most ${PLAN_MOVES_MAX} kept moves`);
  // Off: every move of the line that is not kept; and of the other members' moves the weakest, as many as the game allows.
  const strength = (key: string): number => { const m = k.moves.get(key); return m && m.cooldown > 0 ? m.damage / m.cooldown : 0; };
  const others = shared.filter((key) => !plan.keep.includes(key)).sort((a, b) => strength(a) - strength(b) || a.localeCompare(b));
  const movesOff = [...line.filter((key) => !plan.keep.includes(key)), ...others.slice(0, Math.max(0, shared.length - SHARED_ON_MIN))].slice(0, MOVES_OFF_MAX);
  return { moves: plan.keep.map(id), favs: plan.favourites.map(id), movesOff };
}
