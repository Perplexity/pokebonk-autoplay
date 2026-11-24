/**
 * Fidelity check: the same episode in the headless environment and in a real local Chrome, compared step by step.
 *
 *   node scripts/fidelity/compare.ts --seed=1 --map=forest --steps=3600 --script=walk
 *   node scripts/fidelity/compare.ts --seed=1 --steps=0 --static --sheets          static comparison + all sprite sheets
 *   node scripts/fidelity/compare.ts --seed=2 --map=coast --stop-at-dialog         until the first dialog opens
 *   node scripts/fidelity/compare.ts --seed=1 --native-hud                         browser keeps the game's own dialogs
 *   node scripts/fidelity/compare.ts --seed=1 --render=1                           browser draws every step (real WebGL)
 *   node scripts/fidelity/compare.ts --seed=1 --browser-twice                      also browser against browser
 *   node scripts/fidelity/compare.ts --seed=1 --common-math                        both sides use one Math implementation
 *   node scripts/fidelity/compare.ts --seed=1 --patch=native-abort                 headless side with a proposed shim patch applied in memory
 *   node scripts/fidelity/compare.ts --seed=1 --trace=1,2                          Math.random call sites of steps 1–2 on both sides
 *   node scripts/fidelity/compare.ts --seed=1 --preload=auto                       both sides request, before play, the sprite sheets the episode needs
 *   node scripts/fidelity/compare.ts --seed=1 --no-align                           do not equalise the page clock after boot
 *   node scripts/fidelity/compare.ts --seed=1 --equal                              the configuration where identity is expected:
 *                                                                                  --common-math --browser-as-shim=request,audio-clock,uuid --warm-sheets
 *   node scripts/fidelity/compare.ts --seed=1 --equal --script=seek                a player that walks to map points and uses them
 *
 * `--browser-as-shim` and `--warm-sheets` change the page in the BROWSER only, in memory (docs/fidelity.md §7):
 * they copy the environment's known, deliberate differences into the browser so that the rest can be compared exactly.
 *
 * Offline: the browser is a local Chrome with its own profile under data/fidelity/, every request is answered from
 * mirror/ or by the in-process mock, everything else is refused (src/fidelity/chrome.ts). Results go to
 * data/fidelity/<name>/ (headless.json, browser.json, comparison.json, summary.txt).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBrowser } from '../../src/fidelity/browserRun.ts';
import { compareSides, countLeaves, describe, diffJson } from '../../src/fidelity/compare.ts';
import type { EpisodeOptions, SideResult } from '../../src/fidelity/types.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = new Map<string, string>();
for (const a of process.argv.slice(2)) { const m = /^--([\w-]+)(?:=(.*))?$/.exec(a); if (m) args.set(m[1], m[2] ?? 'true'); }
const num = (k: string, d: number) => (args.has(k) ? Number(args.get(k)) : d);
const say = (s = '') => process.stdout.write(s + '\n');

/**
 * Ids, as the game's sprite cache numbers them, of every sprite sheet in the mirror: pmd/<species>.png is the species
 * number, pmd-forms/<id>.png its own id (30000 and up), pmd-shiny/<species>.png is 20000 + species.
 */
function sheetIds(): number[] {
  const ids = (dir: string) => readdirSync(join(REPO, 'mirror', 'assets', dir)).filter((f) => /^\d+\.png$/.test(f)).map((f) => Number(f.slice(0, -4)));
  return [...ids('pmd'), ...ids('pmd-forms'), ...ids('pmd-shiny').map((n) => 20000 + n)].sort((a, b) => a - b);
}

// `--equal`: the configuration in which the two sides are expected to be identical (docs/fidelity.md §3): one Math on
// both sides, and the browser brought to the shim's behaviour where the shim is known to differ and is left so.
if (args.has('equal')) { args.set('common-math', 'true'); if (!args.has('browser-as-shim')) args.set('browser-as-shim', 'request,audio-clock,uuid'); args.set('warm-sheets', 'true'); }
const opt: EpisodeOptions = {
  seed: num('seed', 1), species: num('species', 155), map: args.get('map') ?? 'forest', tier: num('tier', 0), script: args.get('script') ?? 'walk',
  maxSteps: num('steps', 3600), stopAtDialog: args.has('stop-at-dialog'), static: args.has('static'), sheets: args.has('sheets') ? sheetIds() : null, commonMath: args.has('common-math'),
  preloadSheets: args.has('preload') && args.get('preload') !== 'auto' ? args.get('preload')!.split(',').map(Number) : [],
  shimPatches: args.has('patch') ? args.get('patch')!.split(',') : [],
  browserAsShim: args.has('browser-as-shim') ? args.get('browser-as-shim')!.split(',').filter(Boolean) : [],
  warmSheets: args.has('warm-sheets'),
  trace: args.has('trace') ? (args.get('trace')!.split(',').map(Number) as [number, number]) : null,
  detail: args.has('detail') ? (args.get('detail')!.split(',').map(Number) as [number, number]) : null,
};
const name = args.get('name') ?? `${opt.map}-${opt.species}-t${opt.tier}-seed${opt.seed}-${opt.script}-${opt.maxSteps}${opt.stopAtDialog ? '-dialog' : ''}${args.has('native-hud') ? '-nativehud' : ''}${args.has('render') ? '-render' + args.get('render') : ''}${opt.sheets ? '-sheets' : ''}${opt.commonMath ? '-commonmath' : ''}${opt.shimPatches?.length ? '-patch-' + opt.shimPatches.join('+') : ''}${opt.browserAsShim?.length ? '-asshim-' + opt.browserAsShim.join('+') : ''}${opt.warmSheets ? '-warm' : ''}${args.has('no-align') ? '-noalign' : ''}${args.has('preload') ? '-preload' : ''}`;
const dir = resolve(REPO, 'data', 'fidelity', name);
mkdirSync(dir, { recursive: true });

function headless(o: EpisodeOptions, tag: string): Promise<SideResult> {
  const optFile = join(dir, `options-${tag}.json`), outFile = join(dir, `${tag}.json`);
  writeFileSync(optFile, JSON.stringify(o));
  return new Promise((res, rej) => {
    const c = spawn(process.execPath, [join(REPO, 'src', 'fidelity', 'headlessRun.ts'), optFile, outFile], { stdio: ['ignore', 'inherit', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => { if (code !== 0) rej(new Error(`headless side failed (exit ${code})\n${err.slice(-4000)}`)); else res(JSON.parse(readFileSync(outFile, 'utf8')) as SideResult); });
  });
}
const browser = async (o: EpisodeOptions, ref: SideResult, tag: string): Promise<SideResult> => {
  const r = await runBrowser(o, {
    reference: ref, dataDir: resolve(REPO, 'data', 'fidelity'), dialogCapture: !args.has('native-hud'), renderEvery: num('render', 0), quietMs: num('quiet', 120),
    lingerMs: num('linger', 0), alignClock: !args.has('no-align'), profile: args.get('profile'), screenshot: join(dir, `${tag}.png`), log: (l) => say(`  [browser] ${l}`),
  });
  writeFileSync(join(dir, `${tag}.json`), JSON.stringify(r));
  return r;
};

try {
  say(`fidelity: ${name}`);
  let h = await headless(opt, 'headless');
  if (args.get('preload') === 'auto') {
    // A sprite sheet that arrives during play shifts the random stream at a moment the two sides cannot agree on.
    // Find the sheets this episode asks for during play and have both sides ask for them before play instead.
    // Asking earlier changes the episode, so repeat until an episode asks for none.
    for (let round = 1; round <= 6 && h.spritesDuringPlay?.length; round++) {
      opt.preloadSheets = [...new Set([...(opt.preloadSheets ?? []), ...h.spritesDuringPlay])].sort((x, y) => x - y);
      say(`  [headless] sprite sheets first requested during play: ${h.spritesDuringPlay.join(', ')}; round ${round} with ${opt.preloadSheets.length} sheet(s) requested before play`);
      h = await headless(opt, 'headless');
    }
    if (h.spritesDuringPlay?.length) say(`  NOTE: sprite sheets still arrive during play after 6 rounds: ${h.spritesDuringPlay.join(', ')}`);
  }
  say(`  [headless] ${h.lines.length - 1} steps, stop "${h.stop}", reset ${Math.round(h.timing.resetMs)} ms, play ${Math.round(h.timing.playMs)} ms (${h.engine.node}, V8 ${h.engine.v8})`);
  let b = await browser(opt, h, 'browser');
  let cmp = compareSides(h, b);

  // A difference without field detail: run both sides again up to that step with every hashed value kept by name.
  const first = cmp.trajectory.firstDifference;
  if (first >= 0 && !args.has('no-detail')) {
    say(`  first difference at step ${first}: running both sides again with field detail for steps ${Math.max(0, first - 1)}–${first}`);
    const again: EpisodeOptions = { ...opt, maxSteps: Math.min(opt.maxSteps, first + 2), detail: [Math.max(0, first - 1), first], static: false, sheets: null };
    const h2 = await headless(again, 'headless-detail');
    const b2 = await browser(again, h2, 'browser-detail');
    const c2 = compareSides(h2, b2);
    if (c2.trajectory.firstDifference === first) { cmp = { ...cmp, trajectory: c2.trajectory, trajectoryWithoutClock: c2.trajectoryWithoutClock.firstDifference >= 0 ? c2.trajectoryWithoutClock : cmp.trajectoryWithoutClock }; }
    else say(`  NOTE: the second pair of runs first differs at step ${c2.trajectory.firstDifference}, not ${first}: one side is not reproducible`);
  }
  const text = [describe(cmp, `headless vs browser (${b.engine.browser}, V8 ${b.engine.v8})`)];

  let twice: ReturnType<typeof compareSides> | null = null;
  if (args.has('browser-twice')) {
    const b2 = await browser(opt, h, 'browser-second');
    twice = compareSides(b as SideResult, b2);
    text.push(describe(twice, 'browser vs browser, second run (read "headless" as the first browser run)'));
  }
  if (h.trace && b.trace) {
    // Math.random call sites, step by step: which places in the game's code drew a different number of values.
    for (const step of Object.keys(h.trace).map(Number).sort((x, y) => x - y)) {
      const x = h.trace[step] ?? [], y = b.trace[step] ?? [];
      const count = (list: string[]) => { const m = new Map<string, number>(); for (const s of list) m.set(s, (m.get(s) ?? 0) + 1); return m; };
      const cx = count(x), cy = count(y);
      const sites = [...new Set([...cx.keys(), ...cy.keys()])].filter((s) => cx.get(s) !== cy.get(s));
      let first = 0;
      while (first < Math.min(x.length, y.length) && x[first] === y[first]) first++;
      text.push(`  Math.random call sites at step ${step}: headless ${x.length} calls, browser ${y.length}; ${sites.length ? `${sites.length} site(s) with a different count; sequences agree for the first ${first} calls` : 'same sites, same counts' + (first < x.length ? ` (order differs from call ${first})` : ', same order')}`);
      for (const s of sites.slice(0, 20)) text.push(`      ${s}: headless ${cx.get(s) ?? 0} | browser ${cy.get(s) ?? 0}`);
    }
  }
  const info = b.browser ?? {};
  text.push(`  profile preset ${h.preset}: sha256 of the adopted profile headless ${h.profileSha?.slice(0, 16)} | browser ${b.profileSha?.slice(0, 16)}${h.profileSha === b.profileSha ? ' (same)' : ' (DIFFERENT)'}; account ${h.account?.id} | ${b.account?.id}`);
  text.push(`  3D models, map points with a model after the reset / at the end: headless ${h.models?.atReset.pointsWithModel}/${h.models?.atReset.pointsWithGroup} / ${h.models?.atEnd.pointsWithModel}/${h.models?.atEnd.pointsWithGroup} | browser ${b.models?.atReset.pointsWithModel}/${b.models?.atReset.pointsWithGroup} / ${b.models?.atEnd.pointsWithModel}/${b.models?.atEnd.pointsWithGroup}; \`new Request\` that threw: headless ${h.requestThrows?.count} | browser ${b.requestThrows?.count}`);
  text.push(`  sprite sheets fetched after play began: headless ${JSON.stringify(h.sheetsDuringPlay)} | browser ${JSON.stringify(b.sheetsDuringPlay)}; browser sheet cache ${JSON.stringify(info.sheetCache)}; warm-up ${JSON.stringify(info.warmSheets)}`);
  text.push(`  dialog kinds seen: headless ${JSON.stringify(h.dialogKinds ?? null)} | browser ${JSON.stringify(b.dialogKinds ?? null)}`);
  if (opt.script === 'seek') {
    const d = diffJson(h.seekLog ?? [], b.seekLog ?? []);
    const kinds = (r: SideResult) => { const m: Record<string, number> = {}; for (const e of (r.seekLog ?? []) as unknown[][]) m[String(e[1])] = (m[String(e[1])] ?? 0) + 1; return m; };
    text.push(`  map points used by the seek script: headless ${h.seekLog?.length} ${JSON.stringify(kinds(h))} | browser ${b.seekLog?.length} ${JSON.stringify(kinds(b))}; the two logs: ${d.length ? d.length + ' difference(s)' : 'identical'}`);
  }
  const platform = h.platform && b.platform ? diffJson(h.platform, b.platform) : [];
  text.push(`  platform values a page script can read (${h.platform ? countLeaves(h.platform) : 0} compared): ${platform.length} differ`);
  for (const d of platform) text.push(`      ${d.path}: headless ${JSON.stringify(d.headless)} | browser ${JSON.stringify(d.browser)}`);
  text.push(`  browser: frames ${JSON.stringify(info.frames)}, quality ${info.quality}, requests ${JSON.stringify(info.requests)}`);
  text.push(`  browser page: ${JSON.stringify(info.page)}  gl: ${JSON.stringify(info.gl)}`);
  text.push(`  browser notes: ${JSON.stringify(info.notes)}`);
  text.push(`  requests after play began: ${JSON.stringify(info.requestsDuringPlay)}`);
  text.push(`  blocked requests: headless ${JSON.stringify(h.blocked)} | browser ${JSON.stringify(b.blocked)}`);
  text.push(`  page problems: headless ${h.problems.length} | browser ${b.problems.length}`);
  for (const p of b.problems.slice(0, 6)) text.push(`      browser: ${p.slice(0, 300).replace(/\n/g, ' ')}`);
  text.push(`  game error log: headless ${JSON.stringify(h.gameErrors).slice(0, 300)} | browser ${JSON.stringify(b.gameErrors).slice(0, 300)}`);
  say(text.join('\n'));
  writeFileSync(join(dir, 'comparison.json'), JSON.stringify({
    name, options: opt, flags: Object.fromEntries(args), engines: { headless: h.engine, browser: b.engine },
    steps: { headless: h.lines.length - 1, browser: b.lines.length - 1, stopHeadless: h.stop, stopBrowser: b.stop, end: h.end, last: h.lines[h.lines.length - 1]?.slice(0, 18), lastBrowser: b.lines[b.lines.length - 1]?.slice(0, 18) },
    timing: { headless: h.timing, browser: b.timing }, comparison: cmp, browserTwice: twice, browserFacts: b.browser, audio: { headless: h.audio, browser: b.audio },
    preset: h.preset, profileSha: { headless: h.profileSha, browser: b.profileSha }, account: h.account?.id, models: { headless: h.models, browser: b.models },
    requestThrows: { headless: h.requestThrows?.count, browser: b.requestThrows?.count }, sheetsDuringPlay: { headless: h.sheetsDuringPlay, browser: b.sheetsDuringPlay },
    marks: { headless: h.marks, browser: b.marks }, platform,
    dialogKinds: { headless: h.dialogKinds ?? null, browser: b.dialogKinds ?? null }, seekLog: { headless: h.seekLog ?? null, browser: b.seekLog ?? null },
  }, null, 1));
  writeFileSync(join(dir, 'summary.txt'), text.join('\n') + '\n');
  say(`  results: ${dir}`);
  h = b = null as never;
} catch (e) {
  process.stderr.write(`fidelity compare failed: ${(e as Error)?.stack ?? e}\n`);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
