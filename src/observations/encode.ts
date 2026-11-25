import { createHash } from 'node:crypto';
import { OPTION_SLOTS, TARGET_SLOTS, UNTARGETED_EXTRAS } from '../actions/codec.ts';
import { MOVES, PLAY_BUTTONS } from '../environment/types.ts';
import type { ChoiceMask, Decision, Observation, PlayAction, PlayMask } from '../environment/types.ts';
import type { Enemy, Point, Snapshot } from '../bot/snapshot.ts';
import type { EncoderKnowledge } from '../knowledge/load.ts';
import { DECISION_KINDS, FUSION_KINDS, OFFER_KINDS } from '../knowledge/vocab.ts';
import { DENSITY_BANDS, DENSITY_DIRECTIONS, DOJO_TRIALS } from './state.ts';
import type { MoveState, RunState } from './state.ts';

/**
 * Numeric encoding of an `Observation` for a neural policy: one Float32Array and one Int32Array of fixed size, cut
 * into named segments by a layout descriptor (docs/observation.md). Python slices the two buffers by that descriptor
 * into a Dict space, so the descriptor IS the contract: it is exported as JSON and hashed, and it changes only with
 * OBS_ENCODING_VERSION or with the vocabulary of the game build.
 *
 * Conventions
 *   - every float is bounded: [0, 1] for `bool`, `unit` and `log`, [-1, 1] for `sym` and `slog`; non-finite inputs
 *     become 0. Values beyond a scale's range are clipped;
 *   - positions are relative to the player and WORLD-AXIS ALIGNED (+x east, +z south, the action's "n" is −z). Nothing
 *     is rotated by the camera, because the move directions of the action are world-relative too;
 *   - entity segments (enemies, shots, …) hold the K nearest, nearest first; each row starts with a presence flag and
 *     an absent row is all zeros;
 *   - integers are vocabulary indexes of data/game-knowledge/<build>/vocab.json; 0 is "none / unknown".
 *
 * Each feature is declared once, with its name, its scaling and the function that reads it. The descriptor and the
 * values come from the same declaration, so they cannot drift apart.
 */
/**
 * 2: Max form, rifts, the dojo trial, slot-machine and cage prices, map points used; the buttons form / incense /
 *    fuse in "can" and "prev"; option features for the dojo, Hypno, Bill's machine, the slot machine and selling;
 *    64 option slots.
 */
export const OBS_ENCODING_VERSION = 2;

export const SIZES = {
  enemies: 48, shots: 24, hazards: 16, pickups: 12, points: 16, moveSlots: 4, optionSlots: OPTION_SLOTS, targetSlots: TARGET_SLOTS,
  /** Numeric pickup kinds get a one-hot of this width (the game has no table of pickup kinds). */
  pickupKinds: 16,
} as const;

export type Scale =
  | { kind: 'bool' }
  /** clip(v / max, 0, 1) */
  | { kind: 'unit'; max: number }
  /** clip(v / max, −1, 1) */
  | { kind: 'sym'; max: number }
  /** clip(ln(1 + max(v, 0)) / ln(1 + max), 0, 1) */
  | { kind: 'log'; max: number }
  /** sign(v) · clip(ln(1 + |v|) / ln(1 + max), 0, 1) */
  | { kind: 'slog'; max: number };

const BOOL: Scale = { kind: 'bool' };
const unit = (max: number): Scale => ({ kind: 'unit', max });
const sym = (max: number): Scale => ({ kind: 'sym', max });
const log = (max: number): Scale => ({ kind: 'log', max });
const slog = (max: number): Scale => ({ kind: 'slog', max });

export function applyScale(scale: Scale, value: number | boolean): number {
  if (scale.kind === 'bool') return value ? 1 : 0;
  const v = typeof value === 'number' ? value : value ? 1 : 0;
  if (!Number.isFinite(v)) return 0;
  switch (scale.kind) {
    case 'unit': { const x = v / scale.max; return x < 0 ? 0 : x > 1 ? 1 : x; }
    case 'sym': { const x = v / scale.max; return x < -1 ? -1 : x > 1 ? 1 : x; }
    case 'log': { const x = Math.log1p(v > 0 ? v : 0) / Math.log1p(scale.max); return x > 1 ? 1 : x; }
    case 'slog': { const x = Math.log1p(Math.abs(v)) / Math.log1p(scale.max); return (v < 0 ? -1 : 1) * (x > 1 ? 1 : x); }
  }
}

/** Price of using a map point. The snapshot carries the Poké Ball price; cages and slot machines are priced by the run too. */
function pointCost(e: Point, c: { st: RunState }): number {
  return e.kind === 'cage' ? c.st.economy.cagePrice : e.kind === 'slots' ? c.st.economy.slotPrice : e.cost;
}

export class EncodingError extends Error {
  constructor(message: string) { super(message); this.name = 'EncodingError'; }
}

// ---------------------------------------------------------------- the per-encode context

interface ShotE { dx: number; dz: number; d: number; vx: number; vz: number; r: number; dmg: number; tca: number; miss: number }
interface HazardE { dx: number; dz: number; d: number; r: number; t: number; kind: number; max: number; speed: number }
interface PickupE { kind: number; dx: number; dz: number; d: number }
interface OptionE {
  allowed: boolean; offerKind: number; hasRarity: boolean; rarity: number; level: number; owned: number; hasPrice: boolean; price: number; affordable: boolean;
  fromOtherKit: boolean; banish: boolean; banishKit: boolean; add: number; mul: number; seals: string[]; ups: Record<string, number>; replaces: boolean;
  /** Pokédollars the option pays (Hypno, selling); the fusion machine's link and recipe kind; a dojo trial; Hypno's lesson. */
  hasRefund: boolean; refund: number; link: boolean; recipeKind: number; trial: number; trialBelt: number; trialLimit: number; trialGoal: number; lesson: boolean;
  entity: number; secondary: number;
}
type PrevAction = { move: number } & Record<(typeof PLAY_BUTTONS)[number], boolean>;

interface Ctx {
  obs: Observation; s: Snapshot; st: RunState; k: EncoderKnowledge; prev: PrevAction | null;
  px: number; pz: number; maxHp: number; gold: number; bossIndex: number;
  shots: ShotE[]; hazards: HazardE[]; pickups: PickupE[]; points: Point[];
  vitamins: Map<string, number>; items: Map<string, number>; relics: Set<string>;
  decision: Readonly<Decision> | null; choiceMask: ChoiceMask | null; options: OptionE[];
  types: string[];
}

interface Feature<E> { name: string; scale: Scale; raw: (e: E, c: Ctx) => number | boolean }
interface FloatSegment<E> { name: string; rows: number; features: Feature<E>[]; entities: (c: Ctx) => ArrayLike<E | null | undefined>; note: string }
interface IntFeature<E> { name: string; vocab: string; raw: (e: E, c: Ctx) => number }
interface IntSegment<E> { name: string; rows: number; features: IntFeature<E>[]; entities: (c: Ctx) => ArrayLike<E | null | undefined>; note: string }

const f = <E>(name: string, scale: Scale, raw: (e: E, c: Ctx) => number | boolean): Feature<E> => ({ name, scale, raw });
/** One feature per label, 1 where `index(e, c)` names it (−1 or out of range: all zero). */
const oneHot = <E>(prefix: string, labels: readonly string[], index: (e: E, c: Ctx) => number): Feature<E>[] =>
  labels.map((label, i) => f<E>(`${prefix}:${label}`, BOOL, (e, c) => index(e, c) === i));
/** One feature per label, 1 where `has(label, e, c)`. */
const multiHot = <E>(prefix: string, labels: readonly string[], has: (label: string, e: E, c: Ctx) => boolean): Feature<E>[] =>
  labels.map((label) => f<E>(`${prefix}:${label}`, BOOL, (e, c) => has(label, e, c)));
const self = (c: Ctx): Ctx[] => [c];

export interface LayoutSegment {
  name: string;
  dtype: 'float32' | 'int32';
  /** Offset in elements inside the buffer of that dtype. */
  offset: number;
  /** [rows, features per row]; slice `buffer[offset : offset + rows * features]` and reshape. */
  shape: [number, number];
  note: string;
  features: { name: string; scale?: Scale; vocab?: string }[];
}
export interface ObservationLayout {
  version: number;
  knowledge: { build: string; gameVersion: string | null; vocabVersion: number; vocabSha256: string };
  sizes: { [K in keyof typeof SIZES]: number };
  conventions: Record<string, string>;
  floatSize: number;
  intSize: number;
  segments: LayoutSegment[];
  /** sha256 over everything above. */
  hash: string;
}

export interface Encoded { float: Float32Array; int: Int32Array }

export class ObservationEncoder {
  readonly layout: ObservationLayout;
  /** Keys met during encoding that the vocabulary does not have and that are allowed to be unknown (they encode as 0), with counts. */
  readonly unknown = new Map<string, number>();
  private readonly k: EncoderKnowledge;
  private readonly floats: { seg: FloatSegment<any>; offset: number; scales: Scale[]; raws: ((e: any, c: Ctx) => number | boolean)[] }[] = [];
  private readonly ints: { seg: IntSegment<any>; offset: number }[] = [];
  private floatSize = 0;
  private intSize = 0;
  private readonly sizes: { [K in keyof typeof SIZES]: number };

  /**
   * `sizes.optionSlots`: rows of the dialog-option segments. The default is the version-2 layout (64, the action
   * codec's); the manager's observation (src/hybrid) uses more, because a strong run holds more than 64 distinct items
   * and Ditto lists every one. Another size is another layout, with another hash.
   */
  constructor(knowledge: EncoderKnowledge, sizes: { optionSlots?: number } = {}) {
    this.k = knowledge;
    this.sizes = { ...SIZES, optionSlots: sizes.optionSlots ?? SIZES.optionSlots };
    const SZ = this.sizes;
    const k = knowledge;
    const T = k.tables;
    for (const name of ['species', 'type', 'role', 'rank', 'passive', 'archetype', 'stat', 'vitamin', 'item', 'relic', 'seal', 'overtimeOffering', 'decisionKind', 'enemyFlag', 'map', 'weather', 'interactable', 'entity'])
      if (!T[name]) throw new EncodingError(`the vocabulary of build ${k.build} has no table "${name}"`);
    const typeKeys = k.keys('type'), sealKeys = k.keys('seal'), offeringKeys = k.keys('overtimeOffering'), weatherKeys = k.keys('weather'), rankKeys = k.keys('rank');
    const flagKeys = k.keys('enemyFlag'), kindKeys = k.keys('interactable'), statKeys = k.keys('stat');
    for (const kind of DECISION_KINDS) if (!T.decisionKind[kind]) throw new EncodingError(`the vocabulary has no decision kind "${kind}"`);
    const decisionKeys = k.keys('decisionKind');

    // ------------------------------------------------------------ float segments
    const G: Feature<Ctx>[] = [
      // player
      f('hp_frac', unit(1), (c) => c.s.player.hp / c.maxHp),
      f('max_hp', log(5000), (c) => c.s.player.maxHp),
      f('shield_frac', unit(1), (c) => c.s.player.shield / c.maxHp),
      f('map_x', sym(1), (c) => c.px / (c.s.terrain.bounds || 168)),
      f('map_z', sym(1), (c) => c.pz / (c.s.terrain.bounds || 168)),
      f('vx', sym(25), (c) => c.s.player.vx),
      f('vz', sym(25), (c) => c.s.player.vz),
      f('vy', sym(25), (c) => c.st.player.vy),
      f('speed', unit(25), (c) => c.s.player.speed),
      f('height', unit(10), (c) => c.st.player.height),
      f('grounded', BOOL, (c) => c.st.player.grounded),
      f('jumps_left', unit(3), (c) => c.st.player.jumpsLeft),
      f('diving', BOOL, (c) => c.st.player.diving),
      f('invulnerable_for', unit(2), (c) => Math.max(0, c.s.player.iframes)),
      f('dash_ready', BOOL, (c) => c.st.player.dashCooldown <= 0),
      f('dash_cooldown', unit(2), (c) => c.st.player.dashCooldown),
      f('dashing', BOOL, (c) => c.st.player.dashing),
      f('ultimate_charge', unit(1), (c) => c.st.ultimate.charge),
      f('ultimate_ready', BOOL, (c) => c.st.ultimate.ready),
      f('ultimate_active_for', unit(10), (c) => c.st.ultimate.active),
      f('radius', unit(2), (c) => c.s.player.radius),
      f('pickup_range', unit(30), (c) => c.s.player.pickupRange),
      f('dead', BOOL, (c) => c.s.player.dead),
      // progression
      f('level', log(150), (c) => c.st.build.level),
      f('xp_frac', unit(1), (c) => (c.st.build.xpNext > 0 ? c.st.build.xp / c.st.build.xpNext : 0)),
      f('pending_levels', unit(5), (c) => c.st.build.pendingLevels),
      f('run_time', log(3600), (c) => c.st.zone.time),
      f('zone_time', unit(1200), (c) => c.st.zone.zoneTime),
      ...oneHot<Ctx>('zone', ['1', '2', '3', '4'], (c) => c.st.zone.zone - 1),
      ...oneHot<Ctx>('tier', ['0', '1', '2'], (c) => c.s.tier),
      f('gold', log(100000), (c) => c.gold),
      f('ball_price', log(100000), (c) => c.st.economy.ballPrice),
      f('ball_affordable', BOOL, (c) => c.gold >= c.st.economy.ballPrice),
      f('cage_price', log(100000), (c) => c.st.economy.cagePrice),
      f('slot_price', log(100000), (c) => c.st.economy.slotPrice),
      f('slot_affordable', BOOL, (c) => c.gold >= c.st.economy.slotPrice),
      f('map_points_used', log(500), (c) => c.st.counters.pointsUsed),
      f('kills', log(100000), (c) => c.st.counters.kills),
      f('refreshes', unit(12), (c) => c.st.build.refreshes),
      f('skips', unit(12), (c) => c.st.build.skips),
      f('banishes', unit(12), (c) => c.st.build.banishes),
      f('move_slots_free', unit(SIZES.moveSlots), (c) => c.st.build.moveSlotsFree),
      f('vitamin_slots_free', unit(5), (c) => c.st.build.vitaminSlotsFree),
      f('revives', unit(3), (c) => c.st.build.revives),
      f('has_next_evolution', BOOL, (c) => !!c.st.build.nextEvolution),
      f('levels_to_evolution', unit(50), (c) => (c.st.build.nextEvolution ? Math.max(0, c.st.build.nextEvolution.level - c.st.build.level) : 0)),
      f('evolution_stage', unit(3), (c) => c.st.build.evoStage),
      f('enemy_hp_mult', unit(5), (c) => c.s.diff.enemyHp),
      f('enemy_damage_mult', unit(5), (c) => c.s.diff.enemyDamage),
      f('enemy_speed_mult', unit(3), (c) => c.s.diff.enemySpeed),
      f('enemy_amount_mult', unit(5), (c) => c.s.diff.enemyAmount),
      // zone
      f('final_swarm', BOOL, (c) => c.st.zone.finalSwarm),
      f('final_swarm_for', unit(600), (c) => c.st.zone.finalSwarmSeconds),
      f('collapse_drain_frac', unit(0.1), (c) => c.st.zone.collapseDrain / c.maxHp),
      f('heal_multiplier', unit(1), (c) => c.st.zone.healMultiplier),
      ...oneHot<Ctx>('weather', weatherKeys, (c) => (T.weather[c.st.zone.weather] ?? 0) - 1),
      f('boss_spawned', BOOL, (c) => c.s.bossSpawned),
      f('stage_cleared', BOOL, (c) => c.st.stageCleared),
      f('region_cleared', BOOL, (c) => c.st.regionCleared),
      f('in_sanctuary', BOOL, (c) => c.st.zone.inSanctuary),
      f('enemies_live', log(1000), (c) => c.st.enemies.live),
      f('enemies_cap_frac', unit(1), (c) => (c.st.enemies.cap > 0 ? c.st.enemies.live / c.st.enemies.cap : 0)),
      f('enemies_elite', log(200), (c) => c.st.enemies.elites),
      f('enemies_alpha', log(50), (c) => c.st.enemies.alphas),
      f('enemies_ranged', log(300), (c) => c.st.enemies.ranged),
      // guardian / legendary, seals
      f('guardian_asleep', BOOL, (c) => c.st.guardian.asleep),
      f('guardian_alive', BOOL, (c) => c.st.guardian.alive),
      f('guardian_hp_frac', unit(1), (c) => (c.st.guardian.maxHp > 0 ? c.st.guardian.hp / c.st.guardian.maxHp : 0)),
      f('guardian_max_hp', log(1e7), (c) => c.st.guardian.maxHp),
      f('guardian_enraged', BOOL, (c) => c.st.guardian.enraged),
      f('guardian_fight_time', unit(300), (c) => c.st.guardian.fightTime),
      ...multiHot<Ctx>('seal_active', sealKeys, (key, c) => c.st.guardian.seals.includes(key)),
      f('seals_broken', BOOL, (c) => c.st.guardian.sealsBroken),
      f('seal_clock_running', BOOL, (c) => c.st.guardian.clockLeft > 0),
      f('seal_clock_left', unit(300), (c) => c.st.guardian.clockLeft),
      f('seals_kept', unit(12), (c) => c.st.sealsKept),
      f('boss_present', BOOL, (c) => !!c.s.boss),
      f('boss_dx', sym(60), (c) => (c.s.boss ? c.s.boss.x - c.px : 0)),
      f('boss_dz', sym(60), (c) => (c.s.boss ? c.s.boss.z - c.pz : 0)),
      f('boss_dist', unit(90), (c) => (c.s.boss ? Math.hypot(c.s.boss.x - c.px, c.s.boss.z - c.pz) : 0)),
      f('boss_radius', unit(8), (c) => c.s.boss?.radius ?? 0),
      f('boss_charging', BOOL, (c) => (c.s.boss?.chargeT ?? 0) > 0),
      f('boss_charge_for', unit(3), (c) => c.s.boss?.chargeT ?? 0),
      f('boss_charge_dx', sym(1), (c) => ((c.s.boss?.chargeT ?? 0) > 0 ? c.s.boss!.cdx : 0)),
      f('boss_charge_dz', sym(1), (c) => ((c.s.boss?.chargeT ?? 0) > 0 ? c.s.boss!.cdz : 0)),
      f('boss_move_for', unit(5), (c) => c.s.boss?.moveT ?? 0),
      // overtime
      f('overtime_offered', BOOL, (c) => c.st.overtime.offered),
      f('overtime_live', BOOL, (c) => c.st.overtime.live),
      f('overtime_over', BOOL, (c) => c.st.overtime.over),
      f('overtime_round', unit(24), (c) => c.st.overtime.round),
      f('overtime_round_left', unit(30), (c) => c.st.overtime.roundTimeLeft),
      f('overtime_multiplier', unit(25), (c) => c.st.overtime.multiplier),
      f('overtime_bonus', log(100000), (c) => c.st.overtime.bonus),
      f('overtime_drain_frac', unit(0.1), (c) => c.st.overtime.drain / c.maxHp),
      f('overtime_ring_closing', BOOL, (c) => c.st.overtime.ringClosing),
      f('overtime_ring_radius', unit(80), (c) => c.st.overtime.ringRadius),
      f('overtime_arena_radius', unit(80), (c) => c.st.overtime.arenaRadius),
      f('overtime_centre_dist_frac', unit(1.5), (c) => (c.st.overtime.ringRadius > 0 ? Math.hypot(c.px, c.pz) / c.st.overtime.ringRadius : 0)),
      ...multiHot<Ctx>('overtime_offering', offeringKeys, (key, c) => c.st.overtime.offerings.includes(key)),
      // capture, rift
      f('capture_active', BOOL, (c) => !!c.s.capture),
      f('capture_can_throw', BOOL, (c) => !!c.s.capture?.canThrow),
      f('capture_weak_for', unit(10), (c) => c.s.capture?.weakT ?? 0),
      f('capture_dx', sym(45), (c) => (c.s.capture && c.s.capture.index >= 0 ? c.s.capture.x - c.px : 0)),
      f('capture_dz', sym(45), (c) => (c.s.capture && c.s.capture.index >= 0 ? c.s.capture.z - c.pz : 0)),
      f('friend_ball', BOOL, (c) => c.s.friendBall),
      f('rift_inside', BOOL, (c) => c.s.rift.inside),
      f('rift_entrance', BOOL, (c) => !!c.s.rift.entrance),
      f('rift_entrance_dx', sym(200), (c) => (c.s.rift.entrance ? c.s.rift.entrance.x - c.px : 0)),
      f('rift_entrance_dz', sym(200), (c) => (c.s.rift.entrance ? c.s.rift.entrance.z - c.pz : 0)),
      // Max form, Incense, Hypno
      f('form_charges', unit(3), (c) => c.st.forms.charges),
      f('form_ready', BOOL, (c) => c.st.forms.ready),
      f('form_active_for', unit(30), (c) => c.st.forms.active),
      f('incense', unit(3), (c) => c.st.rift.incense),
      f('rift_can_open', BOOL, (c) => c.st.rift.canOpen),
      f('rift_can_fuse', BOOL, (c) => c.st.rift.canFuse),
      f('hypno_lesson_ready', BOOL, (c) => c.st.hypnoLessonReady),
      // the dojo trial being played
      f('dojo_active', BOOL, (c) => !!c.st.dojo),
      ...oneHot<Ctx>('dojo', DOJO_TRIALS, (c) => (c.st.dojo ? (DOJO_TRIALS as readonly string[]).indexOf(c.st.dojo.key) : -1)),
      f('dojo_belt', unit(3), (c) => c.st.dojo?.belt ?? 0),
      f('dojo_time_left', unit(90), (c) => c.st.dojo?.timeLeft ?? 0),
      f('dojo_progress_frac', unit(1), (c) => (c.st.dojo && c.st.dojo.goal > 0 ? c.st.dojo.progress / c.st.dojo.goal : 0)),
      f('dojo_goal', log(1000), (c) => c.st.dojo?.goal ?? 0),
      f('dojo_area', BOOL, (c) => !!c.st.dojo?.area),
      f('dojo_area_dx', sym(60), (c) => (c.st.dojo?.area ? c.st.dojo.area.x - c.px : 0)),
      f('dojo_area_dz', sym(60), (c) => (c.st.dojo?.area ? c.st.dojo.area.z - c.pz : 0)),
      f('dojo_area_radius', unit(12), (c) => c.st.dojo?.area?.radius ?? 0),
      f('dojo_grace_left', unit(6), (c) => c.st.dojo?.graceLeft ?? 0),
      f('dojo_hold_frac', unit(1), (c) => c.st.dojo?.holdFrac ?? 0),
      f('dojo_fighters', log(400), (c) => c.st.dojo?.fighters ?? 0),
      f('dojo_fighter', BOOL, (c) => !!c.st.dojo?.nearestFighter),
      f('dojo_fighter_dx', sym(45), (c) => (c.st.dojo?.nearestFighter ? c.st.dojo.nearestFighter.x - c.px : 0)),
      f('dojo_fighter_dz', sym(45), (c) => (c.st.dojo?.nearestFighter ? c.st.dojo.nearestFighter.z - c.pz : 0)),
      // phase, what the buttons would do, previous action
      ...oneHot<Ctx>('phase', ['play', 'choice', 'over'], (c) => ['play', 'choice', 'over'].indexOf(c.obs.phase)),
      ...PLAY_BUTTONS.filter((b) => b !== 'jump' && b !== 'dash').map((b) => f<Ctx>(`can_${b}`, BOOL, (c) => c.obs.mask.phase === 'play' && (c.obs.mask as PlayMask)[b])),
      ...oneHot<Ctx>('prev_move', MOVES, (c) => (c.prev ? c.prev.move : -1)),
      ...PLAY_BUTTONS.map((b) => f<Ctx>(`prev_${b}`, BOOL, (c) => !!c.prev?.[b])),
      // who is playing, beyond the bare species number (which is in the int segment `ids`)
      ...multiHot<Ctx>('type', typeKeys, (key, c) => c.types.includes(key)),
      ...oneHot<Ctx>('rank', rankKeys, (c) => (T.rank[c.k.memberOf.get(c.st.build.startSpecies)?.rank ?? ''] ?? 0) - 1),
    ];
    this.addFloat({ name: 'global', rows: 1, features: G, entities: self, note: 'player, progression, zone, guardian and seals, overtime, capture and rift, Max form, the dojo trial, phase, previous play action, type and rank of the Pokémon' });

    const statScale = (key: string): Scale => { const kind = k.statKind.get(key); return kind === 'mult' ? sym(2) : kind === 'pctpts' ? unit(1) : slog(500); };
    this.addFloat<Ctx>({
      name: 'stats', rows: 1, entities: self, note: 'the player\'s run stats (the game\'s own stat object). mult stats are encoded as (value − 1), percentage-point stats as the fraction, flat stats on a signed log scale',
      features: statKeys.map((key) => f<Ctx>(key, statScale(key), (c) => { const v = c.s.player.stats[key]; return typeof v !== 'number' ? 0 : k.statKind.get(key) === 'mult' ? v - 1 : v; })),
    });

    const E_X = 1, E_Z = 2, E_VX = 3, E_VZ = 4, E_HP = 5, E_MAXHP = 6, E_R = 7, E_DMG = 8, E_SPEED = 9, E_FLAGS = 10, E_ATK = 12;
    this.addFloat<Enemy>({
      name: 'enemies', rows: SIZES.enemies, entities: (c) => c.s.enemies.list, note: `the ${SIZES.enemies} nearest live enemies within 45 m, nearest first`,
      features: [
        f('present', BOOL, () => true),
        f('dx', sym(45), (e, c) => e[E_X] - c.px),
        f('dz', sym(45), (e, c) => e[E_Z] - c.pz),
        f('dist', unit(45), (e, c) => Math.hypot(e[E_X] - c.px, e[E_Z] - c.pz)),
        f('vx', sym(15), (e) => e[E_VX]),
        f('vz', sym(15), (e) => e[E_VZ]),
        f('approach_speed', sym(15), (e, c) => { const dx = e[E_X] - c.px, dz = e[E_Z] - c.pz, d = Math.hypot(dx, dz); return d > 1e-6 ? -(dx * e[E_VX] + dz * e[E_VZ]) / d : 0; }),
        f('radius', unit(5), (e) => e[E_R]),
        f('hp_frac', unit(1), (e) => (e[E_MAXHP] > 0 ? e[E_HP] / e[E_MAXHP] : 0)),
        f('max_hp', log(1e6), (e) => e[E_MAXHP]),
        f('contact_damage_frac', unit(1), (e, c) => e[E_DMG] / c.maxHp),
        f('speed', unit(20), (e) => e[E_SPEED]),
        f('attack_in', unit(5), (e) => (typeof e[E_ATK] === 'number' ? Math.max(0, e[E_ATK] as number) : 5)),
        f('is_boss', BOOL, (e, c) => e[0] === c.bossIndex),
        ...flagKeys.map((name) => { const bit = 1 << (T.enemyFlag[name] - 1); return f<Enemy>(`flag:${name}`, BOOL, (e) => (e[E_FLAGS] & bit) !== 0); }),
      ],
    });

    const densityNames: string[] = [];
    for (let d = 0; d < DENSITY_DIRECTIONS; d++) for (let b = 0; b <= DENSITY_BANDS.length; b++) densityNames.push(`dir${d}_band${b}`);
    this.addFloat<Ctx>({
      name: 'density', rows: 1, entities: self, note: `ALL live enemies as counts per direction (${DENSITY_DIRECTIONS}, direction d = angle d·22.5° from +x towards +z) and distance band ([0, ${DENSITY_BANDS[0]}) m, [${DENSITY_BANDS[0]}, ${DENSITY_BANDS[1]}) m, beyond)`,
      features: densityNames.map((name, i) => f<Ctx>(name, log(200), (c) => c.st.enemies.density[i])),
    });

    this.addFloat<ShotE>({
      name: 'shots', rows: SIZES.shots, entities: (c) => c.shots, note: `the ${SIZES.shots} nearest hostile projectiles within 30 m, nearest first`,
      features: [
        f('present', BOOL, () => true), f('dx', sym(30), (e) => e.dx), f('dz', sym(30), (e) => e.dz), f('dist', unit(30), (e) => e.d),
        f('vx', sym(40), (e) => e.vx), f('vz', sym(40), (e) => e.vz), f('radius', unit(3), (e) => e.r), f('damage_frac', unit(1), (e, c) => e.dmg / c.maxHp),
        f('closest_approach_in', unit(3), (e) => e.tca), f('closest_approach_dist', unit(10), (e) => e.miss),
      ],
    });

    this.addFloat<HazardE>({
      name: 'hazards', rows: SIZES.hazards, entities: (c) => c.hazards, note: `the ${SIZES.hazards} ground hazards whose edge is nearest: telegraphed strikes, boss and miniboss pools, expanding boss shock rings`,
      features: [
        f('present', BOOL, () => true), f('dx', sym(60), (e) => e.dx), f('dz', sym(60), (e) => e.dz), f('dist', unit(60), (e) => e.d),
        f('radius', unit(25), (e) => e.r), f('edge_dist', sym(30), (e) => e.d - e.r), f('inside', BOOL, (e) => e.d < e.r), f('time_left', unit(5), (e) => e.t),
        ...oneHot<HazardE>('kind', ['telegraph', 'boss', 'miniboss', 'wave'], (e) => e.kind),
        f('wave_max_radius', unit(40), (e) => e.max), f('wave_speed', unit(30), (e) => e.speed),
      ],
    });

    this.addFloat<Ctx>({
      name: 'xp', rows: 1, entities: self, note: 'experience lying within 20 m: total amount and its centre',
      features: [f('present', BOOL, (c) => c.s.pickups.xpN > 0), f('amount', log(500), (c) => c.s.pickups.xpN), f('dx', sym(20), (c) => (c.s.pickups.xpN > 0 ? c.s.pickups.xpX - c.px : 0)), f('dz', sym(20), (c) => (c.s.pickups.xpN > 0 ? c.s.pickups.xpZ - c.pz : 0))],
    });
    this.addFloat<PickupE>({
      name: 'pickups', rows: SIZES.pickups, entities: (c) => c.pickups, note: `the ${SIZES.pickups} nearest other pickups within 40 m; "kind" is the game's numeric pickup kind (no table of names exists)`,
      features: [
        f('present', BOOL, () => true), f('dx', sym(40), (e) => e.dx), f('dz', sym(40), (e) => e.dz), f('dist', unit(40), (e) => e.d),
        ...oneHot<PickupE>('kind', Array.from({ length: SIZES.pickupKinds }, (_, i) => String(i)), (e) => e.kind),
      ],
    });

    this.addFloat<Point>({
      name: 'points', rows: SIZES.points, entities: (c) => c.points, note: `the ${SIZES.points} nearest map points of the snapshot (the two nearest unused of each kind, every guardian altar and portal)`,
      features: [
        f('present', BOOL, () => true), f('dx', sym(200), (e, c) => e.x - c.px), f('dz', sym(200), (e, c) => e.z - c.pz), f('dist', log(400), (e) => e.d),
        f('in_reach', BOOL, (e) => e.d <= e.r), f('used', BOOL, (e) => e.used), f('cost', log(100000), (e, c) => pointCost(e, c)), f('affordable', BOOL, (e, c) => pointCost(e, c) <= c.gold),
        ...oneHot<Point>('kind', kindKeys, (e) => (T.interactable[e.kind] ?? 0) - 1),
      ],
    });

    const dirs = Array.from({ length: 16 }, (_, i) => i);
    this.addFloat<Ctx>({
      name: 'terrain', rows: 1, entities: self, note: 'around the player, per direction d (angle d·22.5° from +x towards +z): metres walkable, metres coverable when jumping, ground rise at 2.5 m and 5 m, blocked at 2.5 m; then the distance to each edge of the map',
      features: [
        ...dirs.map((d) => f<Ctx>(`free${d}`, unit(9), (c) => c.s.terrain.free?.[d] ?? 0)),
        ...dirs.map((d) => f<Ctx>(`hop${d}`, unit(9), (c) => c.s.terrain.hop?.[d] ?? 0)),
        ...dirs.map((d) => f<Ctx>(`rise_near${d}`, sym(5), (c) => c.s.terrain.ring[d] ?? 0)),
        ...dirs.map((d) => f<Ctx>(`rise_far${d}`, sym(8), (c) => c.s.terrain.ring2[d] ?? 0)),
        ...dirs.map((d) => f<Ctx>(`blocked${d}`, BOOL, (c) => !!c.s.terrain.blocked[d])),
        f('edge_east', unit(60), (c) => c.s.terrain.bounds - c.px), f('edge_west', unit(60), (c) => c.px + c.s.terrain.bounds),
        f('edge_south', unit(60), (c) => c.s.terrain.bounds - c.pz), f('edge_north', unit(60), (c) => c.pz + c.s.terrain.bounds),
      ],
    });

    this.addFloat<MoveState>({
      name: 'moves', rows: SIZES.moveSlots, entities: (c) => c.st.build.moves, note: 'one row per move slot (row = slot); an empty slot is all zeros',
      features: [
        f('present', BOOL, () => true), f('level', unit(10), (e) => e.level),
        f('cooldown_frac', unit(1), (e) => (e.cooldownTotal > 0 ? e.cooldownLeft / e.cooldownTotal : 0)), f('cooldown_left', unit(10), (e) => e.cooldownLeft), f('cooldown_total', unit(10), (e) => e.cooldownTotal),
        f('busy', BOOL, (e) => e.busy), f('fusion', BOOL, (e) => e.fusion), f('linked', BOOL, (e) => e.linked !== null),
        f('damage_share', unit(1), (e, c) => (c.st.counters.damageDealt > 0 ? e.damageDone / c.st.counters.damageDealt : 0)),
        f('physical', BOOL, (e) => e.cls === 'physical'),
        ...oneHot<MoveState>('type', typeKeys, (e) => (T.type[e.type] ?? 0) - 1),
      ],
    });
    this.addFloat<Ctx>({ name: 'vitamins', rows: 1, entities: self, note: 'level of every vitamin of the vocabulary (0 = not held)', features: k.keys('vitamin').map((key) => f<Ctx>(key, unit(12), (c) => c.vitamins.get(key) ?? 0)) });
    this.addFloat<Ctx>({ name: 'items', rows: 1, entities: self, note: 'stack count of every held item of the vocabulary', features: k.keys('item').map((key) => f<Ctx>(key, unit(10), (c) => c.items.get(key) ?? 0)) });
    this.addFloat<Ctx>({ name: 'relics', rows: 1, entities: self, note: 'which relics are held', features: k.keys('relic').map((key) => f<Ctx>(key, BOOL, (c) => c.relics.has(key))) });

    this.addFloat<Ctx>({
      name: 'choice', rows: 1, entities: self, note: 'the open dialog: its kind, how many options it has, and which untargeted extra actions it has and allows. All zero in the play phase',
      features: [
        ...oneHot<Ctx>('kind', decisionKeys, (c) => (c.decision ? T.decisionKind[c.decision.kind] - 1 : -1)),
        f('options', unit(SZ.optionSlots), (c) => c.decision?.options.length ?? 0),
        f('shop_restock_cost', log(100000), (c) => (c.decision?.kind === 'shop' ? Number(c.decision.context.rerollCost) || 0 : 0)),
        f('slot_spins_until_insured', unit(6), (c) => (c.decision?.kind === 'slots' ? Number(c.decision.context.spinsUntilInsured) || 0 : 0)),
        f('hypno_lesson_ready', BOOL, (c) => c.decision?.kind === 'forget' && c.decision.context.lessonReady === true),
        f('legendary', BOOL, (c) => c.decision?.kind === 'seals' && c.decision.context.legendary === true),
        ...UNTARGETED_EXTRAS.map((e) => f<Ctx>(`has:${e}`, BOOL, (c) => !!c.decision && e in c.decision.extras)),
        ...UNTARGETED_EXTRAS.map((e) => f<Ctx>(`allowed:${e}`, BOOL, (c) => c.choiceMask?.extras[e] === true)),
      ],
    });
    this.addFloat<OptionE>({
      name: 'options', rows: SZ.optionSlots, entities: (c) => c.options, note: 'one row per option of the open dialog (row = option index = choice index − 1); what the option is is in the int segments option_entity / option_secondary',
      features: [
        f('present', BOOL, () => true), f('allowed', BOOL, (e) => e.allowed),
        ...oneHot<OptionE>('offer', OFFER_KINDS, (e) => e.offerKind),
        f('has_rarity', BOOL, (e) => e.hasRarity), f('rarity', unit(4), (e) => e.rarity),
        f('current_level', unit(12), (e) => e.level), f('owned', unit(10), (e) => e.owned),
        f('has_price', BOOL, (e) => e.hasPrice), f('price', log(100000), (e) => e.price), f('affordable', BOOL, (e) => e.affordable),
        f('from_other_kit', BOOL, (e) => e.fromOtherKit), f('banish_allowed', BOOL, (e) => e.banish), f('banish_kit_allowed', BOOL, (e) => e.banishKit),
        f('stat_add', slog(100), (e) => e.add), f('stat_mul', sym(1), (e) => e.mul),
        f('seal_count', unit(3), (e) => e.seals.length), ...multiHot<OptionE>('seal', sealKeys, (key, e) => e.seals.includes(key)),
        ...k.upgradeStats.map((stat) => f<OptionE>(`upgrade:${stat}`, sym(2), (e) => e.ups[stat] ?? 0)),
        f('replaces_held', BOOL, (e) => e.replaces),
        f('has_refund', BOOL, (e) => e.hasRefund), f('refund', log(100000), (e) => e.refund),
        f('link', BOOL, (e) => e.link), ...oneHot<OptionE>('recipe', FUSION_KINDS, (e) => e.recipeKind),
        ...oneHot<OptionE>('trial', DOJO_TRIALS, (e) => e.trial), f('trial_belt', unit(3), (e) => e.trialBelt), f('trial_limit', unit(90), (e) => e.trialLimit), f('trial_goal', log(1000), (e) => e.trialGoal),
        f('lesson', BOOL, (e) => e.lesson),
      ],
    });

    // ------------------------------------------------------------ int segments
    const species = (id: number | null | undefined): number => (typeof id === 'number' ? T.species[String(id)] ?? this.note(`species:${id}`) : 0);
    this.addInt<Ctx>({
      name: 'ids', rows: 1, entities: self, note: 'categorical identity of the run',
      features: [
        { name: 'species', vocab: 'species', raw: (c) => species(c.st.build.species) },
        { name: 'start_species', vocab: 'species', raw: (c) => species(c.st.build.startSpecies) },
        { name: 'type1', vocab: 'type', raw: (c) => T.type[c.types[0] ?? ''] ?? 0 },
        { name: 'type2', vocab: 'type', raw: (c) => T.type[c.types[1] ?? ''] ?? 0 },
        { name: 'role', vocab: 'role', raw: (c) => T.role[c.k.memberOf.get(c.st.build.startSpecies)?.role ?? ''] ?? 0 },
        { name: 'rank', vocab: 'rank', raw: (c) => T.rank[c.k.memberOf.get(c.st.build.startSpecies)?.rank ?? ''] ?? 0 },
        { name: 'passive', vocab: 'passive', raw: (c) => T.passive[c.st.build.passive] ?? this.note(`passive:${c.st.build.passive}`) },
        { name: 'map', vocab: 'map', raw: (c) => T.map[c.s.biome] ?? this.note(`map:${c.s.biome}`) },
        { name: 'guardian_species', vocab: 'species', raw: (c) => (c.st.guardian.species ? species(c.st.guardian.species) : 0) },
        { name: 'boss_species', vocab: 'species', raw: (c) => (c.s.boss ? species(c.s.boss.species) : 0) },
        { name: 'decision_kind', vocab: 'decisionKind', raw: (c) => (c.decision ? T.decisionKind[c.decision.kind] : 0) },
      ],
    });
    this.addInt<MoveState>({
      name: 'move_slots', rows: SIZES.moveSlots, entities: (c) => c.st.build.moves, note: 'the move in each slot (0 = empty)',
      features: [
        { name: 'entity', vocab: 'entity', raw: (e) => this.entity('move', e.key) },
        { name: 'archetype', vocab: 'archetype', raw: (e) => T.archetype[e.arch] ?? this.note(`archetype:${e.arch}`) },
      ],
    });
    this.addInt<Enemy>({ name: 'enemy_species', rows: SIZES.enemies, entities: (c) => c.s.enemies.list, note: 'species of each row of the float segment "enemies"', features: [{ name: 'species', vocab: 'species', raw: (e) => species(e[11]) }] });
    this.addInt<OptionE>({
      name: 'option_entity', rows: SZ.optionSlots, entities: (c) => c.options, note: 'what each option of the dialog is: the move, vitamin, item, relic, overtime offering, species (evolution, party) or stat (blessing). "secondary" is the League member a new move comes from, or the relic a new relic would replace',
      features: [{ name: 'entity', vocab: 'entity', raw: (e) => e.entity }, { name: 'secondary', vocab: 'entity', raw: (e) => e.secondary }],
    });

    // ------------------------------------------------------------ the descriptor
    const segments: LayoutSegment[] = [
      ...this.floats.map(({ seg, offset }) => ({ name: seg.name, dtype: 'float32' as const, offset, shape: [seg.rows, seg.features.length] as [number, number], note: seg.note, features: seg.features.map((x: Feature<unknown>) => ({ name: x.name, scale: x.scale })) })),
      ...this.ints.map(({ seg, offset }) => ({ name: seg.name, dtype: 'int32' as const, offset, shape: [seg.rows, seg.features.length] as [number, number], note: seg.note, features: seg.features.map((x: IntFeature<unknown>) => ({ name: x.name, vocab: x.vocab })) })),
    ];
    const body = {
      version: OBS_ENCODING_VERSION,
      knowledge: { build: k.build, gameVersion: k.gameVersion, vocabVersion: k.vocabVersion, vocabSha256: k.vocabSha256 },
      sizes: SZ,
      conventions: {
        axes: 'positions are relative to the player and world-axis aligned: +x east, +z south (the action\'s move "n" is −z). Not rotated by the camera',
        directions: 'direction index d is the angle d·22.5° measured from +x towards +z',
        rows: 'entity segments hold the K nearest, nearest first; a row starts with "present" and an absent row is all zeros',
        scales: 'bool: 0/1 · unit: clip(v/max, 0, 1) · sym: clip(v/max, −1, 1) · log: clip(ln(1+max(v,0))/ln(1+max), 0, 1) · slog: sign(v)·clip(ln(1+|v|)/ln(1+max), 0, 1); non-finite values become 0',
        ints: 'vocabulary indexes of data/game-knowledge/<build>/vocab.json; 0 is none / unknown',
        fractions: 'damage fractions are relative to the player\'s maximum HP',
      },
      floatSize: this.floatSize, intSize: this.intSize, segments,
    };
    this.layout = { ...body, hash: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
  }

  private addFloat<E>(seg: FloatSegment<E>): void {
    const names = new Set<string>();
    for (const x of seg.features) { if (names.has(x.name)) throw new EncodingError(`segment "${seg.name}" declares the feature "${x.name}" twice`); names.add(x.name); }
    this.floats.push({ seg, offset: this.floatSize, scales: seg.features.map((x) => x.scale), raws: seg.features.map((x) => x.raw) });
    this.floatSize += seg.rows * seg.features.length;
  }
  private addInt<E>(seg: IntSegment<E>): void {
    this.ints.push({ seg, offset: this.intSize });
    this.intSize += seg.rows * seg.features.length;
  }

  /** Count a key the vocabulary does not have (allowed to be unknown) and encode it as 0. */
  private note(key: string): number { this.unknown.set(key, (this.unknown.get(key) ?? 0) + 1); return 0; }

  /** Index in the shared entity table. Moves, vitamins, items, relics and offerings must be known: a miss means the vocabulary is not this build's. */
  private entity(domain: 'move' | 'vitamin' | 'item' | 'relic' | 'offering' | 'species' | 'stat', key: string | number | null | undefined): number {
    if (key === null || key === undefined || key === '') return 0;
    const i = this.k.tables.entity[`${domain}:${key}`];
    if (i !== undefined) return i;
    if (domain === 'species' || domain === 'stat') return this.note(`${domain}:${key}`);
    throw new EncodingError(`"${domain}:${key}" is not in the vocabulary of game build ${this.k.build} (vocab ${this.k.vocabSha256.slice(0, 12)}…). The game-knowledge export does not match the running game.`);
  }

  private options(c: Ctx): OptionE[] {
    const d = c.decision, mask = c.choiceMask;
    if (!d || !mask) return [];
    if (d.options.length > this.sizes.optionSlots) throw new EncodingError(`the "${d.kind}" dialog has ${d.options.length} options; the encoding has ${this.sizes.optionSlots} option slots (nothing is truncated)`);
    const banish = Array.isArray(mask.extras.banish) ? mask.extras.banish : [];
    const banishKit = Array.isArray(mask.extras.banishKit) ? mask.extras.banishKit : [];
    const st = c.st;
    return d.options.map((o, i): OptionE => {
      const x = o.data as Record<string, any>;
      const e: OptionE = {
        allowed: !!mask.options[i], offerKind: -1, hasRarity: false, rarity: 0, level: 0, owned: 0, hasPrice: false, price: 0, affordable: false,
        fromOtherKit: false, banish: !!banish[i], banishKit: !!banishKit[i], add: 0, mul: 0, seals: [], ups: {}, replaces: false,
        hasRefund: false, refund: 0, link: false, recipeKind: -1, trial: -1, trialBelt: 0, trialLimit: 0, trialGoal: 0, lesson: false, entity: 0, secondary: 0,
      };
      if (typeof x.refund === 'number') { e.hasRefund = true; e.refund = x.refund; }
      if (typeof x.rarity === 'number') { e.hasRarity = true; e.rarity = x.rarity; }
      if (typeof x.owned === 'number') e.owned = x.owned;
      switch (d.kind) {
        case 'levelup': case 'lesson': {
          e.offerKind = (OFFER_KINDS as readonly string[]).indexOf(String(x.kind));
          if (e.offerKind < 0) throw new EncodingError(`${d.kind} offer of unknown kind "${x.kind}" (known: ${OFFER_KINDS.join(', ')})`);
          if (x.kind === 'newMove') {
            const key = this.k.moveKeyById.get(x.id);
            if (!key) throw new EncodingError(`level-up offer of move id ${x.id}, which the game-knowledge export does not have`);
            e.entity = this.entity('move', key);
            if (x.from !== null && x.from !== undefined) { e.fromOtherKit = true; e.secondary = this.entity('species', x.from); }
          } else if (x.kind === 'upMove') {
            const held = st.build.moves[x.slot];
            if (!held) throw new EncodingError(`level-up offer to upgrade move slot ${x.slot}, which is empty`);
            e.entity = this.entity('move', held.key);
            e.level = held.level;
            for (const u of Array.isArray(x.ups) ? x.ups : []) if (u && typeof u.key === 'string' && typeof u.value === 'number') e.ups[u.key] = u.value;
          } else {
            e.entity = this.entity('vitamin', x.vit);
            e.level = c.vitamins.get(String(x.vit)) ?? 0;
          }
          break;
        }
        case 'evolution': e.entity = this.entity('species', x.species); break;
        case 'item': case 'itemChoice': case 'ditto': case 'shopSell': e.entity = this.entity('item', x.key); break;
        case 'slots':
          if (typeof x.price === 'number') { e.hasPrice = true; e.price = x.price; e.affordable = c.gold >= x.price; }
          break;
        case 'dojo':
          e.trial = (DOJO_TRIALS as readonly string[]).indexOf(String(x.key));
          if (e.trial < 0) throw new EncodingError(`dojo trial of unknown kind "${x.key}" (known: ${DOJO_TRIALS.join(', ')})`);
          e.trialBelt = Number(x.belt) || 0; e.trialLimit = Number(x.limit) || 0; e.trialGoal = Number(x.goal) || 0;
          break;
        case 'forget':
          if (x.what === 'move') { e.entity = this.entity('move', x.key); e.level = Number(x.level) || 0; }
          else if (x.what === 'vitamin') { e.entity = this.entity('vitamin', x.key); e.level = Number(x.level) || 0; }
          else e.lesson = true;
          break;
        case 'fusion':
          e.entity = this.entity('move', x.moveA); e.secondary = this.entity('move', x.moveB);
          e.link = x.how === 'link';
          e.recipeKind = (FUSION_KINDS as readonly string[]).indexOf(String(x.recipeKind));
          break;
        case 'shop':
          e.entity = this.entity('item', x.key);
          if (typeof x.price === 'number') { e.hasPrice = true; e.price = x.price; e.affordable = c.gold >= x.price; }
          break;
        case 'blessing': case 'dojoPrize': {
          const mod = Array.isArray(x.mods) ? x.mods[0] : null;
          if (mod && typeof mod.stat === 'string') {
            e.entity = this.entity('stat', mod.stat);
            if (typeof mod.add === 'number') e.add = mod.add;
            if (typeof mod.mul === 'number') e.mul = mod.mul - 1;
          }
          break;
        }
        case 'seals': e.seals = Array.isArray(x.seals) ? x.seals.map(String) : []; break;
        case 'overtimeOffer': e.entity = this.entity('offering', x.key); break;
        case 'party': e.entity = this.entity('species', x.species); break;
        case 'shinySwap': e.entity = this.entity('species', x.incoming); break;
        case 'relic':
          e.entity = this.entity('relic', x.key);
          if (x.replaces !== null && x.replaces !== undefined) { e.replaces = true; e.secondary = this.entity('relic', x.replaces); }
          break;
        default: break; // sanctuaryPath, leaveSanctuary, overtimeStart, trade: the position and the dialog kind say what the option is
      }
      return e;
    });
  }

  private context(obs: Observation, previous: PlayAction | null | undefined): Ctx {
    const s = obs.snapshot, st = obs.state, p = s.player;
    if (!st) throw new EncodingError('the observation has no "state": it was not made by this version of the environment');
    const px = p.x, pz = p.z;
    const shots: ShotE[] = s.shots.map((q) => {
      const dx = q[0] - px, dz = q[1] - pz, vx = q[2], vz = q[3], v2 = vx * vx + vz * vz;
      const tca = v2 > 1e-9 ? Math.max(0, -(dx * vx + dz * vz) / v2) : 0;
      return { dx, dz, d: Math.hypot(dx, dz), vx, vz, r: q[4], dmg: q[5], tca, miss: Math.hypot(dx + vx * tca, dz + vz * tca) };
    }).sort((a, b) => a.d - b.d);
    const hazards: HazardE[] = [];
    for (const h of s.hazards) { const dx = h.x - px, dz = h.z - pz; hazards.push({ dx, dz, d: Math.hypot(dx, dz), r: h.r, t: h.t, kind: h.kind === 'telegraph' ? 0 : h.kind.startsWith('mini') ? 2 : 1, max: 0, speed: 0 }); }
    for (const w of s.waves) { const dx = w.x - px, dz = w.z - pz; hazards.push({ dx, dz, d: Math.hypot(dx, dz), r: w.r, t: 0, kind: 3, max: w.max, speed: w.speed }); }
    hazards.sort((a, b) => Math.abs(a.d - a.r) - Math.abs(b.d - b.r));
    const pickups: PickupE[] = s.pickups.other.map((q) => {
      const dx = q[1] - px, dz = q[2] - pz;
      if (!(q[0] >= 0 && q[0] < SIZES.pickupKinds)) this.note(`pickupKind:${q[0]}`);
      return { kind: q[0], dx, dz, d: Math.hypot(dx, dz) };
    }).sort((a, b) => a.d - b.d);
    const points = [...s.points].sort((a, b) => a.d - b.d);
    for (const q of points) if (!this.k.tables.interactable[q.kind]) this.note(`interactable:${q.kind}`);
    const prev: PrevAction | null = previous
      ? { move: typeof previous.move === 'number' ? previous.move : MOVES.indexOf(previous.move), ...(Object.fromEntries(PLAY_BUTTONS.map((b) => [b, !!previous[b]])) as Record<(typeof PLAY_BUTTONS)[number], boolean>) }
      : null;
    const c: Ctx = {
      obs, s, st, k: this.k, prev, px, pz, maxHp: Math.max(1, p.maxHp), gold: st.economy.gold, bossIndex: s.boss ? s.boss.i : -1,
      shots, hazards, pickups, points,
      vitamins: new Map(st.build.vitamins.map((v) => [v.key, v.level])), items: new Map(st.build.items.map((v) => [v.key, v.count])), relics: new Set(st.build.relics),
      decision: obs.decision, choiceMask: obs.mask.phase === 'choice' ? (obs.mask as ChoiceMask) : null, options: [],
      types: this.k.typesOf.get(st.build.species) ?? this.k.typesOf.get(st.build.startSpecies) ?? [],
    };
    // Keys the build vectors cannot represent are an export / game mismatch, not something to drop.
    for (const key of c.vitamins.keys()) this.entity('vitamin', key);
    for (const key of c.items.keys()) this.entity('item', key);
    for (const key of c.relics) this.entity('relic', key);
    if (c.decision && !this.k.tables.decisionKind[c.decision.kind]) throw new EncodingError(`dialog of unknown kind "${c.decision.kind}"`);
    c.options = this.options(c);
    return c;
  }

  /**
   * Encode one observation. `previous` is the last play action of the episode (null before the first one); dialogs in
   * between do not clear it, because the game keeps the movement keys held across a dialog. The environment passes
   * it when `encode: true` is set.
   */
  encode(observation: Observation, previous?: PlayAction | null): Encoded {
    const c = this.context(observation, previous);
    const float = new Float32Array(this.floatSize), int = new Int32Array(this.intSize);
    for (const { seg, offset, scales, raws } of this.floats) {
      const list = seg.entities(c), width = raws.length, rows = Math.min(seg.rows, list.length);
      for (let r = 0; r < rows; r++) {
        const e = list[r];
        if (e === null || e === undefined) continue;
        const o = offset + r * width;
        for (let i = 0; i < width; i++) float[o + i] = applyScale(scales[i], raws[i](e, c));
      }
    }
    for (const { seg, offset } of this.ints) {
      const list = seg.entities(c), width = seg.features.length, rows = Math.min(seg.rows, list.length);
      for (let r = 0; r < rows; r++) {
        const e = list[r];
        if (e === null || e === undefined) continue;
        for (let i = 0; i < width; i++) int[offset + r * width + i] = seg.features[i].raw(e, c) | 0;
      }
    }
    return { float, int };
  }

  /** The named slice of an encoded buffer, as rows of numbers (for tests and debugging; Python does this with the descriptor). */
  slice(encoded: Encoded, name: string): number[][] {
    const seg = this.layout.segments.find((x) => x.name === name);
    if (!seg) throw new EncodingError(`the layout has no segment "${name}"`);
    const buf = seg.dtype === 'float32' ? encoded.float : encoded.int;
    const [rows, width] = seg.shape;
    return Array.from({ length: rows }, (_, r) => Array.from(buf.subarray(seg.offset + r * width, seg.offset + (r + 1) * width)));
  }

  /** One named feature of a single-row segment (or of row `row`). */
  value(encoded: Encoded, segment: string, feature: string, row = 0): number {
    const seg = this.layout.segments.find((x) => x.name === segment);
    if (!seg) throw new EncodingError(`the layout has no segment "${segment}"`);
    const i = seg.features.findIndex((x) => x.name === feature);
    if (i < 0) throw new EncodingError(`segment "${segment}" has no feature "${feature}"`);
    return (seg.dtype === 'float32' ? encoded.float : encoded.int)[seg.offset + row * seg.shape[1] + i];
  }
}
