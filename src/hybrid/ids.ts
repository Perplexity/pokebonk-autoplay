import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EncoderKnowledge } from '../knowledge/load.ts';
import type { VocabTable } from '../knowledge/vocab.ts';

/**
 * Append-only ids for the manager's observation.
 *
 * The vocabulary of a game build (data/game-knowledge/<build>/vocab.json) numbers its keys in sorted order, so one new
 * item in a patch renumbers every item after it and widens every vector that has one entry per item: a model trained
 * before the patch reads nonsense after it. The registry (data/encoding/manager-ids.json, ONE file for all builds)
 * fixes both: a key keeps the index it was first given, new keys are appended, and every table has a CAPACITY larger
 * than its content, which is what sizes the observation. A patch that adds keys within the capacity changes no index
 * and no shape; one that outgrows a capacity is refused here and needs a new observation version.
 */
export const ID_REGISTRY_VERSION = 1;
export const RESERVED = '~reserved:';
/** Name under which the move-upgrade stats (not a vocabulary table) are kept in the registry. */
export const UPGRADE_STATS = '~upgradeStat';

/** The tables of a build as the registry takes them: the vocabulary's, and the move-upgrade stats. */
export const registryTables = (k: EncoderKnowledge): Record<string, VocabTable> => ({ ...k.tables, [UPGRADE_STATS]: Object.fromEntries(k.upgradeStats.map((key, i) => [key, i + 1])) });

export interface IdRegistry {
  version: number;
  /** Builds whose vocabulary has been merged in, oldest first. */
  builds: string[];
  tables: Record<string, { capacity: number; keys: string[] }>;
}

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REGISTRY_PATH = join(REPO, 'data', 'encoding', 'manager-ids.json');

/** Room for a quarter more keys, at least 8, rounded up to a multiple of 8. */
export const capacityFor = (n: number): number => Math.ceil((n + Math.max(8, Math.ceil(n / 4))) / 8) * 8;

/**
 * The registry with a build's vocabulary merged in: known keys keep their place, new ones are appended in the
 * vocabulary's own order. A key that left the game keeps its index (it is simply never met again).
 */
export function extendRegistry(reg: IdRegistry | null, build: string, tables: Record<string, VocabTable>): IdRegistry {
  const out: IdRegistry = reg ? { version: reg.version, builds: [...reg.builds], tables: Object.fromEntries(Object.entries(reg.tables).map(([n, t]) => [n, { capacity: t.capacity, keys: [...t.keys] }])) } : { version: ID_REGISTRY_VERSION, builds: [], tables: {} };
  if (out.version !== ID_REGISTRY_VERSION) throw new Error(`[ids] the registry is version ${out.version}, this code is version ${ID_REGISTRY_VERSION}`);
  for (const [name, table] of Object.entries(tables)) {
    const keys = Object.keys(table).sort((a, b) => table[a] - table[b]);
    const t = (out.tables[name] ??= { capacity: capacityFor(keys.length), keys: [] });
    const known = new Set(t.keys);
    for (const k of keys) if (!known.has(k)) t.keys.push(k);
    if (t.keys.length > t.capacity) throw new Error(`[ids] table "${name}" has ${t.keys.length} keys with build ${build}, over its capacity of ${t.capacity}: the manager's observation needs a new version`);
  }
  if (!out.builds.includes(build)) out.builds.push(build);
  return out;
}

export function loadRegistry(path = REGISTRY_PATH): IdRegistry {
  if (!existsSync(path)) throw new Error(`[ids] ${path} does not exist. Run "node scripts/export-encoding.ts" first.`);
  return JSON.parse(readFileSync(path, 'utf8')) as IdRegistry;
}

/**
 * The knowledge of a build with the registry's numbering: every table is the registry's (index = place + 1), padded
 * with reserved names up to its capacity, so that everything sized or numbered by a table is sized and numbered by the
 * registry. Throws when the build has a key the registry does not: the registry must be extended first.
 */
export function registryKnowledge(k: EncoderKnowledge, reg: IdRegistry): EncoderKnowledge {
  const tables: Record<string, VocabTable> = {}, ordered = new Map<string, string[]>();
  for (const [name, table] of Object.entries(k.tables)) {
    const t = reg.tables[name];
    if (!t) throw new Error(`[ids] the registry has no table "${name}" (build ${k.build}): run "node scripts/export-encoding.ts"`);
    const index: VocabTable = {};
    t.keys.forEach((key, i) => { index[key] = i + 1; });
    for (const key of Object.keys(table)) if (!index[key]) throw new Error(`[ids] "${name}:${key}" of build ${k.build} is not in the registry: run "node scripts/export-encoding.ts"`);
    const names = [...t.keys];
    for (let i = names.length; i < t.capacity; i++) { names.push(`${RESERVED}${i + 1}`); index[`${RESERVED}${i + 1}`] = i + 1; }
    tables[name] = index;
    ordered.set(name, names);
  }
  // Not a vocabulary table, but sized the same way: the stats a move upgrade can improve (one column each).
  const ups = reg.tables[UPGRADE_STATS];
  if (!ups) throw new Error(`[ids] the registry has no table "${UPGRADE_STATS}": run "node scripts/export-encoding.ts"`);
  for (const key of k.upgradeStats) if (!ups.keys.includes(key)) throw new Error(`[ids] upgrade stat "${key}" of build ${k.build} is not in the registry: run "node scripts/export-encoding.ts"`);
  const upgradeStats = [...ups.keys];
  for (let i = upgradeStats.length; i < ups.capacity; i++) upgradeStats.push(`${RESERVED}${i + 1}`);
  return {
    ...k, tables, upgradeStats,
    vocabSha256: createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(reg.tables).map(([n, t]) => [n, t.capacity])))).digest('hex'),
    keys: (table: string): string[] => { const v = ordered.get(table); if (!v) throw new Error(`[ids] no table "${table}"`); return v; },
  };
}

/** True when `older` is what `newer` was before keys were appended: same capacities, every list a prefix. */
export function isExtensionOf(newer: IdRegistry, older: IdRegistry): boolean {
  for (const [name, t] of Object.entries(older.tables)) {
    const n = newer.tables[name];
    if (!n || n.capacity !== t.capacity || t.keys.some((key, i) => n.keys[i] !== key)) return false;
  }
  return true;
}
