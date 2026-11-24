import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { OT, balance, ceilingRoundKos, drainFraction, healFactor, hordeHpGrowth, killWeight, overtimeScore, referenceHp, roundMultiplier, spawnMultiplier, spawnRate, survivalSeconds } from '../../src/model/overtime.ts';

const ASSETS = resolve(import.meta.dirname, '../../mirror/assets');

test('the Overtime constants are those of the mirrored bundle', () => {
  const file = readdirSync(ASSETS).find((f) => f.startsWith('assets-') && f.endsWith('.js'));
  assert.ok(file, 'the assets chunk of the mirrored game');
  const src = readFileSync(join(ASSETS, file), 'utf8');
  const m = /=\{roundSecs:30,maxRounds:[^}]*dust:\{[^}]*\}[^}]*\}/.exec(src);
  assert.ok(m, 'the Overtime table was not found in the bundle');
  const table = m[0];
  const value = (key: string): string => { const v = new RegExp(`[{,]${key}:(\\[[^\\]]*\\]|[^,}]+)`).exec(table); assert.ok(v, `${key} is not in the game's table`); return v[1]; };
  for (const [key, mine] of Object.entries(OT)) {
    const theirs = value(key);
    if (Array.isArray(mine)) assert.deepEqual(JSON.parse(theirs.replace(/(^|[\[,])\./g, '$10.')), mine, key);
    else assert.equal(Number(theirs), mine, key);
  }
});

test('multipliers, spawns and the tide follow the game\'s formulas', () => {
  assert.deepEqual([0, 1, 5, 6, 23].map((r) => roundMultiplier(r)), [1.25, 1.5, 4, 5, 22]);
  assert.equal(roundMultiplier(0, 12), 2.45);                       // measured: round 1 with 12 seals kept read x2.45
  assert.equal(roundMultiplier(1, 12, 1), 3.2);                     // measured: Pleamar taken on entering round 2
  assert.equal(roundMultiplier(0, 99, 1), 2.45, 'at most 12 seals count, and Pleamar only from the round it was taken in');
  assert.deepEqual([0, 150, 600].map(spawnRate), [30, 150, 150]);
  assert.deepEqual([0, 45, 270, 600].map(killWeight), [1, 2, 7, 7]);
  assert.deepEqual([spawnMultiplier(1, 1, 1.6), spawnMultiplier(1.5, 1.5, 1.6), spawnMultiplier(0.5, 1, 1)], [1.6, 3, 1]);
  // Measured with every body killed as it arrived, at a multiplier of 3: 5,269, 11,995, 21,747 in rounds 1-3 and 94,5xx from round 10 on.
  for (const [round, measured] of [[0, 5269], [1, 11995], [2, 21747], [9, 94552], [15, 94652]] as const) assert.ok(Math.abs(ceilingRoundKos(round, 3) / measured - 1) < 0.03, `round ${round + 1}`);
  assert.equal(drainFraction(119), 0);
  for (const [s, share] of [[120, 0.0025], [300, 0.02], [480, 0.16], [540, 0.64], [600, 2.56]] as const) assert.ok(Math.abs(drainFraction(s) / share - 1) < 1e-9, `drain at ${s} s`);
  assert.ok(Math.abs(drainFraction(300, { dique: true }) - 0.014) < 1e-12 && Math.abs(drainFraction(300, { pleamarRound: 1 }) - 0.025) < 1e-12);
  assert.deepEqual([100, 120, 225, 330, 700].map((s) => healFactor(s)), [1, 1, 0.5, 0.5, 0.5], 'the floor is reached at 225 s');
  assert.deepEqual([225, 700].map((s) => healFactor(s, { manantial: true })), [1, 1]);
  assert.equal(hordeHpGrowth(60), 4);
  assert.ok(Math.abs(hordeHpGrowth(540) / (4 ** 9 * 12) - 1) < 1e-9);
  assert.equal(referenceHp(141.26).toFixed(1), '541.3');          // measured: refHp 541.26 for an Overtime begun at 141.26 s of run time
});

test('the ceiling of this build: every body killed at once for 24 rounds, x3 spawns, 12 seals, Pleamar from round 2', () => {
  const kos = Array.from({ length: 24 }, (_, r) => ceilingRoundKos(r, 3));
  const full = overtimeScore(kos, 12, 1);
  assert.ok(full.score > 26.0e6 && full.score < 26.9e6, `${full.score}`);
  // 20 million needs the end of round 21 at that ceiling: 10.5 minutes of killing everything.
  const at = (rounds: number) => overtimeScore(kos.slice(0, rounds), 12, 1).score;
  assert.ok(at(20) < 20e6 && at(22) > 20e6);
  // The measured probe run: 23 rounds' KOs give the bonus the game itself reported (21,715,026).
  const measured = [5269, 11995, 21732, 34321, 49820, 62971, 72027, 81026, 90084, 94552, 94605, 94560, 94782, 94636, 94572, 94652, 94580, 94668, 94588, 94684, 94596, 94700, 59941];
  assert.equal(overtimeScore(measured, 12, 1).bonus, 21715026);
});

test('survival: the model puts the probe\'s death within a round of where the game put it', () => {
  // Probe of 2026-11-24 (kill=all, heal=none, x3 spawns): Overtime begun at 158 s of run time, max HP about 360, healing 1, no lifesteal,
  // 94,500 KOs a round from round 10, about 0.44 Training levels a second. It fainted 567 s into Overtime.
  const kosPerSec = (s: number) => ceilingRoundKos(Math.floor(s / 30), 3) / 30;
  const build = { maxHp: 360, healing: 1, regen: 1.5, runTimeAtStart: 158 };
  const all = survivalSeconds(build, { kosPerSec, trainingLevelsPerSec: () => 0.44 });
  assert.ok(all >= 540 && all <= 600, `with every berry picked up: ${all} s`);
  const none = survivalSeconds(build, { kosPerSec, berriesCollected: 0, trainingLevelsPerSec: () => 0.44 });
  assert.ok(none < all && none > 360 && none < 480, `without berries: ${none} s`);
  // What heals at 540 s: berries carry it, the rest is small. More max HP and more healing push the end out; lifesteal is capped.
  const b = balance(build, { kosPerSec }, 540);
  assert.ok(b.parts.berries > 10 * (b.parts.regen + b.parts.training) && b.drain > 300);
  assert.ok(survivalSeconds({ ...build, maxHp: 720 }, { kosPerSec }) > survivalSeconds(build, { kosPerSec }));
  assert.equal(balance({ ...build, leechDemand: 1e9 }, { kosPerSec }, 0).parts.leech, 0.05 * 360);
});
