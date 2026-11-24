/**
 * Read the hit traces the bot writes with --trace-hits (data/hits/*.json) and print, frame by frame, what led to each
 * hit: where the player was heading and what the enemy that landed it was doing.
 *
 *   node scripts/hit-trace.ts [max files] [filter substring]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import type { Action } from '../src/bot/brain/movement.ts';
import type { Snapshot } from '../src/bot/snapshot.ts';

const cfg = loadConfig([]);
const dir = join(cfg.dataDir, 'hits');
const max = Number(process.argv[2] ?? 6), filter = process.argv[3] ?? '';
const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f.includes(filter)).sort().slice(0, max);
for (const f of files) {
  const { lost, frames } = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { lost: number; frames: { snap: Snapshot; action: Action }[] };
  const last = frames[frames.length - 1].snap;
  // The culprit: whoever is closest when the hit registers.
  const culprit = last.enemies.list[0]?.[0];
  console.log(`\n== ${f}: -${Math.round(lost)} hp, culprit #${culprit}`);
  for (const { snap: s, action: a } of frames) {
    const e = s.enemies.list.find((x) => x[0] === culprit);
    const p = s.player;
    const mv = a.move ? `${a.move.x.toFixed(2)},${a.move.z.toFixed(2)}` : 'stand';
    let es = 'culprit not listed';
    if (e) {
      const dx = p.x - e[1], dz = p.z - e[2], d = Math.hypot(dx, dz), v = Math.hypot(e[3], e[4]);
      const closing = v > 0.1 ? (e[3] * dx + e[4] * dz) / (v * (d || 1)) : 0;
      const along = a.move ? (a.move.x * dx + a.move.z * dz) / (d || 1) : 0;
      es = `d=${(d - e[7]).toFixed(1)} v=${v.toFixed(1)}/${e[9]} atk=${e[12] ?? '?'} fl=${e[10]} closing=${closing.toFixed(2)} moveAlongLane=${along.toFixed(2)}`;
    }
    console.log(`  t=${s.t.toFixed(2)} hp=${Math.round(p.hp)} sp=${p.speed} ${a.intent.padEnd(6)} move=${mv.padEnd(11)}${a.dash ? ' DASH' : ''}${a.jump ? ' JUMP' : ''} if=${p.iframes} | ${es} | near=${s.enemies.list.filter((x) => Math.hypot(x[1] - p.x, x[2] - p.z) < 6).length}`);
  }
}
