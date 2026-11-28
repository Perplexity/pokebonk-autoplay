import type { Nav, Snapshot } from '../observations/snapshot.ts';
import { buildFor } from './brain/builds.ts';
import type { Build } from './brain/builds.ts';
import { decide, markVisited, newMemory } from './brain/movement.ts';
import type { Directive, Memory } from './brain/movement.ts';
import { DEFAULT_TUNING } from './brain/tuning.ts';
import type { Tuning } from './brain/tuning.ts';
import type { Policy } from '../environment/policies.ts';
import type { Action, Observation, PlayMask } from '../environment/types.ts';
import type { RunState } from '../observations/state.ts';
import { toPlayAction } from './adapter.ts';
import { choose, kitOfObservation, vitaminPhase } from './chooser.ts';
import type { ChooserContext, KitMemo } from './chooser.ts';
import type { KitState } from './kit.ts';
import { EF, E_DMG, E_FLAGS } from '../observations/snapshot.ts';
import type { Point } from '../observations/snapshot.ts';
import { planWith } from './plan.ts';
import type { Plan } from './plan.ts';
import { kitOf, loadValuationKnowledge } from './values.ts';
import type { Kit, Knowledge } from './values.ts';

/**
 * The player. Movement and fighting are the brain's (brain/movement.ts); this file is the run's lifecycle, the orders
 * it gives the brain, and the bookkeeping between dialogs. Dialogs are answered in chooser.ts, by the plan (plan.ts):
 *
 *   zone        errands (`errandFor`), Rhydon's three roars, then the guardian; once it has fallen the portal stays
 *               closed and the zone is played on, through its final swarm, until the plan says leave
 *   sanctuary   the legendary, a rest, Overtime
 *   Overtime    fight near the portal; cash when the plan says so
 *
 * It sees the observation, the read-only route planner and the game's knowledge export; it is deterministic.
 */
export const PLAYER_VERSION = '3';
const SERVICE_DIALOGS = new Set(['shop', 'ditto', 'trade', 'dojo', 'slots', 'forget', 'fusion']);
/** The game build whose data export the player reads when the caller names none. */
export const DEFAULT_BUILD = 'mwsewi0r';

export interface PlayerOptions {
  planRoute?: (x: number, z: number) => Nav | null;
  /**
   * The running game's build, or how to ask for it: its data export is read (data/game-knowledge/<build>/) when the
   * first observation arrives. Default: the pinned build.
   */
  build?: string | (() => string);
  /** Keys of the plan to replace (plan.ts). */
  plan?: Record<string, unknown>;
  onEvent?: (e: { t: number; what: string; detail: string }) => void;
}
export interface Lifecycle {
  cashing: boolean; restSince: number | null;
  /** zones whose portal the policy has decided to take */
  leaving: Set<number>;
  /** The zone the next three fields belong to; errands given up in it; the errand under way; Pokédollars held on leaving its shop. */
  zone: number; skip: Set<string>; errand: { key: string; since: number } | null; shopLeft: number | null;
  /** Gengar curses drawn at slot machines in this run. */
  gengar: number;
  /** Revives held when last seen; run time a revive was last spent; run time the current zone was cleared, its final swarm was first seen with the guardian fallen (the later of the two when the swarm began first), and Overtime began. */
  revives: number | null; revivedAt: number; clearedAt: number | null; swarmAt: number | null; otAt: number | null;
  /** Run time the walk to this zone's Rhydon totem was first ordered ahead of the wake. */
  roarSince: number | null;
  /** Moves banished and the zone whose lesson is gone (chooser.ts, `KitMemo`); the moves held when Hypno was last left (he is not visited again for the kit until they change). */
  memo: KitMemo; hypnoLeft: string | null;
}
export const newLife = (): Lifecycle => ({ cashing: false, restSince: null, leaving: new Set(), zone: 0, skip: new Set(), errand: null, shopLeft: null, gengar: 0, revives: null, revivedAt: -Infinity, clearedAt: null, otAt: null, swarmAt: null, roarSince: null, memo: { banished: new Set(), lessonZone: 0 }, hypnoLeft: null });

/** What Hypno could change for the kit: the moves held, by slot, and whether this zone's lesson is still to be had. */
export const kitSignature = (kit: KitState, life: Pick<Lifecycle, 'memo'>, stage: number): string => `${kit.held.map((m) => `${m.slot}:${m.key}`).join(',')}|${life.memo.lessonZone === stage ? 'no lesson' : 'lesson'}`;

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

/** What the plan needs to know besides the snapshot: prices, what is held, and the estimated spawn multiplier. */
export interface World { gold: number; ballPrice: number; cagePrice: number; slotPrice: number; items: number; spawn: number; /** The state of the Pokémon's build, when the plan lists one (kit.ts). */ kit?: KitState }
const POINT_NAME: Record<string, string> = { bill: "Bill's machine", freechest: 'Great Ball (free)', chest: 'Poké Ball', berry: 'berries', slots: 'slot machine', meowth: 'shop', ditto: 'Ditto', cage: 'cage', snorlax: 'Snorlax', magnet: 'Magnemite', rhydon: "Rhydon's roar", cursedchest: 'cursed Poké Ball', cursed: 'cursed altar', greed: "Gengar's altar" };
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
 * The errand the plan sends the brain on, or null. The nearest map point of `plan.errands` whose own condition
 * holds: a free ball always; a paid ball, a cage or the slot machine when the Pokédollars cover it; the shop on the
 * first visit or when the Pokédollars have grown; berries when hurt; Ditto with an item to copy; Rhydon before the
 * guardian wakes; curses while HP is high and the spawn multiplier is under the target. Exported for tests.
 */
export function errandFor(s: Snapshot, w: World, hp: number, swarm: boolean, life: Lifecycle, plan: Plan, brainSkip: string[] = []): NonNullable<Directive['goto']> | null {
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
      // Bill's machine: whenever the build's fusion or a link of two of its moves is ready (kit.ts).
      case 'bill': return !!(w.kit?.on && (w.kit.fuse || w.kit.link));
      case 'cursedchest': case 'cursed': case 'greed': return hp >= plan.riskHp && w.spawn < plan.spawnTarget;
      // Hypno: once the final phase has begun, while a vitamin of the earlier phase is still held (chooser.ts, 'forget').
      // Also to forget a move the kit has no place for, and for this zone's lesson into a free slot; not again
      // for either until the moves held have changed since he was last left.
      case 'hypno': {
        const phase = vitaminPhase(s, plan);
        if (!!phase?.final && Object.keys(s.player.vitamins ?? {}).some((k) => !phase.wanted.includes(k))) return true;
        const kit = w.kit;
        return !!kit?.on && s.player.level >= kit.lessonFrom && (kit.forget.length > 0 || (kit.takeable.length > 0 && life.memo.lessonZone !== s.stage)) && kitSignature(kit, life, s.stage) !== life.hypnoLeft;
      }
      default: return false;
    }
  };
  const q = s.points.filter((x) => !x.used && plan.errands.includes(x.kind) && (x.kind === 'hypno' || (x.kind === 'bill' && !!w.kit?.on) || (x.d <= range && (!swarm || x.kind === 'freechest')))
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
export const wakeAfter = (plan: Plan, stage: number): number => plan.wakeAfterSec[Math.min(plan.wakeAfterSec.length - 1, Math.max(0, stage - 1))];

export function directiveFor(s: Snapshot, ot: Pick<RunState['overtime'], 'live' | 'over' | 'direct' | 'round'> & { drain?: number }, life: Lifecycle, plan: Plan, swarm: boolean, skip: string[], world: World): Directive {
  const hp = s.player.maxHp > 0 ? s.player.hp / s.player.maxHp : 0;
  if (ot.over) return {};
  if (s.stage !== life.zone) { life.zone = s.stage; life.skip = new Set(); life.errand = null; life.shopLeft = null; life.clearedAt = null; life.swarmAt = null; life.roarSince = null; life.hypnoLeft = null; }
  if (s.stageCleared) life.clearedAt ??= s.t;
  if (ot.live || ot.direct) life.otAt ??= s.t;
  if (!(ot.live || ot.direct)) {
    if (s.stage >= 4) {
      if (s.stageCleared) { life.restSince ??= s.t; if (hp < 0.9 && s.t - life.restSince < 45) return { holdPortal: true }; }
      return {};
    }
    if (!s.stageCleared) {
      // Time to wake the guardian: the walk is the plan's, so that its last metres are made through the horde.
      const wakeLv = plan.wakeLevel[Math.min(plan.wakeLevel.length - 1, Math.max(0, s.stage - 1))];
      if (!s.bossSpawned && (s.stageTime >= wakeAfter(plan, s.stage) || s.player.level >= wakeLv)) {
        // Rhydon answers only while the guardian sleeps, three times. The roars still owed come first.
        const totem = hp >= plan.wakeHp ? s.points.find((q) => q.kind === 'rhydon' && !q.used && !life.skip.has(pointKey(q)) && !skip.includes(pointKey(q))) : undefined;
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
    // The guardian has fallen: its prizes first, then the zone is played on through its final swarm, and left through
    // the portal when the plan says so. The HP bar, the horde's hits and a spent revive count only once the final swarm
    // is on: until then a cleared zone is an ordinary one, and a bar the guardian emptied is the brain's to refill.
    const by = plan.leaveBySec[Math.min(plan.leaveBySec.length - 1, s.stage - 1)];
    if (swarm) life.swarmAt ??= s.t;
    const since = Math.max(life.clearedAt ?? Infinity, life.swarmAt ?? Infinity);
    if ((swarm && hp < plan.leaveHp) || s.stageTime >= by
      || (swarm && plan.leaveThreat > 0 && !((life.revives ?? 0) > 0) && hordeHit(s) >= plan.leaveThreat)
      || life.revivedAt >= since) life.leaving.add(s.stage);
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
  const revived = life.revivedAt >= (life.otAt ?? Infinity);
  if (life.cashing || hp < plan.cashHp || ot.round > plan.cashAfterRound || drain >= plan.cashDrain || revived) {
    life.cashing = true;
    return { holdPortal: true, goto: { kind: 'cash', x: portal.x, z: portal.z, reach: Math.max(1, portal.r * 0.5), interact: true, force: true, note: `cash out overtime (hp ${Math.round(hp * 100)}%, round ${ot.round}, tide ${(drain * 100).toFixed(1)}%/s${revived ? ', a revive spent' : ''})` } };
  }
  return { holdPortal: true, leash: { x: portal.x, z: portal.z, r: plan.leash } };
}

const cached = new Map<string, Knowledge>();

/** What the player would do in one play tick: the snapshot the brain sees (with the planned route), its tuning and the plan's order. */
export interface Advice { snap: Snapshot; tuning: Tuning; directive: Directive }

/**
 * The player taken apart: the plan's order for a play tick
 * (`advise`), the brain's answer to an order WITHOUT committing it (`peek`), committing one (`commit`), and the
 * answer to a dialog (`choose`) with the bookkeeping the plan does on whatever was answered (`noteChoice`).
 * `playerPolicy` below is these five in order.
 */
export interface PlayerAdvisor {
  readonly plan: Plan;
  readonly knowledge: Knowledge;
  /** The brain's tuning without the zone's wake time. */
  readonly baseTuning: Tuning;
  readonly state: { intent: string; note: string; plan: string };
  readonly life: Lifecycle;
  /** Map points the brain has given up on in this zone ("kind:x:z"). */
  readonly skip: readonly string[];
  kit(species: number): Kit;
  context(species: number): ChooserContext;
  reset(): void;
  /** Once per play observation: logs HP, tracks revives, and returns the plan's order. Advances the plan's own state. */
  advise(obs: Observation): Advice;
  /** The brain's decision for an order, not committed. Pure. */
  peek(advice: Advice): ReturnType<typeof decide>;
  /** Make a peeked decision the one that is played: the brain's memory moves on, and the action is fitted to the mask. */
  commit(obs: Observation, out: ReturnType<typeof decide>): Action;
  choose(obs: Observation): { action: Action; reason: string };
  /** After a dialog was answered (by anyone): what the plan remembers of it. */
  noteChoice(obs: Observation, action: Action, reason: string): void;
}

export function playerAdvisor(options: PlayerOptions = {}): PlayerAdvisor {
  const plan = planWith(options.plan);
  const base: Tuning = { ...DEFAULT_TUNING, ...plan.tuning, wakeLevel: [...plan.wakeLevel], wakeAfterSec: plan.wakeAfterSec[0], visitKinds: [...(plan.tuning.visitKinds ?? DEFAULT_TUNING.visitKinds)] };
  let known: Knowledge | null = null;
  const know = (): Knowledge => {
    if (!known) { const id = typeof options.build === 'function' ? options.build() : options.build ?? DEFAULT_BUILD; known = cached.get(id) ?? loadValuationKnowledge(id); cached.set(id, known); }
    return known;
  };
  let mem: Memory = newMemory(), build: Build | null = null, kit: Kit | null = null;
  let life: Lifecycle = newLife();
  let nav: Nav | null = null, navAt = -Infinity, navGoal: { x: number; z: number } | null = null, intent = '', note = '';
  const emit = (t: number, what: string, detail: string) => options.onEvent?.({ t, what, detail });
  const ctxOf = (species: number): ChooserContext => ({ build: (build ??= buildFor(species)), tuning: base, plan, knowledge: know(), kit: (kit ??= kitOf(know(), species)), memo: life.memo });
  return {
    plan, baseTuning: base,
    get knowledge() { return know(); },
    get state() { return { intent, note, plan: plan.version }; },
    get life() { return life; },
    get skip() { return mem.skip; },
    kit: (species) => (kit ??= kitOf(know(), species)),
    context: ctxOf,
    reset() { mem = newMemory(); build = null; kit = null; nav = null; navAt = -Infinity; navGoal = null; intent = ''; note = ''; life = newLife(); },
    choose(obs) { return choose(obs, ctxOf(obs.snapshot.player.species)); },
    noteChoice(obs, action, reason) {
      const d = obs.decision!, s = obs.snapshot;
      if (SERVICE_DIALOGS.has(d.kind)) mem = markVisited(mem);
      // What the plan remembers of the answers: what was left on leaving the shop, and Gengar's curses at the slot machine.
      if (d.kind === 'shop' && 'extra' in action && action.extra === 'leave') life.shopLeft = s.gold;
      if (d.kind === 'slots' && (d.context.last as { prize?: string } | null)?.prize === 'gengar') life.gengar++;
      // A banished move does not come back; a lesson answered either way is gone for the zone (turned down,
      // it offers the same moves again); Hypno left, and a machine left unused, are not walked to again as things are.
      if (d.kind === 'levelup' && 'extra' in action && action.extra === 'banish') { const o = d.options[Number((action as { target?: number }).target)]; const key = o?.data.kind === 'newMove' ? know().movesById.get(Number(o.data.id))?.key : undefined; if (key) life.memo.banished.add(key); }
      if (d.kind === 'lesson' || (d.kind === 'forget' && d.context.lessonReady === false)) life.memo.lessonZone = s.stage;
      if (plan.builds[s.player.species]) {
        if (d.kind === 'forget' && 'extra' in action && action.extra === 'leave') life.hypnoLeft = kitSignature(kitOfObservation(obs, { plan, knowledge: know() }), life, s.stage);
        if (d.kind === 'fusion' && 'extra' in action && action.extra === 'leave') { const q = s.points.filter((x) => x.kind === 'bill' && !x.used).sort((a, b) => a.d - b.d)[0]; if (q) life.skip.add(pointKey(q)); }
      }
      emit(s.t, `choice:${d.kind}`, reason);
    },
    advise(obs) {
      const s = obs.snapshot;
      ctxOf(s.player.species);
      let snap: Snapshot = s;
      if (options.planRoute && navGoal && (s.t - navAt >= 0.45 || s.t < navAt)) { nav = options.planRoute(navGoal.x, navGoal.z); navAt = s.t; }
      if (nav && s.t - navAt < 1.5 && s.t >= navAt) snap = { ...s, nav };
      // The wake time is the zone's own.
      const tuning: Tuning = base.wakeAfterSec === wakeAfter(plan, s.stage) ? base : { ...base, wakeAfterSec: wakeAfter(plan, s.stage) };
      const st = obs.state;
      if (life.revives !== null && st.build.revives < life.revives) life.revivedAt = s.t;
      life.revives = st.build.revives;
      const world: World = { gold: s.gold, ballPrice: st.economy.ballPrice, cagePrice: st.economy.cagePrice, slotPrice: st.economy.slotPrice, items: st.build.items.length, spawn: spawnEstimate(s, st, know(), life.gengar), ...(plan.builds[s.player.species] ? { kit: kitOfObservation(obs, { plan, knowledge: know() }) } : {}) };
      return { snap, tuning, directive: directiveFor(s, st.overtime, life, plan, st.zone.finalSwarm, mem.skip, world) };
    },
    peek(advice) { return decide(advice.snap, mem, advice.tuning, advice.directive); },
    commit(obs, out) {
      const s = obs.snapshot;
      mem = out.mem;
      navGoal = out.goal?.far ? { x: out.goal.x, z: out.goal.z } : null;
      if (out.action.intent !== intent) emit(s.t, `intent:${out.action.intent}`, out.action.note);
      intent = out.action.intent; note = out.action.note;
      return toPlayAction(out.action, obs.mask as PlayMask).action;
    },
  };
}

export function playerPolicy(options: PlayerOptions = {}): Policy & { readonly state: { intent: string; note: string; plan: string } } {
  const adv = playerAdvisor(options);
  return {
    name: 'player',
    get state() { return adv.state; },
    reset() { adv.reset(); },
    act(obs: Observation): Action {
      if (obs.phase === 'choice') {
        const c = adv.choose(obs);
        adv.noteChoice(obs, c.action, c.reason);
        return c.action;
      }
      if (obs.phase !== 'play') throw new Error('player policy: the episode is over');
      return adv.commit(obs, adv.peek(adv.advise(obs)));
    },
  };
}
