import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ACTION_NVEC, MASK_OFFSETS, decodeAction, encodeAction, encodeMask, maskAllows } from '../../src/actions/codec.ts';
import { createEnvironment, validChoices } from '../../src/environment/index.ts';
import type { ChoiceMask, Observation, PlayAction, StepResult } from '../../src/environment/index.ts';
import { OBS_ENCODING_VERSION, ObservationEncoder } from '../../src/observations/encode.ts';
import { DENSITY_SIZE, STATE_SCHEMA, extractState } from '../../src/observations/state.ts';
import { loadKnowledge } from '../../src/knowledge/load.ts';
import { tableSize } from '../../src/knowledge/vocab.ts';
import { sfc32 } from '../../src/sim/rng.ts';

// SLOW GROUP: boots the real game headless with `encode: true` and plays real episodes through the numeric encoding
// and the action codec (about 30 s). One environment for the whole file: the browser shims are global to the process.

const env = createEnvironment({ encode: true });
after(async () => { await env.close(); });

/** A uniformly random valid action VECTOR, sampled from the concatenated mask alone (what a masked policy would do). */
function sample(mask: Uint8Array, rnd: () => number): number[] {
  return ACTION_NVEC.map((size, dim) => {
    const allowed: number[] = [];
    for (let i = 0; i < size; i++) if (mask[MASK_OFFSETS[dim] + i]) allowed.push(i);
    assert.ok(allowed.length > 0, `dimension ${dim} has no allowed value`);
    return allowed[Math.floor(rnd() * allowed.length)];
  });
}

test('a real episode, every step through the encoding and the codec: bounded, finite, consistent with the observation', async () => {
  let obs: Observation = await env.reset({ seed: 7 });
  const layout = env.observationLayout!;
  const md = env.getMetadata();
  assert.equal(md.encoding.observation?.layoutHash, layout.hash);
  assert.deepEqual([md.encoding.state, md.encoding.observation?.version, md.encoding.action.nvec.length], [STATE_SCHEMA, OBS_ENCODING_VERSION, 9]);
  const knowledge = loadKnowledge(md.game.build);
  const reference = new ObservationEncoder(knowledge);
  assert.equal(reference.layout.hash, layout.hash, 'the layout is a function of the code and the vocabulary');
  const intLimits = new Int32Array(layout.intSize);
  for (const seg of layout.segments.filter((s) => s.dtype === 'int32'))
    for (let r = 0; r < seg.shape[0]; r++) seg.features.forEach((f, i) => { intLimits[seg.offset + r * seg.shape[1] + i] = tableSize(knowledge.tables[f.vocab!]); });

  const rnd = sfc32(7);
  const kinds = new Set<string>();
  let steps = 0, choices = 0, maxLive = 0, last: StepResult | null = null, previous: PlayAction | null = null, checked = 0;
  for (;;) {
    const enc = obs.encoded!;
    assert.ok(enc, 'observation.encoded is present with encode: true');
    assert.deepEqual([enc.version, enc.layoutHash, enc.float.length, enc.int.length], [OBS_ENCODING_VERSION, layout.hash, layout.floatSize, layout.intSize]);
    for (let i = 0; i < enc.float.length; i++) { const v = enc.float[i]; if (!(v >= -1 && v <= 1)) assert.fail(`float ${i} is ${v} at step ${obs.step}`); }
    for (let i = 0; i < enc.int.length; i++) { const v = enc.int[i]; if (!(v >= 0 && v < intLimits[i])) assert.fail(`int ${i} is ${v} (table size ${intLimits[i]}) at step ${obs.step}`); }
    assert.deepEqual(enc.mask, encodeMask(obs));
    // The mask in vector form allows exactly what the environment's own mask allows.
    if (obs.phase === 'choice') {
      choices++; kinds.add(obs.decision!.kind);
      const ones = enc.mask.subarray(MASK_OFFSETS[8], MASK_OFFSETS[8] + ACTION_NVEC[8]).reduce((a, b) => a + b, 0);
      assert.equal(ones, validChoices(obs.mask as ChoiceMask).length);
    }
    if (last?.terminated || last?.truncated || obs.snapshot.t >= 150) break;

    if (obs.step % 97 === 0 || obs.phase === 'choice') {
      // Spot checks of values against the observation they were computed from.
      const s = obs.snapshot, st = obs.state, p = s.player;
      const close = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-5, `${what}: ${a} vs ${b}`);
      close(reference.value(enc, 'global', 'hp_frac'), Math.min(1, p.hp / p.maxHp), 'hp_frac');
      close(reference.value(enc, 'global', `phase:${obs.phase}`), 1, 'phase');
      close(reference.value(enc, 'global', `zone:${st.zone.zone}`), 1, 'zone');
      close(reference.value(enc, 'global', 'type:fire'), 1, 'Cyndaquil is a Fire type');
      assert.equal(reference.value(enc, 'ids', 'species'), knowledge.tables.species[String(p.species)]);
      assert.equal(reference.value(enc, 'ids', 'passive'), knowledge.tables.passive['heat-haze']);
      assert.equal(reference.value(enc, 'ids', 'map'), knowledge.tables.map.forest);
      assert.equal(st.enemies.density.reduce((a, b) => a + b, 0), st.enemies.live, 'the histogram covers every live enemy');
      assert.equal(st.enemies.live, s.enemies.count);
      const rows = reference.slice(enc, 'enemies');
      assert.equal(rows.filter((r) => r[0] === 1).length, Math.min(48, s.enemies.list.length));
      if (s.enemies.list.length) {
        const e = s.enemies.list[0];
        // World-axis aligned and relative to the player: no camera rotation.
        close(rows[0][1], Math.fround(Math.max(-1, Math.min(1, (e[1] - p.x) / 45))), 'enemy dx');
        close(rows[0][2], Math.fround(Math.max(-1, Math.min(1, (e[2] - p.z) / 45))), 'enemy dz');
        assert.equal(reference.value(enc, 'enemy_species', 'species', 0), knowledge.tables.species[String(e[11])] ?? 0);
      }
      const slot0 = st.build.moves[0]!;
      assert.equal(reference.value(enc, 'move_slots', 'entity', 0), knowledge.tables.entity[`move:${slot0.key}`]);
      close(reference.value(enc, 'moves', 'level', 0), Math.min(1, slot0.level / 10), 'move level');
      if (previous) close(reference.value(enc, 'global', `prev_move:${['none', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'][previous.move as number]}`), 1, 'previous move');
      if (obs.decision) {
        close(reference.value(enc, 'choice', `kind:${obs.decision.kind}`), 1, 'decision kind');
        const opts = reference.slice(enc, 'options');
        assert.equal(opts.filter((r) => r[0] === 1).length, obs.decision.options.length);
        if (obs.decision.kind === 'levelup') {
          const ents = reference.slice(enc, 'option_entity');
          obs.decision.options.forEach((o, i) => {
            const d = o.data as Record<string, any>;
            const want = d.kind === 'newMove' ? `move:${knowledge.moveKeyById.get(d.id)}` : d.kind === 'upMove' ? `move:${st.build.moves[d.slot]!.key}` : `vitamin:${d.vit}`;
            assert.equal(ents[i][0], knowledge.tables.entity[want], `option ${i} is ${want}`);
          });
        }
      }
      checked++;
    }

    const vector = sample(enc.mask, rnd);
    const action = decodeAction(vector, obs);
    assert.deepEqual(Array.from(encodeAction(action, obs)), vector, 'encode is the inverse of decode');
    assert.ok(maskAllows(enc.mask, vector));
    if (action.type === 'play') previous = { ...action, move: vector[0] };
    last = await env.step(action);
    assert.equal(last.info.invalidAction, undefined);
    assert.equal(last.info.counters, last.observation.state.counters, 'info.counters is the observation\'s counters object');
    assert.deepEqual([last.info.counters.kills, last.info.counters.level, last.info.counters.zonesEntered], [last.info.kills, last.info.level, last.info.zone]);
    obs = last.observation;
    maxLive = Math.max(maxLive, obs.state.enemies.live);
    steps++;
  }
  assert.ok(steps > 300, `${steps} steps`);
  assert.ok(choices > 0 && kinds.has('levelup'), `dialogs seen: ${[...kinds].join(', ')}`);
  assert.ok(checked > 5);
  assert.ok(maxLive >= 10, `at most ${maxLive} live enemies`);
  assert.deepEqual(env.encoderUnknown, {}, 'every key the episode produced is in the vocabulary');
  assert.deepEqual(env.getMetadata().offline.blocked, []);
});

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

test('the extractor and the encoder are read-only: any number of extra calls leaves the episode\'s digest unchanged', async () => {
  const encoder = new ObservationEncoder(loadKnowledge(env.getMetadata().game.build));
  /** One record per step of everything that tells two episodes apart, plus the number of random draws. */
  const play = async (seed: number, extraCalls: number): Promise<{ digest: string; steps: number; draws: number }> => {
    const hash = createHash('sha256');
    let obs = await env.reset({ seed });
    const sim = env.debug.sim!;
    const rnd = sfc32(seed);
    let res: StepResult | null = null;
    for (;;) {
      const s = obs.snapshot, p = s.player;
      hash.update(JSON.stringify([obs.step, obs.simStep, s.t, p.x, p.y, p.z, p.hp, p.level, s.kills, s.enemies.count, sim.entropy.mathCalls(), obs.phase, obs.mask, obs.decision, obs.state]));
      if (res?.terminated || s.t >= 40) break;
      for (let i = 0; i < extraCalls; i++) {
        // The same read as the environment's: the two figures it hands in are taken from the observation itself.
        const again = extractState(sim.run, { pointsUsed: obs.state.pointsUsed, slotPrice: obs.state.economy.slotPrice, shopSold: obs.state.counters.shopSold });
        if (i === 0) assert.deepEqual(again, obs.state, 'a second read gives the same state');
        encoder.encode(obs, null);
        encodeMask(obs);
      }
      res = await env.step(decodeAction(sample(obs.encoded!.mask, rnd), obs));
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
