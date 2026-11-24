/**
 * Reproducibility check for the environment's reset.
 *
 *   node scripts/env-determinism.ts                       seed 1, cap 120 s of game time, random policy
 *   node scripts/env-determinism.ts --seed=7 --max-time=0 full episodes (until the run ends)
 *   node scripts/env-determinism.ts --warmup=3            episodes played in the reused process before the test one
 *
 * Three child processes play the SAME episode (same seed, species, map, tier, policy):
 *   A  fresh process, first episode
 *   B  fresh process, first episode (process-to-process determinism)
 *   C  a process that first plays `--warmup` other episodes (different seeds, one cut short mid-run), then this one
 * Each prints a digest over every environment step: run clock, position, HP, level, KOs, the number of Math.random
 * calls so far, the phase and the pending decision. All three must be identical.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createEnvironment, POLICIES } from '../src/environment/index.ts';
import type { StepResult } from '../src/environment/index.ts';
import { real } from '../src/sim/clock.ts';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) { const m = /^--([\w-]+)(?:=(.*))?$/.exec(a); if (m) args.set(m[1], m[2] ?? 'true'); }
const num = (k: string, d: number) => (args.has(k) ? Number(args.get(k)) : d);
const say = (s = '') => process.stdout.write(s + '\n');
const SEED = num('seed', 1), MAX = num('max-time', 120), WARMUP = num('warmup', 2);
const POLICY = args.get('policy') ?? 'random';

async function child(): Promise<void> {
  const before = (args.get('before') ?? '').split(',').filter(Boolean).map(Number);
  const env = createEnvironment({ maxGameTime: MAX, species: num('species', 155), map: args.get('map') ?? 'forest', tier: num('tier', 0) });
  const policy = POLICIES[POLICY]();
  const play = async (seed: number, cutAfterSteps = Infinity) => {
    const hash = createHash('sha256');
    const trace: string[] = [];
    let obs = await env.reset({ seed });
    policy.reset(seed);
    const entropy = env.debug.sim!.entropy;
    let res: StepResult | null = null;
    const line = () => {
      const s = obs.snapshot, p = s.player;
      return JSON.stringify([obs.step, obs.simStep, s.t, p.x, p.y, p.z, p.hp, p.level, s.kills, s.enemies.count, entropy.mathCalls(), obs.phase, obs.decision ? [obs.decision.kind, obs.decision.options.map((o) => o.id)] : null]);
    };
    for (;;) {
      const l = line();
      hash.update(l);
      if (trace.length < 40000) trace.push(l);
      if (res?.terminated || res?.truncated || obs.step >= cutAfterSteps) break;
      res = await env.step(policy.act(obs));
      obs = res.observation;
    }
    return { digest: hash.digest('hex'), trace, steps: obs.step, simSteps: obs.simStep, time: obs.snapshot.t, kills: obs.snapshot.kills, level: obs.snapshot.player.level, end: res?.info.endCause ?? 'cut short by the script', mathRandom: entropy.mathCalls() };
  };
  // Warm-up episodes with other seeds; the last one is abandoned mid-run so the reset also has to close a live run.
  for (let i = 0; i < before.length; i++) await play(before[i], i === before.length - 1 ? 400 : Infinity);
  const t0 = real.performanceNow();
  const out = await play(SEED);
  say('@@RESULT@@' + JSON.stringify({ ...out, wallMs: real.performanceNow() - t0, blocked: env.getMetadata().offline.blocked }));
  await env.close();
}

async function parent(): Promise<void> {
  const me = fileURLToPath(import.meta.url);
  const pass = [...args.entries()].map(([k, v]) => `--${k}=${v}`);
  const run = (name: string, before: number[]) => new Promise<any>((res, rej) => {
    const c = spawn(process.execPath, [me, ...pass, '--child', `--before=${before.join(',')}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => {
      const m = /@@RESULT@@(.*)/.exec(out);
      if (!m) return rej(new Error(`child ${name} produced no result (exit ${code})\n${err.slice(-3000)}`));
      res({ name, ...JSON.parse(m[1]) });
    });
  });
  const warm = Array.from({ length: WARMUP }, (_, i) => SEED + 1000 * (i + 1));
  say(`reset reproducibility: seed ${SEED}, policy ${POLICY}, cap ${MAX || 'none'} s of game time; reused process plays seeds ${warm.join(', ')} first (the last one abandoned after 400 steps)`);
  const [a, b, c] = await Promise.all([run('A fresh', []), run('B fresh', []), run(`C after ${WARMUP} episodes`, warm)]);
  for (const r of [a, b, c]) say(`  ${r.name.padEnd(20)} ${r.steps} steps, ${r.simSteps} sim steps, t=${r.time.toFixed(2)} s, KOs ${r.kills}, level ${r.level}, end "${r.end}", Math.random calls ${r.mathRandom}, digest ${r.digest.slice(0, 16)}…, ${(r.wallMs / 1000).toFixed(1)} s wall`);
  let ok = true;
  for (const r of [b, c]) {
    if (r.digest === a.digest) continue;
    ok = false;
    let i = 0;
    while (i < Math.min(a.trace.length, r.trace.length) && a.trace[i] === r.trace[i]) i++;
    say(`  DIFFERENT: "${r.name}" vs "A fresh", first differing step record #${i}`);
    say(`    A: ${a.trace[i]}`);
    say(`    ${r.name[0]}: ${r.trace[i]}`);
  }
  say(ok ? '  RESULT: identical (fresh = fresh = reused process)' : '  RESULT: NOT reproducible');
  if (!ok) process.exitCode = 2;
}

try {
  if (args.has('child')) await child(); else await parent();
} catch (e) {
  process.stderr.write(`env-determinism failed: ${(e as Error)?.stack ?? e}\n`);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
