/**
 * The contract between the dashboard's server (dashboard/server) and its page (dashboard/src): every JSON shape the
 * API returns. Types only, so both sides import it without sharing any code.
 */

/** Summary statistics of a set of episodes. Score = KOs + the overtime bonus when it was cashed (what the ranking counts); 0 for an invalid run. */
export interface Summary {
  episodes: number;
  kosMean: number; kosMedian: number; kosMax: number;
  scoreMean: number; scoreMedian: number; scoreMax: number;
  gameTimeMean: number; gameTimeMedian: number;
  levelMean: number;
  completed: number; died: number; truncated: number;
  /** Episodes ended by the rule against standing still. They score 0. */
  invalid: number;
  /** Episodes by the zone they ended in (1–3, 4 = sanctuary). */
  zones: Record<string, number>;
  /** Episodes by the number of zone guardians beaten. */
  guardians: Record<string, number>;
  overtimeStarted: number; overtimeCashed: number;
}

export interface JobInfo {
  id: number;
  kind: 'train' | 'resume' | 'evaluate' | 'register' | 'promote' | 'rollback' | 'watch';
  title: string;
  command: string[];
  startedAt: string;
  finishedAt: string | null;
  /** `running` while the process lives; `stopped` when it was ended on request; `unknown` when the dashboard was restarted and the process ended meanwhile. */
  state: 'running' | 'succeeded' | 'failed' | 'stopped' | 'unknown';
  exitCode: number | null;
  pid: number | null;
  run: string | null;
  log: string;
}

export interface SessionInfo {
  id: number; run: string; batchId: number; status: string;
  startedAt: string; finishedAt: string | null;
  startTimesteps: number; endTimesteps: number | null;
  /** The newest sign of life: an episode stored or a checkpoint written. */
  lastActivityAt: string;
  /** A session the database calls running that showed life in the last ten minutes. */
  live: boolean;
  episodes: number; errors: number;
  decisionsPerSecond: number | null; episodesPerHour: number | null;
}

export interface CheckpointInfo { id: number; run: string; timesteps: number; kind: string; createdAt: string; sha256: string; episodes: number; path: string }

export interface ModelInfo {
  id: number; role: 'candidate' | 'stable' | 'retired'; createdAt: string; sha256: string; run: string | null; timesteps: number | null;
  evaluationId: number | null; note: string | null; path: string;
  /** The newest judged evaluation of exactly this file, if any. */
  verdict: { evaluationId: number; passed: boolean } | null;
}

export interface EvaluationInfo {
  id: number; createdAt: string; batchId: number; run: string | null; timesteps: number | null; modelSha256: string;
  deterministic: boolean; seeds: number; seedsLabel: string; scenario: { species: number; map: string; tier: number };
  summary: Summary;
  reference: string | null;
  /** Reference summary on the same seeds, when the evaluation was compared with something. */
  referenceSummary: Summary | null;
  ratio: number | null; metric: string | null; minRatio: number | null;
  /** true / false: a promotion verdict. null: not judged (see `note`). */
  passed: boolean | null;
  /** Whether this comparison counts as a promotion verdict, and if not, why. */
  isVerdict: boolean; note: string | null;
  perSeed: { wins: number; losses: number; ties: number } | null;
  lostToErrors: number;
  rewardMean: number | null;
  rewardComponents: Record<string, number> | null;
}

export interface Overview {
  generatedAt: string;
  database: { path: string; exists: boolean; schemaVersion: number | null };
  totals: { trainingEpisodes: number; trainingSteps: number; runs: number; evaluations: number; scriptedEpisodes: number; errors: number };
  status: {
    state: 'training' | 'evaluating' | 'idle';
    headline: string;
    jobs: JobInfo[];
    sessions: SessionInfo[];
    memory: { totalMB: number; freeMB: number };
    gameProcessBudget: number;
  };
  latestCheckpoint: CheckpointInfo | null;
  stable: ModelInfo | null;
  candidates: ModelInfo[];
  latestEvaluation: EvaluationInfo | null;
  /** The run the overview is about: the newest one. */
  focusRun: string | null;
  builds: { build: string; version: string | null }[];
}

export interface RunInfo {
  name: string; createdAt: string; algorithm: string; rewardVersion: string; gameBuild: string;
  targetTimesteps: number; timesteps: number; episodes: number;
  status: 'running' | 'completed' | 'interrupted' | 'failed' | 'stale' | 'new';
  workers: { envs: number; spares: number }; device: string;
  scenarios: { species: number[]; maps: string[]; tiers: number[] };
  stopRequested: boolean;
  sessions: SessionInfo[];
  checkpoints: CheckpointInfo[];
  evaluations: EvaluationInfo[];
  decisionsPerSecond: number | null; episodesPerHour: number | null;
  rewardWeights: Record<string, number>; rewardScale: number;
}

export interface CurveBin {
  /** Bin centre in training decisions. */
  t: number; from: number; to: number; episodes: number;
  scoreMean: number; scoreMedian: number; kosMean: number; gameTimeMean: number; levelMean: number; zoneMean: number;
  completedShare: number; rewardMean: number; components: Record<string, number>;
  /** Mean of the game's own counters named in `Curve.counters`. */
  counters: Record<string, number>;
}

export interface Curve {
  run: string; episodes: number; timesteps: number;
  bins: CurveBin[];
  /** Individual episodes (all of them, or an even sample when there are many): decisions at the end, score, game time. */
  points: { t: number; score: number; gameTime: number; zone: number; id: number }[];
  /** Scripted baselines on the same Pokémon, map and tier, for scale. */
  references: { policy: string; label: string; batchId: number; episodes: number; scoreMedian: number; scoreMean: number }[];
  components: string[];
  counters: string[];
  /** Decisions per second between consecutive checkpoints. */
  throughput: { t: number; at: string; decisionsPerSecond: number }[];
  summary: Summary | null;
  /** Summary of the most recent quarter of the run's episodes, and of the first quarter, to say whether it is moving. */
  firstQuarter: Summary | null; lastQuarter: Summary | null;
}

export interface BatchInfo {
  id: number; label: string | null; startedAt: string; finishedAt: string | null; status: string;
  kind: 'training' | 'evaluation' | 'scripted';
  policy: string; policyVersion: string; species: number[]; map: string | null; tier: number | null;
  gameBuild: string | null; gameVersion: string | null; preset: string | null; rewardVersion: string | null;
  planned: number; errors: number; wallSeconds: number | null; seedsLabel: string;
  summary: Summary | null;
}

export interface GroupRow { key: string; label: string; policy: string; batches: number; summary: Summary }

export interface ChoiceRow {
  kind: 'move' | 'item' | 'vitamin' | 'relic';
  key: string; name: string;
  /** Episodes that ended holding it, and their share of the scope. */
  episodes: number; share: number;
  scoreMedianWith: number; scoreMedianWithout: number | null;
  /** Mean level it had at the end (moves and vitamins) or mean count (items). */
  meanLevel: number | null;
}

export interface PickRow { kind: string; chosen: string; label: string; times: number; share: number }

export interface Breakdowns {
  scopes: { id: string; label: string; episodes: number }[];
  scope: string;
  bySpecies: GroupRow[];
  byVersion: GroupRow[];
  choices: ChoiceRow[];
  /** What was picked in dialogs, when the scope's batches stored their decisions. */
  picks: PickRow[];
  scopeSummary: Summary | null;
  names: { species: Record<string, string> };
}

export interface EpisodeRow {
  id: number; batchId: number; seed: number; species: number; map: string; tier: number;
  endCause: string; gameTime: number; kills: number; score: number; level: number; zone: number;
  guardians: number; victory: boolean; overtimeCashed: boolean; overtimeBonus: number;
  decisions: number; storedDecisions: number; finishedAt: string; reward: number | null;
}

export interface EpisodeDetail extends EpisodeRow {
  batch: BatchInfo;
  build: {
    level: number; maxHp: number;
    moves: { name: string; key: string; level: number; type: string; damageDone: number; fusion: boolean }[];
    vitamins: { key: string; name: string; level: number }[];
    items: { key: string; name: string; count: number }[];
    relics: { key: string; name: string }[];
  } | null;
  counters: Record<string, number>;
  rewardComponents: Record<string, number> | null;
  timeline: { serial: number; gameTime: number; zone: number; level: number; kind: string; chosen: string; options: { id: string; label: string; valid: boolean }[] }[];
  /** How to watch it again: the model file and seed, when the episode was played by a stored model. */
  replay: { model: string; seed: number; deterministic: boolean } | null;
}

export interface EvaluationDetail extends EvaluationInfo {
  rows: { seed: number; episodeId: number; score: number; kills: number; gameTime: number; level: number; zone: number; endCause: string; referenceScore: number | null }[];
  modelPath: string;
}

export interface ModelsView {
  stable: ModelInfo | null;
  pointer: { model_id: number; path: string; sha256: string; promoted_at: string } | null;
  models: ModelInfo[];
  events: { id: number; at: string; action: string; modelId: number; previousStableId: number | null; evaluationId: number | null; note: string | null }[];
  /** Files of the stable model folder with their hashes as last seen, so a change would be visible. */
  stableFiles: { name: string; bytes: number }[];
}

export interface Meta {
  repo: string;
  pythonFound: boolean;
  builtAt: string | null;
  defaults: {
    training: { envs: number; spares: number; totalTimesteps: number; checkpointEvery: number; species: number[]; rewardFile: string; device: string };
    evaluation: { seeds: string; species: number; map: string; tier: number; envs: number; metric: string; minRatio: number; firstReference: string; promotionSeeds: string };
  } | null;
  gameProcessBudget: number;
  suggestedRunName: string;
  /** Stored batches a model can be compared with, by the seeds they played. */
  references: { label: string; batchId: number; policy: string; seedsLabel: string; species: number[] }[];
  /** What can be evaluated, registered or watched. */
  modelChoices: { ref: string; label: string; detail: string }[];
}

export interface ActionResult { ok: boolean; message: string; job?: JobInfo }

/** One frame of a watched session, as the watcher prints it. */
export interface WatchFrame {
  t: 'frame';
  time: number; zone: number; kills: number; level: number; hp: number; maxHp: number; x: number; z: number;
  phase: 'play' | 'choice' | 'over';
  enemies: number;
  /** Nearest enemies as [x, z, radius, flags]. */
  near: [number, number, number, number][];
  boss: { x: number; z: number; hp: number; maxHp: number; name: string } | null;
  points: [string, number, number, number][];
  hazards: [number, number, number][];
  shots: [number, number][];
  decision: { kind: string; options: string[] } | null;
  /** What the model did with this frame: a direction 0–8 and buttons, or the dialog answer in words. */
  action: { move: number; buttons: string[]; choice: string | null } | null;
  bounds: number | null;
}
export type WatchEvent =
  | { t: 'start'; model: string; sha256: string; run: string | null; timesteps: number | null; seed: number; scenario: { species: number; map: string; tier: number }; deterministic: boolean; speed: number }
  | WatchFrame
  | { t: 'end'; kills: number; score: number; gameTime: number; level: number; zone: number; endCause: string; steps: number }
  | { t: 'error'; message: string }
  | { t: 'closed'; code: number | null };

export interface WatchState { active: boolean; startedAt: string | null; job: JobInfo | null; start: Extract<WatchEvent, { t: 'start' }> | null; ended: Extract<WatchEvent, { t: 'end' }> | null }
