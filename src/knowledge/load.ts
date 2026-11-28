import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Where the knowledge export of a game build is kept: `data/game-knowledge/<build>/` (written by scripts/export-knowledge.ts). */
export const knowledgeDir = (build: string): string => join(REPO, 'data', 'game-knowledge', build);
