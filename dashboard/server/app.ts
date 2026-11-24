import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { freemem, totalmem } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import type { ActionResult, Overview } from '../shared/api.ts';
import { ActionError, Actions } from './actions.ts';
import { createContext } from './context.ts';
import type { Context } from './context.ts';
import { Jobs } from './jobs.ts';
import { Reader } from './reader.ts';
import { Watch } from './watch.ts';

/**
 * The dashboard's server: JSON for the page, the page's built files, and the buttons.
 *
 * - It listens on 127.0.0.1 only and makes no outgoing connection of any kind.
 * - It answers only requests addressed to a loopback host (a page on another site cannot reach it by a rebound
 *   name), and a request that changes something must carry a header only this page sends and come from a loopback
 *   origin (a page on another site cannot post to it).
 * - The database is read-only here (reader.ts); every change goes through the project's command lines (actions.ts).
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json; charset=utf-8',
};
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const hostOf = (value: string | undefined): string => (value ?? '').replace(/:\d+$/, '').toLowerCase();

const NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>PokéBonk training dashboard</title>
<body style="font: 16px/1.5 system-ui; max-width: 40rem; margin: 4rem auto; padding: 0 1rem">
<h1 style="font-size: 1.4rem">The dashboard page is not built yet</h1>
<p>Build it once, then reload this page:</p><pre>npm run dashboard:build</pre>
<p>The data is already being served: <a href="/api/overview">/api/overview</a>.</p></body>`;

export interface App { server: Server; ctx: Context; reader: Reader; jobs: Jobs; actions: Actions; watch: Watch; listen(): Promise<number>; close(): Promise<void> }

export function createApp(over: Partial<Context> = {}): App {
  const ctx = createContext(over);
  const reader = new Reader(ctx), jobs = new Jobs(ctx), actions = new Actions(ctx, reader, jobs), watch = new Watch(jobs);

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(text);
  };

  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> => new Promise((done, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > 64_000) { fail(new ActionError('The request is too large.', 413)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return done({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
        done(v as Record<string, unknown>);
      } catch { fail(new ActionError('The request body must be a JSON object.')); }
    });
    req.on('error', fail);
  });

  function overview(): Overview {
    const now = Date.now();
    const totals = reader.totals(), runs = reader.runs(now), sessions = reader.sessions(now), models = reader.modelList();
    const allJobs = jobs.list(), running = allJobs.filter((j) => j.state === 'running');
    const live = sessions.filter((s) => s.live);
    const training = running.find((j) => j.kind === 'train' || j.kind === 'resume'), evaluating = running.find((j) => j.kind === 'evaluate');
    const stale = sessions.filter((s) => s.status === 'running' && !s.live);
    let state: Overview['status']['state'] = 'idle', headline = 'Nothing is running.';
    if (training || live.length) {
      state = 'training';
      const name = training?.run ?? live[0].run, run = runs.find((r) => r.name === name);
      headline = run ? `Training ${name}: ${run.timesteps.toLocaleString('en')} of ${run.targetTimesteps.toLocaleString('en')} decisions.` : `Training ${name} is starting.`;
      if (run?.stopRequested) headline += ' A stop was requested: it will save a checkpoint and exit.';
    } else if (evaluating) { state = 'evaluating'; headline = `Running an ${evaluating.title}.`; }
    else if (stale.length) headline = `Nothing is running. Run ${stale[0].run} was left marked as running by a trainer that ended without saying so.`;
    const checkpoints = reader.checkpoints();
    const latestCheckpoint = checkpoints.length ? checkpoints.reduce((a, b) => (a.createdAt > b.createdAt ? a : b)) : null;
    return {
      generatedAt: new Date(now).toISOString(),
      database: { path: ctx.database, exists: reader.exists, schemaVersion: totals.schemaVersion },
      totals: { trainingEpisodes: totals.trainingEpisodes, trainingSteps: totals.trainingSteps, runs: totals.runs, evaluations: totals.evaluations, scriptedEpisodes: totals.scriptedEpisodes, errors: totals.errors },
      status: { state, headline, jobs: allJobs.slice(0, 12), sessions: sessions.filter((s) => s.status === 'running'), memory: { totalMB: Math.round(totalmem() / 1048576), freeMB: Math.round(freemem() / 1048576) }, gameProcessBudget: ctx.gameProcessBudget },
      latestCheckpoint, stable: models.find((m) => m.role === 'stable') ?? null, candidates: models.filter((m) => m.role === 'candidate'),
      latestEvaluation: reader.evaluations()[0] ?? null, focusRun: runs[0]?.name ?? null, builds: totals.builds,
    };
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname.slice('/api'.length), q = url.searchParams;
    const id = (text: string | undefined): number => { const n = Number(text); if (!Number.isInteger(n) || n < 0) throw new ActionError('Not a valid id.'); return n; };
    let m: RegExpExecArray | null;

    if (req.method === 'GET') {
      if (path === '/overview') return json(res, 200, overview());
      if (path === '/meta') return json(res, 200, await actions.meta());
      if (path === '/runs') return json(res, 200, reader.runs());
      if ((m = /^\/runs\/([^/]+)\/curve$/.exec(path))) { const c = reader.curve(decodeURIComponent(m[1])); return c ? json(res, 200, c) : json(res, 404, { message: 'No such run.' }); }
      if (path === '/evaluations') return json(res, 200, reader.evaluations());
      if ((m = /^\/evaluations\/(\d+)$/.exec(path))) { const e = reader.evaluation(id(m[1])); return e ? json(res, 200, e) : json(res, 404, { message: 'No such evaluation.' }); }
      if (path === '/history') return json(res, 200, reader.batches().slice(0, Math.min(500, Number(q.get('limit')) || 200)));
      if (path === '/breakdowns') return json(res, 200, reader.breakdowns(q.get('scope')));
      if (path === '/episodes') return json(res, 200, reader.episodes(id(q.get('batch') ?? '')));
      if ((m = /^\/episodes\/(\d+)$/.exec(path))) { const e = reader.episode(id(m[1])); return e ? json(res, 200, e) : json(res, 404, { message: 'No such episode.' }); }
      if (path === '/models') return json(res, 200, reader.models());
      if (path === '/jobs') return json(res, 200, jobs.list());
      if ((m = /^\/jobs\/(\d+)\/log$/.exec(path))) return json(res, 200, { job: jobs.get(id(m[1])) ?? null, text: jobs.logTail(id(m[1])) });
      if (path === '/watch') return json(res, 200, watch.state());
      if (path === '/watch/stream') return watch.listen(res);
      return json(res, 404, { message: 'No such resource.' });
    }

    if (req.method === 'POST') {
      // Only this page sends the header, and a browser will not let another site add it without asking first.
      if (req.headers['x-pokebonk-dashboard'] !== '1') return json(res, 403, { ok: false, message: 'This request did not come from the dashboard page.' });
      const origin = req.headers.origin;
      if (origin && !LOOPBACK.has(hostOf(origin.replace(/^https?:\/\//, '')))) return json(res, 403, { ok: false, message: 'This request came from another site.' });
      const body = await readBody(req);
      let result: ActionResult;
      if (path === '/actions/train/start') result = await actions.startTraining(body);
      else if (path === '/actions/train/stop') result = await actions.stopTraining(body);
      else if (path === '/actions/train/resume') result = await actions.resumeTraining(body);
      else if (path === '/actions/evaluate') result = await actions.evaluate(body);
      else if (path === '/actions/models/register') result = await actions.register(body);
      else if (path === '/actions/models/promote') result = await actions.promote(body);
      else if (path === '/actions/models/rollback') result = await actions.rollback(body);
      else if (path === '/actions/watch/start') { const w = actions.watchArgs(body); result = { ok: true, message: `Started ${w.title}.`, job: watch.begin(w.args, w.title) }; }
      else if (path === '/actions/watch/stop') { watch.stop(); result = { ok: true, message: 'Stopped watching.' }; }
      else return json(res, 404, { ok: false, message: 'No such action.' });
      return json(res, result.ok ? 200 : 409, result);
    }
    json(res, 405, { message: 'Only GET and POST are answered.' });
  }

  function serveFile(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    const index = join(ctx.dist, 'index.html');
    if (!existsSync(index)) { res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' }).end(NOT_BUILT); return; }
    let file = resolve(ctx.dist, '.' + decodeURIComponent(url.pathname));
    // Anything that is not a built file is the page itself (it routes by the address' hash).
    if (!file.startsWith(ctx.dist + sep) || !existsSync(file) || !statSync(file).isFile()) file = index;
    const hashed = /\/assets\//.test(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file).pipe(res);
  }

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (!LOOPBACK.has(hostOf(req.headers.host))) { json(res, 403, { message: 'The dashboard answers on localhost only.' }); return; }
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname === '/api' || url.pathname.startsWith('/api/')) await api(req, res, url);
        else serveFile(req, res, url);
      } catch (e) {
        if (res.headersSent) { res.end(); return; }
        if (e instanceof ActionError) json(res, e.status, { ok: false, message: e.message });
        else json(res, 500, { ok: false, message: `The dashboard server failed: ${(e as Error).message}` });
      }
    })();
  });

  return {
    server, ctx, reader, jobs, actions, watch,
    listen: () => new Promise<number>((done, fail) => {
      server.once('error', fail);
      // Loopback only: the dashboard is never reachable from another machine.
      server.listen(ctx.port, '127.0.0.1', () => { const a = server.address(); done(typeof a === 'object' && a ? a.port : ctx.port); });
    }),
    close: () => new Promise<void>((done) => { watch.close(); reader.close(); server.closeAllConnections(); server.close(() => done()); }),
  };
}
