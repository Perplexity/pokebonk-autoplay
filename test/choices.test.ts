import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFor, GENERIC } from '../src/bot/brain/builds.ts';
import { pickGeneric, pickLevelUp, readOffer, scoreOffer } from '../src/bot/brain/choices.ts';
import { DEFAULT_TUNING as T } from '../src/bot/brain/tuning.ts';
import type { UiModal, UiOption } from '../src/bot/snapshot.ts';
import { modals, quiet, recorded, vary } from './helpers.ts';

const base = quiet(recorded('farm-zone1').snap);
const M = modals();
const cyndaquil = buildFor(155);

const card = (name: string, sub: string, tag: string, rarity: string, effects: string[], i = 0): UiOption =>
  ({ text: `${rarity} ${tag} ${name} ${sub} ${effects.join(' ')}`, cls: 'card offer', x: 300 + i * 250, y: 380, w: 210, h: 312, disabled: false, name, sub, tag, rarity, effects });
const levelUp = (options: UiOption[], refreshes = 2): UiModal => ({
  kind: 'levelup', title: 'Level 5!', cls: 'modal | modal', options,
  actions: [`Refresh (${refreshes}) F`, 'Skip (2) X', 'Banish (1) Z', 'View my team Tab'].map((text, i) => ({ text, cls: 'btn small', x: 400 + i * 160, y: 577, w: 120, h: 30, disabled: false })),
});

test('a recorded level-up dialog is understood card by card', () => {
  const m = M.levelup;
  assert.equal(m.kind, 'levelup');
  const infos = m.options.map((o) => readOffer(o, base, cyndaquil));
  assert.equal(infos[0].kind, 'move-upgrade');
  assert.equal(infos[0].name, 'Burning Jealousy');
  assert.ok(infos.slice(1).every((i) => i.kind === 'vitamin-new'));
});

test('recorded level-up: upgrading the core move beats new utility vitamins', () => {
  const pick = pickLevelUp(M.levelup, base, cyndaquil, T);
  assert.equal(pick.option, 0);
  assert.match(pick.reason, /core move Burning Jealousy/);
});

test('core moves first: a new core move over damage stats, an upgrade of one over a new one', () => {
  const hand = levelUp([
    card('Direct X', 'New vitamin', 'NEW', 'Common', ['+5% crit chance'], 0),
    card('Temper Flare', 'New move', 'NEW', 'Move', ['Releases a wave that hits everything around you.'], 1),
    card('Burning Jealousy', 'Level 2 → 3 (max 8)', 'UPGRADE', 'Common', ['+20% damage'], 2),
  ]);
  assert.equal(pickLevelUp(hand, base, cyndaquil, T).option, 2, 'upgrade of the first core move');
  const noUpgrade = levelUp(hand.options.slice(0, 2));
  assert.equal(pickLevelUp(noUpgrade, base, cyndaquil, T).option, 1, 'then the new core move');
});

test('situational new moves lose to core upgrades and are not taken without a free slot', () => {
  const full = vary(base, (s) => { s.player.moveSlots = s.player.moves.length; });
  const offer = card('Rock Smash', 'New move', 'NEW', 'Move', ['Hits the ground in front of you.']);
  assert.ok(scoreOffer(offer, full, cyndaquil, T).score < 20);
  const open = vary(base, (s) => { s.player.moveSlots = s.player.moves.length + 1; s.player.level = 4; });
  assert.ok(scoreOffer(offer, open, cyndaquil, T).score > 50, 'fine early while a slot is free');
});

test('survivability only when hurt', () => {
  const hand = levelUp([
    card('HP Up', 'New vitamin', 'NEW', 'Common', ['+20 max HP'], 0),
    card('Direct X', 'New vitamin', 'NEW', 'Common', ['+5% crit chance'], 1),
  ]);
  assert.equal(pickLevelUp(hand, base, cyndaquil, T).option, 1, 'healthy: damage');
  const hurt = vary(base, (s) => { s.player.hp = s.player.maxHp * 0.3; });
  const pick = pickLevelUp(hand, hurt, cyndaquil, T);
  assert.equal(pick.option, 0, 'under 50% HP: survive');
  assert.match(pick.reason, /survive/);
});

test('a weak hand is refreshed while refreshes are left, then the best of it is taken', () => {
  const junk = [card('Nugget', 'New vitamin', 'NEW', 'Common', ['+15% pokédollars'], 0), card('Star Piece', 'New vitamin', 'NEW', 'Common', ['+12 luck'], 1)];
  const late = vary(base, (s) => { s.player.level = 20; });
  const re = pickLevelUp(levelUp(junk, 2), late, cyndaquil, T);
  assert.equal(re.option, -1);
  assert.match(levelUp(junk).actions[re.action].text, /Refresh/);
  const none = pickLevelUp(levelUp(junk, 0), late, cyndaquil, T);
  assert.ok(none.option >= 0, 'no refresh left: pick a card');
});

test('vitamin slots are limited: no new vitamin when they are full', () => {
  const full = vary(base, (s) => { s.player.vitamins = { a: 1, b: 1, c: 1 }; s.player.vitaminSlots = 3; });
  assert.ok(scoreOffer(card('Direct X', 'New vitamin', 'NEW', 'Common', ['+5% crit chance']), full, cyndaquil, T).score < 20);
});

test('the build decides between two damage stats; the generic build still prefers damage to gold', () => {
  const area = card('Wide Lens', 'New vitamin', 'NEW', 'Common', ['+10% area']), crit = card('Direct X', 'New vitamin', 'NEW', 'Common', ['+5% crit chance']);
  assert.ok(scoreOffer(area, base, cyndaquil, T).score > scoreOffer(crit, base, cyndaquil, T).score, 'the eruption build scales with area first');
  const gold = card('Nugget', 'New vitamin', 'NEW', 'Common', ['+15% pokédollars']);
  assert.ok(scoreOffer(crit, base, GENERIC, T).score > scoreOffer(gold, base, GENERIC, T).score);
});

test('every starter line has at least one curated build with core moves', () => {
  for (const id of [1, 4, 7, 152, 155, 158]) {
    const b = buildFor(id);
    assert.ok(b.core.length >= 3 && b.scale.length >= 3, `build for ${id}`);
  }
  assert.equal(buildFor(999).name, 'generic');
  assert.notEqual(buildFor(155, 1).name, buildFor(155, 0).name, 'a second variant exists');
});

test('"You found an item!" is answered with Take, never Sell or View my team', () => {
  const pick = pickGeneric(M.item, base, cyndaquil, T)!;
  assert.equal(pick.option, -1);
  assert.match(M.item.actions[pick.action].text, /^Take/);
});

test('optional handicaps before the guardian are declined', () => {
  const seals: UiModal = {
    kind: 'unknown', title: 'Challenge Seals', cls: 'modal | modal',
    options: ['Fury Seal', 'Horde Seal', 'Double Team Seal'].map((n, i) => ({ text: `Seal ${n} CHALLENGE ... IF YOU KEEP IT +1 Great Ball`, cls: 'card pact seal', x: 388 + i * 252, y: 380, w: 236, h: 341, disabled: false, name: n, rarity: 'Seal', tag: '', sub: '', effects: [] })),
    actions: [{ text: 'Not now Esc', cls: 'btn ghost', x: 444, y: 664, w: 168, h: 65, disabled: false }, { text: 'Awaken without seals Enter', cls: 'btn red big', x: 700, y: 664, w: 300, h: 65, disabled: false }],
  };
  const pick = pickGeneric(seals, base, cyndaquil, T)!;
  assert.equal(pick.option, -1);
  assert.match(seals.actions[pick.action].text, /without seals/);
});

test('the pause menu: continue, and never a destructive button', () => {
  const pick = pickGeneric(M.pause, base, cyndaquil, T)!;
  assert.match(M.pause.actions[pick.action].text, /^Continue/);
  const noContinue: UiModal = { ...M.pause, actions: M.pause.actions.filter((a) => !/continue/i.test(a.text)) };
  const p2 = pickGeneric(noContinue, base, cyndaquil, T);
  assert.ok(!p2 || !/give up|restart|save and quit|report/i.test(noContinue.actions[p2.action].text));
});

test('shops: nothing the gold does not cover', () => {
  const shop: UiModal = {
    kind: 'shop', title: 'Shop', cls: 'modal | panel shop', actions: [{ text: 'Leave', cls: 'btn', x: 600, y: 600, w: 100, h: 30, disabled: false }],
    options: [{ ...card('Choice Specs', '', '', 'Rare', ['+20% special damage'], 0), text: 'Rare Choice Specs +20% special damage 400 ₽' }, { ...card('Potion', '', '', 'Common', ['Heals 30 HP'], 1), text: 'Common Potion Heals 30 HP 60 ₽' }],
  };
  const poor = vary(base, (s) => { s.gold = 80; });
  assert.equal(pickGeneric(shop, poor, cyndaquil, T)!.option, 1);
  const rich = vary(base, (s) => { s.gold = 500; });
  assert.equal(pickGeneric(shop, rich, cyndaquil, T)!.option, 0);
  const broke = vary(base, (s) => { s.gold = 0; });
  const leave = pickGeneric(shop, broke, cyndaquil, T)!;
  assert.equal(leave.option, -1);
  assert.match(shop.actions[leave.action].text, /Leave/);
});
