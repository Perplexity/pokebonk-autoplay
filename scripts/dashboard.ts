/**
 * The batch page: every stored batch with its state and its ranked KOs, the runs inside one, and one batch against
 * another, on a local page that refreshes while a batch is being played.
 *
 *   node scripts/dashboard.ts                     then open http://127.0.0.1:8090
 *   node scripts/dashboard.ts --port=9000 --db=data/other.sqlite
 *
 * It opens the database read-only, serves this machine only (127.0.0.1) and the page loads nothing from anywhere
 * else.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DATABASE } from '../src/storage/database.ts';
import { batchDetail, batchList, compareBatches } from '../src/dashboard/data.ts';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) { const m = /^--([\w-]+)(?:=(.*))?$/.exec(a); if (m) args.set(m[1], m[2] ?? 'true'); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = args.has('port') ? Number(args.get('port')) : 8090;
const database = args.has('db') ? resolve(args.get('db')!) : DEFAULT_DATABASE;
if (!existsSync(database)) { process.stderr.write(`dashboard: no database at ${database} (a batch creates it: scripts/run-episodes.ts)\n`); process.exit(2); }

const db = new DatabaseSync(database, { readOnly: true });
db.exec('PRAGMA busy_timeout = 5000;');
const page = readFileSync(join(root, 'src/dashboard/page.html'), 'utf8');

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const json = (status: number, body: unknown): void => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const id = (key: string): number => Number(url.searchParams.get(key));
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  try {
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(page); return; }
    if (url.pathname === '/api/batches') { json(200, { now: new Date().toISOString(), database, batches: batchList(db) }); return; }
    if (url.pathname === '/api/batch') { const d = Number.isInteger(id('id')) ? batchDetail(db, id('id')) : null; json(d ? 200 : 404, d ? { now: new Date().toISOString(), batch: d } : { error: `no batch ${url.searchParams.get('id')}` }); return; }
    if (url.pathname === '/api/compare') { const c = Number.isInteger(id('a')) && Number.isInteger(id('b')) ? compareBatches(db, id('a'), id('b')) : null; json(c ? 200 : 404, c ?? { error: 'no such pair of batches' }); return; }
    res.writeHead(404).end();
  } catch (e) { json(500, { error: (e as Error).message }); }
});
server.on('error', (e: NodeJS.ErrnoException) => {
  process.stderr.write(e.code === 'EADDRINUSE' ? `port ${port} is in use: stop what holds it, or pass --port=<another>\n` : `${e.message}\n`);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => { const a = server.address(); process.stdout.write(`batches: http://127.0.0.1:${typeof a === 'object' && a ? a.port : port}  (database ${database}; Ctrl+C to stop)\n`); });
const stop = (): void => { server.close(); db.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
