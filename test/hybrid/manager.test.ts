import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createEnvironment } from '../../src/environment/index.ts';
import { M_ACTIONS, M_PLAY_BASE, ManagerActionError, actionNames, skillId } from '../../src/hybrid/actions.ts';
import { ManagerEnvironment } from '../../src/hybrid/manager.ts';
import { ManagerEncoder } from '../../src/hybrid/observe.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = 5, CAP = 75;

/**
 * Slow: boots the real game (and a second process for the heuristic). The manager's environment on a real episode:
 * taking the heuristic's proposal at every decision IS the heuristic, and any other allowed skill can be carried out.
 */
test('the manager that always takes the proposal plays the heuristic\'s episode to the key press; other skills run too', async () => {
  const child = spawnSync(process.execPath, [join(HERE, 'play-heuristic.ts'), String(SEED), String(CAP)], { encoding: 'utf8', timeout: 240000 });
  assert.equal(child.status, 0, child.stderr.slice(-2000));
  const heuristic = JSON.parse(child.stdout.trim().split('\n').pop()!) as { steps: number; end: string; counters: Record<string, number> };

  const env = createEnvironment({ map: 'forest', species: 150, tier: 2, ranked: true, archive: 'balanced', maxGameTime: CAP });
  try {
    const mgr = new ManagerEnvironment(env);
    mgr.encoder = new ManagerEncoder('mwsewi0r');
    const L = mgr.encoder.layout, names = actionNames(), seg = (n: string) => L.segments.find((x) => x.name === n)!;
    const proposalAt = seg('proposal').offset, kindsAt = seg('kinds').offset, optionsAt = seg('options').offset, optionCols = seg('options').shape[1];
    let o = await mgr.reset({ seed: SEED }), ticks = 0, decisions = 0, dialogs = 0, plays = 0;
    const ended: Record<string, number> = {};
    for (;;) {
      const e = o.encoded!;
      assert.equal(o.mask.length, M_ACTIONS);
      assert.equal(o.mask[o.proposal], 1, `the proposal ${names[o.proposal]} is allowed`);
      assert.deepEqual([e.float.length, e.int.length], [L.floatSize, L.intSize]);
      for (let i = 0; i < e.float.length; i++) assert.ok(e.float[i] >= -1 && e.float[i] <= 1, `float ${i} = ${e.float[i]} is outside [−1, 1]`);
      // The proposal is in the observation, one-hot.
      let hot = 0;
      for (let a = 0; a < M_ACTIONS; a++) hot += e.float[proposalAt + a];
      assert.deepEqual([hot, e.float[proposalAt + o.proposal]], [1, 1]);
      if (o.phase === 'choice') {
        for (let a = M_PLAY_BASE; a < M_ACTIONS; a++) assert.equal(o.mask[a], 0, 'no skill while a dialog is open');
        const n = o.obs.decision!.options.length;
        assert.equal(e.float[optionsAt + (n - 1) * optionCols], 1, 'the last option\'s row is present');
        assert.equal(e.float[optionsAt + n * optionCols], 0, 'and no row after it');
      } else {
        for (let a = 0; a < M_PLAY_BASE; a++) assert.equal(o.mask[a], 0, 'no dialog answer in play');
        assert.equal(o.mask[skillId('farm')], 1);
        // `kinds` says for each use skill whether it is possible, as the mask does.
        for (let a = skillId('retreat') + 1, k = 0; a < M_ACTIONS; a++, k++) assert.equal(e.float[kindsAt + k * 6], o.mask[a], `kinds: ${names[a]}`);
      }
      const phase = o.phase, t = o.obs.state.zone.time;
      const r = await mgr.step(o.proposal);
      decisions++; ticks += r.ticks; ended[r.ended] = (ended[r.ended] ?? 0) + 1;
      if (phase === 'choice') { dialogs++; assert.deepEqual([r.dt, r.ticks], [0, 1], 'a dialog answer takes no game time'); }
      else { plays++; assert.ok(r.ticks >= 1 && r.dt > 0 && r.dt <= mgr.options.sliceSeconds + 0.2, `a skill ran ${r.dt} s`); assert.ok(Math.abs(r.dt - (r.observation.obs.state.zone.time - t)) < 1e-9); }
      o = r.observation;
      if (r.terminated || r.truncated) {
        // The same low-level decisions, the same run: every counter of the heuristic's own episode.
        assert.equal(ticks, heuristic.steps);
        assert.equal(r.info.endCause, heuristic.end);
        assert.deepEqual(JSON.parse(JSON.stringify(r.info.counters)), heuristic.counters);
        assert.equal(o.phase, 'over');
        assert.ok([...o.mask].every((v) => v === 0) && o.proposal === -1);
        await assert.rejects(() => mgr.step(skillId('farm')), /it is over|no episode/);
        break;
      }
    }
    assert.ok(dialogs > 5 && plays > 40 && decisions < ticks / 3, `${decisions} decisions (${dialogs} dialogs, ${plays} skills) for ${ticks} low-level steps`);
    assert.ok(ended.time > 20 && ended.dialog > 5, JSON.stringify(ended));

    // A second episode, played against the proposal: every allowed skill in turn. It runs, and forbidden ones are refused.
    o = await mgr.reset({ seed: SEED + 1 });
    let strayed = 0, turn = 0;
    for (let k = 0; k < 60 && o.phase !== 'over'; k++) {
      if (o.phase === 'choice') { o = (await mgr.step(o.proposal)).observation; continue; }
      const allowed = [...o.mask].map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
      const pick = allowed[turn++ % allowed.length];
      if (pick !== o.proposal) strayed++;
      const forbidden = o.mask.findIndex((v, i) => !v && i >= M_PLAY_BASE);
      if (forbidden >= 0) await assert.rejects(() => mgr.step(forbidden), ManagerActionError);
      await assert.rejects(() => mgr.step(0), ManagerActionError);
      o = (await mgr.step(pick)).observation;
    }
    assert.ok(strayed > 10, `${strayed} skills other than the proposal were carried out`);
    const fig = env.survivalFigures();
    assert.ok(fig.spawnMultiplier >= 1 && fig.spawnMultiplier <= 3 && fig.overheal >= 0 && fig.leechBudget >= 0 && fig.roars >= 0 && fig.roars <= 3, JSON.stringify(fig));
  } finally { await env.close(); }
});
