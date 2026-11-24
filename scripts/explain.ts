/**
 * Explain one decision: replay a recorded snapshot through the policy and print the score of every heading.
 *   node scripts/explain.ts test/fixtures/<name>.json
 */
import { readFileSync } from 'node:fs';
import { decide, newMemory } from '../src/bot/brain/movement.ts';
import { DEFAULT_TUNING } from '../src/bot/brain/tuning.ts';

const { snap } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const r = decide(snap, newMemory(), DEFAULT_TUNING);
console.log(`intent ${r.action.intent} (${r.action.note})  move ${JSON.stringify(r.action.move)}  dash ${r.action.dash} jump ${r.action.jump} ult ${r.action.ult}`);
console.log(`situation: hp ${(r.sit.hpFrac * 100) | 0}% n3 ${r.sit.n3} n8 ${r.sit.n8} pressure ${r.sit.pressure.toFixed(2)} nearest ${r.sit.nearest.toFixed(1)}`);
(r.scores ?? []).forEach((sc, i) => console.log(i === 0 ? `  stand      ${sc.toFixed(2)}` : `  ${String((i - 1) * 22.5).padStart(5)}°  ${sc.toFixed(2)}  rise ${snap.terrain.ring[i - 1]} blocked ${snap.terrain.blocked[i - 1]}`));
for (const e of snap.enemies.list.slice(0, 5)) console.log(`  enemy #${e[0]} at ${(e[1] - snap.player.x).toFixed(1)},${(e[2] - snap.player.z).toFixed(1)} v ${e[3]},${e[4]} flags ${e[10]}`);
