import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, newMemory } from '../src/bot/brain/movement.ts';
import { DEFAULT_TUNING as T } from '../src/bot/brain/tuning.ts';
import type { Snapshot } from '../src/bot/snapshot.ts';
import { quiet, recorded, vary } from './helpers.ts';

const base = recorded('farm-zone1').snap;
/** Open ground everywhere, a goal 40 m away towards +x (the guardian's altar, with the level to wake it). */
const errand = (patch: (s: Snapshot) => void = () => {}) => vary(quiet(base), (q) => {
  q.player.level = T.wakeLevel[0];
  q.points = [{ kind: 'boss', sub: '', x: 40, z: 0, r: 4, used: false, cost: 0, d: 40 }];
  q.terrain.free = new Array(16).fill(9); q.terrain.hop = new Array(16).fill(9);
  patch(q);
});

test('open ground: straight at the goal, no jumping', () => {
  const a = decide(errand(), newMemory(), T).action;
  assert.equal(a.intent, 'wake');
  assert.ok(a.move && a.move.x > 0.9);
  assert.ok(!a.jump);
});

test('a wall, a tree or water ahead is not walked into: the bot takes the open side', () => {
  // Nothing passes towards +x (not even jumping); the way is open from 67.5° on.
  const s = errand((q) => { for (const k of [14, 15, 0, 1, 2]) { q.terrain.free![k] = 0.5; q.terrain.hop![k] = 0.5; } });
  const a = decide(s, newMemory(), T).action;
  assert.ok(a.move, 'keeps moving');
  const k = Math.round(Math.atan2(a.move!.z, a.move!.x) / (Math.PI / 8) + 16) % 16;
  assert.ok(![14, 15, 0, 1, 2].includes(k), `heading ${k * 22.5}° avoids the blocked arc`);
  assert.ok(a.move!.x > -0.3, 'and still makes for the goal around it');
});

test('a hill that only jumping gets up: it goes up it, jumping all the way', () => {
  // A walker is stopped half a metre ahead across the whole side facing the goal; a jumper is not.
  const hill = [12, 13, 14, 15, 0, 1, 2, 3, 4];
  let mem = newMemory(), jumps = 0, ticks = 0;
  for (let i = 0; i < 8; i++) {
    // The player makes headway up the slope between ticks.
    const s = errand((q) => { for (const k of hill) { q.terrain.free![k] = 0.5; q.terrain.hop![k] = 9; } q.t = base.t + i * 0.1; q.player.x = i * 0.5; q.points[0].d = 40 - i * 0.5; });
    const r = decide(s, mem, T);
    mem = r.mem; ticks++;
    assert.ok(r.action.move && r.action.move.x > 0.85, 'heads up the slope');
    if (r.action.jump) jumps++;
  }
  assert.equal(jumps, ticks, 'jumps on every tick it is on the ground');
});

test('no jumping on flat ground just because a step is a few metres off', () => {
  const s = errand((q) => { q.terrain.free![0] = 5; q.terrain.hop![0] = 9; });
  assert.ok(!decide(s, newMemory(), T).action.jump);
});

test('a far goal is reached along the planned route, not the straight line', () => {
  // The altar is straight towards +x, but the route (around a cliff) starts towards +z.
  const s = errand((q) => { q.nav = { tx: 40, tz: 0, ok: true, len: 70, jump: false, x: 1, z: 8 }; });
  const a = decide(s, newMemory(), T).action;
  assert.ok(a.move && a.move.z > 0.85, `follows the waypoint (got ${JSON.stringify(a.move)})`);
  // A route for some other goal is ignored.
  const stale = errand((q) => { q.nav = { tx: -90, tz: 60, ok: true, len: 70, jump: false, x: 1, z: 8 }; });
  assert.ok(decide(stale, newMemory(), T).action.move!.x > 0.9);
  // A climbing stretch of the route is jumped.
  const climb = errand((q) => { q.nav = { tx: 40, tz: 0, ok: true, len: 70, jump: true, x: 8, z: 1 }; });
  assert.ok(decide(climb, newMemory(), T).action.jump);
});

test('the route does not override safety: an enemy on the waypoint is still avoided', () => {
  const s = errand((q) => {
    q.nav = { tx: 40, tz: 0, ok: true, len: 70, jump: false, x: 8, z: 0 };
    q.enemies.list = [[0, 2.2, 0, -4, 0, 70, 70, 0.6, 30, 4, 0, 19, 3]]; q.enemies.count = 1;
  });
  const a = decide(s, newMemory(), T).action;
  assert.ok(!a.move || a.move.x < 0.8, 'does not walk through it');
});

test('the map is a square: its corners are in play, its edges are not crossed', () => {
  // 170 m from the centre along the diagonal is inside a square of half-side 168.
  const corner = errand((q) => { q.player.x = 120; q.player.z = 120; q.points = [{ kind: 'boss', sub: '', x: 150, z: 120, r: 4, used: false, cost: 0, d: 30 }]; });
  const a = decide(corner, newMemory(), T).action;
  assert.ok(a.move && a.move.x > 0.8, 'walks on into the corner area');
  const edge = errand((q) => { q.player.x = 165; q.player.z = 0; q.points = [{ kind: 'boss', sub: '', x: 165, z: 60, r: 4, used: false, cost: 0, d: 60 }]; });
  const b = decide(edge, newMemory(), T).action;
  assert.ok(b.move && b.move.x <= 0.1, 'does not press into the edge');
});

test('the edge of the map: a pack is not backed away from into the boundary, and fleeing bends inwards', () => {
  // 18 m from the +x edge, a pack on the inward side: backing straight off would walk into the corner.
  const pack = (q: Snapshot) => { q.enemies.list = [0, 1, 2, 3, 4].map((k) => [k, 144.5 - (k % 2), (k - 2) * 0.9, 3.5, 0, 70, 70, 0.6, 12, 4, 0, 19, 3]); q.enemies.count = 5; };
  const s = vary(quiet(base), (q) => { q.terrain.free = new Array(16).fill(9); q.terrain.hop = new Array(16).fill(9); q.player.x = 150; pack(q); });
  const a = decide(s, newMemory(), T).action;
  assert.ok(a.move && a.move.x < 0.35, `does not retreat towards the edge (got ${JSON.stringify(a.move)})`);

  const hurt = vary(s, (q) => { q.player.x = 158; q.player.hp = q.player.maxHp * 0.2; q.enemies.list = q.enemies.list.map((e) => [e[0], e[1] + 6, e[2], ...e.slice(3)] as typeof e); });
  const f = decide(hurt, newMemory(), T).action;
  assert.equal(f.intent, 'flee');
  assert.ok(f.move && f.move.x < 0.35, `flees along or away from the edge, not into it (got ${JSON.stringify(f.move)})`);

  // In the middle of the map the same pack is simply backed away from.
  const mid = vary(s, (q) => { q.player.x = 0; q.enemies.list = q.enemies.list.map((e) => [e[0], e[1] - 150, e[2], ...e.slice(3)] as typeof e); });
  assert.ok(decide(mid, newMemory(), T).action.move!.x > 0.3);
});

test('ringed in: it jumps over the crowd, and in the air it may pass over walkers but not flyers', () => {
  const ring = (flags: number) => Array.from({ length: 16 }, (_v, k) => [k, Math.cos((k * Math.PI) / 8) * 2.4, Math.sin((k * Math.PI) / 8) * 2.4, 0, 0, 70, 70, 0.6, 12, 4, flags, 19, 3]) as Snapshot['enemies']['list'];
  const ground = vary(quiet(base), (q) => { q.enemies.list = ring(0); q.enemies.count = 16; });
  const a = decide(ground, newMemory(), T).action;
  assert.ok(a.jump, 'jumps when ringed in');
  assert.ok(a.move, 'and keeps moving');

  // Airborne over walkers costs little; airborne among flyers is as dangerous as on the ground.
  const airWalkers = decide(vary(ground, (q) => { q.player.grounded = false; }), newMemory(), T);
  const airFlyers = decide(vary(ground, (q) => { q.player.grounded = false; q.enemies.list = ring(16); }), newMemory(), T);
  const best = (r: typeof airWalkers) => Math.min(...(r.scores ?? []).slice(1));
  assert.ok(best(airWalkers) < best(airFlyers) * 0.6, 'crossing over walkers is cheap in the air');
  assert.ok(best(airWalkers) < best(decide(ground, newMemory(), T)) * 0.6, 'and much cheaper than walking through them');
});
