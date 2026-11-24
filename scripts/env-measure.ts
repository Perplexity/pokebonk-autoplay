/**
 * Measurements of the headless environment at the configured step rate (default 60 Hz, action repeat 3).
 *
 *   node scripts/env-measure.ts --resets=8                 boot cost, first reset, later resets
 *   node scripts/env-measure.ts --memory=12                N short random-policy episodes in one process: memory after each
 *   node scripts/env-measure.ts --horde=1150               one long zone-1 run to that many seconds of zone time: throughput by
 *                                                          horde size, the frame-rate governor, the final swarm, the collapse
 *
 * MEASUREMENT PROBE, NOT AN AGENT: `--horde` keeps the player alive by writing its HP every step (a cheat, done on the
 * game object directly, outside the environment's interface) because no policy here survives long enough to see a
 * full horde. Nothing in src/environment does this.
 */
import { createEnvironment, POLICIES } from '../src/environment/index.ts';
import type { StepResult } from '../src/environment/index.ts';
import { real } from '../src/sim/clock.ts';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) { const m = /^--([\w-]+)(?:=(.*))?$/.exec(a); if (m) args.set(m[1], m[2] ?? 'true'); }
const num = (k: string, d: number) => (args.has(k) ? Number(args.get(k)) : d);
const say = (s = '') => process.stdout.write(s + '\n');
const now = () => real.performanceNow();
const mem = () => { const m = process.memoryUsage(); return { rss: Math.round(m.rss / 1048576), heap: Math.round(m.heapUsed / 1048576), ext: Math.round(m.external / 1048576) }; };
const gc = (globalThis as { gc?: () => void }).gc;

const env = createEnvironment({ hz: num('hz', 60), actionRepeat: num('action-repeat', 3), maxGameTime: num('max-time', 0), map: args.get('map') ?? 'forest', tier: num('tier', 0) });
const SEED = num('seed', 1);

try {
  if (args.has('resets')) {
    const n = num('resets', 8);
    const t0 = now();
    await env.reset({ seed: SEED });
    const first = now() - t0;
    say(`boot + first reset: ${first.toFixed(0)} ms (boot ${env.timing.bootMs.toFixed(0)} ms incl. offline self-test, reset ${(first - env.timing.bootMs).toFixed(0)} ms)`);
    const policy = POLICIES.random();
    const times: number[] = [];
    for (let i = 1; i <= n; i++) {
      // Play a little so the reset has a live run to close (the usual case after a truncated episode is the same path).
      let obs = env.getObservation();
      policy.reset(i);
      for (let k = 0; k < 200; k++) { const r = await env.step(policy.act(obs)); obs = r.observation; if (r.terminated) break; }
      const t = now();
      await env.reset({ seed: SEED + i });
      times.push(now() - t);
    }
    times.sort((a, b) => a - b);
    say(`later resets (${n}): median ${times[Math.floor(n / 2)].toFixed(0)} ms, min ${times[0].toFixed(0)} ms, max ${times[n - 1].toFixed(0)} ms`);
  }

  if (args.has('memory')) {
    const n = num('memory', 12), cap = num('episode-time', 90);
    const policy = POLICIES.random();
    say(`memory over ${n} episodes in one process (random policy, each cut at ${cap} s of game time${gc ? ', GC forced before each reading' : '; run with --expose-gc for readings after a forced GC'})`);
    say('  episode   game s    KOs   wall s   rss MB   JS heap MB   external MB');
    for (let i = 0; i < n; i++) {
      let obs = await env.reset({ seed: SEED + i });
      policy.reset(SEED + i);
      const t = now();
      let res: StepResult | null = null;
      for (;;) { res = await env.step(policy.act(obs)); obs = res.observation; if (res.terminated || res.truncated || res.info.time >= cap) break; }
      gc?.();
      const m = mem();
      say(`  ${String(i + 1).padStart(7)}  ${res.info.time.toFixed(1).padStart(7)}  ${String(res.info.kills).padStart(5)}  ${((now() - t) / 1000).toFixed(1).padStart(7)}  ${String(m.rss).padStart(7)}  ${String(m.heap).padStart(11)}  ${String(m.ext).padStart(12)}`);
    }
  }

  if (args.has('horde')) {
    const until = num('horde', 700);
    let obs = await env.reset({ seed: SEED });
    const run = env.debug.sim!.run;
    const policy = POLICIES.idle();
    const buckets = [0, 50, 150, 300, 500, 700, 100000];
    const acc = buckets.slice(0, -1).map(() => ({ steps: 0, ms: 0, game: 0 }));
    let swarmAt = -1, collapseAt = -1, peak = 0, minCap = run.liveCap, lastLine = 0;
    say(`long zone-1 run to ${until} s of zone time (idle policy; CHEAT: HP rewritten every step). Columns: zone time, live enemies, live cap, final swarm, collapse HP/s, sim steps/s`);
    let wallMark = now(), stepMark = 0;
    for (;;) {
      run.player.hp = run.player.maxHp; // the cheat
      const n = obs.snapshot.enemies.count;
      const b = buckets.findIndex((lo, i) => n >= lo && n < buckets[i + 1]);
      const t = now(), s0 = obs.simStep, g0 = run.time;
      const res = await env.step(policy.act(obs));
      obs = res.observation;
      acc[b].steps += obs.simStep - s0; acc[b].ms += now() - t; acc[b].game += run.time - g0;
      peak = Math.max(peak, n); minCap = Math.min(minCap, run.liveCap);
      if (swarmAt < 0 && run.director.finalSwarm) { swarmAt = run.stageTime; say(`  final swarm began at zone time ${swarmAt.toFixed(1)} s`); }
      if (collapseAt < 0 && run.collapseHp() > 0) { collapseAt = run.stageTime; say(`  collapse (HP drain) began at zone time ${collapseAt.toFixed(1)} s: ${run.collapseHp().toFixed(2)} HP/s of ${run.player.maxHp.toFixed(0)} max HP`); }
      if (run.stageTime - lastLine >= 60) {
        lastLine = run.stageTime;
        const w = now();
        say(`  ${run.stageTime.toFixed(0).padStart(5)} s  ${String(n).padStart(4)} enemies  cap ${run.liveCap}/${run.liveMax}  swarm ${run.director.finalSwarm ? 'yes' : 'no '}  collapse ${run.collapseHp().toFixed(2).padStart(6)}  ${(((obs.simStep - stepMark) / (w - wallMark)) * 1000).toFixed(0).padStart(5)} steps/s`);
        wallMark = w; stepMark = obs.simStep;
      }
      if (res.terminated || res.truncated || run.stageTime >= until) break;
    }
    say('  throughput by number of live enemies:');
    for (const [i, a] of acc.entries()) if (a.steps) say(`    ${String(buckets[i]).padStart(4)}–${buckets[i + 1] > 9999 ? '   +' : String(buckets[i + 1] - 1).padStart(4)}  ${String(a.steps).padStart(7)} sim steps  ${((a.steps / a.ms) * 1000).toFixed(0).padStart(5)} steps/s  ×${((a.game / a.ms) * 1000).toFixed(1)} real time  (${(a.ms / a.steps).toFixed(2)} ms/step)`);
    const g = env.getMetadata().governor!;
    say(`  peak live enemies ${peak}; governor: thresholds ${g.low}/${g.high} fps, measured fps ${run.fps.toFixed(2)}, live cap now ${g.liveCap}/${g.liveMax}, lowest seen ${minCap}, ever cut: ${g.everCut ? 'YES' : 'no'}`);
    const m = mem();
    say(`  memory: rss ${m.rss} MB, JS heap ${m.heap} MB`);
  }
} catch (e) {
  process.stderr.write(`env-measure failed: ${(e as Error)?.stack ?? e}\n`);
  process.exitCode = 1;
}
await env.close();
process.exit(process.exitCode ?? 0);
