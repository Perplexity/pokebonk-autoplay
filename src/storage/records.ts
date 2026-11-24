import type { ChoiceAction, ChoiceMask, DecisionOption } from '../environment/types.ts';

/**
 * What the runner stores about episodes. Everything here is plain JSON: a worker process builds these records and
 * sends them to the parent, which is the only writer of the database (src/storage/database.ts, docs/storage.md).
 */

/** One answered dialog: what was offered and what was picked. */
export interface DecisionRecord {
  /** The decision's number in its episode, starting at 1 (`Decision.serial`). */
  serial: number;
  /** Environment step at which it was answered. */
  step: number;
  gameTime: number;
  zone: number;
  level: number;
  kind: string;
  /** The HUD method the game called. */
  method: string;
  options: DecisionOption[];
  context: Record<string, unknown>;
  mask: ChoiceMask;
  chosen: ChoiceAction;
  /** The pick in words: an option id (`upMove:m915`), or `extra:<name>` / `extra:<name>><target option id>`. */
  chosenId: string;
}

/** The build the run ended with: `observation.state.build` of the last observation, with move names and the stat block from its snapshot. */
export interface FinalBuild {
  species: number;
  startSpecies: number;
  evoStage: number;
  passive: string;
  level: number;
  maxHp: number;
  moveSlots: number;
  /** One entry per filled slot. `damageDone` is the damage the move dealt in the run. */
  moves: { slot: number; key: string; id: number; name: string; level: number; type: string; arch: string; cls: string; damageDone: number; fusion: boolean; linked: string | null }[];
  vitaminSlots: number;
  vitamins: { key: string; level: number }[];
  items: { key: string; count: number }[];
  relics: string[];
  /** Level-up uses left at the end. */
  refreshes: number;
  skips: number;
  banishes: number;
  revives: number;
  /** The game's computed stat block (damage, area, armor, regen, …). */
  stats: Record<string, number>;
}

export interface EpisodeRecord {
  seed: number;
  /** Species the run started with, and the one it ended as (evolution). */
  species: number;
  finalSpecies: number;
  map: string;
  tier: number;
  ranked: boolean;
  terminated: boolean;
  truncated: boolean;
  /** The environment's cause of end: `died`, `won (victory), overtime cashed`, `truncated: …`. */
  endCause: string;
  /** The game's own `end.how` (null when the episode was truncated: the run never closed). */
  endHow: string | null;
  victory: boolean;
  gameTime: number;
  /** KOs counted by the run (`run.stats.kills`), without any overtime bonus. */
  kills: number;
  overtime: { started: boolean; bonus: number; rounds: number; cashed: boolean };
  level: number;
  zone: number;
  guardiansDefeated: number;
  legendariesDefeated: number;
  sealsKept: number;
  steps: number;
  simSteps: number;
  wallSeconds: number;
  resetSeconds: number;
  finalBuild: FinalBuild;
  /** The run's cumulative counters at the end (`info.counters`, src/observations/state.ts): damage dealt and taken, healing, hits, gold, captures… */
  counters: Record<string, number>;
  /** The game's own end-of-run record, as the local stand-in for the service stored it (null when truncated). */
  record: Record<string, unknown> | null;
  blockedNetwork: string[];
  decisions: DecisionRecord[];
  worker: { id: number; pid: number; episode: number; rssMB: number };
  startedAt: string;
  finishedAt: string;
}

export type ErrorKind = 'episode-error' | 'worker-timeout' | 'worker-exit' | 'worker-start' | 'metadata-mismatch' | 'runner';

export interface ErrorRecord {
  kind: ErrorKind;
  seed: number | null;
  workerId: number | null;
  message: string;
  /** Stack, the environment's own details (UnknownSituationError), the worker's last progress report… */
  details: Record<string, unknown>;
  occurredAt: string;
}

export interface BatchInput {
  label: string | null;
  policyName: string;
  policyVersion: string;
  /** The runner's configuration as given (episodes, seeds, workers, species, map, tier, caps, recycling…). */
  config: Record<string, unknown>;
  hz: number;
  actionRepeat: number;
  rewardVersion: string | null;
  host: Record<string, unknown>;
  episodesPlanned: number;
  startedAt: string;
}

/** What the environment reports about itself (`getMetadata()`), as far as a batch records it in columns. */
export interface BatchMetadata {
  gameBuild: string;
  gameVersion: string | null;
  bundleSha256: string;
  shimHash: string;
  observationSchema: number;
  actionSchema: number;
  decisionSchema: number;
  snapshotSchema: number;
  profilePreset: string;
  ranked: boolean;
  /** The whole metadata object. */
  full: Record<string, unknown>;
}
