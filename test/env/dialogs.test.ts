import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DialogCapture, HANDLED_METHODS, resolveBuildNames } from '../../src/environment/dialogs.ts';
import type { BuildNames } from '../../src/environment/dialogs.ts';
import type { GameFns } from '../../src/environment/gamefns.ts';
import { choiceActionProblem } from '../../src/environment/GameEnvironment.ts';

// The dialog layer against a stand-in HUD and run: no game is loaded in this file. What is checked is the
// protocol: which callback arguments each answer produces, and that nothing unknown passes silently.
// (The same layer against the real game: test/env/environment.test.ts.)

const NAMES: BuildNames = { shopBuy: 'buy', shopReroll: 'restock', shopRerollCost: 'restockCost', playerCanTake: 'canTake', hudFusion: 'fusion', hudPause: 'pauseMenu' };
const METHODS = ['showLevelUp', 'showBranch', 'showItem', 'showItemChoice', 'showBlessing', 'showSeals', 'showSanctuaryPath', 'showLeaveSanctuary', 'showOvertime', 'showOtOffer',
  'showTrade', 'showShop', 'showDitto', 'showParty', 'showShinySwap', 'relicChoice', 'showDojo', 'showSlots', 'showForget', 'fusion', 'showPact', 'showBadges', 'showExpInventory',
  'showTraining', 'showRelayRecruit', 'showMap', 'pauseMenu', 'modal'];

/** Stand-ins for the game's own functions (src/environment/gamefns.ts): each does what the real one does to the stand-in run. */
const FNS: GameFns = {
  forgetMove: (r: any, slot: number) => { const pay = r.player.moves[slot].level * 8; r.player.moves[slot] = null; r.gain(pay); r.stats.forgets++; return pay; },
  forgetVitamin: (r: any, key: string) => { const pay = r.player.vitamins.get(key).level * 6; r.player.vitamins.delete(key); r.gain(pay); r.stats.forgets++; return pay; },
  lessonReady: (r: any) => r.lessonAt !== 's1',
  lessonKey: () => 's1',
  lessonOffers: (r: any, n: number) => { r.lessonRolls++; return r.lessonPool.slice(0, n); },
  applyOffer: (r: any, o: any) => { r.applied.push(o.key); if (o.kind === 'newMove') r.player.moves[r.player.moves.indexOf(null)] = { def: { id: o.id, key: o.key, name: o.key }, level: 1, parents: [] }; },
  movePrice: (_r: unknown, m: any) => m.level * 8,
  vitaminPrice: (_r: unknown, v: any) => v.level * 6,
  slotCost: () => 40,
  sellPrice: (_r: unknown, rarity: number) => [10, 18, 30, 50, 90][rarity],
  dojoPrizes: (_r: unknown, belt: number) => [{ label: '+17% damage', mods: [{ stat: 'damage', mul: 1.17 }], rarity: belt + 1 }, { label: '+29 max HP', mods: [{ stat: 'maxHp', add: 29 }], rarity: belt + 1 }],
  dojoParams: (_r: unknown, t: any) => ({ goal: 10 * t.belt, limit: 20 + t.belt }),
  items: new Map([['leftovers', { rarity: 2 }], ['charcoal', { rarity: 0 }]]),
  runGainGold: 'gain',
  sources: {},
};
const move = (id: number, key: string, level: number, extra: Record<string, unknown> = {}) => ({ def: { id, key, name: key }, level, parents: [], link: null, ...extra });

function setup(runOver: Partial<Record<string, unknown>> = {}) {
  const built: unknown[][] = [];
  const hud: Record<string, any> = {};
  for (const m of METHODS) hud[m] = (...a: unknown[]) => { built.push([m, ...a]); return {}; };
  const run: Record<string, any> = {
    state: 'modal', rerolls: 2, skips: 0, banishes: 1, pendingLevels: 1, gold: 100, competitive: true,
    player: {
      level: 5, speciesId: 155, items: new Map([['leftovers', 1], ['charcoal', 10]]), canTake: (k: string) => k !== 'charcoal',
      moveSlots: 4, moves: [move(1, 'm1', 3), move(2, 'm2', 2), null, null], vitamins: new Map([['protein', { level: 2 }]]), recomputed: 0,
      recompute() { this.recomputed++; },
      removeItem(k: string) { const n = this.items.get(k) ?? 0; if (n <= 1) this.items.delete(k); else this.items.set(k, n - 1); },
    },
    econ: { shop: 0, sold: 0 }, stats: { lessons: 0, forgets: 0 }, lessonAt: '', lessonRolls: 0, applied: [] as string[],
    lessonPool: [{ kind: 'newMove', key: 'm9', id: 9 }, { kind: 'newMove', key: 'm8', id: 8 }, { kind: 'newVit', key: 'vnugget', vit: 'nugget' }],
    gain(n: number) { this.gold += n; },
    seals: { kept: 2 }, overtime: { round: 1, picks: [['dique', 0]], bonus: 12 }, relicKeys: [], allies: { list: [] },
    shop: { stock: [{ key: 'a', price: 50, sold: false }, { key: 'b', price: 500, sold: false }, { key: 'charcoal', price: 1, sold: false }], rerolls: 0 },
    buy(e: any) { if (e.sold || this.gold < e.price || !this.player.canTake(e.key)) return false; this.gold -= e.price; e.sold = true; return true; },
    restock() { if (this.gold < this.restockCost()) return false; this.gold -= this.restockCost(); this.shop.stock = [{ key: 'c', price: 10, sold: false }]; return true; },
    restockCost() { return 30; },
    ...runOver,
  };
  const cap = new DialogCapture(NAMES, FNS);
  const replaced = cap.install(hud, run);
  return { cap, hud, run, built, replaced };
}
const answer = (cap: DialogCapture, a: any) => { assert.equal(choiceActionProblem(a, cap.pending!.mask()), null); cap.pending!.answer(a); };

test('install replaces every dialog method on the instance and builds no window', () => {
  const { hud, built, replaced, cap } = setup();
  assert.equal(replaced.length, METHODS.length);
  hud.showLevelUp({ player: { level: 2 } }, [{ kind: "upMove", key: "m1" }], () => undefined);
  assert.equal(built.length, 0, 'the original HUD method was not called');
  assert.equal(cap.pending!.decision.kind, 'levelup');
  assert.equal(HANDLED_METHODS.length, 20);
});

test('level-up: take, refresh, skip, banish and banish-kit use the game\'s callback protocol', () => {
  const offers = [{ kind: 'newMove', key: 'm915', id: 915, from: 4 }, { kind: 'upMove', key: 'm1' }, { kind: 'newVit', key: 'vnugget', vit: 'nugget' }];
  const calls: unknown[][] = [];
  const { cap, hud, run } = setup();
  const open = () => hud.showLevelUp(run, offers, (...a: unknown[]) => calls.push(a));
  open();
  const d = cap.pending!.decision;
  assert.deepEqual(d.options.map((o) => o.id), ['newMove:m915', 'upMove:m1', 'newVit:vnugget']);
  assert.deepEqual(d.context, { rerolls: 2, skips: 0, banishes: 1, pendingLevels: 1, level: 5 });
  assert.deepEqual(cap.pending!.mask(), { phase: 'choice', options: [true, true, true], extras: { refresh: true, skip: false, banish: [true, true, true], banishKit: [true, false, false] } });
  assert.match(choiceActionProblem({ type: 'choice', extra: 'skip' }, cap.pending!.mask())!, /masked/);
  answer(cap, { type: 'choice', option: 1 });
  assert.equal(cap.pending, null);
  open(); answer(cap, { type: 'choice', extra: 'refresh' });
  open(); answer(cap, { type: 'choice', extra: 'banish', target: 2 });
  open(); answer(cap, { type: 'choice', extra: 'banishKit', target: 0 });
  assert.deepEqual(calls, [[offers[1]], [null, 'reroll'], [offers[2], 'banish'], [offers[0], 'banishKit']]);
  // The decision is a copy: changing it does not touch the game's offer objects.
  (d.options[0].data as Record<string, unknown>).key = 'changed';
  assert.equal(offers[0].key, 'm915');
  // Uses left drive the mask.
  run.rerolls = 0; run.banishes = 0;
  open();
  assert.deepEqual(cap.pending!.mask().extras, { refresh: false, skip: false, banish: [false, false, false], banishKit: [false, false, false] });
});

test('found item: option 0 takes, "sell" sells; item choice: a key or none', () => {
  const calls: unknown[] = [];
  const { cap, hud, run } = setup();
  hud.showItem(run, 'leftovers', (v: boolean) => calls.push(v));
  assert.deepEqual(cap.pending!.decision.options[0], { id: 'leftovers', label: 'leftovers', data: { key: 'leftovers', owned: 1 } });
  answer(cap, { type: 'choice', option: 0 });
  hud.showItem(run, 'leftovers', (v: boolean) => calls.push(v));
  answer(cap, { type: 'choice', extra: 'sell' });
  hud.showItemChoice(run, ['x', 'y'], (v: string | null) => calls.push(v));
  answer(cap, { type: 'choice', option: 1 });
  hud.showItemChoice(run, ['x', 'y'], (v: string | null) => calls.push(v));
  answer(cap, { type: 'choice', extra: 'sell' });
  assert.deepEqual(calls, [true, false, 'y', null]);
});

test('seals: every subset of the offered seals, or not now', () => {
  const calls: unknown[] = [];
  const { cap, hud, run } = setup();
  const open = () => hud.showSeals(run, { species: 123, legendary: false, offers: ['swift', 'heal', 'clock'], kept: 2 }, (v: unknown) => calls.push(v));
  open();
  const d = cap.pending!.decision;
  assert.equal(d.options.length, 8);
  assert.deepEqual(d.options.map((o) => o.id), ['none', 'swift', 'heal', 'swift+heal', 'clock', 'swift+clock', 'heal+clock', 'swift+heal+clock']);
  answer(cap, { type: 'choice', option: 0 });
  open(); answer(cap, { type: 'choice', option: 7 });
  open(); answer(cap, { type: 'choice', option: 5 });
  open(); answer(cap, { type: 'choice', extra: 'decline' });
  assert.deepEqual(calls, [[], ['swift', 'heal', 'clock'], ['swift', 'clock'], null]);
});

test('sanctuary path, leaving the sanctuary, overtime start and tide offerings', () => {
  const calls: unknown[] = [];
  const cb = (v: unknown) => calls.push(v);
  const { cap, hud, run } = setup();
  hud.showSanctuaryPath(run, 151, cb); assert.equal(cap.pending!.decision.context.competitive, true); answer(cap, { type: 'choice', option: 0 });
  hud.showSanctuaryPath(run, 151, cb); answer(cap, { type: 'choice', option: 1 });
  hud.showSanctuaryPath(run, 151, cb); answer(cap, { type: 'choice', extra: 'decline' });
  hud.showLeaveSanctuary(run, cb); answer(cap, { type: 'choice', option: 0 });
  hud.showLeaveSanctuary(run, cb); answer(cap, { type: 'choice', option: 1 });
  hud.showLeaveSanctuary(run, cb); answer(cap, { type: 'choice', extra: 'decline' });
  hud.showOvertime(run, cb); answer(cap, { type: 'choice', option: 0 });
  hud.showOvertime(run, cb); answer(cap, { type: 'choice', extra: 'decline' });
  hud.showOtOffer(run, ['dique', 'cebo', 'pleamar'], cb);
  assert.deepEqual(cap.pending!.decision.context, { round: 2, held: ['dique'], bonus: 12 });
  answer(cap, { type: 'choice', option: 1 });
  hud.showOtOffer(run, ['dique', 'cebo', 'pleamar'], cb); answer(cap, { type: 'choice', extra: 'decline' });
  assert.deepEqual(calls, ['sanct', 'direct', null, 'ot', 'leave', null, true, false, 'cebo', null]);
});

test('evolution: staying needs the stay option, and an Everstone when the game says it is missing', () => {
  const calls: unknown[] = [];
  const cb = (v: unknown) => calls.push(v);
  const { cap, hud, run } = setup();
  hud.showBranch(run, [156], cb, {});
  assert.deepEqual(cap.pending!.mask(), { phase: 'choice', options: [true], extras: {} });
  assert.match(choiceActionProblem({ type: 'choice', extra: 'decline' }, cap.pending!.mask())!, /no extra action/);
  answer(cap, { type: 'choice', option: 0 });
  hud.showBranch(run, [134, 135, 136], cb, { stay: 133, stone: 'missing' });
  assert.deepEqual(cap.pending!.mask().extras, { decline: false });
  answer(cap, { type: 'choice', option: 2 });
  hud.showBranch(run, [156], cb, { stay: 155, stone: 'use' });
  answer(cap, { type: 'choice', extra: 'decline' });
  assert.deepEqual(calls, [156, 136, -1]);
});

test('trade, blessing, Ditto, party, shiny swap and relics', () => {
  const calls: unknown[] = [];
  const cb = (...v: unknown[]) => calls.push(v.length === 1 ? v[0] : v);
  const { cap, hud, run } = setup();
  hud.showTrade(run, { title: 'Fossil', help: '', species: 142, offers: [{ key: 'a', name: 'A' }, { key: 'b', name: 'B', off: true }] }, cb);
  assert.deepEqual(cap.pending!.mask().options, [true, false]);
  answer(cap, { type: 'choice', option: 0 });
  const bless = [{ label: '+5% damage', rarity: 1, mods: [{ stat: 'damage', add: 0.05 }] }, { label: '+3 luck', rarity: 0, mods: [] }];
  hud.showBlessing(run, 'Altar', bless, cb);
  assert.deepEqual(cap.pending!.mask(), { phase: 'choice', options: [true, true], extras: {} });
  answer(cap, { type: 'choice', option: 1 });
  hud.showDitto(run, cb);
  assert.deepEqual(cap.pending!.mask().options, [true, false], 'an item at its maximum cannot be copied');
  answer(cap, { type: 'choice', option: 0 });
  run.allies.list = [{ name: 'A', species: 1 }, { name: 'S', species: 2, shiny: true }];
  hud.showParty(run, { name: 'New', species: 3 }, cb);
  assert.deepEqual(cap.pending!.mask().options, [true, false], 'the shiny partner cannot be released');
  answer(cap, { type: 'choice', extra: 'decline' });
  hud.showShinySwap(run, { name: 'Old' }, { name: 'New' }, null, cb);
  answer(cap, { type: 'choice', option: 0 });
  hud.relicChoice(run, [{ key: 'r1', name: 'R1', rarity: 2 }, { key: 'r2', name: 'R2', rarity: 0 }], cb);
  assert.deepEqual(cap.pending!.decision.options.map((o) => o.id), ['r1', 'r2']);
  answer(cap, { type: 'choice', option: 1 });
  run.relicKeys = ['x', 'y', 'z'];
  hud.relicChoice(run, [{ key: 'r1', name: 'R1' }], cb);
  assert.deepEqual(cap.pending!.decision.options.map((o) => o.id), ['r1@0', 'r1@1', 'r1@2']);
  answer(cap, { type: 'choice', option: 2 });
  hud.relicChoice(run, [{ key: 'r1', name: 'R1' }], cb);
  answer(cap, { type: 'choice', extra: 'decline' });
  assert.deepEqual(calls, ['a', bless[1], 'leftovers', -1, true, ['r2', null], ['r1', 2], [null, null]]);
});

test('shop: buying and restocking go through the game\'s own functions and the window stays open', () => {
  let closed = 0;
  const { cap, hud, run } = setup();
  hud.showShop(run, () => { closed++; });
  assert.deepEqual(cap.pending!.mask(), { phase: 'choice', options: [true, false, false], extras: { reroll: true, sell: true, leave: true } });
  assert.equal(cap.pending!.decision.context.rerollCost, 30);
  answer(cap, { type: 'choice', option: 0 });
  assert.equal(run.gold, 50);
  assert.equal(cap.pending!.decision.kind, 'shop', 'still open after a purchase');
  assert.deepEqual(cap.pending!.mask().options, [false, false, false], 'sold, too expensive, at maximum');
  answer(cap, { type: 'choice', extra: 'reroll' });
  assert.equal(run.gold, 20);
  assert.deepEqual(cap.pending!.decision.options.map((o) => o.id), ['c']);
  assert.equal(cap.pending!.mask().extras.reroll, false);
  answer(cap, { type: 'choice', extra: 'leave' });
  assert.equal(closed, 1);
  assert.equal(cap.pending, null);
  assert.equal(cap.failure, null);
});

test('shop: selling an owned item does what the sell button does, and comes back to the shop', () => {
  let closed = 0;
  const { cap, hud, run } = setup();
  hud.showShop(run, () => { closed++; });
  answer(cap, { type: 'choice', extra: 'sell' });
  const d = cap.pending!.decision;
  assert.equal(d.kind, 'shopSell');
  assert.deepEqual(d.options.map((o) => [o.id, o.data.owned, o.data.refund]), [['leftovers', 1, 30], ['charcoal', 10, 10]], 'the price of the item\'s rarity, from the game\'s own function');
  answer(cap, { type: 'choice', option: 0 });
  assert.deepEqual([run.gold, run.econ.sold, run.player.items.has('leftovers')], [130, 1, false]);
  assert.equal(cap.pending!.decision.kind, 'shopSell', 'the list stays open while there is something to sell');
  answer(cap, { type: 'choice', option: 0 });
  assert.deepEqual([run.gold, run.econ.sold, run.player.items.get('charcoal')], [140, 2, 9], 'one of a stack');
  assert.equal(cap.shopSold, 2, 'the sales made in the shop are counted (reward v2 takes reward away for each)');
  answer(cap, { type: 'choice', extra: 'leave' });
  assert.equal(cap.pending!.decision.kind, 'shop', 'leaving the list goes back to the shop');
  run.player.items.clear();
  assert.equal(cap.pending!.mask().extras.sell, false, 'nothing to sell');
  answer(cap, { type: 'choice', extra: 'leave' });
  assert.deepEqual([closed, cap.pending, cap.failure], [1, null, null]);
});

test('dojo: a trial, then the blessing to fight for; the game gets { trial, stat } or null', () => {
  const calls: unknown[] = [];
  const trials = [{ key: 'rush', belt: 1 }, { key: 'circle', belt: 2 }, { key: 'race', belt: 3 }];
  const { cap, hud, run } = setup();
  const open = () => hud.showDojo(run, trials, 'damage', (v: unknown) => calls.push(v));
  open();
  let d = cap.pending!.decision;
  assert.equal(d.kind, 'dojo');
  assert.deepEqual(d.options.map((o) => [o.id, o.data.goal, o.data.limit]), [['rush:1', 10, 21], ['circle:2', 20, 22], ['race:3', 30, 23]], 'the trial\'s numbers come from the game\'s own function');
  assert.deepEqual(cap.pending!.mask(), { phase: 'choice', options: [true, true, true], extras: { decline: true } });
  answer(cap, { type: 'choice', option: 1 });
  assert.deepEqual(calls, [], 'nothing is sent to the game before the blessing is chosen');
  d = cap.pending!.decision;
  assert.equal(d.kind, 'dojoPrize');
  assert.deepEqual(d.options.map((o) => [o.id, o.data.rarity]), [['damage', 3], ['maxHp', 3]], 'the prizes of that trial\'s belt');
  assert.deepEqual(d.context.trial, { key: 'circle', belt: 2 });
  answer(cap, { type: 'choice', option: 1 });
  assert.deepEqual(calls, [{ trial: trials[1], stat: 'maxHp' }]);
  assert.equal(calls.length && (calls[0] as { trial: unknown }).trial, trials[1], 'the game\'s own trial object is handed back');
  open(); answer(cap, { type: 'choice', extra: 'decline' });
  open(); answer(cap, { type: 'choice', option: 0 }); answer(cap, { type: 'choice', extra: 'decline' });
  assert.deepEqual(calls.slice(1), [null, null]);
  assert.equal(cap.pending, null);
});

test('slot machine: one spin through the game\'s own spin and payout; a prize closes the window, a miss keeps it open', async () => {
  const log: string[] = [];
  const { cap, hud, run } = setup();
  const results = [{ prize: 'none', cost: 40, reels: [] }, { prize: 'meowth', cost: 43, reels: [] }, { prize: 'pikachu', cost: 46, reels: [], insured: true }];
  let spins = 0;
  const api = {
    cost: () => 40 + 3 * spins, spins: () => spins, pity: () => 6 - spins, cursed: () => false,
    spin: async () => { await null; if (run.gold < api.cost()) return null; const r = results[spins]; run.gold -= r.cost; spins++; log.push(`spin ${r.prize}`); return r; },
    pay: (r: { prize: string }) => { log.push(`pay ${r.prize}`); return r.prize === 'pikachu'; },
  };
  run.gold = 200;
  hud.showSlots(run, api, () => log.push('closed'));
  let d = cap.pending!.decision;
  assert.equal(d.kind, 'slots');
  assert.deepEqual(d.options.map((o) => [o.id, o.data.price]), [['spin', 40]]);
  assert.deepEqual([d.context.cost, d.context.spins, d.context.spinsUntilInsured, d.context.last], [40, 0, 6, null]);
  assert.deepEqual(cap.pending!.mask(), { phase: 'choice', options: [true], extras: { leave: true } });
  const out = cap.pending!.answer({ type: 'choice', option: 0 });
  assert.ok(out instanceof Promise, 'a spin is asynchronous: the environment waits for it');
  assert.equal(cap.pending, null, 'nothing can be answered while the spin is under way');
  await out;
  d = cap.pending!.decision;
  assert.deepEqual([d.kind, d.context.cost, d.context.last], ['slots', 43, { prize: 'none', cost: 40, insured: false }], 'a miss: the window is still open');
  await cap.pending!.answer({ type: 'choice', option: 0 });
  assert.deepEqual(cap.pending!.decision.context.last, { prize: 'meowth', cost: 43, insured: false }, 'Pay Day pays Pokédollars and the window stays open');
  await cap.pending!.answer({ type: 'choice', option: 0 });
  assert.equal(cap.pending, null, 'an item prize closes the window, as the HUD does');
  assert.deepEqual(log, ['spin none', 'pay none', 'spin meowth', 'pay meowth', 'spin pikachu', 'pay pikachu', 'closed']);
  // Too poor for a spin: masked. Leaving closes.
  run.gold = 10;
  hud.showSlots(run, api, () => log.push('closed again'));
  assert.deepEqual(cap.pending!.mask().options, [false]);
  assert.match(choiceActionProblem({ type: 'choice', option: 0 }, cap.pending!.mask())!, /masked/);
  answer(cap, { type: 'choice', extra: 'leave' });
  assert.equal(log.at(-1), 'closed again');
  assert.equal(cap.failure, null);
});

test('Hypno: forget a move or a vitamin through the game\'s functions; the lesson of the zone, once', () => {
  let closed = 0;
  const { cap, hud, run } = setup();
  hud.showForget(run, () => { closed++; });
  let d = cap.pending!.decision;
  assert.equal(d.kind, 'forget');
  assert.deepEqual(d.options.map((o) => [o.id, o.data.refund ?? null]), [['move:0', 24], ['move:1', 16], ['vitamin:protein', 12], ['lesson', null]]);
  assert.deepEqual(cap.pending!.mask(), { phase: 'choice', options: [true, true, true, true], extras: { leave: true } }, 'two moves, a free slot and the lesson unused');
  // The lesson first: three offers.
  answer(cap, { type: 'choice', option: 3 });
  d = cap.pending!.decision;
  assert.equal(d.kind, 'lesson');
  assert.deepEqual(d.options.map((o) => o.id), ['newMove:m9', 'newMove:m8', 'newVit:vnugget']);
  assert.deepEqual(cap.pending!.mask(), { phase: 'choice', options: [true, true, true], extras: { decline: true } });
  // Declined: the lesson is kept, and so are its offers (the game is not asked for new ones).
  answer(cap, { type: 'choice', extra: 'decline' });
  assert.equal(cap.pending!.decision.kind, 'forget');
  answer(cap, { type: 'choice', option: 3 });
  assert.equal(run.lessonRolls, 1, 'the same offers again');
  answer(cap, { type: 'choice', option: 0 });
  assert.deepEqual([run.applied, run.lessonAt, run.stats.lessons, run.player.recomputed], [['m9'], 's1', 1, 1], 'the offer is applied by the game\'s function; then the handler\'s own writes');
  d = cap.pending!.decision;
  assert.deepEqual([d.kind, d.options.map((o) => o.id)], ['forget', ['move:0', 'move:1', 'move:2', 'vitamin:protein', 'lesson']]);
  assert.equal(cap.pending!.mask().options[4], false, 'the lesson of this zone is used');
  // Forgetting pays what the game's functions return.
  answer(cap, { type: 'choice', option: 3 });
  assert.deepEqual([run.gold, run.player.vitamins.size, run.stats.forgets], [112, 0, 1]);
  answer(cap, { type: 'choice', option: 0 });
  assert.deepEqual([run.gold, run.player.moves[0], run.stats.forgets], [136, null, 2]);
  answer(cap, { type: 'choice', option: 0 });
  assert.deepEqual(cap.pending!.mask().options, [false, false], 'the last move cannot be forgotten');
  answer(cap, { type: 'choice', extra: 'leave' });
  assert.deepEqual([closed, cap.pending, cap.failure], [1, null, null]);
});

test('Hypno: forgetting a move with the lesson ready opens the lesson at once, as the HUD does', () => {
  const { cap, hud, run } = setup();
  run.player.moves = [move(1, 'm1', 3), move(2, 'm2', 2), move(3, 'm3', 1), move(4, 'm4', 1)];
  run.lessonPool = [{ kind: 'newMove', key: 'm9', id: 9 }, { kind: 'newMove', key: 'm1', id: 1 }, { kind: 'newVit', key: 'vnugget', vit: 'nugget' }];
  hud.showForget(run, () => undefined);
  assert.equal(cap.pending!.mask().options.at(-1), false, 'no free slot: the lesson cannot be asked for');
  answer(cap, { type: 'choice', option: 3 });
  assert.equal(cap.pending!.decision.kind, 'lesson');
  assert.deepEqual(cap.pending!.mask().options, [true, false, true], 'a move that is already known cannot be taken');
});

test('fusion machine: fuse or link each ready pair; the game gets (index, how)', () => {
  const calls: unknown[][] = [];
  const { cap, hud, run } = setup();
  const list = [
    { ready: true, boon: { x: 1 }, a: 0, b: 1, names: ['M1', 'M2'], types: ['fire', 'water'], r: { key: 'steam', kind: 'reaction' } },
    { ready: false, a: 0, b: 2, names: ['M1', 'M3'], need: ['M3 to level 8'], r: { key: 'x', kind: 'type' } },
    { ready: true, boon: null, a: 1, b: 3, names: ['M2', 'M4'], types: ['water', 'water'], r: { key: 'fu-9', kind: 'signature' } },
  ];
  const open = () => hud.fusion(run, list, (...v: unknown[]) => calls.push(v));
  open();
  const d = cap.pending!.decision;
  assert.equal(d.kind, 'fusion');
  assert.deepEqual(d.options.map((o) => [o.id, o.data.moveA, o.data.moveB, o.data.recipeKind]), [['fuse:0+1', 'm1', 'm2', 'reaction'], ['link:0+1', 'm1', 'm2', 'reaction'], ['fuse:1+3', 'm2', null, 'signature']]);
  assert.deepEqual(d.context.notReady, ['M1 + M3: M3 to level 8']);
  answer(cap, { type: 'choice', option: 1 });
  open(); answer(cap, { type: 'choice', option: 2 });
  open(); answer(cap, { type: 'choice', extra: 'leave' });
  assert.deepEqual(calls, [[0, 'link'], [2, 'fuse'], [null]]);
  // Nothing ready: only leaving.
  hud.fusion(run, [list[1]], () => undefined);
  assert.deepEqual(cap.pending!.mask(), { phase: 'choice', options: [], extras: { leave: true } });
});

test('anything unknown is recorded as a failure with the method and its arguments', () => {
  let s = setup();
  s.hud.showPact(s.run, [{ id: 'glass' }], () => undefined);
  assert.equal(s.cap.pending, null);
  assert.equal(s.cap.failure!.method, 'showPact');
  assert.match(s.cap.failure!.args, /glass/);

  s = setup();
  s.hud.pauseMenu(s.run);
  assert.equal(s.cap.failure!.method, 'pause menu');

  // A window opened by a HUD method nobody replaced, while the run is live.
  s = setup({ state: 'play' });
  s.hud.modal('some', 'window');
  assert.equal(s.cap.failure!.method, 'modal');
  assert.match(s.cap.failure!.args, /some/);

  // …but the game's own end-of-run screen is let through.
  s = setup({ state: 'over' });
  s.hud.modal('end screen');
  assert.equal(s.cap.failure, null);
  assert.deepEqual(s.built, [['modal', 'end screen']]);

  // A second dialog while one is waiting.
  s = setup();
  s.hud.showItem(s.run, 'x', () => undefined);
  s.hud.showOvertime(s.run, () => undefined);
  assert.match(s.cap.failure!.reason, /while "showItem" was still waiting/);
  assert.equal(s.cap.pending!.decision.kind, 'item');
});

test('build-specific methods are found by what they do, and a changed build is refused', () => {
  class Run {
    aaa(e: any) { return e.sold||this.gold<e.price||!this.player.zzz(e.key) ? false : true; }
    bbb() { return this.shop.rerolls++, true; }
    ccc() { return Math.round(10*1.5**this.shopRerolls); }
    gold = 0; player: any; shop: any; shopRerolls = 0;
  }
  class Hud {
    modal(..._a: unknown[]): any { return { classList: { add() {} } }; }
    ddd(e: any) { let r = e, i = this.modal(r.el);i.classList.add(`bm-modal`); }
    eee() { return `pz-bar ` + 1; }
  }
  // The test file is not minified: build the method sources the way the bundle has them.
  const fix = (C: any, name: string, src: string) => { C.prototype[name] = new Function(`return function(e){${src}}`)(); };
  fix(Run, 'aaa', 'return e.sold||this.gold<e.price||!this.player.zzz(e.key)?!1:!0');
  fix(Run, 'bbb', 'return this.shop.rerolls++,!0');
  fix(Run, 'ccc', 'return Math.round(10*1.5**this.shopRerolls)');
  fix(Hud, 'ddd', 'let r=e,i=this.modal(r.el);i.classList.add(`bm-modal`)');
  fix(Hud, 'eee', 'return`pz-bar `+1');
  assert.deepEqual(resolveBuildNames(Run, new Hud()), { shopBuy: 'aaa', playerCanTake: 'zzz', shopReroll: 'bbb', shopRerollCost: 'ccc', hudFusion: 'ddd', hudPause: 'eee' });
  fix(Run, 'bbb', 'return 1');
  assert.throws(() => resolveBuildNames(Run, new Hud()), /could not identify the game's "shop: restock" method: 0 candidates/);
});

test('leaving the sanctuary: "ot" leads on to the overtime dialog only once the shrine has relit, and the decision says so', () => {
  // Found in real play (heuristic baseline, Mewtwo, seed 2001): the portal was reached 4 s after the legendary fell, the
  // dialog was answered with "ot" and nothing happened. The game's callback looks for the relit shrine
  // (`kind === 'shrine' && data.ot`, lit 4.5 s after the kill) and opens showOvertime there; without it, it returns.
  const shown = (run: Record<string, unknown>) => { const s = setup(run); s.hud.showLeaveSanctuary(s.run, () => undefined); return s.cap.pending!.decision; };
  const early = shown({ interactables: { list: [{ kind: 'portal' }, { kind: 'shrine', used: true, data: {} }] } });
  assert.equal(early.context.shrineRelit, false);
  assert.deepEqual(early.options.map((o) => [o.id, o.data.opensOvertimeDialog ?? null]), [['ot', false], ['leave', null]]);
  assert.match(early.options[0].label, /overtime dialog/);
  const relit = shown({ interactables: { list: [{ kind: 'portal' }, { kind: 'shrine', used: false, data: { ot: true } }] } });
  assert.equal(relit.context.shrineRelit, true);
  assert.equal(relit.options[0].data.opensOvertimeDialog, true);
  // A run object without a point list (the stand-in of the other tests) reads as "not relit", not as an error.
  assert.equal(shown({}).context.shrineRelit, false);
});
