import type { Tuning } from '../../bot/brain/tuning.ts';
import { DIRECTION_V1, DIRECTION_V2 } from './values.ts';
import type { Direction } from './values.ts';

/**
 * The run plan of the second heuristic: every threshold it plays by, in one versioned object. A batch stores the plan
 * it was played with (`--policy-options={"plan":{…}}` overrides single keys); changing a default means a new `version`.
 *
 * What it is built on (docs/phase-1-report.md): on tier 2 the first heuristic left zone 1 after about five minutes and
 * fainted in zone 2 with 3,400 KOs; the same play that simply stays in zone 1 reaches its final swarm with 12,000 to
 * 29,000. Leaderboard runs stay about half an hour in every zone. So: farm a zone, beat its guardian late, stay for
 * the final swarm, and leave through the portal when the HP bar says so. Measured on seeds 1 to 30 (tier 2, archive
 * `balanced`): leaving 50 s into the swarm brings 16 of 30 runs to Overtime, against 11 when staying until HP is low.
 */
export interface Plan {
  version: string;
  /** Guardian: woken at this player level by zone (1-based, the last value repeats), or after this zone time by zone, whatever the level. */
  wakeLevel: number[]; wakeAfterSec: number[];
  /** A cleared zone is left when HP falls under `leaveHp`, or at this zone time (the collapse begins at 1080 s, in zone 3 at 1200 s). */
  leaveHp: number; leaveAtSec: number[];
  /** Challenge Seals: all three offered are taken from this player level on, by zone (the sanctuary is zone 4); below it none. */
  sealLevel: number[];
  /** Level-ups: an offer scoring under `rerollBelow` is refreshed, under `skipBelow` skipped, while refreshes and skips are left. */
  rerollBelow: number; skipBelow: number;
  /** A new vitamin is taken only when one level of it is worth at least this; an offered one worth less than `banishBelow` is banished. */
  vitaminMin: number; banishBelow: number;
  /** Items: sold instead of taken when worth less than this; bought in the shop when worth at least `shopMinWorth`. */
  itemSellBelow: number; shopMinWorth: number;
  /**
   * Looting. The brain only loots while at most two enemies are within 15 m, which on tier 2 is never; the plan sends
   * it instead: to the nearest unused point of these kinds within `lootRange` metres (a paid Poké Ball only when the
   * Pokédollars cover it), while HP is at least `lootHp` and the final swarm has not begun.
   */
  lootKinds: string[]; lootRange: number; lootHp: number;
  /** The shop is walked to (same conditions) when at least this many Pokédollars are held. */
  shopGold: number;
  /** Enemy-number effects (White Flute, Cursed Incense, elite spawns) are counted as worth something from this HP share on. */
  riskHp: number;
  /** Overtime: offerings in order of preference (others are declined); cash below this HP share, or after this round. */
  offerings: string[]; cashHp: number; cashAfterRound: number;
  /**
   * Overtime: also cash when the tide takes at least this share of max HP per second (1 = off). plan-1 has 0.06; plan-2
   * has it off: with builds that kill at the spawn ceiling the berries they drop out-heal a far larger tide, and the
   * rule cashed in round 10 or 11 runs that go to round 13 to 16 without it (mean score 1.59 against 1.95 million, no
   * bonus lost in either). What ends those runs is the HP bar (`cashHp`).
   */
  cashDrain: number;
  /** The brain's tuning (src/bot/brain/tuning.ts), where the plan differs from its defaults. */
  tuning: Partial<Tuning>;
  /** What stats are worth (values.ts). */
  direction: Direction;

  // ---- added with plan-2 (docs/phase-1b-report.md); plan-1 holds the values that switch each of them off ----
  /**
   * The last metres to a target. The brain's own walk weighs every enemy on the way and keeps off the map edge, and
   * guardian altars stand 15 m from the edge: measured on tier 2, it circled 7 to 17 m from the altar for 100 to 300 s.
   * Within this distance of a target of the plan (altar, Poké Ball, service) the walk is ordered through the horde.
   * 0 = never.
   */
  forceWithin: number;
  /**
   * From this HP share on the whole walk to a target is ordered through the horde, not only its last metres. Above 1 =
   * never. Measured: with the last 30 m only, a run sat in a map corner 140 m from the altar for 500 s (seed 19) because
   * an ordinary walk weighs the horde and the edge more than the target; with the whole walk ordered it scored 996,000.
   */
  forceHp: number;
  /** HP share needed to set out for the guardian's altar under the plan's own order (plan-1: the brain's rule alone). */
  wakeHp: number;
  /**
   * Errands: map points the plan walks to and uses, nearest first, each under its own condition (policy.ts, `errandFor`).
   * Empty = plan-1's looting (`lootKinds` and the shop).
   */
  errands: string[];
  /** An errand that is not done after this many seconds is given up for the zone. */
  errandTimeout: number;
  /** During a final swarm only free Poké Balls within this distance are fetched (the guardian's prizes lie by the portal). */
  swarmLootRange: number;
  /** Slot machine: walked to when the Pokédollars cover this many spins; spun while one spin costs at most `slotShare` of the Pokédollars held. */
  slotMinSpins: number; slotShare: number;
  /** Shop: a new stock is paid for while it costs at most this share of the Pokédollars held (0 = never)… */
  restockShare: number;
  /** …and the shop is visited again in the same zone once the Pokédollars are this many times what was left on leaving it (0 = once per zone). */
  shopRevisit: number;
  /** Curses (cursed altar, cursed Poké Ball, Gengar's altar) are taken while HP is at least `riskHp` and the estimated spawn multiplier is under this. */
  spawnTarget: number;
  /** Challenge Seals put on, in order of preference, at most `sealMax` per fight by zone (the sanctuary is zone 4), from `sealLevel` on. */
  sealsTake: string[]; sealMax: number[];
  /** A move offered from another League member's kit is taken into a free slot when it is of this class ('' = never: banished). */
  borrowClass: string;
  /**
   * Staying in a cleared zone after `leaveAtSec`: as long as the lowest HP share of the last `stayWindow` seconds is at
   * least `stayHp`, until `leaveBySec` at the latest (the collapse begins at 1080 s). `stayHp` above 1 = leave at
   * `leaveAtSec`; 0 = this rule never ends the stay. plan-2 has it at 0: in zones 2 and 3 an ordinary hit takes 20 to 33 %
   * of max HP before any swarm, so a rule on the HP bar left at the swarm's first second and those runs stayed weak
   * (median 1.30 million with it at 0.8 and `leaveHit` 0.15, 2.08 million without both; 30 of 30 in Overtime either way).
   */
  stayHp: number; stayWindow: number; leaveBySec: number[];
  /** During the final swarm of a cleared zone the fight is kept within this many metres of the portal, so the way out is short (0 = anywhere). */
  stayLeash: number;
  /**
   * A cleared zone is also left once a single hit took at least this share of max HP (above 1 = off). The swarm's hits
   * grow by the minute up to the game's cap of 40 % of max HP a hit; measured on tier 2, every run lost in a swarm
   * (15 of 30) fell to two or three capped hits within a second, 200 to 270 s into it. A hit of this size says the
   * cap is near while there is still HP to reach the portal.
   */
  leaveHit: number;
  /**
   * …and once the horde's hits, read off the enemies and shots in view (policy.ts, `hordeHit`), would take this share
   * of max HP after armor (0 = off). In a final swarm enemy damage doubles about every 45 s (measured, seed 16: 0.10 of
   * max HP at its start, 0.56 after 120 s, 4.8 after 256 s) and the build that kills everything on arrival takes no hit
   * at all until one lands that is several times its max HP: the HP bar gives no warning, the horde's damage does.
   */
  leaveThreat: number;
  /** Overtime is cashed at this size of the horde's hits (0 = off). */
  cashThreat: number;
  /**
   * The same two limits while a revive is held (0 = no limit). Leaving at half of max HP a hit got 10 of 10 runs into
   * Overtime but with a third of the score (seed 2: 529,000 against 3.6 million): the deep swarm is where the experience
   * is. A held revive makes the first deadly hit survivable (3 s of invulnerability), and `reviveLeaves` then leaves.
   */
  leaveThreatRevive: number; cashThreatRevive: number;
  /** A Max Revive spent in a cleared zone or in Overtime (the count the game keeps): leave, or cash, at once, while its 3 s of invulnerability last. */
  reviveLeaves: boolean;
  /** Overtime: metres from the portal the fight is kept within. */
  leash: number;
  /** Overtime: also cash when the HP lost to hits and the tide in the last `cashWindow` seconds is at least this share of max HP (above 1 = off). */
  cashLoss: number; cashWindow: number;
  // ---- added with plan-3 ----
  /**
   * Rhydon's totem answers three times per zone (each roar: guardian +30 % HP and +12 % damage, one more Great Ball at
   * its fall), and only while the guardian sleeps. With this on, a wake that is due waits until the zone's totem is
   * used up: the walk there is ordered through the horde at any distance, and given up for the zone after
   * `roarTimeout` seconds. Measured with plan-2 on tier 2, seeds 1 to 10: three roars in 28 of 30 zones and none in
   * two, where the totem was never the nearest errand within `lootRange` before the wake (once passed at 19 m).
   */
  roarsFirst: boolean; roarTimeout: number;
  // ---- added with plan-4 ----
  /**
   * Bill's machine (fuse two moves into one, or link them) is used only while this item is held, and only on two moves
   * that are both at the level cap ('' = the machine is left alone). The owner: moves go to level 10 with a TM Case,
   * "and we should realistically never fuse or join until we have this item, as this maximises our damage even more".
   * Read in the game: the machine takes any two moves at level 8, a fusion inherits the upgrades its parents had, and
   * the TM Case raises the cap of a move from 8 to 10 and of a fusion from ★5 to ★6. With the item set, `bill` is also
   * an errand: the machine is walked to once the item is held and two moves are at the cap.
   */
  fuseNeeds: string;
  /**
   * Vitamins by phase (plan-7; both empty = by worth, as before). While the run farms, a new vitamin is taken only
   * from `vitaminsFarm`, in that order of preference: experience, elites, Pokédollars and luck, which make the build.
   * From zone second `swapAtSec` of zone `swapZone` on, the wanted ones are `vitaminsFinal` (damage and max HP for
   * the sanctuary and Overtime): Hypno is visited to forget the others (he pays for them), and the level-ups of the
   * rest of that zone's final swarm fill the freed slots. The owner, 2026-11-27: "they change their vitamins before
   * the final stage so that they have max hp and damage possible"; "I would spend most of the run, before zone 4,
   * using Calcium/Protein, Nugget, Super Lure, Exp Candy, and Cursed Incense", with the luck vitamin first in place of
   * Calcium. A vitamin of the later phase is never banished in the earlier one.
   */
  vitaminsFarm: string[]; vitaminsFinal: string[]; swapZone: number; swapAtSec: number;
  /**
   * A vitamin of the plan that makes the horde bigger or stronger (its stat is one of the direction's `risk` stats:
   * Cursed Incense, Super Lure) comes after any move upgrade until this level (0 = first, like the others).
   * Chosen on the development seeds 2000001 to 2000100, which are tuning seeds for plan-7 since: without it 3 of
   * those 100 runs fainted in zone 1 after 3.5 to 4.5 minutes, at level 52 to 59 with both vitamins at level 10, 12
   * to 14 items and no move upgraded, because every early level had gone into vitamins.
   */
  vitaminsRiskLevel: number;
  // ---- added with plan-8 ----
  /**
   * The kit the build ends with (kit.ts; both empty = the species' own four moves, as before). `kitFuse`: the two
   * moves Bill's machine fuses. `kit`: the other moves, in order of preference; those the machine can link are linked
   * two by two, so that the fusion, two pairs and one move that cannot be linked fill the four slots. A level-up takes
   * a new move only from these, the species' other moves are banished when they are offered and forgotten at Hypno
   * once the slots are full, Hypno's lesson is taken for a move of the kit, and the machine is an errand whenever two
   * moves are ready for it. The owner, 2026-11-28, of the leaderboard Mewtwo's kit (Trick Room, Future Sight, Perish
   * Song, Mist, Encore and the fusion of Psycho Boost and Psystrike): "Yes, aim for that for mewtwo but we have to
   * consider boost moves like Encore since they boost the damage of other moves", and several uses of the machine,
   * not one.
   */
  kit: string[]; kitFuse: string[];

  // ---- added with plan-9 ----
  /**
   * The HP bar (`leaveHp`) and a spent Max Revive (`reviveLeaves`) make the run leave a cleared zone only once the
   * zone's final swarm has begun (the game starts it at the zone's second 600, whether the guardian has fallen or
   * not). Without this (plans 1 to 8) they count from the moment the guardian falls: a run whose HP bar the guardian
   * itself had emptied took the portal that second, ten minutes of the zone, its final swarm, its machine and its
   * Hypno unused (seed 28 under plan-8: zone 2 left after 107 s with 2 HP of 386, the last four hits the guardian's).
   * 9 zones of 90 under plan-8 on seeds 1 to 30 and 6 of 90 under plan-7 were left before their second 300.
   */
  leaveInSwarm: boolean;
}

export const PLAN_V1: Plan = {
  version: 'plan-1',
  wakeLevel: [999, 999, 999], wakeAfterSec: [420, 360, 360],
  leaveHp: 0.65, leaveAtSec: [650, 650, 650],
  sealLevel: [999, 999, 999, 999],
  rerollBelow: 62, skipBelow: 30,
  vitaminMin: 4, banishBelow: 2,
  itemSellBelow: 1, shopMinWorth: 8,
  lootKinds: ['freechest', 'chest', 'berry'], lootRange: 120, lootHp: 0.55, shopGold: 400,
  riskHp: 0.8,
  offerings: ['manantial', 'dique', 'rompeolas'], cashHp: 0.75, cashAfterRound: 24, cashDrain: 0.06,
  tuning: { lootRange: 90, visitRange: 60, lootCalm: 5, hordeSize: 140, shopGold: 60 },
  direction: DIRECTION_V1,
  forceWithin: 0, forceHp: 2, wakeHp: 2,
  errands: [], errandTimeout: 40, swarmLootRange: 0,
  slotMinSpins: 0, slotShare: 0, restockShare: 0, shopRevisit: 0,
  spawnTarget: 0,
  sealsTake: ['fury', 'swift', 'heal', 'horde', 'clock', 'echo'], sealMax: [3, 3, 3, 3],
  borrowClass: '',
  stayHp: 2, stayWindow: 20, leaveBySec: [650, 650, 650], stayLeash: 0, leaveHit: 2, leaveThreat: 0, cashThreat: 0, leaveThreatRevive: 0, cashThreatRevive: 0, reviveLeaves: false,
  leash: 10,
  cashLoss: 2, cashWindow: 5,
  roarsFirst: false, roarTimeout: 120,
  fuseNeeds: '',
  vitaminsFarm: [], vitaminsFinal: [], swapZone: 3, swapAtSec: 720, vitaminsRiskLevel: 0,
  kit: [], kitFuse: [],
  leaveInSwarm: false,
};

/**
 * plan-2 (docs/phase-1b-report.md). What changed against plan-1 and why, each measured on tier 2, seeds 1 to 30:
 * the walk to a target is made through the horde; errands replace looting (slot machines, the shop with restocks and
 * repeat visits, Ditto, cages, Snorlax, Rhydon's roars, cursed Poké Balls and altars within a spawn target); seals by
 * rule; a cleared zone's final swarm is fought next to the portal and left when HP is low, a Max Revive is spent, or
 * (without one) a hit of the horde would take all of max HP; Overtime is cashed on the HP bar, not on the tide.
 */
export const PLAN_V2: Plan = {
  ...PLAN_V1,
  version: 'plan-2',
  forceWithin: 30, forceHp: 0.55, wakeHp: 0.7,
  errands: ['freechest', 'chest', 'berry', 'slots', 'meowth', 'ditto', 'cage', 'snorlax', 'magnet', 'rhydon', 'cursedchest', 'cursed', 'greed'],
  errandTimeout: 40, swarmLootRange: 30,
  slotMinSpins: 3, slotShare: 0.1, restockShare: 0.1, shopRevisit: 2,
  spawnTarget: 3,
  sealsTake: ['clock', 'swift', 'echo', 'fury', 'horde'], sealMax: [3, 3, 3, 3], sealLevel: [0, 0, 0, 0],
  borrowClass: 'special',
  stayHp: 0, stayWindow: 20, leaveBySec: [1060, 1060, 1060], stayLeash: 15, leaveHit: 2, leaveThreat: 1, cashThreat: 0, leaveThreatRevive: 0, cashThreatRevive: 0, reviveLeaves: true,
  leash: 10,
  cashDrain: 1, cashLoss: 0.5, cashWindow: 4,
};

/**
 * plan-3: plan-2, and the guardian is not woken before Rhydon has roared three times (the owner: "things like Rhydon
 * can be activated 3 times and should be activated 3 times").
 */
export const PLAN_V3: Plan = { ...PLAN_V2, version: 'plan-3', roarsFirst: true };

/**
 * plan-4 (a candidate, NOT the default: not measured yet): plan-3, and Bill's machine fuses two moves at level 10 once
 * a TM Case is held.
 */
export const PLAN_V4: Plan = { ...PLAN_V3, version: 'plan-4', fuseNeeds: 'tm-case', errands: [...PLAN_V3.errands, 'bill'] };

/**
 * plan-5 (measured, NOT the default yet: the manager's copy and its start models are of plan-3): plan-3 with the
 * second build direction (values.ts, `luck-experience-1`). Tier 2, the same account preset, seeds 1 to 30: median
 * 5.73 million against 2.13, mean 5.52 against 2.44, p90 8.27 against 5.24, best 10.48 against 7.07. On 100 seeds
 * nothing was chosen on (2000001 to 2000100): median 4.82 million against 1.47, p90 8.29 against 4.16, better on 75
 * (docs/phase-3-report.md part 4).
 */
export const PLAN_V5: Plan = { ...PLAN_V3, version: 'plan-5', direction: DIRECTION_V2 };

/**
 * plan-6 (NOT the default): plan-5 for the item archive `stack-2` (values.ts), with a build that kills at the Overtime
 * ceiling for longer: Overtime is cashed when the HP bar falls under 30 % (not 75 %, and not on half a bar lost in 4 s),
 * and a cleared zone is left under 40 % HP (not 65 %). Each measured on seeds 1 to 30 with `stack-2`, against plan-5
 * there: the cash rule ×1.13 (better on 29 of 30, no bonus lost), the leave rule ×1.10. Together, on 100 seeds
 * nothing was chosen on: median 7.43 million against plan-5's 4.82 and plan-3's 1.47, p90 9.22, best 10.90; 86 runs
 * of 100 over 5 million (docs/phase-3-report.md part 5).
 */
export const PLAN_V6: Plan = { ...PLAN_V5, version: 'plan-6', cashHp: 0.3, cashLoss: 2, leaveHp: 0.4 };

/**
 * plan-7 (NOT the default): plan-6 with the owner's vitamins by phase (above), on the archive `stack-2`. On 100 seeds
 * nothing was chosen on (3000001 to 3000100), both plans by the same code: median 11.37 million against plan-6's
 * 7.84, p90 12.45 against 9.51, best 12.98 against 11.35; better on 88 of 100 (batches 86 and 87). The five farm
 * vitamins without the change at Hypno scored the same as plan-6. `vitaminsRiskLevel` was chosen on seeds 2000001 to
 * 2000100: plan-7's figures there are tuned (docs/phase-3-report.md part 6).
 */
export const PLAN_V7: Plan = {
  ...PLAN_V6, version: 'plan-7',
  vitaminsFarm: ['exp-candy', 'cursed', 'super-lure', 'nugget', 'star-piece-v'],
  vitaminsFinal: ['calcium', 'hp-up', 'ether', 'stardust', 'pp-up'],
  errands: [...PLAN_V6.errands, 'hypno'], vitaminsRiskLevel: 120,
};

/**
 * plan-8 (NOT the default): plan-7 with the leaderboard Mewtwo's kit (above), for the account's
 * build plan `kit-1` (kit.ts: the four moves that can be linked are the account's favourites, and the moves of the
 * pool that are not of the kit are switched off as far as the game allows). `errands` gains Bill's machine.
 * Measured (docs/phase-3-report.md, part 7): seeds 1-30 median 13.85 million against plan-7's 11.40, best 14.54
 * against 12.95; on the 100 check seeds (3000001 to 3000100), played once, median 13.80 against 11.37, p90 14.47
 * against 12.45, best 15.04 against 12.98, better on 87 of 100. 85 of those 100 runs end with the whole kit.
 */
export const PLAN_V8: Plan = {
  ...PLAN_V7, version: 'plan-8',
  kitFuse: ['psystrike', 'psycho-boost'], kit: ['future-sight', 'perish-song', 'trick-room', 'mist', 'encore'],
  errands: [...PLAN_V7.errands, 'bill'],
};

/**
 * plan-9 (NOT the default): plan-8, and a cleared zone is left on the HP bar or a spent revive only once its final
 * swarm has begun (`leaveInSwarm`). Measured (docs/phase-3-report.md, part 8): on the 100 check seeds, played once,
 * 90 runs are plan-8's own, 10 are higher and none lower; median 13.88 million against 13.80, mean 13.53 against
 * 12.89, p90 14.56 against 14.47, best 15.04 for both. Seeds 1-30: median 14.07 against 13.85, mean 13.63 against 11.88.
 */
export const PLAN_V9: Plan = { ...PLAN_V8, version: 'plan-9', leaveInSwarm: true };

export const PLANS: Record<string, Plan> = { 'plan-1': PLAN_V1, 'plan-2': PLAN_V2, 'plan-3': PLAN_V3, 'plan-4': PLAN_V4, 'plan-5': PLAN_V5, 'plan-6': PLAN_V6, 'plan-7': PLAN_V7, 'plan-8': PLAN_V8, 'plan-9': PLAN_V9 };

/**
 * The plan with single keys replaced (nested `tuning` merged). The key `base` names the plan to start from
 * ('plan-1' … 'plan-9'; default: plan-3, the plan the manager copies). Unknown keys are an error: a typo must not play silently.
 */
export function planWith(over: Record<string, unknown> | undefined, from?: Plan): Plan {
  const name = over?.base;
  if (name !== undefined && !(String(name) in PLANS)) throw new Error(`heuristic2 has no plan "${String(name)}" (it has: ${Object.keys(PLANS).join(', ')})`);
  const base = from ?? (name !== undefined ? PLANS[String(name)] : PLAN_V3);
  const out: Plan = { ...base, tuning: { ...base.tuning } };
  for (const [k, v] of Object.entries(base)) if (Array.isArray(v)) (out as unknown as Record<string, unknown>)[k] = [...v];
  for (const [k, v] of Object.entries(over ?? {})) {
    if (k === 'base') continue;
    if (!(k in base)) throw new Error(`heuristic2 plan has no key "${k}" (it has: ${Object.keys(base).join(', ')})`);
    if (k === 'tuning') Object.assign(out.tuning, v as object);
    else (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}
