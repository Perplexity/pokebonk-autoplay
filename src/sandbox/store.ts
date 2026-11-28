import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Local persistence for the sandbox. Everything is plain JSON under the data folder:
 *
 *   data/db.json            sessions and profiles (one per local account)
 *   data/runs/<id>.json     one file per run: ticket, checkpoints, result, status
 *   data/saves/<id>.json    the game's own suspend/cloud save blob for a run (resume)
 *   data/journal.jsonl      one line per finished run
 */

export interface Account { id: string; name: string; token: string; guest: boolean; created: number }

export interface RunRecord {
  id: string;
  acc: string;
  key?: string;
  status: 'live' | 'suspended' | 'finished' | 'discarded';
  started: number;
  ended?: number;
  /** What the client asked for: species, biome, tier, mode, boosts. */
  request: Record<string, unknown>;
  /** What the sandbox issued: seed, mode config, mutation of the day. */
  ticket: Record<string, unknown>;
  checkpoints: unknown[];
  suspendHash?: string;
  saveHash?: string;
  result?: Record<string, any>;
}

export interface JournalEntry {
  id: string;
  acc: string;
  at: number;
  mode: string;
  species: number;
  biome: string;
  tier: number;
  time: number;
  level: number;
  kills: number;
  stage: number;
  victory: boolean;
  how: string;
  bosses: number;
  captures: number;
  shinies: number;
  score?: number;
}

interface Db { v: 1; accounts: Record<string, Account>; profiles: Record<string, Record<string, any>> }

export class Store {
  readonly dir: string;
  private db: Db;

  constructor(dir: string) {
    this.dir = dir;
    for (const d of ['', 'runs', 'saves', 'logs']) mkdirSync(join(dir, d), { recursive: true });
    this.db = this.read<Db>('db.json') ?? { v: 1, accounts: {}, profiles: {} };
  }

  private read<T>(rel: string): T | null {
    const f = join(this.dir, rel);
    if (!existsSync(f)) return null;
    try { return JSON.parse(readFileSync(f, 'utf8')) as T; } catch { return null; }
  }

  /** Write to a temp file and rename: a crash mid-write never leaves half a file. */
  private write(rel: string, value: unknown) {
    const f = join(this.dir, rel), tmp = f + '.tmp';
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, f);
  }

  private flush() { this.write('db.json', this.db); }

  // ---- accounts and profiles ----
  accountByToken(token: string | undefined): Account | null {
    if (!token) return null;
    return Object.values(this.db.accounts).find((a) => a.token === token) ?? null;
  }
  accounts(): Account[] { return Object.values(this.db.accounts); }
  putAccount(a: Account) { this.db.accounts[a.id] = a; this.flush(); }

  profile(accId: string): Record<string, any> | null { return this.db.profiles[accId] ?? null; }
  putProfile(accId: string, p: Record<string, any>) { this.db.profiles[accId] = p; this.flush(); }

  // ---- runs ----
  run(id: string): RunRecord | null {
    return /^[\w-]{6,64}$/.test(id) ? this.read<RunRecord>(join('runs', id + '.json')) : null;
  }
  putRun(r: RunRecord) { this.write(join('runs', r.id + '.json'), r); }
  /** Delete a run file (and its save). The headless environment does this once it has copied a finished run's record. */
  dropRun(id: string) {
    if (!/^[\w-]{6,64}$/.test(id)) return;
    try { rmSync(join(this.dir, 'runs', id + '.json'), { force: true }); } catch { /* gone */ }
    this.dropSave(id);
  }
  runs(): RunRecord[] {
    return readdirSync(join(this.dir, 'runs')).filter((f) => f.endsWith('.json'))
      .map((f) => this.read<RunRecord>(join('runs', f))).filter((r): r is RunRecord => !!r);
  }
  runByKey(acc: string, key: string): RunRecord | null {
    return this.runs().find((r) => r.acc === acc && r.key === key) ?? null;
  }

  // ---- saves (the game's own suspend blob, stored as sent) ----
  save(id: string): { hash: string; enc: string; data: string } | null {
    return /^[\w-]{6,64}$/.test(id) ? this.read(join('saves', id + '.json')) : null;
  }
  putSave(id: string, s: { hash: string; enc: string; data: string }) { this.write(join('saves', id + '.json'), s); }
  dropSave(id: string) { try { rmSync(join(this.dir, 'saves', id + '.json'), { force: true }); } catch { /* gone */ } }

  // ---- journal ----
  appendJournal(e: JournalEntry) { appendFileSync(join(this.dir, 'journal.jsonl'), JSON.stringify(e) + '\n'); }
  journal(): JournalEntry[] {
    const f = join(this.dir, 'journal.jsonl');
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l) as JournalEntry]; } catch { return []; }
    });
  }

  /** Requests the mock had no handler for, so the endpoint list can be kept honest. */
  noteUnhandled(method: string, path: string) {
    try { appendFileSync(join(this.dir, 'logs', 'unhandled-api.log'), `${new Date().toISOString()} ${method} ${path}\n`); } catch { /* best effort */ }
  }
}
