import type { Nav, Snapshot } from '../../bot/snapshot.ts';
import { buildFor } from '../../bot/brain/builds.ts';
import type { Build } from '../../bot/brain/builds.ts';
import { decide, markVisited, newMemory } from '../../bot/brain/movement.ts';
import type { Directive, Memory } from '../../bot/brain/movement.ts';
import { DEFAULT_TUNING } from '../../bot/brain/tuning.ts';
import type { Tuning } from '../../bot/brain/tuning.ts';
import type { Policy } from '../../environment/policies.ts';
import type { Action, Observation, PlayMask } from '../../environment/types.ts';
import type { RunState } from '../../observations/state.ts';
import { toPlayAction } from '../heuristic/adapter.ts';
import { choose2 } from './chooser.ts';
import { EF, E_DMG, E_FLAGS } from '../../bot/snapshot.ts';
import type { Point } from '../../bot/snapshot.ts';
import { planWith } from './plan.ts';
import type { Plan } from './plan.ts';
import { kitOf, loadValuationKnowledge } from './values.ts';
import type { Kit, Knowledge } from './values.ts';

/**
 * The second heuristic (phase 1 of the heuristic + RL refactor). Movement and fighting are the first heuristic's brain
 * (src/bot/brain, unchanged); what differs is the run plan (plan.ts) and the answers to dialogs (chooser.ts):
 *
 *   zone        farm and loot; wake the guardian late (plan.wakeAfterSec); once it has fallen keep the portal closed and
 *               stay for the final swarm, until HP falls under plan.leaveHp or the zone clock reaches plan.leaveAtSec
 *   sanctuary   as the first heuristic: legendary, a rest, Overtime
 *   Overtime    fight near the portal; cash under plan.cashHp or after plan.cashAfterRound
 *
 * It sees the observation, the read-only route planner and the game's knowledge export; it is deterministic.
 */
export const HEURISTIC2_VERSION = '2';
const SERVICE_DIALOGS = new Set(['shop', 'ditto', 'trade', 'dojo', 'slots', 'forget', 'fusion']);
const BUILD = 'mwsewi0r';

export interface Heuristic2Options {
  planRoute?: (x: number, z: number) => Nav | null;
  /** Keys of the plan to replace (plan.ts). */
  plan?: Record<string, unknown>;
  onEvent?: (e: { t: number; what: string; detail: string }) => void;
}
export interface Lifecycle2 {
  cashing: boolean; restSince: number | null;
  /** zones whose portal the policy has decided to take */
  leaving: Set<number>;
  /** plan-2. The zone the next three fields belong to; errands given up in it; the errand under way; Pokédollars held on leaving its shop. */
  zone: number; skip: Set<string>; errand: { key: string; since: number } | null; shopLeft: number | null;
  /** HP of the last seconds, oldest first, with the game's counter of damage taken where it is known. */
  hpLog: { t: number; hp: number; max: number; taken?: number }[];
  /** Gengar curses drawn at slot machines in this run. */
  gengar: number;
  /** Revives held when last seen; run time a revive was last spent; run time the current zone was cleared and Overtime began. */
  revives: number | null; revivedAt: number; clearedAt: number | null; otAt: number | null;
  /** plan-3. Run time the walk to this zone's Rhydon totem was first ordered ahead of the wake. */
  roarSince: number | null;
}
export const newLife = (): Lifecycle2 => ({ cashing: false, restSince: null, leaving: new Set(), zone: 0, skip: new Set(), errand: null, shopLeft: null, hpLog: [], gengar: 0, revives: null, revivedAt: -Infinity, clearedAt: null, otAt: null, roarSince: null });

/** The limit on the horde's hits that applies now: the plan's own, or the one for a held revive. */
const limitOf = (plain: number, withRevive: number, life: Lifecycle2): number => ((life.revives ?? 0) > 0 ? withRevive : plain);

/**
 * What one hit of the horde would take, as a share of max HP: the upper quartile of the damage of the enemies in view
 * (guardians and map objects apart) or the hardest shot in the air, whichever is more, after armor (the game's
 * armor / (armor + 45)). The game caps a contact hit at 40 % of max HP, but not every source of damage.
 */
export function hordeHit(s: Snapshot): number {
  const armor = Math.max(0, Number(s.player.stats?.armor) || 0), dm: number[] = [];
  for (const e of s.enemies?.list ?? []) if (!(e[E_FLAGS] & (EF.Boss | EF.Capture | EF.Object))) dm.push(e[E_DMG]);
  dm.sort((a, b) => a - b);
  let worst = dm.length ? dm[Math.floor(0.75 * (dm.length - 1))] : 0;
  for (const b of s.shots ?? []) worst = Math.max(worst, b[5]);
  return s.player.maxHp > 0 ? worst * (1 - armor / (armor + 45)) / s.player.maxHp : 0;
}

/** Lowest HP share of the last `window` seconds (1 when nothing is logged). */
export function lowestHp(life: Lifecycle2, now: number, window: number): number {
  let m = 1;
  for (const e of life.hpLog) if (e.t >= now - window && e.max > 0) m = Math.min(m, e.hp / e.max);
  return m;
}
/** The largest single drop of HP between two logged moments of the last `window` seconds, as a share of max HP: the heaviest hit. */
export function heaviestHit(life: Lifecycle2, now: number, window: number): number {
  let worst = 0, prev: Lifecycle2['hpLog'][number] | null = null;
  for (const e of life.hpLog) {
    // The HP bar misses a hit that a revive made good within the same moment; the damage counter does not.
    if (e.t >= now - window && prev && e.max > 0) worst = Math.max(worst, (prev.hp - e.hp) / e.max, e.taken !== undefined && prev.taken !== undefined ? (e.taken - prev.taken) / e.max : 0);
    prev = e;
  }
  return worst;
}
/** HP lost in the last `window` seconds as a share of max HP: every drop counts, what was healed in between does not make up for it. */
export function hpLost(life: Lifecycle2, now: number, window: number): number {
  let lost = 0, prev: { hp: number; max: number } | null = null;
  for (const e of life.hpLog) {
    if (e.t < now - window) { prev = e; continue; }
    if (prev && e.hp < prev.hp && e.max > 0) lost += (prev.hp - e.hp) / e.max;
    prev = e;
  }
  return lost;
}

/** What the plan needs to know besides the snapshot: prices, what is held, and the estimated spawn multiplier. */
export interface World { gold: number; ballPrice: number; cagePrice: number; slotPrice: number; items: number; spawn: number }
const POINT_NAME: Record<string, string> = { freechest: 'Great Ball (free)', chest: 'Poké Ball', berry: 'berries', slots: 'slot machine', meowth: 'shop', ditto: 'Ditto', cage: 'cage', snorlax: 'Snorlax', magnet: 'Magnemite', rhydon: "Rhydon's roar", cursedchest: 'cursed Poké Ball', cursed: 'cursed altar', greed: "Gengar's altar" };
export const pointKey = (q: Pick<Point, 'kind' | 'x' | 'z'>): string => `${q.kind}:${Math.round(q.x)}:${Math.round(q.z)}`;

/**
 * The spawn multiplier the game would apply (it caps difficulty × enemy amount × the tier's amount at 3), ESTIMATED from
 * what the observation shows: the tier's amount, held items and vitamins that change enemy numbers or difficulty, and
 * the curses taken (cursed altar ×1.15 enemies ×1.1 difficulty, cursed Poké Ball ×1.05, Gengar's altar ×1.2, a Gengar
 * at the slot machine ×1.05 each: the game's own numbers). The stat sheet itself is not in the observation.
 */
export function spawnEstimate(s: Snapshot, st: Pick<RunState, 'build' | 'pointsUsed'>, k: Knowledge, gengar: number): number {
  let m = s.diff?.enemyAmount || 1;
  for (const it of st.build.items) for (const mod of k.items.get(it.key)?.mods ?? []) if ((mod.stat === 'enemyAmount' || mod.stat === 'difficulty') && mod.mul) m *= mod.mul ** it.count;
  for (const v of st.build.vitamins) { const info = k.vitamins.get(v.key); if (info && info.kind === 'mul' && (info.stat === 'enemyAmount' || info.stat === 'difficulty')) m *= 1 + info.perLevel * v.level; }
  const used = st.pointsUsed ?? {};
  return m * (1.15 * 1.1) ** (used.cursed ?? 0) * 1.05 ** (used.cursedchest ?? 0) * 1.2 ** (used.greed ?? 0) * (1.05 * 1.05) ** gengar;
}

/**
 * plan-2: the errand the plan sends the brain on, or null. The nearest map point of `plan.errands` whose own condition
 * holds: a free ball always; a paid ball, a cage or the slot machine when the Pokédollars cover it; the shop on the
 * first visit or when the Pokédollars have grown; berries when hurt; Ditto with an item to copy; Rhydon before the
 * guardian wakes; curses while HP is high and the spawn multiplier is under the target. Exported for tests.
 */
export function errandFor(s: Snapshot, w: World, hp: number, swarm: boolean, life: Lifecycle2, plan: Plan, brainSkip: string[] = []): NonNullable<Directive['goto']> | null {
  if (hp < plan.lootHp || (s.bossSpawned && !s.stageCleared)) return null;
  const range = swarm ? plan.swarmLootRange : plan.lootRange;
  const wanted = (q: Point): boolean => {
    switch (q.kind) {
      case 'freechest': return true;
      case 'chest': return w.ballPrice > 0 && w.gold >= w.ballPrice;
      case 'berry': return hp < 0.8;
      case 'slots': return w.slotPrice > 0 && w.gold >= plan.slotMinSpins * w.slotPrice && w.slotPrice <= plan.slotShare * w.gold;
      case 'meowth': return w.gold >= plan.shopGold && (life.shopLeft === null || (plan.shopRevisit > 0 && w.gold >= plan.shopRevisit * Math.max(life.shopLeft, plan.shopGold)));
      case 'ditto': return w.items > 0;
      case 'cage': return w.cagePrice > 0 && w.gold >= w.cagePrice;
      case 'snorlax': case 'magnet': return true;
      case 'rhydon': return !s.bossSpawned && !s.stageCleared;
      case 'cursedchest': case 'cursed': case 'greed': return hp >= plan.riskHp && w.spawn < plan.spawnTarget;
      default: return false;
    }
  };
  const q = s.points.filter((x) => !x.used && plan.errands.includes(x.kind) && x.d <= range && (!swarm || x.kind === 'freechest')
    && !life.skip.has(pointKey(x)) && !brainSkip.includes(pointKey(x)) && wanted(x)).sort((a, b) => a.d - b.d)[0];
  if (!q) { life.errand = null; return null; }
  // An errand that does not get done (out of reach, or the press went to another point) is given up for the zone.
  const key = pointKey(q);
  if (life.errand?.key !== key) life.errand = { key, since: s.t };
  else if (s.t - life.errand.since > plan.errandTimeout) { life.skip.add(key); life.errand = null; return null; }
  const price = q.kind === 'chest' ? w.ballPrice : q.kind === 'slots' ? w.slotPrice : q.kind === 'cage' ? w.cagePrice : 0;
  const note = `${POINT_NAME[q.kind] ?? q.kind}${price ? ` ${Math.round(price)}₽ of ${Math.floor(w.gold)}₽` : q.kind === 'meowth' ? ` with ${Math.floor(w.gold)}₽` : ''}`;
  return { kind: 'errand', x: q.x, z: q.z, reach: Math.max(1, q.r * 0.6), interact: true, force: q.d <= plan.forceWithin || hp >= plan.forceHp, note };
}

/** The directive for the brain. Exported for tests. */
const wakeAfter = (plan: Plan, stage: number): number => plan.wakeAfterSec[Math.min(plan.wakeAfterSec.length - 1, Math.max(0, stage - 1))];

/** Where the plan sends the brain to loot, or null. A berry is only fetched when hurt. */
export function lootGoal(s: Snapshot, hp: number, swarm: boolean, skip: string[], plan: Plan): NonNullable<Directive['goto']> | null {
  if (swarm || hp < plan.lootHp || (s.bossSpawned && !s.stageCleared)) return null;
  // Time to wake the guardian: the brain's own rule does that, and an order to loot would come before it.
  const wakeLv = plan.wakeLevel[Math.min(plan.wakeLevel.length - 1, Math.max(0, s.stage - 1))];
  if (!s.bossSpawned && !s.stageCleared && (s.stageTime >= wakeAfter(plan, s.stage) || s.player.level >= wakeLv)) return null;
  const want = s.points.filter((q) => !q.used && q.d <= plan.lootRange && plan.lootKinds.includes(q.kind) && !skip.includes(`${q.kind}:${Math.round(q.x)}:${Math.round(q.z)}`)
    && (q.kind !== 'chest' || (s.ballCost > 0 && s.gold >= s.ballCost)) && (q.kind !== 'berry' || hp < 0.8)).sort((a, b) => a.d - b.d)[0];
  // The shop, when the Pokédollars are worth the walk and no Poké Ball is nearer.
  const shop = s.gold >= plan.shopGold ? s.points.filter((q) => q.kind === 'meowth' && !q.used && q.d <= plan.lootRange && !skip.includes(`${q.kind}:${Math.round(q.x)}:${Math.round(q.z)}`)).sort((a, b) => a.d - b.d)[0] : undefined;
  if (shop && (!want || shop.d < want.d)) return { kind: 'visit', x: shop.x, z: shop.z, reach: Math.max(1, shop.r * 0.6), interact: true, force: false, note: `visit the shop with ${Math.floor(s.gold)}₽` };
  if (!want) return null;
  const note = want.kind === 'chest' ? `Poké Ball ${s.ballCost}₽ of ${Math.floor(s.gold)}₽` : want.kind;
  return { kind: 'loot', x: want.x, z: want.z, reach: Math.max(1, want.r * 0.7), interact: true, force: false, note };
}

export function directiveFor2(s: Snapshot, ot: Pick<RunState['overtime'], 'live' | 'over' | 'direct' | 'round'> & { drain?: number }, life: Lifecycle2, plan: Plan, swarm = false, skip: string[] = [], world?: World): Directive {
  const hp = s.player.maxHp > 0 ? s.player.hp / s.player.maxHp : 0;
  if (ot.over) return {};
  if (s.stage !== life.zone) { life.zone = s.stage; life.skip = new Set(); life.errand = null; life.shopLeft = null; life.clearedAt = null; life.roarSince = null; }
  if (s.stageCleared) life.clearedAt ??= s.t;
  if (ot.live || ot.direct) life.otAt ??= s.t;
  if (!(ot.live || ot.direct)) {
    if (s.stage >= 4) {
      if (s.stageCleared) { life.restSince ??= s.t; if (hp < 0.9 && s.t - life.restSince < 45) return { holdPortal: true }; }
      return {};
    }
    const limit = plan.leaveAtSec[Math.min(plan.leaveAtSec.length - 1, s.stage - 1)];
    if (!plan.errands.length || !world) {
      // plan-1.
      const loot = lootGoal(s, hp, swarm, skip, plan);
      if (!s.stageCleared) return loot ? { goto: loot } : {};
      // The guardian has fallen: the zone is farmed on, through its final swarm, until the HP bar or the clock says leave.
      if (hp < plan.leaveHp || s.stageTime >= limit) life.leaving.add(s.stage);
      return life.leaving.has(s.stage) ? {} : loot ? { holdPortal: true, goto: loot } : { holdPortal: true };
    }
    if (!s.stageCleared) {
      // Time to wake the guardian: the walk is the plan's, so that its last metres are made through the horde.
      const wakeLv = plan.wakeLevel[Math.min(plan.wakeLevel.length - 1, Math.max(0, s.stage - 1))];
      if (!s.bossSpawned && (s.stageTime >= wakeAfter(plan, s.stage) || s.player.level >= wakeLv)) {
        // plan-3: Rhydon answers only while the guardian sleeps, three times. The roars still owed come first.
        const totem = plan.roarsFirst && hp >= plan.wakeHp ? s.points.find((q) => q.kind === 'rhydon' && !q.used && !life.skip.has(pointKey(q)) && !skip.includes(pointKey(q))) : undefined;
        if (totem) {
          life.roarSince ??= s.t;
          if (s.t - life.roarSince <= plan.roarTimeout) return { goto: { kind: 'errand', x: totem.x, z: totem.z, reach: Math.max(1, totem.r * 0.6), interact: true, force: true, note: `Rhydon's roars before the guardian (${Math.round(totem.d)} m)` } };
          life.skip.add(pointKey(totem));
        }
        const altar = s.points.filter((q) => q.kind === 'boss' && !q.used).sort((a, b) => a.d - b.d)[0];
        if (altar && hp >= plan.wakeHp) return { goto: { kind: 'wake', x: altar.x, z: altar.z, reach: Math.max(1.5, altar.r * 0.6), interact: true, force: altar.d <= plan.forceWithin || hp >= plan.forceHp, note: `wake guardian (lv ${s.player.level}, ${Math.round(s.stageTime)}s)` } };
        return {};
      }
      const errand = errandFor(s, world, hp, swarm, life, plan, skip);
      return errand ? { goto: errand } : {};
    }
    // The guardian has fallen: its prizes first, then the zone is farmed on through its final swarm while the HP bar
    // stays high, and left through the portal when it does not, or when the clock says so.
    const by = plan.leaveBySec[Math.min(plan.leaveBySec.length - 1, s.stage - 1)];
    if (hp < plan.leaveHp || s.stageTime >= by || (s.stageTime >= limit && lowestHp(life, s.t, plan.stayWindow) < plan.stayHp)
      || (swarm && plan.leaveHit <= 1 && heaviestHit(life, s.t, plan.stayWindow) >= plan.leaveHit)
      || (swarm && limitOf(plan.leaveThreat, plan.leaveThreatRevive, life) > 0 && hordeHit(s) >= limitOf(plan.leaveThreat, plan.leaveThreatRevive, life))
      || (plan.reviveLeaves && life.revivedAt >= (life.clearedAt ?? Infinity))) life.leaving.add(s.stage);
    const errand = errandFor(s, world, hp, swarm || life.leaving.has(s.stage), life, plan, skip);
    if (life.leaving.has(s.stage)) return errand ? { holdPortal: true, goto: errand } : {};
    if (errand) return { holdPortal: true, goto: errand };
    // The swarm is fought next to the way out. The brain's own leash comes after its experience and loot goals and
    // let a run drift 200 m from the portal (seed 1): beyond the leash the way back is an order.
    const exit = swarm && plan.stayLeash > 0 ? s.points.filter((q) => q.kind === 'portal').sort((a, b) => a.d - b.d)[0] : undefined;
    if (!exit) return { holdPortal: true };
    if (exit.d > plan.stayLeash) return { holdPortal: true, goto: { kind: 'stay', x: exit.x, z: exit.z, reach: plan.stayLeash * 0.5, interact: false, force: true, note: `back to the portal (${Math.round(exit.d)} m)` } };
    return { holdPortal: true, leash: { x: exit.x, z: exit.z, r: plan.stayLeash } };
  }
  const portal = s.points.filter((q) => q.kind === 'portal').sort((a, b) => a.d - b.d)[0];
  if (!portal) return { holdPortal: true };
  const drain = s.player.maxHp > 0 ? (ot.drain ?? 0) / s.player.maxHp : 0;
  const lost = plan.cashLoss <= 1 ? hpLost(life, s.t, plan.cashWindow) : 0;
  const cap = limitOf(plan.cashThreat, plan.cashThreatRevive, life), threat = cap > 0 ? hordeHit(s) : 0, revived = plan.reviveLeaves && life.revivedAt >= (life.otAt ?? Infinity);
  if (life.cashing || hp < plan.cashHp || ot.round > plan.cashAfterRound || drain >= plan.cashDrain || lost >= plan.cashLoss || (cap > 0 && threat >= cap) || revived) {
    life.cashing = true;
    const why = revived ? ', a revive spent' : cap > 0 && threat >= cap ? `, the horde hits for ${Math.round(threat * 100)}% of max HP` : lost >= plan.cashLoss ? `, ${Math.round(lost * 100)}% lost in ${plan.cashWindow} s` : '';
    return { holdPortal: true, goto: { kind: 'cash', x: portal.x, z: portal.z, reach: Math.max(1, portal.r * 0.5), interact: true, force: true, note: `cash out overtime (hp ${Math.round(hp * 100)}%, round ${ot.round}, tide ${(drain * 100).toFixed(1)}%/s${why})` } };
  }
  return { holdPortal: true, leash: { x: portal.x, z: portal.z, r: plan.leash } };
}

let cached: Knowledge | null = null;

export function heuristic2Policy(options: Heuristic2Options = {}): Policy & { readonly state: { intent: string; note: string; plan: string } } {
  const plan = planWith(options.plan);
  const base: Tuning = { ...DEFAULT_TUNING, ...plan.tuning, wakeLevel: [...plan.wakeLevel], wakeAfterSec: plan.wakeAfterSec[0], visitKinds: [...(plan.tuning.visitKinds ?? DEFAULT_TUNING.visitKinds)] };
  const knowledge = (cached ??= loadValuationKnowledge(BUILD));
  let mem: Memory = newMemory(), build: Build | null = null, kit: Kit | null = null;
  let life: Lifecycle2 = newLife();
  let nav: Nav | null = null, navAt = -Infinity, navGoal: { x: number; z: number } | null = null, intent = '', note = '';
  const emit = (t: number, what: string, detail: string) => options.onEvent?.({ t, what, detail });
  return {
    name: 'heuristic2',
    get state() { return { intent, note, plan: plan.version }; },
    reset() { mem = newMemory(); build = null; kit = null; nav = null; navAt = -Infinity; navGoal = null; intent = ''; note = ''; life = newLife(); },
    act(obs: Observation): Action {
      const s = obs.snapshot;
      build ??= buildFor(s.player.species);
      kit ??= kitOf(knowledge, s.player.species);
      if (obs.phase === 'choice') {
        const c = choose2(obs, { build, tuning: base, plan, knowledge, kit });
        const d = obs.decision!;
        if (SERVICE_DIALOGS.has(d.kind)) mem = markVisited(mem);
        // What the plan remembers of its own answers: what was left on leaving the shop, and Gengar's curses at the slot machine.
        if (d.kind === 'shop' && 'extra' in c.action && c.action.extra === 'leave') life.shopLeft = s.gold;
        if (d.kind === 'slots' && (d.context.last as { prize?: string } | null)?.prize === 'gengar') life.gengar++;
        emit(s.t, `choice:${obs.decision!.kind}`, c.reason);
        return c.action;
      }
      if (obs.phase !== 'play') throw new Error('heuristic2 policy: the episode is over');
      let snap: Snapshot = s;
      if (options.planRoute && navGoal && (s.t - navAt >= 0.45 || s.t < navAt)) { nav = options.planRoute(navGoal.x, navGoal.z); navAt = s.t; }
      if (nav && s.t - navAt < 1.5 && s.t >= navAt) snap = { ...s, nav };
      // The wake time is the zone's own.
      const tuning: Tuning = base.wakeAfterSec === wakeAfter(plan, s.stage) ? base : { ...base, wakeAfterSec: wakeAfter(plan, s.stage) };
      const st = obs.state;
      life.hpLog.push({ t: s.t, hp: s.player.hp, max: s.player.maxHp, taken: st.counters.damageTaken });
      if (life.revives !== null && st.build.revives < life.revives) life.revivedAt = s.t;
      life.revives = st.build.revives;
      while (life.hpLog.length && (life.hpLog[0].t < s.t - 30 || life.hpLog[0].t > s.t)) life.hpLog.shift();
      const world: World = { gold: s.gold, ballPrice: st.economy.ballPrice, cagePrice: st.economy.cagePrice, slotPrice: st.economy.slotPrice, items: st.build.items.length, spawn: spawnEstimate(s, st, knowledge, life.gengar) };
      const out = decide(snap, mem, tuning, directiveFor2(s, st.overtime, life, plan, st.zone.finalSwarm, mem.skip, world));
      mem = out.mem;
      navGoal = out.goal?.far ? { x: out.goal.x, z: out.goal.z } : null;
      if (out.action.intent !== intent) emit(s.t, `intent:${out.action.intent}`, out.action.note);
      intent = out.action.intent; note = out.action.note;
      return toPlayAction(out.action, obs.mask as PlayMask).action;
    },
  };
}
