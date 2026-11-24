import type { BatchMetadata, EpisodeRecord } from '../storage/records.ts';
import type { EpisodeProgress } from './episode.ts';

/** Messages between the runner's parent process and its worker processes (JSON over Node's IPC channel). */

export interface WorkerInit {
  type: 'init';
  workerId: number;
  policy: string;
  /** The policy's own settings (src/runner/policies.ts). */
  policyOptions: Record<string, unknown>;
  env: { hz: number; actionRepeat: number; maxGameTime: number; species: number; map: string; tier: number; ranked: boolean };
  /** TEST ONLY: seeds on which the worker throws, or blocks its event loop for good, instead of playing. */
  faults?: { throwSeeds?: number[]; hangSeeds?: number[] };
}
export type ToWorker = WorkerInit | { type: 'episode'; seed: number } | { type: 'shutdown' };

export type FromWorker =
  | { type: 'ready'; workerId: number; pid: number }
  | { type: 'progress'; workerId: number; progress: EpisodeProgress }
  /** `metadata` comes with the first episode of each worker: the environment only knows it once the game is loaded. */
  | { type: 'episode'; workerId: number; record: EpisodeRecord; metadata?: BatchMetadata }
  /** The episode threw. The worker exits after sending this: the environment's state is not trusted any more. */
  | { type: 'error'; workerId: number; seed: number | null; name: string; message: string; stack: string; details: Record<string, unknown> | null };
