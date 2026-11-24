import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, type Config } from '../config.ts';
import { logger } from '../logger.ts';
import { Mirror } from './mirror.ts';
import { MockApi } from './mockApi.ts';
import { Store } from './store.ts';

const log = logger('sandbox');

/** Live status the bot publishes for the dashboard. */
export interface BotStatus { phase: string; note?: string; run?: Record<string, unknown>; updated: number; decisions?: string[] }

/**
 * The sandbox host: one HTTP server on localhost.
 *
 *   /                 the mirrored game (static files from ./mirror)
 *   /__api/*          the mock game API (see docs/ENDPOINTS.md)
 *   /__sandbox/       dashboard; /__sandbox/api/* its JSON feeds (run journal, live bot status)
 */
export class SandboxHost {
  readonly cfg: Config;
  readonly store: Store;
  readonly api: MockApi;
  readonly mirror: Mirror;
  botStatus: BotStatus = { phase: 'idle', updated: Date.now() };
  private server: Server | null = null;

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.store = new Store(cfg.dataDir);
    this.api = new MockApi(this.store);
    this.mirror = new Mirror({ dir: cfg.mirrorDir, upstream: cfg.upstream, fillMisses: cfg.fillMisses, dataDir: cfg.dataDir });
    this.loadFamilies();
  }

  /** Evolution families from the mirrored species data, so a capture unlocks its whole line like the game expects. */
  private loadFamilies() {
    try {
      const list = JSON.parse(readFileSync(join(this.cfg.mirrorDir, 'data', 'pokemon.json'), 'utf8')) as { id: number; family?: number }[];
      const map = new Map(list.map((p) => [p.id, p.family ?? p.id]));
      this.api.family = (s) => map.get(s) ?? s;
    } catch { /* mirror not copied yet */ }
  }

  private json(res: import('node:http').ServerResponse, value: unknown, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const url = req.url ?? '/', path = url.split('?')[0];
      const fail = (e: unknown) => { log.error(`${req.method} ${path}`, String((e as Error).stack ?? e)); if (!res.headersSent) res.writeHead(500); res.end(); };
      try {
        if (path.startsWith('/__api/') || path === '/__api') { void this.api.serve(req, res, url.slice('/__api'.length) || '/').catch(fail); return; }
        if (path === '/__sandbox' || path.startsWith('/__sandbox/')) { this.dashboard(path, res); return; }
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
        void this.mirror.serve(req, res, url).catch(fail);
      } catch (e) { fail(e); }
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      // Loopback only: the sandbox is never reachable from another machine.
      this.server!.listen(this.cfg.port, '127.0.0.1', () => resolve());
    });
    log.info(`sandbox host on http://localhost:${this.cfg.port}  (dashboard: /__sandbox/)${this.cfg.fillMisses ? '  [warm-up: missing static files are fetched once]' : ''}`);
    if (!this.mirror.hasIndex()) log.warn('the mirror is empty: run `npm run mirror` first');
  }

  private dashboard(path: string, res: import('node:http').ServerResponse) {
    const sub = path.slice('/__sandbox'.length) || '/';
    if (sub === '/' ) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(readFileSync(join(ROOT, 'src', 'dashboard', 'index.html')));
      return;
    }
    if (sub === '/api/journal') return this.json(res, this.store.journal());
    if (sub === '/api/status') return this.json(res, { bot: this.botStatus, mirror: this.mirror.stats, now: Date.now(), dryRun: this.cfg.dryRun });
    if (sub === '/api/endpoints') return this.json(res, this.api.list());
    if (sub.startsWith('/api/run/')) {
      const r = this.store.run(sub.slice('/api/run/'.length));
      return r ? this.json(res, r) : this.json(res, { error: 'Unknown run' }, 404);
    }
    this.json(res, { error: 'Not found' }, 404);
  }

  async stop() { await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r())); }
}
