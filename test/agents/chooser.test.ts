import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ITEM_HARMFUL, SHOP_MIN, choose, scoreLevelUp } from '../../src/agents/heuristic/chooser.ts';
import { ITEM_DEFAULT, VITAMIN_EFFECT, itemScore } from '../../src/agents/heuristic/knowledge.ts';
import { directiveFor, DEFAULT_HEURISTIC, heuristicPolicy } from '../../src/agents/heuristic/policy.ts';
import type { Lifecycle } from '../../src/agents/heuristic/policy.ts';
import { buildFor } from '../../src/bot/brain/builds.ts';
import { DEFAULT_TUNING } from '../../src/bot/brain/tuning.ts';
import type { Snapshot } from '../../src/bot/snapshot.ts';
import { choiceActionProblem, playActionProblem } from '../../src/environment/GameEnvironment.ts';
import { validChoices } from '../../src/environment/policies.ts';
import { MOVES } from '../../src/environment/types.ts';
import type { ChoiceAction, ChoiceMask, Decision, DecisionKind, DecisionOption, Observation, PlayMask } from '../../src/environment/types.ts';
import { enemy, quiet, recorded, vary } from '../helpers.ts';

// The heuristic baseline's chooser and lifecycle memory. No game is loaded here.
//
// test/fixtures/decisions.json holds decisions RECORDED FROM REAL HEADLESS PLAY (scripts/heuristic-trace.ts
// --decisions, seeds 2001 and 2002, build mwsewi0r): the decision and mask exactly as the environment raised them, the
// player's build at that moment, and what the policy answered then. Dialog kinds the baseline has not met in real play
// are tested on stand-in decisions built here with the shape src/environment/dialogs.ts gives them; each says so.

interface Recorded { name: string; seed: number; t: number; zone: number; level: number; gold: number; player: Partial<Snapshot['player']>; decision: Decision; mask: ChoiceMask; answered: ChoiceAction }
const FIXTURES = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'decisions.json'), 'utf8')) as Recorded[];
const base = quiet(recorded('farm-zone1').snap);
const CTX = { build: buildFor(155), tuning: DEFAULT_TUNING };
/** The one part of `observation.state` the policy reads: is overtime running. */
const STATE = { overtime: { live: false, over: false, direct: false } } as unknown as Observation['state'];

function observe(decision: Decision, mask: ChoiceMask, patch: (s: Snapshot) => void = () => {}): Observation {
  return { schema: 3, phase: 'choice', step: 10, simStep: 30, snapshot: vary(base, (s) => { s.state = 'modal'; patch(s); }), decision, mask, state: STATE } as Observation;
}
const fromFixture = (f: Recorded): Observation => observe(f.decision, f.mask, (s) => { Object.assign(s.player, f.player); s.player.level = f.level; s.gold = f.gold; s.stage = f.zone; s.t = f.t; });
const fixture = (name: string): Recorded => { const f = FIXTURES.find((x) => x.name === name); assert.ok(f, `fixture "${name}"`); return f; };

/** A decision as dialogs.ts would raise it (stand-in for kinds not met in real play). */
function standIn(kind: DecisionKind, options: { id: string; data?: Record<string, unknown>; ok?: boolean }[], extras: Record<string, boolean>, context: Record<string, unknown> = {}): { decision: Decision; mask: ChoiceMask } {
  const opts: DecisionOption[] = options.map((o) => ({ id: o.id, label: o.id, data: o.data ?? {} }));
  return {
    decision: { kind, method: 'standIn', title: kind, options: opts, extras: Object.fromEntries(Object.keys(extras).map((k) => [k, { needsTarget: false, effect: '' }])), context, serial: 1 },
    mask: { phase: 'choice', options: options.map((o) => o.ok !== false), extras },
  };
}
const answer = (d: { decision: Decision; mask: ChoiceMask }, patch?: (s: Snapshot) => void) => choose(observe(d.decision, d.mask, patch), CTX);
const picked = (d: { decision: Decision }, a: ChoiceAction): string => ('option' in a ? d.decision.options[a.option].id : `extra:${a.extra}`);

test('recorded real decisions: every answer is valid for its mask, and is what the policy answered in the run', () => {
  assert.ok(FIXTURES.length >= 10);
  const kinds = new Set(FIXTURES.map((f) => f.decision.kind));
  for (const k of ['levelup', 'item', 'itemChoice', 'blessing', 'seals', 'ditto', 'fusion', 'forget']) assert.ok(kinds.has(k as DecisionKind), `a recorded "${k}" decision`);
  for (const f of FIXTURES) {
    const c = choose(fromFixture(f), CTX);
    assert.equal(choiceActionProblem(c.action, f.mask), null, `${f.name}: ${JSON.stringify(c.action)}`);
    assert.ok(c.reason.length > 0);
    // The fixture does not carry the enemies around the player, which only matter to survival picks when hurt.
    if (f.player.hp! >= f.player.maxHp! * 0.9) assert.deepEqual(c.action, f.answered, `${f.name}: ${c.reason}`);
  }
});

test('level-up on recorded offers: own-kit moves first, upgrades of core moves above everything, vitamins by what they raise', () => {
  const first = fixture('levelup: first level, new moves and new vitamins');
  assert.deepEqual(first.decision.options.map((o) => o.id), ['newMove:m915', 'newVit:vstar-piece-v', 'newVit:vpoke-radar', 'newVit:vpp-up']);
  const c1 = choose(fromFixture(first), CTX);
  assert.deepEqual(c1.action, { type: 'choice', option: 0 });
  assert.match(c1.reason, /new move of its own kit/);

  const up = fixture('levelup: an upgrade of an owned move among the offers');
  const scores = up.decision.options.map((o) => scoreLevelUp(o, fromFixture(up).snapshot, CTX));
  assert.equal(up.decision.options[0].id, 'upMove:m807');
  assert.match(scores[0].why, /upgrade core move Burning Jealousy/, 'the move is named from the snapshot by its slot');
  assert.ok(scores[0].score >= 100 && scores.slice(1).every((s) => s.score < scores[0].score));

  // A move borrowed from another League member is worth less than upgrading a core move, and less after level 8.
  const borrowed = fixture('levelup: a move borrowed from another League member');
  const o = fromFixture(borrowed);
  const foreign = borrowed.decision.options.find((x) => x.data.kind === 'newMove' && x.data.from != null)!;
  const own = borrowed.decision.options.find((x) => x.data.kind === 'newMove' && x.data.from == null)!;
  assert.ok(scoreLevelUp(own, o.snapshot, CTX).score > scoreLevelUp(foreign, o.snapshot, CTX).score);
  const late = vary(o.snapshot, (s) => { s.player.level = 20; });
  assert.ok(scoreLevelUp(foreign, late, CTX).score < scoreLevelUp(foreign, o.snapshot, CTX).score);
  const full = vary(o.snapshot, (s) => { s.player.moveSlots = s.player.moves.length; });
  assert.ok(scoreLevelUp(own, full, CTX).score < 20, 'no slot, no new move');

  // Only vitamins: the one the build scales with; hurt, a survival vitamin jumps the queue.
  const vits = fixture('levelup: only vitamins');
  assert.deepEqual(vits.decision.options.map((x) => x.id), ['newVit:vmax-potion', 'newVit:vether', 'newVit:vexp-candy', 'newVit:vx-attack']);
  const healthy = choose(observe(vits.decision, vits.mask, (s) => { Object.assign(s.player, vits.player); s.player.level = vits.level; s.player.hp = s.player.maxHp; }), CTX);
  assert.equal(picked(vits, healthy.action), 'newVit:vx-attack', healthy.reason);
  const hurt = choose(observe(vits.decision, vits.mask, (s) => { Object.assign(s.player, vits.player); s.player.level = vits.level; s.player.hp = s.player.maxHp * 0.3; }), CTX);
  assert.equal(picked(vits, hurt.action), 'newVit:vmax-potion', hurt.reason);
  // One hit from what is around takes a large part of the HP bar: survival again.
  const fragile = choose(observe(vits.decision, vits.mask, (s) => { Object.assign(s.player, vits.player); s.player.level = vits.level; s.player.hp = s.player.maxHp; s.enemies.list = [enemy(1, 5, 0, { dmg: s.player.maxHp * 0.3 })]; }), CTX);
  assert.equal(picked(vits, fragile.action), 'newVit:vmax-potion', fragile.reason);

  // Every vitamin of the game has an effect line, and the two that make the horde harder are never preferred.
  assert.equal(Object.keys(VITAMIN_EFFECT).length, 26);
  const cursed = standIn('levelup', [{ id: 'newVit:vcursed', data: { kind: 'newVit', vit: 'cursed', rarity: 4 } }, { id: 'newVit:vsuper-lure', data: { kind: 'newVit', vit: 'super-lure', rarity: 4 } }, { id: 'newVit:vnugget', data: { kind: 'newVit', vit: 'nugget', rarity: 0 } }], { refresh: false, skip: true });
  assert.equal(picked(cursed, answer(cursed).action), 'newVit:vnugget');
});

test('level-up: a weak hand is refreshed while a refresh is left, and only then', () => {
  const weak = standIn('levelup', [{ id: 'newVit:vsticky-barb', data: { kind: 'newVit', vit: 'sticky-barb', rarity: 0 } }, { id: 'newVit:venigma-berry', data: { kind: 'newVit', vit: 'enigma-berry', rarity: 0 } }], { refresh: true, skip: true });
  assert.deepEqual(answer(weak).action, { type: 'choice', extra: 'refresh' });
  weak.mask.extras.refresh = false;
  const kept = answer(weak);
  assert.ok('option' in kept.action, 'no refresh left: the best of the hand, never a skip');
  // An offer kind the rules do not know is neutral: taken only when nothing better is there, never an error.
  const unknown = standIn('levelup', [{ id: 'mystery:x', data: { kind: 'mystery', rarity: 2 } }, { id: 'newVit:vether', data: { kind: 'newVit', vit: 'ether', rarity: 0 } }], { refresh: false });
  assert.equal(picked(unknown, answer(unknown).action), 'newVit:vether');
  // A vitamin without a free slot is a wasted pick.
  const noSlot = standIn('levelup', [{ id: 'newVit:vether', data: { kind: 'newVit', vit: 'ether', rarity: 0 } }, { id: 'upVit:vnugget', data: { kind: 'upVit', vit: 'nugget', rarity: 0 } }], { refresh: false });
  assert.equal(picked(noSlot, answer(noSlot, (s) => { s.player.vitamins = { a: 1, b: 1, c: 1, d: 1, nugget: 1 }; s.player.vitaminSlots = 5; s.player.level = 30; }).action), 'upVit:vnugget');
});

test('items: taken unless harmful, the best of a choice, type and class items only for a kit that uses them', () => {
  const fire = [{ type: 'fire', cls: 'special' }], water = [{ type: 'water', cls: 'physical' }];
  assert.equal(itemScore('charcoal', fire), 80);
  assert.equal(itemScore('charcoal', water), 25);
  assert.equal(itemScore('choice-band', water), 80);
  assert.equal(itemScore('choice-band', fire), 25);
  assert.equal(itemScore('no-such-item', fire), ITEM_DEFAULT);
  assert.ok(itemScore('max-revive', fire) > itemScore('leftovers', fire) && itemScore('leftovers', fire) > ITEM_DEFAULT && itemScore('white-flute', fire) <= ITEM_HARMFUL);

  const item = fixture('item');
  assert.deepEqual(choose(fromFixture(item), CTX).action, { type: 'choice', option: 0 }, 'recorded: old-rod is taken');
  const flute = standIn('item', [{ id: 'white-flute', data: { key: 'white-flute', owned: 0 } }], { sell: true });
  assert.deepEqual(answer(flute).action, { type: 'choice', extra: 'sell' });

  const pick = fixture('itemChoice');
  assert.deepEqual(pick.decision.options.map((o) => o.id), ['charcoal', 'x-accuracy', 'metal-powder']);
  assert.equal(picked(pick, choose(fromFixture(pick), CTX).action), 'charcoal', 'recorded: the Fire item for a Fire kit');
  const allBad = standIn('itemChoice', [{ id: 'white-flute', data: { key: 'white-flute' } }, { id: 'lure-ball', data: { key: 'lure-ball' } }], { sell: true });
  assert.deepEqual(answer(allBad).action, { type: 'choice', extra: 'sell' });

  // Ditto (recorded): the most valuable owned item is copied; a masked one (already at its maximum) is not.
  const ditto = fixture('ditto');
  assert.equal(picked(ditto, choose(fromFixture(ditto), CTX).action), 'max-revive');
  const capped = { decision: ditto.decision, mask: { ...ditto.mask, options: ditto.mask.options.map((_ok, i) => ditto.decision.options[i].id !== 'max-revive') } };
  assert.notEqual(picked(capped, choose(observe(capped.decision, capped.mask, (s) => { Object.assign(s.player, ditto.player); }), CTX).action), 'max-revive');
  const none = { decision: ditto.decision, mask: { ...ditto.mask, options: ditto.mask.options.map(() => false) } };
  assert.deepEqual(choose(observe(none.decision, none.mask), CTX).action, { type: 'choice', extra: 'decline' });
});

test('guardians, the sanctuary and overtime: no seals, the classic path, start overtime, hold offerings only', () => {
  const seals = fixture('seals');
  assert.equal(seals.decision.options.length, 8, 'recorded: every subset of three seals');
  assert.equal(picked(seals, choose(fromFixture(seals), CTX).action), 'none');
  // Stand-ins (shapes as in dialogs.ts; met only with the cheating probe so far).
  const path = standIn('sanctuaryPath', [{ id: 'sanct' }, { id: 'direct' }], { decline: true });
  assert.equal(picked(path, answer(path).action), 'sanct');
  const leave = standIn('leaveSanctuary', [{ id: 'ot' }, { id: 'leave' }], { decline: true });
  assert.equal(picked(leave, answer(leave).action), 'ot');
  const start = standIn('overtimeStart', [{ id: 'start' }], { decline: true });
  assert.equal(picked(start, answer(start).action), 'start');
  const offer = standIn('overtimeOffer', [{ id: 'rompeolas' }, { id: 'pleamar' }, { id: 'manantial' }], { decline: true }, { round: 2, held: [] });
  assert.equal(picked(offer, answer(offer).action), 'manantial', 'a hold offering, in the order of preference');
  const risk = standIn('overtimeOffer', [{ id: 'pleamar' }, { id: 'cebo' }, { id: 'corriente' }], { decline: true }, { round: 4 });
  assert.deepEqual(answer(risk).action, { type: 'choice', extra: 'decline' });
});

test('stand-ins for dialogs not met in real play: shop, trade, party, shiny swap, relic, evolution, leave-only', () => {
  // Shop: the best affordable item worth its price, again while there is one, then leave. Never a restock.
  const shop = standIn('shop', [
    { id: 'leftovers', data: { key: 'leftovers', price: 120 } }, { id: 'max-revive', data: { key: 'max-revive', price: 900 }, ok: false },
    { id: 'honey', data: { key: 'honey', price: 30 } }, { id: 'lucky-egg', data: { key: 'lucky-egg', price: 80 } },
  ], { reroll: true, leave: true }, { gold: 200, rerollCost: 40 });
  assert.equal(picked(shop, answer(shop).action), 'leftovers', 'the dear one is masked (not affordable)');
  assert.ok(itemScore('honey', []) < SHOP_MIN);
  const cheapOnly = standIn('shop', [{ id: 'honey', data: { key: 'honey', price: 30 } }, { id: 'leftovers', data: { key: 'leftovers', price: 120 }, ok: false }], { reroll: true, leave: true });
  assert.deepEqual(answer(cheapOnly).action, { type: 'choice', extra: 'leave' });

  const trade = standIn('trade', [{ id: 'fossil-a', data: { key: 'fossil-a' } }, { id: 'fossil-b', data: { key: 'fossil-b', off: true }, ok: false }], { decline: true }, { species: 138, help: '' });
  assert.deepEqual(answer(trade).action, { type: 'choice', extra: 'decline' });

  const party = (incoming: number) => standIn('party', [{ id: '0', data: { species: 59, bst: 555, shiny: false } }, { id: '1', data: { species: 19, bst: 253, shiny: true }, ok: false }, { id: '2', data: { species: 16, bst: 251, shiny: false } }], { decline: true }, { incoming: { species: 130, bst: incoming } });
  assert.equal(picked(party(540), answer(party(540)).action), '2', 'the weakest ally that may be released makes room');
  assert.deepEqual(answer(party(200)).action, { type: 'choice', extra: 'decline' }, 'a weaker newcomer leaves');

  const swap = standIn('shinySwap', [{ id: 'swap' }], { decline: true });
  assert.deepEqual(answer(swap).action, { type: 'choice', extra: 'decline' });

  const relic = standIn('relic', [{ id: 'r-a', data: { key: 'r-a' } }, { id: 'r-b', data: { key: 'r-b' } }], { decline: true }, { held: ['x'] });
  assert.equal(picked(relic, answer(relic).action), 'r-a');
  const relicFull = standIn('relic', [{ id: 'r-a@0' }, { id: 'r-a@1' }, { id: 'r-a@2' }], { decline: true }, { held: ['x', 'y', 'z'] });
  assert.deepEqual(answer(relicFull).action, { type: 'choice', extra: 'decline' });

  const evolve = standIn('evolution', [{ id: '134', data: { species: 134 } }, { id: '135', data: { species: 135 } }], { decline: true }, { from: 133 });
  assert.equal(picked(evolve, answer(evolve).action), '134');

  // Leave-only dialogs (fusion and forget are also among the recorded ones).
  // The dialogs the baseline does not use: it closes them.
  for (const kind of ['slots', 'forget', 'fusion', 'shopSell'] as const) assert.deepEqual(answer(standIn(kind, [{ id: 'x' }], { leave: true })).action, { type: 'choice', extra: 'leave' });
  for (const kind of ['dojo', 'dojoPrize', 'lesson'] as const) assert.deepEqual(answer(standIn(kind, [{ id: 'x' }], { decline: true })).action, { type: 'choice', extra: 'decline' });
  for (const name of ['fusion', 'forget']) assert.deepEqual(choose(fromFixture(fixture(name)), CTX).action, { type: 'choice', extra: 'leave' });
});

test('every decision kind has a rule; what a rule wants but the mask forbids falls back to a valid action, said so', () => {
  const kinds: DecisionKind[] = ['levelup', 'evolution', 'item', 'itemChoice', 'blessing', 'seals', 'sanctuaryPath', 'leaveSanctuary', 'overtimeStart', 'overtimeOffer', 'trade', 'shop', 'ditto', 'party', 'shinySwap', 'relic', 'dojo', 'slots', 'forget', 'fusion'];
  for (const kind of kinds) {
    // One odd option and one odd extra that no rule asks for: whatever the rule wanted is not there.
    const d = standIn(kind, [{ id: 'odd', data: { key: 'odd' } }], { confirm: true });
    const c = answer(d);
    assert.equal(choiceActionProblem(c.action, d.mask), null, kind);
    // Only the extra is valid.
    const e = standIn(kind, [{ id: 'odd', data: { key: 'odd' }, ok: false }], { confirm: true });
    const ce = answer(e);
    assert.deepEqual(ce.action, validChoices(e.mask)[0], kind);
    assert.match(ce.reason, /first valid action/, kind);
  }
  assert.throws(() => answer(standIn('riddle' as DecisionKind, [{ id: 'a' }], {})), /no rule for decision kind "riddle"/);
  assert.throws(() => answer(standIn('levelup', [{ id: 'a', ok: false }], { refresh: false })), /has no valid action/);
  assert.throws(() => choose({ ...observe(standIn('item', [{ id: 'a' }], {}).decision, { phase: 'choice', options: [true], extras: {} }), phase: 'play' } as Observation, CTX), /outside the choice phase/);
});

test('lifecycle: the directive follows the overtime state of the observation', () => {
  const OFF = { live: false, over: false, direct: false }, LIVE = { live: true, over: false, direct: false };
  const life = (): Lifecycle => ({ cashing: false, restSince: null });
  const arena = (hp: number, portal = true) => vary(base, (s) => { s.stage = 4; s.stageCleared = true; s.bossSpawned = true; s.player.hp = s.player.maxHp * hp; s.points = portal ? [{ kind: 'portal', sub: '', x: 5, z: -20, r: 3.4, used: false, cost: 0, d: 20.6 }] : []; });
  assert.deepEqual(directiveFor(arena(1), OFF, life(), DEFAULT_HEURISTIC), {}, 'no overtime: the brain plays the zone as usual');
  assert.deepEqual(directiveFor(vary(arena(0.1), (s) => { s.stage = 2; }), OFF, life(), DEFAULT_HEURISTIC), {}, 'hurt in a zone is the brain\'s business');
  assert.deepEqual(directiveFor(vary(arena(0.1), (s) => { s.stageCleared = false; }), OFF, life(), DEFAULT_HEURISTIC), {}, 'and so is the legendary fight');
  // Legendary beaten, overtime still to start: it is started with a full HP bar, after a rest that does not last for ever.
  const rest = life(), t0 = arena(0.5).t;
  assert.deepEqual(directiveFor(arena(0.5), OFF, rest, DEFAULT_HEURISTIC), { holdPortal: true }, 'hurt: the portal (and with it the overtime dialog) waits');
  assert.equal(rest.restSince, t0);
  assert.deepEqual(directiveFor(vary(arena(0.5), (s) => { s.t = t0 + DEFAULT_HEURISTIC.restSec - 1; }), OFF, rest, DEFAULT_HEURISTIC), { holdPortal: true });
  assert.deepEqual(directiveFor(vary(arena(DEFAULT_HEURISTIC.restHp), (s) => { s.t = t0 + 5; }), OFF, rest, DEFAULT_HEURISTIC), {}, 'rested: go on');
  assert.deepEqual(directiveFor(vary(arena(0.5), (s) => { s.t = t0 + DEFAULT_HEURISTIC.restSec + 1; }), OFF, rest, DEFAULT_HEURISTIC), {}, 'the HP bar does not refill: go on anyway');
  const healthy = directiveFor(arena(1), LIVE, life(), DEFAULT_HEURISTIC);
  assert.equal(healthy.holdPortal, true);
  assert.deepEqual(healthy.leash, { x: 5, z: -20, r: DEFAULT_HEURISTIC.leash });
  assert.equal(healthy.goto, undefined);
  assert.deepEqual(directiveFor(arena(1, false), LIVE, life(), DEFAULT_HEURISTIC), { holdPortal: true }, 'no portal in sight: just do not look for one');
  // The direct path: overtime starts by itself a few seconds after arrival; the portal is left alone meanwhile.
  assert.equal(directiveFor(arena(1), { live: false, over: false, direct: true }, life(), DEFAULT_HEURISTIC).holdPortal, true);
  // Hurt in overtime: cash out, and stay with that decision.
  const mem = life();
  const hurt = directiveFor(arena(DEFAULT_HEURISTIC.cashHp - 0.05), LIVE, mem, DEFAULT_HEURISTIC);
  assert.equal(hurt.goto?.force, true);
  assert.equal(hurt.goto?.interact, true);
  assert.deepEqual([hurt.goto?.x, hurt.goto?.z], [5, -20]);
  assert.equal(mem.cashing, true);
  assert.equal(directiveFor(arena(1), LIVE, mem, DEFAULT_HEURISTIC).goto?.kind, 'cash', 'once decided, cashing out is not called off by a heal');
  // Overtime over (its last round collapsed): the portal ends the run, nothing holds it any more.
  assert.deepEqual(directiveFor(arena(1), { live: false, over: true, direct: false }, mem, DEFAULT_HEURISTIC), {});
});

test('the policy: valid actions in both phases, deterministic, far goals ask the route planner', () => {
  const play = (s: Snapshot, state = STATE): Observation => ({ schema: 3, phase: 'play', step: 1, simStep: 3, snapshot: s, decision: null, mask: { phase: 'play', move: MOVES.map(() => true), jump: true, dash: true, ultimate: false, interact: false, form: false, incense: false, fuse: false }, state }) as Observation;
  const far = vary(base, (s) => { s.player.level = DEFAULT_TUNING.wakeLevel[0]; s.ult.charge = 1; s.points = [{ kind: 'boss', sub: '', x: 90, z: 0, r: 4, used: false, cost: 0, d: 90 }]; });
  const asked: [number, number][] = [];
  const events: string[] = [];
  const policy = heuristicPolicy({ planRoute: (x, z) => { asked.push([x, z]); return { tx: x, tz: z, ok: true, len: 95, jump: false, x: 0, z: 8 }; }, onEvent: (e) => events.push(e.what) });
  policy.reset(1);
  const a1 = policy.act(play(far));
  assert.equal(playActionProblem(a1 as never, play(far).mask as PlayMask), null);
  assert.equal(policy.state.intent, 'wake');
  assert.equal(policy.state.build, 'eruption', 'the build plan of the Pokémon the run started with');
  assert.deepEqual(asked, [], 'the first decision finds out that the goal is far');
  const a2 = policy.act(play(vary(far, (s) => { s.t += 0.05; })));
  assert.deepEqual(asked, [[90, 0]], 'the next one plans a route to it');
  assert.ok(['s', 'se'].includes((a2 as { move: string }).move), `and turns towards the waypoint (0, 8) instead of walking straight east at the altar (got ${JSON.stringify(a2)})`);
  policy.act(play(vary(far, (s) => { s.t += 0.1; })));
  assert.equal(asked.length, 1, 'a plan is reused for a while');
  policy.act(play(vary(far, (s) => { s.t += 0.6; })));
  assert.equal(asked.length, 2);
  assert.ok(events.includes('intent:wake'));

  // Without a planner it walks the straight line; the same observations give the same actions.
  const run = () => { const p = heuristicPolicy(); p.reset(1); return [far, vary(far, (s) => { s.t += 0.05; })].map((s) => p.act(play(s))); };
  assert.deepEqual(run(), run());
  assert.deepEqual(run()[1], { type: 'play', move: 'e' });

  // A masked button is never pressed: at the altar the brain wants to interact, the mask says there is nothing to use.
  const at = vary(far, (s) => { s.points[0].x = 1; s.points[0].d = 1; });
  const p2 = heuristicPolicy(); p2.reset(1);
  assert.equal((p2.act(play(at)) as { interact?: boolean }).interact, undefined);
  const open = { ...play(at), mask: { ...(play(at).mask as PlayMask), interact: true } } as Observation;
  const p3 = heuristicPolicy(); p3.reset(1);
  assert.equal((p3.act(open) as { interact?: boolean }).interact, true);

  // Overtime that the game started by itself (the direct path) is noticed in the observation's state: the portal is held.
  const cleared = vary(base, (s) => { s.stage = 4; s.stageCleared = true; s.bossSpawned = true; s.points = [{ kind: 'portal', sub: '', x: 0, z: -30, r: 3.4, used: false, cost: 0, d: 30 }]; s.enemies.list = [enemy(0, 6, 0)]; s.enemies.count = 1; });
  const p4 = heuristicPolicy(); p4.reset(1);
  p4.act(play(cleared));
  assert.equal(p4.state.intent, 'portal');
  const p5 = heuristicPolicy(); p5.reset(1);
  p5.act(play(cleared, { overtime: { live: true, over: false, direct: true } } as unknown as Observation['state']));
  assert.notEqual(p5.state.intent, 'portal');

  // A dialog during the run is answered by the chooser; reset() forgets a decision to cash out.
  const start = standIn('overtimeStart', [{ id: 'start' }], { decline: true });
  assert.deepEqual(p3.act(observe(start.decision, start.mask)), { type: 'choice', option: 0 });
  const dying = vary(cleared, (s) => { s.player.hp = s.player.maxHp * 0.2; });
  p3.act(play(dying, { overtime: { live: true, over: false, direct: false } } as unknown as Observation['state']));
  assert.equal(p3.state.intent, 'cash');
  assert.equal(p3.state.lifecycle.cashing, true);
  p3.reset(2);
  assert.equal(p3.state.lifecycle.cashing, false);
});
