import type { Tuning } from './brain/tuning.ts';
import { DIRECTION } from './values.ts';
import type { Direction } from './values.ts';

/**
 * The plan: every threshold and every list the player plays by, in one versioned object. A batch stores the plan it
 * was played with (`--policy-options={"plan":{…}}` replaces single keys for one batch); changing a value for good
 * means a new `version`, measured against the one before (docs/meta.md).
 *
 * The shape of a run under it: in a zone, do the errands, wake the guardian, stay through the final swarm next to the
 * portal and leave before the collapse; in the sanctuary beat the legendary; in Overtime fight by the portal and cash
 * before the tide wins. What the build becomes is in `builds` (per Pokémon) and the vitamins by phase.
 */
export interface Plan {
  version: string;

  // ---- a zone ----
  /**
   * The guardian is woken once the zone clock reaches `wakeAfterSec` (by zone, the last value repeats) or the player's
   * level reaches `wakeLevel`. With today's builds the level is passed in zone 1's final swarm, so the guardians of
   * zones 2 and 3 are woken on arrival and those zones are all errands and final swarm.
   */
  wakeLevel: number[]; wakeAfterSec: number[];
  /** HP share needed to set out for the guardian's altar. */
  wakeHp: number;
  /** Rhydon's totem roars three times before the guardian is woken; the walk there is given up after this many seconds. */
  roarTimeout: number;
  /** Challenge Seals put on, in order of preference, at most `sealMax` per fight by zone (the sanctuary is zone 4). */
  sealsTake: string[]; sealMax: number[];
  /**
   * Errands: map points the plan walks to and uses, nearest first, each under its own condition (policy.ts,
   * `errandFor`), within `lootRange` metres and while HP is at least `lootHp`. One that is not done after
   * `errandTimeout` seconds is given up for the zone. During a final swarm only free Poké Balls within
   * `swarmLootRange` are fetched.
   */
  errands: string[]; lootRange: number; lootHp: number; errandTimeout: number; swarmLootRange: number;
  /**
   * The last metres to a target are walked through the horde within `forceWithin` metres of it, and the whole walk
   * from this HP share on: an ordinary walk weighs the horde and the map edge more than the target and never arrives.
   */
  forceWithin: number; forceHp: number;
  /** The shop is walked to with at least this many Pokédollars, and again once they are `shopRevisit` times what was left on leaving it. */
  shopGold: number; shopRevisit: number;
  /** Slot machine: walked to when the Pokédollars cover this many spins; spun while one spin costs at most `slotShare` of the Pokédollars held. */
  slotMinSpins: number; slotShare: number;
  /** Curses (cursed altar, cursed Poké Ball, Gengar's altar) are taken while HP is at least `riskHp` and the estimated spawn multiplier is under `spawnTarget`. */
  riskHp: number; spawnTarget: number;
  /**
   * Leaving a cleared zone. Only once its final swarm has begun (the game starts it at the zone's second 600): when
   * HP falls under `leaveHp`, when a Max Revive is spent, or when, with no revive held, a hit of the horde would take
   * `leaveThreat` of max HP (policy.ts, `hordeHit`). And at `leaveBySec` whatever the HP (the collapse begins at
   * 1080 s, in zone 3 at 1200 s). The swarm is fought within `stayLeash` metres of the portal.
   */
  leaveHp: number; leaveThreat: number; leaveBySec: number[]; stayLeash: number;

  // ---- Overtime ----
  /** Offerings in order of preference (others are declined). */
  offerings: string[];
  /**
   * Cashed when HP falls under `cashHp`, after round `cashAfterRound`, when the tide takes `cashDrain` of max HP a
   * second, or when a Max Revive is spent. The fight is kept within `leash` metres of the portal.
   */
  cashHp: number; cashAfterRound: number; cashDrain: number; leash: number;

  // ---- dialogs ----
  /** Level-ups: an offer scoring under `rerollBelow` is refreshed, under `skipBelow` skipped, while refreshes and skips are left. */
  rerollBelow: number; skipBelow: number;
  /** Items: sold instead of taken when worth less than this; bought in the shop when worth at least `shopMinWorth`; a new stock is paid for while it costs at most `restockShare` of the Pokédollars held. */
  itemSellBelow: number; shopMinWorth: number; restockShare: number;

  // ---- the build ----
  /** What stats are worth (values.ts). */
  direction: Direction;
  /**
   * Vitamins by phase. While the run farms, a new vitamin is taken only from `vitaminsFarm`, in that order. From zone
   * second `swapAtSec` of zone `swapZone` on, the wanted ones are `vitaminsFinal`: Hypno is visited to forget the
   * others (he pays for them), and the level-ups of the rest of that zone's final swarm fill the freed slots. A
   * vitamin that makes the horde bigger or stronger comes after any move upgrade until level `vitaminsRiskLevel`.
   * (Both lists empty: by worth, with `vitaminMin` the least one level must be worth and `banishBelow` what is banished.)
   */
  vitaminsFarm: string[]; vitaminsFinal: string[]; swapZone: number; swapAtSec: number; vitaminsRiskLevel: number;
  vitaminMin: number; banishBelow: number;
  /**
   * The moves a Pokémon's build ends with, by Pokédex number (kit.ts). A Pokémon without an entry plays its own four
   * moves, and borrows a move of another League member into a free slot when it is of class `borrowClass`.
   */
  builds: Record<number, SpeciesBuild>;
  borrowClass: string;

  /** The brain's tuning (brain/tuning.ts), where the plan differs from its defaults. */
  tuning: Partial<Tuning>;
}

/**
 * One Pokémon's build. `fuse`: the two moves Bill's machine fuses (empty: none). `kit`: the other moves, in order of
 * preference; those the machine can link are linked two by two, so that a fusion, two pairs and one move that cannot
 * be linked fill four slots. `favourites`: the moves the account's build plan marks as favourites (at most four, all
 * of `kit`); the rest of the pool is switched off as far as the game allows.
 */
export interface SpeciesBuild { fuse: string[]; kit: string[]; favourites: string[] }

/**
 * plan-9. Measured on tier 2, forest, Mewtwo, with the item archive `stack-2` and the build plan `kit-1`
 * (docs/results.md has the figures and the plans before it).
 */
export const PLAN: Plan = {
  version: 'plan-9',
  wakeLevel: [999, 999, 999], wakeAfterSec: [420, 360, 360], wakeHp: 0.7, roarTimeout: 120,
  sealsTake: ['clock', 'swift', 'echo', 'fury', 'horde'], sealMax: [3, 3, 3, 3],
  errands: ['freechest', 'chest', 'berry', 'slots', 'meowth', 'ditto', 'cage', 'snorlax', 'magnet', 'rhydon', 'cursedchest', 'cursed', 'greed', 'hypno', 'bill'],
  lootRange: 120, lootHp: 0.55, errandTimeout: 40, swarmLootRange: 30,
  forceWithin: 30, forceHp: 0.55,
  shopGold: 400, shopRevisit: 2, slotMinSpins: 3, slotShare: 0.1,
  riskHp: 0.8, spawnTarget: 3,
  leaveHp: 0.4, leaveThreat: 1, leaveBySec: [1060, 1060, 1060], stayLeash: 15,
  offerings: ['manantial', 'dique', 'rompeolas'], cashHp: 0.3, cashAfterRound: 24, cashDrain: 1, leash: 10,
  rerollBelow: 62, skipBelow: 30,
  itemSellBelow: 1, shopMinWorth: 8, restockShare: 0.1,
  direction: DIRECTION,
  vitaminsFarm: ['exp-candy', 'cursed', 'super-lure', 'nugget', 'star-piece-v'],
  vitaminsFinal: ['calcium', 'hp-up', 'ether', 'stardust', 'pp-up'],
  swapZone: 3, swapAtSec: 720, vitaminsRiskLevel: 120,
  vitaminMin: 4, banishBelow: 2,
  builds: {
    // Mewtwo: the leaderboard build. The owner, 2026-11-28: "aim for that for mewtwo but we have to consider boost
    // moves like Encore since they boost the damage of other moves".
    150: { fuse: ['psystrike', 'psycho-boost'], kit: ['future-sight', 'perish-song', 'trick-room', 'mist', 'encore'], favourites: ['future-sight', 'perish-song', 'trick-room', 'mist'] },
  },
  borrowClass: 'special',
  tuning: { lootRange: 90, visitRange: 60, lootCalm: 5, hordeSize: 140, shopGold: 60 },
};

export const PLANS: Record<string, Plan> = { [PLAN.version]: PLAN };

/**
 * The plan with single keys replaced (nested `tuning` merged). Unknown keys are an error: a typo must not play
 * silently. The key `base` names the plan to start from (there is one).
 */
export function planWith(over: Record<string, unknown> | undefined, from?: Plan): Plan {
  const name = over?.base;
  if (name !== undefined && !(String(name) in PLANS)) throw new Error(`the player has no plan "${String(name)}" (it has: ${Object.keys(PLANS).join(', ')})`);
  const base = from ?? (name !== undefined ? PLANS[String(name)] : PLAN);
  const out: Plan = { ...base, tuning: { ...base.tuning } };
  for (const [k, v] of Object.entries(base)) if (Array.isArray(v)) (out as unknown as Record<string, unknown>)[k] = [...v];
  for (const [k, v] of Object.entries(over ?? {})) {
    if (k === 'base') continue;
    if (!(k in base)) throw new Error(`the plan has no key "${k}" (it has: ${Object.keys(base).join(', ')})`);
    if (k === 'tuning') Object.assign(out.tuning, v as object);
    else (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}
