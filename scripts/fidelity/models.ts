/**
 * What changes headless when 3D models load (docs/fidelity.md D2): the same episode twice in the headless environment,
 * no browser involved.
 *
 *   A  the environment as it is: three.js cannot load a file, no model ever arrives
 *   B  the same process with the two rejected shim patches `native-abort` and `request-base` applied in memory
 *      (src/fidelity/headlessRun.ts), so that every model loads
 *
 *   node scripts/fidelity/models.ts --seed=1 --map=forest --species=155 --tier=0 --steps=1200
 *
 * Compared: the static dump right after the reset (generated map, map points with their interaction radius, used flag
 * and cost, prop colliders, player, director), then the trajectory; at the first step that differs, every hashed
 * value by name and the Math.random call sites of both runs. Results: data/fidelity/models/<name>/.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareSides, describe } from '../../src/fidelity/compare.ts';
import type { EpisodeOptions, SideResult } from '../../src/fidelity/types.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = new Map<string, string>();
for (const a of process.argv.slice(2)) { const m = /^--([\w-]+)(?:=(.*))?$/.exec(a); if (m) args.set(m[1], m[2] ?? 'true'); }
const num = (k: string, d: number) => (args.has(k) ? Number(args.get(k)) : d);
const say = (s = '') => process.stdout.write(s + '\n');

const base: EpisodeOptions = {
  seed: num('seed', 1), species: num('species', 155), map: args.get('map') ?? 'forest', tier: num('tier', 0), script: args.get('script') ?? 'walk',
  maxSteps: num('steps', 1200), stopAtDialog: false, static: true, sheets: null, detail: null, trace: null,
};
const name = args.get('name') ?? `${base.map}-${base.species}-t${base.tier}-seed${base.seed}-${base.script}-${base.maxSteps}`;
const dir = resolve(REPO, 'data', 'fidelity', 'models', name);
mkdirSync(dir, { recursive: true });

function headless(o: EpisodeOptions, tag: string): Promise<SideResult> {
  const optFile = join(dir, `options-${tag}.json`), outFile = join(dir, `${tag}.json`);
  writeFileSync(optFile, JSON.stringify(o));
  return new Promise((res, rej) => {
    const c = spawn(process.execPath, [join(REPO, 'src', 'fidelity', 'headlessRun.ts'), optFile, outFile], { stdio: ['ignore', 'inherit', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => { if (code !== 0) rej(new Error(`headless run ${tag} failed (exit ${code})\n${err.slice(-4000)}`)); else res(JSON.parse(readFileSync(outFile, 'utf8')) as SideResult); });
  });
}
const PATCH = ['native-abort', 'request-base'];

try {
  say(`models: ${name}  (read "headless" as A = no model, "browser" as B = models load)`);
  let a = await headless(base, 'a'), b = await headless({ ...base, shimPatches: PATCH }, 'b');
  let cmp = compareSides(a, b);
  const first = cmp.trajectory.firstDifference;
  const text: string[] = [];
  if (first >= 0) {
    const again: EpisodeOptions = { ...base, maxSteps: Math.min(base.maxSteps, first + 2), detail: [Math.max(0, first - 1), first], trace: [Math.max(1, first), first + 1], static: false };
    const a2 = await headless(again, 'a-detail'), b2 = await headless({ ...again, shimPatches: PATCH }, 'b-detail');
    const c2 = compareSides(a2, b2);
    if (c2.trajectory.firstDifference === first) cmp = { ...cmp, trajectory: c2.trajectory };
    for (const step of Object.keys(a2.trace ?? {}).map(Number).sort((x, y) => x - y)) {
      const x = a2.trace![step] ?? [], y = b2.trace?.[step] ?? [];
      const count = (list: string[]) => { const m = new Map<string, number>(); for (const s of list) m.set(s, (m.get(s) ?? 0) + 1); return m; };
      const cx = count(x), cy = count(y);
      const sites = [...new Set([...cx.keys(), ...cy.keys()])].filter((s) => cx.get(s) !== cy.get(s));
      text.push(`  Math.random call sites at step ${step}: A ${x.length} calls, B ${y.length}; ${sites.length} site(s) with a different count`);
      for (const s of sites.slice(0, 20)) text.push(`      ${s}: A ${cx.get(s) ?? 0} | B ${cy.get(s) ?? 0}`);
    }
  }
  text.unshift(describe(cmp, 'A (no model) vs B (models load), both headless'));
  text.push(`  models, map points with a model after the reset / at the end: A ${a.models?.atReset.pointsWithModel}/${a.models?.atReset.pointsWithGroup} / ${a.models?.atEnd.pointsWithModel}/${a.models?.atEnd.pointsWithGroup} | B ${b.models?.atReset.pointsWithModel}/${b.models?.atReset.pointsWithGroup} / ${b.models?.atEnd.pointsWithModel}/${b.models?.atEnd.pointsWithGroup}`);
  text.push(`  B by kind at the end: ${JSON.stringify(b.models?.atEnd.byKind)}; capture ball model A ${a.models?.atEnd.captureBall} | B ${b.models?.atEnd.captureBall}`);
  text.push(`  \`new Request\` that threw: A ${a.requestThrows?.count} | B ${b.requestThrows?.count}; reset ms A ${Math.round(a.timing.resetMs)} | B ${Math.round(b.timing.resetMs)}`);
  if (base.script === 'seek') {
    // The two runs draw different random numbers from step 1 on, so they are different episodes. What can still be
    // compared: the map points the scripted player used before the episodes part ways, and from how far away.
    const show = (r: SideResult) => ((r.seekLog ?? []) as [number, string, number | null, number | null, number][]).map((e) => `${e[1]}@${e[0]} from ${e[3] === null ? '?' : e[3].toFixed(3)} m (radius ${e[4]})`);
    const la = show(a), lb = show(b);
    let same = 0;
    while (same < Math.min(la.length, lb.length) && la[same] === lb[same]) same++;
    text.push(`  map points used (kind@play step, distance at the key press): A ${la.length}, B ${lb.length}; the first ${same} are the same point at the same step from the same distance`);
    text.push(`      A: ${la.slice(0, 14).join('; ')}`);
    text.push(`      B: ${lb.slice(0, 14).join('; ')}`);
    text.push(`  dialog kinds: A ${JSON.stringify(a.dialogKinds)} | B ${JSON.stringify(b.dialogKinds)}`);
  }
  text.push(`  page problems: A ${a.problems.length} | B ${b.problems.length}`);
  for (const p of b.problems.slice(0, 4)) text.push(`      B: ${p.slice(0, 240).replace(/\n/g, ' ')}`);
  say(text.join('\n'));
  writeFileSync(join(dir, 'comparison.json'), JSON.stringify({ name, options: base, patch: PATCH, comparison: cmp, models: { a: a.models, b: b.models }, requestThrows: { a: a.requestThrows, b: b.requestThrows }, marks: { a: a.marks, b: b.marks } }, null, 1));
  writeFileSync(join(dir, 'summary.txt'), text.join('\n') + '\n');
  a = b = null as never;
} catch (e) {
  process.stderr.write(`fidelity models failed: ${(e as Error)?.stack ?? e}\n`);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
