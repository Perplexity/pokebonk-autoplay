import type { Snapshot } from '../bot/snapshot.ts';
import type { Counters, RunState } from '../observations/state.ts';

/**
 * The stable interface of the training environment. Everything here is plain JSON data: nothing a caller receives
 * holds a reference to a live game object.
 *
 * Schema versions are bumped whenever a field changes meaning or shape; they are reported by `getMetadata()` and
 * should be stored with every recorded episode.
 */
/**
 * 2: `state` added (src/observations/state.ts), optional `encoded`.
 * 3: the play mask has `form`, `incense` and `fuse`; `state` is at schema 2 (Max form, rifts, dojo, slot machine, map use).
 */
export const OBSERVATION_SCHEMA = 3;
/** 2: play actions have `form`, `incense` and `fuse`. */
export const ACTION_SCHEMA = 2;
/**
 * 2: the slot machine, the dojo, Hypno and Bill's fusion machine are full decisions (they were leave-only); the shop
 * can sell; new kinds `lesson`, `dojoPrize`, `shopSell`.
 */
export const DECISION_SCHEMA = 2;

// ---------------------------------------------------------------- actions

/** 0 = stand still, 1..8 = a world direction, clockwise seen from above starting at -z ("north" of the map). */
export const MOVES = ['none', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
export type Move = (typeof MOVES)[number];
/** World (x, z) unit vector of each move. +x is east, -z is north. */
export const MOVE_VECTORS: Record<Move, { x: number; z: number } | null> = {
  none: null,
  n: { x: 0, z: -1 }, ne: { x: Math.SQRT1_2, z: -Math.SQRT1_2 }, e: { x: 1, z: 0 }, se: { x: Math.SQRT1_2, z: Math.SQRT1_2 },
  s: { x: 0, z: 1 }, sw: { x: -Math.SQRT1_2, z: Math.SQRT1_2 }, w: { x: -1, z: 0 }, nw: { x: -Math.SQRT1_2, z: -Math.SQRT1_2 },
};

/** Real-time phase: held for one decision interval (`actionRepeat` simulation steps). */
export interface PlayAction {
  type: 'play';
  /** A name from MOVES or its index. World-relative: the environment turns it into keys with the camera yaw. */
  move: Move | number;
  /** Edge-triggered in the game (one press per decision): jump, dash, ultimate, interact. */
  jump?: boolean;
  dash?: boolean;
  ultimate?: boolean;
  interact?: boolean;
  /** Max form (the game's F key): spend one charge to transform. */
  form?: boolean;
  /** Burn one Incense to open a rift ahead (the game's C key). */
  incense?: boolean;
  /** Burn three Incense for a fused rift (the game's X key). */
  fuse?: boolean;
}

/** The buttons of a play action, in the order of the action vector. */
export const PLAY_BUTTONS = ['jump', 'dash', 'ultimate', 'interact', 'form', 'incense', 'fuse'] as const;
export type PlayButton = (typeof PLAY_BUTTONS)[number];

/**
 * Extra actions a dialog can offer besides picking one of its options. Which ones exist, and whether they need a
 * `target` option, is in the decision's `extras`.
 */
export type ExtraAction = 'refresh' | 'skip' | 'banish' | 'banishKit' | 'take' | 'sell' | 'decline' | 'leave' | 'confirm' | 'reroll';

/** Choice phase: one of the dialog's options, or one of its extra actions. */
export type ChoiceAction =
  | { type: 'choice'; option: number }
  | { type: 'choice'; extra: ExtraAction; target?: number };

export type Action = PlayAction | ChoiceAction;

// ---------------------------------------------------------------- decisions

/** Every dialog the environment turns into a structured decision. `method` in the decision is the HUD method that raised it. */
export type DecisionKind =
  | 'levelup' | 'evolution' | 'item' | 'itemChoice' | 'blessing' | 'seals' | 'sanctuaryPath' | 'leaveSanctuary'
  | 'overtimeStart' | 'overtimeOffer' | 'trade' | 'shop' | 'ditto' | 'party' | 'shinySwap' | 'relic'
  | 'dojo' | 'dojoPrize' | 'slots' | 'forget' | 'lesson' | 'fusion' | 'shopSell';

export interface DecisionOption {
  /** Short identifier of the option inside its dialog (offer key, item key, seal set, …). */
  id: string;
  /** Human-readable label, in the game's language setting when the game supplies one. */
  label: string;
  /** The game's own option data, copied (numbers, strings, plain arrays/objects only). */
  data: Record<string, unknown>;
}

export interface DecisionExtra {
  /** True when the action is aimed at one of the options (`target` is required), e.g. banish. */
  needsTarget: boolean;
  /** What the game does on this action, in a few words. */
  effect: string;
}

export interface Decision {
  kind: DecisionKind;
  /** Name of the HUD method the game called. */
  method: string;
  /** Title or context line (who is asking, zone, round…). */
  title: string;
  options: DecisionOption[];
  extras: Partial<Record<ExtraAction, DecisionExtra>>;
  /** Dialog-wide facts the options do not carry (uses left, prices, what is not exposed). */
  context: Record<string, unknown>;
  /** Count of decisions raised so far in this episode, starting at 1. */
  serial: number;
}

// ---------------------------------------------------------------- masks

export interface PlayMask {
  phase: 'play';
  /** One entry per MOVES index. All true: every direction can always be asked for. */
  move: boolean[];
  /** Whether pressing the button is accepted now. Jump and dash are always accepted (the game decides the effect). */
  jump: boolean;
  dash: boolean;
  /** True when the game reports the ultimate as charged and not running. */
  ultimate: boolean;
  /** True when the game has something in reach that the interact key would use right now. */
  interact: boolean;
  /** True when a Max form charge is held and the form is not running (the game's own `forms.ready`). */
  form: boolean;
  /** True when the game would open a rift now: Incense held and nothing in the way (the game's own `rifts.useBlock`). */
  incense: boolean;
  /** The same for a fused rift (three Incense). */
  fuse: boolean;
}

export interface ChoiceMask {
  phase: 'choice';
  /** One entry per `decision.options` index: can it be picked. */
  options: boolean[];
  /** For each extra action of the dialog: true/false, or one flag per option when the action needs a target. */
  extras: Partial<Record<ExtraAction, boolean | boolean[]>>;
}

/** No action is valid: the episode is over. */
export interface OverMask { phase: 'over' }

export type ActionMask = PlayMask | ChoiceMask | OverMask;

// ---------------------------------------------------------------- observation

export type Phase = 'play' | 'choice' | 'over';

export interface Observation {
  schema: typeof OBSERVATION_SCHEMA;
  phase: Phase;
  /** Environment steps taken in this episode (calls to `step`). */
  step: number;
  /** Simulation steps of 1/hz s run in this episode, loading phases excluded. */
  simStep: number;
  /** The raw state snapshot (src/bot/snapshot.ts, docs/SNAPSHOT.md). A fresh, frozen copy. */
  snapshot: Readonly<Snapshot>;
  /** Present in the choice phase. */
  decision: Readonly<Decision> | null;
  mask: Readonly<ActionMask>;
  /** Build, economy, progression clocks, guardian / seal / overtime state, all-enemy histogram, cumulative counters (src/observations/state.ts). */
  state: Readonly<RunState>;
  /** Only with the environment option `encode: true`: the numeric encoding (src/observations/encode.ts) and the action mask of the action codec. */
  encoded?: EncodedObservation;
}

/** The fixed-size numeric form of an observation. The buffers are fresh per observation; slice them with the layout descriptor. */
export interface EncodedObservation {
  /** OBS_ENCODING_VERSION and the hash of the layout descriptor the buffers follow. */
  version: number;
  layoutHash: string;
  float: Float32Array;
  int: Int32Array;
  /** Concatenated per-dimension action masks of src/actions/codec.ts (1 = allowed). */
  mask: Uint8Array;
}

export interface EndOfRun {
  /** won | died | quit | retired | restart | error … : the game's own `end.how`. */
  how: string;
  victory: boolean;
  /** The record the game sent when the run closed, as the local stand-in for the service stored it. */
  record: Record<string, unknown>;
}

export interface StepInfo {
  seed: number;
  /** Run clock in seconds. */
  time: number;
  kills: number;
  level: number;
  /** Zone (the game's `stage`): 1–3 are the map's zones, 4 is the sanctuary. */
  zone: number;
  zoneTime: number;
  /** The game's run state after the step: play | modal | transition | dead | over … */
  state: string;
  /** Simulation steps this call ran, and how many of them the player could not act in (loading, cut-scenes, fainting). */
  simSteps: number;
  idleSteps: number;
  /** Overtime: whether it is running, the round (1-based) and the bonus KOs it would add if cashed now. */
  overtime: { live: boolean; over: boolean; cashed: boolean; lost: boolean; round: number; bonus: number } | null;
  /** Seals kept so far in this run. */
  sealsKept: number;
  /** Cumulative counters of the run so far, the game's own figures (same object as `observation.state.counters`). */
  counters: Counters;
  /** Set when the action was not valid and `invalidAction: 'penalty'` is configured: nothing was done. */
  invalidAction?: string;
  /** Why the episode ended, once it has: the game's own cause, or `truncated: …`. */
  endCause?: string;
  /** The game's own end-of-run record, once the run is over. */
  end?: EndOfRun;
  /** Every network attempt the guard has blocked in this process (empty in a healthy run). */
  blockedNetwork: string[];
}

export interface StepResult {
  observation: Observation;
  /** Always 0 in Stage 1: rewards are defined with the trainer. */
  reward: number;
  /** The run is over (fainted, or its real end: the portal out of the sanctuary, overtime collapsed, …). */
  terminated: boolean;
  /** Only when the configured safety cap on game time was reached. */
  truncated: boolean;
  info: StepInfo;
}

// ---------------------------------------------------------------- reset / options / metadata

export interface ResetOptions {
  /** Seeds the random streams and the run ticket. Default: the previous seed + 1 (first episode: 1). */
  seed?: number;
  /** National Pokédex number of a League member. Default: 155 (Cyndaquil). */
  species?: number;
  /** Map id (the game's `biome`): forest, desert, coast, glacier, canela, cave, encina, iris, furia, plateado. */
  map?: string;
  /** Difficulty tier 0–2. */
  tier?: number;
  /** true (default): Ranked rules, i.e. the game's `competitive` run option in the standard mode. false: Classic. */
  ranked?: boolean;
}

export interface GameEnvironmentOptions {
  /** Simulation steps per game second. Fixed at 60 by the owner's decision; other values are for experiments. */
  hz?: number;
  /** Simulation steps per agent decision. Default 3 (20 decisions per second at 60 Hz). */
  actionRepeat?: number;
  /** What to do with an action the mask forbids: throw (default), or do nothing and flag it in `info.invalidAction`. */
  invalidAction?: 'throw' | 'penalty';
  /** Safety cap on the run clock in seconds; reaching it ends the episode as `truncated`. Default: none. */
  maxGameTime?: number;
  /**
   * The owner's rule against standing still (2026-11-24): an episode in which, for this many seconds of the run clock,
   * no KO was made AND the player did not leave a circle of `idleRadius` metres, ends there as `truncated` with the
   * end cause `idle: …`. Such a run is invalid: it never ends in the game either. Dialogs take no game time and do
   * not count. Default 0: no such rule.
   */
  maxIdleGameTime?: number;
  /** What counts as having moved, for `maxIdleGameTime`: leaving a circle of this radius (metres). Default 3. */
  idleRadius?: number;
  /**
   * The same rule read strictly (the owner, 2026-11-24: "in a real run, you'd be getting KOs extremely often"): an
   * episode in which no KO was made for this many seconds of the run clock ends there as `truncated` with the end
   * cause `idle: no KO for … s of game time`, whether the player moved or not. The time a guardian or the legendary
   * is alive does not count: a boss fight is one long KO. Time inside a rift does not count either, for this rule and for
   * `maxIdleGameTime` (the owner: "We should allow rifts infinite time"; the reward pays a rift by how quickly it is done). In the sanctuary outside Overtime, where nothing spawns, the
   * allowance is four times as long (the walk to the shrine, the rest before Overtime). Measured on 32 baseline episodes: outside boss fights and
   * rifts the longest stretch without a KO was 16 s; inside a rift, where the zone clock stands still and nothing
   * comes unless a wave is called, up to 800 s. Default 0: no such rule.
   */
  maxKoGapGameTime?: number;
  /** Defaults for `reset()`. */
  species?: number;
  map?: string;
  tier?: number;
  ranked?: boolean;
  /** Fresh account with everything unlocked (default), or the starter-only fresh account. */
  profile?: 'unlocked' | 'starter';
  /**
   * Preset unlocked-v4: the item archive of the unlocked account (`profile.itemsOff`), by the name of a version in
   * src/agents/heuristic2/values.ts (`empty`, `loose`, `balanced`, `narrow`). The archived items are generated from the
   * game's item effects for the kit of `species`, never more than the account has archive slots, and are taken out of
   * every Poké Ball and shop of the run by the game itself. Absent: unlocked-v3 (nothing archived).
   */
  archive?: string;
  /** Where the local stand-in for the game service keeps its files. Default: a per-process folder under data/env/. */
  dataDir?: string;
  /** Only `in-process-mock` is accepted (see src/sim/guard.ts). */
  apiTarget?: string;
  /** Print the page's console warnings and errors as they happen. */
  verbose?: boolean;
  /**
   * Also put the numeric encoding and the action-codec mask in every observation (`observation.encoded`). Needs the
   * game-knowledge export of the running build (data/game-knowledge/<build>/). Default: off.
   */
  encode?: boolean;
}

export interface GameMetadata {
  game: {
    /** Build id in the bundle's file names. */
    build: string;
    /** Version the bundle's own release list gives for this build (null when the list has no entry for it). */
    version: string | null;
    /** The value of the `x-client` header the game sends with its API calls (its API revision), when it has made one. */
    clientHeader: string | null;
    /** sha256 over the bytes of every loaded chunk, in load order. */
    bundleSha256: string;
    chunks: number;
    /** Minified identifiers the loader found (they change with every build). */
    identifiers: { app: string; App: string; Run: string } | null;
  };
  sim: { hz: number; dt: number; actionRepeat: number; decisionsPerSecond: number; render: boolean };
  schema: { observation: number; action: number; decision: number; snapshot: number };
  /** Every place environment code is spliced into game code or stands in for the game service. */
  instrumentation: string[];
  /** sha256 over the source of the browser shims (src/sim/*.ts) and the DOM library version. */
  shimHash: string;
  shims: string[];
  profile: { preset: string; registered: boolean; summary: Record<string, unknown> };
  mode: { ranked: boolean; season: Record<string, unknown> };
  offline: {
    guardInstalled: boolean;
    primitives: string[];
    selfTest: { ok: boolean; probes: number } | null;
    /** Blocked attempts so far: Node-level and page-level. */
    blocked: string[];
  };
  /** The game's frame-rate governor as it stands (it must never cut the live-enemy cap at 60 Hz). */
  governor: { low: number; high: number; liveCap: number; liveMax: number; cut: boolean; everCut: boolean } | null;
  /** `handlerWrites`: field writes the environment makes in place of a HUD click handler (src/environment/dialogs.ts). */
  dialogs: { handled: string[]; refused: string[]; handlerWrites: string[] };
  /** Versions of the learning-side formats: the state extractor, the action codec, and (with `encode: true`) the observation layout. */
  encoding: {
    state: number;
    action: { version: number; hash: string; nvec: number[]; maskSize: number };
    observation: { version: number; layoutHash: string; floatSize: number; intSize: number; vocabSha256: string } | null;
  };
}

export interface GameEnvironment {
  reset(options?: ResetOptions): Promise<Observation>;
  step(action: Action): Promise<StepResult>;
  getObservation(): Observation;
  getMetadata(): GameMetadata;
  close(): Promise<void>;
}

/** Raised for an action the current mask forbids (with `invalidAction: 'throw'`). */
export class InvalidActionError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidActionError'; }
}

/** Raised when the game does something the environment has no rule for. Never papered over. */
export class UnknownSituationError extends Error {
  details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown>) {
    super(`${message}\n${JSON.stringify(details, null, 2)}`);
    this.name = 'UnknownSituationError';
    this.details = details;
  }
}
