/**
 * The whole fidelity matrix, one comparison after the other (one browser at a time), with a results table.
 *
 *   node scripts/fidelity/suite.ts                 everything (about two hours on a busy machine)
 *   node scripts/fidelity/suite.ts --only=static   groups: static | equal | models | asis | math | shims | timing | single | variants
 *   node scripts/fidelity/suite.ts --only=equal-walk-forest-155-t0-s1      one case by its id
 *   node scripts/fidelity/suite.ts --profile=browser-profile-2   another Chrome profile folder (to run two groups at once)
 *   node scripts/fidelity/suite.ts --full=45000 --long=12000   step limits of the long groups (an episode also ends when the run does)
 *   node scripts/fidelity/suite.ts --skip-done     keep results that already exist under data/fidelity/suite/
 *   node scripts/fidelity/suite.ts --table         only rebuild results.md / results.json from the existing results
 *
 * Each case is one call of scripts/fidelity/compare.ts; its folder is data/fidelity/suite/<case>/. The table goes to
 * data/fidelity/suite/results.md and results.json.
 *
 * Configurations (docs/fidelity.md §3):
 *   as is      the environment as it is against the browser as it is (cold sheet cache, its own Math, models, audio)
 *   equal      `--equal`: one Math on both sides; the browser made to behave like the shim in the two places where the
 *              shim is known to differ and is left so (no file through three.js, the suspended audio clock runs), and
 *              the game's sheet cache warm. The headless side is the unmodified environment. Identity is expected.
 *   models     the draft's way round: the HEADLESS side gets the three rejected shim patches in memory, so that models
 *              load on both sides; the browser only has the warm sheet cache
 *   math       only the common Math: what the shims (and a cold sheet cache) change
 *   shims      everything of `equal` except the Math: what the two engines' Math alone changes
 *   timing     everything of `equal` except the warm sheet cache: what a cold game cache changes
 *   single     `equal` with one of the two shim equalisations left out: each known shim difference by itself
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = new Map<string, string>();
for (const a of process.argv.slice(2)) { const m = /^--([\w-]+)(?:=(.*))?$/.exec(a); if (m) args.set(m[1], m[2] ?? 'true'); }
const say = (s = '') => process.stdout.write(s + '\n');
const PATCHES = '--patch=native-abort,request-base,audio-clock';
const LONG = Number(args.get('long') ?? 12000);
const FULL = Number(args.get('full') ?? 45000);
const EQUAL = ['--equal'];
const AS_SHIM = '--browser-as-shim=request,audio-clock,uuid';

interface Case { id: string; group: string; what: string; flags: string[] }
const EPISODES: { seed: number; map: string; species: number; tier: number }[] = [
  { seed: 1, map: 'forest', species: 155, tier: 0 }, { seed: 2, map: 'forest', species: 155, tier: 0 }, { seed: 3, map: 'forest', species: 155, tier: 0 },
  { seed: 11, map: 'coast', species: 25, tier: 2 }, { seed: 12, map: 'coast', species: 25, tier: 2 }, { seed: 13, map: 'coast', species: 25, tier: 2 },
];
const ep = (e: (typeof EPISODES)[number]) => [`--seed=${e.seed}`, `--map=${e.map}`, `--species=${e.species}`, `--tier=${e.tier}`];
const tag = (e: (typeof EPISODES)[number]) => `${e.map}-${e.species}-t${e.tier}-s${e.seed}`;

const cases: Case[] = [];
// Stage 1: static state of a fresh run. Every sprite sheet of the mirror once (pmd, pmd-forms, pmd-shiny).
for (const e of EPISODES) cases.push({ id: `static-asis-${tag(e)}`, group: 'static', what: 'static, as is', flags: [...ep(e), '--steps=0', '--static', ...(e === EPISODES[0] ? ['--sheets'] : [])] });
for (const e of EPISODES) cases.push({ id: `static-math-${tag(e)}`, group: 'static', what: 'static, common Math', flags: [...ep(e), '--steps=0', '--static', '--common-math'] });
for (const e of EPISODES) cases.push({ id: `static-equal-${tag(e)}`, group: 'static', what: 'static, equal', flags: [...ep(e), '--steps=0', '--static', ...EQUAL] });
// Stages 2 and 3 in the configuration where equality is expected: whole scripted episodes, dialogs answered.
for (const e of EPISODES) cases.push({ id: `equal-walk-${tag(e)}`, group: 'equal', what: 'walk, equal', flags: [...ep(e), `--steps=${FULL}`, '--script=walk', ...EQUAL] });
cases.push({ id: `equal-idle-${tag(EPISODES[0])}`, group: 'equal', what: 'idle, equal', flags: [...ep(EPISODES[0]), `--steps=${FULL}`, '--script=idle', ...EQUAL] });
cases.push({ id: `equal-idle-${tag(EPISODES[3])}`, group: 'equal', what: 'idle, equal', flags: [...ep(EPISODES[3]), `--steps=${FULL}`, '--script=idle', ...EQUAL] });
cases.push({ id: `equal-dance-${tag(EPISODES[1])}`, group: 'equal', what: 'dance, equal', flags: [...ep(EPISODES[1]), `--steps=${FULL}`, '--script=dance', ...EQUAL] });
cases.push({ id: `equal-dance-${tag(EPISODES[4])}`, group: 'equal', what: 'dance, equal', flags: [...ep(EPISODES[4]), `--steps=${FULL}`, '--script=dance', ...EQUAL] });
// A player that walks to map points and uses them, and fires its ultimate: interact (E) and ultimate (R).
for (const e of [EPISODES[0], EPISODES[2], EPISODES[3], EPISODES[4]]) cases.push({ id: `equal-seek-${tag(e)}`, group: 'equal', what: 'seek (uses map points), equal', flags: [...ep(e), `--steps=${FULL}`, '--script=seek', ...EQUAL] });
// The other way round (the draft's configuration): the headless side patched in memory so that models load on both sides.
for (const e of [EPISODES[0], EPISODES[3]]) cases.push({ id: `models-walk-${tag(e)}`, group: 'models', what: 'walk, headless with the three rejected shim patches, models on both sides', flags: [...ep(e), `--steps=${FULL}`, '--script=walk', '--common-math', PATCHES, '--browser-as-shim=uuid', '--warm-sheets'] });
cases.push({ id: `models-seek-${tag(EPISODES[0])}`, group: 'models', what: 'seek (uses map points), models on both sides', flags: [...ep(EPISODES[0]), `--steps=${FULL}`, '--script=seek', '--common-math', PATCHES, '--browser-as-shim=uuid', '--warm-sheets'] });
// The environment as it is against the browser as it is.
for (const e of EPISODES) cases.push({ id: `asis-walk-${tag(e)}`, group: 'asis', what: 'walk, as is', flags: [...ep(e), '--steps=3600', '--script=walk'] });
cases.push({ id: `asis-idle-${tag(EPISODES[0])}`, group: 'asis', what: 'idle, as is', flags: [...ep(EPISODES[0]), '--steps=3600', '--script=idle'] });
cases.push({ id: `asis-idle-${tag(EPISODES[3])}`, group: 'asis', what: 'idle, as is', flags: [...ep(EPISODES[3]), '--steps=3600', '--script=idle'] });
// One cause at a time.
for (const e of [EPISODES[0], EPISODES[3]]) cases.push({ id: `math-walk-${tag(e)}`, group: 'math', what: 'walk, common Math only', flags: [...ep(e), '--steps=3600', '--script=walk', '--common-math'] });
for (const e of EPISODES) cases.push({ id: `shims-walk-${tag(e)}`, group: 'shims', what: 'walk, equal except the Math (each engine its own)', flags: [...ep(e), `--steps=${LONG}`, '--script=walk', AS_SHIM, '--warm-sheets'] });
for (const e of [EPISODES[0], EPISODES[3]]) cases.push({ id: `timing-walk-${tag(e)}`, group: 'timing', what: 'walk, equal except the sheet cache (cold in the browser)', flags: [...ep(e), `--steps=${FULL}`, '--script=walk', '--common-math', AS_SHIM] });
for (const e of [EPISODES[0], EPISODES[3]]) {
  cases.push({ id: `single-models-${tag(e)}`, group: 'single', what: 'walk, equal except D2 (the browser loads its models)', flags: [...ep(e), '--steps=3600', '--script=walk', '--common-math', '--browser-as-shim=audio-clock,uuid', '--warm-sheets'] });
  cases.push({ id: `single-audio-${tag(e)}`, group: 'single', what: 'walk, equal except D3 (the browser\'s suspended audio clock stands still)', flags: [...ep(e), '--steps=3600', '--script=walk', '--common-math', '--browser-as-shim=request,uuid', '--warm-sheets'] });
  cases.push({ id: `single-uuid-${tag(e)}`, group: 'single', what: 'walk, equal except D10 (three.js in the browser draws its UUIDs from Math.random)', flags: [...ep(e), `--steps=${FULL}`, '--script=walk', '--common-math', '--browser-as-shim=request,audio-clock', '--warm-sheets'] });
}
// Variants of the equal configuration on one episode.
const V = [...ep(EPISODES[0]), '--script=walk', ...EQUAL];
cases.push({ id: 'variant-first-dialog', group: 'variants', what: 'stop at the first dialog', flags: [...V, '--steps=20000', '--stop-at-dialog'] });
cases.push({ id: 'variant-native-hud', group: 'variants', what: 'browser keeps the game\'s own HUD dialogs', flags: [...V, '--steps=20000', '--native-hud'] });
cases.push({ id: 'variant-render', group: 'variants', what: 'browser draws every step (real WebGL)', flags: [...V, '--steps=6000', '--render=1'] });
cases.push({ id: 'variant-no-align', group: 'variants', what: 'page clock not equalised after boot', flags: [...V, '--steps=3600', '--no-align'] });
cases.push({ id: 'variant-browser-twice', group: 'variants', what: 'browser against browser', flags: [...V, '--steps=6000', '--browser-twice'] });

/**
 * sha256 of the profile a side adopted at reset, without the hunt counters (they are the episode seed): the same value
 * in every case of a suite means the preset did not change while the suite ran.
 */
function adoptedProfile(file: string): { sha: string; hunt: unknown } | null {
  if (!existsSync(file)) return null;
  const replies = (JSON.parse(readFileSync(file, 'utf8')) as { unlockReplies: { profile: Record<string, unknown> }[] }).unlockReplies;
  if (!replies?.length) return null;
  const { hunt, ...rest } = replies[replies.length - 1].profile;
  return { sha: createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 16), hunt };
}

const only = args.get('only')?.split(',');
const outDir = resolve(REPO, 'data', 'fidelity', 'suite');
mkdirSync(outDir, { recursive: true });
const rows: Record<string, unknown>[] = [];
for (const c of cases) {
  const picked = !only || only.includes(c.group) || only.includes(c.id);
  const file = join(outDir, c.id, 'comparison.json');
  if (picked && !args.has('table') && !(args.has('skip-done') && existsSync(file))) {
    say(`\n=== ${c.id}: ${c.what}`);
    const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'fidelity', 'compare.ts'), ...c.flags, `--name=suite/${c.id}`, ...(args.has('profile') ? [`--profile=${args.get('profile')}`] : [])], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 3_600_000, maxBuffer: 64 * 1024 * 1024 });
    const lines = (r.stdout ?? '').split('\n').filter((l) => !/ExperimentalWarning|trace-warnings|mock-api/.test(l));
    say(lines.slice(0, 16).map((l) => l.slice(0, 240)).join('\n'));
    if (r.status !== 0) say(`  FAILED (exit ${r.status}): ${(r.stderr ?? '').slice(-1500)}`);
  }
  // The table always lists every case that has a result (a second suite process may be running other groups).
  if (!existsSync(file)) { if (picked) rows.push({ id: c.id, group: c.group, what: c.what, failed: true, attempted: !args.has('table') }); continue; }
  const j = JSON.parse(readFileSync(file, 'utf8'));
  const t = j.comparison.trajectory, v = j.comparison.behaviour, tw = j.browserTwice?.trajectory, wc = j.comparison.trajectoryWithoutClock;
  rows.push({
    id: c.id, group: c.group, what: c.what, flags: c.flags.join(' '),
    seed: j.options.seed, map: j.options.map, species: j.options.species, tier: j.options.tier, script: j.options.script,
    stepsHeadless: j.steps.headless, stepsBrowser: j.steps.browser, stopHeadless: j.steps.stopHeadless, stopBrowser: j.steps.stopBrowser,
    identical: t.identical, identicalSteps: t.identicalSteps, firstDifference: t.firstDifference, differingColumns: Object.keys(t.columns), fields: t.fields.length, fieldSample: t.fields.slice(0, 8),
    withoutClock: { identical: wc.identical, identicalSteps: wc.identicalSteps, firstDifference: wc.firstDifference, differingColumns: Object.keys(wc.columns) },
    firstDiscreteDifference: v.firstDiscreteDifference, discrete: v.discrete, positionGap: v.positionGap, maxContinuous: v.maxContinuous,
    dialogs: [j.comparison.decisions.headless, j.comparison.decisions.browser, j.comparison.decisions.differences.length],
    actionsIdentical: j.comparison.actions.identical, apiDifferences: j.comparison.api.differences.length, api: [j.comparison.api.headless, j.comparison.api.browser],
    static: j.comparison.static ? [j.comparison.static.compared, j.comparison.static.differences.length] : null,
    staticDifferences: j.comparison.static ? j.comparison.static.differences.map((d: { path: string }) => d.path) : null,
    sheets: j.comparison.sheets ? [j.comparison.sheets.compared, j.comparison.sheets.differences.length, j.comparison.sheets.notReady.length] : null,
    storage: j.comparison.storage.length, chunks: j.comparison.chunks.length, end: j.comparison.end.length, endDifferences: j.comparison.end, endHow: j.steps.end?.how ?? null,
    autosave: j.comparison.autosave ? [j.comparison.autosave.values, j.comparison.autosave.differences.length, j.comparison.autosave.headless] : null,
    autosaveDifferences: j.comparison.autosave ? j.comparison.autosave.differences.map((d: { path: string }) => d.path).slice(0, 12) : null,
    audio: j.comparison.audio.length, marks: j.marks,
    last: j.steps.last, lastBrowser: j.steps.lastBrowser ?? null, browserTwice: tw ? { identical: tw.identical, identicalSteps: tw.identicalSteps } : null,
    preset: j.preset, profileSha: j.profileSha, account: j.account,
    adopted: { headless: adoptedProfile(join(outDir, c.id, 'headless.json')), browser: adoptedProfile(join(outDir, c.id, 'browser.json')) }, models: j.models, requestThrows: j.requestThrows, sheetsDuringPlay: j.sheetsDuringPlay,
    sheetCache: j.browserFacts?.sheetCache, warmSheets: j.browserFacts?.warmSheets,
    browserFrames: j.browserFacts?.frames, notes: j.browserFacts?.notes, engines: j.engines, timing: j.timing,
  });
}
writeFileSync(join(outDir, 'results.json'), JSON.stringify(rows, null, 1));

const md: string[] = ['| Case | Episode | Steps (headless / browser), stop | Bit-identical steps | First difference | Discrete values equal until | Dialogs (h / b) | End-of-run record |', '|---|---|---|---|---|---|---|---|'];
for (const r of rows as any[]) {
  if (r.failed) { md.push(`| ${r.id} | | ${r.attempted ? 'FAILED' : 'no result'} | | | | | |`); continue; }
  if (r.group === 'static') continue; // stage 1 has its own table below
  const epi = `${r.map}, #${r.species}, tier ${r.tier}, seed ${r.seed}, ${r.script}`;
  const first = r.firstDifference < 0 ? '—' : `step ${r.firstDifference}: ${r.differingColumns.join(', ')}`;
  const disc = r.stepsHeadless === 0 ? '—' : r.firstDiscreteDifference < 0 ? `the end (${Math.min(r.stepsHeadless, r.stepsBrowser)})` : `step ${r.firstDiscreteDifference - 1} (then ${Object.keys(r.discrete).join(', ')})`;
  const end = r.stopHeadless !== 'run over' || r.stopBrowser !== 'run over' ? '—' : r.end === 0 ? `identical (${r.endHow})` : `${r.end} field(s) differ: ${r.endDifferences.map((d: { path: string }) => d.path).slice(0, 4).join(', ')}`;
  md.push(`| ${r.id} | ${epi} | ${r.stepsHeadless} / ${r.stepsBrowser} (${r.stopHeadless}) | ${r.identical ? 'all ' + r.stepsHeadless : r.identicalSteps} | ${first} | ${disc} | ${r.dialogs[0]} / ${r.dialogs[1]}${r.dialogs[2] ? ' (differ)' : ''} | ${end} |`);
}
// Stage 1 has its own table: what was compared right after the reset.
const st: string[] = ['| Case | Episode | Static values compared | Differ | Which | Map points | Sprite sheets (measured / differ) | API calls (h / b), differ | Storage, chunks |', '|---|---|---|---|---|---|---|---|---|'];
for (const r of rows as any[]) {
  if (r.failed || !r.static) continue;
  const where = new Map<string, number>();
  for (const p of r.staticDifferences as string[]) { const k = p.replace(/\[\d+\]/g, '[]').replace(/\[\]\[\]$/, '[]'); where.set(k, (where.get(k) ?? 0) + 1); }
  const which = [...where].map(([k, n]) => `${n} × ${k}`).join(', ') || '—';
  st.push(`| ${r.id} | ${r.map}, #${r.species}, tier ${r.tier}, seed ${r.seed} | ${r.static[0]} | ${r.static[1]} | ${which} | ${r.models?.headless?.atReset?.points ?? '?'} | ${r.sheets ? `${r.sheets[0]} / ${r.sheets[1]}${r.sheets[2] ? ` (${r.sheets[2]} not ready)` : ''}` : '—'} | ${r.api[0]} / ${r.api[1]}, ${r.apiDifferences} | ${r.storage === 0 && r.chunks === 0 ? 'identical' : `${r.storage} / ${r.chunks} differ`} |`);
}
const done = (rows as any[]).filter((r) => !r.failed);
const shas = new Set(done.flatMap((r) => [r.adopted?.headless?.sha, r.adopted?.browser?.sha]));
const facts = [
  `Cases with a result: ${done.length}. Profile preset: ${[...new Set(done.map((r) => r.preset))].join(', ')}; sha256 (first 16 hex) of the adopted profile without the hunt counters, over both sides of all cases: ${[...shas].join(', ')}${shas.size === 1 ? ' (one value: every case, both sides, the same profile)' : ' (MORE THAN ONE VALUE: the preset changed while the suite ran, or the sides differ)'}.`,
  `Account id: ${[...new Set(done.map((r) => r.account))].join(', ')}. Engines: ${[...new Set(done.map((r) => `${r.engines?.headless?.node} (V8 ${r.engines?.headless?.v8}) / ${r.engines?.browser?.browser} (V8 ${r.engines?.browser?.v8})`))].join('; ')}.`,
];
writeFileSync(join(outDir, 'results.md'), md.join('\n') + '\n\n' + st.join('\n') + '\n\n' + facts.join('\n') + '\n');
say('\n' + md.join('\n') + '\n\n' + st.join('\n') + '\n\n' + facts.join('\n'));
process.exit(0);
