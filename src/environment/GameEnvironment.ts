import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sim } from '../sim/env.ts';
import { real } from '../sim/clock.ts';
import { localRankedSeason } from '../sandbox/mockApi.ts';
import type { RunRecord } from '../sandbox/store.ts';
import { extractSnapshot } from '../bot/extract.ts';
import type { Nav, Snapshot } from '../bot/snapshot.ts';
import { ACTION_ENCODING_VERSION, actionLayout, encodeMask } from '../actions/codec.ts';
import { loadKnowledge } from '../knowledge/load.ts';
import { OBS_ENCODING_VERSION, ObservationEncoder } from '../observations/encode.ts';
import { STATE_SCHEMA, extractState } from '../observations/state.ts';
import { DialogCapture, HANDLED_METHODS, HANDLER_WRITES, REFUSED_METHODS, resolveBuildNames } from './dialogs.ts';
import type { BuildNames } from './dialogs.ts';
import { resolveGameFns } from './gamefns.ts';
import type { GameFns } from './gamefns.ts';
import { ARCHIVES, itemArchive, kitOf, loadValuationKnowledge } from '../agents/heuristic2/values.ts';
import { UNLOCKED_PRESET, playableMaps, readRegistries, unlockedProfile, verifyUnlocked } from './profile.ts';
import type { Registries, UnlockCheck } from './profile.ts';
import { ACTION_SCHEMA, DECISION_SCHEMA, InvalidActionError, MOVES, MOVE_VECTORS, OBSERVATION_SCHEMA, PLAY_BUTTONS, UnknownSituationError } from './types.ts';
import type {
  Action, ActionMask, ChoiceAction, ChoiceMask, EndOfRun, GameEnvironment, GameEnvironmentOptions, GameMetadata, Observation, PlayAction, PlayMask,
  ResetOptions, StepInfo, StepResult,
} from './types.ts';

/**
 * `GameEnvironment` over the headless game process (`Sim`): reset / step / observe with two phases.
 *
 *   play     real time. One `step` holds the action for `actionRepeat` simulation steps of 1/hz s.
 *   choice   a dialog is open. One `step` answers it through the game's own callback. Game time does not move.
 *
 * One environment per Node process (the browser shims are global). `reset()` can be called any number of times;
 * every reset restores the account, the browser storage and the random streams, so an episode depends only on its
 * reset options (see docs/environment.md, "Reproducibility").
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The game's default key bindings. */
const KEY = { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', jump: 'Space', dash: 'ShiftLeft', interact: 'KeyE', ultimate: 'KeyR', form: 'KeyF', incense: 'KeyC', fuse: 'KeyX' } as const;
/** One real macrotask turn: promise chains and Node's own asynchronous work run, the virtual clock does not move. */
const turn = (): Promise<void> => new Promise<void>((r) => real.setImmediate(r));
/** Turns a dialog answer may take before it is treated as a hang (a slot-machine spin settles in a handful). */
const MAX_ANSWER_TURNS = 2000;

/**
 * World direction → movement keys for a camera yaw. Same rule as `keysFor` in src/bot/session.ts: the game moves
 * "up" along (-sin yaw, -cos yaw).
 */
export function keysForMove(move: { x: number; z: number } | null, camYaw: number): string[] {
  if (!move) return [];
  const fx = -Math.sin(camYaw), fz = -Math.cos(camYaw), rx = Math.cos(camYaw), rz = -Math.sin(camYaw);
  const f = move.x * fx + move.z * fz, r = move.x * rx + move.z * rz;
  const keys: string[] = [];
  if (f > 0.38) keys.push(KEY.up); else if (f < -0.38) keys.push(KEY.down);
  if (r > 0.38) keys.push(KEY.right); else if (r < -0.38) keys.push(KEY.left);
  return keys;
}

/** Run states in which game time passes (or a scripted sequence plays) and no input has any effect. */
const WAITING_STATES = new Set(['transition', 'evolving', 'cinematic', 'capturing', 'dead']);
/** Upper bound on consecutive simulation steps spent in such a state before it is treated as a hang. */
const MAX_WAIT_STEPS = 60 * 120;

function deepFreeze<T>(v: T): T {
  // Typed arrays (the optional numeric encoding) cannot be frozen; they are fresh buffers nothing else holds.
  if (v && typeof v === 'object' && !ArrayBuffer.isView(v) && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

/** Validate a play action against the mask. Returns the reason it is invalid, or null. Exported for tests. */
export function playActionProblem(a: PlayAction, mask: PlayMask): string | null {
  const m = typeof a.move === 'number' ? a.move : MOVES.indexOf(a.move);
  if (!Number.isInteger(m) || m < 0 || m >= MOVES.length) return `move ${JSON.stringify(a.move)} is not one of ${MOVES.join(', ')} (or its index 0–${MOVES.length - 1})`;
  if (!mask.move[m]) return `move ${MOVES[m]} is masked`;
  for (const k of PLAY_BUTTONS) {
    if (a[k] !== undefined && typeof a[k] !== 'boolean') return `${k} must be a boolean`;
    if (a[k] && !mask[k]) return `${k} is masked: the game would not act on it now`;
  }
  for (const k of Object.keys(a)) if (!['type', 'move', ...PLAY_BUTTONS].includes(k)) return `unknown field "${k}" in a play action`;
  return null;
}

/** Validate a choice action against the mask. Returns the reason it is invalid, or null. Exported for tests. */
export function choiceActionProblem(a: ChoiceAction, mask: ChoiceMask): string | null {
  const hasOption = 'option' in a, hasExtra = 'extra' in a;
  if (hasOption === hasExtra) return 'a choice action needs exactly one of "option" or "extra"';
  if (hasOption) {
    const i = (a as { option: number }).option;
    if (!Number.isInteger(i) || i < 0 || i >= mask.options.length) return `option ${JSON.stringify(i)} is out of range: the dialog has ${mask.options.length} option(s)`;
    if (!mask.options[i]) return `option ${i} is masked`;
    return null;
  }
  const e = a as { extra: string; target?: number };
  if (!Object.hasOwn(mask.extras, e.extra)) return `this dialog has no extra action "${e.extra}" (it has: ${Object.keys(mask.extras).join(', ') || 'none'})`;
  const m = mask.extras[e.extra as keyof ChoiceMask['extras']];
  if (Array.isArray(m)) {
    if (!Number.isInteger(e.target) || e.target! < 0 || e.target! >= m.length) return `extra action "${e.extra}" needs a target option index 0–${m.length - 1}`;
    if (!m[e.target!]) return `extra action "${e.extra}" on option ${e.target} is masked`;
    return null;
  }
  if (e.target !== undefined) return `extra action "${e.extra}" takes no target`;
  if (!m) return `extra action "${e.extra}" is masked`;
  return null;
}

/**
 * The species the game keeps a "hunt" counter for, from the bundle's own list (a module-private array next to the
 * code that reads `profile.hunt`). A build where the pattern does not match exactly once is refused.
 */
/**
 * The legendary-hunt counter of an episode. The game's profile reader caps the counter at 1,000,000
 * (`k: Math.min(1e6, …)`), so a larger seed cannot be stored as it is: it wraps around. Seeds up to the cap keep
 * their own value, which is what every episode recorded before this function existed was played with.
 */
export const HUNT_COUNTER_CAP = 1_000_000;
export function huntCounter(seed: number): number {
  return seed <= HUNT_COUNTER_CAP ? seed : seed % (HUNT_COUNTER_CAP + 1);
}

export function findHuntSpecies(loaded: string[]): number[] {
  const re = /([\w$]+)=\[(\d+(?:,\d+)+)\],[\w$]+=e=>\1\.includes\(e\),[\w$]+=[\d.]+,[\w$]+=\(e,t\)=>\{let n=e\.hunt\?\.\[t\]/g;
  const found: number[][] = [];
  for (const path of loaded) {
    const src = readFileSync(join(REPO, 'mirror', decodeURIComponent(path)), 'utf8');
    for (const m of src.matchAll(re)) found.push(m[2].split(',').map(Number));
  }
  if (found.length !== 1) throw new Error(`[environment] expected exactly one hunt-species list in the bundle, found ${found.length}: this build is not supported`);
  return found[0];
}

/** `maxKoGapGameTime` in the sanctuary outside Overtime: this many times the allowance (see koGapTooLong). */
const SANCTUARY_KO_GAP_FACTOR = 4;

type Resolved = Required<Pick<GameEnvironmentOptions, 'hz' | 'actionRepeat' | 'invalidAction' | 'species' | 'map' | 'tier' | 'ranked' | 'profile' | 'verbose'>> & { maxGameTime: number; maxIdleGameTime: number; idleRadius: number; maxKoGapGameTime: number; dataDir?: string; archive?: string; apiTarget?: string; encode: boolean };

export class HeadlessGameEnvironment implements GameEnvironment {
  readonly options: Resolved;
  private sim: Sim | null = null;
  private dialogs: DialogCapture | null = null;
  private names: BuildNames | null = null;
  private fns: GameFns | null = null;
  private registries: Registries | null = null;
  /** Map points used in this episode by kind, and the points seen unused / already counted (see scanMapUse). */
  private pointsUsed: Record<string, number> = {};
  private pointsSeen = new WeakSet<object>();
  private pointsCounted = new WeakSet<object>();
  private unlockCheck: UnlockCheck | null = null;
  private instrumentation: string[] = [];
  /** Account state every episode starts from. */
  private baseline: { profile: string; settings: string; lastSpecies: number; lastBiome: string; storage: [string, string][] } | null = null;
  private episode = { seed: 0, index: 0, steps: 0, simSteps: 0, species: 0, map: '', tier: 0, ranked: true, done: false, truncated: false, endCause: '', end: null as EndOfRun | null };
  private lastSeed = 0;
  /** Species with a per-run "hunt" counter in the profile (the legendaries), read from the bundle; and this episode's counter. */
  private huntSpecies: number[] = [];
  private huntK = 0;
  private finished = new Map<string, RunRecord>();
  private governorEverCut = false;
  private bundleSha = '';
  private closed = false;
  /** With `encode: true`: the observation encoder of the running build, and the play action of the previous step. */
  private encoder: ObservationEncoder | null = null;
  private previousPlay: PlayAction | null = null;
  /** The last sign of activity, for `maxIdleGameTime`: the run clock, the KOs and the place at that moment. */
  private activity = { time: 0, kills: 0, x: 0, z: 0 };
  /** The last KO (or the last moment a boss was alive), for `maxKoGapGameTime`: the run clock and the KOs then. */
  /** Dialogs the game raised while the Pokémon was fainting, in this episode: dropped, not asked (see `check`). */
  private droppedDialogs: string[] = [];
  /** Preset unlocked-v4: the items archived (empty for unlocked-v3 and for the archive version `empty`). */
  private archived: string[] = [];
  private lastKo = { time: 0, kills: 0, overtime: false };
  private koGapAllowance = 0;
  /** Wall-clock cost of the last boot and reset, for measurements. */
  readonly timing = { bootMs: 0, resetMs: 0, lastResetMs: 0, resets: 0, lastReset: { closeMs: 0, accountMs: 0, startMs: 0 } };

  constructor(options: GameEnvironmentOptions = {}) {
    this.options = {
      hz: options.hz ?? 60, actionRepeat: options.actionRepeat ?? 3, invalidAction: options.invalidAction ?? 'throw',
      maxGameTime: options.maxGameTime ?? 0, maxIdleGameTime: options.maxIdleGameTime ?? 0, idleRadius: options.idleRadius ?? 3, maxKoGapGameTime: options.maxKoGapGameTime ?? 0, species: options.species ?? 155, map: options.map ?? 'forest', tier: options.tier ?? 0,
      ranked: options.ranked ?? true, profile: options.profile ?? 'unlocked', archive: options.archive, verbose: !!options.verbose, dataDir: options.dataDir, apiTarget: options.apiTarget,
      encode: !!options.encode,
    };
    if (!Number.isInteger(this.options.actionRepeat) || this.options.actionRepeat < 1) throw new Error('actionRepeat must be a positive integer');
    if (!(this.options.maxIdleGameTime >= 0) || !(this.options.idleRadius > 0)) throw new Error('maxIdleGameTime must be 0 (no rule) or a positive number of game seconds, and idleRadius a positive number of metres');
    if (this.options.archive != null && !(this.options.archive in ARCHIVES)) throw new Error(`unknown archive "${this.options.archive}": use one of ${Object.keys(ARCHIVES).join(', ')}`);
    if (!(this.options.maxKoGapGameTime >= 0)) throw new Error('maxKoGapGameTime must be 0 (no rule) or a positive number of game seconds');
    if (this.options.invalidAction !== 'throw' && this.options.invalidAction !== 'penalty') throw new Error('invalidAction must be "throw" or "penalty"');
  }

  // ------------------------------------------------------------------ boot

  private get app(): any { return this.sim!.app; }
  private get run(): any { return this.sim!.run; }

  /** Wait for a promise of the game, driving its frame loop on the virtual clock meanwhile. */
  private async settle<T>(p: Promise<T>, what: string): Promise<T> {
    let out: T | undefined, err: unknown, done = false;
    p.then((v) => { out = v; done = true; }, (e) => { err = e ?? new Error('rejected'); done = true; });
    await this.sim!.pump(() => done, what);
    if (err) throw err;
    return out as T;
  }

  private async boot(seed: number): Promise<void> {
    const t0 = real.performanceNow();
    const sim = await Sim.boot({
      seed, hz: this.options.hz, registered: true, verbose: this.options.verbose, apiTarget: this.options.apiTarget,
      dataDir: this.options.dataDir ?? join(REPO, 'data', 'env', `${process.pid}-${real.Date.now().toString(36)}`),
    });
    this.sim = sim;
    const app = sim.app;

    // The account stays what the preset says: finished runs do not accumulate progress between episodes.
    sim.api.progression = false;
    sim.api.onEvent = (ev) => { if (ev.type === 'run-finish' && ev.run) this.finished.set(ev.run.id, ev.run); };
    this.instrumentation.push('in-process game service (src/sandbox/mockApi.ts): finished runs are not folded into the profile; POST /dev/unlock returns the unlocked preset; GET /status reports a local ranked season');

    // Registries of the running bundle → the unlocked preset → the game's own devUnlock call adopts it.
    const reg = this.registries = await readRegistries(sim.loader.loaded);
    this.instrumentation.push('read-only: module exports of the loaded chunks are inspected to find the game\'s registries (League, Lab, shop items, maps, forms, tiers, season, friendship perks and level function, shiny perks, species rules and reference data)');
    this.instrumentation.push('read-only: planRoute(x, z) runs the snapshot extractor\'s route planner (A* over the game\'s height map and prop colliders) for scripted policies; it reads terrain and writes nothing');
    sim.api.season = localRankedSeason(reg.season.season, reg.season.name, reg.season.biomes, sim.clock.epoch);
    await this.settle(app.backend.status(), 'the game to re-read the service status');
    const season = app.backend.season();
    if (!(season?.live && season?.ranked && Array.isArray(season?.maps) && season.maps.length)) throw new Error(`[environment] the game does not see a live ranked season: ${JSON.stringify(season)}`);

    if (this.options.profile === 'unlocked') {
      sim.api.unlockPreset = (p) => {
        const profile = unlockedProfile(p, reg, (s) => app.meta.family(s));
        if (this.options.archive == null) return profile;
        // unlocked-v4: the same account with an item archive. The game applies its slot limit only when an item is
        // toggled in the menu, not when a run starts, so the preset keeps to it itself.
        const count = ARCHIVES[this.options.archive];
        if (count == null) throw new Error(`[environment] unknown archive "${this.options.archive}": use one of ${Object.keys(ARCHIVES).join(', ')}`);
        const slots = 5 * (Number(profile.lab?.archive) || 0) + (profile.itemsOwned?.length ?? 0);
        const knowledge = loadValuationKnowledge(this.buildId());
        this.archived = itemArchive(knowledge, kitOf(knowledge, this.options.species), { count, slots });
        if (this.archived.length > slots) throw new Error(`[environment] the archive holds ${this.archived.length} items, the account has ${slots} slots`);
        return { ...profile, itemsOff: [...this.archived] };
      };
      await this.settle(app.meta.devUnlock(), 'meta.devUnlock()');
      if (this.options.archive != null && JSON.stringify(app.meta.profile.itemsOff) !== JSON.stringify(this.archived)) throw new Error('[environment] the game did not adopt the item archive of the preset');
      this.unlockCheck = verifyUnlocked(app.meta, reg, this.archived);
      if (!this.unlockCheck.ok) throw new Error(`[environment] the unlocked profile is not fully unlocked according to the game:\n  ${this.unlockCheck.problems.join('\n  ')}`);
    } else {
      // The starter-only fresh account: /dev/unlock hands back the profile as it was when the game booted.
      const fresh = structuredClone(sim.store.profile(sim.session!.id)!);
      sim.api.unlockPreset = () => structuredClone(fresh);
    }

    // Legendary capture encounters: the game decides whether a legendary is "pending" for this run from a hash of
    // (account id, species, profile.hunt[species].k), where k is a counter it raises after every run. The account id
    // is fixed here and the profile is put back at every reset, so without help every episode would see the very
    // same roll. The counter is set from the episode seed instead: each seed gets its own roll, as successive runs
    // of one account do, and the same seed always gets the same one.
    this.huntSpecies = findHuntSpecies(sim.loader.loaded);
    this.huntK = huntCounter(seed);
    const preset = sim.api.unlockPreset!;
    sim.api.unlockPreset = (p, a) => ({ ...preset(p, a), hunt: this.huntProfile() });
    await this.settle(app.meta.devUnlock(), 'meta.devUnlock() (hunt counters)');
    this.instrumentation.push(`profile.hunt: the per-run counter k of the ${this.huntSpecies.length} legendaries (${this.huntSpecies.join(', ')}) is set from the episode seed at every reset (the seed itself up to the game's cap of 1,000,000, above it the seed modulo 1,000,001; m = 0); the account id is a fixed value (the game hashes both into its legendary-encounter roll)`);

    // The frame-rate governor must never be the reason for a smaller horde: the game measures frames per second from
    // the dt it is stepped with, so its settings must leave the thresholds at their defaults.
    const settings = app.meta.profile.settings;
    if (settings.quality !== 'high') throw new Error(`[environment] the game chose graphics quality "${settings.quality}": the live-enemy cap would be lower than the default`);
    if (app.fpsCap() !== 0) throw new Error(`[environment] the game has an FPS limit of ${app.fpsCap()}: the governor thresholds would move`);
    if (this.options.hz < 55) process.stderr.write(`[environment] WARNING: stepping at ${this.options.hz} Hz is below the game's 55 fps mark; it will cut its live-enemy cap in large hordes.\n`);

    // Reset point for every later episode.
    const storage: [string, string][] = [];
    const ls = (globalThis as any).localStorage;
    for (let i = 0; i < ls.length; i++) { const k = ls.key(i); storage.push([k, ls.getItem(k)]); }
    this.baseline = {
      profile: this.profileDigestSource(), settings: JSON.stringify(settings), lastSpecies: app.meta.profile.lastSpecies, lastBiome: app.meta.profile.lastBiome,
      storage: storage.filter(([k]) => k !== 'pb-errs'),
    };

    // Restart the random streams at the moment the run object is built, so that nothing the menu drew before
    // (which differs between a fresh process and a reused one) reaches the run.
    const launch = app.launch;
    app.launch = (...args: unknown[]) => { this.reseed(sim.currentSeed, 0); return launch.apply(app, args); };
    this.instrumentation.push('app.launch on the app instance: wrapped; the random streams are restarted from the episode seed immediately before the game constructs the run');
    this.instrumentation.push(`entropy: "the random streams" are Math.random, crypto.getRandomValues and the state field of the game's module-level generator (${reg.sources.rng}), which the bundle otherwise seeds once per page load. They are restarted at run construction (stream 0) and each time a zone finishes loading (stream = zone number), so that neither earlier episodes nor how long loading took (sprite sheets cached or not) can shift the random numbers of play`);

    // The game's own functions behind the dialogs whose buttons carry logic (src/environment/gamefns.ts).
    this.fns = await resolveGameFns(sim.loader.loaded, sim.pb!.Run);
    this.instrumentation.push(`read-only: module exports of the loaded chunks are inspected to find the game functions the dialog answers call (${Object.entries(this.fns.sources).map(([k, v]) => `${k} = ${v}`).join(', ')})`);
    this.instrumentation.push(`dialog answers that stand in for a HUD click handler make the handler's own field writes: ${HANDLER_WRITES.join('; ')}`);
    this.instrumentation.push('read-only: the "used" flag of the map points (run.interactables.list) is read after every simulation step to count the points used in the episode');

    const sha = createHash('sha256');
    for (const path of sim.loader.loaded) sha.update(readFileSync(join(REPO, 'mirror', decodeURIComponent(path))));
    this.bundleSha = sha.digest('hex');

    this.instrumentation.push('read-only: observation.state and info.counters (src/observations/state.ts) read fields of the live run object and call these members of it, none of which writes: interactables.chestCost(), seals.kept, swarmSecs, collapseHp(), tideHealK(), nextBossSpecies(), overtime.offered / roundLeft / bonus / drainHp / healK / mult(round), ult.ready, meta.runGain("healed")');
    if (this.options.encode) {
      // The numeric encoding works from the exported knowledge of exactly this build (data/game-knowledge/<build>/); it reads nothing from the game.
      this.encoder = new ObservationEncoder(loadKnowledge(this.buildId()));
    }
    this.timing.bootMs = real.performanceNow() - t0;
  }

  /** Build id in the file name of the bundle's main chunk. */
  private buildId(): string {
    const entry = this.sim!.loader.loaded.find((p) => /\/main-[^/]*\.js$/.test(p)) ?? '';
    return /-([a-z0-9]+)\.js$/.exec(entry)?.[1] ?? 'unknown';
  }

  /** Restart every random stream the game draws from: Math.random, crypto, and the game's own module-level generator. */
  private reseed(seed: number, stream: number): void {
    this.sim!.entropy.reseed(seed, stream);
    this.registries!.rng.s = ((Math.imul(seed ^ 0x85ebca6b, 0xc2b2ae35) + Math.imul(stream + 1, 0x27d4eb2f)) >>> 0) || 0x9e3779b9;
  }

  private huntProfile(): Record<string, { k: number; m: number }> {
    return Object.fromEntries(this.huntSpecies.map((s) => [String(s), { k: this.huntK, m: 0 }]));
  }

  /**
   * The run's `realTime` counter (seconds of frames it has been through, loading included) is put back to what it
   * was before a loading phase. Loading takes a different number of frames depending on what the process already has
   * in its caches, and the game compares this counter against thresholds in play code, so an offset of a few frames
   * made a long episode drift apart between a fresh process and a reused one.
   */
  private setRealTime(value: number): void {
    const run = this.run;
    if (typeof run.realTime !== 'number' || !Number.isFinite(value)) throw new UnknownSituationError('[environment] the run has no numeric realTime counter: this build is not supported', this.where({ realTime: run.realTime, value }));
    run.realTime = value;
    const note = 'run.realTime (the run\'s count of real seconds, loading included): set back to its value before each loading phase (0 for the first zone), so that the length of loading, which depends on the process\'s caches, does not reach play';
    if (!this.instrumentation.includes(note)) this.instrumentation.push(note);
  }

  /** The parts of the profile that define the account, in a stable order (settings and device picks are compared separately). */
  private profileDigestSource(): string {
    const p = this.app.meta.profile;
    const skip = new Set(['settings', 'lastSpecies', 'lastBiome', 'daily', 'weekly', 'hunt']);
    return JSON.stringify(Object.keys(p).filter((k) => !skip.has(k)).sort().map((k) => [k, p[k]]));
  }

  // ------------------------------------------------------------------ reset

  async reset(options: ResetOptions = {}): Promise<Observation> {
    if (this.closed) throw new Error('the environment is closed');
    const t0 = real.performanceNow();
    const seed = (options.seed ?? this.lastSeed + 1) >>> 0;
    if (!this.sim) await this.boot(seed);
    const sim = this.sim!, app = this.app;

    // 1. Close whatever run is still open, the way the game's own Restart does. (The old run and its HUD are disposed by
    //    the game itself when it launches the next one.)
    const tA = real.performanceNow();
    await this.abandonRun();
    const tB = real.performanceNow();

    // 2. Account, browser storage and random streams back to the starting point.
    sim.reseed(seed);
    const ls = (globalThis as any).localStorage;
    ls.clear();
    for (const [k, v] of this.baseline!.storage) ls.setItem(k, v);
    this.huntK = huntCounter(seed);
    await this.settle(app.meta.devUnlock(), 'meta.devUnlock() (profile reset)');
    if (JSON.stringify(app.meta.profile.hunt) !== JSON.stringify(this.huntProfile())) throw new UnknownSituationError('[environment] the game did not adopt the hunt counters of this episode', { seed, got: app.meta.profile.hunt });
    app.meta.profile.settings = JSON.parse(this.baseline!.settings);
    app.meta.profile.lastSpecies = this.baseline!.lastSpecies;
    app.meta.profile.lastBiome = this.baseline!.lastBiome;
    if (this.profileDigestSource() !== this.baseline!.profile) throw new UnknownSituationError('[environment] the profile did not return to its starting state at reset', { seed });
    for (const id of this.finished.keys()) sim.store.dropRun(id);
    this.finished.clear();

    const tC = real.performanceNow();
    // 3. Start the run: the call the game's own map screen makes (Ranked: with `competitive`).
    const cfg = {
      species: options.species ?? this.options.species, biome: options.map ?? this.options.map, tier: options.tier ?? this.options.tier,
      boosts: [] as string[], mode: 'standard', ...((options.ranked ?? this.options.ranked) ? { competitive: true } : {}),
    };
    const reg = this.registries!;
    if (!playableMaps(reg).some((m) => m.id === cfg.biome)) throw new Error(`unknown map "${cfg.biome}": the game has ${playableMaps(reg).map((m) => m.id).join(', ')}`);
    if (!Number.isInteger(cfg.tier) || cfg.tier < 0 || cfg.tier >= reg.tiers) throw new Error(`tier ${cfg.tier} does not exist: the game has tiers 0–${reg.tiers - 1}`);
    if (!app.meta.inLeague(cfg.species)) throw new Error(`species ${cfg.species} is not a League member of this profile (the game would not offer it)`);
    if (app.meta.biomeTier(cfg.biome) < cfg.tier) throw new Error(`map "${cfg.biome}" tier ${cfg.tier} is locked for this profile (unlocked up to ${app.meta.biomeTier(cfg.biome)})`);

    await sim.startRun(cfg, (a) => {
      this.names ??= resolveBuildNames(sim.pb!.Run, a.hud);
      this.dialogs ??= new DialogCapture(this.names, this.fns!);
      const replaced = this.dialogs.install(a.hud, a.run);
      const note = `HUD instance of each run: ${replaced.length} dialog methods replaced (${replaced.join(', ')}); options are answered through the game's own callbacks, no dialog is built or clicked`;
      if (!this.instrumentation.includes(note)) this.instrumentation.push(note);
    });
    const run = this.run;
    const got = { species: run.player?.speciesId, map: run.biome?.id, tier: run.tier, mode: run.mode, competitive: !!run.competitive, seed: run.seed >>> 0, state: run.state };
    const want = { species: cfg.species, map: cfg.biome, tier: cfg.tier, mode: 'standard', competitive: 'competitive' in cfg, seed, state: 'play' };
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new UnknownSituationError('[environment] the run the game started is not the run that was asked for', { want, got });

    // Loading consumed a number of random draws that depends on what this process had cached; play starts from a
    // defined point of the stream instead.
    this.reseed(seed, run.stage | 0);
    this.setRealTime(0);
    this.lastSeed = seed;
    this.episode = { seed, index: this.episode.index + 1, steps: 0, simSteps: 0, species: cfg.species, map: cfg.biome, tier: cfg.tier, ranked: 'competitive' in cfg, done: false, truncated: false, endCause: '', end: null };
    this.held.clear();
    this.previousPlay = null;
    this.activity = { time: 0, kills: 0, x: Number(run.player?.pos?.x) || 0, z: Number(run.player?.pos?.z) || 0 };
    this.lastKo = { time: 0, kills: 0, overtime: false };
    this.droppedDialogs = [];
    this.pointsUsed = {};
    this.pointsSeen = new WeakSet();
    this.pointsCounted = new WeakSet();
    this.scanMapUse();
    const ms = real.performanceNow() - t0;
    this.timing.lastResetMs = ms; this.timing.resetMs += ms; this.timing.resets++;
    this.timing.lastReset = { closeMs: tB - tA, accountMs: tC - tB, startMs: real.performanceNow() - tC };
    this.check('reset');
    return this.observe();
  }

  /** End a run that is still open through the game's own Restart path (`endHow = "restart"`, result posted, no end screen). */
  private async abandonRun(): Promise<void> {
    const run = this.run;
    if (!run || run.state === 'over') {
      if (run && !run.sent) await this.sim!.pump(() => !!run.sent, 'the finished run to be posted');
      return;
    }
    this.releaseAll();
    run.endHow = 'restart';
    await this.settle(Promise.resolve(run.finish(false, true)), 'the abandoned run to close');
  }

  // ------------------------------------------------------------------ step

  private held = new Set<string>();

  private hold(codes: Iterable<string>): void {
    const want = new Set(codes), input = this.app.input;
    for (const k of this.held) if (!want.has(k)) { input.release(k); this.held.delete(k); }
    for (const k of want) if (!this.held.has(k)) { input.press(k); this.held.add(k); }
  }
  private releaseAll(): void { this.hold([]); }

  /**
   * Count the map points the player has used: a point is counted once, when the game's own `used` flag turns on for
   * a point that was seen unused before. (The list is rebuilt for every zone, and the game keeps no total.)
   */
  private scanMapUse(): void {
    const list = this.run?.interactables?.list;
    if (!Array.isArray(list)) return;
    for (const p of list) {
      if (!p || typeof p !== 'object') continue;
      if (!p.used) { this.pointsSeen.add(p); continue; }
      if (!this.pointsSeen.has(p) || this.pointsCounted.has(p)) continue;
      this.pointsCounted.add(p);
      const kind = String(p.kind);
      this.pointsUsed[kind] = (this.pointsUsed[kind] ?? 0) + 1;
    }
  }

  /**
   * Wait for a promise of the game WITHOUT moving the virtual clock: no frame runs, no random number is drawn and
   * `realTime` does not advance, so how long the wait took cannot reach play.
   */
  private async still<T>(p: Promise<T>, what: string): Promise<T> {
    let out: T | undefined, err: unknown, done = false;
    p.then((v) => { out = v; done = true; }, (e) => { err = e ?? new Error('rejected'); done = true; });
    for (let i = 0; !done; i++) {
      if (i >= MAX_ANSWER_TURNS) throw new UnknownSituationError(`[environment] gave up waiting for ${what}`, this.where({ turns: i }));
      await turn();
    }
    if (err) throw err;
    return out as T;
  }

  async step(action: Action): Promise<StepResult> {
    if (this.closed) throw new Error('the environment is closed');
    if (!this.sim || !this.run || this.episode.index === 0) throw new Error('call reset() before step()');
    if (this.episode.done) throw new Error('the episode is over: call reset()');
    const phase = this.phase();
    const mask = this.mask();
    let invalid: string | null = null;
    if (!action || typeof action !== 'object') invalid = 'the action is not an object';
    else if (action.type !== phase) invalid = `a "${String((action as { type?: unknown }).type)}" action was sent in the ${phase} phase`;
    else invalid = action.type === 'play' ? playActionProblem(action, mask as PlayMask) : choiceActionProblem(action, mask as ChoiceMask);
    if (invalid) {
      if (this.options.invalidAction === 'throw') throw new InvalidActionError(`invalid action at step ${this.episode.steps} (seed ${this.episode.seed}): ${invalid}. Action: ${JSON.stringify(action)}`);
      this.episode.steps++;
      return this.result(0, 0, invalid);
    }

    this.episode.steps++;
    let ran = 0, idle = 0;
    if (action.type === 'choice') {
      // The game's own callback. It may open the next dialog at once (refresh, banish, the shop staying open).
      const answered = this.dialogs!.pending!.answer(action);
      if (answered) await this.still(answered, 'the game to finish a dialog action');
      this.scanMapUse();
      this.check('answering a dialog');
    } else {
      const run = this.run, input = this.app.input;
      const m = typeof action.move === 'number' ? action.move : MOVES.indexOf(action.move);
      this.previousPlay = { type: 'play', move: m };
      for (const b of PLAY_BUTTONS) this.previousPlay[b] = !!action[b];
      this.hold(keysForMove(MOVE_VECTORS[MOVES[m]], run.camYaw));
      // The buttons act on the key-down edge: pressed for the first simulation step only.
      const taps = PLAY_BUTTONS.filter((b) => action[b]).map((b) => KEY[b]) as string[];
      for (const k of taps) input.press(k);
      for (let i = 0; i < this.options.actionRepeat; i++) {
        await this.simStep();
        ran++;
        if (i === 0) for (const k of taps) input.release(k);
        if (this.dialogs!.pending || this.run.state !== 'play' || this.capReached()) break;
      }
      for (const k of taps) input.release(k);
    }

    // States in which the player cannot act (loading a zone, evolution and boss cut-scenes, a Poké Ball in flight,
    // fainting): let the game run through them, with no key held.
    let waited = 0, realTimeBeforeLoading: number | null = null;
    while (!this.dialogs!.pending && WAITING_STATES.has(this.run.state) && !this.capReached()) {
      if (waited === 0) this.releaseAll();
      const loading = this.run.state === 'transition';
      if (loading && realTimeBeforeLoading === null) realTimeBeforeLoading = this.run.realTime;
      await this.simStep();
      ran++; idle++;
      // A zone finished loading: see the note in reset().
      if (loading && this.run.state !== 'transition') {
        this.reseed(this.episode.seed, this.run.stage | 0);
        this.setRealTime(realTimeBeforeLoading!);
        realTimeBeforeLoading = null;
      }
      if (++waited > MAX_WAIT_STEPS) throw new UnknownSituationError('[environment] the game stayed in a non-interactive state', this.where({ state: this.run.state, waitedSteps: waited }));
    }
    return this.result(ran, idle, null);
  }

  private async simStep(): Promise<void> {
    await this.sim!.step();
    this.episode.simSteps++;
    const run = this.run;
    if (run.liveCap < run.liveMax) this.governorEverCut = true;
    this.scanMapUse();
    this.check('a simulation step');
  }

  private capReached(): boolean { return this.options.maxGameTime > 0 && this.run.time >= this.options.maxGameTime; }

  /**
   * The rule against standing still (`maxIdleGameTime`). A KO, or leaving the circle around the place of the last
   * activity, is activity and moves the mark; without either for the configured game time the episode is over.
   * Reads the run clock, the KO count and the player's position; writes nothing.
   */
  private idleTooLong(): boolean {
    if (!(this.options.maxIdleGameTime > 0)) return false;
    const run = this.run, a = this.activity, kills = run.stats?.kills | 0;
    const x = Number(run.player?.pos?.x) || 0, z = Number(run.player?.pos?.z) || 0;
    // Inside a rift neither rule runs (the owner, 2026-11-24: "We should allow rifts infinite time").
    if (kills !== a.kills || Math.hypot(x - a.x, z - a.z) > this.options.idleRadius || run.rifts?.isInside) {
      this.activity = { time: run.time, kills, x, z };
      return false;
    }
    return run.time - a.time >= this.options.maxIdleGameTime;
  }

  /**
   * The rule against going without a KO (`maxKoGapGameTime`). A KO moves the mark, and so does every moment a
   * guardian or the legendary is alive, and every moment inside a rift. Reads the run clock, the KO count,
   * `boss.alive`, `rifts.isInside`, `sanctuary` and `overtime.live`; writes nothing.
   */
  private koGapTooLong(): boolean {
    if (!(this.options.maxKoGapGameTime > 0)) return false;
    const run = this.run, kills = run.stats?.kills | 0;
    // Overtime going live is a new stretch as well: the rest before it was measured against the sanctuary's allowance.
    const overtime = !!run.overtime?.live;
    if (kills !== this.lastKo.kills || run.boss?.alive || overtime !== this.lastKo.overtime || run.rifts?.isInside) {
      this.lastKo = { time: run.time, kills, overtime };
      return false;
    }
    // The sanctuary has no wild Pokémon at all: the walk to the shrine and the rest before Overtime (45 s at most in
    // the heuristic baseline) are stretches without a KO in every complete run. Four times the allowance there.
    const allowance = this.options.maxKoGapGameTime * (run.sanctuary && !run.overtime?.live ? SANCTUARY_KO_GAP_FACTOR : 1);
    this.koGapAllowance = allowance;
    return run.time - this.lastKo.time >= allowance;
  }

  /** Fail loudly on anything the environment has no rule for. */
  private check(during: string): void {
    const d = this.dialogs!, run = this.run;
    if (d.failure) {
      const f = d.failure;
      throw new UnknownSituationError(`[environment] unhandled dialog "${f.method}" during ${during}: ${f.reason}`, this.where({ dialogMethod: f.method, arguments: f.args, stack: f.stack }));
    }
    if (run.state === 'modal' && !d.pending) throw new UnknownSituationError(`[environment] the run is waiting on a dialog that was not captured (during ${during})`, this.where({}));
    if (run.state === 'paused') throw new UnknownSituationError(`[environment] the game paused itself (during ${during})`, this.where({}));
    if (d.pending && (run.state === 'dead' || run.state === 'over')) {
      // A dialog raised in the very step in which the Pokémon fainted (seen: the item dialog of a Poké Ball opened as the
      // last hit landed). The game draws it over a run that is already ending and does not wait for an answer: fainting
      // set the state to "dead" and the run finishes 0.6 s later whatever is on screen. It is not a decision.
      this.droppedDialogs.push(`${d.pending.decision.method} at ${Number(run.time).toFixed(1)} s`);
      d.pending = null;
    }
    if (run.state !== 'modal' && d.pending) {
      // The shop and the leave-only dialogs put the run in "modal" themselves before calling the HUD; a decision
      // without the modal state means the capture and the run disagree.
      throw new UnknownSituationError(`[environment] a dialog was captured but the run is in state "${run.state}" (during ${during})`, this.where({ dialogMethod: d.pending.decision.method }));
    }
  }

  private where(extra: Record<string, unknown>): Record<string, unknown> {
    const run = this.run, e = this.episode;
    return {
      seed: e.seed, species: e.species, map: e.map, tier: e.tier, ranked: e.ranked, step: e.steps, simStep: e.simSteps, hz: this.options.hz, actionRepeat: this.options.actionRepeat,
      runState: run?.state, runTime: run?.time, zone: run?.stage, level: run?.player?.level, ...extra,
      pageProblems: this.sim!.browser.problems.slice(-5), gameErrors: this.sim!.browser.gameErrors.slice(-5),
    };
  }

  // ------------------------------------------------------------------ observe

  private phase(): 'play' | 'choice' | 'over' {
    if (this.episode.done || this.run.state === 'over') return 'over';
    return this.dialogs!.pending ? 'choice' : 'play';
  }

  private mask(): ActionMask {
    const phase = this.phase();
    if (phase === 'over') return { phase: 'over' };
    if (phase === 'choice') return this.dialogs!.pending!.mask();
    const run = this.run;
    const can = (f: () => unknown): boolean => { try { return !!f(); } catch { return false; } };
    // The game's own conditions, in the order its input code checks them (docs/game-mechanics.md §5).
    const near = run.interactables?.nearest ?? null;
    const interact = run.state === 'play' && (
      can(() => run.rifts.nearEntrance()) ||
      (!run.capture?.throwing && (can(() => run.capture.canThrow()) || (!near && can(() => run.allies.canThrow())) || (!near && can(() => run.rifts.canCallWave())) || !!near)));
    return {
      phase: 'play', move: MOVES.map(() => true), jump: true, dash: true,
      ultimate: run.state === 'play' && !!run.ult?.ready && !(run.ult?.active > 0),
      interact,
      // The game's own conditions for the F, C and X keys (docs/game-mechanics.md §5).
      form: run.state === 'play' && can(() => run.forms.ready),
      incense: run.state === 'play' && can(() => run.rifts.incenseOn && run.rifts.useBlock(false) === null),
      fuse: run.state === 'play' && can(() => run.rifts.incenseOn && run.rifts.fuseOn && run.rifts.useBlock(true) === null),
    };
  }

  private observe(): Observation {
    const snapshot = extractSnapshot.call(this.run) as Snapshot | null;
    if (!snapshot) throw new UnknownSituationError('[environment] the run has no player to observe', this.where({}));
    const pending = this.phase() === 'choice' ? this.dialogs!.pending : null;
    const observation = deepFreeze({
      schema: OBSERVATION_SCHEMA, phase: this.phase(), step: this.episode.steps, simStep: this.episode.simSteps,
      snapshot, decision: pending ? structuredClone(pending.decision) : null, mask: structuredClone(this.mask()),
      state: extractState(this.run, { pointsUsed: this.pointsUsed, slotPrice: this.fns!.slotCost(this.run), shopSold: this.dialogs!.shopSold }),
    }) as Observation;
    if (!this.encoder) return observation;
    // The numeric form is computed from the frozen observation alone (plus the previous play action), never from the game.
    const { float, int } = this.encoder.encode(observation, this.previousPlay);
    return Object.freeze({ ...observation, encoded: Object.freeze({ version: OBS_ENCODING_VERSION, layoutHash: this.encoder.layout.hash, float, int, mask: encodeMask(observation) }) }) as Observation;
  }

  /** With `encode: true`: the layout descriptor of `observation.encoded` (the contract Python slices the buffers by). */
  get observationLayout(): ObservationEncoder['layout'] | null { return this.encoder?.layout ?? null; }
  /** With `encode: true`: keys the encoder met that its vocabulary allows to be unknown (they encode as 0), with counts. */
  get encoderUnknown(): Record<string, number> { return Object.fromEntries(this.encoder?.unknown ?? []); }

  getObservation(): Observation {
    if (!this.sim || !this.run || this.episode.index === 0) throw new Error('call reset() before getObservation()');
    return this.observe();
  }

  /**
   * Read-only helper for scripted policies (src/agents/heuristic): the next waypoint of a route from the player to the
   * world point (x, z), planned by the snapshot extractor's own A* over the game's height map and prop colliders
   * (`Snapshot.nav`, docs/SNAPSHOT.md). Reads terrain, changes nothing, draws no random number. null when no route
   * could be planned.
   */
  planRoute(x: number, z: number): Nav | null {
    if (!this.sim || !this.run || this.episode.index === 0) throw new Error('call reset() before planRoute()');
    if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error(`planRoute needs a finite world point, got (${x}, ${z})`);
    const nav = (extractSnapshot.call(this.run, x, z) as Snapshot | null)?.nav;
    return nav ? deepFreeze(structuredClone(nav)) : null;
  }

  private blocked(): string[] {
    const sim = this.sim!;
    return [...sim.guard.attempts.map((a) => `${a.kind} ${a.target}`), ...sim.net.log.blocked];
  }

  private info(ran: number, idle: number, observation: Observation): StepInfo {
    const run = this.run, ot = run.overtime;
    const info: StepInfo = {
      counters: observation.state.counters,
      seed: this.episode.seed, time: run.time, kills: run.stats?.kills | 0, level: run.player?.level | 0, zone: run.stage | 0, zoneTime: run.stageTime,
      state: String(run.state), simSteps: ran, idleSteps: idle,
      overtime: ot ? { live: !!ot.live, over: !!ot.over, cashed: !!ot.cashed, lost: !!ot.lost, round: (ot.round | 0) + 1, bonus: ot.live || ot.over ? ot.bonus | 0 : 0 } : null,
      sealsKept: run.seals?.kept | 0,
      blockedNetwork: this.blocked(),
    };
    return info;
  }

  private async result(ran: number, idle: number, invalid: string | null): Promise<StepResult> {
    const run = this.run;
    let terminated = false, truncated = false;
    if (run.state === 'over') {
      terminated = true;
      // The game posts its result after the state changes; wait for that, then take the record from the local service.
      await this.sim!.pump(() => !!run.sent, 'the game to post the end-of-run result');
      const rec = [...this.finished.values()].pop();
      if (!rec?.result) throw new UnknownSituationError('[environment] the run is over but the game posted no result', this.where({ finishedRuns: this.finished.size }));
      const record = JSON.parse(JSON.stringify(rec.result)) as Record<string, any>;
      const how = String(record.end?.how ?? 'unknown');
      this.episode.end = { how, victory: !!record.victory, record };
      const ot = record.ot ? (record.ot.cashed ? ', overtime cashed' : ', overtime lost') : '';
      this.episode.endCause = `${how}${record.victory ? ' (victory)' : ''}${ot}`;
      this.episode.done = true;
      this.releaseAll();
    } else if (this.capReached()) {
      truncated = true;
      this.episode.truncated = true;
      this.episode.done = true;
      this.episode.endCause = `truncated: game time reached the cap of ${this.options.maxGameTime} s`;
      this.releaseAll();
    } else if (this.idleTooLong()) {
      // The run is still open in the game (it would stay open for ever); the next reset closes it, as after the cap.
      truncated = true;
      this.episode.truncated = true;
      this.episode.done = true;
      this.episode.endCause = `idle: no KO and no movement for ${this.options.maxIdleGameTime} s of game time`;
      this.releaseAll();
    } else if (this.koGapTooLong()) {
      truncated = true;
      this.episode.truncated = true;
      this.episode.done = true;
      this.episode.endCause = `idle: no KO for ${this.koGapAllowance} s of game time`;
      this.releaseAll();
    }
    const observation = this.observe();
    const info = this.info(ran, idle, observation);
    if (invalid) info.invalidAction = invalid;
    if (this.episode.done) { info.endCause = this.episode.endCause; if (this.episode.end) info.end = structuredClone(this.episode.end); }
    return { observation, reward: 0, terminated, truncated, info: deepFreeze(info) };
  }

  // ------------------------------------------------------------------ metadata / close

  getMetadata(): GameMetadata {
    if (!this.sim) throw new Error('call reset() once before getMetadata(): the game is loaded by the first reset');
    const sim = this.sim, run = this.run;
    const simDir = join(REPO, 'src', 'sim');
    const shims = readdirSync(simDir).filter((f) => f.endsWith('.ts')).sort();
    const require = createRequire(import.meta.url);
    let dom = 'happy-dom ?';
    try { dom = `happy-dom ${JSON.parse(readFileSync(join(dirname(require.resolve('happy-dom')), '..', 'package.json'), 'utf8')).version}`; } catch { /* reported as unknown */ }
    const sh = createHash('sha256');
    for (const f of shims) sh.update(f).update(readFileSync(join(simDir, f)));
    sh.update(dom);
    const cap = run?.fpsCap || 0;
    const build = this.buildId();
    const act = actionLayout(), obsLayout = this.encoder?.layout ?? null;
    return {
      encoding: {
        state: STATE_SCHEMA,
        action: { version: ACTION_ENCODING_VERSION, hash: act.hash, nvec: act.nvec, maskSize: act.maskSize },
        observation: obsLayout ? { version: obsLayout.version, layoutHash: obsLayout.hash, floatSize: obsLayout.floatSize, intSize: obsLayout.intSize, vocabSha256: obsLayout.knowledge.vocabSha256 } : null,
      },
      game: {
        build, version: this.registries?.releases.find((r) => r.build === build)?.version ?? null, clientHeader: sim.net.log.client, bundleSha256: this.bundleSha,
        chunks: sim.loader.loaded.length, identifiers: sim.loader.ids,
      },
      sim: { hz: this.options.hz, dt: 1 / this.options.hz, actionRepeat: this.options.actionRepeat, decisionsPerSecond: this.options.hz / this.options.actionRepeat, render: false },
      schema: { observation: OBSERVATION_SCHEMA, action: ACTION_SCHEMA, decision: DECISION_SCHEMA, snapshot: 1 },
      instrumentation: [...sim.instrumentation, ...this.instrumentation],
      shimHash: sh.digest('hex'),
      shims: [...shims.map((f) => `src/sim/${f}`), dom],
      profile: { preset: this.options.profile === 'unlocked' ? (this.options.archive != null ? `unlocked-v4:${this.options.archive}` : UNLOCKED_PRESET) : this.options.profile, registered: !sim.session?.guest, summary: this.unlockCheck?.summary ?? { note: 'starter-only fresh account' } },
      mode: { ranked: this.episode.ranked, season: JSON.parse(JSON.stringify(sim.api.season)) },
      offline: {
        guardInstalled: true, primitives: [...sim.guard.primitives],
        selfTest: sim.guard.lastSelfTest ? { ok: sim.guard.lastSelfTest.ok, probes: sim.guard.lastSelfTest.probes.length } : null,
        blocked: this.blocked(),
      },
      governor: run ? {
        low: cap ? Math.min(45, cap * 0.75) : 45, high: cap ? Math.min(55, cap * 0.92) : 55,
        liveCap: run.liveCap, liveMax: run.liveMax, cut: run.liveCap < run.liveMax, everCut: this.governorEverCut,
      } : null,
      dialogs: { handled: [...HANDLED_METHODS], refused: [...REFUSED_METHODS], handlerWrites: [...HANDLER_WRITES] },
    };
  }

  /** Internals for measurement and test scripts. Not part of the agent-facing interface. */
  get debug(): { sim: Sim | null; dialogsSeen: Record<string, number>; registries: Registries | null; unlock: UnlockCheck | null; names: BuildNames | null } {
    return { sim: this.sim, dialogsSeen: Object.fromEntries(this.dialogs?.seen ?? []), registries: this.registries, unlock: this.unlockCheck, names: this.names };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.sim) return;
    try { await this.abandonRun(); } catch { /* closing anyway */ }
    this.sim.cleanup();
  }
}

export function createEnvironment(options?: GameEnvironmentOptions): HeadlessGameEnvironment { return new HeadlessGameEnvironment(options); }
