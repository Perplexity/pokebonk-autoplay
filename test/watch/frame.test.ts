import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EF } from '../../src/observations/snapshot.ts';
import { buildOf, enemyClass, frameOf } from '../../src/watch/frame.ts';

// What the watch page is sent: pure functions of an observation. No game is loaded here.

const obs = (over: { snapshot?: Record<string, unknown>; state?: Record<string, unknown> } = {}) => ({
  snapshot: {
    t: 581.26, stage: 2, stageTime: 41.04, stageCleared: false, bossSpawned: true, kills: 1234, gold: 987,
    player: { x: 10.04, z: -3.26, hp: 286.4, maxHp: 386, shield: 0, level: 137, xp: 50, xpNext: 200, moves: [{ key: 'future-sight', name: 'Future Sight' }, { key: 'fu-150', name: 'Genetic Supremacy' }], stats: { damage: 18.234, maxHp: 386, luck: 120.4, xpGain: 5.5 } },
    enemies: { count: 3, list: [[1, 12.04, -3, 0, 0, 5, 5, 0.52, 3, 2, 0, 19], [2, 20, 0, 0, 0, 5, 5, 0.8, 3, 2, EF.Elite, 20], [3, 0, 9, 0, 0, 900, 1000, 2, 30, 2, EF.Boss, 150]] },
    shots: [[1.04, 2, 0, 0, 0.3, 12]], hazards: [{ x: 4, z: 5, r: 3, t: 1, kind: 'telegraph' }],
    boss: { x: 0, z: 9, hp: 900, maxHp: 1000, name: 'Raikou' },
    points: [{ kind: 'bill', sub: '', x: 84.04, z: 0, r: 2, used: false, cost: 0, d: 74 }, { kind: 'chest', sub: '', x: 1, z: 1, r: 1, used: true, cost: 50, d: 9 }],
    rift: { inside: false, entrance: null },
    ...over.snapshot,
  },
  state: {
    zone: { finalSwarm: false, finalSwarmSeconds: 0, collapseDrain: 0, inSanctuary: false },
    overtime: { live: false, over: false, round: 0, roundTimeLeft: 0, bonus: 0, drain: 0 },
    rift: { incense: 1 },
    build: {
      moves: [{ slot: 0, key: 'future-sight', level: 10, fusion: false, linked: 'trick-room' }, null, { slot: 2, key: 'fu-150', level: 6, fusion: true, linked: null }],
      vitamins: [{ key: 'exp-candy', level: 12 }], items: [{ key: 'lucky-egg', count: 7 }, { key: 'comet-shard', count: 10 }, { key: 'no-such-item', count: 1 }], relics: ['l-star'], revives: 2,
    },
    ...over.state,
  },
}) as never;
const k = { items: new Map([['lucky-egg', { name: 'Lucky Egg' }], ['comet-shard', { name: 'Comet Shard' }]]), vitamins: new Map([['exp-candy', { name: 'Exp. Candy' }]]) } as never;

test('a frame: the zone, the player, enemies by class, points, and where the player is heading', () => {
  const f = frameOf(obs(), { intent: 'errand', note: "Bill's machine (74 m)", goal: { x: 84.04, z: 0, kind: 'errand' } });
  assert.deepEqual([f.t, f.zone, f.zoneT, f.guardian, f.swarm, f.rift, f.ot], [581.3, 2, 41, 'awake', false, false, null]);
  assert.deepEqual(f.p, { x: 10, z: -3.3, hp: 286, maxHp: 386, shield: 0, level: 137, xp: 0.25 });
  assert.deepEqual(f.e, [12, -3, 0.5, 0, 20, 0, 0.8, 1, 0, 9, 2, 3], 'x, z, radius, class for each enemy');
  assert.deepEqual([f.shots, f.hazards, f.enemies], [[1, 2, 0.3], [4, 5, 3], 3]);
  assert.deepEqual(f.boss, { x: 0, z: 9, hp: 900, maxHp: 1000, name: 'Raikou' });
  assert.deepEqual(f.points, [{ kind: 'bill', x: 84, z: 0, r: 2, used: false }, { kind: 'chest', x: 1, z: 1, r: 1, used: true }]);
  assert.deepEqual([f.goal, f.intent, f.note, f.incense], [{ x: 84, z: 0, kind: 'errand' }, 'errand', "Bill's machine (74 m)", 1]);
  // A fallen guardian's object stays in the snapshot: it is not drawn as one that is up.
  const fallen = frameOf(obs({ snapshot: { stageCleared: true } }), { intent: '', note: '' });
  assert.deepEqual([fallen.guardian, fallen.boss, fallen.goal], ['fallen', null, null]);
  const ot = frameOf(obs({ state: { overtime: { live: true, over: false, round: 17, roundTimeLeft: 12.4, bonus: 9_000_000.4, drain: 310.26 } } }), { intent: '', note: '' });
  assert.deepEqual(ot.ot, { live: true, round: 17, left: 12, bonus: 9_000_000, drain: 310.3 });
});

test('an enemy\'s class on the map', () => {
  assert.deepEqual([0, EF.Elite, EF.Alpha, EF.Totem | EF.Elite, EF.Boss | EF.Elite, EF.Capture, EF.Object | EF.Elite].map(enemyClass), [0, 1, 2, 2, 3, 4, 4]);
});

test('the build as the page lists it: names from the game\'s data, items most held first, a key that changes with it', () => {
  const b = buildOf(obs(), k);
  assert.deepEqual(b.moves, [{ name: 'Future Sight', level: 10, linked: 'Trick Room', fusion: false }, { name: 'Genetic Supremacy', level: 6, linked: null, fusion: true }]);
  assert.deepEqual(b.items, [{ name: 'Comet Shard', count: 10 }, { name: 'Lucky Egg', count: 7 }, { name: 'No Such Item', count: 1 }]);
  assert.deepEqual([b.itemCount, b.vitamins, b.relics, b.revives], [18, [{ name: 'Exp. Candy', level: 12 }], ['L Star'], 2]);
  assert.deepEqual(b.stats, [{ name: 'Damage', value: 18.23 }, { name: 'Max HP', value: 386 }, { name: 'Luck', value: 120.4 }, { name: 'Experience', value: 5.5 }]);
  assert.equal(buildOf(obs(), k).key, b.key);
  assert.notEqual(buildOf(obs({ state: { build: { moves: [], vitamins: [], items: [], relics: [], revives: 0 } } }), k).key, b.key);
});
