/**
 * Shrine Overtime in numbers: what a round is worth, what the tide takes, what heals, and how long a build lasts.
 *
 * Every constant is the game's own (build mwsewi0r, 0.10.26: the table `ot` and its helper functions in the bundle's
 * assets chunk, the player's `heal` / `leech` / `hurt` / `drain`, `drops` and `payEmptyLevels`). The test
 * test/model/overtime.test.ts reads the table out of the mirrored bundle and fails if a constant here differs.
 * Checked in play with scripts/probes/overtime-ceiling-probe.ts (docs/phase-0-report.md).
 *
 * Pure functions, no game object: usable by a heuristic, by a report and by a test alike.
 */

/** The game's Overtime table (`ot` of the assets chunk). */
export const OT = {
  roundSecs: 30, maxRounds: 24, late: 480, lateHp: 12, lateDmg: 4, mult: [1.25, 1.5, 2, 2.5, 3, 4], sealMult: 0.1, maxSeals: 12, bodies: 350,
  rate0: 30, rateGrow: 0.8, rateMax: 150, amountMax: 3, weightSecs: 45, weightMax: 7, eliteEvery: 20, elites0: 6, eliteGrow: 2, hpPerMin: 4, dmgPerMin: 2,
  ringFrom: 90, ringTo: 240, ring: 0.4, drainFrom: 120, drain0: 0.0025, drainGrow: 2, healEnd: 330, healFloor: 0.5, lateDrain: 2,
  offerEvery: 2, dique: 0.7, rompeolas: 0.6, pleamar: 0.5, pleamarDrain: 1.25, corrienteHp: 0.75, corrienteDmg: 1.5,
} as const;

/** Player-side constants read in the player and combat code. */
export const PLAYER = {
  /** Lifesteal, Shell Bell and move drain share a budget: this share of max HP per second, storing at most `leechStore`. */
  leechPerSec: 0.05, leechStore: 0.08,
  /** A lifesteal proc heals 1 + this share of max HP; Shell Bell this share of the damage of a hit, per bell. */
  lifestealProcHp: 0.005, shellBell: 0.008,
  /** A healing berry: this share of max HP. Dropped by a kill with chance `berryChance` x power-up stat x the kill's weight. */
  berryHeal: 0.25, berryChance: 0.006,
  /** A Training level (a level-up with nothing left to offer) heals this share of max HP. */
  trainingHeal: 0.2,
  /** A hit of an ordinary enemy never takes more than this share of max HP (elites, Alphas, totems: `hitCapBig`); then nothing lands for `iframes` s. */
  hitCap: 0.4, hitCapBig: 0.25, iframes: 0.45, iframesDodge: 0.25,
  /** Armor: damage x (1 - armor / (armor + armorHalf)). Evasion is capped. Overheal is capped at this share of max HP and decays. */
  armorHalf: 45, evasionMax: 0.6, overhealMax: 1, overhealDecayPerSec: 0.01,
  /** A shield refills at this share of its maximum per second, after `shieldDelay` s without a hit. */
  shieldRegenPerSec: 0.25, shieldDelay: 3,
} as const;

export interface Offerings { dique?: boolean; manantial?: boolean; rompeolas?: boolean; cebo?: boolean; corriente?: boolean; /** round index (0-based) Pleamar was taken in */ pleamarRound?: number | null }

/** Multiplier of round `round` (0-based) on its KOs. */
export function roundMultiplier(round: number, sealsKept = 0, pleamarRound: number | null = null): number {
  const i = Math.max(0, Math.floor(round)), m = OT.mult;
  return (i < m.length ? m[i] : m[m.length - 1] + (i - m.length + 1)) + OT.sealMult * Math.max(0, Math.min(OT.maxSeals, Math.floor(sealsKept))) + (pleamarRound != null && pleamarRound <= i ? OT.pleamar : 0);
}
/** Horde bodies per second before the spawn multiplier, `secs` into Overtime. */
export const spawnRate = (secs: number): number => Math.min(OT.rateMax, OT.rate0 + OT.rateGrow * Math.max(0, secs));
/** KOs one horde body is worth when it falls (fractions are carried over). */
export const killWeight = (secs: number): number => Math.min(OT.weightMax, 1 + Math.max(0, secs) / OT.weightSecs);
/** The spawn multiplier: difficulty x enemy amount (stats) x the tier's amount, between 1 and 3. */
export const spawnMultiplier = (difficulty: number, enemyAmount: number, tierAmount: number): number => Math.max(1, Math.min(OT.amountMax, difficulty * enemyAmount * tierAmount));
/** HP and damage of the horde relative to Overtime's first moment. */
export const hordeHpGrowth = (secs: number): number => OT.hpPerMin ** (secs / 60) * OT.lateHp ** (Math.max(0, secs - OT.late) / 60);
export const hordeDamageGrowth = (secs: number): number => OT.dmgPerMin ** (secs / 60) * OT.lateDmg ** (Math.max(0, secs - OT.late) / 60);
/** The expected max HP the tide is measured in: by the run clock at the moment Overtime starts (`maxHp` of the game's expectation table). */
export const referenceHp = (runTimeAtStart: number): number => 400 + 60 * Math.max(0, runTimeAtStart) / 60;
/** Share of the reference HP the tide takes per second. Overheal and shield absorb it before HP; armor, evasion and i-frames do not apply. */
export function drainFraction(secs: number, o: Offerings = {}): number {
  if (secs < OT.drainFrom) return 0;
  return OT.drain0 * OT.drainGrow ** ((secs - OT.drainFrom) / 60) * OT.lateDrain ** (Math.max(0, secs - OT.late) / 60) * (o.dique ? OT.dique : 1) * (o.pleamarRound != null && o.pleamarRound * OT.roundSecs <= secs ? OT.pleamarDrain : 1);
}
/** Factor on every heal (and on shield refill) during Overtime. It reaches its floor at 225 s, not at `healEnd`. */
export function healFactor(secs: number, o: Offerings = {}): number {
  const k = Math.max(OT.healFloor, Math.min(1, 1 - (secs - OT.drainFrom) / (OT.healEnd - OT.drainFrom)));
  return o.manantial ? Math.min(1, k * 2) : k;
}
/** KOs of a round if every horde body falls as it arrives (elites not counted). */
export function ceilingRoundKos(round: number, multiplier: number): number {
  let k = 0;
  for (let s = round * OT.roundSecs; s < (round + 1) * OT.roundSecs; s++) k += spawnRate(s + 0.5) * killWeight(s + 0.5) * multiplier;
  return k;
}
/** Score of Overtime alone (KOs + bonus) when cashed at the end of round `rounds`, given the KOs of each round. */
export function overtimeScore(roundKos: number[], sealsKept = 0, pleamarRound: number | null = null): { kos: number; bonus: number; score: number } {
  let kos = 0, bonus = 0;
  roundKos.forEach((k, i) => { kos += k; bonus += k * (roundMultiplier(i, sealsKept, pleamarRound) - 1); });
  bonus = Math.floor(bonus);
  return { kos, bonus, score: kos + bonus };
}

export interface SurvivalBuild {
  maxHp: number; hp?: number; overheal?: number; shield?: number;
  /** stats */ healing: number; regen: number; regenShareOfMaxHp?: number; powerup?: number; berryMul?: number;
  /** HP per second the build would leech if nothing capped it (lifesteal procs, Shell Bell, move drain) */ leechDemand?: number;
  /** the run clock when Overtime starts */ runTimeAtStart: number;
}
export interface SurvivalInputs {
  /** KOs per second at `secs` (weighted, as the game counts them) and the share of dropped berries that is picked up */ kosPerSec: (secs: number) => number; berriesCollected?: number;
  /** Training levels per second, and HP per second taken by hits after armor, evasion and the per-hit cap */ trainingLevelsPerSec?: (secs: number) => number; hitDamagePerSec?: (secs: number) => number;
  offerings?: Offerings;
}
/** What heals and what is taken, per second, `secs` into Overtime. */
export function balance(b: SurvivalBuild, inp: SurvivalInputs, secs: number): { heal: number; drain: number; parts: Record<string, number> } {
  const o = inp.offerings ?? {}, f = b.healing * healFactor(secs, o);
  const parts = {
    berries: PLAYER.berryChance * (b.powerup ?? 1) * inp.kosPerSec(secs) * (inp.berriesCollected ?? 1) * PLAYER.berryHeal * b.maxHp * (b.berryMul ?? 1) * f,
    leech: Math.min(b.leechDemand ?? 0, PLAYER.leechPerSec * b.maxHp) * f,
    regen: (b.regen + (b.regenShareOfMaxHp ?? 0) * b.maxHp) * f,
    training: (inp.trainingLevelsPerSec?.(secs) ?? 0) * PLAYER.trainingHeal * b.maxHp * f,
  };
  const drain = drainFraction(secs, o) * referenceHp(b.runTimeAtStart) + (inp.hitDamagePerSec?.(secs) ?? 0);
  return { heal: parts.berries + parts.leech + parts.regen + parts.training, drain, parts };
}
/** Seconds into Overtime at which HP reaches zero (the 24 rounds if it never does), stepping one second at a time. Heals above max HP are lost. */
export function survivalSeconds(b: SurvivalBuild, inp: SurvivalInputs): number {
  let hp = b.hp ?? b.maxHp, buffer = (b.overheal ?? 0) + (b.shield ?? 0);
  const end = OT.maxRounds * OT.roundSecs;
  for (let s = 0; s < end; s++) {
    const { heal, drain } = balance(b, inp, s);
    let take = drain;
    const fromBuffer = Math.min(buffer, take); buffer -= fromBuffer; take -= fromBuffer;
    hp = Math.min(b.maxHp, hp + heal) - take;
    if (hp <= 0) return s;
  }
  return end;
}
