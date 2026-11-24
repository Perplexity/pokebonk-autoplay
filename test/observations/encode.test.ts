import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPTION_SLOTS } from '../../src/actions/codec.ts';
import type { Snapshot } from '../../src/bot/snapshot.ts';
import type { ChoiceMask, Decision, Observation, PlayMask } from '../../src/environment/index.ts';
import { MOVES } from '../../src/environment/index.ts';
import { loadKnowledge } from '../../src/knowledge/load.ts';
import { EncodingError, OBS_ENCODING_VERSION, ObservationEncoder, SIZES, applyScale } from '../../src/observations/encode.ts';
import type { Scale } from '../../src/observations/encode.ts';
import { DENSITY_SIZE, STATE_SCHEMA } from '../../src/observations/state.ts';
import type { RunState } from '../../src/observations/state.ts';

// No game: synthetic observations against the exported knowledge of the pinned build.

const K = loadKnowledge('mwsewi0r');
const enc = new ObservationEncoder(K);

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    v: 1, t: 12, state: 'play', mode: 'standard', biome: 'forest', tier: 0, stage: 1, stageTime: 12, mutation: null,
    diff: { enemyHp: 1, enemyDamage: 1, enemySpeed: 1, enemyAmount: 1 }, timeScale: 1, fps: 60, camYaw: 0, gold: 50, ballCost: 18, pendingLevels: 0,
    bossSpawned: false, stageCleared: false, victory: false, weather: 'clear', kills: 3,
    player: {
      x: 10, y: 0, z: -20, vx: 0, vz: 0, hp: 100, maxHp: 200, shield: 0, level: 3, xp: 5, xpNext: 20, dead: false, iframes: 0, grounded: true, speed: 14, radius: 0.5, pickupRange: 9,
      sliding: false, dashReady: true, jumpsLeft: 1, species: 155, ability: 'heat-haze', moves: [], moveSlots: 4, vitaminSlots: 5, items: {}, vitamins: {}, stats: { maxHp: 200, damage: 1.32, critChance: 0.1, luck: 30 },
    },
    ult: { charge: 0.5, active: false, ready: false },
    enemies: { count: 0, list: [] }, shots: [], hazards: [], waves: [], boss: null,
    pickups: { xpN: 0, xpX: 0, xpZ: 0, heal: [], other: [] }, points: [], capture: null, friendBall: false, rift: { inside: false, entrance: null },
    terrain: { ring: Array(16).fill(0), ring2: Array(16).fill(0), blocked: Array(16).fill(0), free: Array(16).fill(9), hop: Array(16).fill(9), bounds: 168 },
    ...over,
  };
}

function state(over: Partial<RunState> = {}): RunState {
  return {
    schema: STATE_SCHEMA,
    build: {
      species: 155, startSpecies: 155, evoStage: 0, passive: 'heat-haze', level: 3, xp: 5, xpNext: 20, pendingLevels: 0, moveSlots: 4, moveSlotsFree: 3,
      moves: [{ slot: 0, key: 'burning-jealousy', id: 807, level: 2, type: 'fire', cls: 'special', arch: 'cone', cooldownLeft: 0.9, cooldownTotal: 1.8, busy: false, damageDone: 50, fusion: false, linked: null }, null, null, null],
      vitaminSlots: 5, vitaminSlotsFree: 4, vitamins: [{ key: 'protein', level: 3 }], items: [{ key: 'charcoal', count: 2 }], relics: ['c-fang'],
      refreshes: 9, skips: 9, banishes: 8, nextEvolution: { to: 156, level: 22 }, revives: 1,
    },
    player: { dashCooldown: 0, dashing: false, grounded: true, jumpsLeft: 1, diving: false, vy: 0, height: 0 },
    ultimate: { charge: 0.5, ready: false, active: 0, uses: 0 },
    economy: { gold: 50, ballPrice: 18, ballsBought: 0, shopRerolls: 0, cagePrice: 60, slotPrice: 40 },
    forms: { charges: 0, ready: false, active: 0, locked: false },
    rift: { incense: 1, canOpen: true, canFuse: false },
    hypnoLessonReady: true,
    dojo: null,
    pointsUsed: {},
    zone: { zone: 1, zoneTime: 12, time: 12, weather: 'clear', finalSwarm: false, finalSwarmSeconds: 0, collapseDrain: 0, healMultiplier: 1, inSanctuary: false },
    guardian: { species: 123, asleep: true, alive: false, hp: 0, maxHp: 0, enraged: false, fightTime: 0, seals: [], sealsBroken: false, clockLeft: 0 },
    stageCleared: false, regionCleared: false,
    overtime: { offered: false, live: false, over: false, cashed: false, lost: false, direct: false, round: 0, roundTimeLeft: 0, seconds: 0, multiplier: 0, bonus: 0, drain: 0, ringClosing: false, ringRadius: 0, arenaRadius: 0, offerings: [] },
    sealsKept: 0,
    enemies: { live: 0, elites: 0, alphas: 0, ranged: 0, cap: 800, capMax: 800, density: Array(DENSITY_SIZE).fill(0) },
    counters: {
      time: 12, kills: 3, damageDealt: 100, damageTaken: 0, healed: 0, hits: 0, dodges: 0, guardiansDefeated: 0, legendariesDefeated: 0, alphasDefeated: 0, totemsDefeated: 0, summonersDefeated: 0,
      zonesEntered: 1, zonesCleared: 0, level: 3, itemsHeld: 2, itemsPeak: 2, movesLearned: 0, evolutions: 0, ultimatesUsed: 0, goldEarned: 50, goldSpent: 0, ballsBought: 0, captured: 0, sealsKept: 0, sealsBroken: 0,
      overtimeBonus: 0, overtimeRounds: 0,
      shopBought: 0, shopSpent: 0, shopSold: 0, itemsSold: 0, slotSpins: 0, lessons: 0, forgets: 0, riftsCleared: 0, formsUsed: 0, movesLinked: 0, pointsUsed: 0, mapUse: 0,
    },
    ...over,
  };
}

const playMask: PlayMask = { phase: 'play', move: MOVES.map(() => true), jump: true, dash: true, ultimate: false, interact: true, form: false, incense: false, fuse: false };
const play = (s: Partial<Snapshot> = {}, st: Partial<RunState> = {}): Observation => ({ schema: 3, phase: 'play', step: 1, simStep: 3, snapshot: snapshot(s), decision: null, mask: playMask, state: state(st) });
function dialog(decision: Partial<Decision> & Pick<Decision, 'kind' | 'options'>, mask: Omit<ChoiceMask, 'phase'>, st: Partial<RunState> = {}): Observation {
  return { schema: 3, phase: 'choice', step: 1, simStep: 3, snapshot: snapshot({ state: 'modal' }), decision: { method: 'x', title: '', extras: {}, context: {}, serial: 1, ...decision }, mask: { phase: 'choice', ...mask }, state: state(st) };
}
const val = (o: Observation, segment: string, feature: string, row = 0, prev = null as Parameters<typeof enc.encode>[1]): number => enc.value(enc.encode(o, prev), segment, feature, row);

test('scales: bounded for every input, non-finite becomes 0', () => {
  const scales: Scale[] = [{ kind: 'bool' }, { kind: 'unit', max: 10 }, { kind: 'sym', max: 10 }, { kind: 'log', max: 1000 }, { kind: 'slog', max: 1000 }];
  for (const s of scales) for (const v of [0, 1, -1, 5, -5, 10, 1e9, -1e9, Number.MAX_VALUE, -Number.MAX_VALUE, NaN, Infinity, -Infinity, 1e-12]) {
    const x = applyScale(s, v);
    const lo = s.kind === 'sym' || s.kind === 'slog' ? -1 : 0;
    assert.ok(Number.isFinite(x) && x >= lo && x <= 1, `${s.kind}(${v}) = ${x}`);
  }
  assert.deepEqual([applyScale({ kind: 'unit', max: 10 }, 5), applyScale({ kind: 'unit', max: 10 }, -3), applyScale({ kind: 'unit', max: 10 }, 30)], [0.5, 0, 1]);
  assert.deepEqual([applyScale({ kind: 'sym', max: 10 }, -5), applyScale({ kind: 'sym', max: 10 }, -30)], [-0.5, -1]);
  assert.deepEqual([applyScale({ kind: 'log', max: 99 }, 0), applyScale({ kind: 'log', max: 99 }, 99), applyScale({ kind: 'log', max: 99 }, 9)], [0, 1, 0.5]);
  assert.deepEqual([applyScale({ kind: 'slog', max: 99 }, -9), applyScale({ kind: 'slog', max: 99 }, -1e6)], [-0.5, -1]);
  assert.deepEqual([applyScale({ kind: 'bool' }, true), applyScale({ kind: 'bool' }, false), applyScale({ kind: 'unit', max: 2 }, NaN), applyScale({ kind: 'slog', max: 2 }, -Infinity)], [1, 0, 0, 0]);
});

test('layout: versioned, hashed, contiguous segments, unique feature names, sizes from the declared constants', () => {
  const L = enc.layout;
  assert.equal(L.version, OBS_ENCODING_VERSION);
  assert.match(L.hash, /^[0-9a-f]{64}$/);
  assert.equal(new ObservationEncoder(K).layout.hash, L.hash, 'same code + same vocabulary = same layout');
  assert.deepEqual(L.knowledge, { build: 'mwsewi0r', gameVersion: '0.10.26', vocabVersion: 2, vocabSha256: K.vocabSha256 });
  for (const dtype of ['float32', 'int32'] as const) {
    let at = 0;
    for (const s of L.segments.filter((x) => x.dtype === dtype)) {
      assert.equal(s.offset, at, `${s.name} starts where the previous segment ends`);
      assert.equal(s.features.length, s.shape[1]);
      assert.equal(new Set(s.features.map((f) => f.name)).size, s.features.length, `${s.name}: unique feature names`);
      for (const f of s.features) assert.ok(dtype === 'float32' ? !!f.scale : !!f.vocab && !!K.tables[f.vocab], `${s.name}.${f.name} declares its ${dtype === 'float32' ? 'scale' : 'vocabulary'}`);
      at += s.shape[0] * s.shape[1];
    }
    assert.equal(at, dtype === 'float32' ? L.floatSize : L.intSize);
  }
  const shape = (name: string) => L.segments.find((s) => s.name === name)!.shape;
  assert.deepEqual([shape('enemies')[0], shape('shots')[0], shape('hazards')[0], shape('pickups')[0], shape('points')[0], shape('moves')[0], shape('options')[0]], [SIZES.enemies, SIZES.shots, SIZES.hazards, SIZES.pickups, SIZES.points, SIZES.moveSlots, OPTION_SLOTS]);
  assert.deepEqual([shape('density'), shape('vitamins'), shape('items'), shape('relics'), shape('stats'), shape('terrain')], [[1, 48], [1, 26], [1, 142], [1, 47], [1, 39], [1, 84]]);
  assert.deepEqual(L.segments.map((s) => s.name), ['global', 'stats', 'enemies', 'density', 'shots', 'hazards', 'xp', 'pickups', 'points', 'terrain', 'moves', 'vitamins', 'items', 'relics', 'choice', 'options', 'ids', 'move_slots', 'enemy_species', 'option_entity']);
  assert.deepEqual([L.floatSize, L.intSize], [7553, 195]);
});

test('an empty moment encodes to bounded values with empty entity rows all zero', () => {
  const e = enc.encode(play());
  assert.deepEqual([e.float.length, e.int.length], [enc.layout.floatSize, enc.layout.intSize]);
  for (const v of e.float) assert.ok(v >= -1 && v <= 1);
  for (const name of ['enemies', 'shots', 'hazards', 'pickups', 'points', 'options']) assert.ok(enc.slice(e, name).every((row) => row.every((v) => v === 0)), `${name} is empty`);
  assert.deepEqual(enc.slice(e, 'choice')[0].reduce((a, b) => a + b, 0), 0, 'no dialog: the choice segment is zero');
  assert.deepEqual([enc.value(e, 'global', 'hp_frac'), enc.value(e, 'global', 'phase:play'), enc.value(e, 'global', 'zone:1'), enc.value(e, 'global', 'tier:0'), enc.value(e, 'global', 'can_interact'), enc.value(e, 'global', 'can_ultimate')], [0.5, 1, 1, 1, 1, 0]);
  assert.deepEqual([enc.value(e, 'global', 'type:fire'), enc.value(e, 'global', 'type:water'), enc.value(e, 'global', 'rank:common'), enc.value(e, 'global', 'weather:clear'), enc.value(e, 'global', 'guardian_asleep')], [1, 0, 1, 1, 1]);
  // Position on the map and distance to its edges: world axes, not the camera's.
  assert.ok(Math.abs(enc.value(e, 'global', 'map_x') - 10 / 168) < 1e-6 && Math.abs(enc.value(e, 'global', 'map_z') + 20 / 168) < 1e-6);
  assert.deepEqual([enc.value(e, 'terrain', 'edge_east'), enc.value(e, 'terrain', 'free0')], [1, 1]);
  // Identity of the Pokémon beyond its number: types, role, rank, passive.
  assert.deepEqual([enc.value(e, 'ids', 'species'), enc.value(e, 'ids', 'type1'), enc.value(e, 'ids', 'type2'), enc.value(e, 'ids', 'role'), enc.value(e, 'ids', 'rank'), enc.value(e, 'ids', 'passive'), enc.value(e, 'ids', 'map'), enc.value(e, 'ids', 'guardian_species'), enc.value(e, 'ids', 'decision_kind')],
    [155, K.tables.type.fire, 0, K.tables.role.Volcano, K.tables.rank.common, K.tables.passive['heat-haze'], K.tables.map.forest, 123, 0]);
  // Build.
  assert.deepEqual([enc.value(e, 'moves', 'present', 0), enc.value(e, 'moves', 'cooldown_frac', 0), enc.value(e, 'moves', 'type:fire', 0), enc.value(e, 'moves', 'present', 1)], [1, 0.5, 1, 0]);
  assert.ok(Math.abs(enc.value(e, 'moves', 'level', 0) - 0.2) < 1e-6 && Math.abs(enc.value(e, 'moves', 'damage_share', 0) - 0.5) < 1e-6);
  assert.deepEqual([enc.value(e, 'move_slots', 'entity', 0), enc.value(e, 'move_slots', 'archetype', 0), enc.value(e, 'move_slots', 'entity', 1)], [K.tables.entity['move:burning-jealousy'], K.tables.archetype.cone, 0]);
  assert.deepEqual([enc.value(e, 'vitamins', 'protein'), enc.value(e, 'items', 'charcoal'), enc.value(e, 'relics', 'c-fang'), enc.value(e, 'relics', 'c-shell')].map((v) => Math.round(v * 1000) / 1000), [0.25, 0.2, 1, 0]);
  // Stats by kind: mult as (v − 1) / 2, percentage points as the fraction, flat on a log scale.
  assert.ok(Math.abs(enc.value(e, 'stats', 'damage') - 0.16) < 1e-6 && Math.abs(enc.value(e, 'stats', 'critChance') - 0.1) < 1e-6 && enc.value(e, 'stats', 'luck') > 0.5 && enc.value(e, 'stats', 'moveSpeed') === 0);
});

test('entities: relative to the player in world axes whatever the camera yaw, nearest K kept, flags as bits', () => {
  const list = Array.from({ length: 60 }, (_, i) => [i, 10 + (i + 1), -20, -2, 0, 5, 10, 0.6, 20, 3, i === 0 ? 1 | 4 : 8, 16, 1.5] as [number, number, number, number, number, number, number, number, number, number, number, number, number]);
  for (const camYaw of [0, 1.3, -2.7]) {
    const e = enc.encode(play({ camYaw, enemies: { count: 60, list }, boss: { i: 0, name: 'x', species: 123, x: 11, z: -20, hp: 5, maxHp: 10, radius: 2, enraged: false, chargeT: 0.5, cdx: 1, cdz: 0, move: '', moveT: 0, fightT: 3, phase: '' } }));
    const rows = enc.slice(e, 'enemies');
    assert.equal(rows.filter((r) => r[0] === 1).length, SIZES.enemies, 'the 48 nearest of 60');
    const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);
    near(enc.value(e, 'enemies', 'dx', 0), 1 / 45); near(enc.value(e, 'enemies', 'dz', 0), 0); near(enc.value(e, 'enemies', 'dist', 0), 1 / 45);
    near(enc.value(e, 'enemies', 'dx', 47), 48 / 45 > 1 ? 1 : 48 / 45);
    near(enc.value(e, 'enemies', 'approach_speed', 0), 2 / 15);                 // moving towards −x at 2 m/s while east of the player
    near(enc.value(e, 'enemies', 'hp_frac', 0), 0.5); near(enc.value(e, 'enemies', 'contact_damage_frac', 0), 0.1); near(enc.value(e, 'enemies', 'attack_in', 0), 0.3);
    assert.deepEqual([enc.value(e, 'enemies', 'is_boss', 0), enc.value(e, 'enemies', 'flag:Elite', 0), enc.value(e, 'enemies', 'flag:Boss', 0), enc.value(e, 'enemies', 'flag:Ranged', 0), enc.value(e, 'enemies', 'flag:Ranged', 1), enc.value(e, 'enemies', 'is_boss', 1)], [1, 1, 1, 0, 1, 0]);
    assert.deepEqual([enc.value(e, 'enemy_species', 'species', 0), enc.value(e, 'enemy_species', 'species', 47), enc.value(e, 'ids', 'boss_species')], [16, 16, 123]);
    near(enc.value(e, 'global', 'boss_dx'), 1 / 60); assert.deepEqual([enc.value(e, 'global', 'boss_present'), enc.value(e, 'global', 'boss_charging'), enc.value(e, 'global', 'boss_charge_dx')], [1, 1, 1]);
  }
  // Shots, hazards, pickups and points are sorted by distance here (the snapshot does not order them).
  const e = enc.encode(play({
    shots: [[40, -20, -10, 0, 0.4, 20], [13, -20, -10, 0, 0.4, 20]],
    hazards: [{ x: 10, z: -10, r: 3, t: 1, kind: 'telegraph' }, { x: 10, z: -19, r: 3, t: 0, kind: 'boss.pools' }], waves: [{ x: 10, z: -20, r: 30, max: 40, speed: 12 }],
    pickups: { xpN: 4, xpX: 12, xpZ: -20, heal: [], other: [[2, 30, -20], [5, 11, -20], [99, 10, -21]] },
    points: [{ kind: 'chest', sub: '', x: 60, z: -20, r: 3, used: false, cost: 18, d: 50 }, { kind: 'boss', sub: '', x: 12, z: -20, r: 3, used: false, cost: 0, d: 2 }, { kind: 'chest', sub: '', x: 10, z: 30, r: 3, used: false, cost: 80, d: 50.1 }],
  }));
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  assert.deepEqual([enc.value(e, 'shots', 'dx', 0), enc.value(e, 'shots', 'closest_approach_in', 0), enc.value(e, 'shots', 'closest_approach_dist', 0), enc.value(e, 'shots', 'damage_frac', 0)].map(r3), [0.1, 0.1, 0, 0.1]);
  assert.deepEqual([enc.value(e, 'shots', 'dx', 1), enc.value(e, 'shots', 'present', 2)].map(r3), [1, 0]);
  assert.deepEqual([enc.value(e, 'hazards', 'kind:boss', 0), enc.value(e, 'hazards', 'inside', 0), enc.value(e, 'hazards', 'kind:telegraph', 1), enc.value(e, 'hazards', 'inside', 1), enc.value(e, 'hazards', 'kind:wave', 2), enc.value(e, 'hazards', 'wave_max_radius', 2)], [1, 1, 1, 0, 1, 1]);
  assert.deepEqual([enc.value(e, 'xp', 'present'), r3(enc.value(e, 'xp', 'dx')), enc.value(e, 'pickups', 'kind:5', 0), enc.value(e, 'pickups', 'kind:2', 2), enc.value(e, 'pickups', 'present', 1)], [1, 0.1, 1, 1, 1]);
  assert.equal(enc.slice(e, 'pickups')[1].slice(4).reduce((a, b) => a + b, 0), 0, 'a pickup kind beyond the one-hot has no kind bit…');
  assert.ok((enc.unknown.get('pickupKind:99') ?? 0) > 0, '…and is counted as unknown');
  assert.deepEqual([enc.value(e, 'points', 'kind:boss', 0), enc.value(e, 'points', 'in_reach', 0), enc.value(e, 'points', 'kind:chest', 1), enc.value(e, 'points', 'affordable', 1), enc.value(e, 'points', 'affordable', 2), r3(enc.value(e, 'points', 'dx', 1))], [1, 1, 1, 1, 0, 0.25]);
});

test('previous action, density, overtime and seals', () => {
  const density = Array(DENSITY_SIZE).fill(0); density[0] = 200; density[5] = 1;
  const o = play({}, {
    enemies: { live: 201, elites: 3, alphas: 1, ranged: 10, cap: 800, capMax: 800, density },
    guardian: { species: 151, asleep: false, alive: true, hp: 500, maxHp: 1000, enraged: true, fightTime: 30, seals: ['clock', 'echo'], sealsBroken: false, clockLeft: 60 },
    overtime: { offered: false, live: true, over: false, cashed: false, lost: false, direct: false, round: 3, roundTimeLeft: 15, seconds: 75, multiplier: 2.5, bonus: 40, drain: 2, ringClosing: true, ringRadius: 40, arenaRadius: 50, offerings: ['dique'] },
    sealsKept: 6,
  });
  const e = enc.encode(o, { type: 'play', move: 'se', dash: true });
  assert.deepEqual([enc.value(e, 'global', 'prev_move:se'), enc.value(e, 'global', 'prev_move:none'), enc.value(e, 'global', 'prev_dash'), enc.value(e, 'global', 'prev_jump')], [1, 0, 1, 0]);
  assert.equal(enc.slice(enc.encode(o, null), 'global')[0].slice(enc.layout.segments[0].features.findIndex((f) => f.name === 'prev_move:none')).slice(0, 13).reduce((a, b) => a + b, 0), 0, 'no previous action: all zero');
  assert.deepEqual([enc.value(e, 'density', 'dir0_band0'), enc.value(e, 'density', 'dir1_band2') > 0, enc.value(e, 'density', 'dir2_band0')], [1, true, 0]);
  assert.deepEqual([enc.value(e, 'global', 'guardian_alive'), enc.value(e, 'global', 'guardian_hp_frac'), enc.value(e, 'global', 'seal_active:clock'), enc.value(e, 'global', 'seal_active:fury'), enc.value(e, 'global', 'seal_clock_running'), enc.value(e, 'global', 'seals_kept')], [1, 0.5, 1, 0, 1, 0.5]);
  assert.deepEqual([enc.value(e, 'global', 'overtime_live'), enc.value(e, 'global', 'overtime_round'), enc.value(e, 'global', 'overtime_round_left'), enc.value(e, 'global', 'overtime_ring_closing'), enc.value(e, 'global', 'overtime_offering:dique'), enc.value(e, 'global', 'overtime_offering:cebo')], [1, 0.125, 0.5, 1, 1, 0]);
  assert.equal(enc.value(e, 'ids', 'guardian_species'), 151);
});

test('choice: dialog kind, per-option features, entities from the vocabulary, masks', () => {
  const options: Decision['options'] = [
    { id: 'newMove:m52', label: '', data: { kind: 'newMove', id: 52, rarity: 0, key: 'm52', from: 4 } },
    { id: 'upMove:m807', label: '', data: { kind: 'upMove', slot: 0, rarity: 3, key: 'm807', ups: [{ key: 'dmg', value: 0.385, label: '' }, { key: 'area', value: 0.2625, label: '' }] } },
    { id: 'upVit:vprotein', label: '', data: { kind: 'upVit', vit: 'protein', rarity: 1, key: 'vprotein' } },
    { id: 'newVit:vcarbos', label: '', data: { kind: 'newVit', vit: 'carbos', rarity: 4, key: 'vcarbos' } },
  ];
  const o = dialog({ kind: 'levelup', options, extras: { refresh: { needsTarget: false, effect: '' }, skip: { needsTarget: false, effect: '' }, banish: { needsTarget: true, effect: '' }, banishKit: { needsTarget: true, effect: '' } } },
    { options: [true, true, true, true], extras: { refresh: true, skip: false, banish: [true, true, true, true], banishKit: [true, false, false, false] } });
  const e = enc.encode(o);
  assert.deepEqual([enc.value(e, 'global', 'phase:choice'), enc.value(e, 'choice', 'kind:levelup'), enc.value(e, 'choice', 'kind:shop'), enc.value(e, 'ids', 'decision_kind')], [1, 1, 0, K.tables.decisionKind.levelup]);
  assert.ok(Math.abs(enc.value(e, 'choice', 'options') - 4 / OPTION_SLOTS) < 1e-6);
  assert.deepEqual([enc.value(e, 'choice', 'has:refresh'), enc.value(e, 'choice', 'allowed:refresh'), enc.value(e, 'choice', 'has:skip'), enc.value(e, 'choice', 'allowed:skip'), enc.value(e, 'choice', 'has:sell')], [1, 1, 1, 0, 0]);
  const rows = enc.slice(e, 'options');
  assert.equal(rows.filter((r) => r[0] === 1).length, 4);
  assert.deepEqual([0, 1, 2, 3].map((i) => ['newMove', 'upMove', 'newVit', 'upVit'].find((k) => enc.value(e, 'options', `offer:${k}`, i) === 1)), ['newMove', 'upMove', 'upVit', 'newVit']);
  assert.deepEqual([0, 1, 2, 3].map((i) => enc.value(e, 'options', 'rarity', i)), [0, 0.75, 0.25, 1]);
  assert.deepEqual([enc.value(e, 'options', 'from_other_kit', 0), enc.value(e, 'options', 'banish_kit_allowed', 0), enc.value(e, 'options', 'banish_kit_allowed', 1), enc.value(e, 'options', 'banish_allowed', 3)], [1, 1, 0, 1]);
  assert.ok(Math.abs(enc.value(e, 'options', 'current_level', 1) - 2 / 12) < 1e-6 && Math.abs(enc.value(e, 'options', 'current_level', 2) - 3 / 12) < 1e-6 && enc.value(e, 'options', 'current_level', 3) === 0);
  assert.ok(Math.abs(enc.value(e, 'options', 'upgrade:dmg', 1) - 0.1925) < 1e-6 && Math.abs(enc.value(e, 'options', 'upgrade:area', 1) - 0.13125) < 1e-6 && enc.value(e, 'options', 'upgrade:cd', 1) === 0);
  assert.deepEqual(enc.slice(e, 'option_entity').slice(0, 5), [
    [K.tables.entity['move:ember'], K.tables.entity['species:4']], [K.tables.entity['move:burning-jealousy'], 0], [K.tables.entity['vitamin:protein'], 0], [K.tables.entity['vitamin:carbos'], 0], [0, 0]]);

  // Shop: prices against the Pokédollars held; seals: which seals a subset has; blessing: the stat and its amount.
  const shop = enc.encode(dialog({ kind: 'shop', options: [{ id: 'charcoal', label: '', data: { key: 'charcoal', price: 40, sold: false, owned: 2 } }, { id: 'leftovers', label: '', data: { key: 'leftovers', price: 400, sold: false, owned: 0 } }], context: { gold: 50, rerollCost: 30 }, extras: { reroll: { needsTarget: false, effect: '' }, leave: { needsTarget: false, effect: '' } } },
    { options: [true, false], extras: { reroll: true, leave: true } }));
  assert.deepEqual([enc.value(shop, 'options', 'allowed', 0), enc.value(shop, 'options', 'affordable', 0), enc.value(shop, 'options', 'allowed', 1), enc.value(shop, 'options', 'affordable', 1), enc.value(shop, 'options', 'has_price', 1), enc.value(shop, 'choice', 'allowed:reroll'), enc.value(shop, 'choice', 'allowed:leave')], [1, 1, 0, 0, 1, 1, 1]);
  assert.ok(Math.abs(enc.value(shop, 'options', 'owned', 0) - 0.2) < 1e-6 && enc.value(shop, 'choice', 'shop_restock_cost') > 0);
  assert.deepEqual(enc.slice(shop, 'option_entity').slice(0, 2), [[K.tables.entity['item:charcoal'], 0], [K.tables.entity['item:leftovers'], 0]]);
  const seals = enc.encode(dialog({ kind: 'seals', options: [{ id: 'none', label: '', data: { seals: [] } }, { id: 'clock+echo', label: '', data: { seals: ['clock', 'echo'] } }], context: { legendary: true } }, { options: [true, true], extras: { decline: true } }));
  assert.deepEqual([enc.value(seals, 'options', 'seal:clock', 1), enc.value(seals, 'options', 'seal:fury', 1), enc.value(seals, 'options', 'seal:clock', 0), enc.value(seals, 'choice', 'legendary'), enc.value(seals, 'choice', 'allowed:decline')], [1, 0, 0, 1, 1]);
  assert.ok(Math.abs(enc.value(seals, 'options', 'seal_count', 1) - 2 / 3) < 1e-6);
  const blessing = enc.encode(dialog({ kind: 'blessing', options: [{ id: 'a', label: '', data: { label: '+18 luck', mods: [{ stat: 'luck', add: 18 }], rarity: 1 } }, { id: 'b', label: '', data: { label: '+12%', mods: [{ stat: 'attackSpeed', mul: 1.12 }], rarity: 1 } }] }, { options: [true, true], extras: {} }));
  assert.deepEqual(enc.slice(blessing, 'option_entity').slice(0, 2), [[K.tables.entity['stat:luck'], 0], [K.tables.entity['stat:attackSpeed'], 0]]);
  assert.ok(enc.value(blessing, 'options', 'stat_add', 0) > 0.5 && Math.abs(enc.value(blessing, 'options', 'stat_mul', 1) - 0.12) < 1e-6 && enc.value(blessing, 'options', 'stat_mul', 0) === 0);
  const relic = enc.encode(dialog({ kind: 'relic', options: [{ id: 'c-shell@0', label: '', data: { key: 'c-shell', rarity: 0, replaces: 'c-fang' } }] }, { options: [true], extras: { decline: true } }));
  assert.deepEqual([enc.slice(relic, 'option_entity')[0], enc.value(relic, 'options', 'replaces_held', 0)], [[K.tables.entity['relic:c-shell'], K.tables.entity['relic:c-fang']], 1]);
});

test('map features: Max form, Incense, the dojo trial, prices, and the options of the dojo, Hypno, Bill\'s machine, the slot machine and selling', () => {
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);
  const L = enc.layout, PX = 10, PZ = -20;   // the fixture's player position
  // ---- play phase ----
  const mask: PlayMask = { ...playMask, form: true, incense: true };
  const base = state();
  const st = state({
    forms: { charges: 2, ready: true, active: 12, locked: false }, rift: { incense: 3, canOpen: true, canFuse: true }, hypnoLessonReady: false,
    dojo: { key: 'circle', belt: 2, timeLeft: 30, progress: 7, goal: 35, area: { x: PX + 10, z: PZ - 5, radius: 6 }, graceLeft: 1.5, holdFrac: 0, fighters: 4, nearestFighter: { x: PX - 9, z: PZ } },
    counters: { ...base.counters, pointsUsed: 12, mapUse: 20 },
  });
  const o: Observation = { ...play({ points: [{ kind: 'slots', sub: '', x: PX + 5, z: PZ, r: 3, used: false, cost: 0, d: 5 }, { kind: 'cage', sub: '', x: PX, z: PZ + 8, r: 3, used: false, cost: 0, d: 8 }] }, st), mask };
  const e = enc.encode(o, { type: 'play', move: 'n', form: true, fuse: true });
  const g = (name: string) => enc.value(e, 'global', name);
  assert.deepEqual([g('form_ready'), g('rift_can_open'), g('rift_can_fuse'), g('hypno_lesson_ready'), g('dojo_active'), g('dojo:circle'), g('dojo:statue'), g('dojo_area'), g('dojo_fighter')], [1, 1, 1, 0, 1, 1, 0, 1, 1]);
  assert.deepEqual([g('can_form'), g('can_incense'), g('can_fuse'), g('can_interact'), g('prev_form'), g('prev_incense'), g('prev_fuse')], [1, 1, 0, 1, 1, 0, 1]);
  near(g('form_charges'), 2 / 3); near(g('form_active_for'), 12 / 30); near(g('incense'), 1); near(g('dojo_belt'), 2 / 3); near(g('dojo_time_left'), 30 / 90); near(g('dojo_progress_frac'), 0.2);
  near(g('dojo_area_dx'), 10 / 60); near(g('dojo_area_dz'), -5 / 60); near(g('dojo_area_radius'), 0.5); near(g('dojo_grace_left'), 0.25); near(g('dojo_fighter_dx'), -9 / 45);
  assert.ok(g('slot_price') > 0 && g('cage_price') > g('slot_price') && g('slot_affordable') === 1 && g('map_points_used') > 0);
  // A map point's price: the run's own figure for slot machines and cages (the snapshot carries 0 for them).
  assert.ok(enc.value(e, 'points', 'cost', 0) > 0 && enc.value(e, 'points', 'affordable', 0) === 1, 'slot machine: 40 ₽ with 50 ₽ held');
  assert.ok(enc.value(e, 'points', 'cost', 1) > enc.value(e, 'points', 'cost', 0) && enc.value(e, 'points', 'affordable', 1) === 0, 'cage: 60 ₽ with 50 ₽ held');
  // No trial: every dojo feature is zero.
  const idle = enc.encode(play());
  for (const f of L.segments.find((s) => s.name === 'global')!.features.filter((x) => x.name.startsWith('dojo'))) assert.equal(enc.value(idle, 'global', f.name), 0, f.name);

  // ---- dialogs ----
  const opt = (x: ReturnType<typeof enc.encode>, name: string, row: number) => enc.value(x, 'options', name, row);
  const dojo = enc.encode(dialog({ kind: 'dojo', options: [{ id: 'rush:1', label: '', data: { key: 'rush', belt: 1, goal: 28, limit: 20 } }, { id: 'race:3', label: '', data: { key: 'race', belt: 3, goal: 10, limit: 45 } }] }, { options: [true, true], extras: { decline: true } }));
  assert.deepEqual([opt(dojo, 'trial:rush', 0), opt(dojo, 'trial:race', 0), opt(dojo, 'trial:race', 1), enc.value(dojo, 'choice', 'kind:dojo')], [1, 0, 1, 1]);
  near(opt(dojo, 'trial_belt', 1), 1); near(opt(dojo, 'trial_limit', 1), 0.5); assert.ok(opt(dojo, 'trial_goal', 0) > opt(dojo, 'trial_goal', 1));
  assert.throws(() => enc.encode(dialog({ kind: 'dojo', options: [{ id: 'x', label: '', data: { key: 'juggling', belt: 1 } }] }, { options: [true], extras: { decline: true } })), /dojo trial of unknown kind "juggling"/);
  const prize = enc.encode(dialog({ kind: 'dojoPrize', options: [{ id: 'damage', label: '', data: { label: '+17% damage', mods: [{ stat: 'damage', mul: 1.17 }], rarity: 2 } }] }, { options: [true], extras: { decline: true } }));
  assert.deepEqual(enc.slice(prize, 'option_entity')[0], [K.tables.entity['stat:damage'], 0]);
  near(opt(prize, 'stat_mul', 0), 0.17); near(opt(prize, 'rarity', 0), 0.5);

  const forget = enc.encode(dialog({ kind: 'forget', context: { lessonReady: true }, options: [
    { id: 'move:0', label: '', data: { what: 'move', slot: 0, key: 'burning-jealousy', level: 2, refund: 16, fusion: false, linked: false } },
    { id: 'vitamin:protein', label: '', data: { what: 'vitamin', key: 'protein', level: 3, refund: 18 } },
    { id: 'lesson', label: '', data: { what: 'lesson' } }] }, { options: [false, true, true], extras: { leave: true } }));
  assert.deepEqual(enc.slice(forget, 'option_entity').slice(0, 3), [[K.tables.entity['move:burning-jealousy'], 0], [K.tables.entity['vitamin:protein'], 0], [0, 0]]);
  assert.deepEqual([opt(forget, 'allowed', 0), opt(forget, 'has_refund', 0), opt(forget, 'has_refund', 2), opt(forget, 'lesson', 2), opt(forget, 'lesson', 1), enc.value(forget, 'choice', 'hypno_lesson_ready')], [0, 1, 0, 1, 0, 1]);
  assert.ok(opt(forget, 'refund', 1) > opt(forget, 'refund', 0)); near(opt(forget, 'current_level', 1), 3 / 12);
  const lesson = enc.encode(dialog({ kind: 'lesson', options: [{ id: 'newMove:m52', label: '', data: { kind: 'newMove', id: 52, key: 'm52', rarity: 1 } }, { id: 'newVit:vcarbos', label: '', data: { kind: 'newVit', vit: 'carbos', key: 'vcarbos', rarity: 2 } }] }, { options: [true, true], extras: { decline: true } }));
  assert.deepEqual([opt(lesson, 'offer:newMove', 0), opt(lesson, 'offer:newVit', 1)], [1, 1], 'a lesson offer is encoded as a level-up offer');
  assert.deepEqual(enc.slice(lesson, 'option_entity').slice(0, 2), [[K.tables.entity['move:ember'], 0], [K.tables.entity['vitamin:carbos'], 0]]);

  const fusion = enc.encode(dialog({ kind: 'fusion', options: [
    { id: 'fuse:0+1', label: '', data: { how: 'fuse', a: 0, b: 1, moveA: 'ember', moveB: 'burning-jealousy', recipe: 'x', recipeKind: 'reaction' } },
    { id: 'link:0+1', label: '', data: { how: 'link', a: 0, b: 1, moveA: 'ember', moveB: 'burning-jealousy', recipe: 'x', recipeKind: 'reaction' } }] }, { options: [true, true], extras: { leave: true } }));
  assert.deepEqual(enc.slice(fusion, 'option_entity').slice(0, 2), [[K.tables.entity['move:ember'], K.tables.entity['move:burning-jealousy']], [K.tables.entity['move:ember'], K.tables.entity['move:burning-jealousy']]]);
  assert.deepEqual([opt(fusion, 'link', 0), opt(fusion, 'link', 1), opt(fusion, 'recipe:reaction', 0), opt(fusion, 'recipe:signature', 0)], [0, 1, 1, 0]);

  const slots = enc.encode(dialog({ kind: 'slots', context: { cost: 60, spinsUntilInsured: 3 }, options: [{ id: 'spin', label: '', data: { price: 60 } }] }, { options: [false], extras: { leave: true } }));
  assert.deepEqual([opt(slots, 'has_price', 0), opt(slots, 'affordable', 0), opt(slots, 'allowed', 0)], [1, 0, 0], '60 ₽ with 50 ₽ held');
  near(enc.value(slots, 'choice', 'slot_spins_until_insured'), 0.5);
  const sell = enc.encode(dialog({ kind: 'shopSell', options: [{ id: 'charcoal', label: '', data: { key: 'charcoal', owned: 2, refund: 10, rarity: 0 } }] }, { options: [true], extras: { leave: true } }));
  assert.deepEqual([enc.slice(sell, 'option_entity')[0], opt(sell, 'has_refund', 0), opt(sell, 'has_rarity', 0)], [[K.tables.entity['item:charcoal'], 0], 1, 1]);
  near(opt(sell, 'owned', 0), 0.2);
});

test('what the encoding cannot represent is an error, never a silent drop', () => {
  const many = Array.from({ length: OPTION_SLOTS + 1 }, (_, i) => ({ id: String(i), label: '', data: { key: 'charcoal', owned: 1 } }));
  assert.throws(() => enc.encode(dialog({ kind: 'ditto', options: many }, { options: many.map(() => true), extras: { decline: true } })), new RegExp(`${OPTION_SLOTS + 1} options; the encoding has ${OPTION_SLOTS} option slots`));
  assert.throws(() => enc.encode(dialog({ kind: 'item', options: [{ id: 'x', label: '', data: { key: 'not-an-item', owned: 0 } }] }, { options: [true], extras: { sell: true } })), EncodingError);
  assert.throws(() => enc.encode(dialog({ kind: 'levelup', options: [{ id: 'x', label: '', data: { kind: 'newPact', key: 'p1' } }] }, { options: [true], extras: {} })), /unknown kind "newPact"/);
  assert.throws(() => enc.encode(dialog({ kind: 'levelup', options: [{ id: 'x', label: '', data: { kind: 'newMove', id: 999999, key: 'm999999' } }] }, { options: [true], extras: {} })), /move id 999999/);
  assert.throws(() => enc.encode(dialog({ kind: 'levelup', options: [{ id: 'x', label: '', data: { kind: 'upMove', slot: 2, key: 'm1' } }] }, { options: [true], extras: {} })), /slot 2, which is empty/);
  assert.throws(() => enc.encode(play({}, { build: { ...state().build, items: [{ key: 'mystery-item', count: 1 }] } })), /"item:mystery-item" is not in the vocabulary/);
  assert.throws(() => enc.encode(dialog({ kind: 'mystery' as never, options: [] }, { options: [], extras: { leave: true } })), /unknown kind "mystery"/);
  assert.throws(() => enc.encode({ ...play(), state: undefined as never }), /no "state"/);
  assert.throws(() => enc.value(enc.encode(play()), 'global', 'no_such_feature'), EncodingError);
});
