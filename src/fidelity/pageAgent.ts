import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VirtualClock } from '../sim/clock.ts';
import { installSeededEntropy, sfc32 } from '../sim/rng.ts';
import { API_HOST, ORIGIN } from '../sim/net.ts';
import { keysForMove } from '../environment/GameEnvironment.ts';
import { MOVES, MOVE_VECTORS } from '../environment/types.ts';
import * as shared from './shared.ts';
import { installCommonMath } from './commonMath.ts';

/**
 * The script the oracle browser runs before any script of the page (CDP `Page.addScriptToEvaluateOnNewDocument`).
 * It makes the real page deterministic in the same way the headless page is, and it is where the browser side's copy
 * of the environment's reset / step logic lives.
 *
 * What is the SAME CODE as the headless side (sent as source text, so the two cannot drift apart):
 *   - `VirtualClock` (src/sim/clock.ts) and `sfc32` / `installSeededEntropy` (src/sim/rng.ts): `fn.toString()`;
 *   - `readRegistries` (src/environment/profile.ts) and `DialogCapture` / `resolveBuildNames`
 *     (src/environment/dialogs.ts): the files, type-stripped by Node's `module.stripTypeScriptTypes`;
 *   - `keysForMove` (src/environment/GameEnvironment.ts) and everything in src/fidelity/shared.ts.
 *
 * What is a PORT, written here by hand after `HeadlessGameEnvironment` and `Sim` and therefore the part to re-read when
 * those change: the order of calls in boot and reset (driven from browserRun.ts), `simStep`, `envStep`, the reseed
 * formula of the game's generator, the profile digest. Each is marked "port of".
 *
 * those change: the order of calls in boot and reset (driven from browserRun.ts: three `devUnlock` calls, the hunt
 * counters, `setRealTime`), `simStep`, `envStep`.
 *
 * What exists ONLY here (a real browser needs it, the headless page does not): the bookkeeping of asynchronous work
 * (`settle`). Headless, a fetch or an image "load" completes within one turn of the event loop; in a browser it takes
 * real time. Between two simulation steps the browser side therefore waits until nothing the page started is still
 * in flight, which is what `await turn()` gives the headless side for free.
 *
 * And, only when asked for (`asShim`, `warmSheets`; off by default, listed in the result when on): the three places
 * where the page is brought to what the headless side does. `request` and `audio-clock` copy a KNOWN difference of the
 * shims into the browser (docs/fidelity.md D2, D3), so that everything else can be compared exactly; `warmSheets`
 * gives the browser the warm sheet cache that the headless image shim amounts to (D4).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

export interface AgentConfig {
  origin: string;
  apiHost: string;
  seed: number;
  hz: number;
  /** localStorage content before the page's first script runs (the prepared session). */
  storage: [string, string][];
  script: string;
  maxSteps: number;
  stopAtDialog: boolean;
  detail: [number, number] | null;
  /** false: leave the game's own HUD dialogs in place and stop when the run enters `modal`. */
  dialogCapture: boolean;
  /** 0: never call the renderer between steps (as the environment does). N: draw every N-th step, entropy protected. */
  renderEvery: number;
  moveVectors: Record<string, { x: number; z: number } | null>;
  /** Replace the transcendental Math functions by src/fidelity/commonMath.ts (the headless side does the same). */
  commonMath: boolean;
  /** Record Math.random call sites during these simulation steps. */
  trace: [number, number] | null;
  /** Places where the page is made to behave like the shim (`browserAsShim` in types.ts): `request`, `audio-clock`, `uuid`. */
  asShim: string[];
  /** With `uuid` in `asShim`: seed of the private stream three.js' UUIDs are drawn from (read from src/sim/loader.ts). */
  uuidSeed: number | null;
}

/** Runs inside the page. Self-contained: everything it needs arrives in `cfg` and `lib`. */
export function agentMain(cfg: AgentConfig, lib: any): void {
  const w = window as any;
  const real = lib.real;
  const commonMath: string[] = cfg.commonMath ? lib.installCommonMath(Math) : [];
  const F: any = (w.__fid = { cfg, frames: 0, seed: cfg.seed >>> 0, marks: [], problems: [], tasks: {}, apiTimes: [], pend: {}, lines: [], details: {}, actions: [], decisions: [], notes: [], reg: null, dialogs: null, commonMath });

  // ---------------------------------------------------------------- asynchronous work in flight
  let pending = 0;
  const pend: Record<string, number> = F.pend;
  const begin = (kind: string) => { pending++; pend[kind] = (pend[kind] || 0) + 1; let open = true; return () => { if (open) { open = false; pending--; pend[kind]--; } }; };
  const track = <T,>(kind: string, p: Promise<T>): Promise<T> => { const end = begin(kind); p.then(end, end); return p; };

  const nativeFetch = w.fetch.bind(w);
  w.fetch = function (input: any, init: any) {
    const href = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
    if (href.indexOf('//' + cfg.apiHost) >= 0) F.apiTimes.push([String((init && init.method) || (input && input.method) || 'GET').toUpperCase(), href, clock.now]);
    return track('fetch', nativeFetch(input, init) as Promise<any>).then((res: any) => {
      for (const m of ['json', 'text', 'arrayBuffer', 'blob', 'formData']) { const orig = res[m].bind(res); res[m] = () => track('body', orig()); }
      return res;
    });
  };
  const srcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
  const loading = new WeakMap<object, () => void>();
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true, enumerable: true,
    get(this: any) { return srcDesc.get!.call(this); },
    set(this: any, v: string) {
      if (!loading.has(this)) {
        const end = begin('image');
        const done = () => { loading.delete(this); this.removeEventListener('load', done); this.removeEventListener('error', done); real.clearTimeout(guard); end(); };
        // An element whose load never reports (detached and collected, or an empty src) must not hold the run forever.
        const guard = real.setTimeout(() => { F.notes.push('image load not reported within 20 s: ' + String(v).slice(0, 120)); done(); }, 20000);
        loading.set(this, done);
        this.addEventListener('load', done); this.addEventListener('error', done);
      }
      srcDesc.set!.call(this, v);
    },
  });
  if (typeof w.createImageBitmap === 'function') { const cib = w.createImageBitmap.bind(w); w.createImageBitmap = (...a: any[]) => track('bitmap', cib(...a)); }
  const BAC = w.BaseAudioContext && w.BaseAudioContext.prototype;
  if (BAC && BAC.decodeAudioData) { const dec = BAC.decodeAudioData; BAC.decodeAudioData = function (this: any, ...a: any[]) { return track('audio-decode', dec.apply(this, a)); }; }
  // Observation only: remember the audio contexts the game creates, to report their state (running / suspended).
  if (typeof w.AudioContext === 'function') {
    const AC = w.AudioContext; w.__fidAudio = [];
    const Sub = class extends AC { constructor(...a: any[]) { super(...a); w.__fidAudio.push(this); } };
    if (cfg.asShim.includes('audio-clock')) {
      // AS THE SHIM (docs/fidelity.md D3): `NullAudioContext.currentTime` is the page clock in seconds although the
      // context is suspended. A real suspended context reports a clock that stands still. Only while suspended.
      const time = Object.getOwnPropertyDescriptor(w.BaseAudioContext.prototype, 'currentTime')!.get!;
      Object.defineProperty(Sub.prototype, 'currentTime', { configurable: true, get(this: any) { return this.state === 'suspended' ? clock.now / 1000 : time.call(this); } });
      Object.defineProperty(Sub.prototype, 'getOutputTimestamp', { configurable: true, writable: true, value(this: any) { return this.state === 'suspended' ? { contextTime: clock.now / 1000, performanceTime: clock.now } : AC.prototype.getOutputTimestamp.call(this); } });
    }
    w.AudioContext = Sub;
  }
  // AS THE HEADLESS MODULE HOOK (docs/fidelity.md D10): the stream three.js' UUIDs are drawn from once its chunk has
  // been served with the same rewrite (browserRun.ts). Fixed seed, never restarted, exactly as in src/sim/loader.ts.
  if (cfg.asShim.includes('uuid')) w.__pbUuidRandom = lib.sfc32(cfg.uuidSeed);
  F.requestThrows = { count: 0, first: [] };
  if (cfg.asShim.includes('request')) {
    // AS THE SHIM (docs/fidelity.md D2): under the shims `new Request(url, { signal })` always throws (Node's Request
    // refuses the DOM library's AbortSignal, and cannot resolve a page-relative URL). The only caller in the bundle is
    // three.js' FileLoader, so three.js loads no file and no 3D model ever arrives. Same throw, same place, here.
    const NativeRequest = w.Request;
    w.Request = new Proxy(NativeRequest, {
      construct(target: any, args: any[]) {
        const input = args[0], init = args[1];
        const why = init && init.signal != null ? 'RequestInit: Expected signal to be an instance of AbortSignal' : typeof input === 'string' && !/^[a-z][a-z0-9+.-]*:/i.test(input) ? 'Failed to parse URL from ' + input : null;
        if (why) { F.requestThrows.count++; if (F.requestThrows.first.length < 40) F.requestThrows.first.push(String(input).slice(0, 90) + ' → ' + why); throw new TypeError(why + ' (as the headless shim)'); }
        return Reflect.construct(target, args);
      },
    });
  }
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes as any) {
      if (n.tagName !== 'LINK' || !n.href || !/stylesheet|modulepreload/.test(n.rel)) continue;
      const end = begin('link');
      const done = () => { real.clearTimeout(guard); end(); };
      const guard = real.setTimeout(done, 20000);
      n.addEventListener('load', done); n.addEventListener('error', done);
    }
  }).observe(document, { childList: true, subtree: true });

  const channel = new MessageChannel();
  let wake: (() => void) | null = null;
  channel.port1.onmessage = () => { const f = wake; wake = null; if (f) f(); };
  /** One full turn of the page's event loop (all microtasks first), not throttled like a timer. */
  const macrotask = () => new Promise<void>((r) => { wake = r; channel.port2.postMessage(0); });
  /** Resolve once nothing tracked is in flight for `turns` consecutive event-loop turns. */
  const settle = async (turns: number): Promise<void> => {
    let idle = 0, spins = 0;
    while (idle < turns) {
      await macrotask();
      if (pending === 0) idle++;
      else { idle = 0; if (++spins % 40 === 0) await new Promise<void>((r) => real.setTimeout(r, 1)); }
    }
  };

  // ---------------------------------------------------------------- clock and entropy: the code of src/sim
  const clock = new lib.VirtualClock();
  clock.onError = (where: string, e: any) => { F.problems.push(`[page ${where} error] ${(e && e.stack) || e}`); };
  clock.install(w);
  const entropy = lib.installSeededEntropy(cfg.seed, w);
  F.clock = clock; F.entropy = entropy;
  F.trace = {};
  let tracing: string[] | null = null;
  if (cfg.trace) {
    let inner = Math.random;
    const stack: (() => number)[] = []; // see headlessRun.ts: assigning the tracer back means "restore"
    const traced = () => { if (tracing) tracing.push(lib.shared.callSite(1, 4)); return inner(); };
    Object.defineProperty(Math, 'random', { configurable: true, enumerable: false, get: () => traced, set: (f: () => number) => { if (f === traced) inner = stack.pop() ?? inner; else { stack.push(inner); inner = f; } } });
  }

  // ---------------------------------------------------------------- the prepared local account
  try { localStorage.clear(); sessionStorage.clear(); for (const [k, v] of cfg.storage) localStorage.setItem(k, v); } catch (e) { F.problems.push('[agent] storage: ' + e); }

  // ---------------------------------------------------------------- what the page complains about
  const fmt = (x: any) => { try { return x instanceof Error ? (x.stack ?? x.message) : typeof x === 'string' ? x : JSON.stringify(x) ?? String(x); } catch { return String(x); } };
  for (const level of ['warn', 'error'] as const) {
    const orig = (console as any)[level].bind(console);
    (console as any)[level] = (...a: any[]) => { F.problems.push((`[page ${level}] ` + a.map(fmt).join(' ')).slice(0, 2000)); orig(...a); };
  }
  w.addEventListener('error', (e: any) => { F.problems.push('[page uncaught] ' + String((e && e.error && e.error.stack) || (e && e.message) || e).slice(0, 2000)); });
  w.addEventListener('unhandledrejection', (e: any) => { F.problems.push('[page unhandledrejection] ' + String((e && e.reason && e.reason.stack) || (e && e.reason)).slice(0, 2000)); });
  for (const type of ['visibilitychange', 'blur', 'pagehide', 'freeze', 'pointerlockchange', 'pointerlockerror', 'webglcontextlost'])
    (type === 'blur' || type === 'pagehide' ? w : document).addEventListener(type, () => { F.notes.push(`event ${type} at simStep ${F.lines.length - 1}, frame ${F.frames}`); }, true);

  // ---------------------------------------------------------------- driver interface
  const app = () => w.__pb.app;
  const mark = (kind: string, more: Record<string, unknown> = {}) => { F.marks.push({ kind, frames: F.frames, clock: clock.now, math: entropy.mathCalls(), crypto: entropy.cryptoCalls(), ...more }); };
  F.mark = mark;
  F.pending = () => pending;
  F.settle = async (turns: number) => { await settle(turns); return pending; };
  /** One display frame of the page clock: port of the body of `Sim.pump`. */
  F.frame = () => { clock.advance(1000 / 60); clock.frame(); F.frames++; };
  F.begin = (name: string, fn: () => unknown) => {
    const t: any = (F.tasks[name] = { done: false, value: null, error: null });
    try { Promise.resolve(fn()).then((v) => { t.value = v === undefined ? null : v; t.done = true; }, (e) => { t.error = String((e && e.stack) || e); t.done = true; }); }
    catch (e: any) { t.error = String((e && e.stack) || e); t.done = true; }
  };
  F.readRegistries = async (paths: string[]) => {
    const reg = (F.reg = await lib.env.readRegistries(paths));
    return { sources: reg.sources, season: reg.season, tiers: reg.tiers, maps: lib.env.playableMaps(reg).map((m: any) => m.id), rng: reg.rng.s, release: reg.releases[0] };
  };
  F.verifyUnlocked = () => lib.env.verifyUnlocked(app().meta, F.reg);
  /** Port of `Sim.reseed`: Math.random and crypto restart from the seed (the driver resets the ticket counter). */
  F.simReseed = (seed: number) => { F.seed = seed >>> 0; mark('reseed', { seed: F.seed, stream: 0, rngBefore: F.reg ? F.reg.rng.s : null, simStep: F.lines.length ? F.lines.length - 1 : -1 }); entropy.reseed(F.seed); };
  /** Port of `HeadlessGameEnvironment.reseed`: the streams and the state of the game's own generator. */
  F.envReseed = (seed: number, stream: number) => {
    mark('reseed', { seed, stream, rngBefore: F.reg ? F.reg.rng.s : null, simStep: F.lines.length ? F.lines.length - 1 : -1 });
    entropy.reseed(seed, stream);
    F.reg.rng.s = ((Math.imul(seed ^ 0x85ebca6b, 0xc2b2ae35) + Math.imul(stream + 1, 0x27d4eb2f)) >>> 0) || 0x9e3779b9;
  };
  /** Port of `HeadlessGameEnvironment.profileDigestSource`. */
  const profileDigestSource = () => {
    const p = app().meta.profile, skip = new Set(['settings', 'lastSpecies', 'lastBiome', 'daily', 'weekly', 'hunt']);
    return JSON.stringify(Object.keys(p).filter((k) => !skip.has(k)).sort().map((k) => [k, p[k]]));
  };
  F.profileDigestSource = profileDigestSource;
  /** For the port of the hunt-counter check in `reset()`: the counters the game adopted. */
  F.huntJson = () => JSON.stringify(app().meta.profile.hunt ?? null);
  /** Port of `HeadlessGameEnvironment.setRealTime`. */
  F.setRealTime = (value: number) => {
    const run = app().run;
    if (typeof run.realTime !== 'number' || !Number.isFinite(value)) throw new Error('the run has no numeric realTime counter');
    run.realTime = value;
  };
  F.modelFacts = () => lib.shared.modelFacts(app().run);
  F.platformFacts = () => lib.shared.platformFacts();
  /**
   * ONLY HERE (docs/fidelity.md D4): the game's sheet cache, warm and kept warm. `window.__pbSheets` is published by
   * one statement appended in memory to the chunk that holds the game's sheet loader (browserRun.ts): `load` is that
   * loader, `cache` its url → promise-of-image map, `url` the game's asset-URL function.
   *
   * Every sheet is loaded once through the game's own loader. The game's own memory trim removes entries from the
   * cache; a sheet asked for again after that would be a real, asynchronous load. The entry is therefore put back
   * when it is asked for (same image element), so that a sheet always reaches the game in the step that asks for it,
   * as it does under the headless image shim.
   */
  F.sheets = { warmed: 0, evicted: 0, restored: 0, failed: [] as string[] };
  F.warmSheets = async (paths: string[]) => {
    const S = w.__pbSheets;
    if (!S || typeof S.load !== 'function' || !(S.cache instanceof Map) || typeof S.url !== 'function') throw new Error('the game\'s sheet loader was not published (window.__pbSheets)');
    const urls: string[] = paths.map((p) => S.url(p));
    const keep = new Map<string, Promise<any>>();
    await Promise.all(urls.map((u) => { const p: Promise<any> = S.load(u); keep.set(u, p); return Promise.race([p, new Promise((r) => real.setTimeout(() => r(null), 120000))]).then((img: any) => { if (img && img.naturalWidth) F.sheets.warmed++; else F.sheets.failed.push(u); }); }));
    const get = Map.prototype.get, set = Map.prototype.set, del = Map.prototype.delete;
    S.cache.delete = function (u: string) { if (keep.has(u) && Map.prototype.has.call(this, u)) F.sheets.evicted++; return del.call(this, u); };
    S.cache.get = function (u: string) {
      const have = get.call(this, u);
      if (have !== undefined || !keep.has(u)) return have;
      F.sheets.restored++;
      set.call(this, u, keep.get(u));
      return keep.get(u);
    };
    return { asked: urls.length, cached: S.cache.size, ...F.sheets, sample: urls.slice(0, 2) };
  };
  const storageNow = () => { const out: [string, string][] = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i)!; out.push([k, localStorage.getItem(k)!]); } return out; };
  F.storage = storageNow;
  /** Port of the end of `HeadlessGameEnvironment.boot`: the reset point, and the wrap of `app.launch`. */
  F.baselineTake = () => {
    const a = app(), p = a.meta.profile;
    F.baseline = { profile: profileDigestSource(), settings: JSON.stringify(p.settings), lastSpecies: p.lastSpecies, lastBiome: p.lastBiome, storage: storageNow().filter(([k]) => k !== 'pb-errs') };
    const launch = a.launch;
    a.launch = (...args: unknown[]) => { F.envReseed(F.seed, 0); return launch.apply(a, args); };
    return { quality: p.settings.quality, fpsCap: a.fpsCap(), settings: F.baseline.settings };
  };
  /** Port of step 2 of `reset()`, before and after the `devUnlock` call. */
  F.restoreStorage = () => { localStorage.clear(); for (const [k, v] of F.baseline.storage) localStorage.setItem(k, v); };
  F.restoreProfile = () => {
    const p = app().meta.profile;
    p.settings = JSON.parse(F.baseline.settings); p.lastSpecies = F.baseline.lastSpecies; p.lastBiome = F.baseline.lastBiome;
    return profileDigestSource() === F.baseline.profile;
  };
  /** Port of the `onRunCreated` callback in `reset()`: the same `DialogCapture` class on this run's HUD. */
  F.installDialogs = () => {
    const a = app();
    F.names = F.names || lib.env.resolveBuildNames(w.__pb.Run, a.hud);
    F.dialogs = F.dialogs || new lib.env.DialogCapture(F.names);
    return { replaced: F.dialogs.install(a.hud, a.run), names: F.names };
  };
  F.runFacts = () => { const run = app().run; return { species: run.player && run.player.speciesId, map: run.biome && run.biome.id, tier: run.tier, mode: run.mode, competitive: !!run.competitive, seed: run.seed >>> 0, state: run.state, stage: run.stage | 0 }; };
  F.audioFacts = () => lib.shared.audioFacts(app().run);
  F.static = () => lib.shared.staticDump(app().run, app());
  F.sheetsAsk = (ids: number[]) => { for (const id of ids) lib.shared.sheetMeasure(app().run, id); };
  F.sheetsReady = (ids: number[]) => ids.every((id) => app().run.sprites.get(id).ready);
  F.sheetsRead = (ids: number[]) => ids.map((id) => lib.shared.sheetMeasure(app().run, id) || { id, notReady: true });

  // ---------------------------------------------------------------- stepping
  const dtMs = 1000 / cfg.hz, dt = dtMs / 1000;
  const KEYS = { jump: 'Space', dash: 'ShiftLeft', interact: 'KeyE', ultimate: 'KeyR' };
  const WAITING = new Set(['transition', 'evolving', 'cinematic', 'capturing', 'dead']);
  const held = new Set<string>();
  /** Port of `HeadlessGameEnvironment.hold`. */
  const hold = (codes: Iterable<string>) => {
    const want = new Set(codes), input = app().input;
    for (const k of held) if (!want.has(k)) { input.release(k); held.delete(k); }
    for (const k of want) if (!held.has(k)) { input.press(k); held.add(k); }
  };
  const pendingOf = (): string | null => { const d = F.dialogs && F.dialogs.pending && F.dialogs.pending.decision; return d ? `${d.method}:${d.options.map((o: any) => o.id).join('|')}` : null; };
  const record = () => {
    const i = F.lines.length;
    const d = lib.shared.stepDigest(app().run, { i, math: entropy.mathCalls(), crypto: entropy.cryptoCalls(), rngS: F.reg ? F.reg.rng.s : 0, pending: pendingOf(), detail: !!cfg.detail && i >= cfg.detail[0] && i <= cfg.detail[1] });
    F.lines.push(d.line);
    if (d.groups) F.details[i] = d.groups;
  };
  F.record = record;
  /** Port of `HeadlessGameEnvironment.check`. */
  const check = (during: string) => {
    const D = F.dialogs, run = app().run;
    if (!D) return;
    if (D.failure) throw new Error(`unhandled dialog "${D.failure.method}" during ${during}: ${D.failure.reason} ${D.failure.args}`);
    if (run.state === 'modal' && !D.pending) throw new Error(`the run is waiting on a dialog that was not captured (during ${during})`);
    if (run.state === 'paused') throw new Error(`the game paused itself (during ${during})`);
    if (run.state !== 'modal' && D.pending) throw new Error(`a dialog was captured but the run is in state "${run.state}" (during ${during})`);
  };
  /**
   * Draw one frame with the real renderer without letting it consume the simulation's random numbers: Math.random
   * and the game's generator are put aside for the duration of the call.
   */
  const draw = () => {
    const a = app(), keepRandom = Math.random, keepS = F.reg ? F.reg.rng.s : 0;
    Math.random = lib.sideRandom;
    try { a.r.render(dt); } catch (e: any) { F.notes.push('render: ' + String(e && e.message)); } finally { Math.random = keepRandom; if (F.reg) F.reg.rng.s = keepS; }
  };
  F.draw = draw;
  /** Port of `Sim.step` plus the bookkeeping of `HeadlessGameEnvironment.simStep`. */
  const simStep = async () => {
    const a = app(), run = a.run, i = F.lines.length;
    tracing = cfg.trace && i >= cfg.trace[0] && i <= cfg.trace[1] ? (F.trace[i] = []) : null;
    clock.advance(dtMs);
    try { run.update(dt); } finally { a.input.endFrame(); }
    if (cfg.renderEvery > 0 && F.lines.length % cfg.renderEvery === 0) draw();
    await settle(1);
    tracing = null;
    record();
    check('a simulation step');
  };
  /** Port of `HeadlessGameEnvironment.step` for a valid action with actionRepeat = 1. */
  const envStep = async (action: any) => {
    const a = app(), D = F.dialogs;
    if (action.type === 'choice') { D.pending.answer(action); check('answering a dialog'); }
    else {
      const input = a.input;
      hold(lib.keysForMove(cfg.moveVectors[action.move], a.run.camYaw));
      const taps = [action.jump && KEYS.jump, action.dash && KEYS.dash, action.ultimate && KEYS.ultimate, action.interact && KEYS.interact].filter(Boolean) as string[];
      for (const k of taps) input.press(k);
      await simStep();
      for (const k of taps) input.release(k);
    }
    let waited = 0, realTimeBeforeLoading: number | null = null;
    while (!(D && D.pending) && WAITING.has(a.run.state)) {
      if (waited === 0) hold([]);
      const loadingZone = a.run.state === 'transition';
      if (loadingZone && realTimeBeforeLoading === null) realTimeBeforeLoading = a.run.realTime;
      await simStep();
      if (loadingZone && a.run.state !== 'transition') {
        F.envReseed(F.seed, a.run.stage | 0);
        F.setRealTime(realTimeBeforeLoading);
        realTimeBeforeLoading = null;
      }
      if (++waited > 7200) throw new Error('the game stayed in a non-interactive state');
    }
  };
  F.ep = { playN: 0, answered: 0, stop: '', memo: {} };
  F.seekLog = () => F.ep.memo.log || [];
  F.dialogKinds = () => { const out: Record<string, number> = {}; if (F.dialogs) for (const [k, n] of F.dialogs.seen) out[k] = n; return out; };
  /** The scripted episode, in slices: runs until the digest has `untilLine` lines or the episode stops. */
  F.play = async (untilLine: number) => {
    const ep = F.ep, from = F.lines.length;
    try {
      while (!ep.stop) {
        const run = app().run, D = F.dialogs;
        if (run.state === 'over') { ep.stop = 'run over'; break; }
        if (F.lines.length - 1 >= cfg.maxSteps) { ep.stop = 'step limit'; break; }
        if (F.lines.length >= untilLine) break;
        let action: any;
        if (D && D.pending) {
          const d = D.pending.decision, mask = D.pending.mask();
          F.decisions.push({ simStep: F.lines.length - 1, kind: d.kind, method: d.method, options: d.options.map((o: any) => o.id), mask: JSON.parse(JSON.stringify(mask)), context: JSON.parse(JSON.stringify(d.context)) });
          if (cfg.stopAtDialog) { ep.stop = 'first dialog'; break; }
          action = lib.shared.scriptAnswer(mask, ep.answered++);
        } else if (!D && run.state !== 'play' && !WAITING.has(run.state)) { ep.stop = `run state "${run.state}" (the game's own HUD is in place)`; break; }
        else if (cfg.script === 'seek') action = lib.shared.seekAction(run, ep.playN++, lib.shared.playMask(run), ep.memo);
        else action = lib.shared.scriptAction(cfg.script, ep.playN++);
        F.actions.push([F.lines.length - 1, JSON.stringify(action)]);
        await envStep(action);
      }
    } catch (e: any) { ep.stop = 'error: ' + String((e && e.stack) || e); }
    return { lines: F.lines.slice(from), stop: ep.stop };
  };
}

/** Synchronous SHA-256 for the page, with the two calls `installSeededEntropy` makes on node:crypto's `createHash`. */
const PAGE_CREATE_HASH = `(name) => {
  if (name !== 'sha256') throw new Error('page createHash: ' + name + ' is not implemented');
  const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  let data = new Uint8Array(0);
  const api = {
    update(view) { const next = new Uint8Array(data.length + view.length); next.set(data); next.set(view, data.length); data = next; return api; },
    digest() {
      const len = data.length, total = ((len + 9 + 63) >> 6) << 6, m = new Uint8Array(total), dv = new DataView(m.buffer);
      m.set(data); m[len] = 0x80; dv.setUint32(total - 8, Math.floor(len / 0x20000000)); dv.setUint32(total - 4, (len << 3) >>> 0);
      const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]), W = new Uint32Array(64);
      const rr = (x, n) => (x >>> n) | (x << (32 - n));
      for (let o = 0; o < total; o += 64) {
        for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + i * 4);
        for (let i = 16; i < 64; i++) { const a = W[i - 15], b = W[i - 2]; W[i] = (W[i - 16] + (rr(a, 7) ^ rr(a, 18) ^ (a >>> 3)) + W[i - 7] + (rr(b, 17) ^ rr(b, 19) ^ (b >>> 10))) >>> 0; }
        let [a, b, c, d, e, f, g, h] = H;
        for (let i = 0; i < 64; i++) {
          const t1 = (h + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
          const t2 = ((rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
          h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
      }
      const out = new Uint8Array(32), ov = new DataView(out.buffer);
      for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i]);
      return out;
    },
  };
  return api;
}`;

/** A module of src/environment as a classic-script fragment: types stripped, imports and `export` keywords removed. */
function environmentSource(file: string, replaceImports: Record<string, string> = {}): string {
  let src = stripTypeScriptTypes(readFileSync(join(REPO, 'src', 'environment', file), 'utf8'));
  src = src.replace(/^import\s[^;]*?from\s+'([^']+)';?[ \t]*$/gm, (all, from: string) => {
    if (from in replaceImports) return replaceImports[from];
    throw new Error(`pageAgent: src/environment/${file} imports "${from}", which the page fragment has no stand-in for`);
  });
  if (/^\s*import\s/m.test(src)) throw new Error(`pageAgent: src/environment/${file} still has an import after preparation`);
  return src.replace(/^export\s+(?=(async\s+)?(function|const|let|class)\b)/gm, '').replace(/^export\s+(type|interface)\b[^\n]*$/gm, '');
}

/** The key codes `keysForMove` returns, read off the function itself (its table is private to its module). */
function movementKeys(): { up: string; down: string; left: string; right: string } {
  const one = (v: { x: number; z: number }) => { const k = keysForMove(v, 0); if (k.length !== 1) throw new Error('pageAgent: keysForMove no longer maps an axis to one key'); return k[0]; };
  return { up: one({ x: 0, z: -1 }), down: one({ x: 0, z: 1 }), left: one({ x: -1, z: 0 }), right: one({ x: 1, z: 0 }) };
}

/** The full source of the injected script. Throws if the page copy of `keysForMove` does not behave like the original. */
/**
 * The statement appended (in memory) to the chunk that holds the game's sprite-sheet loader, so that the page agent
 * can warm the game's own sheet cache: it publishes the loader, its cache and the asset-URL function, all three
 * module-private. The names are minified and found by the shape of the code; null when this is not that chunk.
 * Appended after the last statement: no position in the chunk moves, so call sites stay comparable.
 */
export function sheetLoaderExport(source: string): string | null {
  const loader = /function ([\w$]+)\(e,t=!1\)\{let n=([\w$]+)\.get\(e\);if\(n\)\{let r=t\?void 0:[\w$]+\.get\(e\);/.exec(source);
  const url = /this\.load\(this\.url=([\w$]+)\(this\.fallback\?/.exec(source);
  if (!loader || !url) return null;
  return `;globalThis.__pbSheets={load:${loader[1]},cache:${loader[2]},url:${url[1]}};`;
}

/**
 * The in-memory rewrite of three.js' `generateUUID` that the headless module hook makes (src/sim/loader.ts): its four
 * `Math.random()` calls go to a private stream, `globalThis.__pbUuidRandom`. The pattern, the replacement expression
 * and the stream's seed are READ FROM THAT FILE's text, so this side cannot drift from it; if the file no longer has
 * them in this form, building the page script fails.
 */
export function uuidRewrite(): { seed: number; apply: (source: string) => string | null } {
  const text = readFileSync(join(REPO, 'src', 'sim', 'loader.ts'), 'utf8');
  const seed = /__pbUuidRandom = sfc32\((0x[0-9a-fA-F]+|\d+)\)/.exec(text);
  const pattern = /^const UUID = \/(.+)\/g;$/m.exec(text);
  const expr = /const R = '([^']+)';/.exec(text);
  if (!seed || !pattern || !expr || !text.includes('`function ${fn}(){let ${a}=${R},${b}=${R},${c}=${R},${d}=${R};`')) throw new Error('pageAgent: src/sim/loader.ts no longer holds the three.js UUID rewrite in the form the browser side reads; re-read both');
  const UUID = new RegExp(pattern[1], 'g'), R = expr[1];
  return {
    seed: Number(seed[1]),
    apply(source) {
      const found = [...source.matchAll(UUID)];
      if (found.length !== 1) return null;
      const [all, fn, a, b, c, d] = found[0];
      return source.replace(all, () => `function ${fn}(){let ${a}=${R},${b}=${R},${c}=${R},${d}=${R};`);
    },
  };
}

export function buildAgentSource(cfg: Omit<AgentConfig, 'origin' | 'apiHost' | 'moveVectors'>): string {
  const keys = movementKeys();
  const keysForMoveSrc = `(() => { const KEY = ${JSON.stringify(keys)}; return ${keysForMove.toString()}; })()`;
  const copy = new Function(`return ${keysForMoveSrc};`)() as typeof keysForMove;
  for (const m of MOVES) for (let yaw = -7; yaw <= 7; yaw += 0.173) {
    const a = keysForMove(MOVE_VECTORS[m], yaw).join('+'), b = copy(MOVE_VECTORS[m], yaw).join('+');
    if (a !== b) throw new Error(`pageAgent: the page copy of keysForMove differs from the original (move ${m}, yaw ${yaw}: ${a} vs ${b})`);
  }
  const full: AgentConfig = { ...cfg, origin: ORIGIN, apiHost: API_HOST, moveVectors: MOVE_VECTORS };
  const sharedSrc = Object.entries(shared).filter(([, f]) => typeof f === 'function').map(([name, f]) => `${JSON.stringify(name)}: ${(f as () => void).toString()}`).join(',\n');
  return `(() => {
  const cfg = ${JSON.stringify(full)};
  if (window !== window.top || location.origin !== cfg.origin || window.__fid) return;
  const real = {
    setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window),
    setImmediate: undefined, Date: window.Date, performanceNow: window.performance.now.bind(window.performance),
  };
  const createHash = ${PAGE_CREATE_HASH};
  const VirtualClock = ${VirtualClock.toString()};
  const sfc32 = ${sfc32.toString()};
  const installSeededEntropy = ${installSeededEntropy.toString()};
  const sideRandom = sfc32(0x51de);
  const installCommonMath = ${installCommonMath.toString()};
  const env = (() => {
    const ORIGIN = location.origin;
${environmentSource('profile.ts', { '../sim/net.ts': '' })}
${environmentSource('dialogs.ts')}
    return { readRegistries, playableMaps, verifyUnlocked, DialogCapture, resolveBuildNames };
  })();
  const shared = {
${sharedSrc}
  };
  const keysForMove = ${keysForMoveSrc};
  (${agentMain.toString()})(cfg, { real, VirtualClock, sfc32, installSeededEntropy, installCommonMath, sideRandom, env, shared, keysForMove });
})();`;
}
