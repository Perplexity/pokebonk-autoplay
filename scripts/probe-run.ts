/**
 * Developer probe: find the live run object in the sandbox page and print its shape (keys, types, small samples).
 * Used to (re)derive the snapshot extractor when the game build changes.
 *
 *   node scripts/probe-run.ts [dotted.path] [depth]
 */
import { loadConfig, sandboxOrigin } from '../src/config.ts';
import { Cdp } from '../src/cdp/client.ts';
import { locateRun } from '../src/bot/perception.ts';

const cfg = loadConfig([]);
const list = (await (await fetch(`http://127.0.0.1:${cfg.browser.debugPort}/json/list`)).json()) as any[];
const page = list.find((t) => t.type === 'page');
if (!page || !String(page.url).startsWith(sandboxOrigin(cfg))) throw new Error('No sandbox page');
const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
const path = process.argv[2] ?? '';
const depth = Number(process.argv[3] ?? 1);
try {
  const t0 = Date.now();
  const runId = await locateRun(cdp);
  console.log(`locate: ${Date.now() - t0} ms ->`, runId ? 'found' : 'NOT FOUND');
  if (runId && process.argv[2] === '--fn') {
    // node scripts/probe-run.ts --fn "return Object.keys(run.ui)"   (the body receives `run`)
    const out = await cdp.send('Runtime.callFunctionOn', {
      objectId: runId, returnByValue: true, functionDeclaration: `function () { const run = this; ${process.argv.slice(3).join(' ')} }`,
    }, 30_000);
    if (out.exceptionDetails) console.log('ERR', out.exceptionDetails.exception?.description);
    else console.log(typeof out.result.value === 'string' ? out.result.value : JSON.stringify(out.result.value));
  } else if (runId) {
    const out = await cdp.send('Runtime.callFunctionOn', {
      objectId: runId, returnByValue: true, arguments: [{ value: path }, { value: depth }],
      functionDeclaration: `function (path, depth) {
        let o = this;
        for (const k of path.split('.').filter(Boolean)) o = o?.[k];
        const seen = new Set();
        const desc = (v, d) => {
          if (v === null || v === undefined) return String(v);
          const t = typeof v;
          if (t === 'number') return Number.isInteger(v) ? v : Math.round(v * 1000) / 1000;
          if (t === 'string') return JSON.stringify(v.slice(0, 60));
          if (t === 'boolean') return v;
          if (t === 'function') return 'fn';
          if (seen.has(v)) return '<seen>';
          if (ArrayBuffer.isView(v)) return v.constructor.name + '(' + v.length + ') [' + Array.from(v.slice(0, 6)).map((x) => Math.round(x * 100) / 100).join(',') + ']';
          if (Array.isArray(v)) { if (d <= 0) return 'Array(' + v.length + ')'; seen.add(v); return { __array: v.length, first: v.slice(0, 2).map((x) => desc(x, d - 1)) }; }
          if (v instanceof Map) { if (d <= 0) return 'Map(' + v.size + ')'; return { __map: v.size, first: [...v.entries()].slice(0, 3).map(([k, x]) => [desc(k, 0), desc(x, d - 1)]) }; }
          if (v instanceof Set) return 'Set(' + v.size + ') ' + JSON.stringify([...v].slice(0, 5).map((x) => desc(x, 0)));
          const name = v.constructor?.name ?? 'Object';
          if (d <= 0) return '{' + name + ' ' + Object.keys(v).length + ' keys}';
          seen.add(v);
          const out = {};
          for (const k of Object.keys(v).slice(0, 220)) {
            if (k === 'run' || k === 'r' || k === 'meta' || k === 'audio' || k === 'vfx' || k === 'sprites') { out[k] = '<ref>'; continue; }
            try { out[k] = desc(v[k], d - 1); } catch (e) { out[k] = '<err>'; }
          }
          const proto = Object.getPrototypeOf(v);
          if (proto && proto !== Object.prototype) out.__methods = Object.getOwnPropertyNames(proto).filter((k) => k !== 'constructor').slice(0, 150).join(' ');
          return out;
        };
        return desc(o, depth);
      }`,
    }, 30_000);
    console.log(JSON.stringify(out.result.value, null, 1));
  }
} finally { cdp.close(); }
