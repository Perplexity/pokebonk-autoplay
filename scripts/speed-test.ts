/**
 * Developer probe: measure how fast the run clock advances against the wall clock, optionally after asking the
 * browser for accelerated virtual time.
 *
 *   node scripts/speed-test.ts                 measure only
 *   node scripts/speed-test.ts <factor>        grant virtual time at <factor>× for the measurement window
 */
import { loadConfig, sandboxOrigin } from '../src/config.ts';
import { Cdp } from '../src/cdp/client.ts';
import { Perception } from '../src/bot/perception.ts';

const cfg = loadConfig([]);
const factor = Number(process.argv[2] ?? 0);
const list = (await (await fetch(`http://127.0.0.1:${cfg.browser.debugPort}/json/list`)).json()) as any[];
const page = list.find((t) => t.type === 'page');
if (!page || !String(page.url).startsWith(sandboxOrigin(cfg))) throw new Error('No sandbox page');
const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
try {
  const per = new Perception(cdp);
  const a = await per.snapshot();
  if (!a) throw new Error('No run');
  const t0 = Date.now();
  if (factor > 0) {
    // Grant virtual time in slices: every 100 ms of wall clock, factor × 100 ms of page time.
    const end = Date.now() + 6000;
    while (Date.now() < end) {
      await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: 100 * factor }).catch((e) => console.log('policy error:', e.message));
      await sleep(100);
    }
  } else await sleep(6000);
  const b = await per.snapshot();
  const wall = (Date.now() - t0) / 1000;
  console.log(`state ${a.state} → ${b?.state}; run clock ${a.t} → ${b?.t} in ${wall.toFixed(1)} s of wall clock = ${(((b?.t ?? a.t) - a.t) / wall).toFixed(2)}×`);
} finally { cdp.close(); }
