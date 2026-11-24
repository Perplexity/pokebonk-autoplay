import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface BotConfig {
  /** Policy ticks per second (perception snapshot + decision). */
  tickHz: number;
  /** Pokédex ids to prefer on the select screen, first available wins. */
  species: number[];
  /** Run modes in priority order. The first one the sandbox profile can start is used. */
  modes: string[];
  biome: string;
  tier: number;
  /** Quit ("bank") a run after this many seconds of run time. 0 = play until it ends. */
  bankAfterSec: number;
  /** Stop after this many runs. 0 = keep going. */
  maxRuns: number;
  /** Seconds without any state change before the session manager starts recovery. */
  stuckSec: number;
  /**
   * Game speed. 1 = the game untouched. Above 1 the sandbox raises the game's own time scale so runs take less wall
   * clock: the one setting that writes to the game's state instead of only reading it. See README, "Faster runs".
   */
  speed: number;
  /** Write the frames before every hit to data/hits/ (what the bot saw and chose): the raw material for tuning. */
  traceHits: boolean;
  /** Heuristic weights. See src/bot/brain/tuning.ts for what each one does. */
  tuning: Record<string, number>;
}

export interface Config {
  /** Port of the sandbox host (static mirror + mock API + dashboard). */
  port: number;
  dataDir: string;
  mirrorDir: string;
  /** Where `npm run mirror` copies the public static files from. Never contacted by `npm start`. */
  upstream: string;
  /** API hostname the game's bundle calls. Inside the sandbox browser it is answered by the local mock. */
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
  bot: BotConfig;
  /** Perceive and decide, log the decisions, send no input. */
  dryRun: boolean;
  /** Only run the sandbox host (no browser, no bot). */
  sandboxOnly: boolean;
  /** Sandbox host + sandbox browser, no bot: play by hand. */
  manual: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export const DEFAULTS: Config = {
  port: 8080,
  dataDir: 'data',
  mirrorDir: 'mirror',
  upstream: 'https://pokebonk.com',
  apiHost: 'api.pokebonk.com',
  fillMisses: false,
  browser: { path: '', debugPort: 9333, headless: false, width: 1280, height: 800, mute: true, lang: 'en' },
  bot: {
    tickHz: 10,
    species: [4, 1, 7],
    modes: ['standard', 'mutation', 'bossrush', 'expedition', 'training'],
    biome: 'forest',
    tier: 0,
    bankAfterSec: 0,
    maxRuns: 0,
    stuckSec: 25,
    speed: 1,
    traceHits: false,
    tuning: {},
  },
  dryRun: false,
  sandboxOnly: false,
  manual: false,
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
  if (flag('dry-run')) cfg.dryRun = true;
  if (flag('sandbox-only')) cfg.sandboxOnly = true;
  if (flag('manual')) cfg.manual = true;
  if (flag('headless')) cfg.browser.headless = true;
  if (flag('fill')) cfg.fillMisses = true;
  if (flag('debug')) cfg.logLevel = 'debug';
  if (flag('trace-hits')) cfg.bot.traceHits = true;
  if (arg('port')) cfg.port = Number(arg('port'));
  if (arg('runs')) cfg.bot.maxRuns = Number(arg('runs'));
  if (arg('speed')) cfg.bot.speed = Number(arg('speed'));
  cfg.bot.speed = Math.max(1, Math.min(12, Number(cfg.bot.speed) || 1));
  if (arg('bank')) cfg.bot.bankAfterSec = Number(arg('bank'));
  if (arg('species')) cfg.bot.species = arg('species')!.split(',').map(Number);
  if (arg('mode')) cfg.bot.modes = arg('mode')!.split(',');
  cfg.dataDir = resolve(ROOT, cfg.dataDir);
  cfg.mirrorDir = resolve(ROOT, cfg.mirrorDir);
  return cfg;
}

export const sandboxOrigin = (cfg: Config) => `http://localhost:${cfg.port}`;
