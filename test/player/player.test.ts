import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { Snapshot } from '../../src/observations/snapshot.ts';
import { choose, scoreLevelUp, vitaminPhase, worthNow } from '../../src/player/chooser.ts';
import type { ChooserContext } from '../../src/player/chooser.ts';
import { PLAN, PLANS, planWith } from '../../src/player/plan.ts';
import { directiveFor, errandFor, hordeHit, newLife, spawnEstimate } from '../../src/player/policy.ts';
import type { World } from '../../src/player/policy.ts';
import { ARCHIVE_NAMES, archiveOf, DIRECTION, itemWorth, kitOf, loadValuationKnowledge, textMultiplier, vitaminWorth } from '../../src/player/values.ts';
import { DEFAULT_TUNING } from '../../src/player/brain/tuning.ts';
import { buildFor } from '../../src/player/brain/builds.ts';

// The plan's rules outside a Pokémon's build (that is kit.test.ts) and the valuation. No game is loaded here.

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
  for (const key of ['tm-case', 'max-ether', 'focus-band', 'berry-juice', 'metronome', 'razor-fang', 'up-grade', 'stick']) assert.ok(worth(key) >= 10, `${key} has no stat line and is still worth something: ${worth(key)}`);
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

test('the direction: luck, experience and Pokédollars above a damage item of their rarity; taking hits at a fraction', () => {
  assert.equal(DIRECTION.version, 'luck-experience-1');
  assert.equal(PLAN.direction, DIRECTION);
  assert.ok(worth('comet-shard') > worth('twisted-spoon') && worth('exp-share') > worth('wise-glasses'));
  for (const key of ['berry-juice', 'shell-bell', 'leftovers', 'assault-vest']) assert.ok(worth(key) > 0 && worth(key) < worth('exp-share'), `${key}: worth something, less than a lever`);
  assert.ok(worth('max-revive') >= 60, 'a second life keeps its worth: staying in a final swarm rests on it');
});

test('the item archive stack-2: every slot of the account, and what can be stacked stays in the pool', () => {
  assert.deepEqual(ARCHIVE_NAMES, ['stack-2']);
  const stack = archiveOf('stack-2', k, mewtwo, 105), pool = [...k.items.keys()].filter((x) => !stack.includes(x));
  assert.equal(stack.length, 105, 'every slot of the account is used');
  assert.equal(archiveOf('stack-2', k, mewtwo, 60).length, 60, 'never more than the slots');
  // What the leaderboard Mewtwo held ten of, as far as the direction values it, and what a run cannot do without.
  for (const key of ['comet-shard', 'exp-share', 'lucky-egg', 'star-piece', 'amulet-coin', 'twisted-spoon', 'wise-glasses', 'shiny-stone', 'dusk-stone', 'razor-claw', 'metronome', 'pp-max', 'cleanse-tag', 'macho-brace', 'max-revive', 'revive', 'tm-case', 'max-ether']) assert.ok(pool.includes(key), `${key} stays in the pool`);
  const unlimited = pool.filter((x) => k.items.get(x)!.maxStack == null).length;
  assert.ok(unlimited >= 13 && unlimited / pool.length > 0.3, `a third of the pool or more stacks without a limit of its own (${unlimited} of ${pool.length})`);
  // For another kit the archive is another one: it is generated, not listed.
  assert.notDeepEqual(archiveOf('stack-2', k, kitOf(k, 32), 105), stack);
  assert.throws(() => archiveOf('narrow-9', k, mewtwo, 105), /unknown archive "narrow-9"/);
});

const snap = (over: Record<string, unknown>): Snapshot => ({ t: 100, stage: 1, stageTime: 100, stageCleared: false, bossSpawned: false, gold: 0, ballCost: 50, points: [], player: { hp: 200, maxHp: 200, level: 20, species: 150, moves: [{ key: 'psycho-cut', name: 'Psycho Cut', cls: 'physical' }], moveSlots: 4, items: {}, vitamins: {} }, ...over } as unknown as Snapshot);
const ctx: ChooserContext = { build: buildFor(150), tuning: DEFAULT_TUNING, plan: PLAN, knowledge: k, kit: mewtwo };
const offer = (data: Record<string, unknown>) => ({ id: 'x', label: '', data });
const world = (o: Partial<World> = {}): World => ({ gold: 0, ballPrice: 50, cagePrice: 30, slotPrice: 40, items: 0, spawn: 1.6, ...o });
const point = (kind: string, d: number, o: Record<string, unknown> = {}) => ({ kind, sub: '', x: d, z: 0, r: 2, used: false, cost: 0, d, ...o });
const OT = { live: false, over: false, direct: false, round: 0 };

test('the plan: one current version, unknown keys refused, tuning merged, the default never written into', () => {
  assert.deepEqual(Object.keys(PLANS), ['plan-9']);
  assert.equal(planWith(undefined).version, 'plan-9');
  assert.deepEqual(planWith({ base: 'plan-9' }), PLAN);
  assert.throws(() => planWith({ base: 'plan-99' }), /no plan "plan-99"/);
  assert.throws(() => planWith({ leaveHP: 0.5 }), /no key "leaveHP"/);
  const p = planWith({ leaveHp: 0.5, tuning: { lootRange: 10 } });
  assert.deepEqual([p.leaveHp, p.tuning.lootRange, p.tuning.hordeSize, PLAN.leaveHp, PLAN.tuning.lootRange], [0.5, 10, PLAN.tuning.hordeSize, 0.4, 90]);
  const q = planWith({ sealMax: [1, 1, 1, 1] });
  q.sealMax[0] = 9; q.errands.push('x');
  assert.deepEqual([PLAN.sealMax[0], PLAN.errands.includes('x')], [3, false], 'an overridden plan never writes into the default');
  // Every Pokémon with a build: its favourites are moves of its kit, at most four.
  for (const [id, b] of Object.entries(PLAN.builds)) {
    assert.ok(b.favourites.length <= 4 && b.favourites.every((m) => b.kit.includes(m)), `build of ${id}`);
    assert.ok(b.fuse.length === 0 || b.fuse.length === 2, `build of ${id}: a fusion has two moves`);
    for (const m of [...b.kit, ...b.fuse]) assert.ok(k.moves.has(m), `build of ${id}: ${m} is a move of the game`);
  }
});

test('vitamins by phase: the farm set, then the final set from the plan\'s moment on; the risky ones after the moves at first', () => {
  const at = (stage: number, stageTime: number) => vitaminPhase(snap({ stage, stageTime }), PLAN)!;
  assert.deepEqual([at(1, 0).final, at(2, 1000).final, at(3, 719).final, at(3, 720).final, at(4, 0).final], [false, false, false, true, true]);
  assert.deepEqual([at(1, 0).wanted, at(1, 0).later, at(3, 800).wanted, at(3, 800).later], [PLAN.vitaminsFarm, PLAN.vitaminsFinal, PLAN.vitaminsFinal, []]);
  assert.equal(vitaminPhase(snap({}), planWith({ vitaminsFarm: [], vitaminsFinal: [] })), null, 'a plan without the lists has no phases');
  // Farming: the plan's vitamins before a move upgrade, in the plan's order; one of the final stage is left alone but
  // not banished; any other is junk.
  const farm = snap({ stage: 1, stageTime: 100, player: { ...snap({}).player, level: 200 } }), late = snap({ stage: 3, stageTime: 800 });
  const sc = (vit: string, where: Snapshot, kind = 'newVit') => scoreLevelUp(offer({ kind, vit }), where, ctx);
  const upMove = (where: Snapshot) => scoreLevelUp(offer({ kind: 'upMove', slot: 0 }), where, ctx).score;
  assert.ok(sc('exp-candy', farm).score > sc('cursed', farm).score && sc('cursed', farm).score > sc('star-piece-v', farm).score);
  assert.ok(sc('star-piece-v', farm).score > upMove(farm), 'a vitamin of the plan comes before a move upgrade');
  assert.deepEqual([sc('calcium', farm).score < 20, sc('calcium', farm).junk, sc('iron', farm).junk], [true, false, true]);
  assert.match(sc('calcium', farm).why, /not one of the plan's vitamins yet/);
  // Cursed Incense and Super Lure make the horde stronger: not before the build can take it, and never banished.
  assert.equal(PLAN.vitaminsRiskLevel, 120);
  const early = snap({ stage: 1, stageTime: 100, player: { ...farm.player, level: 50 } }), grown = snap({ stage: 1, stageTime: 400, player: { ...farm.player, level: 120 } });
  for (const vit of ['cursed', 'super-lure']) for (const kind of ['newVit', 'upVit']) {
    const e = sc(vit, early, kind);
    assert.ok(e.score < upMove(early) && e.score > sc('iron', early).score + 30 && !e.junk, `${vit} ${kind}: after the moves, before anything else, never banished (${e.score})`);
    assert.ok(sc(vit, grown, kind).score > 85 && sc(vit, grown, kind).score > upMove(grown), `${vit} ${kind}: first from level 120 on`);
  }
  assert.ok(sc('exp-candy', early).score > 85 && sc('nugget', early).score > 85, 'the others from the first level');
  // The final stage: the other set, and the farm vitamins are not taken again.
  assert.ok(sc('calcium', late).score > 85 && sc('hp-up', late).score > 85 && sc('exp-candy', late).score < 20);
  assert.match(sc('calcium', late).why, /for the final stage/);
  assert.equal(sc('nugget', late, 'upVit').score, 25, 'a held vitamin of the other phase is not levelled on purpose');
  // Without the lists a vitamin is scored by what a level is worth; what makes the horde bigger counts only with a full bar.
  const byWorth: ChooserContext = { ...ctx, plan: planWith({ vitaminsFarm: [], vitaminsFinal: [] }) };
  assert.match(scoreLevelUp(offer({ kind: 'newVit', vit: 'calcium' }), farm, byWorth).why, /a level/);
  assert.ok(worthNow('white-flute', farm, ctx) > worthNow('white-flute', snap({ player: { ...farm.player, hp: 80 } }), ctx));
  // Hypno is an errand in the final phase while a vitamin of the earlier one is held, also in a swarm and far away.
  const hyp = [point('hypno', 150)], none = planWith({ builds: {} });
  const errand = (stage: number, stageTime: number, vitamins: Record<string, number>, swarm = false) => errandFor(snap({ stage, stageTime, stageCleared: true, points: hyp, player: { ...snap({}).player, vitamins } }), world({}), 1, swarm, newLife(), none);
  assert.equal(errand(3, 700, { nugget: 12 }), null, 'not before the swap');
  assert.equal(errand(3, 800, { nugget: 12, calcium: 3 }, true)?.note, 'hypno');
  assert.equal(errand(3, 800, { calcium: 12, 'hp-up': 12 }, true), null, 'nothing left to forget');
});

test('a Pokémon the plan lists no build for: its own moves first, a special move borrowed, Bill and the lesson left', () => {
  const none: ChooserContext = { ...ctx, plan: planWith({ builds: {} }) }, s = snap({});
  const own = scoreLevelUp(offer({ kind: 'newMove', id: 540 }), s, none), up = scoreLevelUp(offer({ kind: 'upMove', slot: 0 }), s, none);
  assert.ok(own.score > up.score && !own.junk);
  const special = [...k.movesById.values()].find((m) => m.class === 'special' && m.type !== 'psychic')!, physical = [...k.movesById.values()].find((m) => m.class === 'physical')!;
  const sp = scoreLevelUp(offer({ kind: 'newMove', id: special.id, from: 25 }), s, none), ph = scoreLevelUp(offer({ kind: 'newMove', id: physical.id, from: 25 }), s, none);
  assert.ok(sp.score >= 80 && !sp.junk && ph.junk);
  const obs = (kind: string, extras: Record<string, boolean>) => ({ phase: 'choice', snapshot: s, decision: { kind, method: kind, options: [{ id: 'x', label: 'x', data: {} }], context: {} }, mask: { options: [true], extras } }) as never;
  assert.deepEqual(choose(obs('fusion', { leave: true }), none).action, { type: 'choice', extra: 'leave' });
  assert.deepEqual(choose(obs('lesson', { decline: true }), none).action, { type: 'choice', extra: 'decline' });
  assert.equal(errandFor(snap({ points: [point('bill', 20)] }), world({}), 1, false, newLife(), none.plan), null, 'the machine is not walked to');
});

test('errands: each map point under its own condition, the nearest first, the last metres through the horde', () => {
  const P = planWith({ builds: {} }), pts = [point('chest', 20), point('slots', 40), point('meowth', 50), point('cage', 60), point('freechest', 70), point('cursed', 80), point('ditto', 90)];
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
  // The walk: ordered through the horde; an errand not done in time is given up for the zone.
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

test('a zone: errands, Rhydon\'s roars, the guardian; then the portal stays closed and the swarm is fought next to it', () => {
  const w = world({ gold: 500 });
  const altar = point('boss', 12), far = point('boss', 200), ball = point('freechest', 20), chest = point('chest', 25), totem = point('rhydon', 260);
  const dir = (s: Record<string, unknown>, l = newLife(), swarm = false, plan = PLAN) => directiveFor(snap(s), OT, l, plan, swarm, [], w);
  const due = { stageTime: PLAN.wakeAfterSec[0], t: 1000 };
  // Before the wake time: errands. From it on: the altar, its last metres ordered through the horde.
  assert.equal(dir({ points: [altar, chest] }).goto?.kind, 'errand');
  const wake = dir({ points: [altar, chest], ...due }).goto!;
  assert.deepEqual([wake.kind, wake.force, wake.interact], ['wake', true, true]);
  assert.deepEqual([dir({ points: [far], ...due }).goto?.force], [true], 'a far altar too');
  assert.deepEqual(dir({ points: [altar], ...due, player: { ...snap({}).player, hp: 100 } }), {}, 'hurt: the walk is the brain\'s to break off');
  assert.equal(dir({ points: [altar], stageTime: 5, player: { ...snap({}).player, level: PLAN.wakeLevel[0] } }).goto?.kind, 'wake', 'or by level, whatever the clock');
  // The wake is due and the totem still answers (the game marks it used after the third roar): the totem first.
  const l = newLife(), go = dir({ points: [altar, totem], ...due }, l).goto!;
  assert.deepEqual([go.kind, go.x, go.force, go.interact], ['errand', 260, true, true]);
  assert.match(go.note, /Rhydon/);
  assert.equal(dir({ points: [altar, totem], ...due, t: 1050 }, l).goto?.x, 260, 'one or two roars made: it is pressed again');
  assert.equal(dir({ points: [altar, { ...totem, used: true }], ...due, t: 1060 }, l).goto?.kind, 'wake', 'three roars made: the guardian');
  // A totem that cannot be reached is given up after `roarTimeout` seconds, for the zone.
  const stuck = newLife();
  assert.equal(dir({ points: [altar, totem], ...due }, stuck).goto?.kind, 'errand');
  assert.equal(dir({ points: [altar, totem], ...due, t: 1000 + PLAN.roarTimeout + 1 }, stuck).goto?.kind, 'wake');
  assert.equal(dir({ points: [altar, totem], ...due, stage: 2, stageTime: PLAN.wakeAfterSec[1], t: 2000 }, stuck).goto?.kind, 'errand', 'the next zone has its own totem');
  assert.deepEqual(dir({ points: [altar, totem], ...due, player: { ...snap({}).player, hp: 100 } }), {}, 'hurt: neither walk is ordered');
  // Cleared: played on. In the swarm the prizes by the portal are still fetched; a paid ball is not.
  const cleared = { stageCleared: true, bossSpawned: true, stageTime: 610 };
  assert.deepEqual(dir({ ...cleared, points: [chest] }, newLife(), true), { holdPortal: true });
  assert.equal(dir({ ...cleared, points: [ball] }, newLife(), true).goto?.x, 20);
  assert.deepEqual(dir({ ...cleared, points: [point('portal', 10)] }, newLife(), true), { holdPortal: true, leash: { x: 10, z: 0, r: PLAN.stayLeash } }, 'the swarm is fought near the way out');
  const back = dir({ ...cleared, points: [point('portal', 40)] }, newLife(), true).goto!;
  assert.deepEqual([back.kind, back.force, back.interact, back.reach < PLAN.stayLeash], ['stay', true, false, true], 'from further away: back to it, through the horde, without taking it');
  assert.deepEqual(dir({ ...cleared, points: [point('portal', 40)] }, newLife(), false), { holdPortal: true }, 'before the swarm: anywhere');
  assert.deepEqual(dir({ ...cleared, stageTime: PLAN.leaveBySec[0], t: 660 }, newLife(), true), {}, 'the clock, before the collapse');
  const gone = newLife();
  assert.deepEqual(dir({ ...cleared, player: { ...snap({}).player, hp: 60 } }, gone, true), {}, 'under 40 % HP in the swarm: leave');
  assert.deepEqual(dir(cleared, gone, true), {}, 'the decision to leave is not taken back when HP recovers');
  assert.equal(dir({ ...cleared, stageTime: PLAN.leaveBySec[0], t: 1060, points: [ball] }, newLife(), true).goto?.x, 20, 'leaving, but a prize 20 m away is taken first');
});

test('leaving a cleared zone: the HP bar, the horde\'s hits and a spent revive count only once the final swarm has begun', () => {
  const w = world({ gold: 500 });
  const dir = (s: Record<string, unknown>, l = newLife(), swarm = false) => directiveFor(snap(s), OT, l, PLAN, swarm, [], w);
  const hurt = { ...snap({}).player, hp: 2 }, portal = point('portal', 10);
  // The guardian has just fallen, 86 s into the zone, and it left 2 HP of 200 (seed 28, zone 2).
  const fallen = { stage: 2, stageCleared: true, bossSpawned: true, stageTime: 86, t: 993, player: hurt, points: [portal] };
  const l = newLife();
  assert.ok(dir(fallen, l).holdPortal, 'the portal stays closed: the zone is not over');
  assert.ok(dir({ ...fallen, stageTime: 400, t: 1307 }, l).holdPortal, 'and still, for as long as there is no swarm');
  assert.equal(l.leaving.size, 0);
  assert.deepEqual(dir({ ...fallen, stageTime: 640, t: 1547 }, l, true), {}, 'in the swarm under 40 %: through the portal');
  assert.ok(dir({ ...fallen, stageTime: 640, t: 1547, player: snap({}).player }, newLife(), true).holdPortal, 'in the swarm with a full bar: it stays');
  // A revive spent after the guardian fell but before the swarm does not end the stay, in the swarm it does.
  const full = { ...fallen, player: snap({}).player };
  const early = newLife(); dir(full, early); early.revivedAt = 1000;
  assert.ok(dir({ ...full, stageTime: 300, t: 1207 }, early).holdPortal, 'a revive before the swarm');
  assert.ok(dir({ ...full, stageTime: 610, t: 1517 }, early, true).holdPortal, 'and the swarm then begins: that revive is not held against it');
  early.revivedAt = 1530;
  assert.deepEqual(dir({ ...full, stageTime: 630, t: 1537 }, early, true), {}, 'a revive spent in the swarm: through the portal');
  // The swarm can begin while the guardian still stands: what counts is then the moment it falls.
  const late = newLife(); late.revivedAt = 1520;
  assert.ok(dir({ ...full, stageTime: 650, t: 1557 }, late, true).holdPortal, 'a revive spent on the guardian, in the swarm, before it fell');
  assert.equal(late.swarmAt, 1557);
  dir({ stage: 3, stageTime: 1, t: 1600 }, late);
  assert.equal(late.swarmAt, null, 'a new zone starts afresh');
  // The horde's damage, not the HP bar, says when a swarm has become deadly: without a revive, a hit that would take
  // all of max HP ends the stay at full HP. Enemy tuples: [i, x, z, vx, vz, hp, maxHp, radius, dmg, speed, flags, species].
  const foe = (dmg: number, flags = 0) => [0, 5, 5, 0, 0, 10, 10, 0.5, dmg, 3, flags, 19];
  const at = (dmg: number, o: Record<string, unknown> = {}) => snap({ stageCleared: true, bossSpawned: true, stageTime: 700, points: [point('portal', 8)], enemies: { count: 4, list: [foe(dmg), foe(dmg), foe(dmg), foe(dmg * 0.5), foe(1e6, 4)] }, shots: [], player: { ...snap({}).player, stats: { armor: 45 } }, ...o });
  assert.ok(Math.abs(hordeHit(at(100)) - 0.25) < 1e-9, 'the guardian\'s own damage is not the horde\'s (200 max HP, armor 45 halves a hit)');
  assert.ok(Math.abs(hordeHit(at(100, { shots: [[0, 0, 1, 0, 0.4, 400]] })) - 1) < 1e-9, 'a shot in the air counts');
  assert.ok(directiveFor(at(300), OT, newLife(), PLAN, true, [], w).holdPortal, 'three quarters of max HP a hit: stay');
  assert.deepEqual(directiveFor(at(420), OT, newLife(), PLAN, true, [], w), {}, 'a hit would take all of max HP: through the portal, at full HP');
  assert.ok(directiveFor(at(420), OT, newLife(), PLAN, false, [], w).holdPortal, 'the rule is the swarm\'s');
  const insured = newLife(); insured.revives = 1;
  assert.ok(directiveFor(at(4000), OT, insured, PLAN, true, [], w).holdPortal, 'with a revive held the stay goes on: the revive is the warning');
});

test('Overtime: fought by the portal, cashed on the HP bar, the tide, a spent revive or the last round', () => {
  const w = world({}), portal = point('portal', 6), live = { ...OT, live: true, round: 3 };
  const dir = (s: Record<string, unknown>, ot: Record<string, unknown> = live, l = newLife()) => directiveFor(snap({ stage: 4, points: [portal], t: 104, ...s }), ot as never, l, PLAN, false, [], w);
  const calm = dir({});
  assert.ok(calm.holdPortal && calm.leash && !calm.goto);
  assert.deepEqual(calm.leash, { x: 6, z: 0, r: PLAN.leash });
  const cash = dir({ player: { ...snap({}).player, hp: 50 } });
  assert.deepEqual([cash.goto?.kind, cash.goto?.force, cash.goto?.interact], ['cash', true, true], 'under 30 % HP');
  assert.ok(dir({ player: { ...snap({}).player, hp: 80 } }).leash, '40 % HP: on');
  assert.ok(dir({}, { ...live, round: 11, drain: 150 }).leash, 'the tide at three quarters of a bar a second: on');
  assert.equal(dir({}, { ...live, round: 18, drain: 200 }).goto?.kind, 'cash', 'a whole bar a second: cash');
  assert.equal(dir({}, { ...live, round: PLAN.cashAfterRound + 1 }).goto?.kind, 'cash');
  const revived = newLife(); dir({}, live, revived); revived.revivedAt = 110;
  assert.match(dir({ t: 111 }, live, revived).goto?.note ?? '', /a revive spent/);
  const committed = newLife(); dir({ player: { ...snap({}).player, hp: 50 } }, live, committed);
  assert.equal(dir({}, live, committed).goto?.kind, 'cash', 'once cashing, always: the bar reading high again does not call it off');
  // The sanctuary before Overtime: a rest after the legendary, then nothing is ordered.
  const rest = newLife();
  assert.ok(directiveFor(snap({ stage: 4, stageCleared: true, player: { ...snap({}).player, hp: 100 } }), OT, rest, PLAN, false, [], w).holdPortal);
  assert.deepEqual(directiveFor(snap({ stage: 4, stageCleared: true, t: 200, player: { ...snap({}).player, hp: 100 } }), OT, rest, PLAN, false, [], w), {});
});

test('answers: slot spins by price, restocks, seals from the list', () => {
  const obs = (kind: string, options: { id: string; data?: Record<string, unknown> }[], context: Record<string, unknown>, extras: Record<string, boolean>, s = snap({})) =>
    ({ phase: 'choice', snapshot: s, decision: { kind, method: kind, options: options.map((o) => ({ id: o.id, label: o.id, data: o.data ?? {} })), context }, mask: { options: options.map(() => true), extras } }) as never;
  const slots = (cost: number, gold: number) => choose(obs('slots', [{ id: 'spin' }], { cost, gold }, { leave: true }), ctx).action;
  assert.deepEqual(slots(40, 1000), { type: 'choice', option: 0 });
  assert.deepEqual(slots(140, 1000), { type: 'choice', extra: 'leave' });
  // The shop: what is worth holding first, then a new stock while it is cheap, then leave.
  const worthless = [...k.items.keys()].sort((a, b) => worthNow(a, snap({}), ctx) - worthNow(b, snap({}), ctx))[0];
  const stock = [{ id: 'twisted-spoon', data: { key: 'twisted-spoon', price: 100 } }, { id: worthless, data: { key: worthless, price: 80 } }];
  assert.deepEqual(choose(obs('shop', stock, { gold: 5000, rerollCost: 40 }, { reroll: true, leave: true }), ctx).action, { type: 'choice', option: 0 });
  const junk = [stock[1]];
  assert.deepEqual(choose(obs('shop', junk, { gold: 5000, rerollCost: 40 }, { reroll: true, leave: true }), ctx).action, { type: 'choice', extra: 'reroll' });
  assert.deepEqual(choose(obs('shop', junk, { gold: 5000, rerollCost: 900 }, { reroll: true, leave: true }), ctx).action, { type: 'choice', extra: 'leave' });
  // Seals: as many of the plan's list as are offered; a seal not on the list ("heal") is never put on.
  const subsets = (offers: string[]) => Array.from({ length: 1 << offers.length }, (_v, m) => offers.filter((_o, i) => m & (1 << i))).map((x) => ({ id: x.join('+') || 'none', data: { seals: x } }));
  const seal = (offers: string[], c = ctx) => { const o = subsets(offers); return o[(choose(obs('seals', o, {}, { decline: true }), c).action as { option: number }).option].id; };
  assert.equal(seal(['swift', 'clock', 'echo']), 'swift+clock+echo');
  assert.equal(seal(['swift', 'heal', 'echo']), 'swift+echo');
  assert.equal(seal(['heal']), 'none');
  assert.equal(seal(['swift', 'clock', 'echo'], { ...ctx, plan: planWith({ sealMax: [1] }) }), 'clock', 'one seal: the first of the list');
});

test('the spawn multiplier is estimated from the tier, what is held and the curses taken', () => {
  const s = snap({ diff: { enemyHp: 1.9, enemyDamage: 1.96, enemySpeed: 1.16, enemyAmount: 1.6 } });
  const st = (items: { key: string; count: number }[], vitamins: { key: string; level: number }[], pointsUsed: Record<string, number>) => ({ build: { items, vitamins }, pointsUsed }) as never;
  assert.ok(Math.abs(spawnEstimate(s, st([], [], {}), k, 0) - 1.6) < 1e-9);
  assert.ok(Math.abs(spawnEstimate(s, st([{ key: 'white-flute', count: 2 }], [], {}), k, 0) - 1.6 * 1.12 ** 2) < 1e-9);
  assert.ok(Math.abs(spawnEstimate(s, st([], [{ key: 'cursed', level: 5 }], { cursed: 1, greed: 1 }), k, 1) - 1.6 * 1.6 * 1.265 * 1.2 * 1.1025) < 1e-9);
});
