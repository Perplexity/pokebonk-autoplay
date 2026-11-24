/**
 * Game-knowledge export (docs/game-knowledge.md).
 *
 *   node scripts/export-knowledge.ts            boot the headless game, read its tables, write data/game-knowledge/<build>/
 *   node scripts/export-knowledge.ts --check    do the same in memory and compare with the files on disk (exit 2 if any differs)
 *   node scripts/export-knowledge.ts --only=155,25 --out=<dir>   a partial export for quick checks (never into data/)
 *
 * The export starts one run per League member through the environment's own reset (about 1.5 s each, a few minutes in
 * all), because the per-species values are read from the game's own player object. It plays nothing: no step is taken.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEnvironment } from '../src/environment/index.ts';
import { buildKnowledge, serialize, writeKnowledge } from '../src/knowledge/export.ts';
import { real } from '../src/sim/clock.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map<string, string>();
for (const a of process.argv.slice(2)) { const m = /^--([\w-]+)(?:=(.*))?$/.exec(a); if (m) args.set(m[1], m[2] ?? 'true'); }
const say = (s = '') => process.stdout.write(s + '\n');

try {
  const t0 = real.performanceNow();
  const only = args.has('only') ? args.get('only')!.split(',').map(Number) : undefined;
  const env = createEnvironment({});
  const k = await buildKnowledge(env, { only, log: args.has('verbose') ? say : undefined });
  const build = k.vocab.header.build;
  const blocked = env.getMetadata().offline.blocked;
  await env.close();
  if (blocked.length) throw new Error(`network attempts were blocked during the export: ${blocked.join(', ')}`);
  const dir = args.get('out') ? resolve(args.get('out')!) : join(REPO, 'data', 'game-knowledge', build);
  if (only && !args.get('out')) throw new Error('--only makes a partial export: give --out=<dir> (it is never written to data/game-knowledge)');

  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const names = ['species', 'moves', 'items', 'vocab'] as const;
  say(`game build ${build} (${k.vocab.header.gameVersion}), language ${k.vocab.header.language}, profile ${k.vocab.header.profile}, bundle ${k.vocab.header.bundleSha256.slice(0, 16)}…`);
  say(`species: ${k.species.species.length} League members`);
  say(`moves: ${k.moves.moves.length} moves, ${k.moves.fusions.length} fusions, ${Object.keys(k.moves.archetypes).length} archetypes`);
  const it = k.items as unknown as Record<string, unknown[]>;
  say(`items: ${it.vitamins.length} vitamins, ${it.heldItems.length} held items, ${it.relics.length} relics, ${it.runBoosts.length} run boosts, ${it.seals.length} seals, ${it.overtimeOfferings.length} overtime offerings, ${it.typeBlessings.length} type blessings, ${it.powerups.length} power-ups, ${it.lab.length} Lab upgrades, ${it.stats.length} stats`);
  say(`vocab: ${Object.entries(k.vocab.tables).map(([name, t]) => `${name} ${Object.keys(t).length}`).join(', ')}`);

  if (args.has('check')) {
    let same = true;
    for (const name of names) {
      const path = join(dir, `${name}.json`);
      const now = serialize(k[name]);
      const disk = existsSync(path) ? readFileSync(path, 'utf8') : null;
      const ok = disk === now;
      same &&= ok;
      say(`  ${name}.json  ${ok ? 'identical' : disk === null ? 'MISSING on disk' : 'DIFFERENT'}  sha256 ${sha(now).slice(0, 16)}…  ${Buffer.byteLength(now)} bytes`);
    }
    say(same ? 'check: byte-identical to the files on disk' : 'check: NOT identical');
    if (!same) process.exitCode = 2;
  } else {
    const written = writeKnowledge(dir, k);
    for (const name of names) say(`  wrote ${written[name].path}  ${written[name].bytes} bytes  sha256 ${sha(serialize(k[name])).slice(0, 16)}…`);
  }
  for (const name of names) for (const g of k[name].header.gaps) if (args.has('verbose')) say(`  gap (${name}): ${g}`);
  say(`done in ${((real.performanceNow() - t0) / 1000).toFixed(1)} s`);
} catch (e) {
  process.stderr.write(`export-knowledge failed: ${(e as Error)?.stack ?? e}\n`);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
