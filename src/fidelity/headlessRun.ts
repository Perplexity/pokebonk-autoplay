/**
 * Headless side of the fidelity comparison: one episode in the real training environment (`createEnvironment`), with
 * a state digest taken after every simulation step.
 *
 * Run as a child process (one environment per Node process, and the offline guard would also block the debugger
 * connection the browser side needs):
 *
 *   node src/fidelity/headlessRun.ts <options.json> <result.json>
 *
 * Nothing in src/sim or src/environment is changed. What this file adds, in this process only, to be able to look:
 *   - `VirtualClock.prototype.frame` counts display frames;
 *   - `MockApi.prototype.handle` records every API call and its reply (the reply of POST /dev/unlock is handed to the
 *     browser side so both sides adopt the identical profile);
 *   - `Sim.boot` is wrapped to put a recorder around `sim.step` and `sim.entropy.reseed` on the instance;
 *   - the global `Request` is put behind a proxy that notes every construction that throws, and throws it on.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createEnvironment } from '../environment/index.ts';
import type { Action, ChoiceMask, PlayMask, StepResult } from '../environment/index.ts';
import { Sim } from '../sim/env.ts';
import { VirtualClock, real } from '../sim/clock.ts';
import { MockApi } from '../sandbox/mockApi.ts';
import { Net, PAGE_URL } from '../sim/net.ts';
import { installCommonMath } from './commonMath.ts';
import { audioFacts, callSite, modelFacts, platformFacts, playMask, seekAction, scriptAction, scriptAnswer, sheetMeasure, staticDump, stepDigest } from './shared.ts';
import { replySha } from './compare.ts';
import type { ApiCall, EpisodeOptions, Mark, SideResult } from './types.ts';

const [optFile, outFile] = process.argv.slice(2);
if (!optFile || !outFile) { process.stderr.write('usage: node src/fidelity/headlessRun.ts <options.json> <result.json>\n'); process.exit(64); }
const opt = JSON.parse(readFileSync(optFile, 'utf8')) as EpisodeOptions;

// Only for the comparison, and only when asked: both sides compute sin, exp, atan2 … with the same code.
const commonMath = opt.commonMath ? installCommonMath(Math) : [];

// Call-site trace of Math.random: an accessor on Math, set before the environment installs its seeded generator, so
// that the tracer sits in front of whatever function is assigned to Math.random later.
const trace: Record<number, string[]> = {};
let tracing: string[] | null = null;
if (opt.trace) {
  // The game swaps Math.random for a seeded function while it generates things, then puts back what it had read:
  // the tracer. So an assignment of the tracer means "restore the previous one", anything else "replace".
  let inner = Math.random;
  const stack: (() => number)[] = [];
  const traced = () => { if (tracing) tracing.push(callSite(1, 4)); return inner(); };
  Object.defineProperty(Math, 'random', { configurable: true, enumerable: false, get: () => traced, set: (f: () => number) => { if (f === traced) inner = stack.pop() ?? inner; else { stack.push(inner); inner = f; } } });
}

// PROPOSED SHIM PATCHES, applied in this process only so that their effect can be measured before anyone edits
// src/sim. Each one is a few lines that would go into src/sim/browser.ts; docs/fidelity.md has the patch text.
//
// The hook: `installBrowser` ends with `clock.install(globalThis)`, a prototype method. Wrapping it runs code after
// every shim is in place and before the game is loaded.
const shimPatches: string[] = [];
/** `new Request(...)` calls that threw: under the shims that is every file three.js tries to load (docs/fidelity.md D2). */
const requestThrows = { count: 0, first: [] as string[] };
{
  const want = new Set(opt.shimPatches ?? []);
  const nativeAbort = { AbortController: globalThis.AbortController, AbortSignal: globalThis.AbortSignal };
  const install = VirtualClock.prototype.install;
  VirtualClock.prototype.install = function (this: VirtualClock, g: any = globalThis) {
    install.call(this, g);
    const def = (k: string, v: unknown) => Object.defineProperty(g, k, { value: v, writable: true, configurable: true, enumerable: true });
    if (want.has('native-abort')) {
      // The DOM library replaces AbortController / AbortSignal with its own classes, but `Request` stays Node's, and
      // Node's Request refuses a signal that is not its own AbortSignal. three.js builds exactly such a Request for
      // every file it loads. The patch keeps Node's two classes, like the other platform classes browser.ts keeps.
      for (const [k, v] of Object.entries(nativeAbort)) def(k, v);
      shimPatches.push('native-abort: AbortController and AbortSignal stay Node\'s own classes');
    }
    if (want.has('request-base')) {
      // Node's Request has no document to resolve a relative URL against and throws "Failed to parse URL". The game
      // hands three.js relative URLs (./assets/models/x.glb). The patch resolves them against the page URL.
      const NativeRequest = g.Request as typeof Request;
      def('Request', class extends NativeRequest { constructor(input: RequestInfo | URL, init?: RequestInit) { super(typeof input === 'string' ? new URL(input, PAGE_URL).href : input, init); } });
      shimPatches.push('request-base: `new Request(relativeUrl)` resolves against the page URL');
    }
    if (want.has('audio-clock')) {
      // The shim's audio context says "suspended" but its `currentTime` follows the page clock. A suspended context
      // in a browser has a clock that stands still. The game's sound code rate-limits each move's sound by that
      // clock, and draws from Math.random when the limiter lets a sound through. The patch freezes the clock at 0.
      const Shim = g.AudioContext as new (...a: unknown[]) => object;
      const Frozen = function (...a: unknown[]) {
        const ctx = new Shim(...a);
        Object.defineProperty(ctx, 'currentTime', { get: () => 0, configurable: true });
        Object.defineProperty(ctx, 'getOutputTimestamp', { value: () => ({ contextTime: 0, performanceTime: this_clock.now }), configurable: true, writable: true });
        return ctx;
      };
      const this_clock = this;
      def('AudioContext', Frozen); def('webkitAudioContext', Frozen);
      shimPatches.push('audio-clock: the suspended audio context\'s currentTime stays 0, as in a browser');
    }
    // Observation only, after any patch: which Request constructions throw. The error is thrown on unchanged.
    const Inner = g.Request;
    def('Request', new Proxy(Inner, {
      construct(target: any, args: unknown[]) {
        try { return Reflect.construct(target, args); }
        catch (e) { requestThrows.count++; if (requestThrows.first.length < 40) requestThrows.first.push(`${String(args[0]).slice(0, 90)} → ${String((e as Error)?.message).slice(0, 110)}`); throw e; }
      },
    }));
  };
}

// Files the page asks for once play has begun (sprite sheets, HUD images, models, sounds).
let playing = false;
const assetsDuringPlay: string[] = [];
const fileFor = Net.prototype.fileFor;
Net.prototype.fileFor = function (this: Net, url: URL) { if (playing) assetsDuringPlay.push(`${lines.length - 1} ${url.pathname}`); return fileFor.call(this, url); };

let frames = 0;
const frame = VirtualClock.prototype.frame;
VirtualClock.prototype.frame = function (this: VirtualClock) { frames++; return frame.call(this); };

let sim: Sim | null = null;
const api: ApiCall[] = [];
const unlockReplies: unknown[] = [];
let bootProfile: Record<string, unknown> | null = null;
const handle = MockApi.prototype.handle;
MockApi.prototype.handle = async function (this: MockApi, method: string, url: string, headers: Record<string, string | undefined>, body: unknown) {
  const at = { frame: frames, clock: Math.floor(sim?.clock.now ?? 0), simStep: lines.length ? lines.length - 1 : -1 };
  const r = await handle.call(this, method, url, headers, body);
  if (method === 'POST' && url.startsWith('/dev/unlock') && r.status === 200) unlockReplies.push(structuredClone(r.json));
  if (method === 'GET' && url === '/profile' && r.status === 200 && !bootProfile) bootProfile = structuredClone((r.json as { profile: Record<string, unknown> }).profile);
  api.push({ ...at, method, url, body: body ?? null, status: r.status, replySha: replySha(method, url, r.json), client: headers['x-client'] ?? null, device: headers['x-device'] ?? null });
  return r;
};

const marks: Mark[] = [];
const lines: unknown[][] = [];
const details: Record<number, Record<string, Record<string, unknown>>> = {};
let rng: { s: number } | null = null;
let pendingOf: () => string | null = () => null;

const record = () => {
  const s = sim!, i = lines.length;
  const wantDetail = !!opt.detail && i >= opt.detail[0] && i <= opt.detail[1];
  const d = stepDigest(s.run, { i, math: s.entropy.mathCalls(), crypto: s.entropy.cryptoCalls(), rngS: rng ? rng.s : 0, pending: pendingOf(), detail: wantDetail });
  lines.push(d.line);
  if (d.groups) details[i] = d.groups;
};

const boot = Sim.boot;
Sim.boot = async (o) => {
  const s = await boot.call(Sim, o);
  sim = s;
  marks.push({ kind: 'booted', frames, clock: s.clock.now, math: s.entropy.mathCalls(), crypto: s.entropy.cryptoCalls() });
  const rngNow = (): number | null => rng?.s ?? (env as any).registries?.rng?.s ?? null;
  const reseed = s.entropy.reseed;
  s.entropy.reseed = (seed: number, stream?: number) => {
    marks.push({ kind: 'reseed', seed, stream: stream ?? 0, frames, clock: s.clock.now, math: s.entropy.mathCalls(), crypto: s.entropy.cryptoCalls(), rngBefore: rngNow(), simStep: lines.length ? lines.length - 1 : -1 });
    reseed(seed, stream);
  };
  // Both sides ask for these sprite sheets when the run exists (see `preloadSheets` in types.ts).
  const startRun = s.startRun;
  s.startRun = function (this: Sim, cfg, onRunCreated) {
    return startRun.call(this, cfg, (a: any) => { onRunCreated?.(a); for (const id of opt.preloadSheets ?? []) a.run.sprites.get(id); });
  };
  const step = s.step;
  s.step = async function (this: Sim) {
    const i = lines.length;
    tracing = opt.trace && i >= opt.trace[0] && i <= opt.trace[1] ? (trace[i] = []) : null;
    await step.call(this);
    tracing = null;
    record();
  };
  return s;
};

const t0 = real.performanceNow();
const env = createEnvironment({ actionRepeat: 1, species: opt.species, map: opt.map, tier: opt.tier });
let obs = await env.reset({ seed: opt.seed });
const s = sim!;
rng = env.debug.registries!.rng;
pendingOf = () => { const d = (env as any).dialogs?.pending?.decision; return d ? `${d.method}:${d.options.map((o: { id: string }) => o.id).join('|')}` : null; };
playing = true;
marks.push({ kind: 'play', frames, clock: s.clock.now, math: s.entropy.mathCalls(), crypto: s.entropy.cryptoCalls(), rngBefore: rng.s });
const resetMs = real.performanceNow() - t0;

const result: SideResult = {
  side: 'headless', options: opt,
  engine: { node: process.version, v8: process.versions.v8, userAgent: (globalThis as any).navigator?.userAgent ?? null, commonMath, shimPatches, uuidPatched: (s.loader as { uuidPatched?: number }).uuidPatched ?? 0 },
  session: s.session, account: null, bootProfile: null, unlockReplies, season: JSON.parse(JSON.stringify(s.api.season)),
  registrySources: env.debug.registries!.sources, chunks: [...s.loader.loaded], storage: [],
  marks, api, lines, details, actions: [], decisions: [], static: null, sheets: null, end: null, stop: '', problems: [], gameErrors: [], blocked: [], timing: { resetMs, playMs: 0 },
};
{
  const acc = s.store.accountByToken(s.session!.token)!;
  result.account = { ...acc };
  result.bootProfile = bootProfile;
  const ls = (globalThis as any).localStorage;
  for (let i = 0; i < ls.length; i++) { const k = ls.key(i); result.storage.push([k, ls.getItem(k)]); }
}

result.preset = String(env.getMetadata().profile.preset);
result.profileSha = createHash('sha256').update(JSON.stringify((unlockReplies[unlockReplies.length - 1] as { profile?: unknown })?.profile ?? null)).digest('hex');
const modelsAtReset = modelFacts(s.run);
if (opt.static) result.static = staticDump(s.run, s.app);
record(); // line 0: the state the episode starts from

if (opt.maxSteps > 0) {
  const t1 = real.performanceNow();
  let res: StepResult | null = null, playN = 0, answered = 0;
  const seekMemo: { log?: unknown[] } = {};
  result.seekLog = [];
  for (;;) {
    if (res?.terminated) { result.stop = 'run over'; break; }
    if (lines.length - 1 >= opt.maxSteps) { result.stop = 'step limit'; break; }
    let action: Action;
    if (obs.phase === 'choice') {
      const d = obs.decision!;
      result.decisions.push({ simStep: lines.length - 1, kind: d.kind, method: d.method, options: d.options.map((o) => o.id), mask: JSON.parse(JSON.stringify(obs.mask)), context: JSON.parse(JSON.stringify(d.context)) });
      if (opt.stopAtDialog) { result.stop = 'first dialog'; break; }
      action = scriptAnswer(obs.mask as ChoiceMask, answered++) as Action;
    } else if (opt.script === 'seek') {
      // The page side has only the port of the play mask; here it is checked against the environment's own at every step.
      const m = playMask(s.run), em = obs.mask as PlayMask;
      if (m.interact !== em.interact || m.ultimate !== em.ultimate) throw new Error(`the play-mask port (shared.ts) differs from the environment's mask at step ${lines.length - 1}: ${JSON.stringify(m)} vs ${JSON.stringify({ ultimate: em.ultimate, interact: em.interact })}`);
      action = seekAction(s.run, playN++, m, seekMemo) as Action;
    } else action = scriptAction(opt.script, playN++) as Action;
    result.actions.push([lines.length - 1, JSON.stringify(action)]);
    res = await env.step(action);
    obs = res.observation;
  }
  if (res?.terminated) result.end = JSON.parse(JSON.stringify(res.info.end ?? null));
  result.seekLog = seekMemo.log ?? [];
  result.dialogKinds = Object.fromEntries(Object.entries(env.debug.dialogsSeen));
  result.timing.playMs = real.performanceNow() - t1;
}

if (opt.sheets?.length) {
  // The game's own sprite cache measures a sheet when its image arrives. Ask for every sheet, in small groups, and let
  // the game's frame loop run until each one is ready.
  const out: unknown[] = [];
  const ids = opt.sheets;
  for (let at = 0; at < ids.length; at += 12) {
    const group = ids.slice(at, at + 12);
    for (const id of group) sheetMeasure(s.run, id);
    try { await s.pump(() => group.every((id) => s.run.sprites.get(id).ready), `sprite sheets ${group.join(',')}`, 20_000); } catch { /* reported as not ready below */ }
    for (const id of group) out.push(sheetMeasure(s.run, id) ?? { id, notReady: true });
  }
  result.sheets = out;
}

if (opt.trace) result.trace = trace;
result.requestThrows = requestThrows;
result.models = { atReset: modelsAtReset, atEnd: modelFacts(s.run) };
result.audio = audioFacts(s.run);
{
  const ls = (globalThis as any).localStorage;
  result.assetsDuringPlay = assetsDuringPlay;
  result.spritesDuringPlay = [...new Set(assetsDuringPlay.map((l) => /assets[/]pmd(?:-forms)?[/]([0-9]+)[.]png$/.exec(l)?.[1]).filter(Boolean).map(Number))];
  result.sheetsDuringPlay = [...new Set(assetsDuringPlay.map((l) => /assets[/]((?:pmd|pmd-forms|pmd-shiny|front)[/][^/]+[.]png)$/.exec(l)?.[1]).filter(Boolean) as string[])];
  result.storageEnd = [];
  for (let i = 0; i < ls.length; i++) { const k = ls.key(i); result.storageEnd.push([k, ls.getItem(k)]); }
}
result.platform = platformFacts(); // last: it creates canvases and an <audio> element of its own
result.problems = s.browser.problems.slice(0, 50);
result.gameErrors = s.browser.gameErrors.slice(0, 50);
result.blocked = env.getMetadata().offline.blocked;
writeFileSync(outFile, JSON.stringify(result));
await env.close();
process.exit(0);
