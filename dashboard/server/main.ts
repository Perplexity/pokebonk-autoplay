/**
 * The training dashboard (docs/dashboard.md).
 *
 *   node dashboard/server/main.ts                     http://127.0.0.1:8090
 *   node dashboard/server/main.ts --port=9000 --db=<file> --models=<folder> --python=<executable> --budget=12
 *
 * It reads data/pokebonk.sqlite and the models folder, and starts the project's own command lines when a button asks
 * for it. It listens on this machine only and contacts nothing.
 */
import { createApp } from './app.ts';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--([\w-]+)(?:=(.*))?$/.exec(a);
  if (!m || !['port', 'db', 'models', 'python', 'budget'].includes(m[1])) { process.stderr.write(`dashboard: unknown argument "${a}" (see the header of dashboard/server/main.ts)\n`); process.exit(2); }
  args.set(m[1], m[2] ?? '');
}
const number = (key: string): number | undefined => {
  if (!args.has(key)) return undefined;
  const n = Number(args.get(key));
  if (!Number.isInteger(n) || n < 0) { process.stderr.write(`dashboard: --${key} needs a whole number\n`); process.exit(2); }
  return n;
};

const app = createApp({ port: number('port'), database: args.get('db'), models: args.get('models'), python: args.get('python'), gameProcessBudget: number('budget') });
try {
  const port = await app.listen();
  process.stdout.write(`training dashboard on http://127.0.0.1:${port}  (database ${app.ctx.database})\n`);
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  process.stderr.write(err.code === 'EADDRINUSE' ? `dashboard: port ${app.ctx.port} is in use; choose another with --port=<number>\n` : `dashboard: ${err.message}\n`);
  process.exit(1);
}
const stop = (): void => { void app.close().then(() => process.exit(0)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
