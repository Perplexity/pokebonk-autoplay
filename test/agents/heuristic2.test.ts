import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { Snapshot } from '../../src/bot/snapshot.ts';
import { choose2, scoreLevelUp2, worthNow } from '../../src/agents/heuristic2/chooser.ts';
import type { Chooser2Context } from '../../src/agents/heuristic2/chooser.ts';
import { PLAN_V1, PLAN_V2, PLAN_V3, PLAN_V5, PLAN_V6, planWith } from '../../src/agents/heuristic2/plan.ts';
import { directiveFor2, errandFor, heaviestHit, hordeHit, hpLost, lootGoal, lowestHp, newLife, spawnEstimate } from '../../src/agents/heuristic2/policy.ts';
import type { World } from '../../src/agents/heuristic2/policy.ts';
import { ARCHIVES, ARCHIVE_NAMES, archiveOf, DIRECTION_V1, DIRECTION_V2, DIRECTIONS, itemArchive, itemWorth, kitOf, loadValuationKnowledge, textMultiplier, vitaminWorth } from '../../src/agents/heuristic2/values.ts';
import { DEFAULT_TUNING } from '../../src/bot/brain/tuning.ts';
import { buildFor } from '../../src/bot/brain/builds.ts';

const k = loadValuationKnowledge('mwsewi0r'), mewtwo = kitOf(k, 150);
const worth = (key: string, kit = mewtwo) => itemWorth(k.items.get(key)!, kit).value;

test('the valuation is generated from the game\'s effect data, for the kit of the Pokémon', () => {
  assert.deepEqual(mewtwo.types, { psychic: 1 });
  assert.equal(mewtwo.special, 0.75, 'three of Mewtwo\'s four kit moves are special');
  // A stat multiplier is worth 100 · weight · ln(m); a type bonus counts by the share of the kit that has the type.
  assert.ok(Math.abs(worth('wise-glasses') - 100 * Math.log(1.15) * 0.75) < 1e-9);
  assert.ok(worth('twisted-spoon') > 30 && worth('charcoal') < 5, 'a Psychic bonus matters to Mewtwo, a Fire bonus does not');
  const nidoking = kitOf(k, 32);
  assert.ok(itemWorth(k.items.get('muscle-band')!, nidoking).value > worth('muscle-band'), 'physical damage is worth more to a physical kit');
  // Effects that are not a stat are read from the effect text.
  assert.equal(textMultiplier('3% chance for a hit to deal ×8 damage: bonk!'), 1.21);
  assert.equal(textMultiplier('multiplies your damage ×1.025 for each different item you hold (up to ×1.35)'), 1.35);
  assert.equal(textMultiplier('+2% damage per second without being hit, as a separate multiplier (up to +40%)'), 1.4);
  assert.equal(textMultiplier('+15 max hp and +3% max hp.'), 1);
  for (const key of ['tm-case', 'max-ether', 'focus-band', 'berry-juice', 'metronome', 'razor-fang', 'up-grade', 'stick']) assert.ok(worth(key) > 10, `${key} has no stat line and is still worth something: ${worth(key)}`);
  // What makes the horde bigger is kept apart as risk.
  const flute = itemWorth(k.items.get('white-flute')!, mewtwo);
  assert.ok(flute.risk > 0 && flute.value > 0);
  const cursed = vitaminWorth(k.vitamins.get('cursed')!, mewtwo);
  assert.ok(cursed.risk > 0 && cursed.value > 0, 'Cursed Incense: experience and Pokédollars are worth, the difficulty is risk');
  assert.ok(vitaminWorth(k.vitamins.get('calcium')!, mewtwo).value > vitaminWorth(k.vitamins.get('protein')!, mewtwo).value);
});

test('the valuation agrees with a leaderboard Mewtwo on what is worth stacking', () => {
  const held = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/leaderboard/mewtwo-coast-29m.json'), 'utf8')).build.items as Record<string, number>;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const stacked = Object.keys(held).filter((key) => held[key] >= 5), absent = [...k.items.keys()].filter((key) => !held[key]);
  assert.ok(mean(stacked.map((x) => worth(x))) > mean(absent.map((x) => worth(x))) * 1.2, 'items it held five or more of are worth more on average than items it did not hold');
});

test('the second direction: luck, experience and Pokédollars against damage as measured; taking hits at a fraction', () => {
  const w2 = (key: string) => itemWorth(k.items.get(key)!, mewtwo, DIRECTION_V2).value;
  assert.deepEqual(Object.keys(DIRECTIONS), ['special-sustain-1', 'luck-experience-1']);
  // Damage is the yardstick and is not moved: what a damage item is worth is the same in both.
  for (const key of ['twisted-spoon', 'wise-glasses', 'dusk-stone']) assert.equal(w2(key), worth(key), key);
  // The levers measured on seeds 1-30 are worth more than a damage item of their rarity…
  for (const key of ['comet-shard', 'star-piece', 'exp-share', 'lucky-egg', 'amulet-coin', 'macho-brace']) assert.ok(w2(key) > worth(key) * 1.5, `${key} rises`);
  assert.ok(w2('comet-shard') > w2('twisted-spoon') && w2('exp-share') > w2('wise-glasses'));
  // …and what only helps to take a hit falls, without becoming worthless (no run was measured with less of it).
  for (const key of ['berry-juice', 'shell-bell', 'leftovers', 'assault-vest']) assert.ok(w2(key) < worth(key) && w2(key) > 0, `${key} falls`);
  // A second life keeps its worth: staying in a final swarm rests on it.
  assert.equal(w2('max-revive'), worth('max-revive'));
  // The first direction is what it was, and the account preset's archive is still made with it.
  assert.deepEqual([DIRECTION_V1.mul.xpGain, DIRECTION_V1.add.luck, DIRECTION_V1.add.armor, DIRECTION_V1.mul.healing], [0.8, 0.25, 0.8, 0.7]);
  const a1 = itemArchive(k, mewtwo, { count: 40, slots: 999 }), a2 = itemArchive(k, mewtwo, { count: 40, slots: 999, direction: DIRECTION_V2 });
  assert.ok(a1.filter((x) => a2.includes(x)).length >= 35, 'the two directions archive nearly the same items: plan-5 was measured on the preset of plan-3');
  assert.ok(!a1.some((x) => ['comet-shard', 'star-piece', 'exp-share', 'lucky-egg', 'amulet-coin', 'macho-brace', 'lucky-punch'].includes(x)), 'none of the levers is archived');
  assert.deepEqual([PLAN_V5.version, PLAN_V5.direction.version, PLAN_V3.direction.version], ['plan-5', 'luck-experience-1', 'special-sustain-1']);
  assert.deepEqual({ ...PLAN_V5, version: '', direction: null }, { ...PLAN_V3, version: '', direction: null }, 'plan-5 is plan-3 but for the direction');
  assert.deepEqual(planWith({ base: 'plan-5' }), PLAN_V5);
  // plan-6: plan-5 with a later cash-out and a later leave, for the archive that stacks.
  assert.deepEqual([PLAN_V6.version, PLAN_V6.cashHp, PLAN_V6.cashLoss, PLAN_V6.leaveHp, PLAN_V5.cashHp, PLAN_V5.cashLoss, PLAN_V5.leaveHp], ['plan-6', 0.3, 2, 0.4, 0.75, 0.5, 0.65]);
  assert.deepEqual({ ...PLAN_V6, version: '', cashHp: 0, cashLoss: 0, leaveHp: 0 }, { ...PLAN_V5, version: '', cashHp: 0, cashLoss: 0, leaveHp: 0 });
  assert.deepEqual(planWith({ base: 'plan-6' }), PLAN_V6);
  assert.equal(planWith(undefined).version, 'plan-3', 'the default is still the plan the manager copies');
});

test('archives: the least valuable items, within the slots, never a valuable one', () => {
  assert.deepEqual(ARCHIVES, { empty: 0, loose: 20, balanced: 40, narrow: 105 });
  const narrow = itemArchive(k, mewtwo, { count: 105, slots: 105 }), loose = itemArchive(k, mewtwo, { count: 20, slots: 105 });
  assert.ok(narrow.length <= 105 && loose.length === 20 && loose.every((x) => narrow.includes(x)), 'a wider archive contains the narrower one');
  assert.equal(itemArchive(k, mewtwo, { count: 105, slots: 20 }).length, 20, 'never more than the account has slots');
  assert.deepEqual(itemArchive(k, mewtwo, { count: 0, slots: 105 }), []);
  for (const key of ['twisted-spoon', 'wise-glasses', 'tm-case', 'max-ether', 'berry-juice', 'exp-share', 'dusk-stone', 'razor-claw', 'pp-max', 'metronome', 'white-flute']) assert.ok(!narrow.includes(key), `${key} must stay in the pool`);
  assert.ok(narrow.includes('muscle-band') === false || worth('muscle-band') < 8);
  assert.ok(narrow.every((x) => worth(x) < 8));
});

test('archives of the second direction: new names, the old ones as they were; stack-2 keeps what can be stacked', () => {
  assert.deepEqual(ARCHIVE_NAMES, ['empty', 'loose', 'balanced', 'narrow', 'balanced-2', 'stack-2']);
  for (const name of Object.keys(ARCHIVES)) assert.deepEqual(archiveOf(name, k, mewtwo, 105), itemArchive(k, mewtwo, { count: ARCHIVES[name], slots: 105 }), `${name} is what it was`);
  assert.deepEqual(archiveOf('balanced-2', k, mewtwo, 105), itemArchive(k, mewtwo, { count: 40, slots: 105, direction: DIRECTION_V2 }));
  const stack = archiveOf('stack-2', k, mewtwo, 105), pool = [...k.items.keys()].filter((x) => !stack.includes(x));
  assert.equal(stack.length, 105, 'every slot of the account is used');
  assert.equal(archiveOf('stack-2', k, mewtwo, 60).length, 60, 'never more than the slots');
  // What the leaderboard Mewtwo held ten of, as far as the second direction values it, and what a run cannot do without.
  for (const key of ['comet-shard', 'exp-share', 'lucky-egg', 'star-piece', 'amulet-coin', 'twisted-spoon', 'wise-glasses', 'shiny-stone', 'dusk-stone', 'razor-claw', 'metronome', 'pp-max', 'cleanse-tag', 'macho-brace', 'max-revive', 'revive', 'tm-case', 'max-ether']) assert.ok(pool.includes(key), `${key} stays in the pool`);
  const unlimited = pool.filter((x) => k.items.get(x)!.maxStack == null).length;
  assert.ok(unlimited >= 13 && unlimited / pool.length > 0.3, `a third of the pool or more stacks without a limit of its own (${unlimited} of ${pool.length})`);
  assert.throws(() => archiveOf('narrow-9', k, mewtwo, 105), /unknown archive "narrow-9"/);
});

const snap = (over: Record<string, unknown>): Snapshot => ({ t: 100, stage: 1, stageTime: 100, stageCleared: false, bossSpawned: false, gold: 0, ballCost: 50, points: [], player: { hp: 200, maxHp: 200, level: 20, species: 150, moves: [{ key: 'psycho-cut', name: 'Psycho Cut', cls: 'physical' }], moveSlots: 4, items: {}, vitamins: {} }, ...over } as unknown as Snapshot);
const ctx: Chooser2Context = { build: buildFor(150), tuning: DEFAULT_TUNING, plan: PLAN_V1, knowledge: k, kit: mewtwo };
const offer = (data: Record<string, unknown>) => ({ id: 'x', label: '', data });

test('level-ups: the kit first, then what the build direction values; junk is marked for banishing', () => {
  const s = snap({});
  const own = scoreLevelUp2(offer({ kind: 'newMove', id: 540 }), s, ctx), borrowed = scoreLevelUp2(offer({ kind: 'newMove', id: 1, from: 25 }), s, ctx);
  const calcium = scoreLevelUp2(offer({ kind: 'newVit', vit: 'calcium' }), s, ctx), carbos = scoreLevelUp2(offer({ kind: 'newVit', vit: 'carbos' }), s, ctx), up = scoreLevelUp2(offer({ kind: 'upMove', slot: 0 }), s, ctx);
  assert.ok(own.score > calcium.score && calcium.score > up.score && up.score > carbos.score && carbos.score > borrowed.score);
  assert.ok(borrowed.junk && carbos.junk && !calcium.junk && !own.junk);
  // Cursed Incense is taken with a full HP bar and left alone when hurt.
  const healthy = scoreLevelUp2(offer({ kind: 'newVit', vit: 'cursed' }), s, ctx).score, hurt = scoreLevelUp2(offer({ kind: 'newVit', vit: 'cursed' }), snap({ player: { ...s.player, hp: 80 } }), ctx).score;
  assert.ok(healthy > hurt);
  assert.ok(worthNow('white-flute', s, ctx) > worthNow('white-flute', snap({ player: { ...s.player, hp: 80 } }), ctx));
});

test('the plan: unknown keys are refused, tuning is merged', () => {
  assert.throws(() => planWith({ leaveHP: 0.5 }), /no key "leaveHP"/);
  const p = planWith({ leaveHp: 0.5, tuning: { lootRange: 10 } });
  assert.deepEqual([p.leaveHp, p.tuning.lootRange, p.tuning.hordeSize, PLAN_V1.leaveHp], [0.5, 10, PLAN_V1.tuning.hordeSize, 0.65]);
  // The newest plan is the default; an older one is played by naming it, and stays what it was.
  assert.equal(planWith(undefined).version, 'plan-3');
  assert.deepEqual(planWith({ base: 'plan-2' }), PLAN_V2);
  assert.equal(planWith({ base: 'plan-1' }).version, 'plan-1');
  assert.deepEqual(planWith({ base: 'plan-1' }), PLAN_V1);
  assert.throws(() => planWith({ base: 'plan-9' }), /no plan "plan-9"/);
  const q = planWith({ sealMax: [1, 1, 1, 1] });
  q.sealMax[0] = 9; q.errands.push('x');
  assert.deepEqual([PLAN_V2.sealMax[0], PLAN_V2.errands.includes('x')], [3, false], 'an overridden plan never writes into the default');
});

test('the run plan: loot before the swarm, wake late, stay after the guardian, leave on low HP or by the clock', () => {
  const life = newLife;
  const ot = { live: false, over: false, direct: false, round: 0 };
  const ball = { kind: 'chest', sub: '', x: 30, z: 0, r: 2, used: false, cost: 50, d: 30 }, free = { ...ball, kind: 'freechest', x: 60, d: 60 };
  // Poké Balls: a paid one only when the Pokédollars cover it; nothing while hurt, in the final swarm, or when it is time to wake the guardian.
  assert.equal(lootGoal(snap({ points: [ball, free], gold: 0 }), 1, false, [], PLAN_V1)?.x, 60);
  assert.equal(lootGoal(snap({ points: [ball, free], gold: 80 }), 1, false, [], PLAN_V1)?.x, 30);
  assert.equal(lootGoal(snap({ points: [ball], gold: 80 }), 0.4, false, [], PLAN_V1), null);
  assert.equal(lootGoal(snap({ points: [ball], gold: 80 }), 1, true, [], PLAN_V1), null);
  assert.equal(lootGoal(snap({ points: [ball], gold: 80, stageTime: PLAN_V1.wakeAfterSec[0] }), 1, false, [], PLAN_V1), null);
  assert.equal(lootGoal(snap({ points: [ball], gold: 80 }), 1, false, ['chest:30:0'], PLAN_V1), null, 'a point the brain gave up on is not ordered again');
  // Before the guardian falls the portal is not an issue; afterwards it is held until HP or the clock says leave, and then for good.
  assert.deepEqual(directiveFor2(snap({}), ot, life(), PLAN_V1), {});
  const l = life(), cleared = { stageCleared: true, bossSpawned: true, stageTime: 610 };
  assert.deepEqual(directiveFor2(snap(cleared), ot, l, PLAN_V1), { holdPortal: true });
  assert.deepEqual(directiveFor2(snap({ ...cleared, player: { ...snap({}).player, hp: 100 } }), ot, l, PLAN_V1), {}, 'under 65 % HP: leave');
  assert.deepEqual(directiveFor2(snap(cleared), ot, l, PLAN_V1), {}, 'the decision to leave is not taken back when HP recovers');
  assert.deepEqual(directiveFor2(snap({ ...cleared, stageTime: 650 }), ot, life(), PLAN_V1), {}, 'the clock: 50 s into the final swarm');
  // Overtime: near the portal, and through it when HP is low.
  const portal = { ...ball, kind: 'portal', x: 5, z: 5, d: 7 };
  const live = directiveFor2(snap({ stage: 4, points: [portal] }), { ...ot, live: true, round: 2 }, life(), PLAN_V1);
  assert.ok(live.holdPortal && live.leash && !live.goto);
  const cash = directiveFor2(snap({ stage: 4, points: [portal], player: { ...snap({}).player, hp: 100 } }), { ...ot, live: true, round: 2 }, life(), PLAN_V1);
  assert.ok(cash.goto?.force && cash.goto.interact && cash.goto.kind === 'cash');
  // …or when the tide takes 6 % of max HP a second, whatever the HP bar shows.
  const tide = directiveFor2(snap({ stage: 4, points: [portal] }), { ...ot, live: true, round: 9, drain: 13 }, life(), PLAN_V1);
  assert.ok(tide.goto?.force, 'cashed by the tide');
  assert.ok(!directiveFor2(snap({ stage: 4, points: [portal] }), { ...ot, live: true, round: 5, drain: 5 }, life(), PLAN_V1).goto);
});

const world = (o: Partial<World> = {}): World => ({ gold: 0, ballPrice: 50, cagePrice: 30, slotPrice: 40, items: 0, spawn: 1.6, ...o });
const point = (kind: string, d: number, o: Record<string, unknown> = {}) => ({ kind, sub: '', x: d, z: 0, r: 2, used: false, cost: 0, d, ...o });

test('plan-2 errands: each map point under its own condition, the nearest first, the last metres through the horde', () => {
  const P = PLAN_V2, pts = [point('chest', 20), point('slots', 40), point('meowth', 50), point('cage', 60), point('freechest', 70), point('cursed', 80), point('ditto', 90)];
  const go = (w: Partial<World>, hp = 1, swarm = false, s: Record<string, unknown> = {}, l = newLife()) => errandFor(snap({ points: pts, ...s }), world(w), hp, swarm, l, P);
  assert.equal(go({ gold: 0 })?.x, 70, 'without Pokédollars: the free ball');
  assert.equal(go({ gold: 35 })?.x, 60, 'the cage costs 30');
  assert.equal(go({ gold: 60 })?.x, 20, 'the Poké Ball costs 50');
  assert.equal(go({ gold: 60, ballPrice: 100 })?.x, 60);
  assert.equal(go({ gold: 60, ballPrice: 100, cagePrice: 100 })?.x, 70, 'a slot spin of 40 is more than a tenth of 60: not yet');
  assert.equal(go({ gold: 400, ballPrice: 1e6 })?.x, 40, 'the slot machine once a spin is a tenth of the Pokédollars');
  assert.equal(go({ gold: 400, ballPrice: 1e6, slotPrice: 1e6 })?.x, 50, 'the shop from 400 on');
  assert.equal(go({ gold: 0, items: 1 }, 1, false, { points: [point('ditto', 90), point('freechest', 95)] })?.x, 90, 'Ditto with an item to copy');
  assert.equal(go({ gold: 0 }, 1, false, { points: [point('ditto', 90)] }), null, 'and not without one');
  // Curses: with a high HP bar, and only under the spawn target.
  const curse = { points: [point('cursed', 30), point('cursedchest', 35), point('greed', 38)] };
  assert.equal(go({}, 1, false, curse)?.x, 30);
  assert.equal(go({}, 0.7, false, curse), null, 'not while hurt');
  assert.equal(go({ spawn: 3 }, 1, false, curse), null, 'not once the horde is as large as the game makes it');
  // Hurt, or the guardian is up: nothing. In a final swarm: only a free ball close by.
  assert.equal(go({ gold: 400 }, 0.5), null);
  assert.equal(go({ gold: 400 }, 1, false, { bossSpawned: true }), null);
  assert.equal(go({ gold: 400 }, 1, true), null);
  assert.equal(go({ gold: 400 }, 1, true, { points: [point('chest', 10), point('freechest', 25)] })?.x, 25);
  // The walk: ordered through the horde within `forceWithin`; an errand not done in time is given up for the zone.
  assert.deepEqual([go({ gold: 0 })?.force, go({ gold: 60 })?.kind, go({ gold: 60 })?.interact], [true, 'errand', true]);
  assert.equal(errandFor(snap({ points: pts }), world({}), 1, false, newLife(), planWith({ forceHp: 2 }))?.force, false, 'with forceHp off, a far target is walked to the ordinary way');
  const l = newLife();
  assert.equal(go({ gold: 60 }, 1, false, { t: 100 }, l)?.x, 20);
  assert.equal(go({ gold: 60 }, 1, false, { t: 100 + P.errandTimeout + 1 }, l), null);
  assert.equal(go({ gold: 60 }, 1, false, { t: 100 + P.errandTimeout + 2 }, l)?.x, 60, 'the next one');
  // The shop again in the same zone only when the Pokédollars have doubled since leaving it.
  const left = newLife(); left.shopLeft = 1000;
  const shopOnly = { points: [point('meowth', 50)] };
  assert.equal(go({ gold: 1500 }, 1, false, shopOnly, left), null);
  assert.equal(go({ gold: 2000 }, 1, false, shopOnly, left)?.x, 50);
});

test('plan-2 run plan: the altar through the horde, prizes before the portal, staying while the HP bar is high', () => {
  const P = PLAN_V2, ot = { live: false, over: false, direct: false, round: 0 }, w = world({ gold: 500 });
  const altar = point('boss', 12), far = point('boss', 200), ball = point('freechest', 20), chest = point('chest', 25);
  const dir = (s: Record<string, unknown>, l = newLife(), swarm = false) => directiveFor2(snap(s), ot, l, P, swarm, [], w);
  // Before the wake time: errands. From it on: the altar, its last metres ordered through the horde.
  assert.equal(dir({ points: [altar, chest] }).goto?.kind, 'errand');
  const wake = dir({ points: [altar, chest], stageTime: P.wakeAfterSec[0] }).goto!;
  assert.deepEqual([wake.kind, wake.force, wake.interact], ['wake', true, true]);
  assert.deepEqual([dir({ points: [far], stageTime: P.wakeAfterSec[0] }).goto?.force], [true], 'a far altar too');
  assert.deepEqual(dir({ points: [altar], stageTime: P.wakeAfterSec[0], player: { ...snap({}).player, hp: 100 } }), {}, 'hurt: the walk is the brain\'s to break off');
  // Cleared: farmed on. In the swarm the prizes by the portal are still fetched; a paid ball is not.
  const cleared = { stageCleared: true, bossSpawned: true, stageTime: 610 };
  assert.deepEqual(dir({ ...cleared, points: [chest] }, newLife(), true), { holdPortal: true });
  assert.equal(dir({ ...cleared, points: [ball] }, newLife(), true).goto?.x, 20);
  assert.deepEqual(dir({ ...cleared, points: [point('portal', 10)] }, newLife(), true), { holdPortal: true, leash: { x: 10, z: 0, r: P.stayLeash } }, 'the swarm is fought near the way out');
  const back = dir({ ...cleared, points: [point('portal', 40)] }, newLife(), true).goto!;
  assert.deepEqual([back.kind, back.force, back.interact, back.reach < P.stayLeash], ['stay', true, false, true], 'from further away: back to it, through the horde, without taking it');
  // The rule on one heavy hit in the swarm (off in plan-2): here 20 % of max HP, HP back at 97 %, and the zone is left.
  const struck = () => { const l = newLife(); for (const [t, hp] of [[606, 200], [607, 160], [608, 194], [610, 195]] as const) l.hpLog.push({ t, hp, max: 200 }); return l; };
  const wary = planWith({ leaveHit: 0.15 }), near = { ...cleared, t: 610, points: [point('portal', 10)] };
  assert.ok(Math.abs(heaviestHit(struck(), 610, 20) - 0.2) < 1e-9);
  assert.deepEqual(directiveFor2(snap(near), ot, struck(), wary, true, [], w), {}, 'through the portal');
  assert.ok(directiveFor2(snap({ ...near, stageTime: 590 }), ot, struck(), wary, false, [], w).holdPortal, 'outside a swarm a hit of that size does not end the stay');
  assert.ok(dir(near, struck(), true).holdPortal, 'plan-2 stays: in zones 2 and 3 every hit is that size');
  assert.deepEqual(dir({ ...cleared, points: [point('portal', 40)] }, newLife(), false), { holdPortal: true }, 'before the swarm: anywhere');
  // The rule on the lowest HP of the last seconds (off in plan-2, see plan.ts): with it, the zone is held after
  // `leaveAtSec` while that was high, and left when it was not. plan-2 itself stays through such a dip.
  const calm = newLife, pressed = () => { const l = newLife(); for (let t = 640; t <= 660; t++) l.hpLog.push({ t, hp: t === 650 ? 140 : 195, max: 200 }); return l; };
  const watchful = planWith({ stayHp: 0.8 }), dirW = (s: Record<string, unknown>, l = newLife()) => directiveFor2(snap(s), ot, l, watchful, true, [], w);
  assert.deepEqual(dirW({ ...cleared, stageTime: 660, t: 660 }, calm()), { holdPortal: true });
  assert.deepEqual(dirW({ ...cleared, stageTime: 660, t: 660 }, pressed()), {}, 'HP fell to 70 % ten seconds ago: through the portal');
  assert.deepEqual(dir({ ...cleared, stageTime: 660, t: 660 }, pressed(), true), { holdPortal: true }, 'plan-2 stays');
  assert.deepEqual(dir({ ...cleared, stageTime: 660, t: 660, player: { ...snap({}).player, hp: 120 } }, pressed(), true), {}, 'under 65 % HP it leaves, as plan-1 did');
  assert.deepEqual(dir({ ...cleared, stageTime: P.leaveBySec[0], t: 660 }, calm(), true), {}, 'the clock, before the collapse');
  assert.equal(dirW({ ...cleared, stageTime: 660, t: 660, points: [ball] }, pressed()).goto?.x, 20, 'leaving, but a prize 20 m away is taken first');
  assert.ok(Math.abs(lowestHp(pressed(), 660, 20) - 0.7) < 1e-9 && lowestHp(pressed(), 660, 5) > 0.9);
  // Overtime: cashed when much HP was lost within seconds, even though the bar reads high again.
  const portal = point('portal', 6), hit = newLife();
  for (const [t, hp] of [[100, 200], [101, 130], [102, 190], [103, 140], [104, 195]] as const) hit.hpLog.push({ t, hp, max: 200 });
  assert.ok(Math.abs(hpLost(hit, 104, 4) - 0.6) < 1e-9);
  const live = { ...ot, live: true, round: 3 };
  assert.equal(directiveFor2(snap({ stage: 4, points: [portal], t: 104 }), live, hit, P, false, [], w).goto?.kind, 'cash');
  assert.ok(directiveFor2(snap({ stage: 4, points: [portal], t: 104 }), live, newLife(), P, false, [], w).leash);
  // The tide alone does not cash in plan-2 (it did in plan-1 at 6 % of max HP a second).
  assert.ok(directiveFor2(snap({ stage: 4, points: [portal], t: 104 }), { ...live, round: 11, drain: 60 }, newLife(), P, false, [], w).leash);
  assert.equal(directiveFor2(snap({ stage: 4, points: [portal], t: 104 }), { ...live, round: 11, drain: 60 }, newLife(), planWith({ cashDrain: 0.06 }), false, [], w).goto?.kind, 'cash');
});

test('plan-3: Rhydon roars three times before the guardian is woken, however far the totem is', () => {
  const P = PLAN_V3, ot = { live: false, over: false, direct: false, round: 0 }, w = world({ gold: 500 });
  const altar = point('boss', 12), totem = point('rhydon', 260), due = { stageTime: P.wakeAfterSec[0], t: 1000 };
  const dir = (s: Record<string, unknown>, l = newLife(), plan = P) => directiveFor2(snap(s), ot, l, plan, false, [], w);
  // The wake is due and the totem still answers (the game marks it used after the third roar): the totem first.
  const l = newLife(), go = dir({ points: [altar, totem], ...due }, l).goto!;
  assert.deepEqual([go.kind, go.x, go.force, go.interact], ['errand', 260, true, true]);
  assert.match(go.note, /Rhydon/);
  assert.equal(dir({ points: [altar, totem], ...due, t: 1050 }, l).goto?.x, 260, 'one or two roars made: it is pressed again');
  assert.equal(dir({ points: [altar, { ...totem, used: true }], ...due, t: 1060 }, l).goto?.kind, 'wake', 'three roars made: the guardian');
  // A totem that cannot be reached is given up after `roarTimeout` seconds, for the zone.
  const stuck = newLife();
  assert.equal(dir({ points: [altar, totem], ...due }, stuck).goto?.kind, 'errand');
  assert.equal(dir({ points: [altar, totem], ...due, t: 1000 + P.roarTimeout + 1 }, stuck).goto?.kind, 'wake');
  assert.equal(dir({ points: [altar, totem], ...due, t: 1000 + P.roarTimeout + 2 }, stuck).goto?.kind, 'wake');
  assert.equal(dir({ points: [altar, totem], ...due, stage: 2, stageTime: P.wakeAfterSec[1], t: 2000 }, stuck).goto?.kind, 'errand', 'the next zone has its own totem');
  // Hurt: neither walk is ordered. No totem in the zone: the guardian. plan-2 is what it was: the guardian at once.
  assert.deepEqual(dir({ points: [altar, totem], ...due, player: { ...snap({}).player, hp: 100 } }), {});
  assert.equal(dir({ points: [altar], ...due }).goto?.kind, 'wake');
  assert.equal(dir({ points: [altar, totem], ...due }, newLife(), PLAN_V2).goto?.kind, 'wake');
  assert.deepEqual([PLAN_V2.roarsFirst, PLAN_V1.roarsFirst, P.roarsFirst], [false, false, true]);
});

test('plan-2 answers: slot spins by price, restocks, seals from the list, borrowed special moves', () => {
  const ctx2: Chooser2Context = { ...ctx, plan: PLAN_V2 };
  const obs = (kind: string, options: { id: string; data?: Record<string, unknown> }[], context: Record<string, unknown>, extras: Record<string, boolean>, s = snap({})) =>
    ({ phase: 'choice', snapshot: s, decision: { kind, method: kind, options: options.map((o) => ({ id: o.id, label: o.id, data: o.data ?? {} })), context }, mask: { options: options.map(() => true), extras } }) as never;
  const slots = (cost: number, gold: number) => choose2(obs('slots', [{ id: 'spin' }], { cost, gold }, { leave: true }), ctx2).action;
  assert.deepEqual(slots(40, 1000), { type: 'choice', option: 0 });
  assert.deepEqual(slots(140, 1000), { type: 'choice', extra: 'leave' });
  assert.deepEqual(choose2(obs('slots', [{ id: 'spin' }], { cost: 40, gold: 1000 }, { leave: true }), ctx).action, { type: 'choice', extra: 'leave' }, 'plan-1 does not spin');
  // The shop: what is worth holding first, then a new stock while it is cheap, then leave.
  const worthless = [...k.items.keys()].sort((a, b) => worthNow(a, snap({}), ctx2) - worthNow(b, snap({}), ctx2))[0];
  const stock = [{ id: 'twisted-spoon', data: { key: 'twisted-spoon', price: 100 } }, { id: worthless, data: { key: worthless, price: 80 } }];
  assert.deepEqual(choose2(obs('shop', stock, { gold: 5000, rerollCost: 40 }, { reroll: true, leave: true }), ctx2).action, { type: 'choice', option: 0 });
  const junk = [stock[1]];
  assert.deepEqual(choose2(obs('shop', junk, { gold: 5000, rerollCost: 40 }, { reroll: true, leave: true }), ctx2).action, { type: 'choice', extra: 'reroll' });
  assert.deepEqual(choose2(obs('shop', junk, { gold: 5000, rerollCost: 900 }, { reroll: true, leave: true }), ctx2).action, { type: 'choice', extra: 'leave' });
  assert.deepEqual(choose2(obs('shop', junk, { gold: 5000, rerollCost: 40 }, { reroll: true, leave: true }), ctx).action, { type: 'choice', extra: 'leave' }, 'plan-1 never restocks');
  // Seals: as many of the plan's list as are offered; a seal not on the list ("heal") is never put on.
  const subsets = (offers: string[]) => Array.from({ length: 1 << offers.length }, (_v, m) => offers.filter((_o, i) => m & (1 << i))).map((x) => ({ id: x.join('+') || 'none', data: { seals: x } }));
  const seal = (offers: string[], c = ctx2) => { const o = subsets(offers); return o[(choose2(obs('seals', o, {}, { decline: true }), c).action as { option: number }).option].id; };
  assert.equal(seal(['swift', 'clock', 'echo']), 'swift+clock+echo');
  assert.equal(seal(['swift', 'heal', 'echo']), 'swift+echo');
  assert.equal(seal(['heal']), 'none');
  assert.equal(seal(['swift', 'clock', 'echo'], { ...ctx2, plan: planWith({ sealMax: [1] }) }), 'clock', 'one seal: the first of the list');
  assert.equal(seal(['swift', 'clock', 'echo'], ctx), 'none', 'plan-1 wakes without seals');
  // A special move of another kit goes into a free slot; a physical one is still junk.
  const special = [...k.movesById.values()].find((m) => m.class === 'special' && m.type !== 'psychic')!, physical = [...k.movesById.values()].find((m) => m.class === 'physical')!;
  const sp = scoreLevelUp2(offer({ kind: 'newMove', id: special.id, from: 25 }), snap({}), ctx2), ph = scoreLevelUp2(offer({ kind: 'newMove', id: physical.id, from: 25 }), snap({}), ctx2);
  assert.ok(sp.score >= 80 && !sp.junk && ph.junk);
});

test('the spawn multiplier is estimated from the tier, what is held and the curses taken', () => {
  const s = snap({ diff: { enemyHp: 1.9, enemyDamage: 1.96, enemySpeed: 1.16, enemyAmount: 1.6 } });
  const st = (items: { key: string; count: number }[], vitamins: { key: string; level: number }[], pointsUsed: Record<string, number>) => ({ build: { items, vitamins }, pointsUsed }) as never;
  assert.ok(Math.abs(spawnEstimate(s, st([], [], {}), k, 0) - 1.6) < 1e-9);
  assert.ok(Math.abs(spawnEstimate(s, st([{ key: 'white-flute', count: 2 }], [], {}), k, 0) - 1.6 * 1.12 ** 2) < 1e-9);
  assert.ok(Math.abs(spawnEstimate(s, st([], [{ key: 'cursed', level: 5 }], { cursed: 1, greed: 1 }), k, 1) - 1.6 * 1.6 * 1.265 * 1.2 * 1.1025) < 1e-9);
});

test('plan-2: the horde\'s damage, not the HP bar, says when a swarm or Overtime has become deadly', () => {
  const P = PLAN_V2, ot = { live: false, over: false, direct: false, round: 0 }, w = world({});
  // Enemy tuples: [i, x, z, vx, vz, hp, maxHp, radius, dmg, speed, flags, species]. 200 max HP, armor 45 halves a hit.
  const foe = (dmg: number, flags = 0) => [0, 5, 5, 0, 0, 10, 10, 0.5, dmg, 3, flags, 19];
  const at = (dmg: number, o: Record<string, unknown> = {}) => snap({ stageCleared: true, bossSpawned: true, stageTime: 700, points: [point('portal', 8)], enemies: { count: 4, list: [foe(dmg), foe(dmg), foe(dmg), foe(dmg * 0.5), foe(1e6, 4)] }, shots: [], player: { ...snap({}).player, stats: { armor: 45 } }, ...o });
  assert.ok(Math.abs(hordeHit(at(100)) - 0.25) < 1e-9, 'the guardian\'s own damage is not the horde\'s');
  assert.ok(Math.abs(hordeHit(at(100, { shots: [[0, 0, 1, 0, 0.4, 400]] })) - 1) < 1e-9, 'a shot in the air counts');
  assert.ok(directiveFor2(at(300), ot, newLife(), P, true, [], w).holdPortal, 'three quarters of max HP a hit: stay');
  assert.deepEqual(directiveFor2(at(420), ot, newLife(), P, true, [], w), {}, 'a hit would take all of max HP: through the portal, at full HP');
  assert.ok(directiveFor2(at(420), ot, newLife(), P, false, [], w).holdPortal, 'the rule is the swarm\'s');
  const insured = newLife(); insured.revives = 1;
  assert.ok(directiveFor2(at(4000), ot, insured, P, true, [], w).holdPortal, 'with a revive held the stay goes on: the revive is the warning');
  // A revive spent after the zone was cleared: leave. One spent before (in the guardian fight) does not count.
  const spent = newLife(); spent.zone = 1; spent.clearedAt = 500; spent.revivedAt = 650;
  assert.deepEqual(directiveFor2(at(10), ot, spent, P, true, [], w), {});
  const before = newLife(); before.zone = 1; before.clearedAt = 500; before.revivedAt = 450;
  assert.ok(directiveFor2(at(10), ot, before, P, true, [], w).holdPortal);
  // The damage counter shows a hit the HP bar does not (a revive made it good at once).
  const hidden = newLife();
  for (const [t, taken] of [[600, 1000], [601, 1000], [602, 2300]] as const) hidden.hpLog.push({ t, hp: 254, max: 254, taken });
  assert.ok(heaviestHit(hidden, 602, 20) > 5);
  // Overtime: cashed when one hit of the horde would take all of max HP, or a revive was spent in it.
  const live = { ...ot, live: true, round: 6 }, arena = { stage: 4, stageCleared: true };
  const careful = planWith({ cashThreat: 1 });
  assert.ok(directiveFor2(at(300, arena), live, newLife(), careful, false, [], w).leash);
  assert.equal(directiveFor2(at(420, arena), live, newLife(), careful, false, [], w).goto?.kind, 'cash');
  assert.ok(directiveFor2(at(420, arena), live, newLife(), P, false, [], w).leash, 'plan-2 itself does not cash on the horde\'s damage: it cost six rounds');
  const fallen = newLife(); fallen.otAt = 2000; fallen.revivedAt = 2100;
  assert.equal(directiveFor2(at(10, arena), live, fallen, P, false, [], w).goto?.kind, 'cash');
});
