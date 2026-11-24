import { createHash } from 'node:crypto';
import { digestColumns } from './shared.ts';
import type { SideResult } from './types.ts';

/** Comparison of the two sides' results. Everything here is exact: values are equal or they are listed. */

/**
 * Short hash of an API reply for the transcript. Left out because they cannot be equal by construction: the server
 * time (`now`), and the ticket's `id` and `seed`, which the mock draws at random and the fetch layer replaces.
 */
export function replySha(method: string, url: string, json: unknown): string {
  let v = json;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = { ...(v as Record<string, unknown>) };
    delete o.now;
    if (method === 'POST' && url === '/runs') { delete o.id; delete o.seed; }
    v = o;
  }
  return createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 16);
}

export interface Difference { path: string; headless: unknown; browser: unknown }

/** Every leaf where two JSON values differ (paths in dot notation), up to `limit`. */
export function diffJson(a: unknown, b: unknown, path = '', out: Difference[] = [], limit = 400): Difference[] {
  if (out.length >= limit) return out;
  if (a === b) return out;
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path: path || '(root)', headless: a, browser: b });
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push({ path: path + '.length', headless: a.length, browser: b.length });
    for (let i = 0; i < Math.min(a.length, b.length); i++) diffJson(a[i], b[i], `${path}[${i}]`, out, limit);
    return out;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffJson(a[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k, out, limit);
  return out;
}

/** Number of leaf values in a JSON value (how much was compared). */
export function countLeaves(v: unknown): number {
  if (!v || typeof v !== 'object') return 1;
  let n = 0;
  for (const x of Array.isArray(v) ? v : Object.values(v)) n += countLeaves(x);
  return n;
}

export interface TrajectoryComparison {
  stepsHeadless: number;
  stepsBrowser: number;
  /** Simulation steps (digest lines after line 0) that are identical on both sides from the start. */
  identicalSteps: number;
  identical: boolean;
  /** Index of the first differing digest line, or -1. */
  firstDifference: number;
  /** Which columns of that line differ: name → [headless, browser]. */
  columns: Record<string, [unknown, unknown]>;
  /** Field-level differences at the first differing line, when both sides recorded details for it. */
  fields: Difference[];
  /** Field-level differences on the line before (should be empty: it shows the line before really was identical). */
  fieldsBefore: Difference[] | null;
  stopHeadless: string;
  stopBrowser: string;
}

const columnName = (i: number, cell: unknown): string => { const names = digestColumns(); return i < names.length ? names[i] : String(cell).split('=')[0]; };

export function compareTrajectories(h: SideResult, b: SideResult, ignoreColumns: string[] = []): TrajectoryComparison {
  const n = Math.min(h.lines.length, b.lines.length);
  const names = digestColumns();
  const skip = new Set(ignoreColumns);
  const same = (x: unknown[], y: unknown[]) => {
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) { if (skip.has(columnName(i, x[i]))) continue; if (x[i] !== y[i] && !(typeof x[i] === 'number' && typeof y[i] === 'number' && Number.isNaN(x[i]) && Number.isNaN(y[i]))) return false; }
    return true;
  };
  let first = -1;
  for (let i = 0; i < n; i++) if (!same(h.lines[i], b.lines[i])) { first = i; break; }
  const columns: Record<string, [unknown, unknown]> = {};
  let fields: Difference[] = [], fieldsBefore: Difference[] | null = null;
  if (first >= 0) {
    const x = h.lines[first], y = b.lines[first];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) columns[i < names.length ? names[i] : String(x[i] ?? y[i]).split('=')[0]] = [x[i], y[i]];
    if (h.details[first] && b.details[first]) fields = diffJson(h.details[first], b.details[first]);
    if (first > 0 && h.details[first - 1] && b.details[first - 1]) fieldsBefore = diffJson(h.details[first - 1], b.details[first - 1]);
  }
  const identicalSteps = (first < 0 ? n : first) - 1;
  return {
    stepsHeadless: h.lines.length - 1, stepsBrowser: b.lines.length - 1, identicalSteps: Math.max(0, identicalSteps),
    identical: first < 0 && h.lines.length === b.lines.length, firstDifference: first, columns, fields, fieldsBefore, stopHeadless: h.stop, stopBrowser: b.stop,
  };
}

/**
 * The comparison a bit-exact digest cannot give once two engines round differently: are the same THINGS happening?
 * Discrete columns (state, level, KOs, enemy counts, number of random draws, generator state, open dialog) must be
 * equal; continuous ones (clock, position, HP, XP) are reported as the largest difference seen.
 */
export interface BehaviourComparison {
  stepsCompared: number;
  /** First digest line where a discrete column differs, or -1. */
  firstDiscreteDifference: number;
  discrete: Record<string, [unknown, unknown]>;
  /** Largest absolute difference of each continuous column over the lines before that one. */
  maxContinuous: Record<string, number>;
  /** Position difference (metres) at a few steps, to show how it grows. */
  positionGap: [number, number][];
}

const DISCRETE = ['state', 'stage', 'level', 'kills', 'enemySlots', 'enemiesAlive', 'mathRandomCalls', 'cryptoCalls', 'gameRngState', 'pendingDialog'];
const CONTINUOUS = ['time', 'stageTime', 'x', 'y', 'z', 'hp', 'xp'];

export function compareBehaviour(h: SideResult, b: SideResult): BehaviourComparison {
  const names = digestColumns(), n = Math.min(h.lines.length, b.lines.length);
  const idx = (name: string) => names.indexOf(name);
  let first = -1;
  const discrete: Record<string, [unknown, unknown]> = {};
  for (let i = 0; i < n && first < 0; i++) for (const c of DISCRETE) if (h.lines[i][idx(c)] !== b.lines[i][idx(c)]) { first = i; discrete[c] = [h.lines[i][idx(c)], b.lines[i][idx(c)]]; }
  const end = first < 0 ? n : first;
  const maxContinuous: Record<string, number> = {};
  for (const c of CONTINUOUS) { let m = 0; for (let i = 0; i < end; i++) { const d = Math.abs((h.lines[i][idx(c)] as number) - (b.lines[i][idx(c)] as number)); if (d > m) m = d; } maxContinuous[c] = m; }
  const gap = (i: number) => Math.hypot(...['x', 'y', 'z'].map((c) => (h.lines[i][idx(c)] as number) - (b.lines[i][idx(c)] as number)));
  const positionGap: [number, number][] = [];
  for (const i of [60, 300, 600, 1200, 1800, 3600, 5400, 7200, 10800, 14400, n - 1]) if (i > 0 && i < n && !positionGap.some((p) => p[0] === i)) positionGap.push([i, gap(i)]);
  return { stepsCompared: n - 1, firstDiscreteDifference: first, discrete, maxContinuous, positionGap };
}

export interface SideComparison {
  trajectory: TrajectoryComparison;
  behaviour: BehaviourComparison;
  /** Same trajectory comparison with the page-clock stamps left out (group `runClock`). */
  trajectoryWithoutClock: TrajectoryComparison;
  actions: { identical: boolean; firstDifference: number; headless?: unknown; browser?: unknown };
  decisions: { headless: number; browser: number; differences: Difference[] };
  marks: Difference[];
  api: { headless: number; browser: number; differences: Difference[] };
  static: { compared: number; differences: Difference[] } | null;
  sheets: { compared: number; differences: Difference[]; notReady: unknown[] } | null;
  storage: Difference[];
  chunks: Difference[];
  season: Difference[];
  registrySources: Difference[];
  end: Difference[];
  audio: Difference[];
  /**
   * The game's own autosave of the run (localStorage `pb.runauto.<account>`, written by the game once a minute of run
   * time): its serialisation of the run, the player, every enemy and pickup, the director and its generators. A second
   * state comparison, in the game's own terms, independent of the digest in shared.ts.
   */
  autosave: { headless: number; browser: number; values: number; differences: Difference[] } | null;
}

export function compareSides(h: SideResult, b: SideResult): SideComparison {
  const acts = Math.min(h.actions.length, b.actions.length);
  let firstAct = -1;
  for (let i = 0; i < acts; i++) if (h.actions[i][0] !== b.actions[i][0] || h.actions[i][1] !== b.actions[i][1]) { firstAct = i; break; }
  if (firstAct < 0 && h.actions.length !== b.actions.length) firstAct = acts;
  // The headless side creates its account with one call of its own (POST /auth/guest) before the game exists; the browser side is handed that account.
  // The run id in a path is the mock's own random one (the game sees the pinned id; the fetch layer translates).
  const apiKey = (r: SideResult) => r.api.filter((c) => c.url !== '/auth/guest').map((c) => ({ call: `${c.method} ${c.url.replace(/\/runs\/[0-9a-f]{16,}/, '/runs/:id')}`, body: c.body, status: c.status, replySha: c.replySha, client: c.client, device: c.device, clock: c.clock }));
  const sortPairs = (s: [string, string][]) => Object.fromEntries([...s].sort((x, y) => (x[0] < y[0] ? -1 : 1)));
  const autosaveOf = (r: SideResult): { text: string; json: unknown } | null => {
    for (const [k, v] of r.storageEnd ?? []) {
      if (!k.startsWith('pb.runauto.') || k.includes('.ack.')) continue;
      try { const text = (JSON.parse(v) as { save?: string }).save; if (typeof text === 'string') return { text, json: JSON.parse(text) }; } catch { /* not a save */ }
    }
    return null;
  };
  const sh = autosaveOf(h), sb = autosaveOf(b);
  const byId = (list: unknown[] | null) => Object.fromEntries((list ?? []).map((s) => [String((s as { id: number }).id), s]));
  return {
    trajectory: compareTrajectories(h, b),
    behaviour: compareBehaviour(h, b),
    trajectoryWithoutClock: compareTrajectories(h, b, ['runClock']),
    actions: firstAct < 0 ? { identical: true, firstDifference: -1 } : { identical: false, firstDifference: firstAct, headless: h.actions[firstAct], browser: b.actions[firstAct] },
    decisions: { headless: h.decisions.length, browser: b.decisions.length, differences: diffJson(h.decisions.slice(0, Math.min(h.decisions.length, b.decisions.length)), b.decisions.slice(0, Math.min(h.decisions.length, b.decisions.length))) },
    marks: diffJson(h.marks, b.marks),
    api: { headless: h.api.length, browser: b.api.length, differences: diffJson(apiKey(h), apiKey(b)) },
    static: h.static && b.static ? { compared: countLeaves(h.static), differences: diffJson(h.static, b.static) } : null,
    sheets: h.sheets && b.sheets ? { compared: h.sheets.length, differences: diffJson(byId(h.sheets), byId(b.sheets)), notReady: [...h.sheets, ...b.sheets].filter((s) => (s as { notReady?: boolean }).notReady) } : null,
    storage: diffJson(sortPairs(h.storage), sortPairs(b.storage)),
    chunks: diffJson(h.chunks, b.chunks),
    season: diffJson(h.season, b.season),
    registrySources: diffJson(h.registrySources, b.registrySources),
    end: diffJson(h.end, b.end),
    audio: diffJson(h.audio ?? null, b.audio ?? null),
    autosave: sh && sb ? { headless: sh.text.length, browser: sb.text.length, values: countLeaves(sh.json), differences: diffJson(sh.json, sb.json) } : null,
  };
}

const short = (v: unknown) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s === undefined ? 'undefined' : s.length > 110 ? s.slice(0, 107) + '…' : s; };

/** A readable summary of a comparison, for the terminal and for the result folder. */
export function describe(c: SideComparison, title: string): string {
  const out: string[] = [title];
  const list = (name: string, d: Difference[], max = 12) => {
    out.push(`  ${name}: ${d.length ? `${d.length} difference(s)` : 'identical'}`);
    for (const x of d.slice(0, max)) out.push(`      ${x.path}: headless ${short(x.headless)} | browser ${short(x.browser)}`);
    if (d.length > max) out.push(`      … ${d.length - max} more`);
  };
  const traj = (name: string, t: TrajectoryComparison) => {
    if (t.stepsHeadless + t.stepsBrowser === 0) return;
    if (t.identical) { out.push(`  ${name}: IDENTICAL for all ${t.stepsHeadless} simulation steps (headless stopped: ${t.stopHeadless}; browser stopped: ${t.stopBrowser})`); return; }
    if (t.firstDifference < 0) { out.push(`  ${name}: identical for the ${t.identicalSteps} steps both sides ran, but the lengths differ (headless ${t.stepsHeadless}: ${t.stopHeadless}; browser ${t.stepsBrowser}: ${t.stopBrowser})`); return; }
    out.push(`  ${name}: identical for ${t.identicalSteps} steps, FIRST DIFFERENCE at step ${t.firstDifference} (headless ran ${t.stepsHeadless}, browser ${t.stepsBrowser})`);
    for (const [k, [x, y]] of Object.entries(t.columns)) out.push(`      ${k}: headless ${short(x)} | browser ${short(y)}`);
    if (t.fieldsBefore) out.push(`      fields at step ${t.firstDifference - 1}: ${t.fieldsBefore.length ? t.fieldsBefore.length + ' differ' : 'all identical'}`);
    if (t.fields.length) { out.push(`      fields at step ${t.firstDifference}: ${t.fields.length} differ`); for (const x of t.fields.slice(0, 40)) out.push(`        ${x.path}: headless ${short(x.headless)} | browser ${short(x.browser)}`); }
  };
  traj('trajectory', c.trajectory);
  if (!c.trajectory.identical) traj('trajectory without page-clock stamps', c.trajectoryWithoutClock);
  if (!c.trajectory.identical && c.behaviour.stepsCompared > 0) {
    const v = c.behaviour;
    out.push(v.firstDiscreteDifference < 0
      ? `  behaviour: every discrete value (state, level, KOs, enemy counts, random draws, generator state, dialog) is equal for all ${v.stepsCompared} steps`
      : `  behaviour: discrete values equal for ${v.firstDiscreteDifference - 1} steps; first discrete difference at step ${v.firstDiscreteDifference}: ${Object.entries(v.discrete).map(([k, [x, y]]) => `${k} headless ${short(x)} | browser ${short(y)}`).join('; ')}`);
    out.push(`      largest continuous differences before that: ${Object.entries(v.maxContinuous).map(([k, d]) => `${k} ${d === 0 ? '0' : d.toExponential(2)}`).join(', ')}`);
    out.push(`      position gap in metres at step: ${v.positionGap.map(([i, d]) => `${i}: ${d === 0 ? '0' : d.toExponential(2)}`).join(', ')}`);
  }
  out.push(`  actions sent: ${c.actions.identical ? 'identical' : `differ from #${c.actions.firstDifference}: headless ${short(c.actions.headless)} | browser ${short(c.actions.browser)}`}`);
  list(`dialogs raised (headless ${c.decisions.headless}, browser ${c.decisions.browser})`, c.decisions.differences);
  list('reseed points and call counts before each (marks)', c.marks);
  list(`API calls (headless ${c.api.headless}, browser ${c.api.browser})`, c.api.differences);
  if (c.static) list(`static state (${c.static.compared} values)`, c.static.differences, 40);
  if (c.sheets) { list(`sprite sheets measured (${c.sheets.compared})`, c.sheets.differences, 40); if (c.sheets.notReady.length) out.push(`      not ready: ${short(c.sheets.notReady)}`); }
  list('localStorage after reset', c.storage);
  list('script chunks loaded, in order', c.chunks);
  list('season reported by the mock', c.season);
  list('registry sources', c.registrySources);
  list('end-of-run record', c.end, 30);
  list('sound object after the episode', c.audio, 20);
  if (c.autosave) list(`the game's own autosave of the run (${c.autosave.values} values, ${c.autosave.headless} characters)`, c.autosave.differences, 20);
  return out.join('\n');
}
