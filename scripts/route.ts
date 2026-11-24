/**
 * Developer probe: plan a route from the player to a map point in the running sandbox and print it with the local
 * walkability, to check the terrain reading against what is on screen.
 *
 *   node scripts/route.ts            route to the zone guardian's altar
 *   node scripts/route.ts <x> <z>    route to a point
 */
import { loadConfig, sandboxOrigin } from '../src/config.ts';
import { Cdp } from '../src/cdp/client.ts';
import { Perception } from '../src/bot/perception.ts';

const cfg = loadConfig([]);
const list = (await (await fetch(`http://127.0.0.1:${cfg.browser.debugPort}/json/list`)).json()) as any[];
const page = list.find((t) => t.type === 'page');
if (!page || !String(page.url).startsWith(sandboxOrigin(cfg))) throw new Error('No sandbox page');
const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
try {
  const per = new Perception(cdp);
  const first = await per.snapshot();
  if (!first) throw new Error('No run');
  const altar = first.points.find((p) => p.kind === 'boss');
  const target = process.argv[2] ? { x: Number(process.argv[2]), z: Number(process.argv[3]) } : altar ? { x: altar.x, z: altar.z } : null;
  if (!target) throw new Error('No target');
  const t0 = performance.now();
  const s = await per.snapshot(target);
  const ms = performance.now() - t0;
  if (!s) throw new Error('No snapshot');
  const p = s.player;
  console.log(`player ${p.x},${p.z} (y ${p.y})  target ${target.x},${target.z}  straight ${Math.hypot(target.x - p.x, target.z - p.z).toFixed(0)} m`);
  console.log(`route: ${JSON.stringify(s.nav)}  (${ms.toFixed(0)} ms with the plan, ${per.lastMs.toFixed(0)} ms measured)`);
  console.log('dir    free  hop   rise@2.5');
  s.terrain.free?.forEach((f, k) => console.log(`${String(k * 22.5).padStart(5)}° ${String(f).padStart(4)} ${String(s.terrain.hop![k]).padStart(4)}  ${s.terrain.ring[k]}`));
} finally { cdp.close(); }
