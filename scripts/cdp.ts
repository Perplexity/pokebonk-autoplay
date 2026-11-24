/**
 * Developer probe for a running sandbox browser (start one with `npm run browser`).
 *
 *   node scripts/cdp.ts eval "<expression>"        evaluate in the page, print JSON
 *   node scripts/cdp.ts file <script.js>           evaluate a file (an expression or an IIFE)
 *   node scripts/cdp.ts shot <out.png>             screenshot
 *   node scripts/cdp.ts key <code> [ms]            press a key (KeyW, Escape, Space...)
 *   node scripts/cdp.ts click <x> <y>              click at viewport coordinates
 *
 * It refuses to touch a page that is not on the sandbox origin.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadConfig, sandboxOrigin } from '../src/config.ts';
import { Cdp } from '../src/cdp/client.ts';
import { Executor } from '../src/bot/executor.ts';

const [cmd, ...rest] = process.argv.slice(2);
const cfg = loadConfig([]);
const list = (await (await fetch(`http://127.0.0.1:${cfg.browser.debugPort}/json/list`)).json()) as any[];
const page = list.find((t) => t.type === 'page');
if (!page) throw new Error('No page target');
if (!String(page.url).startsWith(sandboxOrigin(cfg)) && page.url !== 'about:blank') throw new Error(`Not the sandbox: ${page.url}`);
const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
try {
  if (cmd === 'eval' || cmd === 'file') {
    const expr = cmd === 'eval' ? rest.join(' ') : readFileSync(rest[0], 'utf8');
    const out = await cdp.eval(expr, { awaitPromise: true, timeoutMs: 60_000 });
    console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
  } else if (cmd === 'shot') {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, 30_000);
    writeFileSync(rest[0], Buffer.from(data, 'base64'));
    console.log('saved', rest[0]);
  } else if (cmd === 'key') {
    const ex = new Executor(cdp, false);
    await ex.tap(rest[0], Number(rest[1] ?? 60));
  } else if (cmd === 'click') {
    const ex = new Executor(cdp, false);
    await ex.click(Number(rest[0]), Number(rest[1]));
  } else if (cmd === 'clicktext') {
    const want = rest.join(' ').toLowerCase();
    const hit = await cdp.eval<{ x: number; y: number; t: string } | null>(`(() => {
      const want = ${JSON.stringify(want)};
      const els = [...document.querySelectorAll('button, .btn, [role=button], .sp-card, .card, .tab, a')].filter((e) => {
        const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && (e.innerText || '').toLowerCase().includes(want);
      }).sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
      const e = els[0]; if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), t: e.innerText.trim().slice(0, 60) };
    })()`);
    if (!hit) console.log('no element with text', want);
    else { await new Executor(cdp, false).click(hit.x, hit.y); console.log('clicked', JSON.stringify(hit)); }
  } else {
    console.log('usage: eval|file|shot|key|click|clicktext');
  }
} finally {
  cdp.close();
}
