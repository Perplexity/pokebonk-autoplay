import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface Config {
  dataDir: string;
  mirrorDir: string;
  /** Where `npm run mirror` copies the public static files from. Nothing else contacts it. */
  upstream: string;
  /** API hostname the game's bundle calls. It is answered by the local stand-in (src/sandbox/mockApi.ts), never by the service. */
  apiHost: string;
  /** When true the mirror fetches a missing static file from `upstream` once and caches it (opt-in warm-up). */
  fillMisses: boolean;
  browser: {
    /** Chrome/Edge executable. Auto-detected when empty. */
    path: string;
    debugPort: number;
    headless: boolean;
    width: number;
    height: number;
    mute: boolean;
    lang: string;
  };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export const DEFAULTS: Config = {
  dataDir: 'data',
  mirrorDir: 'mirror',
  upstream: 'https://pokebonk.com',
  apiHost: 'api.pokebonk.com',
  fillMisses: false,
  browser: { path: '', debugPort: 9333, headless: false, width: 1280, height: 800, mute: true, lang: 'en' },
  logLevel: 'info',
};

function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return (over === undefined ? base : (over as T));
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)?.[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) ? merge(b, v) : v;
  }
  return out as T;
}

/** Defaults ← config.json (optional, repo root) ← command-line flags. */
export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  let cfg = structuredClone(DEFAULTS);
  const file = join(ROOT, 'config.json');
  if (existsSync(file)) cfg = merge(cfg, JSON.parse(readFileSync(file, 'utf8')));
  const flag = (n: string) => argv.includes(`--${n}`);
  const arg = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  if (flag('headless')) cfg.browser.headless = true;
  if (flag('fill')) cfg.fillMisses = true;
  if (flag('debug')) cfg.logLevel = 'debug';
  cfg.dataDir = resolve(ROOT, cfg.dataDir);
  cfg.mirrorDir = resolve(ROOT, cfg.mirrorDir);
  return cfg;
}
