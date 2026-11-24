import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Cdp } from '../cdp/client.ts';
import { findBrowser } from '../cdp/browser.ts';
import { DEFAULTS } from '../config.ts';
import { API_HOST, ORIGIN, Net } from '../sim/net.ts';

/**
 * The oracle browser: a local Chrome with its own profile folder (data/fidelity/browser-profile), a visible window,
 * and no way out of the machine.
 *
 * Containment, the same two layers as the legacy sandbox browser (src/cdp/browser.ts), plus one:
 *  1. host resolver rule: nothing but localhost resolves;
 *  2. every request is paused (CDP Fetch domain) and answered here:
 *       http://localhost:8080/...     → the file under mirror/, read by the same `Net` class the headless page uses
 *       https://api.pokebonk.com/...  → the in-process mock API, through the same `Net` (ticket seed and id pinned)
 *       data: / blob: / about:        → continue (not network)
 *       anything else                 → failed, and listed in `blocked`
 *  3. nothing listens on port 8080 for this: no HTTP server is started at all. The page origin is the same string the
 *     headless page has (`http://localhost:8080`), served entirely from memory.
 *
 * Differences from the legacy launcher, on purpose: no `--autoplay-policy=no-user-gesture-required` (the audio context
 * must stay suspended, as it is in a tab nobody has clicked and as the headless shim reports it), and the debugging
 * port is chosen by Chrome (read from DevToolsActivePort), so nothing collides with a running sandbox.
 */

export interface ServedRequest { n: number; method: string; url: string; kind: 'file' | 'api' | 'local' | 'blocked'; status: number; ms: number }

export interface ChromeOptions {
  profileDir: string;
  mirrorDir: string;
  net: Net;
  /** Virtual `Date.now()` for the mock while it answers the API call that is being routed (the page's clock). */
  apiNow: (method: string, url: string) => Promise<number>;
  /** In-memory change of a served script (the module load hook of the headless side, same statement). */
  patchScript?: (path: string, source: string) => string | null;
  width?: number;
  height?: number;
  log?: (line: string) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class OracleChrome {
  readonly opt: ChromeOptions;
  cdp!: Cdp;
  private proc: ChildProcess | null = null;
  readonly served: ServedRequest[] = [];
  readonly blocked: string[] = [];
  readonly patched: string[] = [];
  /** Requests paused and not yet answered. */
  inflight = 0;
  /** performance.now() of the last request start or end. */
  lastActivity = 0;
  version: Record<string, string> = {};
  exited = false;

  constructor(opt: ChromeOptions) { this.opt = opt; }

  async launch(): Promise<Cdp> {
    const exe = findBrowser(DEFAULTS);
    const profile = this.opt.profileDir;
    mkdirSync(profile, { recursive: true });
    const portFile = join(profile, 'DevToolsActivePort');
    rmSync(portFile, { force: true });
    const w = this.opt.width ?? 1280, h = this.opt.height ?? 720;
    const args = [
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
      '--enable-automation',
      '--no-first-run', '--no-default-browser-check', '--disable-default-apps', '--disable-sync', '--disable-extensions',
      '--disable-component-update', '--disable-background-networking', '--disable-domain-reliability', '--no-pings',
      '--disable-features=Translate,OptimizationHints,MediaRouter,CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
      `--window-size=${w + 16},${h + 140}`,
      '--lang=en',
      '--mute-audio',
      'about:blank',
    ];
    this.proc = spawn(exe, args, { stdio: 'ignore', detached: false });
    this.proc.on('exit', () => { this.exited = true; this.proc = null; });

    let port = 0;
    for (let i = 0; i < 120 && !port; i++) {
      if (existsSync(portFile)) port = Number(readFileSync(portFile, 'utf8').split('\n')[0]) || 0;
      if (!port) await sleep(250);
    }
    if (!port) throw new Error('Chrome did not write its debugging port (DevToolsActivePort)');
    const base = `http://127.0.0.1:${port}`;
    this.version = (await (await fetch(`${base}/json/version`)).json()) as Record<string, string>;
    let target = '';
    for (let i = 0; i < 80 && !target; i++) {
      const list = (await (await fetch(`${base}/json/list`)).json()) as { type: string; webSocketDebuggerUrl?: string }[];
      target = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? '';
      if (!target) await sleep(250);
    }
    if (!target) throw new Error('Chrome has no page target');
    const c = (this.cdp = await Cdp.connect(target));
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    await c.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    c.on('Fetch.requestPaused', (p) => { void this.route(p).catch((e) => this.opt.log?.(`route failed: ${(e as Error).message}`)); });
    // The viewport the headless page reports (1280 × 720, device pixel ratio 1), whatever the window size.
    await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    // The page must not see the owner's mouse or keyboard, nor a blur when another window is in front.
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await c.send('Input.setIgnoreInputEvents', { ignore: true }).catch(() => {});
    c.on('Page.javascriptDialogOpening', () => { void c.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); });
    return c;
  }

  private cors(origin: string | undefined) {
    return [
      { name: 'Access-Control-Allow-Origin', value: origin ?? ORIGIN },
      { name: 'Access-Control-Allow-Headers', value: 'authorization, content-type, x-device, x-client, x-admin-token' },
      { name: 'Access-Control-Allow-Methods', value: 'GET, POST, PUT, DELETE, OPTIONS' },
      { name: 'Access-Control-Max-Age', value: '600' },
      { name: 'Cache-Control', value: 'no-store' },
    ];
  }

  private async route(p: any): Promise<void> {
    const c = this.cdp, req = p.request, url: string = req.url, t0 = performance.now();
    const note = (kind: ServedRequest['kind'], status: number) => { this.served.push({ n: this.served.length, method: req.method, url, kind, status, ms: Math.round(performance.now() - t0) }); };
    if (/^(data|blob|about|chrome|devtools):/.test(url)) { await c.send('Fetch.continueRequest', { requestId: p.requestId }); return; }
    this.inflight++; this.lastActivity = t0;
    try {
      let u: URL;
      try { u = new URL(url); } catch { this.blocked.push(`${req.method} ${url}`); await c.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }); return; }
      const isPage = u.origin === ORIGIN, isApi = u.hostname === API_HOST;
      if (!isPage && !isApi) {
        this.blocked.push(`${req.method} ${u.origin}${u.pathname}`);
        note('blocked', 0);
        await c.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' });
        return;
      }
      const headers = req.headers as Record<string, string>;
      const origin = headers.Origin ?? headers.origin;
      if (isApi && req.method === 'OPTIONS') {
        await c.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 204, responseHeaders: this.cors(origin) });
        return;
      }
      let body: string | undefined = req.postData;
      if (body === undefined && req.hasPostData) {
        const d = await c.send('Fetch.getRequestPostData', { requestId: p.requestId }).catch(() => null);
        body = d ? (d.base64Encoded ? Buffer.from(d.postData, 'base64').toString('utf8') : d.postData) : undefined;
      }
      let res: Response;
      if (isApi) {
        // The mock stamps replies with Date.now(). Headless that is the page's virtual clock; give it the same here.
        const now = await this.opt.apiNow(req.method, url);
        const realNow = Date.now;
        let pending: Promise<Response>;
        Date.now = () => now;
        try { pending = this.opt.net.fetch(url, { method: req.method, headers, body }); } finally { Date.now = realNow; }
        res = await pending;
      } else res = await this.opt.net.fetch(url, { method: req.method });
      let buf = Buffer.from(await res.arrayBuffer());
      if (isPage && res.status === 200 && u.pathname.endsWith('.js') && this.opt.patchScript) {
        const out = this.opt.patchScript(u.pathname, buf.toString('utf8'));
        if (out !== null) { buf = Buffer.from(out, 'utf8'); this.patched.push(u.pathname); }
      }
      const responseHeaders = [...(isApi ? this.cors(origin) : [{ name: 'Cache-Control', value: 'no-store' }])];
      const type = res.headers.get('content-type');
      if (type) responseHeaders.push({ name: 'Content-Type', value: type });
      note(isApi ? 'api' : 'file', res.status);
      await c.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: res.status, responseHeaders, body: buf.toString('base64') }, 30_000);
    } finally { this.inflight--; this.lastActivity = performance.now(); }
  }

  /** Wait until no request has been in flight for `quietMs`. */
  async networkQuiet(quietMs: number, timeoutMs = 60_000): Promise<void> {
    const t0 = performance.now();
    for (;;) {
      const idleFor = performance.now() - this.lastActivity;
      if (this.inflight === 0 && idleFor >= quietMs) return;
      if (performance.now() - t0 > timeoutMs) throw new Error(`the browser's requests did not settle (${this.inflight} in flight)`);
      await sleep(this.inflight ? 2 : Math.max(1, Math.min(10, quietMs - idleFor)));
    }
  }

  async screenshot(file: string): Promise<void> {
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'png' }, 30_000);
    (await import('node:fs')).writeFileSync(file, Buffer.from(data, 'base64'));
  }

  /** Close this Chrome, and only this one: the process started here, by its handle. */
  async close(): Promise<void> {
    try { await this.cdp?.send('Browser.close', {}, 3000); } catch { /* already gone */ }
    this.cdp?.close();
    for (let i = 0; i < 20 && this.proc; i++) await sleep(100);
    const proc = this.proc;
    if (proc && !proc.killed) { try { proc.kill(); } catch { /* gone */ } }
  }
}
