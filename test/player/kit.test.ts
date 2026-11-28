import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Snapshot } from '../../src/observations/snapshot.ts';
import { buildFor } from '../../src/player/brain/builds.ts';
import { DEFAULT_TUNING } from '../../src/player/brain/tuning.ts';
import { choose, kitOfObservation, scoreLevelUp } from '../../src/player/chooser.ts';
import type { ChooserContext, KitMemo } from '../../src/player/chooser.ts';
import { BUILD_PLANS, BUILD_PLAN_NAMES, SHARED_ON_MIN, buildPlanOf, kitState, linkable } from '../../src/player/kit.ts';
import type { HeldMove } from '../../src/player/kit.ts';
import { PLAN, planWith } from '../../src/player/plan.ts';
import { errandFor, playerAdvisor, kitSignature, newLife } from '../../src/player/policy.ts';
import type { World } from '../../src/player/policy.ts';
import { kitOf, loadValuationKnowledge } from '../../src/player/values.ts';

const k = loadValuationKnowledge('mwsewi0r');
const id = (key: string): number => k.moves.get(key)!.id;
/** Held moves from "key:level" (a linked pair as "a+b:level", the fusion as "fu-150:level"), slot by slot; "-" is an empty slot. */
const hold = (...slots: string[]): HeldMove[] => slots.flatMap((x, slot) => {
  if (x === '-') return [];
  const [name, level] = x.split(':'), [key, linked] = name.split('+');
  return [{ slot, key, level: Number(level ?? 1), fusion: key.startsWith('fu-'), linked: linked ?? null }];
});
const bill = (used = false) => [{ kind: 'bill', used }];
const state = (moves: HeldMove[], o: { items?: Record<string, number>; stage?: number; points?: { kind: string; used: boolean }[]; plan?: typeof PLAN } = {}) =>
  kitState(moves, 4, o.items ?? {}, 150, o.stage ?? 1, o.points ?? bill(), o.plan ?? PLAN, k);

const B = PLAN.builds[150], NONE = planWith({ builds: {} });

test('Mewtwo\'s build: the fusion, four moves the machine can link and Encore; a Pokémon without a build has no kit state', () => {
  assert.deepEqual([B.fuse, B.kit, B.favourites], [['psystrike', 'psycho-boost'], ['future-sight', 'perish-song', 'trick-room', 'mist', 'encore'], ['future-sight', 'perish-song', 'trick-room', 'mist']]);
  assert.ok(PLAN.errands.includes('bill') && PLAN.errands.includes('hypno'));
  assert.deepEqual(B.kit.map((key) => linkable(key, k)), [true, true, true, true, false]);
  assert.equal(state(hold('psycho-cut:1'), { plan: NONE }).on, false);
  assert.equal(kitState(hold('ember:1'), 4, {}, 4, 1, bill(), PLAN, k).on, false, 'Charmander is not in the plan\'s builds');
  const on = state(hold('psycho-cut:1'));
  assert.deepEqual([on.on, on.pair, on.wanted], [true, B.fuse, B.kit]);
});

test('the kit: which moves a free slot takes, and in which order', () => {
  // The first level: three free slots, two of them owed to the fusion's moves that are not held yet.
  const start = state(hold('psycho-cut:1'));
  assert.deepEqual([start.on, start.fused, start.cap, start.lessonFrom], [true, false, 8, 8]);
  assert.deepEqual(start.missing, ['future-sight', 'perish-song', 'trick-room', 'mist', 'encore'], 'the move that cannot be linked comes last');
  assert.deepEqual(start.takeable, ['future-sight', 'perish-song', 'trick-room', 'mist']);
  assert.deepEqual(start.ownJunk, ['psycho-cut', 'prismatic-laser']);
  // One free slot and Psycho Boost still to come: nothing else goes into it.
  assert.deepEqual(state(hold('psycho-cut:3', 'psystrike:2', 'mist:1')).takeable, []);
  assert.deepEqual(state(hold('psycho-cut:3', 'psystrike:2', 'psycho-boost:1')).takeable, ['future-sight', 'perish-song', 'trick-room', 'mist']);
  // After the fusion, with a machine still to come, a pair first; Encore only when every move that can be linked is held.
  const z2 = { stage: 2, points: bill(true) };
  assert.deepEqual(state(hold('future-sight+perish-song:10', 'fu-150:6', 'mist:10'), z2).takeable, ['trick-room']);
  assert.deepEqual(state(hold('future-sight+perish-song:10', 'fu-150:6', 'mist+trick-room:10'), z2).takeable, ['encore']);
  assert.equal(state(hold('future-sight+perish-song:10', 'fu-150:6', 'mist+trick-room:10'), z2).machinesLeft, 1);
  // No machine left (the third zone's is used, or the sanctuary): nothing more will be paired, Encore first.
  const last = state(hold('future-sight+perish-song:10', 'fu-150:6', 'mist:10'), { stage: 3, points: bill(true) });
  assert.deepEqual([last.machinesLeft, last.missing, last.takeable], [0, ['encore', 'trick-room'], ['encore', 'trick-room']]);
  assert.equal(state(hold('fu-150:6'), { stage: 4, points: [] }).machinesLeft, 0);
  assert.equal(state(hold('psycho-cut:1'), { stage: 1, points: bill() }).machinesLeft, 3);
  // The whole kit: nothing missing, nothing to take, nothing to forget.
  const whole = state(hold('future-sight+perish-song:10', 'fu-150:6', 'mist+trick-room:10', 'encore:10'), { stage: 3, points: bill(true) });
  assert.deepEqual([whole.missing, whole.takeable, whole.junk, whole.forget, whole.fuse, whole.link], [[], [], [], [], null, null]);
});

test('the kit: what Bill\'s machine does, and what Hypno forgets', () => {
  // The fusion needs both of its moves at the cap: 8, and 10 with a TM Case.
  assert.deepEqual(state(hold('psycho-cut:8', 'psystrike:8', 'psycho-boost:7', 'mist:8')).fuse, null);
  assert.deepEqual(state(hold('psycho-cut:8', 'psystrike:8', 'psycho-boost:8', 'mist:8')).fuse, ['psystrike', 'psycho-boost']);
  assert.deepEqual(state(hold('psycho-cut:8', 'psystrike:8', 'psycho-boost:8', 'mist:8'), { items: { 'tm-case': 1 } }).fuse, null, 'with a TM Case the cap is 10');
  assert.equal(state(hold('psystrike:10', 'psycho-boost:10'), { items: { 'tm-case': 1 } }).cap, 10);
  // A link: two moves of the kit that can be linked, both at the cap and neither linked already; in the plan's order.
  const three = state(hold('mist:8', 'fu-150:5', 'perish-song:8', 'future-sight:8'));
  assert.deepEqual([three.fuse, three.link, three.fused], [null, ['future-sight', 'perish-song'], true]);
  assert.deepEqual(state(hold('mist:8', 'fu-150:5', 'perish-song:7', 'future-sight:8')).link, ['future-sight', 'mist']);
  assert.deepEqual(state(hold('encore:8', 'fu-150:5', 'perish-song:8')).link, null, 'Encore cannot be linked');
  assert.deepEqual(state(hold('future-sight+perish-song:8', 'fu-150:5', 'mist:8')).link, null, 'a linked pair does not go into the machine again');
  assert.deepEqual(state(hold('future-sight+perish-song:8', 'fu-150:5', 'mist:8', 'trick-room:8')).link, ['trick-room', 'mist']);
  // Hypno: a move the kit has no place for, out of a full set of slots, while something is still to be learned.
  const full = state(hold('psycho-cut:4', 'psystrike:6', 'psycho-boost:2', 'mist:3'));
  assert.deepEqual([full.junk, full.forget], [[0], [0]]);
  assert.deepEqual(state(hold('psycho-cut:4', 'psystrike:6', 'psycho-boost:2')).forget, [], 'not while a slot is free');
  assert.deepEqual(state(hold('future-sight+perish-song:10', 'fu-150:6', 'mist+trick-room:10', 'psybeam:3')).forget, [3], 'a move taken for want of anything else makes room for Encore');
  // Before the fusion its two moves are of the kit; after it a stray one is not.
  assert.deepEqual(state(hold('psystrike:8', 'fu-150:1', 'mist:8', 'future-sight:8')).junk, [0]);
});

// ---- the answers -------------------------------------------------------------------------------------------------

const snap = (over: Record<string, unknown>): Snapshot => ({ t: 100, stage: 1, stageTime: 100, stageCleared: false, bossSpawned: false, gold: 0, ballCost: 50, points: bill(), player: { hp: 200, maxHp: 200, level: 20, species: 150, moves: [], moveSlots: 4, items: {}, vitamins: {} }, ...over } as unknown as Snapshot);
const ctx8 = (memo?: KitMemo): ChooserContext => ({ build: buildFor(150), tuning: DEFAULT_TUNING, plan: PLAN, knowledge: k, kit: kitOf(k, 150), ...(memo ? { memo } : {}) });
const build = (moves: HeldMove[]) => ({ build: { moves: [0, 1, 2, 3].map((slot) => moves.find((m) => m.slot === slot) ?? null) } });
const obs = (kind: string, options: { id: string; data?: Record<string, unknown> }[], context: Record<string, unknown>, extras: Record<string, boolean | boolean[]>, moves: HeldMove[], s: Record<string, unknown> = {}, mask?: boolean[]) =>
  ({ phase: 'choice', snapshot: snap({ ...s, player: { ...snap({}).player, moves: moves.map((m) => ({ key: m.key })), ...(s.player as object ?? {}) } }), state: build(moves), decision: { kind, method: kind, options: options.map((o) => ({ id: o.id, label: o.id, data: o.data ?? {} })), context }, mask: { options: mask ?? options.map(() => true), extras } }) as never;
const offer = (data: Record<string, unknown>) => ({ id: `${String(data.kind)}:${String(data.id ?? data.vit ?? data.slot)}`, label: '', data });

test('level-ups with a build: only moves of the kit, the species\' other moves banished, a banish kept back for each', () => {
  const held = hold('psycho-cut:3', 'psystrike:2', 'psycho-boost:1'), o = obs('levelup', [], {}, {}, held) as any, kit = kitOfObservation(o, ctx8());
  const sc = (data: Record<string, unknown>, st = kit) => scoreLevelUp(offer(data), o.snapshot, ctx8(), st);
  assert.deepEqual([sc({ kind: 'newMove', id: id('future-sight') }).score, sc({ kind: 'newMove', id: id('mist'), from: 144 }).score], [98, 95], 'in the plan\'s order');
  assert.equal(sc({ kind: 'newMove', id: id('psycho-boost') }, kitOfObservation(obs('levelup', [], {}, {}, hold('psycho-cut:3', 'psystrike:2')) as any, ctx8())).score, 99, 'a move of the fusion first');
  const encore = sc({ kind: 'newMove', id: id('encore'), from: 202 }), laser = sc({ kind: 'newMove', id: id('prismatic-laser') }), other = sc({ kind: 'newMove', id: id('psybeam'), from: 63 });
  assert.deepEqual([encore.score, encore.junk], [5, false], 'Encore is not taken while a pair is still to be learned, and never banished');
  assert.deepEqual([laser.score, laser.junk, laser.must], [0, true, true]);
  assert.deepEqual([other.score, other.junk], [10, false], 'another member\'s move is left alone: the banishes are few');
  // Upgrades: the fusion's moves first, a move that will be dropped last (still over the refresh mark of 62).
  const up = (slot: number) => sc({ kind: 'upMove', slot }).score;
  assert.ok(up(1) >= 86 && up(2) >= 86 && up(0) === 64 && ctx8().plan.rerollBelow < 64);
  const later = kitOfObservation(obs('levelup', [], {}, {}, hold('-', 'fu-150:2', 'mist:3')) as any, ctx8());
  assert.deepEqual([sc({ kind: 'upMove', slot: 1 }, later).score, sc({ kind: 'upMove', slot: 2 }, later).score], [76, 76], 'by slot, also with an empty slot before it');
  // The same offers for a Pokémon the plan lists no build for: its own moves, as ever.
  const c7 = { ...ctx8(), plan: NONE };
  assert.ok(scoreLevelUp(offer({ kind: 'newMove', id: id('prismatic-laser') }), o.snapshot, c7, kitOfObservation(o, c7)).score >= 95);

  // Banishing. Two of the species' moves are not banished yet: two banishes are kept for them.
  const pick = (options: Record<string, unknown>[], banishes: number, memo?: KitMemo) => choose(obs('levelup', options.map(offer), { banishes }, { banish: options.map(() => banishes > 0), refresh: true, skip: true }, held, { player: { level: 200 } }), ctx8(memo)).action;
  const iron = { kind: 'newVit', vit: 'iron' }, laserOffer = { kind: 'newMove', id: id('prismatic-laser') }, candy = { kind: 'newVit', vit: 'exp-candy' };
  assert.deepEqual(pick([iron, candy], 2), { type: 'choice', option: 1 }, 'a vitamin that is not of the plan is not banished with the last two');
  assert.deepEqual(pick([iron, candy], 3), { type: 'choice', extra: 'banish', target: 0 });
  assert.deepEqual(pick([iron, laserOffer, candy], 1), { type: 'choice', extra: 'banish', target: 1 }, 'the species\' own move before anything else');
  assert.deepEqual(pick([iron, candy], 1, { banished: new Set(['psycho-cut', 'prismatic-laser']), lessonZone: 0 }), { type: 'choice', extra: 'banish', target: 0 }, 'both banished: nothing is kept back');
  assert.deepEqual(pick([iron, candy], 2, { banished: new Set(['prismatic-laser']), lessonZone: 0 }), { type: 'choice', extra: 'banish', target: 0 });
});

test('Hypno with a build: the dropped move out of a full set, the lesson once a zone and not before the kit can be offered', () => {
  const full = hold('psycho-cut:4', 'psystrike:6', 'psycho-boost:2', 'mist:3');
  const forget = (moves: HeldMove[], s: Record<string, unknown> = {}, memo?: KitMemo, lessonReady = true) => {
    const options = [...moves.map((m) => ({ id: `move:${m.slot}`, data: { what: 'move', slot: m.slot, key: m.key } })), { id: 'lesson', data: { what: 'lesson' } }];
    const free = moves.length < 4;
    return choose(obs('forget', options, { lessonReady }, { leave: true }, moves, s, [...moves.map(() => moves.length > 1), lessonReady && free]), ctx8(memo));
  };
  assert.deepEqual(forget(full).action, { type: 'choice', option: 0 });
  assert.match(forget(full).reason, /forget psycho-cut/);
  const three = hold('-', 'psystrike:6', 'psycho-boost:2', 'mist:3');
  assert.deepEqual(forget(three).action, { type: 'choice', option: 3 }, 'the lesson for the free slot');
  assert.deepEqual(forget(three, { player: { level: 5 } }).action, { type: 'choice', extra: 'leave' }, 'not before level 8: Future Sight could not be offered');
  assert.deepEqual(forget(three, {}, { banished: new Set(), lessonZone: 1 }).action, { type: 'choice', extra: 'leave' }, 'not twice in a zone');
  assert.deepEqual(forget(three, { stage: 2 }, { banished: new Set(), lessonZone: 1 }).action, { type: 'choice', option: 3 }, 'again in the next zone');
  assert.deepEqual(forget(three, {}, undefined, false).action, { type: 'choice', extra: 'leave' }, 'the game says the lesson is gone');
  // The lesson: the best move of the kit that the slot should take; otherwise it is kept.
  const lesson = (ids: number[], moves = three) => choose(obs('lesson', ids.map((x) => ({ id: `newMove:m${x}`, data: { kind: 'newMove', id: x } })), {}, { decline: true }, moves), ctx8()).action;
  assert.deepEqual(lesson([id('psybeam'), id('mist'), id('trick-room')]), { type: 'choice', option: 2 }, 'Mist is held: Trick Room');
  assert.deepEqual(lesson([id('trick-room'), id('perish-song'), id('psycho-cut')]), { type: 'choice', option: 1 }, 'in the plan\'s order');
  assert.deepEqual(lesson([id('psybeam'), id('encore'), id('psycho-cut')]), { type: 'choice', extra: 'decline' }, 'Encore not yet');
  assert.deepEqual(choose(obs('lesson', [{ id: 'x', data: { kind: 'newMove', id: id('mist') } }], {}, { decline: true }, three), { ...ctx8(), plan: NONE }).action, { type: 'choice', extra: 'decline' }, 'without a build no lesson is taken');
});

test('Bill\'s machine with a build: the fusion, else a link of two kit moves, else nothing', () => {
  const machine = (moves: HeldMove[], pairs: [string, string, string][], items: Record<string, number> = {}) =>
    choose(obs('fusion', pairs.map(([how, a, b]) => ({ id: `${how}:${a}+${b}`, data: { how, moveA: a, moveB: b } })), {}, { leave: true }, moves, { player: { items } }), ctx8());
  const all: [string, string, string][] = [['fuse', 'psystrike', 'psycho-boost'], ['link', 'psystrike', 'psycho-boost'], ['fuse', 'mist', 'future-sight'], ['link', 'mist', 'future-sight']];
  assert.deepEqual(machine(hold('future-sight:8', 'psystrike:8', 'psycho-boost:8', 'mist:8'), all).action, { type: 'choice', option: 0 });
  assert.deepEqual(machine(hold('future-sight:8', 'psystrike:8', 'psycho-boost:8', 'mist:8'), all, { 'tm-case': 1 }).action, { type: 'choice', extra: 'leave' }, 'with a TM Case it waits for level 10');
  const links: [string, string, string][] = [['fuse', 'mist', 'future-sight'], ['link', 'mist', 'future-sight'], ['fuse', 'perish-song', 'future-sight'], ['link', 'perish-song', 'future-sight']];
  const linked = machine(hold('future-sight:8', 'fu-150:5', 'perish-song:8', 'mist:8'), links);
  assert.deepEqual(linked.action, { type: 'choice', option: 3 }, 'a link, never a fusion, of the first two in the plan\'s order');
  assert.match(linked.reason, /link future-sight and perish-song.*trick-room/);
  assert.deepEqual(machine(hold('future-sight:8', 'fu-150:5', 'perish-song:6', 'encore:8'), []).action, { type: 'choice', extra: 'leave' });
});

test('errands with a build: Bill\'s machine when two moves are ready, Hypno to forget or for the lesson, neither twice for nothing', () => {
  const far = [{ kind: 'bill', sub: '', x: 300, z: 0, r: 2, used: false, cost: 0, d: 300 }, { kind: 'hypno', sub: '', x: -200, z: 0, r: 2, used: false, cost: 0, d: 200 }];
  const s = (over: Record<string, unknown> = {}) => snap({ points: far, stageCleared: true, ...over });
  const world = (moves: HeldMove[], st = s()): World => ({ gold: 0, ballPrice: 0, cagePrice: 0, slotPrice: 0, items: 0, spawn: 1, kit: kitOfObservation({ snapshot: st, state: build(moves) as never }, ctx8()) });
  const errand = (moves: HeldMove[], st = s(), life = newLife(), swarm = false) => errandFor(st, world(moves, st), 1, swarm, life, PLAN)?.note ?? null;
  assert.equal(errand(hold('future-sight:8', 'psystrike:8', 'psycho-boost:8', 'mist:8')), "Bill's machine", '300 m away');
  assert.equal(errand(hold('future-sight:8', 'psystrike:8', 'psycho-boost:8', 'mist:8'), s(), newLife(), true), "Bill's machine", 'also in the final swarm');
  assert.equal(errand(hold('future-sight:8', 'psystrike:8', 'psycho-boost:7', 'mist:7')), null, 'nothing is ready');
  assert.equal(errand(hold('future-sight:8', 'psystrike:8', 'psycho-boost:7', 'mist:8')), "Bill's machine", 'a link may come before the fusion: three uses either way');
  assert.equal(errand(hold('future-sight:8', 'fu-150:5', 'perish-song:8', 'mist:8')), "Bill's machine", 'a link');
  // Hypno.
  assert.equal(errand(hold('psycho-cut:4', 'psystrike:6', 'psycho-boost:2', 'mist:3')), 'hypno', 'a move to forget');
  assert.equal(errand(hold('-', 'psystrike:6', 'psycho-boost:2', 'mist:3')), 'hypno', 'the lesson for a free slot');
  assert.equal(errand(hold('-', 'psystrike:6', 'psycho-boost:2', 'mist:3'), s({ player: { ...snap({}).player, level: 5 } })), null, 'not before level 8');
  const gone = newLife(); gone.memo.lessonZone = 1;
  assert.equal(errand(hold('-', 'psystrike:6', 'psycho-boost:2', 'mist:3'), s(), gone), null, 'the lesson of this zone is gone');
  // Left with nothing changed: not walked to again until the moves held are other ones.
  const left = newLife(), stuck = hold('psycho-cut:4', 'psystrike:6', 'psycho-boost:2', 'mist:3');
  left.hypnoLeft = kitSignature(world(stuck).kit!, left, 1);
  assert.equal(errand(stuck, s(), left), null);
  assert.equal(errand(hold('psycho-cut:4', 'psystrike:6', 'psycho-boost:2', 'future-sight:1'), s(), left), 'hypno');
  // Without a build neither is walked to for a move.
  assert.equal(errandFor(s(), { gold: 0, ballPrice: 0, cagePrice: 0, slotPrice: 0, items: 0, spawn: 1 }, 1, false, newLife(), NONE), null);
});

test('the player remembers what it answered: banished moves, the lesson of the zone, Hypno and a machine left as they were', () => {
  const adv = playerAdvisor({});
  const moves = hold('psycho-cut:4', 'psystrike:6', 'psycho-boost:2');
  const levelup = obs('levelup', [offer({ kind: 'newMove', id: id('prismatic-laser') }), offer({ kind: 'newVit', vit: 'iron' })], { banishes: 3 }, { banish: [true, true] }, moves);
  adv.noteChoice(levelup, { type: 'choice', extra: 'banish', target: 0 }, '');
  adv.noteChoice(levelup, { type: 'choice', extra: 'banish', target: 1 }, '');
  assert.deepEqual([...adv.life.memo.banished], ['prismatic-laser'], 'moves only');
  assert.equal(adv.context(150).memo, adv.life.memo, 'the answers see it');
  adv.noteChoice(obs('lesson', [], {}, { decline: true }, moves, { stage: 2 }), { type: 'choice', extra: 'decline' }, '');
  assert.equal(adv.life.memo.lessonZone, 2);
  const hypno = obs('forget', [], { lessonReady: false }, { leave: true }, moves, { stage: 3 });
  adv.noteChoice(hypno, { type: 'choice', extra: 'leave' }, '');
  assert.equal(adv.life.memo.lessonZone, 3, 'the game says this zone\'s lesson is gone');
  assert.equal(adv.life.hypnoLeft, '0:psycho-cut,1:psystrike,2:psycho-boost|no lesson');
  const point = { kind: 'bill', sub: '', x: 12.2, z: -7.6, r: 2, used: false, cost: 0, d: 3 };
  adv.noteChoice(obs('fusion', [], {}, { leave: true }, moves, { points: [point] }), { type: 'choice', extra: 'leave' }, '');
  assert.ok(adv.life.skip.has('bill:12:-8'), 'a machine left unused is not walked to again in this zone');
  adv.reset();
  assert.deepEqual([[...adv.life.memo.banished], adv.life.memo.lessonZone, adv.life.hypnoLeft], [[], 0, null]);
});

test('the account\'s build plan kit-1: four favourites, and the pool switched off as far as the game allows', () => {
  assert.deepEqual(BUILD_PLAN_NAMES, ['kit-1']);
  const plan = buildPlanOf('kit-1', 150, k), pool = k.learnable(150);
  assert.deepEqual(plan.favs, ['future-sight', 'perish-song', 'trick-room', 'mist'].map(id), 'the four moves the machine can link');
  assert.deepEqual(plan.moves, B.kit.map(id));
  assert.deepEqual(BUILD_PLANS['kit-1'][150].keep, B.kit);
  assert.deepEqual([pool.line.length, pool.shared.length], [10, 30]);
  const off = new Set(plan.movesOff);
  assert.equal(off.size, plan.movesOff.length);
  assert.ok(plan.movesOff.length <= 40 && ![...B.kit, ...k.kitOf(150)].some((key) => off.has(key)), 'never a move of the kit or of the species');
  assert.deepEqual(pool.line.filter((key) => !off.has(key)), ['mist', 'future-sight'], 'of its own line only the kit\'s two stay on');
  const sharedOn = pool.shared.filter((key) => !off.has(key));
  assert.equal(sharedOn.length, SHARED_ON_MIN, 'the game keeps twelve moves of other members on');
  assert.ok(['trick-room', 'encore', 'perish-song'].every((key) => sharedOn.includes(key)));
  // What stays on besides the kit is the strongest of the rest.
  const dps = (key: string) => { const m = k.moves.get(key)!; return m.cooldown > 0 ? m.damage / m.cooldown : 0; };
  const weakestOn = Math.min(...sharedOn.filter((key) => !B.kit.includes(key)).map(dps)), strongestOff = Math.max(...pool.shared.filter((key) => off.has(key)).map(dps));
  assert.ok(weakestOn >= strongestOff);
  // The level from which every move of the kit can be offered: the game's own rule.
  assert.deepEqual(B.kit.map((key) => pool.from[key]), [8, 7, 4, 5, 4]);
  assert.throws(() => buildPlanOf('kit-1', 6, k), /nothing for species 6/);
  assert.throws(() => buildPlanOf('kit-9', 150, k), /nothing for species 150/);
});
