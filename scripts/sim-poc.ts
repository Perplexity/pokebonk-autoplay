/**
 * Proof of concept: the mirrored game bundle running headless inside Node (no browser, no debugger protocol, no network).
 *
 *   node scripts/sim-poc.ts                         one episode, seed 1, until the run is over or 600 s of game time
 *   node scripts/sim-poc.ts --seed=7 --max-time=120
 *   node scripts/sim-poc.ts --steps=2000            stop after this many simulation steps
 *   node scripts/sim-poc.ts --hz=60                 60 steps per game second instead of 20
 *   node scripts/sim-poc.ts --hz=30 --fps-limit=30  the game's own "FPS limit: 30" setting, stepped at 30 Hz
 *   node scripts/sim-poc.ts --render                also run the game's renderer against the null GL context
 *   node scripts/sim-poc.ts --determinism           same seed twice in two child processes, compare state digests
 *   node scripts/sim-poc.ts --verbose               print the page's console.warn/error as they happen
 *
 * The "policy" is deliberately dumb: hold one movement key, change it every 4 s of game time (a square walk), take
 * the first level-up offer. It exists to show that input reaches the game and that the run ends, nothing more.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Sim, DEFAULT_RUN } from '../src/sim/env.ts';
import { real } from '../src/sim/clock.ts';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) { const m = /^--([\w-]+)(?:=(.*))?$/.exec(a); if (m) args.set(m[1], m[2] ?? 'true'); }
const num = (k: string, d: number) => (args.has(k) ? Number(args.get(k)) : d);
const SEED = num('seed', 1), MAX_TIME = num('max-time', 600), MAX_STEPS = num('steps', Infinity), HZ = num('hz', 20);
const CHILD = args.has('samples-only');
// The page's console is captured by the sim, so the script writes to the streams directly.
const say = (s = '') => process.stdout.write(s + '\n');
// Wall time must come from the real clock: `performance.now()` is the virtual one once the sim is installed.
const wall = () => real.performanceNow();
const f1 = (v: number) => v.toFixed(1), f2 = (v: number) => v.toFixed(2);

/** One per second of game time. `rnd` is the number of Math.random() calls so far: a strict tripwire for divergence. */
interface Sample { t: number; x: number; y: number; z: number; hp: number; level: number; kills: number; rnd: number }
const digest = (samples: Sample[]) => createHash('sha256').update(JSON.stringify(samples)).digest('hex');

async function episode() {
  const wall0 = wall();
  // debugAutoAnswer: this script has no policy for dialogs; the driver answers them itself (first offer / first button).
  const sim = await Sim.boot({ seed: SEED, hz: HZ, fpsLimit: num('fps-limit', 0), render: args.has('render'), verbose: args.has('verbose'), debugAutoAnswer: true });
  const wallBoot = wall();
  if (!CHILD) {
    say(`boot      ok   ${(wallBoot - wall0).toFixed(0)} ms wall, virtual clock at ${sim.clock.now.toFixed(0)} ms, ${sim.loader.loaded.length} chunks, profile "${sim.app.meta.profile.name}"`);
    say(`          app=${sim.loader.ids?.app} App=${sim.loader.ids?.App} Run=${sim.loader.ids?.Run}, renderer "${sim.app.r.gpu}"`);
  }
  await sim.startRun({ ...DEFAULT_RUN });
  const wallRun = wall();
  const run = sim.run;
  if (!CHILD) {
    say(`startRun  ok   ${(wallRun - wallBoot).toFixed(0)} ms wall, run seed ${run.seed}, state "${run.state}", species ${run.player.speciesId}, biome ${run.biome?.id ?? DEFAULT_RUN.biome}`);
  }

  // ---- input check: one second each of no key, KeyW, KeyD. Forward is (-sin camYaw, -cos camYaw). ----
  let steps = 0;
  const held = async (keys: string[]) => {
    const a = sim.brief();
    sim.setKeys(keys);
    for (let i = 0; i < HZ; i++) { await sim.step(); steps++; }
    const b = sim.brief();
    return { keys, from: [a.x, a.z], to: [b.x, b.z], dx: b.x - a.x, dz: b.z - a.z };
  };
  const moves = [await held([]), await held(['KeyW']), await held(['KeyD'])];
  if (!CHILD) {
    say(`input     camYaw ${f2(run.camYaw)} → forward is (${f2(-Math.sin(run.camYaw))}, ${f2(-Math.cos(run.camYaw))}) in (x, z); input.locked=${sim.app.input.locked}`);
    for (const m of moves) say(`          1 s holding ${(m.keys.join('+') || 'nothing').padEnd(8)} (x, z) ${f2(m.from[0])}, ${f2(m.from[1])} → ${f2(m.to[0])}, ${f2(m.to[1])}   Δx=${f2(m.dx)} Δz=${f2(m.dz)}`);
    const ok = Math.hypot(moves[0].dx, moves[0].dz) < 0.01 && moves[1].dz < -3 && Math.abs(moves[1].dx) < 0.5 && moves[2].dx > 3 && Math.abs(moves[2].dz) < 0.5;
    say(`          ${ok ? 'OK: still without a key, forward on KeyW, right on KeyD' : 'UNEXPECTED: the player did not move as the keys say'}`);
    say(`stepping  dt=1/${HZ} s, cap ${MAX_TIME} s of game time${Number.isFinite(MAX_STEPS) ? ` or ${MAX_STEPS} steps` : ''}; square walk, key changes every 4 s`);
    say('   time  state        hp      lvl  kills  alive      x       y       z   key');
  }

  const KEYS = ['KeyW', 'KeyD', 'KeyS', 'KeyA'];
  const samples: Sample[] = [];
  const radii = new Map<number, Set<number>>(); // species → collision radii seen on plain enemies
  let nextLine = 0, nextSample = 0, reason = '', deadAt = -1, key = '';
  const line = () => { const b = sim.brief(); say(`${f1(b.time).padStart(7)}  ${b.state.padEnd(10)} ${f1(b.hp).padStart(6)}/${String(Math.round(b.maxHp)).padEnd(4)} ${String(b.level).padStart(3)} ${String(b.kills).padStart(6)} ${String(b.alive).padStart(6)} ${f2(b.x).padStart(8)} ${f2(b.y).padStart(7)} ${f2(b.z).padStart(8)}   ${key}`); };
  const wallLoop0 = wall();
  for (;;) {
    const b = sim.brief();
    if (b.time >= nextSample) { samples.push({ t: b.time, x: b.x, y: b.y, z: b.z, hp: b.hp, level: b.level, kills: b.kills, rnd: sim.entropy.mathCalls() }); nextSample = Math.floor(b.time) + 1; }
    if (!CHILD && b.time >= nextLine) { line(); nextLine += 30; }
    if (b.state === 'over') { reason = `run over: player ${run.player.dead ? 'dead' : 'alive'}, victory=${!!run.victory}, endHow=${run.endHow ?? 'n/a'}`; break; }
    if (b.state === 'dead' && deadAt < 0) { deadAt = steps; if (!CHILD) { say(`   player fainted at ${f2(b.time)} s (state "dead"); stepping on until the game closes the run`); line(); } }
    if (deadAt >= 0 && steps - deadAt > 30 * HZ) { reason = 'player dead (the run did not reach "over" within 30 s)'; break; }
    if (b.time >= MAX_TIME) { reason = `cap: ${MAX_TIME} s of game time`; break; }
    if (steps >= MAX_STEPS) { reason = `cap: ${MAX_STEPS} steps`; break; }
    key = KEYS[Math.floor(b.time / 4) % 4];
    sim.setKeys(b.state === 'play' ? [key] : []);
    await sim.step();
    steps++;
    if (steps % 100 === 0) { const E = run.enemies; for (let i = 0; i < E.n; i++) if (E.alive[i] && E.flags[i] === 0 && E.sized?.[i]) (radii.get(E.species[i]) ?? radii.set(E.species[i], new Set()).get(E.species[i])!).add(Math.round(E.radius[i] * 100) / 100); }
  }
  const wallLoop = wall() - wallLoop0;
  const b = sim.brief();
  samples.push({ t: b.time, x: b.x, y: b.y, z: b.z, hp: b.hp, level: b.level, kills: b.kills, rnd: sim.entropy.mathCalls() });

  if (CHILD) {
    say('@@SAMPLES@@' + JSON.stringify({ samples, steps, reason, digest: digest(samples), mathRandom: sim.entropy.mathCalls(), blocked: sim.net.log.blocked }));
    if (!args.has('keep-data')) sim.cleanup();
    return;
  }

  line();
  const snap = sim.snapshot();
  const rep = sim.report(), T = rep.timing;
  say();
  say(`terminal  ${reason}`);
  say(`steps     ${steps} (${f1(b.time)} s of game time) in ${(wallLoop / 1000).toFixed(2)} s wall → ${(steps / (wallLoop / 1000)).toFixed(0)} steps/s, ${(b.time / (wallLoop / 1000)).toFixed(1)}× real time`);
  say(`time      run.update ${T.updateMs.toFixed(0)} ms (${(T.updateMs / steps * 1000).toFixed(0)} µs/step) · timers ${T.timersMs.toFixed(0)} ms · yield to event loop ${T.yieldMs.toFixed(0)} ms${args.has('render') ? ` · null-GL render ${T.renderMs.toFixed(0)} ms` : ''} · boot ${(wallBoot - wall0).toFixed(0)} ms · start ${(wallRun - wallBoot).toFixed(0)} ms`);
  const gov = sim.governor();
  say(`governor  stepping at ${gov.hz} Hz; the game cuts its live-enemy cap when its measured fps is under ${gov.low} (setting fpsLimit=${gov.fpsCap || 'none'}); cap now ${gov.liveCap}/${gov.liveMax}${gov.cut ? ' (CUT by the game)' : ''}${gov.hz < gov.low ? ' — will be cut once ≥ ' + Math.round(gov.liveCap * 0.85) + ' enemies are alive' : ''}`);
  say(`memory    rss ${rep.memory.rssMB} MB, JS heap ${rep.memory.heapUsedMB} MB, external ${rep.memory.externalMB} MB`);
  say(`digest    ${digest(samples)} (${samples.length} samples)`);
  say(`snapshot  extractSnapshot ok: ${Object.keys(snap).length} fields; player ${JSON.stringify({ x: snap.player.x, y: snap.player.y, z: snap.player.z, hp: snap.player.hp, level: snap.player.level, moves: snap.player.moves.map((m: any) => `${m.key}:${m.level}`) })}`);
  say(`          enemies ${snap.enemies.count} (${snap.enemies.list.length} listed), shots ${snap.shots.length}, hazards ${snap.hazards.length}, points ${snap.points.length}, terrain ring ${JSON.stringify(snap.terrain?.ring)}`);
  say(`radii     plain enemies, species → collision radius: ${[...radii.entries()].sort((p, q) => p[0] - q[0]).map(([s, r]) => `${s}→${[...r].join('/')}`).join('  ') || '(none sized)'}`);
  say(`entropy   Math.random calls ${rep.entropy.mathRandom}, crypto.getRandomValues calls ${rep.entropy.crypto}`);
  say(`images    ${rep.images.loaded} loaded, ${rep.images.failed} failed (${rep.images.missing.length} not in the mirror), ${rep.images.decoded} PNG decodes, undecodable: ${rep.images.decodeFailed.length}`);
  say(`canvas2d  ${rep.canvas.contexts} contexts, drawImage ${rep.canvas.drawImage} (display, skipped ${rep.canvas.drawImageDisplay}; no source pixels ${rep.canvas.drawImageNoPixels}; resampled ${rep.canvas.drawImageScaled}), getImageData ${rep.canvas.getImageData} (blank ${rep.canvas.getImageDataBlank}: ${rep.canvas.blankReads.join(', ')})`);
  say(`api       ${rep.net.api.map(([k, n]) => `${k}${n > 1 ? ` ×${n}` : ''}`).join(' | ')}`);
  say(`mirror    ${rep.net.files} file reads; not in the mirror (404): ${rep.net.missing.map(([k, n]) => `${k}${n > 1 ? ` ×${n}` : ''}`).join(', ') || 'none'}`);
  say(`network   blocked attempts: ${rep.net.blocked.length ? rep.net.blocked.join(' | ') : 'none'}; cross-origin elements in the DOM (never loaded): ${rep.net.externalRefs.join(' | ') || 'none'}`);
  say(`driver    ${rep.events.length} interventions${rep.events.length ? ':' : ''}`);
  for (const e of rep.events.slice(0, 40)) say(`          ${f1(e.t).padStart(6)} s  ${e.what}`);
  if (rep.events.length > 40) say(`          … ${rep.events.length - 40} more`);
  say(`game log  errors the game caught itself: ${rep.gameErrors.length ? '' : 'none'}`);
  for (const e of rep.gameErrors) say(`          ${e.slice(0, 260)}`);
  say(`page log  console.warn/error + uncaught: ${rep.problems.length}`);
  for (const e of rep.problems.slice(0, 12)) say(`          ${e.split('\n')[0].slice(0, 260)}`);
  say(`ignored   ${rep.ignored.join(', ') || 'none'}`);
  say('instrumentation points:');
  for (const i of rep.instrumentation) say(`  - ${i}`);
  if (!args.has('keep-data')) sim.cleanup();
}

/** Same seed, two fresh processes; the digests of the per-second samples must match. */
async function determinism() {
  const me = fileURLToPath(import.meta.url);
  const pass = [...args.entries()].filter(([k]) => k !== 'determinism').map(([k, v]) => `--${k}=${v}`);
  const child = (n: number) => new Promise<any>((res, rej) => {
    const t0 = wall();
    const c = spawn(process.execPath, [me, ...pass, '--samples-only'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => {
      const m = /@@SAMPLES@@(.*)/.exec(out);
      if (!m) return rej(new Error(`child ${n} produced no samples (exit ${code})\n${err.slice(-2000)}`));
      res({ ...JSON.parse(m[1]), wallMs: wall() - t0 });
    });
  });
  say(`determinism: seed ${SEED}, two child processes, cap ${MAX_TIME} s of game time${Number.isFinite(MAX_STEPS) ? ` / ${MAX_STEPS} steps` : ''}`);
  const [a, b] = await Promise.all([child(1), child(2)]);
  for (const [n, r] of [[1, a], [2, b]] as const)
    say(`  run ${n}: ${r.steps} steps, ${r.samples.length} samples, ended "${r.reason}", Math.random calls ${r.mathRandom}, digest ${r.digest}, ${(r.wallMs / 1000).toFixed(1)} s wall`);
  if (a.digest === b.digest) { say('  RESULT: identical'); return; }
  const n = Math.min(a.samples.length, b.samples.length);
  let i = 0;
  while (i < n && JSON.stringify(a.samples[i]) === JSON.stringify(b.samples[i])) i++;
  say(`  RESULT: DIFFERENT. First differing sample: #${i}`);
  say(`    run 1: ${JSON.stringify(a.samples[i])}`);
  say(`    run 2: ${JSON.stringify(b.samples[i])}`);
  process.exitCode = 2;
}

try {
  if (args.has('determinism')) await determinism(); else await episode();
} catch (e) {
  process.stderr.write(`sim-poc failed: ${(e as Error)?.stack ?? e}\n`);
  process.exitCode = 1;
}
// Node timers of the DOM library may still be pending; the work is done.
process.exit(process.exitCode ?? 0);
