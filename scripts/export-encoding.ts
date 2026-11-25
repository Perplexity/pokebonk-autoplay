/**
 * The encoding contracts as files, and the cost of encoding (docs/observation.md).
 *
 *   node scripts/export-encoding.ts                 write data/encoding/<build>/observation-layout.json and action-layout.json,
 *                                                   the manager's two layouts next to them, and data/encoding/manager-ids.json
 *   node scripts/export-encoding.ts --check         compare with the files on disk (exit 2 if any differs)
 *   node scripts/export-encoding.ts --measure       boot the game and time state extraction and encoding at about 0, 150 and 800
 *                                                   live enemies (one long zone-1 run kept alive by a labelled cheat)
 *
 * Writing the layouts needs no game: they are a function of the code and of data/game-knowledge/<build>/vocab.json.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionLayout, encodeMask } from '../src/actions/codec.ts';
import { extractSnapshot } from '../src/bot/extract.ts';
import { createEnvironment, validChoices } from '../src/environment/index.ts';
import type { ChoiceMask, Observation, PlayAction } from '../src/environment/index.ts';
import { loadKnowledge } from '../src/knowledge/load.ts';
import { ObservationEncoder } from '../src/observations/encode.ts';
import { managerActionLayout } from '../src/hybrid/actions.ts';
import { REGISTRY_PATH, extendRegistry, registryTables } from '../src/hybrid/ids.ts';
import type { IdRegistry } from '../src/hybrid/ids.ts';
import { ManagerEncoder } from '../src/hybrid/observe.ts';
import { extractState } from '../src/observations/state.ts';
import { real } from '../src/sim/clock.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map<string, string>();
for (const a of process.argv.slice(2)) { const m = /^--([\w-]+)(?:=(.*))?$/.exec(a); if (m) args.set(m[1], m[2] ?? 'true'); }
const say = (s = '') => process.stdout.write(s + '\n');
const text = (v: unknown): string => JSON.stringify(v, null, 1) + '\n';

function build(): string {
  if (args.has('build')) return args.get('build')!;
  const root = join(REPO, 'data', 'game-knowledge');
  const builds = existsSync(root) ? readdirSync(root).filter((d) => existsSync(join(root, d, 'vocab.json'))) : [];
  if (builds.length !== 1) throw new Error(`expected exactly one exported build under data/game-knowledge, found ${builds.length} (${builds.join(', ')}); pass --build=<id>`);
  return builds[0];
}

async function measure(encoder: ObservationEncoder): Promise<void> {
  const env = createEnvironment({ invalidAction: 'throw' });
  let obs: Observation = await env.reset({ seed: 1 });
  const sim = env.debug.sim!;
  say('CHEAT (measurement only): the player\'s HP is rewritten to its maximum before every step so that the run reaches the final swarm; nothing measured here is a result of play.');
  const buckets = [{ name: '0–10 live enemies', lo: 0, hi: 10 }, { name: '100–200', lo: 100, hi: 200 }, { name: '700–800', lo: 700, hi: 800 }].map((b) => ({ ...b, n: 0, live: 0, state: 0, encode: 0, mask: 0, snapshot: 0, step: 0 }));
  const REP = 20;
  let prev: PlayAction | null = null, stepMs = 0;
  const done = () => buckets.every((b) => b.n >= 40);
  for (let i = 0; i < 400000 && !done(); i++) {
    const run = sim.run;
    run.player.hp = run.player.maxHp;
    const live = obs.state.enemies.live;
    const b = buckets.find((x) => live >= x.lo && live <= x.hi && x.n < 40);
    if (b && obs.phase === 'play' && i % 7 === 0) {
      let t = real.performanceNow();
      for (let r = 0; r < REP; r++) extractState(run);
      b.state += (real.performanceNow() - t) / REP;
      t = real.performanceNow();
      for (let r = 0; r < REP; r++) encoder.encode(obs, prev);
      b.encode += (real.performanceNow() - t) / REP;
      t = real.performanceNow();
      for (let r = 0; r < REP; r++) encodeMask(obs);
      b.mask += (real.performanceNow() - t) / REP;
      t = real.performanceNow();
      for (let r = 0; r < REP; r++) extractSnapshot.call(run);
      b.snapshot += (real.performanceNow() - t) / REP;
      b.step += stepMs; b.live += live; b.n++;
    }
    let action;
    if (obs.phase === 'choice') action = validChoices(obs.mask as ChoiceMask)[0];
    else { prev = { type: 'play', move: (Math.floor(i / 40) % 8) + 1 }; action = prev; }
    const t = real.performanceNow();
    const res = await env.step(action);
    stepMs = (real.performanceNow() - t) / Math.max(1, res.info.simSteps);
    obs = res.observation;
    if (res.terminated || res.truncated) { say(`the run ended (${res.info.endCause}) at ${res.info.time.toFixed(0)} s`); break; }
    if (i % 4000 === 0) say(`  … t=${res.info.time.toFixed(0)} s, live ${obs.state.enemies.live}, samples ${buckets.map((x) => x.n).join('/')}`);
  }
  say('per call, milliseconds (mean over the samples; each sample is the mean of 20 calls on the same state):');
  say('  load                 samples  live   extractState  encode   encodeMask  snapshot (existing)  one simulation step (env.step / simSteps)');
  for (const b of buckets) {
    if (!b.n) { say(`  ${b.name.padEnd(20)} no samples`); continue; }
    const f = (x: number) => (x / b.n).toFixed(3).padStart(8);
    say(`  ${b.name.padEnd(20)} ${String(b.n).padStart(5)}  ${(b.live / b.n).toFixed(0).padStart(5)}  ${f(b.state)}     ${f(b.encode)} ${f(b.mask)}    ${f(b.snapshot)}             ${f(b.step)}`);
  }
  await env.close();
}

try {
  const b = build();
  const k = loadKnowledge(b);
  const encoder = new ObservationEncoder(k);
  // The manager's layouts (src/hybrid): its id registry is one file for all builds and only ever grows.
  const before = existsSync(REGISTRY_PATH) ? (JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as IdRegistry) : null;
  const registry = extendRegistry(before, b, registryTables(k));
  const manager = new ManagerEncoder(b, registry);
  const files: Record<string, string> = {
    'observation-layout.json': text(encoder.layout), 'action-layout.json': text(actionLayout()),
    'manager-observation-layout.json': text(manager.layout), 'manager-action-layout.json': text(managerActionLayout()), '../manager-ids.json': text(registry),
  };
  say(`manager: observation layout v${manager.layout.version} hash ${manager.layout.hash.slice(0, 16)}… compat ${manager.layout.compat.slice(0, 16)}…, ${manager.layout.floatSize} floats + ${manager.layout.intSize} ints in ${manager.layout.segments.length} segments; ${managerActionLayout().size} actions (hash ${managerActionLayout().hash.slice(0, 16)}…); id registry: ${Object.keys(registry.tables).length} tables, builds ${registry.builds.join(', ')}`);
  const dir = join(REPO, 'data', 'encoding', b);
  const L = encoder.layout;
  say(`build ${b}: observation layout v${L.version} hash ${L.hash.slice(0, 16)}…, ${L.floatSize} floats + ${L.intSize} ints in ${L.segments.length} segments; action layout v${actionLayout().version} hash ${actionLayout().hash.slice(0, 16)}…, nvec [${actionLayout().nvec.join(', ')}], mask ${actionLayout().maskSize}`);
  for (const s of L.segments) say(`  ${s.dtype.padEnd(8)} ${s.name.padEnd(14)} offset ${String(s.offset).padStart(5)}  shape ${s.shape[0]} × ${s.shape[1]}`);
  if (args.has('measure')) await measure(encoder);
  else if (args.has('check')) {
    let same = true;
    for (const [name, body] of Object.entries(files)) { const p = join(dir, name); const ok = existsSync(p) && readFileSync(p, 'utf8') === body; same &&= ok; say(`  ${name}: ${ok ? 'identical' : 'DIFFERENT or missing'}`); }
    if (!same) process.exitCode = 2;
  } else {
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) { writeFileSync(join(dir, name), body); say(`  wrote ${join(dir, name)} (${Buffer.byteLength(body)} bytes)`); }
  }
} catch (e) {
  process.stderr.write(`export-encoding failed: ${(e as Error)?.stack ?? e}\n`);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
