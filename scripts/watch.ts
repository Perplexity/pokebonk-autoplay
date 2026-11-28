/**
 * Watch one run of the player as it happens, on a local page: a top-down map, the run's state, what the player
 * intends and why, every dialog it answers, and its build. For looking at behaviour; nothing is stored.
 *
 *   node scripts/watch.ts --seed=1                  then open http://127.0.0.1:8090
 *   node scripts/watch.ts --seed=28 --speed=4 --plan='{"leaveHp":0.5}'
 *
 * Options: --seed  --species=150  --map=forest  --tier=2  --max-time=<game s, default 7200>
 *          --speed=1      game seconds per second (the page changes it and pauses)
 *          --plan=<json>  keys of the plan to replace (src/player/plan.ts)
 *          --archive, --build-plan   the account (default: the plan's own; `none` plays without)
 *          --port=8090
 *
 * The game runs in a process of its own, which may not open a socket: it reports over the process pipe, and this
 * process serves the page to this machine only (127.0.0.1). The page loads nothing from anywhere else.
 */
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) { const m = /^--([\w-]+)(?:=(.*))?$/.exec(a); if (m) args.set(m[1], m[2] ?? 'true'); }
const num = (k: string, d: number): number => (args.has(k) ? Number(args.get(k)) : d);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = num('port', 8090);
const options = {
  seed: num('seed', 1), species: num('species', 150), map: args.get('map') ?? 'forest', tier: num('tier', 2), maxTime: num('max-time', 7200), speed: num('speed', 1),
  ...(args.has('plan') ? { plan: JSON.parse(args.get('plan')!) as Record<string, unknown> } : {}),
  ...(args.has('archive') ? { archive: args.get('archive') } : {}), ...(args.has('build-plan') ? { buildPlan: args.get('build-plan') } : {}),
};

// What a page that connects late is told first: the run, the build, the last frame, and the log so far.
const EVENTS_KEPT = 500;
const seen: { meta: unknown; build: unknown; frame: unknown; end: unknown; events: unknown[]; speed: number; paused: boolean; error: string | null } = { meta: null, build: null, frame: null, end: null, events: [], speed: options.speed, paused: false, error: null };
const pages = new Set<ServerResponse>();
const push = (type: string, data: unknown): void => { const line = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; for (const p of pages) p.write(line); };

const game = fork(join(root, 'src/watch/game.ts'), [JSON.stringify(options)], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
let output = '';
const keep = (chunk: Buffer): void => { output = (output + chunk.toString('utf8')).slice(-4000); };
game.stdout?.on('data', keep);
game.stderr?.on('data', keep);
game.on('message', (m: { type: string; meta?: unknown; frame?: unknown; build?: unknown; event?: unknown; summary?: unknown }) => {
  if (m.type === 'ready') { seen.meta = m.meta; push('meta', m.meta); process.stdout.write(`the run has started: seed ${options.seed}\n`); }
  else if (m.type === 'frame') { seen.frame = m.frame; push('frame', m.frame); }
  else if (m.type === 'build') { seen.build = m.build; push('build', m.build); }
  else if (m.type === 'event') { seen.events.push(m.event); if (seen.events.length > EVENTS_KEPT) seen.events.shift(); push('log', m.event); }
  else if (m.type === 'end') { seen.end = m.summary; push('end', m.summary); process.stdout.write(`the run is over: ${JSON.stringify(m.summary)}\nThe page stays up; Ctrl+C to stop.\n`); }
});
game.on('exit', (code) => {
  if (seen.end || code === 0) return;
  seen.error = `the game process stopped (exit ${code}): ${output.trim().split('\n').slice(-6).join(' | ') || 'no output'}`;
  push('fault', seen.error);
  process.stderr.write(seen.error + '\n');
});

const page = readFileSync(join(root, 'src/watch/page.html'), 'utf8');
const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  if (req.method === 'GET' && url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(page); return; }
  if (req.method === 'GET' && url === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    const first = (type: string, data: unknown): void => { if (data !== null) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
    first('meta', seen.meta); first('control', { speed: seen.speed, paused: seen.paused }); first('build', seen.build); first('frame', seen.frame);
    for (const e of seen.events) first('log', e);
    first('end', seen.end); first('fault', seen.error);
    pages.add(res);
    req.on('close', () => pages.delete(res));
    return;
  }
  if (req.method === 'POST' && url === '/control') {
    let body = '';
    req.on('data', (c: Buffer) => { body = (body + c.toString('utf8')).slice(0, 200); });
    req.on('end', () => {
      try {
        const m = JSON.parse(body) as { speed?: number; paused?: boolean };
        if (typeof m.speed === 'number' && m.speed > 0 && m.speed <= 64) { seen.speed = m.speed; if (game.connected) game.send({ type: 'speed', value: m.speed }); }
        if (typeof m.paused === 'boolean') { seen.paused = m.paused; if (game.connected) game.send({ type: 'pause', on: m.paused }); }
        push('control', { speed: seen.speed, paused: seen.paused });
        res.writeHead(204).end();
      } catch { res.writeHead(400).end(); }
    });
    return;
  }
  res.writeHead(404).end();
});
server.on('error', (e: NodeJS.ErrnoException) => {
  process.stderr.write(e.code === 'EADDRINUSE' ? `port ${port} is in use: stop the other watch, or pass --port=<another>\n` : `${e.message}\n`);
  game.kill();
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => process.stdout.write(`watch: http://127.0.0.1:${port}  (the game is loading; about ten seconds)\n`));
const stop = (): void => { game.kill(); server.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
