import type { Tuning } from '../../bot/brain/tuning.ts';
import { DIRECTION_V1 } from './values.ts';
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

export const PLANS: Record<string, Plan> = { 'plan-1': PLAN_V1, 'plan-2': PLAN_V2 };

/**
 * The plan with single keys replaced (nested `tuning` merged). The key `base` names the plan to start from
 * ('plan-1', 'plan-2'; default: the newest). Unknown keys are an error: a typo must not play silently.
 */
export function planWith(over: Record<string, unknown> | undefined, from?: Plan): Plan {
  const name = over?.base;
  if (name !== undefined && !(String(name) in PLANS)) throw new Error(`heuristic2 has no plan "${String(name)}" (it has: ${Object.keys(PLANS).join(', ')})`);
  const base = from ?? (name !== undefined ? PLANS[String(name)] : PLAN_V2);
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
