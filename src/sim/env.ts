import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { MockApi } from '../sandbox/mockApi.ts';
import { Store } from '../sandbox/store.ts';
import { initLogger } from '../logger.ts';
import { extractSnapshot } from '../observations/extract.ts';
import { VirtualClock, real } from './clock.ts';
import { Net, ORIGIN } from './net.ts';
import { installLoader } from './loader.ts';
import type { LoaderInfo } from './loader.ts';
import { installBrowser } from './browser.ts';
import type { Browser } from './browser.ts';
import { installSeededEntropy } from './rng.ts';
import type { SeededEntropy } from './rng.ts';
import { canvasStats } from './canvas2d.ts';
import { assertOfflineConfig, installNetworkGuard } from './guard.ts';
import type { NetworkGuard } from './guard.ts';

/**
 * Headless game process: the mirrored bundle running inside Node on browser shims, a virtual clock and the in-process
 * mock API. One `Sim` per Node process (the shims are global and the bundle keeps module-level state).
 *
 *   const sim = await Sim.boot({ seed: 1 });
 *   await sim.startRun({ species: 155, biome: 'forest', tier: 0, boosts: [], mode: 'standard' });
 *   sim.setKeys(['KeyW']);  await sim.step();  sim.snapshot();  sim.terminal();
 *
 * What is the game's and what is ours:
 *   - game code, untouched: everything in mirror/ (boot, menus, the run, its HUD, its HTTP client);
 *   - ours: the shims (browser.ts), the clock, the fetch router, and three instrumentation points listed in
 *     `Sim.instrumentation`.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface RunConfig { species: number; biome: string; tier: number; boosts: string[]; mode: string }
export const DEFAULT_RUN: RunConfig = { species: 155, biome: 'forest', tier: 0, boosts: [], mode: 'standard' };

export interface SimOptions {
  /** Seeds Math.random / crypto and is issued as the run ticket's seed. */
  seed: number;
  /** Simulation rate. The game clamps a frame's dt to 1/20 s, so 20 is the coarsest step it accepts. */
  hz?: number;
  /**
   * The game's own "FPS limit" setting (Settings → Graphics: 0 = none, 30, 60, 90, 120, 144), stored in the profile.
   * It matters to the simulation: the run measures its frame rate and, below 45 fps (or 75 % of this limit), cuts the
   * cap on live enemies from 800 towards 500 once a horde gets that big. See `governor()`.
   */
  fpsLimit?: number;
  /** Also call the game's renderer (against the null GL context) every step. Off: sim only. */
  render?: boolean;
  /** Print the page's console.warn/error as they happen. */
  verbose?: boolean;
  dataDir?: string;
  /**
   * DEBUG ONLY (the proof-of-concept script uses it): let the driver answer dialogs by itself. Level-up offers are
   * answered through the game's callback with `pickOffer`; any other dialog gets its first enabled DOM button clicked
   * after half a second. Off by default: the environment (src/environment) captures every dialog as a structured
   * decision and never clicks anything.
   */
  debugAutoAnswer?: boolean;
  /** With `debugAutoAnswer`: called when the game offers level-up choices; returns the index to take. Default: the first. */
  pickOffer?: (offers: any[], run: any) => number;
  /** Make the local account a registered one (not a guest). The game's menu only offers Ranked to registered accounts. */
  registered?: boolean;
  /**
   * Who answers the game's API calls. Only `in-process-mock` (the default) is accepted; the field exists so that a
   * configuration naming a real endpoint is refused at startup instead of silently ignored.
   */
  apiTarget?: string;
  /** Skip the network guard's startup self-test (about 20 refused probes). For unit tests of other things only. */
  skipSelfTest?: boolean;
}

export interface Timing { steps: number; updateMs: number; timersMs: number; renderMs: number; yieldMs: number; bootMs: number; startMs: number }

/** Let promise chains and Node's own async work run to completion (one real macrotask turn). */
const turn = () => new Promise<void>((r) => real.setImmediate(r));

export class Sim {
  readonly opt: Required<Omit<SimOptions, 'dataDir' | 'pickOffer' | 'fpsLimit'>> & { fpsLimit: number; dataDir: string; pickOffer: (offers: any[], run: any) => number };
  /** Node-level offline guard (net, tls, http, https, http2, dns, dgram, fetch, WebSocket): installed before anything else. */
  readonly guard: NetworkGuard;
  readonly clock: VirtualClock;
  readonly net: Net;
  readonly browser: Browser;
  readonly loader: LoaderInfo;
  readonly entropy: SeededEntropy;
  readonly store: Store;
  readonly api: MockApi;
  readonly timing: Timing = { steps: 0, updateMs: 0, timersMs: 0, renderMs: 0, yieldMs: 0, bootMs: 0, startMs: 0 };
  /** Every place where sim code is spliced into game code. */
  readonly instrumentation: string[] = [];
  /** Things the driver did on the game's behalf (offers picked, modals clicked, forced resumes). */
  readonly events: { t: number; what: string }[] = [];
  private held = new Set<string>();
  private pendingOffer: { offers: any[]; cb: (o: any, how?: string) => void } | null = null;
  private dtMs: number;
  private tickets = 0;
  /** Seed of the current episode: Math.random / crypto streams and the run ticket. `reseed()` changes it. */
  private seed: number;
  /** The local account the game is signed in as. */
  session: { id: string; name: string; token: string; guest: boolean } | null = null;

  private constructor(opt: SimOptions) {
    const dataDir = opt.dataDir ?? join(REPO, 'data', 'sim-poc', `${process.pid}-${real.Date.now().toString(36)}`);
    this.opt = {
      seed: opt.seed >>> 0, hz: opt.hz ?? 20, fpsLimit: opt.fpsLimit ?? 0, render: !!opt.render, verbose: !!opt.verbose, dataDir, pickOffer: opt.pickOffer ?? (() => 0),
      debugAutoAnswer: !!opt.debugAutoAnswer, registered: !!opt.registered, apiTarget: opt.apiTarget ?? 'in-process-mock', skipSelfTest: !!opt.skipSelfTest,
    };
    this.seed = this.opt.seed;
    // Offline first: refuse a configuration that names a real endpoint, then take Node's network primitives away,
    // before any game code or DOM library is loaded.
    assertOfflineConfig({ pageOrigin: ORIGIN, apiTarget: this.opt.apiTarget, mirrorDir: join(REPO, 'mirror') });
    this.guard = installNetworkGuard();
    if (!(this.opt.hz >= 20)) throw new Error('hz must be at least 20: the game clamps dt to 1/20 s, a slower rate would lose game time');
    this.dtMs = 1000 / this.opt.hz;
    initLogger('warn');
    mkdirSync(dataDir, { recursive: true });
    this.store = new Store(dataDir);
    this.api = new MockApi(this.store);
    // Ids come from a fixed sequence, not from the operating system: the game hashes the account id into gameplay
    // rolls (which legendary can appear as a capture encounter), so it has to be the same in every process.
    let ids = 0;
    this.api.newId = (bytes = 12) => createHash('sha256').update(`pb-sim-id|${ids++}`).digest('hex').slice(0, bytes * 2);
    this.clock = new VirtualClock();
    this.net = new Net({
      mirrorDir: join(REPO, 'mirror'),
      api: this.api,
      Response: globalThis.Response,
      // The mock draws the ticket's seed and id at random (node:crypto). Both feed the game's own generators (the id
      // is hashed into the seed of the level-up and drop rolls), so both are pinned at the fetch boundary; the n-th
      // run of a process gets a distinct, reproducible id.
      pinTicket: () => ({ seed: this.seed, id: createHash('sha256').update(`pb-sim:${this.seed}:${this.tickets++}`).digest('hex').slice(0, 24) }),
    });
    this.instrumentation.push('fetch layer: in the POST /runs reply the mock\'s random `seed` and ticket `id` are replaced (seed = the episode seed, id = hash of the seed and the number of tickets issued since the last reseed); /runs/<id>/… request paths are translated back to the mock\'s id');
    this.loader = installLoader(join(REPO, 'mirror'));
    this.browser = installBrowser({ net: this.net, clock: this.clock, quietConsole: !this.opt.verbose });
    this.entropy = installSeededEntropy(this.opt.seed);
  }

  get pb(): { app: any; App: any; Run: any; booted?: boolean } | undefined { return (globalThis as any).__pb; }
  get app(): any { return this.pb?.app; }
  get run(): any { return this.pb?.app?.run ?? null; }

  /** Advance the virtual clock in display frames, running the game's own requestAnimationFrame loop, until `done()`. */
  async pump(done: () => boolean, what: string, maxVirtualMs = 120_000, maxRealMs = 180_000): Promise<void> {
    const t0 = real.performanceNow(), v0 = this.clock.now;
    for (;;) {
      await turn();
      if (done()) return;
      if (this.clock.now - v0 > maxVirtualMs || real.performanceNow() - t0 > maxRealMs)
        throw new Error(`[sim] gave up waiting for: ${what} (virtual ${(this.clock.now - v0) | 0} ms, real ${(real.performanceNow() - t0) | 0} ms)\n` + this.browser.problems.slice(-8).join('\n'));
      this.clock.advance(1000 / 60);
      this.clock.frame();
    }
  }

  /**
   * Start a new episode's random streams: Math.random and crypto restart from `seed`, the next run ticket carries
   * `seed` and the id derived from it (ticket counter back to zero).
   */
  reseed(seed: number): void {
    this.seed = seed >>> 0;
    this.tickets = 0;
    this.entropy.reseed(this.seed);
  }

  get currentSeed(): number { return this.seed; }

  static async boot(opt: SimOptions): Promise<Sim> {
    const sim = new Sim(opt);
    const t0 = real.performanceNow();
    const g = globalThis as any;
    if (!sim.opt.skipSelfTest) {
      const test = await sim.guard.selfTest();
      if (!test.ok) throw new Error('[sim] offline self-test FAILED, refusing to load the game. Not blocked: ' + test.probes.filter((p) => !p.blocked).map((p) => `${p.name} (${p.detail})`).join('; '));
    }

    // The page: index.html's markup (canvas#game, div#ui, meta tags). Its inline scripts (boot-failure recovery card,
    // theme pre-paint) are not evaluated; the module entry is imported below instead of through a <script> tag.
    const html = readFileSync(join(REPO, 'mirror', 'index.html'), 'utf8');
    g.document.write(html);
    g.document.close?.();
    const entry = /<script type="module"[^>]*\ssrc="\.\/(assets\/[^"]+\.js)"/.exec(html)?.[1];
    if (!entry) throw new Error('[sim] no module entry in mirror/index.html');
    if (!g.document.getElementById('game') || !g.document.getElementById('ui')) throw new Error('[sim] index.html did not produce #game and #ui');

    // A ready-made guest account whose profile already has its starters, so no menu has to be clicked.
    const session = (await sim.api.handle('POST', '/auth/guest', {}, {})).json as { id: string; name: string; token: string; guest: boolean };
    if (sim.opt.registered) {
      const acc = sim.store.accountByToken(session.token)!;
      acc.guest = false;
      sim.store.putAccount(acc);
      session.guest = false;
    }
    sim.session = session;
    const profile = sim.store.profile(session.id)!;
    Object.assign(profile, { starter: 4, starterJ: 155, lastSpecies: 155, unlocked: [4, 155], league: [4, 155] });
    if (sim.opt.fpsLimit) profile.settings = { ...profile.settings, fpsLimit: String(sim.opt.fpsLimit) };
    sim.store.putProfile(session.id, profile);
    g.localStorage.setItem('pb.session', JSON.stringify(session));
    if (session.guest) g.localStorage.setItem('pb.guest', JSON.stringify(session));

    let failed: unknown = null;
    import(`${ORIGIN}/${entry}`).catch((e) => { failed = e; });
    await sim.pump(() => { if (failed) throw failed; return !!sim.pb?.booted; }, 'boot() to return');
    if (!sim.app.meta?.profile) throw new Error('[sim] boot() returned without a signed-in profile\n' + sim.browser.problems.join('\n'));
    if (sim.loader.uuidPatched !== 1) throw new Error(`[sim] three.js' UUID generator was found in ${sim.loader.uuidPatched} chunks, expected exactly 1: this build is not supported (its UUIDs would draw from the game's random stream)`);
    sim.instrumentation.push('module load hook (in memory): in the three.js chunk, the four Math.random() calls of generateUUID are pointed at a private stream (globalThis.__pbUuidRandom), so creating a three.js object (many are created lazily and cached per process) does not move the random numbers of play');
    sim.instrumentation.push(`module load hook (in memory): inserted \`${sim.loader.injected}\` after the app is constructed, and \`globalThis.__pb.booted=true;\` after \`await app.boot()\``);
    sim.timing.bootMs = real.performanceNow() - t0;
    return sim;
  }

  /** `app.startRun(cfg)` (the call the menu's Play button makes), then the game's own loading phase until play begins. */
  async startRun(cfg: RunConfig & { competitive?: boolean } = DEFAULT_RUN, onRunCreated?: (app: any) => void): Promise<void> {
    const t0 = real.performanceNow();
    const app = this.app;
    let res: unknown, err: unknown, settled = false;
    app.startRun({ ...cfg }).then((v: unknown) => { res = v; settled = true; }, (e: unknown) => { err = e; settled = true; });
    await this.pump(() => settled, 'app.startRun() to settle');
    if (err) throw err;
    if (res !== true || !app.run) throw new Error(`[sim] startRun returned ${String(res)} and no run was created\n` + this.browser.problems.slice(-8).join('\n'));

    if (this.opt.debugAutoAnswer) {
      // Level-up choices: the HUD would build a card dialog and wait for a click. Keep the offers and the game's own
      // callback instead; step() answers through that callback between two updates, where the click would land.
      app.hud.showLevelUp = (_run: unknown, offers: any[], cb: (o: any, how?: string) => void) => { this.pendingOffer = { offers, cb }; };
      const note = 'DEBUG auto-answer: hud.showLevelUp on the HUD instance is replaced and answered with the first offer; any other dialog gets its first DOM button clicked after 0.5 s';
      if (!this.instrumentation.includes(note)) this.instrumentation.push(note);
    }
    // The run and its HUD exist now and no dialog can have opened yet (state "transition"): the caller's moment to
    // replace HUD methods on this run's HUD instance.
    onRunCreated?.(app);

    // The run waits in state "transition" while its sprites load ("Preparing the zone"); the game's own loop drives that.
    await this.pump(() => app.run.state !== 'transition', 'the run to leave its loading phase', 60_000);
    this.timing.startMs = real.performanceNow() - t0;
  }

  /** Hold exactly these key codes (game bindings: KeyW/A/S/D, Space, ShiftLeft, KeyE, KeyR…). */
  setKeys(codes: Iterable<string>): void {
    const want = new Set(codes), input = this.app.input;
    for (const k of this.held) if (!want.has(k)) { input.release(k); this.held.delete(k); }
    for (const k of want) if (!this.held.has(k)) { input.press(k); this.held.add(k); }
  }

  /**
   * One simulation step: clock += dt (timers due in that interval run), `run.update(dt)`, `input.endFrame()`:
   * the body of the game's frame loop without gamepad polling and without the renderer.
   */
  async step(): Promise<void> {
    const app = this.app, run = app.run, T = this.timing;
    const dt = this.dtMs / 1000;
    let a = real.performanceNow();
    if (this.opt.debugAutoAnswer) this.answerModals(run);
    this.clock.advance(this.dtMs);
    let b = real.performanceNow(); T.timersMs += b - a; a = b;
    try { run.update(dt); } finally { app.input.endFrame(); }
    b = real.performanceNow(); T.updateMs += b - a; a = b;
    if (this.opt.render) { app.r.render(dt); b = real.performanceNow(); T.renderMs += b - a; a = b; }
    await turn();
    T.yieldMs += real.performanceNow() - a;
    T.steps++;
  }

  private modalSteps = 0;
  private answerModals(run: any): void {
    if (this.pendingOffer) {
      const { offers, cb } = this.pendingOffer;
      this.pendingOffer = null;
      const i = Math.max(0, Math.min(offers.length - 1, this.opt.pickOffer(offers, run) | 0));
      this.events.push({ t: run.time, what: `level-up: took offer ${i + 1}/${offers.length} (${offers[i]?.kind ?? '?'} ${offers[i]?.key ?? ''})` });
      cb(offers[i]);
      this.modalSteps = 0;
      return;
    }
    if (run.state !== 'modal' && run.state !== 'paused') { this.modalSteps = 0; return; }
    // Any other dialog the game opened by itself: after half a second, click its first enabled button, like a player
    // who takes the first option. Recorded so the report can list which dialogs appeared.
    if (++this.modalSteps < this.opt.hz / 2) return;
    this.modalSteps = 0;
    if (run.state === 'paused') { this.events.push({ t: run.time, what: 'run was paused by the game: resumed' }); run.resume(); return; }
    const el = this.app.hud?.modalEl;
    const btn = el?.isConnected ? [...el.querySelectorAll('button')].find((x: any) => !x.disabled && !x.hidden) : null;
    this.events.push({ t: run.time, what: `dialog "${String(el?.className ?? 'none')}": ${btn ? `clicked "${String(btn.textContent).trim().slice(0, 40)}"` : 'no button to click'}` });
    (btn as any)?.click();
  }

  /** The existing observation extractor (src/bot/extract.ts), run in-process against the live run object. */
  snapshot(): any { return extractSnapshot.call(this.run); }

  /** null while the episode goes on, else why it ended. */
  terminal(): string | null {
    const run = this.run;
    if (!run) return 'no run';
    if (run.state === 'over') return run.player?.dead ? 'over (player dead)' : 'over';
    if (run.state === 'dead') return 'dead';
    return null;
  }

  /**
   * The game's frame-rate governor, as it stands: the cap on live enemies and the thresholds it is judged by.
   * `cut` is true once the game has lowered the cap because the measured frame rate (= hz here) was under `low`.
   */
  governor(): { hz: number; fpsCap: number; low: number; high: number; liveCap: number; liveMax: number; cut: boolean } {
    const run = this.run, cap = run.fpsCap || 0;
    return { hz: this.opt.hz, fpsCap: cap, low: cap ? Math.min(45, cap * 0.75) : 45, high: cap ? Math.min(55, cap * 0.92) : 55, liveCap: run.liveCap, liveMax: run.liveMax, cut: run.liveCap < run.liveMax };
  }

  /** Small state line for logs and digests. */
  brief(): { time: number; state: string; hp: number; maxHp: number; level: number; kills: number; alive: number; x: number; y: number; z: number; stage: number } {
    const run = this.run, p = run.player, E = run.enemies;
    let alive = 0;
    for (let i = 0; i < E.n; i++) if (E.alive[i] && !(E.dying[i] > 0) && !(E.flags[i] & (32768 | 65536))) alive++;
    return { time: run.time, state: run.state, hp: p.hp, maxHp: p.maxHp, level: p.level, kills: run.stats.kills, alive, x: p.pos.x, y: p.pos.y, z: p.pos.z, stage: run.stage };
  }

  /**
   * Elements in the document that point at another origin and would make a browser fetch (scripts, frames,
   * stylesheets, media). The DOM library never loads any of them; this lists what a browser would have asked for.
   */
  externalRefs(): string[] {
    const out = new Set<string>();
    const doc = (globalThis as any).document;
    for (const el of doc.querySelectorAll('script[src], iframe[src], img[src], audio[src], video[src], source[src], link[rel~="stylesheet"][href], link[rel~="preload"][href], link[rel~="modulepreload"][href]')) {
      const raw = el.getAttribute('src') ?? el.getAttribute('href') ?? '';
      try { const u = new URL(raw, ORIGIN + '/'); if (u.origin !== ORIGIN && /^https?:$/.test(u.protocol)) out.add(`${el.tagName.toLowerCase()} ${u.href}`); } catch { /* not a URL */ }
    }
    return [...out];
  }

  report() {
    const mem = process.memoryUsage();
    return {
      timing: this.timing,
      memory: { rssMB: Math.round(mem.rss / 1048576), heapUsedMB: Math.round(mem.heapUsed / 1048576), externalMB: Math.round(mem.external / 1048576) },
      guard: { primitives: this.guard.primitives.length, attempts: this.guard.attempts, selfTest: this.guard.lastSelfTest ? { ok: this.guard.lastSelfTest.ok, probes: this.guard.lastSelfTest.probes.length } : null },
      net: { blocked: this.net.log.blocked, externalRefs: this.externalRefs(), missing: [...this.net.log.missing.entries()], api: [...this.net.log.api.entries()], files: this.net.log.files },
      images: { loaded: this.browser.images.loaded, failed: this.browser.images.failed, decoded: this.browser.images.decoded, decodeFailed: this.browser.images.decodeFailed, missing: [...this.browser.images.missing] },
      canvas: { ...canvasStats },
      entropy: { mathRandom: this.entropy.mathCalls(), crypto: this.entropy.cryptoCalls() },
      problems: this.browser.problems,
      gameErrors: this.browser.gameErrors,
      ignored: this.browser.ignored,
      chunks: this.loader.loaded,
      instrumentation: this.instrumentation,
      events: this.events,
      timersPending: this.clock.pendingTimers(),
    };
  }

  /** Remove this process's sandbox data folder. */
  cleanup(): void { try { rmSync(this.opt.dataDir, { recursive: true, force: true }); } catch { /* best effort */ } }
}
