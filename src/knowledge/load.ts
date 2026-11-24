import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KnowledgeHeader } from './export.ts';
import type { VocabTable } from './vocab.ts';

/**
 * The exported game knowledge as the observation encoder needs it: the vocabulary tables plus the few joins the
 * encoder does (types of a species, role of a League member, key of a move id, kind of a stat).
 * Read from `data/game-knowledge/<build>/` (written by scripts/export-knowledge.ts); nothing is read from the game here.
 */
export interface EncoderKnowledge {
  build: string;
  gameVersion: string | null;
  vocabVersion: number;
  /**
   * sha256 of the vocabulary TABLES (`JSON.stringify(tables)`): part of the observation layout's identity. The file's
   * header is not in it, so a re-export that changes only a header field (the account preset, a gap note) leaves the
   * layout hash alone; any change to a key or an index changes it.
   */
  vocabSha256: string;
  tables: Record<string, VocabTable>;
  /** Species number → its types (every species of the Pokédex). */
  typesOf: Map<number, string[]>;
  /** League member → role and rank. */
  memberOf: Map<number, { role: string; rank: string }>;
  /** Generic move id (and fusion id) → move key. */
  moveKeyById: Map<number, string>;
  /** Stat key → how the game counts it: flat | mult | pctpts. */
  statKind: Map<string, string>;
  /** Every stat a move upgrade can improve (the union of the archetypes' upgrade stats), sorted. */
  upgradeStats: string[];
  /** Keys of a table in index order (index 1 first). */
  keys(table: string): string[];
}

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const knowledgeDir = (build: string): string => join(REPO, 'data', 'game-knowledge', build);

export function loadKnowledge(build: string, dir = knowledgeDir(build)): EncoderKnowledge {
  const read = <T>(name: string): { text: string; json: T } => {
    const path = join(dir, `${name}.json`);
    if (!existsSync(path)) throw new Error(`[knowledge] ${path} does not exist. Run "node scripts/export-knowledge.ts" for game build ${build} first.`);
    const text = readFileSync(path, 'utf8');
    return { text, json: JSON.parse(text) as T };
  };
  const vocab = read<{ header: KnowledgeHeader; tables: Record<string, VocabTable> }>('vocab');
  const species = read<{ header: KnowledgeHeader; species: { id: number; role: string; rank: string }[]; pokedex: { id: number; types: string[] }[] }>('species');
  const moves = read<{ header: KnowledgeHeader; archetypes: Record<string, { upgradeStats: string[] }>; moves: { key: string; id: number }[]; fusions: { key: string; id: number | null }[] }>('moves');
  const items = read<{ header: KnowledgeHeader; stats: { key: string; kind: string }[] }>('items');
  for (const d of [vocab.json, species.json, moves.json, items.json]) {
    if (d.header.build !== build) throw new Error(`[knowledge] ${d.header.dataset}.json in ${dir} is for game build ${d.header.build}, the running game is ${build}`);
    if (d.header.bundleSha256 !== vocab.json.header.bundleSha256) throw new Error(`[knowledge] the datasets in ${dir} come from different exports (bundle hashes differ)`);
  }
  const tables = vocab.json.tables;
  const ordered = new Map<string, string[]>();
  return {
    build, gameVersion: vocab.json.header.gameVersion, vocabVersion: vocab.json.header.version,
    vocabSha256: createHash('sha256').update(JSON.stringify(tables)).digest('hex'),
    tables,
    typesOf: new Map(species.json.pokedex.map((s) => [s.id, s.types])),
    memberOf: new Map(species.json.species.map((s) => [s.id, { role: s.role, rank: s.rank }])),
    moveKeyById: new Map([...moves.json.moves.map((m) => [m.id, m.key] as [number, string]), ...moves.json.fusions.filter((f) => f.id !== null).map((f) => [f.id as number, f.key] as [number, string])]),
    statKind: new Map(items.json.stats.map((s) => [s.key, s.kind])),
    upgradeStats: [...new Set(Object.values(moves.json.archetypes).flatMap((a) => a.upgradeStats))].sort(),
    keys(table: string): string[] {
      let k = ordered.get(table);
      if (!k) {
        const t = tables[table];
        if (!t) throw new Error(`[knowledge] the vocabulary has no table "${table}"`);
        k = Object.keys(t).sort((a, b) => t[a] - t[b]);
        ordered.set(table, k);
      }
      return k;
    },
  };
}
