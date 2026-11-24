import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JobInfo } from '../shared/api.ts';
import type { Context } from './context.ts';

/**
 * The processes the dashboard starts: the project's own command lines (`python -m pokebonk_rl.train | evaluate |
 * registry | watch`), nothing else. A job writes its output to a log file under `logs/dashboard/`; the list of jobs
 * is kept in `data/dashboard/jobs.json` so that a restarted dashboard still knows what it started.
 *
 * Training and evaluation are started detached: closing the dashboard does not stop them.
 */

interface Stored extends JobInfo { gameProcesses: number }

export interface StartOptions {
  kind: JobInfo['kind'];
  title: string;
  /** Arguments after the Python executable. */
  args: string[];
  run?: string | null;
  /** Game processes the job will hold (memory is the limit of the machine). */
  gameProcesses?: number;
  detached?: boolean;
}

const alive = (pid: number | null): boolean => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

export class Jobs {
  private jobs: Stored[] = [];
  private children = new Map<number, ChildProcess>();
  private stopping = new Set<number>();
  private readonly file: string;
  private readonly ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
    this.file = join(ctx.state, 'jobs.json');
    if (existsSync(this.file)) {
      try { this.jobs = JSON.parse(readFileSync(this.file, 'utf8')) as Stored[]; } catch { this.jobs = []; }
    }
  }

  private save(): void {
    mkdirSync(this.ctx.state, { recursive: true });
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.jobs.slice(-200), null, 1));
    renameSync(tmp, this.file);
  }

  /** Jobs, newest first, with the state of those this process no longer holds a handle to brought up to date. */
  list(): JobInfo[] {
    let changed = false;
    for (const j of this.jobs) {
      if (j.state === 'running' && !this.children.has(j.id) && !alive(j.pid)) {
        // Started by an earlier dashboard process and ended since: its exit code was not seen.
        j.state = 'unknown'; j.finishedAt ??= new Date().toISOString(); changed = true;
      }
    }
    if (changed) this.save();
    return this.jobs.map(({ gameProcesses: _g, ...j }) => j).reverse();
  }

  get(id: number): JobInfo | undefined { return this.list().find((j) => j.id === id); }

  running(): Stored[] { this.list(); return this.jobs.filter((j) => j.state === 'running'); }

  /** Game processes held by the jobs that are running now. */
  gameProcessesInUse(): number { return this.running().reduce((n, j) => n + j.gameProcesses, 0); }

  start(o: StartOptions): { job: JobInfo; child: ChildProcess } {
    mkdirSync(this.ctx.logs, { recursive: true });
    const id = (this.jobs.at(-1)?.id ?? 0) + 1;
    const log = join(this.ctx.logs, `job-${String(id).padStart(4, '0')}-${o.kind}.log`);
    const args = [...this.ctx.pythonArgs, ...o.args];
    const command = [this.ctx.python, ...args];
    const fd = openSync(log, 'a');
    let child: ChildProcess;
    try {
      // PYTHONUNBUFFERED: the log shows progress as it happens.
      child = spawn(this.ctx.python, args, {
        cwd: this.ctx.repo, detached: o.detached ?? false, windowsHide: true, env: { ...process.env, PYTHONUNBUFFERED: '1' },
        stdio: o.kind === 'watch' ? ['ignore', 'pipe', fd] : ['ignore', fd, fd],
      });
    } finally { closeSync(fd); }
    const job: Stored = {
      id, kind: o.kind, title: o.title, command, startedAt: new Date().toISOString(), finishedAt: null, state: 'running', exitCode: null, pid: child.pid ?? null, run: o.run ?? null, log,
      gameProcesses: o.gameProcesses ?? 0,
    };
    this.jobs.push(job);
    this.children.set(id, child);
    const finish = (code: number | null, error?: Error) => {
      if (job.state !== 'running') return;
      job.exitCode = code; job.finishedAt = new Date().toISOString(); job.state = code === 0 ? 'succeeded' : this.stopping.delete(id) ? 'stopped' : 'failed';
      if (error) { try { writeFileSync(log, `\ncould not start: ${error.message}\n`, { flag: 'a' }); } catch { /* the state says it failed */ } }
      this.children.delete(id);
      this.save();
    };
    child.on('error', (e) => finish(null, e));
    child.on('exit', (code) => finish(code));
    if (o.detached) child.unref();
    this.save();
    const { gameProcesses: _g, ...info } = job;
    return { job: info, child };
  }

  /** Start a short job and wait for it to end (registry commands: they finish in seconds). */
  async runToEnd(o: StartOptions, timeoutMs = 120_000): Promise<JobInfo> {
    const { job, child } = this.start(o);
    await new Promise<void>((done) => {
      const timer = setTimeout(done, timeoutMs);
      const end = () => { clearTimeout(timer); done(); };
      child.once('exit', end);
      child.once('error', end);
    });
    return this.get(job.id)!;
  }

  /** End a job on request (a watched session): it is then `stopped`, not `failed`. */
  stop(id: number): void {
    const child = this.children.get(id);
    if (!child) return;
    this.stopping.add(id);
    child.kill();
  }

  /** The end of a job's log. */
  logTail(id: number, bytes = 16_000): string {
    const j = this.jobs.find((x) => x.id === id);
    if (!j || !existsSync(j.log)) return '';
    const size = statSync(j.log).size, from = Math.max(0, size - bytes);
    const fd = openSync(j.log, 'r');
    try {
      const buf = Buffer.alloc(size - from);
      readSync(fd, buf, 0, buf.length, from);
      const text = buf.toString('utf8');
      return from > 0 ? text.slice(text.indexOf('\n') + 1) : text;
    } finally { closeSync(fd); }
  }
}
