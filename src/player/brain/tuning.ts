/**
 * Every number the strategy uses, in one place. Override any of them in config.json under bot.tuning.
 */
export interface Tuning {
  // ---- survival ----
  /** Enemies closer than this (plus their own radius) are treated as about to hit. */
  dangerRadius: number;
  /** Weight of enemy proximity when scoring a direction. */
  wDanger: number;
  /** Weight of how crowded the sectors around a direction are (escaping a surround). */
  wCrowd: number;
  /** Penalty for stepping into a ground hazard, a shot's path or a boss charge lane. */
  wHazard: number;
  /** Penalty for walking into a cliff, water or the edge of the arena. */
  wTerrain: number;
  /** Distance from the map edge inside which the bot starts steering back towards open ground. */
  edgeMargin: number;
  /** How hard it steers away from the edge (grows with the square of how deep into the margin it is). */
  wEdge: number;
  /** Weight of the current goal's pull. */
  wGoal: number;
  /** Keeps the heading steady between ticks. */
  wInertia: number;
  /** Below this fraction of HP the bot stops pursuing goals and only looks for safety and healing. */
  lowHp: number;
  /** Enemies within 3.5 m that trigger a dash out. */
  dashSurround: number;

  // ---- fighting distance ----
  /** Extra metres added to the kit's natural range when kiting. */
  kiteSlack: number;
  /** Fraction of HP above which the bot goes after priority targets. */
  huntHp: number;

  // ---- ultimate ----
  /** Enemies within 8 m that count as "surrounded" for the ultimate. */
  ultCrowd: number;
  /** Enemies bunched within 8 m (and most of the pack with them) that make the ultimate worth firing. */
  ultHerd: number;
  /** Pressure (see brain/movement.ts) above which a charged ultimate is used even without a boss. */
  ultPressure: number;
  /** Keep the ultimate for the guardian when it is about to be woken (seconds of zone time before the wake rule). */
  ultHoldSec: number;

  // ---- zone progression ----
  /** Player level at which the zone guardian is woken, by zone (1-based; the last value repeats). */
  wakeLevel: number[];
  /** Zone time after which the guardian is woken whatever the level. */
  wakeAfterSec: number;
  /** HP fraction required to set out for the guardian's altar, and to wake the guardian once there. */
  wakeHp: number;
  /** HP fraction below which a walk to the altar that is under way is broken off (lower than `wakeHp`: a scratch on the way does not turn the bot around). */
  wakeKeepHp: number;
  /**
   * The walk to an altar that is still far (over 14 m): the share of the threats (enemies, crowding, shots, ground
   * hazards) that still counts when choosing a heading, and the weight of the goal's pull (an ordinary goal has 1 and
   * about 0.9, an order carried out through everything 0 and 4).
   */
  wakeThreat: number; wakePull: number;
  /** Ultimate charge (0–1) required before waking the guardian on level. */
  wakeUlt: number;
  /** Sanctuary (zone 4): HP fraction at which the legendary is woken… */
  sanctuaryHp: number;
  /** …or seconds in the sanctuary after which it is woken anyway. */
  sanctuaryRestSec: number;

  // ---- loot ----
  /** Walk to a chest/altar only when it is within this distance. */
  lootRange: number;
  /** Pressure below which looting is allowed. */
  lootCalm: number;
  /** Living enemies in the arena above which the bot stops looting and thins the horde instead. */
  hordeSize: number;
  /**
   * Map points with a service (a dialog) that are walked to and used once per zone while things are calm:
   * `meowth` is the shop, `ditto` copies an item, `fossil` and `porygon` offer trades.
   */
  visitKinds: string[];
  /** …when they are within this distance. */
  visitRange: number;
  /** Pokédollars needed before the shop is worth the walk. */
  shopGold: number;

  // ---- choices ----
  /** A level-up offer scoring below this is rerolled when a reroll is left. */
  rerollBelow: number;
  /** Below this fraction of HP survivability offers jump the queue. */
  surviveHp: number;
  /** ...and also when one hit from the hardest enemy nearby takes more than this fraction of the HP bar. */
  surviveHit: number;
}

export const DEFAULT_TUNING: Tuning = {
  dangerRadius: 3.4,
  wDanger: 1.6,
  wCrowd: 0.55,
  wHazard: 6.0,
  wTerrain: 3.0,
  edgeMargin: 32,
  wEdge: 2.4,
  wGoal: 0.9,
  wInertia: 0.18,
  lowHp: 0.42,
  dashSurround: 4,

  kiteSlack: 0.2,
  huntHp: 0.6,

  ultCrowd: 12,
  ultHerd: 8,
  ultPressure: 9,
  ultHoldSec: 25,

  wakeLevel: [16, 32, 44],
  wakeAfterSec: 420,
  wakeHp: 0.7,
  wakeKeepHp: 0.55,
  wakeThreat: 0.35,
  wakePull: 2.5,
  wakeUlt: 0.6,
  sanctuaryHp: 0.9,
  sanctuaryRestSec: 45,

  lootRange: 28,
  lootCalm: 2.5,
  hordeSize: 45,
  visitKinds: ['meowth', 'ditto', 'fossil', 'porygon'],
  visitRange: 28,
  shopGold: 150,

  rerollBelow: 38,
  surviveHp: 0.5,
  surviveHit: 0.22,
};

/**
 * Daily mutation: an arena-wide modifier. The run reports its effect as multipliers on enemies; the bot reads those
 * rather than the mutation's name, so an unknown mutation still adapts: faster enemies → kite wider and dash sooner,
 * harder hits → keep more distance and heal earlier, bigger crowds → ultimate sooner.
 */
export function adaptTuning(base: Tuning, diff: { enemyHp: number; enemyDamage: number; enemySpeed: number; enemyAmount: number }): Tuning {
  const t = { ...base, wakeLevel: [...base.wakeLevel], visitKinds: [...base.visitKinds] };
  const sp = Math.max(0.5, diff.enemySpeed || 1), dm = Math.max(0.5, diff.enemyDamage || 1), am = Math.max(0.5, diff.enemyAmount || 1), hp = Math.max(0.5, diff.enemyHp || 1);
  if (sp > 1.05) { t.dangerRadius *= Math.min(1.6, sp); t.kiteSlack += (sp - 1) * 4; t.dashSurround = Math.max(2, t.dashSurround - 1); }
  if (dm > 1.05) { t.dangerRadius *= Math.min(1.4, 1 + (dm - 1) * 0.5); t.lowHp = Math.min(0.6, t.lowHp + (dm - 1) * 0.15); t.surviveHp = Math.min(0.75, t.surviveHp + (dm - 1) * 0.15); }
  if (am > 1.05) { t.ultCrowd = Math.round(t.ultCrowd * Math.min(1.5, am)); t.wCrowd *= 1.2; }
  if (hp > 1.05) t.wakeLevel = t.wakeLevel.map((l) => l + Math.round((hp - 1) * 4));
  return t;
}

export function resolveTuning(overrides: Record<string, unknown> | undefined): Tuning {
  const t: any = { ...DEFAULT_TUNING, wakeLevel: [...DEFAULT_TUNING.wakeLevel], visitKinds: [...DEFAULT_TUNING.visitKinds] };
  for (const [k, v] of Object.entries(overrides ?? {})) if (k in t && (typeof v === 'number' || Array.isArray(v))) t[k] = v;
  return t as Tuning;
}
