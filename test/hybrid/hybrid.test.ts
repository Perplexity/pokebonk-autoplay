import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PLAN_V3, PLAN_V4, planWith } from '../../src/agents/heuristic2/plan.ts';
import { fusionPick, moveCap } from '../../src/agents/heuristic2/chooser.ts';
import type { Snapshot } from '../../src/bot/snapshot.ts';
import type { ChoiceMask, Decision } from '../../src/environment/types.ts';
import { loadKnowledge } from '../../src/knowledge/load.ts';
import {
  MANAGER_ACTION_VERSION, M_ACTIONS, M_OPTION_SLOTS, M_PLAY_BASE, M_USE_BASE, ManagerActionError, NOT_USED_KINDS, SKILLS, USE_KINDS,
  actionNames, choiceMaskIds, choiceOfId, idOfChoice, managerActionLayout, playOfId, skillId, useId,
} from '../../src/hybrid/actions.ts';
import { RESERVED, UPGRADE_STATS, capacityFor, extendRegistry, isExtensionOf, registryKnowledge, registryTables } from '../../src/hybrid/ids.ts';
import { applyFusionRule } from '../../src/hybrid/manager.ts';
import { ManagerEncoder } from '../../src/hybrid/observe.ts';
import { classify, playMaskIds, portalPoint, quietTuning, skillOrder, usePoint, wakePoint } from '../../src/hybrid/skills.ts';
import type { SkillWorld } from '../../src/hybrid/skills.ts';
import { DEFAULT_TUNING } from '../../src/bot/brain/tuning.ts';

const BUILD = 'mwsewi0r';
const K = loadKnowledge(BUILD);
const point = (kind: string, d: number, o: Record<string, unknown> = {}) => ({ kind, sub: '', x: d, z: 0, r: 2, used: false, cost: 0, d, ...o });
const snap = (over: Record<string, unknown>): Snapshot => ({ t: 100, stage: 1, stageTime: 100, stageCleared: false, bossSpawned: false, gold: 0, points: [], player: { x: 0, z: 0, hp: 200, maxHp: 200, items: {}, moves: [] }, ...over } as unknown as Snapshot);
const world = (o: Partial<SkillWorld> = {}): SkillWorld => ({ gold: 0, ballPrice: 50, cagePrice: 30, slotPrice: 40, overtime: false, ...o });
const NONE = new Set<string>();

test('the manager\'s action table: one id per dialog answer and per skill, append-only', () => {
  const L = managerActionLayout(), names = actionNames();
  assert.equal(L.version, MANAGER_ACTION_VERSION);
  assert.equal(L.size, M_ACTIONS);
  assert.equal(names.length, M_ACTIONS);
  assert.equal(new Set(names.filter((n) => n !== 'spare')).size, names.filter((n) => n !== 'spare').length, 'no name twice');
  // Version 1 as it was first written: these ids never change their meaning. New ones go at the END of each list.
  assert.deepEqual([M_OPTION_SLOTS, M_PLAY_BASE, M_USE_BASE], [144, 192, 197]);
  assert.deepEqual(names.slice(144, 152), ['extra:refresh', 'extra:skip', 'extra:take', 'extra:sell', 'extra:decline', 'extra:leave', 'extra:confirm', 'extra:reroll']);
  assert.deepEqual([names[152], names[159], names[160], names[167], names[168], names[191]], ['extra:banish:0', 'extra:banish:7', 'extra:banishKit:0', 'extra:banishKit:7', 'spare', 'spare']);
  assert.deepEqual(names.slice(192, 197), ['skill:farm', 'skill:near_portal', 'skill:wake', 'skill:portal', 'skill:retreat']);
  assert.deepEqual(names.slice(197, 210), ['use:freechest', 'use:chest', 'use:cursedchest', 'use:berry', 'use:slots', 'use:meowth', 'use:ditto', 'use:cage', 'use:snorlax', 'use:magnet', 'use:rhydon', 'use:cursed', 'use:greed']);
  assert.deepEqual([...SKILLS].slice(0, 5), ['farm', 'near_portal', 'wake', 'portal', 'retreat']);
  // Every map point kind of the build either has a `use` skill or is deliberately left out.
  for (const kind of Object.keys(K.tables.interactable)) assert.ok(useId(kind) >= 0 || (NOT_USED_KINDS as readonly string[]).includes(kind), `map point kind "${kind}" has neither a use skill nor an entry in NOT_USED_KINDS`);
  for (const kind of USE_KINDS) assert.ok(K.tables.interactable[kind], `use:${kind} names a kind the game does not have`);
  // Round trips.
  for (let i = 0; i < 168; i++) assert.equal(idOfChoice(choiceOfId(i)), i);
  for (let i = M_PLAY_BASE; i < M_ACTIONS; i++) { const p = playOfId(i); assert.equal(p.skill === 'use' ? useId(p.kind) : skillId(p.skill), i); }
  assert.throws(() => choiceOfId(170), ManagerActionError, 'a spare id is not a choice');
  assert.throws(() => playOfId(10), ManagerActionError);
  assert.throws(() => idOfChoice({ type: 'choice', option: 144 }), /144 option slots/);
  // A dialog's mask: options, untargeted and targeted extras; a dialog that does not fit is an error, never cut.
  const mask: ChoiceMask = { phase: 'choice', options: [true, false, true], extras: { leave: true, skip: false, banish: [false, true, false] } } as ChoiceMask;
  const ids = [...choiceMaskIds(mask)].map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(ids.map((i) => names[i]), ['option:0', 'option:2', 'extra:leave', 'extra:banish:1']);
  assert.throws(() => choiceMaskIds({ phase: 'choice', options: Array(145).fill(true), extras: {} } as ChoiceMask), /145 options/);
});

test('skills: what is possible now, the order each one is, and the skill the heuristic\'s order amounts to', () => {
  const allowed = (s: Snapshot, w: SkillWorld, skipped = NONE): string[] => { const m = playMaskIds(s, w, skipped), n = actionNames(); return [...m].map((v, i) => (v ? n[i] : '')).filter(Boolean); };
  const altar = point('boss', 60), portal = point('portal', 40), chest = point('chest', 20), free = point('freechest', 30), totem = point('rhydon', 90), shop = point('meowth', 50);
  // A zone with its guardian asleep.
  const zone = snap({ points: [altar, chest, free, totem, shop] });
  assert.deepEqual(allowed(zone, world()), ['skill:farm', 'skill:wake', 'skill:retreat', 'use:freechest', 'use:meowth', 'use:rhydon']);
  assert.ok(allowed(zone, world({ gold: 50 })).includes('use:chest'), 'a paid ball needs its price');
  assert.ok(!allowed(snap({ points: [altar, { ...free, used: true }] }), world()).includes('use:freechest'), 'a used point is no target');
  assert.ok(!allowed(zone, world(), new Set(['freechest:30:0'])).includes('use:freechest'), 'nor is one that was given up');
  // The guardian is up: no waking, and Rhydon no longer answers.
  const fight = snap({ points: [altar, totem, free], bossSpawned: true });
  assert.deepEqual(allowed(fight, world()), ['skill:farm', 'skill:retreat', 'use:freechest']);
  // Cleared: the portal can be taken or stayed by; in Overtime it cashes.
  const cleared = snap({ points: [portal, free], bossSpawned: true, stageCleared: true });
  assert.deepEqual(allowed(cleared, world()), ['skill:farm', 'skill:near_portal', 'skill:portal', 'skill:retreat', 'use:freechest']);
  assert.equal(wakePoint(cleared), undefined);
  assert.equal(portalPoint(cleared)?.x, 40);
  assert.equal(wakePoint(snap({ stage: 4, points: [point('shrine', 25)] }))?.kind, 'shrine', 'the sanctuary: the legendary sleeps at the shrine');
  assert.equal(usePoint(zone, 'chest', world({ gold: 49 })), undefined);

  // Orders.
  const P = PLAN_V3;
  assert.deepEqual(skillOrder({ skill: 'farm' }, cleared, world(), P, NONE), { directive: { holdPortal: true }, retreat: false });
  assert.deepEqual(skillOrder({ skill: 'retreat' }, zone, world(), P, NONE), { directive: { holdPortal: true }, retreat: true });
  const wake = skillOrder({ skill: 'wake' }, zone, world(), P, NONE)!.directive.goto!;
  assert.deepEqual([wake.kind, wake.x, wake.force, wake.interact], ['wake', 60, true, true]);
  assert.equal(skillOrder({ skill: 'wake' }, fight, world(), P, NONE), null);
  const back = skillOrder({ skill: 'near_portal' }, cleared, world(), P, NONE)!.directive;
  assert.deepEqual([back.holdPortal, back.goto?.kind, back.goto?.force], [true, 'stay', true], 'beyond the leash: back to the portal, through the horde');
  const near = skillOrder({ skill: 'near_portal' }, snap({ points: [point('portal', 6)], stageCleared: true, bossSpawned: true }), world(), P, NONE)!.directive;
  assert.deepEqual(near, { holdPortal: true, leash: { x: 6, z: 0, r: P.stayLeash } });
  assert.deepEqual(skillOrder({ skill: 'portal' }, cleared, world(), P, NONE)!.directive, {}, 'a cleared zone: the brain\'s own rule takes the portal');
  assert.equal(skillOrder({ skill: 'portal' }, cleared, world({ overtime: true }), P, NONE)!.directive.goto?.kind, 'cash');
  assert.equal(skillOrder({ skill: 'portal' }, zone, world(), P, NONE), null);
  const use = skillOrder({ skill: 'use', kind: 'freechest' }, zone, world(), P, NONE)!.directive;
  assert.deepEqual([use.holdPortal, use.goto?.kind, use.goto?.x, use.goto?.force, use.goto?.interact], [true, 'errand', 30, true, true]);
  assert.equal(skillOrder({ skill: 'use', kind: 'altar' }, snap({ points: [point('altar', 15)] }), world(), P, NONE)!.directive.goto?.interact, false, 'an Unown altar is stood in, not pressed');
  // Under the manager the brain wakes nothing by itself; `retreat` makes any HP low.
  const quiet = quietTuning(DEFAULT_TUNING), fleeing = quietTuning(DEFAULT_TUNING, true);
  assert.ok(quiet.wakeLevel.every((v) => v > 9000) && quiet.wakeAfterSec === Infinity && quiet.sanctuaryHp > 1 && quiet.sanctuaryRestSec === Infinity);
  assert.deepEqual([quiet.lowHp, fleeing.lowHp > 1], [DEFAULT_TUNING.lowHp, true]);

  // The heuristic's order as a skill.
  const goto = (kind: string, x: number) => ({ kind, x, z: 0, reach: 1, interact: true, force: true, note: '' });
  assert.equal(classify({}, 'farm', zone), skillId('farm'));
  assert.equal(classify({ holdPortal: true }, 'hunt', cleared), skillId('farm'));
  assert.equal(classify({ goto: goto('wake', 60) }, 'wake', zone), skillId('wake'));
  assert.equal(classify({}, 'wake', zone), skillId('wake'), 'the brain\'s own rule woke it');
  assert.equal(classify({}, 'portal', cleared), skillId('portal'), 'the brain\'s own rule took the portal');
  assert.equal(classify({ holdPortal: true, goto: goto('cash', 40) }, 'cash', cleared), skillId('portal'));
  assert.equal(classify({ holdPortal: true, goto: goto('stay', 40) }, 'stay', cleared), skillId('near_portal'));
  assert.equal(classify({ holdPortal: true, leash: { x: 40, z: 0, r: 10 } }, 'farm', cleared), skillId('near_portal'));
  assert.equal(classify({ goto: goto('errand', 30) }, 'errand', zone), useId('freechest'));
  assert.equal(classify({ goto: goto('errand', 90) }, 'boss', zone), useId('rhydon'), 'the order is what counts, not what the brain made of it this tick');
});

test('Bill\'s machine: fused only with the TM Case held and both moves at level 10 (plan-4; plan-3 leaves it alone)', () => {
  const d = { kind: 'fusion', options: [
    { id: 'link:0+1', label: '', data: { how: 'link', a: 0, b: 1, moveA: 'psystrike', moveB: 'psycho-cut' } },
    { id: 'fuse:0+1', label: '', data: { how: 'fuse', a: 0, b: 1, moveA: 'psystrike', moveB: 'psycho-cut' } },
    { id: 'fuse:0+2', label: '', data: { how: 'fuse', a: 0, b: 2, moveA: 'psystrike', moveB: 'ancient-power' } },
  ] } as unknown as Decision;
  const s = (items: Record<string, number>, levels: number[]): Snapshot => snap({ player: { x: 0, z: 0, hp: 200, maxHp: 200, items, moves: [{ key: 'psystrike', level: levels[0] }, { key: 'psycho-cut', level: levels[1] }, { key: 'ancient-power', level: levels[2] }] } });
  assert.equal(PLAN_V3.fuseNeeds, '');
  assert.deepEqual([PLAN_V4.fuseNeeds, PLAN_V4.errands.includes('bill'), PLAN_V3.errands.includes('bill')], ['tm-case', true, false]);
  assert.equal(planWith(undefined).version, 'plan-3', 'plan-4 is a candidate, not the default');
  assert.equal(fusionPick(d, s({ 'tm-case': 1 }, [10, 10, 10]), PLAN_V3), -1);
  assert.equal(fusionPick(d, s({}, [8, 8, 8]), PLAN_V4), -1, 'the game would fuse at level 8: the plan waits for the TM Case');
  assert.equal(fusionPick(d, s({ 'tm-case': 1 }, [10, 9, 8]), PLAN_V4), -1, '…and for both moves to reach the new cap');
  assert.equal(fusionPick(d, s({ 'tm-case': 1 }, [10, 10, 8]), PLAN_V4), 1, 'the fusion, not the link');
  assert.equal(fusionPick(d, s({ 'tm-case': 1 }, [10, 8, 10]), PLAN_V4), 2);
  assert.deepEqual([moveCap(s({}, [8, 8, 8]), PLAN_V4), moveCap(s({ 'tm-case': 1 }, [8, 8, 8]), PLAN_V4), moveCap(s({ 'tm-case': 1 }, [8, 8, 8]), PLAN_V3)], [8, 10, 8]);
});

test('the manager\'s rule at Bill\'s machine: nothing but leaving without the TM Case', () => {
  const d = { kind: 'fusion', options: [{ id: 'fuse:0+1', label: '', data: {} }, { id: 'link:0+1', label: '', data: {} }] } as unknown as Decision;
  const open = (): Uint8Array => choiceMaskIds({ phase: 'choice', options: [true, true], extras: { leave: true } } as ChoiceMask);
  const names = actionNames(), allowed = (m: Uint8Array): string[] => [...m].map((v, i) => (v ? names[i] : '')).filter(Boolean);
  const without = open(); applyFusionRule(d, [{ key: 'leftovers', count: 2 }], 'tm-case', without);
  assert.deepEqual(allowed(without), ['extra:leave']);
  const held = open(); applyFusionRule(d, [{ key: 'tm-case', count: 1 }], 'tm-case', held);
  assert.deepEqual(allowed(held), ['option:0', 'option:1', 'extra:leave']);
  const off = open(); applyFusionRule(d, [], '', off);
  assert.deepEqual(allowed(off), ['option:0', 'option:1', 'extra:leave'], 'the rule can be switched off');
  const shop = open(); applyFusionRule({ ...d, kind: 'shop' } as Decision, [], 'tm-case', shop);
  assert.deepEqual(allowed(shop), ['option:0', 'option:1', 'extra:leave'], 'only Bill\'s machine');
});

test('append-only ids: a key keeps its index, new keys go to the end, shapes come from the capacity', () => {
  const first = extendRegistry(null, 'a', { item: { apple: 1, berry: 2, cherry: 3 }, stat: { armor: 1 } });
  assert.deepEqual(first.tables.item, { capacity: capacityFor(3), keys: ['apple', 'berry', 'cherry'] });
  assert.deepEqual([capacityFor(3), capacityFor(142), capacityFor(26)], [16, 184, 40]);
  // A later build inserts a key in the middle of its own (sorted) numbering, and drops one.
  const later = extendRegistry(first, 'b', { item: { apple: 1, banana: 2, cherry: 3 }, stat: { armor: 1 }, relic: { orb: 1 } });
  assert.deepEqual(later.tables.item.keys, ['apple', 'berry', 'cherry', 'banana'], 'old indexes stand, the new key is appended, the dropped one keeps its place');
  assert.deepEqual(later.builds, ['a', 'b']);
  assert.deepEqual(first.tables.item.keys, ['apple', 'berry', 'cherry'], 'the registry given is not written to');
  assert.ok(isExtensionOf(later, first) && !isExtensionOf(first, later));
  assert.ok(!isExtensionOf({ ...later, tables: { ...later.tables, item: { capacity: 16, keys: ['berry', 'apple', 'cherry', 'banana'] } } }, first));
  const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i + 1]));
  assert.throws(() => extendRegistry(first, 'c', { item: many }), /over its capacity of 16/);

  // The real build: the registry's numbering replaces the vocabulary's, padded to the capacity.
  const reg = extendRegistry(null, BUILD, registryTables(K)), RK = registryKnowledge(K, reg);
  assert.equal(RK.keys('item').length, reg.tables.item.capacity);
  assert.equal(RK.keys('item').filter((k) => !k.startsWith(RESERVED)).length, 142);
  assert.equal(RK.tables.item['twisted-spoon'], reg.tables.item.keys.indexOf('twisted-spoon') + 1);
  assert.equal(RK.upgradeStats.length, reg.tables[UPGRADE_STATS].capacity);
  assert.throws(() => registryKnowledge({ ...K, tables: { ...K.tables, item: { ...K.tables.item, 'brand-new': 999 } } }, reg), /not in the registry/);
});

test('the manager\'s observation layout: its shape survives keys appended to the registry; anything else changes `compat`', () => {
  const reg = extendRegistry(null, BUILD, registryTables(K));
  const enc = new ManagerEncoder(BUILD, reg), L = enc.layout;
  const seg = (name: string) => L.segments.find((x) => x.name === name)!;
  assert.deepEqual(L.segments.filter((x) => x.dtype === 'float32').map((x) => x.name), ['global', 'stats', 'density', 'xp', 'moves', 'vitamins', 'items', 'relics', 'choice', 'options', 'mgr', 'proposal', 'prev_play', 'kinds', 'option_fx']);
  assert.deepEqual(L.segments.filter((x) => x.dtype === 'int32').map((x) => x.name), ['ids', 'move_slots', 'option_entity', 'option_fx_stats']);
  assert.deepEqual([seg('proposal').shape, seg('prev_play').shape, seg('kinds').shape, seg('options').shape[0], seg('option_fx').shape[0], seg('option_fx_stats').shape],
    [[1, M_ACTIONS], [1, M_ACTIONS - M_PLAY_BASE], [1, USE_KINDS.length * 6], 144, 144, [144, 3]]);
  assert.equal(seg('items').shape[1], reg.tables.item.capacity, 'one entry per id the registry can ever give');
  // Offsets are contiguous per dtype and add up to the sizes.
  for (const dtype of ['float32', 'int32'] as const) {
    let at = 0;
    for (const x of L.segments.filter((y) => y.dtype === dtype)) { assert.equal(x.offset, at, `${x.name} follows the segment before it`); at += x.shape[0] * x.shape[1]; }
    assert.equal(at, dtype === 'float32' ? L.floatSize : L.intSize);
  }
  for (const name of ['kills_big', 'overtime_bonus_big', 'level_big', 'overheal_frac', 'lifesteal_budget_frac', 'tide_frac_big', 'spawn_multiplier', 'horde_hit', 'tm_case', 'moves_at_cap', 'rhydon_roars'])
    assert.ok(seg('mgr').features.some((x) => x.name === name), `mgr has ${name}`);
  assert.equal(new ManagerEncoder(BUILD, reg).layout.hash, L.hash, 'same code + same registry = same layout');
  // A later build adds an item: the full hash changes (a name changed), the shape a network depends on does not.
  const grown = extendRegistry(reg, 'next', { item: { ...K.tables.item, 'brand-new-item': 143 } });
  const G = new ManagerEncoder(BUILD, grown).layout;
  assert.notEqual(G.hash, L.hash);
  assert.equal(G.compat, L.compat);
  assert.deepEqual([G.floatSize, G.intSize], [L.floatSize, L.intSize]);
  // Another capacity is another shape.
  const wider = { ...reg, tables: { ...reg.tables, item: { ...reg.tables.item, capacity: reg.tables.item.capacity + 8 } } };
  assert.notEqual(new ManagerEncoder(BUILD, wider).layout.compat, L.compat);
});
