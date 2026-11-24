/**
 * Developer probe: wait until a selector shows up in the sandbox page, then print the element's HTML (svg and inline
 * styles removed). Used to learn the structure of a dialog while the bot is playing.
 *
 *   node scripts/wait-dom.ts ".card.offer" [timeoutSec] [maxChars]
 */
import { loadConfig, sandboxOrigin } from '../src/config.ts';
import { Cdp } from '../src/cdp/client.ts';

const cfg = loadConfig([]);
const [sel, timeout = '90', max = '3000'] = process.argv.slice(2);
const list = (await (await fetch(`http://127.0.0.1:${cfg.browser.debugPort}/json/list`)).json()) as any[];
const page = list.find((t) => t.type === 'page');
if (!page || !String(page.url).startsWith(sandboxOrigin(cfg))) throw new Error('No sandbox page');
const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
try {
  const end = Date.now() + Number(timeout) * 1000;
  for (;;) {
    const html = await cdp.eval<string | null>(`(() => { const all = [...document.querySelectorAll(${JSON.stringify(sel)})]; if (!all.length) return null;
      return all.map((e) => e.outerHTML.replace(/<svg[\\s\\S]*?<\\/svg>/g, '').replace(/ style="[^"]*"/g, '').replace(/ (alt|draggable)="[^"]*"/g, '')).join('\\n----\\n'); })()`);
    if (html) { console.log(html.slice(0, Number(max))); break; }
    if (Date.now() > end) { console.log('timeout'); break; }
    await new Promise((r) => setTimeout(r, 80));
  }
} finally { cdp.close(); }
