/**
 * Which Math functions do Node's V8 and the local Chrome's V8 compute differently?
 *
 *   node scripts/fidelity/math.ts [--n=20000]
 *
 * Runs `mathBattery` (src/fidelity/shared.ts) in this process and in the oracle browser (a blank page: nothing is
 * loaded) and compares every result bit for bit. Then does the same with the comparison's common implementation
 * (src/fidelity/commonMath.ts) installed on both sides: that one must be identical everywhere, and its distance from
 * the engine's own results says how good an approximation it is. Writes data/fidelity/math.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OracleChrome } from '../../src/fidelity/chrome.ts';
import { installCommonMath } from '../../src/fidelity/commonMath.ts';
import { mathBattery } from '../../src/fidelity/shared.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const n = Number(/--n=(\d+)/.exec(process.argv.join(' '))?.[1] ?? 20000);
const dataDir = resolve(REPO, 'data', 'fidelity');
mkdirSync(dataDir, { recursive: true });
const say = (s: string) => process.stdout.write(s + '\n');

type Battery = Record<string, number[]>;
const f64 = new Float64Array(1), i64 = new BigInt64Array(f64.buffer);
const bits = (x: number) => { f64[0] = x; return i64[0]; };
function compare(a: Battery, b: Battery, nameA: string, nameB: string) {
  return Object.keys(a).map((fn) => {
    let different = 0, maxUlp = 0, example = '';
    for (let i = 0; i < n; i++) {
      const x = a[fn][i], y = b[fn][i];
      if (Object.is(x, y) || (Number.isNaN(x) && Number.isNaN(y))) continue;
      different++;
      const d = bits(x) - bits(y), ulp = Number(d < 0n ? -d : d);
      if (ulp > maxUlp) maxUlp = ulp;
      if (!example) example = `${nameA} ${x} | ${nameB} ${y}`;
    }
    return { fn, inputs: n, different, maxUlp, example };
  });
}
const show = (title: string, rows: ReturnType<typeof compare>) => {
  say(title);
  for (const r of rows) say(`  ${r.fn.padEnd(12)} ${r.different === 0 ? 'identical' : `${r.different} differ (${(100 * r.different / n).toFixed(2)} %), at most ${r.maxUlp} ulp; e.g. ${r.example}`}`);
};
const revive = (text: string): Battery => JSON.parse(text, (_k, v) => (v === 'NaN' ? NaN : v === 'Infinity' ? Infinity : v === '-Infinity' ? -Infinity : v)) as Battery;
const inPage = (pre: string) => `(() => { ${pre}; return JSON.stringify((${mathBattery.toString()})(${n}), (k, v) => typeof v === 'number' && !Number.isFinite(v) ? String(v) : v); })()`;

// `--profile=<folder>`: another Chrome profile folder under data/fidelity, when a comparison is using the default one.
const profile = /--profile=([\w-]+)/.exec(process.argv.join(' '))?.[1] ?? 'browser-profile';
const chrome = new OracleChrome({ profileDir: join(dataDir, profile), mirrorDir: join(REPO, 'mirror'), net: null as never, apiNow: async () => 0 });
const cdp = await chrome.launch();
try {
  const nodeNative = mathBattery(n);
  const chromeNative = revive(await cdp.eval<string>(inPage(''), { timeoutMs: 120_000 }));
  const chromeCommon = revive(await cdp.eval<string>(inPage(`(${installCommonMath.toString()})(Math)`), { timeoutMs: 120_000 }));
  installCommonMath(Math);
  const nodeCommon = mathBattery(n);
  const out = {
    node: process.version, nodeV8: process.versions.v8, chrome: chrome.version.Browser, chromeV8: chrome.version['V8-Version'], inputs: n,
    nativeNodeVsChrome: compare(nodeNative, chromeNative, 'node', 'chrome'),
    commonNodeVsChrome: compare(nodeCommon, chromeCommon, 'node', 'chrome'),
    commonVsNativeNode: compare(nodeCommon, nodeNative, 'common', 'native'),
    commonVsNativeChrome: compare(chromeCommon, chromeNative, 'common', 'native'),
  };
  writeFileSync(join(dataDir, 'math.json'), JSON.stringify(out, null, 1));
  say(`Math functions, ${n} inputs each: Node ${out.node} (V8 ${out.nodeV8}) vs ${out.chrome} (V8 ${out.chromeV8})`);
  show('1. the engines\' own functions, Node vs Chrome:', out.nativeNodeVsChrome);
  show('2. the common implementation, Node vs Chrome (must be identical):', out.commonNodeVsChrome);
  show('3. the common implementation vs Node\'s own (how far the stand-in is from the engine):', out.commonVsNativeNode);
  show('4. the common implementation vs Chrome\'s own:', out.commonVsNativeChrome);
} finally { await chrome.close(); }
process.exit(0);
