import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { knowledgeDir } from '../../src/knowledge/load.ts';
import { KNOWLEDGE_VERSION } from '../../src/knowledge/export.ts';

// No game: these read the exported datasets of the pinned build (data/game-knowledge/mwsewi0r, written by
// scripts/export-knowledge.ts). A deliberate re-export that changes a dataset must change the pinned values here.

const BUILD = 'mwsewi0r';
const dir = knowledgeDir(BUILD);
// data/ is not under version control (like mirror/): on a machine without the export, say what to run.
if (!existsSync(join(dir, 'species.json'))) throw new Error(`${dir} has no export. Run "node scripts/export-knowledge.ts" (it needs the local mirror of build ${BUILD}).`);
const read = (name: string): any => JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'));
const species = read('species'), moves = read('moves'), items = read('items');

test('every dataset carries the same build, bundle hash and versions, says where its data came from and what it lacks', () => {
  for (const [name, d, version] of [['species', species, KNOWLEDGE_VERSION], ['moves', moves, KNOWLEDGE_VERSION], ['items', items, KNOWLEDGE_VERSION]] as const) {
    const h = d.header;
    assert.deepEqual([h.dataset, h.build, h.gameVersion, h.version, h.language, h.profile], [name, BUILD, '0.10.26', version, 'en', 'unlocked-v3']);
    assert.equal(h.bundleSha256, species.header.bundleSha256);
    assert.match(h.bundleSha256, /^[0-9a-f]{64}$/);
    assert.ok(Object.keys(h.source).length >= 5 && Object.values(h.source).every((s) => typeof s === 'string' && s.length > 10), `${name}: sources`);
    assert.ok(Array.isArray(h.gaps) && h.gaps.length >= 3, `${name}: gaps`);
    assert.equal('exportedAt' in h, false, 'no wall-clock time: a second export must be byte-identical');
  }
});

test('species: all 138 League members, each with a kit of four, a passive, moves per form and an ultimate', () => {
  assert.equal(species.species.length, 138);
  assert.equal(new Set(species.species.map((s: any) => s.id)).size, 138);
  const moveKeys = new Set(moves.moves.map((m: any) => m.key));
  for (const s of species.species) {
    assert.equal(s.kit.length, 4, `kit of ${s.id}`);
    assert.deepEqual(s.kit.map((k: any) => k.slot), [0, 1, 2, 3]);
    assert.equal(s.kit[0].unlockLevel, 1);
    for (const k of s.kit) assert.ok(moveKeys.has(k.move), `${s.id}: kit move ${k.move} is in moves.json`);
    assert.deepEqual(s.startingMoves, [{ move: s.kit[0].move, level: 1 }], `${s.id} starts with the first move of its kit`);
    assert.ok(s.types.length >= 1 && s.types.length <= 2 && s.role && s.passive.id && s.passive.desc);
    assert.equal(s.evolution.line[0], s.id);
    assert.deepEqual(Object.keys(s.moves).map(Number).sort((a, b) => a - b), [...s.evolution.line].sort((a: number, b: number) => a - b), `${s.id}: one move plan per form`);
    for (const form of Object.values(s.moves) as any[]) for (const m of [...form.line, ...form.shared]) assert.ok(moveKeys.has(m.move));
    assert.ok(s.run.maxHp > 50 && s.run.moveSlots === 4 && s.run.vitaminSlots === 5 && s.run.refreshes === 9);
    assert.ok(s.ultimate && s.ultimate.names.length >= 1);
    assert.ok(s.signatureFusion);
  }
  const cyndaquil = species.species.find((s: any) => s.id === 155);
  assert.deepEqual([cyndaquil.key, cyndaquil.types, cyndaquil.passive.id, cyndaquil.kit.map((k: any) => k.move), cyndaquil.kit.map((k: any) => k.unlockLevel), cyndaquil.evolution.line, cyndaquil.run.maxHp],
    ['cyndaquil', ['fire'], 'heat-haze', ['burning-jealousy', 'temper-flare', 'fire-pledge', 'blast-burn'], [1, 2, 4, 7], [155, 156, 157], 183]);
  const mew = species.species.find((s: any) => s.id === 151);
  assert.ok(mew.moves['151'].any.length > 100, 'Mew can learn any move: its pool is the "any" list');
});

test('moves and items: structured numbers from the game\'s tables', () => {
  assert.equal(moves.moves.length, 759);
  assert.equal(moves.fusions.length, 165);
  const ember = moves.moves.find((m: any) => m.key === 'ember');
  assert.deepEqual([ember.type, ember.class, ember.archetype, ember.cooldown, ember.status, ember.kitOf, ember.upgradeStats], ['fire', 'special', 'bolt', 0.85, 'burn', [4], ['dmg', 'cd', 'count', 'pierce', 'speed', 'crit', 'bounce']]);
  for (const m of moves.moves) {
    assert.ok(moves.archetypes[m.archetype], `${m.key}: archetype ${m.archetype}`);
    for (const x of [m.damage, m.cooldown, m.count, m.area, m.speed, m.duration, m.pierce, m.statusChance]) assert.ok(Number.isFinite(x), `${m.key}: finite numbers`);
  }
  assert.ok(moves.moves.some((m: any) => m.memberVariants.length > 0), 'some moves are defined differently for one League member');
  assert.deepEqual([moves.levelUp.rarityMultipliers, moves.levelUp.upgradesPerOffer, moves.levelUp.damageModPerLevel, moves.levelUp.maxMoveLevel, moves.levelUp.maxVitaminLevel], [[1, 1.2, 1.45, 1.75, 2.1], [2, 2, 2, 3, 3], 0.08, 8, 10]);
  const bolt = moves.archetypes.bolt;
  assert.deepEqual(Object.keys(bolt.upgrades), bolt.upgradeStats);
  for (const u of Object.values(bolt.upgrades) as any[]) assert.equal(u.values.length, 5, 'one value per rarity');
  assert.deepEqual([items.vitamins.length, items.heldItems.length, items.relics.length, items.seals.length, items.overtimeOfferings.length, items.lab.length, items.stats.length], [26, 142, 47, 6, 6, 25, 39]);
  const charcoal = items.heldItems.find((i: any) => i.key === 'charcoal');
  assert.deepEqual([charcoal.name, charcoal.rarity, charcoal.typeBoost, charcoal.mods], ['Charcoal', 0, 'fire', [{ stat: 'damage', mul: 1.03 }]]);
  assert.deepEqual(items.friendship.maxLevel, 20);
});
