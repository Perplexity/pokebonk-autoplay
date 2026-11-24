import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Cdp } from '../cdp/client.ts';
import { MockApi, localRankedSeason } from '../sandbox/mockApi.ts';
import { Store } from '../sandbox/store.ts';
import type { RunRecord } from '../sandbox/store.ts';
import { API_HOST, Net, ORIGIN, PAGE_URL } from '../sim/net.ts';
import { OracleChrome } from './chrome.ts';
import { buildAgentSource, sheetLoaderExport, uuidRewrite } from './pageAgent.ts';
import { replySha } from './compare.ts';
import type { ApiCall, EpisodeOptions, SideResult } from './types.ts';

/**
 * Browser side of the fidelity comparison: the same episode as `headlessRun.ts`, in a real local Chrome.
 *
 * This file is the browser counterpart of `Sim.boot`, `HeadlessGameEnvironment.boot` and `.reset`: it makes the same
 * calls on the game in the same order (each block names what it is a port of). The page-side half is pageAgent.ts.
 *
 * Every change made to what the browser receives or runs is in memory and is listed in `result.browser.modifications`.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The same statement the headless module load hook inserts (src/sim/loader.ts), found by the same pattern. */
const TAIL = /var ([\w$]+)=new ([\w$]+);([\w$]+)\(\2\.prototype,([\w$]+)\.prototype((?:,[\w$]+\.prototype)*)\),await \1\.boot\(\);?\s*$/;

export interface BrowserRunOptions {
  /** The headless result of the same episode: the account, the profile replies and the season are taken from it. */
  reference: SideResult;
  dataDir: string;
  /** Install the environment's dialog capture on the HUD (default). false: the game's own dialogs, stop at the first. */
  dialogCapture?: boolean;
  /** Draw every N-th step with the real renderer (random streams protected). 0: never, as the environment. */
  renderEvery?: number;
  /** Real milliseconds without any request before a display frame is pumped in boot and loading phases. */
  quietMs?: number;
  /** Leave the window open for this long after the episode (ms). */
  lingerMs?: number;
  screenshot?: string;
  /**
   * Pump extra display frames after boot until the page clock equals the headless one at the same point (default true).
   * The headless page needs one frame for its simulated load events; a browser needs none.
   */
  alignClock?: boolean;
  /** Name of the Chrome profile folder under `dataDir` (default `browser-profile`). Two comparisons at once need two. */
  profile?: string;
  log?: (line: string) => void;
}

export async function runBrowser(opt: EpisodeOptions, o: BrowserRunOptions): Promise<SideResult> {
  const ref = o.reference, log = o.log ?? (() => {});
  const quietMs = o.quietMs ?? 120;
  if (!ref.account || !ref.session || !ref.bootProfile) throw new Error('the headless reference has no account / profile to copy');
  const t0 = performance.now();

  // ---- the local stand-in for the game service: the same classes the headless side runs in-process ----
  const storeDir = join(o.dataDir, `store-${process.pid}-${Date.now().toString(36)}`);
  mkdirSync(storeDir, { recursive: true });
  const store = new Store(storeDir);
  store.putAccount({ ...ref.account });
  store.putProfile(ref.account.id, structuredClone(ref.bootProfile));
  const mock = new MockApi(store);
  mock.progression = false;
  // Port of the fixed id sequence in the `Sim` constructor. The account (ids 0 and 1 of that sequence) is copied from
  // the headless side, so this side continues at 2.
  let ids = 2;
  mock.newId = (bytes = 12) => createHash('sha256').update(`pb-sim-id|${ids++}`).digest('hex').slice(0, bytes * 2);
  const finished: RunRecord[] = [];
  mock.onEvent = (ev) => { if (ev.type === 'run-finish' && ev.run) finished.push(ev.run); };
  let seed = opt.seed >>> 0, tickets = 0;
  const net = new Net({
    mirrorDir: join(REPO, 'mirror'), api: mock, Response: globalThis.Response,
    // Port of the `pinTicket` in the `Sim` constructor.
    pinTicket: () => ({ seed, id: createHash('sha256').update(`pb-sim:${seed}:${tickets++}`).digest('hex').slice(0, 24) }),
  });
  const api: ApiCall[] = [];
  let unlocks = 0, virtualNow = 0, epoch = 0;
  const handle = mock.handle.bind(mock);
  mock.handle = async (method, url, headers, body) => {
    const at = { frame: Math.round((virtualNow - epoch) / (1000 / 60)), clock: virtualNow - epoch, simStep: -1 };
    const r = await handle(method, url, headers, body);
    api.push({ ...at, method, url, body: body ?? null, status: r.status, replySha: replySha(method, url, r.json), client: headers['x-client'] ?? null, device: headers['x-device'] ?? null });
    return r;
  };

  const modifications: string[] = [];
  const asShim = opt.browserAsShim ?? [];
  const uuid = asShim.includes('uuid') ? uuidRewrite() : null;
  let uuidPatched = 0;
  let cdp!: Cdp;
  const chrome = new OracleChrome({
    profileDir: join(o.dataDir, o.profile ?? 'browser-profile'), mirrorDir: join(REPO, 'mirror'), net, log,
    apiNow: async (method, url) => {
      // The page noted its clock when it made the call; the mock stamps its reply with that time, as it does headless.
      const v = await cdp.eval<[number, number] | null>(`(() => { const F = window.__fid; if (!F) return null; const i = F.apiTimes.findIndex((e) => e[0] === ${JSON.stringify(method)} && e[1] === ${JSON.stringify(url)}); const t = i >= 0 ? F.apiTimes.splice(i, 1)[0][2] : F.clock.now; return [F.clock.epoch, F.clock.epoch + Math.floor(t)]; })()`, { timeoutMs: 30_000 }).catch(() => null);
      if (v !== null) { epoch = v[0]; virtualNow = v[1]; }
      return virtualNow || Date.now();
    },
    patchScript: (path, original) => {
      let source = original;
      if (opt.warmSheets) {
        const add = sheetLoaderExport(source);
        if (add) {
          modifications.push(`script ${path} (in memory, this side only): appended \`${add}\` so that the game's own sprite-sheet loader and its cache can be reached`);
          source += add;
        }
      }
      if (uuid) {
        // Port of the second rewrite of the headless module hook (three.js' generateUUID), pattern read from its file.
        const out = uuid.apply(source);
        if (out !== null) {
          uuidPatched++;
          modifications.push(`AS THE HEADLESS MODULE HOOK (D10): script ${path} served with three.js' generateUUID drawing its four numbers from \`globalThis.__pbUuidRandom\` (sfc32, seed 0x${uuid.seed.toString(16)}, defined before any page script, never restarted) instead of Math.random`);
          source = out;
        }
      }
      const m = TAIL.exec(source);
      if (m) {
        const [, app, App, , Run] = m;
        const injected = `globalThis.__pb={app:${app},App:${App},Run:${Run}};`;
        const at = m.index + `var ${app}=new ${App};`.length;
        modifications.push(`script ${path} (in memory, same as the headless module load hook): inserted \`${injected}\` after the app is constructed and \`;globalThis.__pb.booted=true;\` after \`await ${app}.boot()\``);
        source = source.slice(0, at) + injected + source.slice(at) + ';globalThis.__pb.booted=true;';
      }
      return source === original ? null : source;
    },
  });
  cdp = await chrome.launch();
  log(`chrome ${chrome.version.Browser}, V8 ${chrome.version['V8-Version']}`);

  const evalJson = async <T,>(expr: string, timeoutMs = 60_000): Promise<T> => JSON.parse(await cdp.eval<string>(`JSON.stringify(${expr})`, { timeoutMs })) as T;
  const evalAsync = async <T,>(expr: string, timeoutMs = 120_000): Promise<T> => JSON.parse(await cdp.eval<string>(`(async () => JSON.stringify(await (${expr})))()`, { awaitPromise: true, timeoutMs })) as T;

  /** Nothing the page asked for is in flight, on the wire or in the page, and it has been so for `quietMs`. */
  const quiet = async (): Promise<void> => {
    for (;;) {
      await chrome.networkQuiet(quietMs);
      let left: number;
      try { left = await cdp.eval<number>('window.__fid ? window.__fid.settle(2) : -1', { awaitPromise: true, timeoutMs: 60_000 }); } catch { left = -1; }
      if (left === -1) { await sleep(25); continue; }
      if (chrome.inflight === 0 && performance.now() - chrome.lastActivity >= quietMs) return;
    }
  };
  /** Port of `Sim.pump`: display frames of the virtual clock until `done`; "one turn of the event loop" is `quiet()`. */
  const pump = async (done: string, what: string, maxFrames = 7200): Promise<number> => {
    const started = performance.now();
    for (let n = 0; ; n++) {
      await quiet();
      const state = await cdp.eval<string>(`(() => { try { return (${done}) ? 'done' : 'more'; } catch (e) { return 'error: ' + e; } })()`);
      if (state === 'done') return n;
      if (state !== 'more') throw new Error(`[browser] while waiting for ${what}: ${state}`);
      if (n >= maxFrames || performance.now() - started > 180_000) throw new Error(`[browser] gave up waiting for: ${what} (${n} frames)\n` + (await evalJson<string[]>('window.__fid.problems.slice(-8)')).join('\n'));
      await cdp.eval('window.__fid.frame()');
    }
  };
  /** Port of `HeadlessGameEnvironment.settle`: a promise of the game, with the frame loop driven meanwhile. */
  const settleTask = async <T,>(name: string, expr: string): Promise<T> => {
    await cdp.eval(`window.__fid.begin(${JSON.stringify(name)}, () => ${expr})`);
    await pump(`window.__fid.tasks[${JSON.stringify(name)}].done`, name);
    const t = await evalJson<{ value: T; error: string | null }>(`window.__fid.tasks[${JSON.stringify(name)}]`);
    if (t.error) throw new Error(`[browser] ${name}: ${t.error}`);
    return t.value;
  };

  const result: SideResult = {
    side: 'browser', options: opt,
    engine: { browser: chrome.version.Browser, v8: chrome.version['V8-Version'], userAgent: chrome.version['User-Agent'] },
    session: ref.session, account: ref.account, bootProfile: ref.bootProfile, unlockReplies: [], season: {}, registrySources: {}, chunks: [], storage: [],
    marks: [], api, lines: [], details: {}, actions: [], decisions: [], static: null, sheets: null, end: null, stop: '', problems: [], gameErrors: [], blocked: chrome.blocked,
    timing: { resetMs: 0, playMs: 0 }, browser: {},
  };
  const facts: Record<string, unknown> = (result.browser = { modifications });

  try {
    // ---- port of `Sim.boot`: the prepared session in localStorage, then the page ----
    const agent = buildAgentSource({
      seed, hz: 60, storage: [['pb.session', JSON.stringify(ref.session)]], script: opt.script, maxSteps: opt.maxSteps, stopAtDialog: opt.stopAtDialog, detail: opt.detail,
      dialogCapture: o.dialogCapture !== false, renderEvery: o.renderEvery ?? 0, commonMath: !!opt.commonMath, trace: opt.trace ?? null,
      asShim, uuidSeed: uuid ? uuid.seed : null,
    });
    for (const k of asShim) {
      if (k === 'uuid') continue; // listed when the three.js chunk is served
      if (k === 'request') modifications.push('AS THE SHIM (D2): `new Request(url, { signal })` and `new Request(relativeUrl)` throw a TypeError, as they do under the headless shims; three.js\' FileLoader is the only caller, so no 3D model is ever requested');
      else if (k === 'audio-clock') modifications.push('AS THE SHIM (D3): while an AudioContext is suspended its `currentTime` and `getOutputTimestamp()` report the page clock (the shim\'s clock runs although it says "suspended")');
      else throw new Error(`unknown --browser-as-shim item "${k}" (known: request, audio-clock, uuid)`);
    }
    if (opt.commonMath) modifications.push('Math.sin, cos, tan, asin, acos, atan, atan2, sinh, cosh, tanh, asinh, acosh, atanh, exp, expm1, log, log1p, log2, log10, cbrt replaced by src/fidelity/commonMath.ts (the headless side of this run has the same replacement)');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: agent });
    await cdp.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' }).catch(() => {});
    modifications.push(
      `a script evaluated before any page script (${agent.length} characters, src/fidelity/pageAgent.ts): virtual clock (performance, Date, setTimeout, setInterval, requestAnimationFrame, requestIdleCallback), seeded Math.random / crypto.getRandomValues / crypto.randomUUID and synchronous crypto.subtle.digest (the code of src/sim/clock.ts and src/sim/rng.ts)`,
      'the same script wraps, to know when asynchronous work is finished: window.fetch (and the body readers of its responses), the `src` setter of HTMLImageElement, createImageBitmap, BaseAudioContext.decodeAudioData; and observes <link> insertions',
      'the same script wraps console.warn / console.error to keep the messages, clears localStorage and sessionStorage of the origin, and writes the prepared session to localStorage `pb.session`',
      'requests: every request of the page is answered from memory by CDP Fetch (files of mirror/, the mock API with the ticket seed and id pinned); nothing listens on the page\'s port',
      'CDP emulation: viewport 1280 × 720 at device pixel ratio 1, focus emulation, user input ignored',
    );
    await cdp.send('Page.navigate', { url: PAGE_URL });
    const bootFrames = await pump('window.__pb && window.__pb.booted === true', 'boot() to return');
    if (!(await cdp.eval<boolean>('!!window.__pb.app.meta.profile'))) throw new Error('[browser] boot() returned without a signed-in profile');
    epoch = await cdp.eval<number>('window.__fid.clock.epoch');
    facts.bootFrames = bootFrames;
    facts.uuidPatched = uuidPatched;
    if (uuid && uuidPatched !== 1) throw new Error(`[browser] three.js' generateUUID was rewritten in ${uuidPatched} served chunk(s); expected exactly 1 (as the headless module hook)`);
    if (uuid && ref.engine.uuidPatched !== 1) throw new Error(`[browser] --browser-as-shim=uuid was asked for, but the headless side rewrote three.js' generateUUID in ${String(ref.engine.uuidPatched)} chunk(s): the environment has changed, re-read src/sim/loader.ts`);
    const refBoot = ref.marks.find((m) => m.kind === 'booted')?.frames ?? bootFrames;
    if (o.alignClock !== false && refBoot > bootFrames) {
      for (let i = bootFrames; i < refBoot; i++) await cdp.eval('window.__fid.frame()');
      modifications.push(`${refBoot - bootFrames} extra display frame(s) pumped right after boot, so that the page clock reads the same as the headless one from there on`);
    }
    await cdp.eval(`window.__fid.mark('booted')`);
    log(`booted after ${bootFrames} frame(s), ${Math.round(performance.now() - t0)} ms`);

    // ---- only here: the game's sheet cache warm before any run exists (the page clock does not move meanwhile) ----
    if (opt.warmSheets) {
      const tW = performance.now();
      const dirs = ['pmd', 'pmd-forms', 'pmd-shiny', 'front'];
      const paths = dirs.flatMap((d) => { try { return readdirSync(join(REPO, 'mirror', 'assets', d)).filter((f) => f.endsWith('.png')).sort().map((f) => `${d}/${f}`); } catch { return []; } });
      const clockBefore = await cdp.eval<number>('window.__fid.clock.now');
      const warm = await evalAsync<Record<string, unknown>>(`window.__fid.warmSheets(${JSON.stringify(paths)})`, 600_000);
      await quiet();
      facts.warmSheets = { ...warm, ms: Math.round(performance.now() - tW), clockMoved: (await cdp.eval<number>('window.__fid.clock.now')) - clockBefore };
      if ((warm.failed as string[]).length) throw new Error(`[browser] ${(warm.failed as string[]).length} sprite sheet(s) did not load while warming the game's cache: ${(warm.failed as string[]).slice(0, 5).join(', ')}`);
      modifications.push(`the game's sprite-sheet cache warmed before the run: all ${paths.length} sheets of mirror/assets/{${dirs.join(',')}} loaded once through the game's own loader; \`get\` / \`delete\` of that cache map wrapped so that an entry the game's memory trim removes is put back when asked for (the headless image shim delivers every sheet inside the request)`);
      log(`sheet cache warm: ${warm.warmed} of ${paths.length} sheets, ${Math.round(performance.now() - tW)} ms`);
    }

    // ---- port of `HeadlessGameEnvironment.boot` ----
    const chunksNow = () => chrome.served.filter((r) => r.kind === 'file' && r.status === 200 && new URL(r.url).pathname.endsWith('.js')).map((r) => new URL(r.url).pathname).filter((p, i, a) => a.indexOf(p) === i);
    const reg = await evalAsync<{ sources: Record<string, string>; season: { season: number; name: string; biomes: string[] }; tiers: number; maps: string[]; rng: number; release: unknown }>(`window.__fid.readRegistries(${JSON.stringify(chunksNow())})`);
    result.registrySources = reg.sources;
    modifications.push('read-only: `import()` of the already-loaded chunk URLs from the page context to read the game\'s registries (same function as headless)');
    mock.season = localRankedSeason(reg.season.season, reg.season.name, reg.season.biomes, epoch);
    result.season = JSON.parse(JSON.stringify(mock.season));
    await settleTask('status', 'window.__pb.app.backend.status()');
    const season = await evalJson<{ live?: boolean; ranked?: boolean; maps?: string[] }>('window.__pb.app.backend.season()');
    if (!(season?.live && season?.ranked && Array.isArray(season?.maps) && season.maps.length)) throw new Error(`[browser] the game does not see a live ranked season: ${JSON.stringify(season)}`);
    // Both sides adopt the identical profile: the replies the headless side's /dev/unlock gave, in order.
    mock.unlockPreset = () => {
      const reply = ref.unlockReplies[Math.min(unlocks++, ref.unlockReplies.length - 1)] as { profile: Record<string, unknown> };
      result.unlockReplies.push(structuredClone(reply));
      return structuredClone(reply.profile);
    };
    await settleTask('devUnlock', 'window.__pb.app.meta.devUnlock()');
    facts.unlock = await evalJson('window.__fid.verifyUnlocked()');
    // Port of the hunt-counter block: a second devUnlock, whose reply carries `hunt` (the headless side's second reply).
    await settleTask('devUnlock (hunt counters)', 'window.__pb.app.meta.devUnlock()');
    const base = await evalJson<{ quality: string; fpsCap: number; settings: string }>('window.__fid.baselineTake()');
    facts.settings = JSON.parse(base.settings);
    facts.quality = base.quality; facts.appFpsCap = base.fpsCap;
    modifications.push('app.launch on the app instance: wrapped to restart the random streams right before the run is built (same as headless)');
    modifications.push('entropy: Math.random, crypto and the `s` field of the game\'s module-level generator are set at run construction and when a zone finishes loading (same as headless)');

    // ---- port of `HeadlessGameEnvironment.reset` (first episode of the process: no run to close) ----
    seed = opt.seed >>> 0; tickets = 0;
    await cdp.eval(`window.__fid.simReseed(${seed})`);
    await cdp.eval('window.__fid.restoreStorage()');
    await settleTask('devUnlock (profile reset)', 'window.__pb.app.meta.devUnlock()');
    {
      const wantHunt = JSON.stringify((ref.unlockReplies[ref.unlockReplies.length - 1] as { profile: { hunt?: unknown } }).profile.hunt ?? null);
      const gotHunt = await cdp.eval<string>('window.__fid.huntJson()');
      if (gotHunt !== wantHunt) throw new Error(`[browser] the game did not adopt the hunt counters of this episode: ${gotHunt} instead of ${wantHunt}`);
      facts.hunt = JSON.parse(gotHunt);
      if (unlocks !== ref.unlockReplies.length) throw new Error(`[browser] the port made ${unlocks} devUnlock calls, the headless side ${ref.unlockReplies.length}: the reset sequence of the environment has changed, re-read browserRun.ts`);
    }
    if (!(await cdp.eval<boolean>('window.__fid.restoreProfile()'))) throw new Error('[browser] the profile did not return to its starting state at reset');
    facts.profileSha = createHash('sha256').update(await cdp.eval<string>('window.__fid.profileDigestSource()')).digest('hex');
    const cfg = { species: opt.species, biome: opt.map, tier: opt.tier, boosts: [], mode: 'standard', competitive: true };
    await cdp.eval(`window.__fid.begin('startRun', () => window.__pb.app.startRun(${JSON.stringify(cfg)}))`);
    const startFrames = await pump(`window.__fid.tasks.startRun.done`, 'app.startRun() to settle');
    const started = await evalJson<{ value: unknown; error: string | null }>('window.__fid.tasks.startRun');
    if (started.error || started.value !== true || !(await cdp.eval<boolean>('!!window.__pb.app.run'))) throw new Error(`[browser] startRun returned ${JSON.stringify(started)}\n` + (await evalJson<string[]>('window.__fid.problems.slice(-8)')).join('\n'));
    if (o.dialogCapture !== false) {
      const d = await evalJson<{ replaced: string[]; names: Record<string, string> }>('window.__fid.installDialogs()');
      facts.buildNames = d.names;
      modifications.push(`HUD instance of the run: ${d.replaced.length} dialog methods replaced by the environment's DialogCapture (same class as headless)`);
    } else modifications.push('HUD: untouched; the episode stops when the first dialog opens');
    if (opt.preloadSheets?.length) {
      await cdp.eval(`window.__fid.sheetsAsk(${JSON.stringify(opt.preloadSheets)})`);
      modifications.push(`sprite sheets ${opt.preloadSheets.join(', ')} requested from the game's sprite cache when the run was created (the headless side of this run does the same)`);
    }
    const loadFrames = await pump(`window.__pb.app.run.state !== 'transition'`, 'the run to leave its loading phase');
    const got = await evalJson<Record<string, unknown>>('window.__fid.runFacts()');
    const want = { species: cfg.species, map: cfg.biome, tier: cfg.tier, mode: 'standard', competitive: true, seed, state: 'play' };
    for (const [k, v] of Object.entries(want)) if (got[k] !== v) throw new Error(`[browser] the run the game started is not the run that was asked for: ${JSON.stringify({ want, got })}`);
    await cdp.eval(`window.__fid.envReseed(${seed}, window.__pb.app.run.stage | 0)`);
    facts.realTimeAfterLoading = await cdp.eval<number>('window.__pb.app.run.realTime');
    await cdp.eval('window.__fid.setRealTime(0)');
    await cdp.eval(`window.__fid.mark('play', { rngBefore: window.__fid.reg.rng.s })`);
    const modelsAtReset = await evalJson<Record<string, unknown>>('window.__fid.modelFacts()');
    facts.frames = { boot: bootFrames, startRun: startFrames, loading: loadFrames };
    result.storage = await evalJson('window.__fid.storage()');
    result.timing.resetMs = performance.now() - t0;
    log(`run started: startRun ${startFrames} frame(s), loading ${loadFrames} frame(s), ${Math.round(result.timing.resetMs)} ms`);
    const requestsAtPlay = chrome.served.length;

    if (opt.static) result.static = await evalJson('window.__fid.static()');
    await cdp.eval('window.__fid.record()'); // line 0
    result.lines.push(...(await evalJson<unknown[][]>('window.__fid.lines')));

    // ---- the scripted episode, in slices ----
    if (opt.maxSteps > 0) {
      const t1 = performance.now();
      for (;;) {
        const until = result.lines.length + 300;
        const slice = await evalAsync<{ lines: unknown[][]; stop: string }>(`window.__fid.play(${until})`, 300_000);
        result.lines.push(...slice.lines);
        if (slice.stop) { result.stop = slice.stop; break; }
      }
      result.timing.playMs = performance.now() - t1;
      log(`episode: ${result.lines.length - 1} steps, stop "${result.stop}", ${Math.round(result.timing.playMs)} ms`);
      if (result.stop === 'run over') {
        await pump('!!window.__pb.app.run.sent', 'the game to post the end-of-run result');
        const rec = finished[finished.length - 1];
        const record = rec?.result ? JSON.parse(JSON.stringify(rec.result)) : null;
        result.end = record ? { how: String(record.end?.how ?? 'unknown'), victory: !!record.victory, record } : null;
      }
    }
    result.actions = await evalJson('window.__fid.actions');
    result.seekLog = await evalJson('window.__fid.seekLog()');
    result.dialogKinds = await evalJson('window.__fid.dialogKinds()');
    result.decisions = await evalJson('window.__fid.decisions');
    result.details = await evalJson('window.__fid.details');
    if (opt.trace) result.trace = await evalJson('window.__fid.trace');
    facts.requestsDuringPlay = chrome.served.slice(requestsAtPlay).map((r) => `${r.method} ${r.url.replace(ORIGIN, '').replace(`https://${API_HOST}`, 'api:')} → ${r.status}`);

    if (opt.sheets?.length) {
      const out: unknown[] = [];
      for (let at = 0; at < opt.sheets.length; at += 12) {
        const group = JSON.stringify(opt.sheets.slice(at, at + 12));
        await cdp.eval(`window.__fid.sheetsAsk(${group})`);
        try { await pump(`window.__fid.sheetsReady(${group})`, `sprite sheets ${group}`, 1200); } catch { /* reported as not ready */ }
        out.push(...(await evalJson<unknown[]>(`window.__fid.sheetsRead(${group})`)));
      }
      result.sheets = out;
    }

    if (o.renderEvery || o.screenshot) await cdp.eval('window.__fid.draw()').catch(() => {});
    if (o.screenshot) await chrome.screenshot(o.screenshot).catch(() => {});
    result.marks = await evalJson('window.__fid.marks');
    result.audio = await evalJson('window.__fid.audioFacts()');
    result.storageEnd = await evalJson('window.__fid.storage()');
    result.assetsDuringPlay = chrome.served.slice(requestsAtPlay).filter((r) => r.kind === 'file').map((r) => new URL(r.url).pathname);
    result.spritesDuringPlay = [...new Set(result.assetsDuringPlay.map((p) => /assets[/]pmd(?:-forms)?[/]([0-9]+)[.]png$/.exec(p)?.[1]).filter(Boolean).map(Number))];
    result.sheetsDuringPlay = [...new Set(result.assetsDuringPlay.map((p) => /assets[/]((?:pmd|pmd-forms|pmd-shiny|front)[/][^/]+[.]png)$/.exec(p)?.[1]).filter(Boolean) as string[])];
    result.requestThrows = await evalJson('window.__fid.requestThrows');
    result.models = { atReset: modelsAtReset, atEnd: await evalJson('window.__fid.modelFacts()') };
    result.preset = ref.preset;
    result.profileSha = createHash('sha256').update(JSON.stringify((result.unlockReplies[result.unlockReplies.length - 1] as { profile?: unknown })?.profile ?? null)).digest('hex');
    facts.sheetCache = await evalJson('window.__fid.sheets');
    result.chunks = chunksNow();
    facts.notes = await evalJson('window.__fid.notes');
    facts.page = await evalJson(`({ audioState: (() => { try { return [...new Set((window.__fidAudio || []).map((c) => c.state))]; } catch { return null; } })(), pointerLock: !!document.pointerLockElement, hidden: document.hidden, focus: document.hasFocus(), dpr: devicePixelRatio, inner: [innerWidth, innerHeight], input: { locked: window.__pb.app.input.locked, dragLook: window.__pb.app.input.dragLook, lockFails: window.__pb.app.input.lockFails }, pendingKinds: window.__fid.pend, frames: window.__fid.frames, clock: window.__fid.clock.now, timers: window.__fid.clock.pendingTimers() })`);
    facts.gl = await evalJson(`(() => { try { const c = document.getElementById('game'); const gl = c.getContext('webgl2'); const ext = gl && gl.getExtension('WEBGL_debug_renderer_info'); return { canvas: [c.width, c.height], version: gl && gl.getParameter(gl.VERSION), renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null }; } catch (e) { return { error: String(e) }; } })()`);
    try { result.gameErrors = (JSON.parse((await cdp.eval<string | null>(`localStorage.getItem('pb-errs')`)) ?? '{}').l ?? []) as string[]; } catch { /* none */ }
    result.platform = await evalJson('window.__fid.platformFacts()'); // last: it creates canvases and an <audio> element of its own
  } finally {
    try { result.problems = await evalJson<string[]>('(window.__fid ? window.__fid.problems : []).slice(0, 50)'); } catch { /* page gone */ }
    facts.requests = { total: chrome.served.length, files: chrome.served.filter((r) => r.kind === 'file').length, api: chrome.served.filter((r) => r.kind === 'api').length, missing: chrome.served.filter((r) => r.kind === 'file' && r.status === 404).map((r) => r.url.replace(ORIGIN, '')), patched: chrome.patched };
    if (o.lingerMs) await sleep(o.lingerMs);
    await chrome.close();
    try { rmSync(storeDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return result;
}
