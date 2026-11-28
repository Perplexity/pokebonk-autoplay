import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createEnvironment, validChoices } from '../../src/environment/index.ts';
import type { ChoiceMask, StepResult } from '../../src/environment/index.ts';
import { randomPolicy } from '../../src/environment/policies.ts';
import { DENSITY_SIZE, STATE_SCHEMA, extractState } from '../../src/observations/state.ts';

// SLOW GROUP: boots the real game headless and plays real episodes (about 20 s). One environment for the whole file:
// the browser shims are global to the process.

const env = createEnvironment({});
after(async () => { await env.close(); });

test('state at the start of a run agrees with the game\'s own objects', async () => {
  const obs = await env.reset({ seed: 21 });
  const st = obs.state, run = env.debug.sim!.run;
  assert.equal(st.schema, STATE_SCHEMA);
  assert.deepEqual([st.build.species, st.build.startSpecies, st.build.passive, st.build.level], [155, 155, 'heat-haze', 1]);
  assert.deepEqual([st.build.moveSlots, st.build.moveSlotsFree, st.build.vitaminSlots, st.build.vitaminSlotsFree], [4, 3, 5, 5]);
  assert.deepEqual([st.build.refreshes, st.build.skips, st.build.banishes], [run.rerolls, run.skips, run.banishes]);
  assert.equal(st.build.moves.length, 4);
  const m = st.build.moves[0]!;
  assert.deepEqual([m.slot, m.key, m.level, m.fusion, m.linked], [0, 'burning-jealousy', 1, false, null]);
  assert.equal(m.id, run.player.moves[0].def.id);
  assert.ok(m.cooldownTotal > 0 && m.cooldownLeft >= 0);
  assert.deepEqual(st.build.moves.slice(1), [null, null, null]);
  assert.deepEqual(st.build.items, [{ key: 'max-revive', count: 1 }], 'the Lab\'s Max Revive');
  assert.deepEqual(st.build.nextEvolution, { to: 156, level: run.nextEvo.level });
  assert.deepEqual([st.zone.zone, st.zone.zoneTime, st.zone.finalSwarm, st.zone.collapseDrain, st.zone.healMultiplier, st.zone.inSanctuary], [1, 0, false, 0, 1, false]);
  assert.deepEqual([st.guardian.asleep, st.guardian.alive, st.guardian.seals, st.guardian.clockLeft], [true, false, [], 0]);
  assert.equal(st.guardian.species, run.nextBossSpecies());
  assert.deepEqual([st.stageCleared, st.regionCleared, st.sealsKept], [false, false, 0]);
  assert.deepEqual([st.overtime.offered, st.overtime.live, st.overtime.round, st.overtime.bonus, st.overtime.offerings], [false, false, 0, 0, []]);
  assert.deepEqual([st.ultimate.charge, st.ultimate.ready, st.ultimate.active], [0, false, 0]);
  assert.equal(st.economy.ballPrice, run.interactables.chestCost());
  assert.ok(st.economy.ballPrice > 0);
  assert.deepEqual([st.enemies.cap, st.enemies.capMax, st.enemies.density.length], [800, 800, DENSITY_SIZE]);
  assert.deepEqual([st.counters.kills, st.counters.damageDealt, st.counters.damageTaken, st.counters.healed, st.counters.guardiansDefeated, st.counters.zonesEntered, st.counters.level, st.counters.itemsHeld], [0, 0, 0, 0, 0, 1, 1, 1]);
  // Plain frozen data, like the rest of the observation.
  assert.ok(Object.isFrozen(st) && Object.isFrozen(st.build.moves) && Object.isFrozen(st.counters) && Object.isFrozen(st.enemies.density));
  // After a few seconds the counters have moved with the game's own.
  let res: StepResult | null = null;
  for (let i = 0; i < 400; i++) { res = await env.step(res?.observation.phase === 'choice' ? validChoices(res.observation.mask as ChoiceMask)[0] : { type: 'play', move: 1 + (i % 8) }); if (res.terminated) break; }
  const c = res!.observation.state.counters;
  assert.deepEqual([c.kills, c.damageDealt, c.damageTaken, c.time], [run.stats.kills, run.stats.damage, run.stats.damageTaken, run.time]);
  assert.ok(c.damageDealt > 0);
});

test('the state extractor is read-only: any number of extra calls leaves the episode\'s digest unchanged', async () => {
  /** One record per step of everything that tells two episodes apart, plus the number of random draws. */
  const play = async (seed: number, extraCalls: number): Promise<{ digest: string; steps: number; draws: number }> => {
    const hash = createHash('sha256');
    let obs = await env.reset({ seed });
    const sim = env.debug.sim!;
    const policy = randomPolicy();
    policy.reset(seed);
    let res: StepResult | null = null;
    for (;;) {
      const s = obs.snapshot, p = s.player;
      hash.update(JSON.stringify([obs.step, obs.simStep, s.t, p.x, p.y, p.z, p.hp, p.level, s.kills, s.enemies.count, sim.entropy.mathCalls(), obs.phase, obs.mask, obs.decision, obs.state]));
      if (res?.terminated || s.t >= 40) break;
      for (let i = 0; i < extraCalls; i++) {
        // The same read as the environment's: the two figures it hands in are taken from the observation itself.
        const again = extractState(sim.run, { pointsUsed: obs.state.pointsUsed, slotPrice: obs.state.economy.slotPrice, shopSold: obs.state.counters.shopSold });
        if (i === 0) assert.deepEqual(again, obs.state, 'a second read gives the same state');
      }
      res = await env.step(policy.act(obs));
      obs = res.observation;
    }
    return { digest: hash.digest('hex'), steps: obs.step, draws: sim.entropy.mathCalls() };
  };
  const plain = await play(9, 0);
  const busy = await play(9, 5);
  assert.deepEqual(busy, plain);
  assert.ok(plain.steps > 300 && plain.draws > 1000);
  const other = await play(10, 0);
  assert.notEqual(other.digest, plain.digest);
});
