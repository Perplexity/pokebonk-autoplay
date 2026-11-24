/**
 * Preparation step, run once before going offline: make sure the mirror has the sprite sheet of every species and
 * form the game can spawn. The game derives an enemy's collision radius and height from the opaque pixels of its
 * sheet, so a missing sheet is not cosmetic: that species would get a default size in the offline simulation.
 *
 *   node scripts/mirror-sprites.ts          download what is missing (plain GETs for static files, a few per second)
 *   node scripts/mirror-sprites.ts --check  only report what is missing; contacts nothing
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { Mirror } from '../src/sandbox/mirror.ts';

const cfg = loadConfig([]);
const check = process.argv.includes('--check');
const data = (f: string) => JSON.parse(readFileSync(join(cfg.mirrorDir, 'data', f), 'utf8'));
const sprites = data('sprites.json') as Record<string, { anims?: unknown; fallback?: string }>;
const forms = data('formsprites.json') as { sheets: Record<string, unknown> };

// The playable Pokédex is the first 251; sheets with animations live in pmd/, the rest name their own fallback image.
const want: string[] = [];
for (let id = 1; id <= 251; id++) {
  const s = sprites[String(id)];
  if (!s) continue;
  want.push(s.anims ? `/assets/pmd/${id}.png` : `/assets/${s.fallback ?? `front/${id}.png`}`);
}
for (const id of Object.keys(forms.sheets)) want.push(`/assets/pmd-forms/${id}.png`);
// Shiny Pokémon use their own sheet (sprite ids 20000 + species): without it a shiny would be sized from a failed load.
for (let id = 1; id <= 251; id++) if (sprites[String(id)]?.anims) want.push(`/assets/pmd-shiny/${id}.png`);

const missing = want.filter((p) => !existsSync(join(cfg.mirrorDir, p)));
console.log(`${want.length} sheets needed, ${want.length - missing.length} present, ${missing.length} missing`);
if (check || !missing.length) {
  if (missing.length) console.log(missing.join('\n'));
  process.exit(missing.length && check ? 1 : 0);
}

const mirror = new Mirror({ dir: cfg.mirrorDir, upstream: cfg.upstream, fillMisses: true });
let ok = 0;
const failed: string[] = [];
for (const p of missing) {
  if (await mirror.fetchOne(p)) ok++; else failed.push(p);
  await new Promise((r) => setTimeout(r, 250));
}
console.log(`downloaded ${ok}, not available upstream: ${failed.length}`);
if (failed.length) console.log(failed.join('\n'));
