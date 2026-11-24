/** Data exchanged between the two sides of the fidelity comparison and the comparer. Plain JSON only. */

export interface EpisodeOptions {
  seed: number;
  species: number;
  map: string;
  tier: number;
  /** Name of the scripted input sequence (`scriptAction` in shared.ts): walk | dance | east | idle. */
  script: string;
  /** Simulation steps to run after the reset (0: reset only, for the static comparison). */
  maxSteps: number;
  /** Stop when the first dialog opens instead of answering it. */
  stopAtDialog: boolean;
  /** Keep every hashed value by name for simulation steps in this inclusive range (to find the differing field). */
  detail: [number, number] | null;
  /** Take the static dump (map, player, tables) right after the reset. */
  static: boolean;
  /** Sprite ids whose sheets the game is asked to measure after the episode. */
  sheets: number[] | null;
  /**
   * Replace the transcendental Math functions by one plain-JavaScript implementation on both sides
   * (src/fidelity/commonMath.ts). The two engines round these functions differently; with this on, what remains is
   * the difference between the shims and the browser.
   */
  commonMath?: boolean;
  /** Record the call site of every Math.random call made during these simulation steps (inclusive range). */
  trace?: [number, number] | null;
  /**
   * Headless side only: proposed changes to the shims, applied in memory in the comparison's own process to measure
   * their effect (src/fidelity/headlessRun.ts). `native-abort`: keep Node's AbortController / AbortSignal.
   * `request-base`: `new Request(relativeUrl)` resolves against the page URL.
   */
  shimPatches?: string[];
  /**
   * Sprite ids both sides ask the game's sprite cache for as soon as the run exists, before its loading phase. With
   * every sheet the episode will need in this list, no sprite sheet arrives during play (see docs/fidelity.md: the
   * moment an image arrives shifts the random stream, and the two sides cannot agree on that moment).
   */
  preloadSheets?: number[];
  /**
   * Browser side only: make the real browser behave like the shim in a place where the shim is KNOWN to differ and is
   * left that way on purpose (docs/fidelity.md D2, D3). In memory, in the page (src/fidelity/pageAgent.ts).
   *   `request`      `new Request(url, { signal })` throws, as it does under the shims: three.js then loads no file
   *                  (no 3D model ever arrives);
   *   `audio-clock`  a suspended audio context's `currentTime` follows the page clock instead of standing still;
   *   `uuid`         three.js' `generateUUID` draws from a private stream instead of `Math.random`: the same in-memory
   *                  rewrite of the three.js chunk that the headless module hook makes (src/sim/loader.ts, D10).
   */
  browserAsShim?: string[];
  /**
   * Browser side only: before the run starts, every Pokémon sprite sheet of the mirror is loaded through the game's
   * own sheet loader, and the game's sheet cache is kept from going cold. A sheet then reaches the game within the
   * step that asks for it, which is what the headless image shim does for every load (docs/fidelity.md D4).
   */
  warmSheets?: boolean;
}

export interface Mark {
  kind: 'booted' | 'reseed' | 'play';
  /** Display frames pumped so far (boot and loading phases). */
  frames: number;
  /** Virtual page clock in ms. */
  clock: number;
  /** Math.random / crypto calls since the previous restart of the streams. */
  math: number;
  crypto: number;
  seed?: number;
  stream?: number;
  /** State of the game's own generator before it was set. */
  rngBefore?: number | null;
  simStep?: number;
}

export interface ApiCall {
  frame: number;
  clock: number;
  simStep: number;
  method: string;
  url: string;
  body: unknown;
  status: number;
  replySha: string;
  client: string | null;
  device: string | null;
}

export interface DecisionRecord {
  simStep: number;
  kind: string;
  method: string;
  options: string[];
  mask: unknown;
  context: unknown;
}

export interface SideResult {
  side: 'headless' | 'browser';
  options: EpisodeOptions;
  engine: Record<string, unknown>;
  session: { id: string; name: string; token: string; guest: boolean } | null;
  account: { id: string; name: string; token: string; guest: boolean; created: number } | null;
  /** The stored profile when the game booted (reply of its first GET /profile). */
  bootProfile: Record<string, unknown> | null;
  /** Every reply of POST /dev/unlock, in order. */
  unlockReplies: unknown[];
  season: Record<string, unknown>;
  registrySources: Record<string, string>;
  /** Script chunks in load order (URL paths). */
  chunks: string[];
  /** localStorage right after the reset. */
  storage: [string, string][];
  marks: Mark[];
  api: ApiCall[];
  /** One digest line per simulation step; line 0 is the state right after the reset. */
  lines: unknown[][];
  details: Record<number, Record<string, Record<string, unknown>>>;
  /** [simulation step the action was sent at, the action as JSON]. */
  actions: [number, string][];
  decisions: DecisionRecord[];
  static: Record<string, unknown> | null;
  sheets: unknown[] | null;
  end: unknown;
  /** Why the episode loop stopped. */
  stop: string;
  problems: string[];
  gameErrors: string[];
  /** Requests that tried to leave the machine and were refused. */
  blocked: string[];
  timing: { resetMs: number; playMs: number };
  /** With `options.trace`: per simulation step, the call sites of Math.random in call order (`chunk:column < caller:column …`). */
  trace?: Record<number, string[]>;
  /** Headless side: files requested after play began, as `simStep path`. */
  assetsDuringPlay?: string[];
  /** Sprite ids whose sheet was first requested after play began. */
  spritesDuringPlay?: number[];
  /** Pokémon sprite sheets (pmd, pmd-forms, pmd-shiny, front) fetched after play began, as `folder/file.png`. */
  sheetsDuringPlay?: string[];
  /** localStorage after the episode (the game keeps its autosave of the run there). */
  storageEnd?: [string, string][];
  /** The game's sound object after the episode (`audioFacts` in shared.ts). */
  audio?: Record<string, unknown>;
  /** Browser side only: what was changed in memory, the requests served, things seen on the way. */
  browser?: Record<string, unknown>;
  /**
   * `seek` script only: one entry per map point the scripted player used, `[play step it was seen used, kind, play
   * step of the key press, distance from the point at that press, the point's interaction radius]`.
   */
  seekLog?: unknown[];
  /** Dialog methods seen, with counts (headless: the environment's own count). */
  dialogKinds?: Record<string, number>;
  /** What a page script can read about its platform (`platformFacts` in shared.ts), taken after everything else. */
  platform?: Record<string, unknown>;
  /** Headless side: version of the profile preset the environment reports, and sha256 of the profile both sides adopt. */
  preset?: string;
  profileSha?: string;
  /** `new Request(...)` calls that threw (three.js' file loader under the shims): count and the first few. */
  requestThrows?: { count: number; first: string[] };
  /** Map points and capture balls that have a 3D model, after the reset and at the end (`modelFacts` in shared.ts). */
  models?: { atReset: Record<string, unknown>; atEnd: Record<string, unknown> };
}
