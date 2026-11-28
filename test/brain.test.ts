import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EF, E_X, E_Z } from '../src/bot/snapshot.ts';
import type { Snapshot } from '../src/bot/snapshot.ts';
import { assess, decide, kitRange, liveBoss, newMemory, pickFocus } from '../src/bot/brain/movement.ts';
import { adaptTuning, DEFAULT_TUNING, resolveTuning } from '../src/bot/brain/tuning.ts';
import { enemy, quiet, recorded, vary } from './helpers.ts';

const T = DEFAULT_TUNING;
const base = recorded('farm-zone1').snap;
const dot = (a: { x: number; z: number }, b: { x: number; z: number }) => a.x * b.x + a.z * b.z;

test('recorded snapshots have the documented shape', () => {
  for (const name of ['farm-zone1', 'farm-zone1-b']) {
    const { snap, ui } = recorded(name);
    assert.equal(snap.v, 1);
    assert.equal(typeof snap.t, 'number');
    assert.ok(snap.player.maxHp > 0 && snap.player.moves.length >= 1);
    assert.equal(snap.terrain.ring.length, 16);
    assert.ok(snap.enemies.list.every((e) => e.length >= 12));
    assert.ok(snap.enemies.count >= snap.enemies.list.length);
    assert.equal(ui.screen, 'run');
  }
});

test('the policy is a pure function: same snapshot and memory, same decision', () => {
  for (const name of ['farm-zone1', 'farm-zone1-b']) {
    const { snap } = recorded(name);
    const a = decide(snap, newMemory(), T), b = decide(snap, newMemory(), T);
    assert.deepEqual(a.action, b.action);
    assert.deepEqual(a.mem, b.mem);
  }
});

test('on recorded play the bot moves, and not into the closest enemy', () => {
  for (const name of ['farm-zone1', 'farm-zone1-b']) {
    const { snap } = recorded(name);
    if (snap.state !== 'play') continue;
    const { action, sit } = decide(snap, newMemory(), T);
    assert.ok(action.intent.length > 0);
    const e = snap.enemies.list[0];
    if (e && action.move && sit.nearest < 2.5) {
      const to = { x: e[E_X] - snap.player.x, z: e[E_Z] - snap.player.z }, l = Math.hypot(to.x, to.z) || 1;
      assert.ok(dot(action.move, { x: to.x / l, z: to.z / l }) < 0.5, 'walks away from an enemy in its face');
    }
  }
});

test('nothing happens outside play: paused, dialog open, dead', () => {
  for (const state of ['paused', 'modal', 'over', 'transition']) {
    const { action } = decide(vary(base, (s) => { s.state = state; }), newMemory(), T);
    assert.equal(action.move, null);
    assert.ok(!action.ult && !action.dash && !action.jump && !action.interact);
  }
  const dead = decide(vary(base, (s) => { s.state = 'play'; s.player.dead = true; }), newMemory(), T);
  assert.equal(dead.action.move, null);
});

test('survival first: a pack on one side is left behind', () => {
  const s = vary(quiet(base), (q) => {
    q.enemies.list = [enemy(0, 2, 0), enemy(1, 2.4, 0.8), enemy(2, 2.2, -0.9), enemy(3, 3.2, 0.2)];
    q.enemies.count = 4;
  });
  const { action } = decide(s, newMemory(), T);
  assert.ok(action.move, 'moves');
  assert.ok(action.move!.x < -0.3, `heads away from the pack (got ${JSON.stringify(action.move)})`);
});

test('escaping a surround beats kills: it takes the gap, and dashes when the ring is tight', () => {
  const ring: ReturnType<typeof enemy>[] = [];
  // Enemies all around at 2.2 m, except a gap towards +z.
  for (let k = 0; k < 16; k++) { if (k >= 3 && k <= 5) continue; const a = (k * Math.PI) / 8; ring.push(enemy(k, Math.cos(a) * 2.2, Math.sin(a) * 2.2)); }
  const s = vary(quiet(base), (q) => { q.enemies.list = ring; q.enemies.count = ring.length; });
  const { action, sit } = decide(s, newMemory(), T);
  assert.ok(sit.surrounded);
  assert.ok(action.move && action.move.z > 0.7, `goes through the gap (got ${JSON.stringify(action.move)})`);
  assert.ok(action.dash, 'dashes out');
});

test('low HP: goals are dropped, the bot flees or heals', () => {
  const s = vary(quiet(base), (q) => {
    q.player.hp = q.player.maxHp * 0.2;
    q.player.level = 30; // would otherwise go and wake the guardian
    q.points = [{ kind: 'boss', sub: '', x: 60, z: 0, r: 4, used: false, cost: 0, d: 60 }];
    q.enemies.list = [enemy(0, 5, 0), enemy(1, 6, 1)]; q.enemies.count = 2;
  });
  const { action } = decide(s, newMemory(), T);
  assert.equal(action.intent, 'flee');
  assert.ok(action.move && action.move.x < 0, 'away from the enemies, not towards the altar');
});

test('telegraphed ground hazards are left, with a dash when one is underfoot', () => {
  const s = vary(quiet(base), (q) => {
    q.bossSpawned = true; // a live guardian always has it; `boss` alone can be a leftover of an earlier fight (liveBoss)
    q.boss = { i: 7, name: 'Guardian', species: 3, x: 12, z: 0, hp: 5000, maxHp: 9000, radius: 1.5, enraged: false, chargeT: 0, cdx: 0, cdz: 0, move: '', moveT: 0, fightT: 20, phase: '' };
    q.enemies.list = [enemy(7, 12, 0, { hp: 5000, maxHp: 9000, r: 1.5, flags: EF.Boss })]; q.enemies.count = 1;
    q.hazards = [{ x: 0.5, z: 0, r: 2.6, t: 3, kind: 'boss.pools' }];
  });
  const { action } = decide(s, newMemory(), T);
  assert.equal(action.intent, 'boss');
  assert.ok(action.move, 'moves out of the pool');
  const after = { x: action.move!.x * 5.5 * 0.7, z: action.move!.z * 5.5 * 0.7 };
  assert.ok(Math.hypot(after.x - 0.5, after.z) > 2.6, 'ends up outside the pool');
  assert.ok(action.dash);
});

test('a boss charge lane is left sideways', () => {
  const s = vary(quiet(base), (q) => {
    q.bossSpawned = true; // a live guardian always has it; `boss` alone can be a leftover of an earlier fight (liveBoss)
    q.boss = { i: 7, name: 'Guardian', species: 3, x: 14, z: 0, hp: 5000, maxHp: 9000, radius: 1.5, enraged: false, chargeT: 0.6, cdx: -1, cdz: 0, move: 'charge', moveT: 0.2, fightT: 20, phase: '' };
    q.enemies.list = [enemy(7, 14, 0, { hp: 5000, maxHp: 9000, r: 1.5, flags: EF.Boss })]; q.enemies.count = 1;
  });
  const { action } = decide(s, newMemory(), T);
  assert.ok(action.move && Math.abs(action.move.z) > 0.6, `steps out of the lane (got ${JSON.stringify(action.move)})`);
});

test('shock rings are jumped as they arrive', () => {
  const s = vary(quiet(base), (q) => { q.waves = [{ x: 10, z: 0, r: 9.2, max: 30, speed: 20 }]; });
  assert.ok(decide(s, newMemory(), T).action.jump);
  const far = vary(quiet(base), (q) => { q.waves = [{ x: 10, z: 0, r: 2, max: 30, speed: 20 }]; });
  assert.ok(!decide(far, newMemory(), T).action.jump, 'not while the ring is still far');
});

test('ultimate: saved for the guardian, used when surrounded, held when it is quiet', () => {
  const ready = (q: typeof base) => { q.ult = { charge: 1, active: false, ready: true }; };
  const calm = vary(quiet(base), (q) => { ready(q); q.enemies.list = [enemy(0, 9, 0)]; q.enemies.count = 1; });
  assert.ok(!decide(calm, newMemory(), T).action.ult, 'no ultimate on one enemy');

  const crowd = vary(quiet(base), (q) => {
    ready(q);
    q.enemies.list = Array.from({ length: 14 }, (_v, k) => enemy(k, Math.cos(k) * 5, Math.sin(k) * 5)); q.enemies.count = 14;
  });
  assert.ok(decide(crowd, newMemory(), T).action.ult, 'surrounded');

  const boss = vary(quiet(base), (q) => {
    ready(q);
    q.bossSpawned = true; // a live guardian always has it; `boss` alone can be a leftover of an earlier fight (liveBoss)
    q.boss = { i: 7, name: 'Guardian', species: 3, x: 9, z: 0, hp: 8000, maxHp: 9000, radius: 1.5, enraged: false, chargeT: 0, cdx: 0, cdz: 0, move: '', moveT: 0, fightT: 6, phase: '' };
    q.enemies.list = [enemy(7, 9, 0, { hp: 8000, maxHp: 9000, r: 1.5, flags: EF.Boss })]; q.enemies.count = 1;
  });
  assert.ok(decide(boss, newMemory(), T).action.ult, 'boss phase');

  // Pressure alone spends it, but not when the guardian is about to be woken.
  const pressed = (level: number) => vary(quiet(base), (q) => {
    ready(q); q.player.level = level;
    q.points = [{ kind: 'boss', sub: '', x: 80, z: 0, r: 4, used: false, cost: 0, d: 80 }];
    q.enemies.list = Array.from({ length: 10 }, (_v, k) => enemy(k, 4 + (k % 3), (k - 5) * 0.9, { dmg: 30 })); q.enemies.count = 10;
  });
  assert.ok(decide(pressed(2), newMemory(), resolveTuning({ ultPressure: 3, ultCrowd: 99 })).action.ult, 'on cooldown under pressure');
  assert.ok(!decide(pressed(T.wakeLevel[0]), newMemory(), resolveTuning({ ultPressure: 3, ultCrowd: 99 })).action.ult, 'kept for the guardian');
});

test('zone flow: wake the guardian when strong enough, take the portal when the zone is cleared', () => {
  const altar = { kind: 'boss', sub: '', x: 40, z: 0, r: 4, used: false, cost: 0, d: 40 };
  const weak = vary(quiet(base), (q) => { q.player.level = 3; q.points = [altar]; });
  assert.notEqual(decide(weak, newMemory(), T).action.intent, 'wake');

  const strong = vary(quiet(base), (q) => { q.player.level = T.wakeLevel[0]; q.points = [altar]; });
  const w = decide(strong, newMemory(), T).action;
  assert.equal(w.intent, 'wake');
  assert.ok(w.move && w.move.x > 0.8);

  const late = vary(quiet(base), (q) => { q.player.level = 3; q.stageTime = T.wakeAfterSec + 1; q.points = [altar]; });
  assert.equal(decide(late, newMemory(), T).action.intent, 'wake', 'the clock also wakes it');

  const at = vary(quiet(base), (q) => { q.player.level = T.wakeLevel[0]; q.points = [{ ...altar, x: 1, d: 1 }]; });
  assert.ok(decide(at, newMemory(), T).action.interact, 'presses interact at the altar');

  const cleared = vary(quiet(base), (q) => { q.stageCleared = true; q.bossSpawned = true; q.points = [{ kind: 'portal', sub: '', x: 0, z: -30, r: 3, used: false, cost: 0, d: 30 }]; });
  const p = decide(cleared, newMemory(), T).action;
  assert.equal(p.intent, 'portal');
  assert.ok(p.move && p.move.z < -0.8);
});

test('targeting: ranged and nearly-dead elites are the focus when healthy', () => {
  const s = vary(quiet(base), (q) => {
    q.enemies.list = [enemy(0, 6, 0), enemy(1, 0, 9, { flags: EF.Ranged }), enemy(2, -8, 0, { flags: EF.Elite, hp: 20, maxHp: 400 })];
    q.enemies.count = 3;
  });
  const f = pickFocus(s);
  assert.ok(f && (f[0] === 1 || f[0] === 2));
  assert.equal(decide(s, newMemory(), T).action.intent, 'hunt');
  const hurt = vary(s, (q) => { q.player.hp = q.player.maxHp * 0.5; });
  assert.notEqual(decide(hurt, newMemory(), T).action.intent, 'hunt', 'only when safe');
});

test('captures: a rare target in the window is approached, but never out of a crowd', () => {
  const cap = { state: 'weak', index: 3, species: 144, mode: 'legend', shiny: false, x: 10, z: 0, weakT: 6, canThrow: true };
  const s = vary(quiet(base), (q) => { q.capture = cap; q.enemies.list = [enemy(3, 10, 0, { flags: EF.Capture })]; q.enemies.count = 1; });
  const a = decide(s, newMemory(), T).action;
  assert.equal(a.intent, 'capture');
  assert.ok(a.move && a.move.x > 0.8);
  const crowded = vary(s, (q) => { for (let k = 0; k < 12; k++) q.enemies.list.push(enemy(10 + k, 2 + (k % 4) * 0.5, (k - 6) * 0.5, { dmg: 40 })); q.enemies.count = 13; });
  assert.notEqual(decide(crowded, newMemory(), T).action.intent, 'capture');
});

test('terrain: it does not walk into a cliff or off the arena', () => {
  const s = vary(quiet(base), (q) => {
    q.player.level = T.wakeLevel[0];
    q.points = [{ kind: 'boss', sub: '', x: 40, z: 0, r: 4, used: false, cost: 0, d: 40 }];
    for (const k of [15, 0, 1]) { q.terrain.ring[k] = 6; q.terrain.ring2[k] = 8; q.terrain.blocked[k] = 1; } // a wall towards +x
  });
  const a = decide(s, newMemory(), T).action;
  assert.ok(a.move && a.move.x < 0.95, 'does not push straight into the wall');
  const edge = vary(quiet(base), (q) => { q.player.x = 166; q.enemies.list = [enemy(0, 160, 0)]; q.enemies.count = 1; });
  const b = decide(edge, newMemory(), T).action;
  assert.ok(!b.move || b.move.x <= 0.4, 'stays inside the arena');
});

test('stuck: no progress while walking leads to a jump and a detour', () => {
  const s = vary(quiet(base), (q) => { q.player.level = T.wakeLevel[0]; q.points = [{ kind: 'boss', sub: '', x: 40, z: 0, r: 4, used: false, cost: 0, d: 40 }]; });
  let mem = newMemory(), jumped = false;
  for (let i = 0; i < 20; i++) {
    const r = decide(vary(s, (q) => { q.t = base.t + i * 0.25; }), mem, T);
    mem = r.mem;
    jumped ||= r.action.jump;
  }
  assert.ok(jumped, 'jumps when it is not getting anywhere');
  assert.ok(mem.detourUntil > 0, 'starts a detour');
});

test('mutation adaptation: faster and harder enemies widen the margins', () => {
  const fast = adaptTuning(T, { enemyHp: 1, enemyDamage: 1, enemySpeed: 1.4, enemyAmount: 1 });
  assert.ok(fast.dangerRadius > T.dangerRadius && fast.kiteSlack > T.kiteSlack && fast.dashSurround < T.dashSurround);
  const hard = adaptTuning(T, { enemyHp: 1, enemyDamage: 1.5, enemySpeed: 1, enemyAmount: 1 });
  assert.ok(hard.lowHp > T.lowHp && hard.surviveHp > T.surviveHp);
  const many = adaptTuning(T, { enemyHp: 1.5, enemyDamage: 1, enemySpeed: 1, enemyAmount: 1.5 });
  assert.ok(many.ultCrowd > T.ultCrowd && many.wakeLevel[0] > T.wakeLevel[0]);
  assert.deepEqual(adaptTuning(T, { enemyHp: 1, enemyDamage: 1, enemySpeed: 1, enemyAmount: 1 }), T);
  // And through the policy: the same pack is kept further away when it is faster.
  const pack = vary(quiet(base), (q) => { q.enemies.list = [enemy(0, 6.5, 0), enemy(1, 6.8, 0.6)]; q.enemies.count = 2; });
  const quick = vary(pack, (q) => { q.diff.enemySpeed = 1.5; q.mutation = 'swift'; });
  const a = decide(pack, newMemory(), T).action, b = decide(quick, newMemory(), T).action;
  assert.ok((b.move?.x ?? 0) <= (a.move?.x ?? 0), 'backs off more under the faster mutation');
});

test('kit range follows the moves', () => {
  const shots = vary(base, (q) => { q.player.moves = [{ key: 'a', name: 'A', level: 1, type: 'fire', arch: 'shot', cls: 'special', cd: 1, area: 1 }]; });
  const melee = vary(base, (q) => { q.player.moves = [{ key: 'a', name: 'A', level: 1, type: 'normal', arch: 'strike', cls: 'physical', cd: 1, area: 1 }]; });
  assert.ok(kitRange(shots) > kitRange(melee));
});

test('assess counts what is close', () => {
  const s = vary(quiet(base), (q) => { q.enemies.list = [enemy(0, 2, 0), enemy(1, 6, 0), enemy(2, 13, 0)]; q.enemies.count = 3; });
  const sit = assess(s);
  assert.deepEqual([sit.n3, sit.n8, sit.n15], [1, 2, 3]);
  assert.ok(!sit.surrounded);
});

test('chargers: the dash lane is left sideways, not outrun', () => {
  // A charger about to launch at us from +x: walking straight away along the line is how you get caught.
  const windup = enemy(0, 9, 0, { flags: EF.Charger, speed: 5, atk: 0.3 });
  const a = decide(vary(quiet(base), (q) => { q.enemies.list = [windup]; q.enemies.count = 1; }), newMemory(), T).action;
  assert.ok(a.move && Math.abs(a.move.z) > 0.55, `sidesteps before the dash (got ${JSON.stringify(a.move)})`);

  // The dash is under way, 12 m/s straight at us: sidestep and dash out of the lane.
  const live = enemy(0, 6, 0, { flags: EF.Charger, speed: 5, vx: -12, vz: 0, atk: 0 });
  const b = decide(vary(quiet(base), (q) => { q.enemies.list = [live]; q.enemies.count = 1; }), newMemory(), T).action;
  assert.ok(b.move && Math.abs(b.move.z) > 0.55, `leaves the lane (got ${JSON.stringify(b.move)})`);
  assert.ok(b.dash, 'dashes out of a live lane');

  // One charging past us, not at us, is no reason to dash.
  const past = enemy(0, 6, 9, { flags: EF.Charger, speed: 5, vx: 12, vz: 0, atk: 0 });
  assert.ok(!decide(vary(quiet(base), (q) => { q.enemies.list = [past]; q.enemies.count = 1; }), newMemory(), T).action.dash);
});

test('recorded hit: an enemy coming head-on while walking to loot is stepped around early', () => {
  // A frame recorded 1 s before the bot got hit (data/hits, --trace-hits): it was walking to a chest, straight at a
  // flying enemy that was coming for it. The old policy only checked three instants ahead and walked into it.
  const { snap, culprit, was } = recorded('headon-loot') as unknown as { snap: typeof base; culprit: number; was: { move: { x: number; z: number } } };
  const e = snap.enemies.list.find((x) => x[0] === culprit)!;
  const to = { x: e[E_X] - snap.player.x, z: e[E_Z] - snap.player.z }, d = Math.hypot(to.x, to.z);
  assert.ok(d > 7, 'the enemy is still far');
  assert.ok(dot(was.move, { x: to.x / d, z: to.z / d }) > 0.7, 'the recorded decision walked at it');
  // The chest it was after, beyond the enemy.
  const s = vary(snap, (q) => { q.points = [{ kind: 'freechest', sub: '', x: q.player.x + (to.x / d) * 25, z: q.player.z + (to.z / d) * 25, r: 1.5, used: false, cost: 0, d: 25 }]; });
  const a = decide(s, newMemory(), T).action;
  // (With several enemies this close the goal is now the fight rather than the chest; either way it must not walk into them.)
  assert.ok(a.move && dot(a.move, { x: to.x / d, z: to.z / d }) < 0.72, `no longer walks at it (got ${JSON.stringify(a.move)})`);
});

test('balls: Great Balls first, then cursed balls (both free), a paid Poké Ball only when the Pokédollars cover it', () => {
  const pt = (kind: string, x: number) => ({ kind, sub: '', x, z: 0, r: 1.5, used: false, cost: kind === 'chest' ? 18 : 0, d: Math.abs(x) });
  const all = vary(quiet(base), (q) => { q.gold = 500; q.ballCost = 18; q.points = [pt('chest', 5), pt('cursedchest', -12), pt('freechest', 20)]; });
  const a = decide(all, newMemory(), T).action;
  assert.match(a.note, /Great Ball/);
  assert.ok(a.move && a.move.x > 0.8, 'walks past the nearer paid ball to the free Great Ball');

  const noGreat = vary(all, (q) => { q.points = q.points.filter((p) => p.kind !== 'freechest'); });
  assert.match(decide(noGreat, newMemory(), T).action.note, /cursed ball/);

  const paidOnly = (gold: number, cost: number) => vary(quiet(base), (q) => { q.gold = gold; q.ballCost = cost; q.points = [pt('chest', 6)]; });
  assert.notEqual(decide(paidOnly(17, 18), newMemory(), T).action.intent, 'loot', 'one Pokédollar short: no trip');
  const buy = decide(paidOnly(18, 18), newMemory(), T).action;
  assert.equal(buy.intent, 'loot');
  assert.match(buy.note, /18₽ of 18₽/);
  assert.notEqual(decide(paidOnly(60, 75), newMemory(), T).action.intent, 'loot', 'the price rises with every ball bought');
});

test('no ball runs while there is a fight within reach', () => {
  const s = vary(quiet(base), (q) => {
    q.points = [{ kind: 'freechest', sub: '', x: 20, z: 0, r: 1.5, used: false, cost: 0, d: 20 }];
    q.enemies.list = [enemy(0, -9, 0), enemy(1, -10, 1), enemy(2, -9.5, -1), enemy(3, -11, 0)]; q.enemies.count = 4;
  });
  assert.equal(decide(s, newMemory(), T).action.intent, 'farm');
});

test('herding: the pack is closed on, then circled at move range, and the ultimate waits for it to bunch up', () => {
  const clump = (cx: number, n: number, r = 1.5) => Array.from({ length: n }, (_v, k) => enemy(k, cx + Math.cos(k * 2.4) * r * (0.4 + (k % 3) * 0.3), Math.sin(k * 2.4) * r * (0.4 + (k % 3) * 0.3)));
  const far = vary(quiet(base), (q) => { q.enemies.list = clump(13, 10); q.enemies.count = 10; });
  const a = decide(far, newMemory(), T).action;
  assert.equal(a.intent, 'farm');
  assert.ok(a.move && a.move.x > 0.6, 'closes the distance to a pack that is out of range');

  const range = kitRange(far) + T.kiteSlack;
  const at = vary(quiet(base), (q) => { q.enemies.list = clump(range + 0.4, 10, 1.2); q.enemies.count = 10; });
  const b = decide(at, newMemory(), T).action;
  assert.ok(b.move && Math.abs(b.move.z) > 0.55, `circles at range instead of running off or diving in (got ${JSON.stringify(b.move)})`);

  // Ultimate: not on a scattered handful, yes once most of the herd is inside its reach.
  const charged = (list: ReturnType<typeof enemy>[]) => vary(quiet(base), (q) => { q.ult = { charge: 1, active: false, ready: true }; q.enemies.list = list; q.enemies.count = list.length; });
  const scattered = charged([enemy(0, 5, 0), enemy(1, -13, 2), enemy(2, 2, 14), enemy(3, -3, -13), enemy(4, 12, 9), enemy(5, -11, -8)]);
  assert.ok(!decide(scattered, newMemory(), T).action.ult);
  const bunched = decide(charged(clump(5.5, 9, 1.5)), newMemory(), T).action;
  assert.ok(bunched.ult);
  assert.match(bunched.note, /herd of/);
});

test('the guardian is not woken on level with an empty ultimate; a telegraphed strike is left before it lands', () => {
  const altar = { kind: 'boss', sub: '', x: 40, z: 0, r: 4, used: false, cost: 0, d: 40 };
  const empty = vary(quiet(base), (q) => { q.player.level = T.wakeLevel[0]; q.points = [altar]; q.ult = { charge: 0.1, active: false, ready: false }; });
  assert.notEqual(decide(empty, newMemory(), T).action.intent, 'wake');

  // A strike circle on top of us landing in 0.6 s: move out, and far enough to be out when it lands.
  const strike = vary(quiet(base), (q) => { q.hazards = [{ x: 0.3, z: 0, r: 3, t: 0.6, kind: 'telegraph' }]; });
  const a = decide(strike, newMemory(), T).action;
  assert.ok(a.move, 'moves');
  assert.ok(a.dash, 'walking alone would not clear a 3 m circle in 0.6 s: dash');
  // The same circle landing in 3 s is no emergency.
  const later = vary(quiet(base), (q) => { q.hazards = [{ x: 0.3, z: 0, r: 3, t: 3, kind: 'telegraph' }]; });
  assert.ok(!decide(later, newMemory(), T).action.dash);
});

// ---- the run's lifecycle beyond the first guardian (src/agents/heuristic drives it through the environment) ----

const GUARDIAN = { i: 7, name: 'Golduck', species: 55, x: 9, z: 0, hp: 5000, maxHp: 9000, radius: 1.5, enraged: false, chargeT: 0, cdx: 0, cdz: 0, move: '', moveT: 0, fightT: 20, phase: '' };
const PORTAL = { kind: 'portal', sub: '', x: 0, z: -30, r: 3.4, used: false, cost: 0, d: 30 };

test('a leftover boss record is not a guardian: the next zone before the wake, a cleared zone, overtime', () => {
  // The game keeps its boss object after the fight and reuses the enemy slot: in zone 2 the snapshot's `boss` can
  // describe a plain Kakuna (seen in a real run). It is not fought as a guardian, and the ultimate is not spent on it.
  const next = vary(quiet(base), (q) => {
    q.stage = 2; q.bossSpawned = false; q.stageCleared = false; q.ult = { charge: 1, active: false, ready: true };
    q.boss = { ...GUARDIAN, species: 14, hp: 60, maxHp: 60 };
    q.enemies.list = [enemy(7, 9, 0)]; q.enemies.count = 1;
  });
  assert.equal(liveBoss(next), null);
  const a = decide(next, newMemory(), T).action;
  assert.notEqual(a.intent, 'boss');
  assert.ok(!a.ult, 'no ultimate on a leftover record');

  const cleared = vary(quiet(base), (q) => { q.bossSpawned = true; q.stageCleared = true; q.boss = { ...GUARDIAN }; q.points = [PORTAL]; });
  assert.equal(liveBoss(cleared), null);
  assert.equal(decide(cleared, newMemory(), T).action.intent, 'portal');

  const live = vary(quiet(base), (q) => { q.bossSpawned = true; q.boss = { ...GUARDIAN }; q.enemies.list = [enemy(7, 9, 0, { hp: 5000, maxHp: 9000, r: 1.5, flags: EF.Boss })]; q.enemies.count = 1; });
  assert.equal(liveBoss(live)?.name, 'Golduck');
  assert.equal(decide(live, newMemory(), T).action.intent, 'boss');
});

test('lifecycle directive: the portal is left alone during overtime, the fight stays near it, and cashing out comes before fleeing', () => {
  const overtime = (hp: number, px = 0, pz = 0) => vary(quiet(base), (q) => {
    q.stage = 4; q.bossSpawned = true; q.stageCleared = true; q.player.hp = q.player.maxHp * hp; q.player.x = px; q.player.z = pz; q.terrain.bounds = 63;
    q.points = [{ ...PORTAL, d: Math.hypot(PORTAL.x - px, PORTAL.z - pz) }];
    q.enemies.list = [enemy(0, px + 6, pz), enemy(1, px + 7, pz + 1), enemy(2, px + 6, pz - 1)]; q.enemies.count = 3;
  });
  // Without a directive a cleared zone means: take the portal (which would cash overtime the moment it starts).
  assert.equal(decide(overtime(1), newMemory(), T).action.intent, 'portal');
  // Held: it fights.
  const held = decide(overtime(1), newMemory(), T, { holdPortal: true }).action;
  assert.equal(held.intent, 'farm');
  assert.ok(!held.interact);
  // On a leash: too far from the portal, it walks back towards it first.
  const far = decide(overtime(1, 0, 10), newMemory(), T, { holdPortal: true, leash: { x: PORTAL.x, z: PORTAL.z, r: 16 } }).action;
  assert.equal(far.intent, 'leash');
  assert.ok(far.move && far.move.z < -0.5, 'towards the portal');
  assert.equal(decide(overtime(1, 0, -20), newMemory(), T, { holdPortal: true, leash: { x: PORTAL.x, z: PORTAL.z, r: 16 } }).action.intent, 'farm', 'inside the leash it fights');
  // Hurt: without the order it flees; with a forced order it goes for the portal and presses interact there.
  assert.equal(decide(overtime(0.2), newMemory(), T, { holdPortal: true }).action.intent, 'flee');
  const cash = { kind: 'cash', x: PORTAL.x, z: PORTAL.z, reach: 1.7, interact: true, force: true, note: 'cash out' };
  const going = decide(overtime(0.2), newMemory(), T, { holdPortal: true, goto: cash }).action;
  assert.equal(going.intent, 'cash');
  assert.ok(going.move && going.move.z < -0.5);
  assert.ok(!going.interact, 'not yet there');
  const there = decide(overtime(0.2, 0, -29), newMemory(), T, { holdPortal: true, goto: cash }).action;
  assert.ok(there.interact, 'presses interact at the portal');
});

test('sanctuary: the legendary is woken at the shrine once rested, and its fight is a guardian fight', () => {
  const shrine = { kind: 'shrine', sub: '', x: 20, z: 0, r: 5, used: false, cost: 0, d: 20 };
  const arrive = (hp: number, stageTime: number) => vary(quiet(base), (q) => { q.stage = 4; q.stageTime = stageTime; q.player.level = 9; q.player.hp = q.player.maxHp * hp; q.terrain.bounds = 63; q.points = [shrine]; });
  const rested = decide(arrive(1, 3), newMemory(), T).action;
  assert.equal(rested.intent, 'wake', 'whatever the level: nothing spawns in the sanctuary to level on');
  assert.ok(rested.move && rested.move.x > 0.8);
  assert.notEqual(decide(arrive(0.6, 3), newMemory(), T).action.intent, 'wake', 'hurt: it rests first');
  assert.equal(decide(arrive(0.6, T.sanctuaryRestSec + 1), newMemory(), T).action.intent, 'wake', 'but not for ever');
  const at = vary(arrive(1, 3), (q) => { q.points = [{ ...shrine, x: 2, d: 2 }]; });
  assert.ok(decide(at, newMemory(), T).action.interact);
  // In zones 1–3 a shrine is not a guardian altar.
  const zone1 = vary(arrive(1, 3), (q) => { q.stage = 1; });
  assert.notEqual(decide(zone1, newMemory(), T).action.intent, 'wake');
});

test('the walk to the altar does not wait for a gap in the horde, and once begun it is finished', () => {
  // Headless play before these rules. Seed 3012, zone 3: the wake goal came up eleven times in four minutes and was
  // dropped each time within seconds because the horde pressed again; the guardian was still asleep 12 minutes later.
  // Thirty seeds on forest: eleven episodes ended in zone 2 above the wake level with the guardian never woken.
  const altar = { kind: 'boss', sub: '', x: 60, z: 0, r: 4, used: false, cost: 0, d: 60 };
  const pressed = (patch: (q: Snapshot) => void = () => {}) => vary(quiet(base), (q) => {
    q.stage = 3; q.stageTime = 200; q.player.level = 60; q.ult.charge = 1; q.points = [altar];
    q.enemies.list = Array.from({ length: 30 }, (_v, k) => enemy(k, Math.cos(k) * (5 + (k % 4)), Math.sin(k) * (5 + (k % 4)))); q.enemies.count = 90;
    patch(q);
  });
  assert.ok(assess(pressed()).pressure >= T.lootCalm * 1.6, 'the horde is pressing');
  assert.equal(decide(pressed(), newMemory(), T).action.intent, 'wake', 'strong enough and healthy: it sets out through the horde');
  assert.notEqual(decide(pressed((q) => { q.player.hp = q.player.maxHp * 0.6; }), newMemory(), T).action.intent, 'wake', 'it does not set out hurt');
  assert.notEqual(decide(pressed((q) => { q.ult = { charge: 0.1, active: false, ready: false }; }), newMemory(), T).action.intent, 'wake', 'nor with an empty ultimate');
  assert.notEqual(decide(pressed((q) => { q.player.level = 20; }), newMemory(), T).action.intent, 'wake', 'nor below the level');
  // Under way: an ultimate spent or a scratch do not call the walk off.
  const underWay = { ...newMemory(), goal: 'wake', lastStage: 3 };
  const on = decide(pressed(), underWay, T);
  assert.equal(on.action.intent, 'wake');
  assert.equal(on.mem.goal, 'wake');
  assert.equal(decide(pressed((q) => { q.ult = { charge: 0, active: true, ready: false }; }), underWay, T).action.intent, 'wake', 'the ultimate was used on the way');
  assert.equal(decide(pressed((q) => { q.player.hp = q.player.maxHp * 0.6; }), underWay, T).action.intent, 'wake', 'a scratch does not turn it around');
  assert.notEqual(decide(pressed((q) => { q.player.hp = q.player.maxHp * 0.5; }), underWay, T).action.intent, 'wake', `below ${T.wakeKeepHp} it is broken off`);
  assert.equal(decide(pressed((q) => { q.player.hp = q.player.maxHp * 0.3; }), underWay, T).action.intent, 'flee');
  // At the altar the guardian is only woken with the HP the fight needs: hurt, it waits there.
  const there = (hp: number) => pressed((q) => { q.points = [{ ...altar, x: 1, d: 1 }]; q.enemies = { count: 0, list: [] }; q.player.hp = q.player.maxHp * hp; });
  assert.ok(decide(there(1), underWay, T).action.interact, 'healthy: it wakes the guardian');
  const hurt = decide(there(0.6), underWay, T).action;
  assert.equal(hurt.intent, 'wake');
  assert.ok(!hurt.interact, 'hurt: it stays at the altar and does not press');
});

test('the walk to a far altar is made with determination: a line of enemies in the way is passed, not walked along', () => {
  // Headless play before this rule (seed 3004, zone 2, 60 to 170 enemies alive): four minutes of "wake" spent between
  // 120 m and 240 m from an altar 285 m away. With it: at the altar 85 s after setting out.
  const altar = { kind: 'boss', sub: '', x: 0, z: -60, r: 4, used: false, cost: 0, d: 60 };
  const line = vary(quiet(base), (q) => {
    q.stage = 2; q.stageTime = 200; q.player.level = 60; q.ult.charge = 1; q.points = [altar];
    q.enemies.list = Array.from({ length: 10 }, (_v, k) => enemy(k, -4.5 + k, -6)).sort((x, y) => Math.hypot(x[E_X], x[E_Z]) - Math.hypot(y[E_X], y[E_Z])); q.enemies.count = 120;
  });
  const ORDINARY = resolveTuning({ wakeThreat: 1, wakePull: 0.9 });
  const meek = decide(line, newMemory(), ORDINARY).action;
  assert.equal(meek.intent, 'wake');
  assert.ok(meek.move && meek.move.z > -0.2, `at the ordinary weights it walks along the line, no nearer to the altar (got ${JSON.stringify(meek.move)})`);
  const set = decide(line, newMemory(), T).action;
  assert.equal(set.intent, 'wake');
  assert.ok(set.move && set.move.z < -0.3, `determined: past the line, towards the altar (got ${JSON.stringify(set.move)})`);
  // It is not blind: an enemy is still not walked into (that is what a forced order does).
  assert.ok(set.move.z > -0.9, 'not straight through the line');
  // Close to the altar the ordinary caution is back.
  const near = vary(line, (q) => { q.points = [{ ...altar, z: -12, d: 12 }]; });
  assert.deepEqual(decide(near, newMemory(), T).action.move, decide(near, newMemory(), ORDINARY).action.move, 'within 14 m the weights are the ordinary ones');
});

test('a cleared zone: the portal is taken through the horde, and before fleeing', () => {
  // Headless play before this rule (seed 12, zone 2): 13 m from the portal when the guardian fell, 70 m away twenty
  // seconds later (a dozen telegraphed strikes and the horde outweighed the goal), fainted there four minutes later.
  const portal = { kind: 'portal', sub: '', x: 0, z: -13, r: 3.4, used: false, cost: 0, d: 13 };
  const cleared = (hp: number) => vary(quiet(base), (q) => {
    q.stage = 2; q.bossSpawned = true; q.stageCleared = true; q.player.hp = q.player.maxHp * hp; q.points = [portal];
    q.enemies.list = Array.from({ length: 40 }, (_v, k) => enemy(k, -9.75 + (k % 20), -3 - Math.floor(k / 20) * 1.5)).sort((x, y) => Math.hypot(x[E_X], x[E_Z]) - Math.hypot(y[E_X], y[E_Z])); q.enemies.count = 200;
    q.hazards = Array.from({ length: 12 }, (_v, k) => ({ x: -6 + k, z: -6, r: 2.5, t: 0.8, kind: 'telegraph' }));
  });
  const a = decide(cleared(0.8), newMemory(), T).action;
  assert.equal(a.intent, 'portal');
  assert.ok(a.move && a.move.z < -0.7, `straight at the portal (got ${JSON.stringify(a.move)})`);
  assert.ok(a.jump && a.dash, 'over the crowd, fast');
  const low = decide(cleared(0.2), newMemory(), T).action;
  assert.equal(low.intent, 'portal', 'hurt: the portal is the way out, not a corner of the same zone');
  assert.ok(low.move && low.move.z < -0.7);
  const at = vary(cleared(0.8), (q) => { q.points = [{ ...portal, z: -1, d: 1 }]; });
  assert.ok(decide(at, newMemory(), T).action.interact, 'presses interact at the portal');
  // Held by the lifecycle layer (overtime, the rest before it): not taken, and then low HP means fleeing as usual.
  assert.notEqual(decide(cleared(0.8), newMemory(), T, { holdPortal: true }).action.intent, 'portal');
  assert.equal(decide(cleared(0.2), newMemory(), T, { holdPortal: true }).action.intent, 'flee');
});

test('a forced order is carried out through the horde: the crowd does not push the bot away from the portal', () => {
  // Recorded behaviour before this rule (Mewtwo, seed 2001, overtime): 30 s of "cash out" during which the bot went from
  // 15 m to 46 m away from the portal and fainted. A wall of enemies stands between the player and the portal here.
  const cash = { kind: 'cash', x: 0, z: -30, reach: 1.7, interact: true, force: true, note: 'cash out' };
  const walled = vary(quiet(base), (q) => {
    q.stage = 4; q.bossSpawned = true; q.stageCleared = true; q.terrain.bounds = 63; q.player.hp = q.player.maxHp * 0.6;
    q.points = [{ ...PORTAL, d: 30 }];
    q.enemies.list = Array.from({ length: 40 }, (_v, k) => enemy(k, -9.75 + (k % 20), -3 - Math.floor(k / 20) * 1.5)).sort((a, b) => Math.hypot(a[E_X], a[E_Z]) - Math.hypot(b[E_X], b[E_Z])); q.enemies.count = 350;
  });
  const free = decide(walled, newMemory(), T, { holdPortal: true }).action;
  assert.ok(!free.move || free.move.z > -0.3, 'left to itself it does not walk into the wall');
  const forced = decide(walled, newMemory(), T, { holdPortal: true, goto: cash }).action;
  assert.equal(forced.intent, 'cash');
  assert.ok(forced.move && forced.move.z < -0.7, `straight at the portal (got ${JSON.stringify(forced.move)})`);
  assert.ok(forced.jump, 'over the crowd');
  assert.ok(forced.dash, 'and fast');
  // Shots and strikes on the way do not turn it either (thirty shots in the air pushed it sideways in the recorded run)…
  const fire = vary(walled, (q) => { q.shots = Array.from({ length: 30 }, (_v, k) => [-6 + (k % 12), -6, 0, 9, 0.4, 14] as [number, number, number, number, number, number]); q.hazards = [{ x: 0, z: -4, r: 3, t: 0.4, kind: 'telegraph' }]; });
  const through = decide(fire, newMemory(), T, { holdPortal: true, goto: cash }).action;
  assert.ok(through.move && through.move.z < -0.7, `still at the portal (got ${JSON.stringify(through.move)})`);
  // …but a wall does: it is not walked into.
  const wall = vary(walled, (q) => { q.terrain.free = new Array(16).fill(9); q.terrain.hop = new Array(16).fill(9); for (const k of [11, 12, 13]) { q.terrain.free![k] = 0; q.terrain.hop![k] = 0; } });
  const round = decide(wall, newMemory(), T, { holdPortal: true, goto: cash }).action;
  assert.ok(round.move && round.move.z < 0 && Math.abs(round.move.x) > 0.5, `around the wall (got ${JSON.stringify(round.move)})`);
});

test('boxed in behind something solid, a forced goal is walked round, not waited for', () => {
  // Headless play (tier 2, seed 9, plan-5): the legendary's wall of roots stood between the run and the portal 10 m
  // away. Every heading with a step towards the portal was blocked, and the run stood there to the time cap.
  const behind = vary(quiet(base), (q) => {
    q.stage = 4; q.bossSpawned = true; q.stageCleared = true; q.terrain.bounds = 63;
    q.points = [{ kind: 'portal', sub: '', x: q.player.x, z: q.player.z - 10, r: 3.4, used: false, cost: 0, d: 10 }];
    // Headings are angles of 22.5° from +x towards +z: 1 to 7 lead away from the wall, the rest into it or along it.
    q.terrain.free = new Array(16).fill(0); q.terrain.hop = new Array(16).fill(0);
    for (let k = 1; k <= 7; k++) { q.terrain.free![k] = 9; q.terrain.hop![k] = 9; }
  });
  let mem = newMemory(), t0 = behind.t, first: ReturnType<typeof decide>['action'] | null = null, moved: ReturnType<typeof decide>['action'] | null = null, at = 0;
  for (let i = 0; i < 80 && !moved; i++) {
    const out = decide(vary(behind, (q) => { q.t = t0 + i * 0.05; }), mem, T);
    mem = out.mem; first ??= out.action;
    if (out.action.move) { moved = out.action; at = i * 0.05; }
  }
  assert.equal(first!.intent, 'portal');
  assert.equal(first!.move, null, 'for a moment it waits: a strike about to land is a reason to stand');
  assert.ok(moved && at >= 2 && at <= 2.2, `after two seconds it walks (walked after ${at} s)`);
  assert.ok(moved!.move!.z >= 0 && Math.abs(moved!.move!.x) > 0.5, `sideways, clear of the wall (got ${JSON.stringify(moved!.move)})`);
  assert.equal(moved!.intent, 'portal', 'the goal is still the portal');
  // Once the way is clear it is the straight line again.
  const clear = vary(behind, (q) => { q.t = t0 + 6; q.terrain.free = new Array(16).fill(9); q.terrain.hop = new Array(16).fill(9); });
  const on = decide(clear, mem, T).action;
  assert.ok(on.move && on.move.z < -0.7, `straight at the portal (got ${JSON.stringify(on.move)})`);
  // The same when it does walk, into something that reads as free and is not (held-out seed 900038): two seconds
  // of walking without moving, then well to one side of the goal.
  const pressed = vary(behind, (q) => { q.terrain.free = new Array(16).fill(9); q.terrain.hop = new Array(16).fill(9); });
  let mem2 = newMemory(), turned: ReturnType<typeof decide>['action'] | null = null, at2 = 0, straight = 0;
  for (let i = 0; i < 100 && !turned; i++) {
    const out = decide(vary(pressed, (q) => { q.t = t0 + i * 0.05; }), mem2, T);   // the position never changes
    mem2 = out.mem;
    if (out.action.move && out.action.move.z < -0.7 && mem2.aroundUntil <= t0 + i * 0.05) straight++;
    else if (out.action.move && mem2.aroundUntil > t0 + i * 0.05) { turned = out.action; at2 = i * 0.05; }
  }
  assert.ok(straight >= 5, `first it walks at the portal (${straight} steps), then leans to pass what is in the way`);
  assert.ok(turned && at2 >= 2 && at2 <= 3.6, `then it goes round (after ${at2} s)`);
  assert.ok(turned!.move!.z > -0.5 && Math.abs(turned!.move!.x) > 0.5, `well to one side (got ${JSON.stringify(turned!.move)})`);
  // An ordinary goal is still given up on, not walked round for ever, and nothing changes while the way is open.
  const open = vary(clear, (q) => { q.t = t0; });
  assert.ok(decide(open, newMemory(), T).action.move!.z < -0.7);
  assert.deepEqual([newMemory().boxedSince, newMemory().aroundUntil], [-1, 0]);
});
