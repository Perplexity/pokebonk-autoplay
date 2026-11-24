import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

let minLevel: Level = 'info';
let file: string | null = null;

export function initLogger(level: Level, dataDir?: string) {
  minLevel = level;
  if (dataDir) {
    mkdirSync(join(dataDir, 'logs'), { recursive: true });
    file = join(dataDir, 'logs', `bot-${new Date().toISOString().slice(0, 10)}.log`);
  }
}

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
  const line = `${new Date().toISOString().slice(11, 23)} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}` +
    (extra === undefined ? '' : ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)));
  if (file) { try { appendFileSync(file, line + '\n'); } catch { /* logging never breaks the run */ } }
  if (LEVELS[level] >= LEVELS[minLevel]) (level === 'error' ? console.error : console.log)(line);
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export const logger = (scope: string): Logger => ({
  debug: (m, e) => emit('debug', scope, m, e),
  info: (m, e) => emit('info', scope, m, e),
  warn: (m, e) => emit('warn', scope, m, e),
  error: (m, e) => emit('error', scope, m, e),
});
