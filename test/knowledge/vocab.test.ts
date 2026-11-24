import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { knowledgeDir, loadKnowledge } from '../../src/knowledge/load.ts';
import { DECISION_KINDS, EXTRA_ACTIONS, OFFER_KINDS, VOCAB_VERSION, indexOf, makeTable, tableSize } from '../../src/knowledge/vocab.ts';
import { KNOWLEDGE_VERSION } from '../../src/knowledge/export.ts';
import { UNTARGETED_EXTRAS, TARGETED_EXTRAS } from '../../src/actions/codec.ts';

// No game: these read the exported datasets of the pinned build (data/game-knowledge/mwsewi0r, written by
// scripts/export-knowledge.ts). A deliberate re-export that changes a vocabulary must change the pinned values here.

const BUILD = 'mwsewi0r';
const dir = knowledgeDir(BUILD);
// data/ is not under version control (like mirror/): on a machine without the export, say what to run.
if (!existsSync(join(dir, 'vocab.json'))) throw new Error(`${dir} has no export. Run "node scripts/export-knowledge.ts" (it needs the local mirror of build ${BUILD}).`);
const read = (name: string): any => JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'));
const vocab = read('vocab'), species = read('species'), moves = read('moves'), items = read('items');

test('makeTable: sorted keys numbered from 1, 0 reserved, duplicates and empty keys refused', () => {
  assert.deepEqual(makeTable(['b', 'a', 'c']), { a: 1, b: 2, c: 3 });
  assert.deepEqual(makeTable([10, 9, 100]), { 9: 1, 10: 2, 100: 3 }, 'numeric keys sort numerically');
  assert.deepEqual(makeTable(['b10', 'b9']), { b10: 1, b9: 2 }, 'other keys sort by code unit');
  assert.deepEqual(makeTable(['x', 'y']), makeTable(['y', 'x']), 'the order the keys arrive in does not matter');
  assert.throws(() => makeTable(['a', 'a']), /duplicate key/);
  assert.throws(() => makeTable(['a', '']), /empty key/);
  const t = makeTable(['a', 'b']);
  assert.deepEqual([tableSize(t), indexOf(t, 'b'), indexOf(t, 'zzz'), indexOf(t, null), indexOf(t, undefined)], [3, 2, 0, 0, 0]);
});

test('every dataset carries the same build, bundle hash and versions, says where its data came from and what it lacks', () => {
  for (const [name, d, version] of [['species', species, KNOWLEDGE_VERSION], ['moves', moves, KNOWLEDGE_VERSION], ['items', items, KNOWLEDGE_VERSION], ['vocab', vocab, VOCAB_VERSION]] as const) {
    const h = d.header;
    assert.deepEqual([h.dataset, h.build, h.gameVersion, h.version, h.language, h.profile], [name, BUILD, '0.10.26', version, 'en', 'unlocked-v3']);
    assert.equal(h.bundleSha256, vocab.header.bundleSha256);
    assert.match(h.bundleSha256, /^[0-9a-f]{64}$/);
    assert.ok(Object.keys(h.source).length >= 5 && Object.values(h.source).every((s) => typeof s === 'string' && s.length > 10), `${name}: sources`);
    assert.ok(Array.isArray(h.gaps) && h.gaps.length >= 3, `${name}: gaps`);
    assert.equal('exportedAt' in h, false, 'no wall-clock time: a second export must be byte-identical');
  }
});

test('vocabulary stability: every table is contiguous from 1 in sorted key order, and the pinned build has the pinned indexes', () => {
  const tables: Record<string, Record<string, number>> = vocab.tables;
  const sizes = Object.fromEntries(Object.entries(tables).map(([name, t]) => [name, Object.keys(t).length]));
  assert.deepEqual(sizes, {
    species: 251, type: 18, role: 136, rank: 4, passive: 214, move: 924, archetype: 26, moveClass: 2, status: 13, stat: 39, vitamin: 26, item: 142, relic: 47, runBoost: 9,
    seal: 6, overtimeOffering: 6, offerKind: 4, decisionKind: 23, extraAction: 10, enemyFlag: 24, projectileFlag: 13, map: 14, weather: 7, interactable: 35, rarity: 5, entity: 1441,
  });
  for (const [name, t] of Object.entries(tables)) {
    const idx = Object.values(t).sort((a, b) => a - b);
    assert.deepEqual(idx, idx.map((_, i) => i + 1), `${name}: indexes 1…n, 0 is reserved`);
    // Flags are numbered by bit position and rarities by rank; every other table by sorted key.
    if (!['enemyFlag', 'projectileFlag', 'rarity'].includes(name)) assert.deepEqual(t, makeTable(Object.keys(t)), `${name}: sorted by key`);
  }
  // Pinned for build mwsewi0r, vocabulary version 1.
  assert.equal(createHash('sha256').update(JSON.stringify(tables)).digest('hex'), 'dbeca67449004d3f4943248668f81cc4aa0fbdf2d25826733b2fac6537b47492');
  assert.deepEqual(
    [tables.species['155'], tables.type.fire, tables.move.ember, tables.item.charcoal, tables.vitamin.protein, tables.entity['move:ember'], tables.entity['species:155'], tables.entity['stat:luck'],
      tables.decisionKind.levelup, tables.offerKind.newMove, tables.map.forest, tables.passive['heat-haze'], tables.interactable.chest, tables.enemyFlag.Boss, tables.seal.clock, tables.weather.rain],
    [155, 7, 192, 19, 17, 334, 1188, 1397, 12, 1, 6, 59, 9, 3, 1, 5]);
  // Bit numbering of the enemy flags: the value is the bit position + 1 (Elite = 1 → bit 0, Boss = 4 → bit 2).
  assert.deepEqual([tables.enemyFlag.Elite, tables.enemyFlag.Alpha, tables.enemyFlag.Boss, tables.enemyFlag.Ranged, tables.enemyFlag.Horde], [1, 2, 3, 4, 24]);
});

test('the vocabulary is exactly the keys of the datasets it indexes', () => {
  const t: Record<string, Record<string, number>> = vocab.tables;
  const keys = (table: string): string[] => Object.keys(t[table]).sort();
  const same = (table: string, want: string[]) => assert.deepEqual(keys(table), [...new Set(want)].sort(), table);
  same('species', species.pokedex.map((s: any) => String(s.id)));
  same('move', [...moves.moves.map((m: any) => m.key), ...moves.fusions.map((f: any) => f.key)]);
  same('archetype', Object.keys(moves.archetypes));
  same('vitamin', items.vitamins.map((v: any) => v.key));
  same('item', items.heldItems.map((i: any) => i.key));
  same('relic', items.relics.map((r: any) => r.key));
  same('seal', items.seals.map((s: any) => s.key));
  same('overtimeOffering', items.overtimeOfferings.map((s: any) => s.key));
  same('stat', items.stats.map((s: any) => s.key));
  same('weather', items.weather.map((w: any) => w.key));
  same('map', items.maps.map((m: any) => m.key));
  same('type', items.types.order);
  same('role', species.species.map((s: any) => s.role));
  same('passive', [...keys('passive')]);
  for (const s of species.species) assert.ok(t.passive[s.passive.id] > 0, `passive of ${s.id}`);
  same('decisionKind', [...DECISION_KINDS]);
  same('extraAction', [...EXTRA_ACTIONS]);
  same('offerKind', [...OFFER_KINDS]);
  // Every extra action has a place in the action codec.
  assert.deepEqual([...UNTARGETED_EXTRAS, ...TARGETED_EXTRAS].sort(), [...EXTRA_ACTIONS].sort());
  // The shared entity table is the union of its domains.
  const domains = new Map<string, number>();
  for (const k of Object.keys(t.entity)) { const d = k.slice(0, k.indexOf(':')); domains.set(d, (domains.get(d) ?? 0) + 1); }
  assert.deepEqual(Object.fromEntries(domains), { move: 924, vitamin: 26, item: 142, relic: 47, seal: 6, offering: 6, species: 251, stat: 39 });
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

test('loadKnowledge: the joins the encoder uses, and a clear error for a build that was not exported', () => {
  const k = loadKnowledge(BUILD);
  assert.deepEqual([k.build, k.vocabVersion], [BUILD, VOCAB_VERSION]);
  assert.equal(k.vocabSha256, 'dbeca67449004d3f4943248668f81cc4aa0fbdf2d25826733b2fac6537b47492', 'the hash of the tables, not of the file: header changes do not move the layout hash');
  assert.deepEqual(k.typesOf.get(6), ['fire', 'flying']);
  assert.equal(k.typesOf.size, 251);
  assert.deepEqual(k.memberOf.get(155), { role: 'Volcano', rank: 'common' });
  assert.equal(k.moveKeyById.get(52), 'ember');
  assert.equal(k.moveKeyById.get(50000), 'fu-1');
  assert.deepEqual([k.statKind.get('maxHp'), k.statKind.get('damage'), k.statKind.get('critChance')], ['flat', 'mult', 'pctpts']);
  assert.deepEqual(k.upgradeStats, ['area', 'bounce', 'cd', 'count', 'crit', 'dmg', 'dur', 'pierce', 'speed', 'status']);
  assert.deepEqual(k.keys('type')[k.tables.type.fire - 1], 'fire');
  assert.throws(() => loadKnowledge('nosuchbuild'), /Run "node scripts\/export-knowledge\.ts"/);
});
