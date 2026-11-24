import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where everything the dashboard reads or starts lives. One value, built once, passed to every part of the server. */
export interface Context {
  repo: string;
  database: string;
  models: string;
  /** Folder for the logs of what the dashboard starts. */
  logs: string;
  /** The dashboard's own state (its list of started jobs). Never a model, never the database. */
  state: string;
  /** The built page (dashboard/dist). */
  dist: string;
  python: string;
  /** Arguments that go before every command's own (a launcher such as `py -3.13` needs them; tests use them too). */
  pythonArgs: string[];
  node: string;
  port: number;
  /** Most game processes one job may ask for: memory is the limit of this machine. */
  gameProcessBudget: number;
  knowledge: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '..', '..');

export function defaultPython(repo: string): string {
  const candidates = [join(repo, '.venv', 'bin', 'python'), join(repo, '.venv', 'Scripts', 'python.exe')];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

export function createContext(over: Partial<Context> = {}): Context {
  const repo = resolve(over.repo ?? REPO);
  return {
    repo,
    database: resolve(over.database ?? join(repo, 'data', 'pokebonk.sqlite')),
    models: resolve(over.models ?? join(repo, 'models')),
    logs: resolve(over.logs ?? join(repo, 'logs', 'dashboard')),
    state: resolve(over.state ?? join(repo, 'data', 'dashboard')),
    dist: resolve(over.dist ?? join(repo, 'dashboard', 'dist')),
    python: over.python ?? defaultPython(repo),
    pythonArgs: over.pythonArgs ?? [],
    node: over.node ?? process.execPath,
    port: over.port ?? 8090,
    gameProcessBudget: over.gameProcessBudget ?? 12,
    knowledge: resolve(over.knowledge ?? join(repo, 'data', 'game-knowledge')),
  };
}
