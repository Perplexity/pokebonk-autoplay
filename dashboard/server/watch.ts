import type { ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';
import type { JobInfo, WatchEvent, WatchState } from '../shared/api.ts';
import type { Jobs } from './jobs.ts';

/**
 * One watched session at a time: `python -m pokebonk_rl.watch` plays an episode with a stored model in one game
 * process of its own and prints a JSON line per frame; this relays the lines to the pages that are listening
 * (server-sent events). Nothing of it is stored: an evaluation episode is watched again by playing its model file
 * and seed again, which gives the same episode (docs/training.md §5).
 */
export class Watch {
  private listeners = new Set<ServerResponse>();
  private job: JobInfo | null = null;
  private stopChild: (() => void) | null = null;
  private start: Extract<WatchEvent, { t: 'start' }> | null = null;
  private ended: Extract<WatchEvent, { t: 'end' }> | null = null;
  private lastFrame: Extract<WatchEvent, { t: 'frame' }> | null = null;
  private closed: Extract<WatchEvent, { t: 'closed' | 'error' }> | null = null;
  private startedAt: string | null = null;
  private readonly jobs: Jobs;

  constructor(jobs: Jobs) { this.jobs = jobs; }

  get active(): boolean { return this.stopChild !== null; }

  state(): WatchState { return { active: this.active, startedAt: this.startedAt, job: this.job ? this.jobs.get(this.job.id) ?? this.job : null, start: this.start, ended: this.ended }; }

  private send(res: ServerResponse, event: WatchEvent): void { res.write(`data: ${JSON.stringify(event)}\n\n`); }

  private publish(event: WatchEvent): void {
    if (event.t === 'start') this.start = event;
    if (event.t === 'end') this.ended = event;
    if (event.t === 'frame') this.lastFrame = event;
    if (event.t === 'closed' || event.t === 'error') this.closed = event;
    for (const res of this.listeners) this.send(res, event);
  }

  begin(args: string[], title: string): JobInfo {
    this.stop();
    this.start = null; this.ended = null; this.lastFrame = null; this.closed = null;
    const { job, child } = this.jobs.start({ kind: 'watch', title, args, gameProcesses: 1 });
    this.job = job;
    this.startedAt = job.startedAt;
    this.stopChild = () => this.jobs.stop(job.id);
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', (line) => {
      if (!line.startsWith('{')) return;
      try { this.publish(JSON.parse(line) as WatchEvent); } catch { /* a line that is not a frame is not for the page */ }
    });
    child.once('exit', (code) => {
      if (this.job?.id !== job.id) return;
      this.stopChild = null;
      if (code !== 0 && !this.ended && this.jobs.get(job.id)?.state !== 'stopped') this.publish({ t: 'error', message: this.jobs.logTail(job.id, 1500).trim().split('\n').at(-1) || `the watcher ended with exit code ${code}` });
      this.publish({ t: 'closed', code });
    });
    child.once('error', (e) => { if (this.job?.id === job.id) { this.stopChild = null; this.publish({ t: 'error', message: e.message }); } });
    return job;
  }

  stop(): void {
    this.stopChild?.();
    this.stopChild = null;
  }

  /** A page starts listening: it gets the session's start, its newest frame and, if it is over, how it ended; then every event. */
  listen(res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': listening\n\n');
    for (const event of [this.start, this.lastFrame, this.ended, this.closed]) if (event) this.send(res, event);
    this.listeners.add(res);
    res.on('close', () => this.listeners.delete(res));
  }

  close(): void {
    this.stop();
    for (const res of this.listeners) res.end();
    this.listeners.clear();
  }
}
