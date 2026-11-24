/**
 * Print (or record) one state snapshot from a running sandbox browser.
 *
 *   node scripts/snap.ts                     summary on the console
 *   node scripts/snap.ts --full              the whole snapshot as JSON
 *   node scripts/snap.ts --ui                the DOM side only
 *   node scripts/snap.ts --save <name>       write test/fixtures/<name>.json  ({ snap, ui })
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, ROOT, sandboxOrigin } from '../src/config.ts';
import { Cdp } from '../src/cdp/client.ts';
import { Perception } from '../src/bot/perception.ts';

const cfg = loadConfig([]);
const list = (await (await fetch(`http://127.0.0.1:${cfg.browser.debugPort}/json/list`)).json()) as any[];
const page = list.find((t) => t.type === 'page');
if (!page || !String(page.url).startsWith(sandboxOrigin(cfg))) throw new Error('No sandbox page');
const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
const args = process.argv.slice(2);
try {
  const per = new Perception(cdp);
  const ui = await per.ui();
  const snap = args.includes('--ui') ? null : await per.snapshot();
  const save = args.indexOf('--save');
  if (save >= 0) {
    const dir = join(ROOT, 'test', 'fixtures');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, args[save + 1] + '.json'), JSON.stringify({ snap, ui }));
    console.log('saved', args[save + 1]);
  } else if (args.includes('--ui')) console.log(JSON.stringify(ui, null, 1));
  else if (args.includes('--full')) console.log(JSON.stringify(snap));
  else if (!snap) console.log('no run; screen =', ui.screen, ui.modal ? 'modal ' + ui.modal.kind : '');
  else {
    const { enemies, points, terrain, player, ...rest } = snap;
    console.log(JSON.stringify({ ...rest, player: { ...player, stats: '…' }, enemies: { count: enemies.count, listed: enemies.list.length, nearest: enemies.list.slice(0, 3) }, points: points.map((p) => `${p.kind}${p.sub ? ':' + p.sub : ''}@${Math.round(p.d)}m${p.used ? ' used' : ''}`).join(' '), terrain }, null, 1));
    console.log(`snapshot ${per.lastMs.toFixed(1)} ms, ${JSON.stringify(snap).length} bytes; ui: ${ui.screen}${ui.modal ? ' modal=' + ui.modal.kind + ' [' + ui.modal.cls + '] opts=' + ui.modal.options.length + ' actions=' + ui.modal.actions.map((a) => a.text).join('|') : ''}`);
  }
} finally { cdp.close(); }
