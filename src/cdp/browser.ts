import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sandboxOrigin, type Config } from '../config.ts';
import { logger } from '../logger.ts';
import { Cdp } from './client.ts';

const log = logger('browser');

const CANDIDATES = [
  process.env.CHROME_PATH ?? '',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];

export function findBrowser(cfg: Config): string {
  const p = [cfg.browser.path, ...CANDIDATES].find((c) => c && existsSync(c));
  if (!p) throw new Error('No Chrome/Edge found. Set browser.path in config.json or the CHROME_PATH environment variable.');
  return p;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
export const isLoopback = (url: string) => { try { return LOOPBACK.has(new URL(url).hostname); } catch { return false; } };

/**
 * The sandbox browser: its own Chrome profile under the data folder, started for this project only.
 *
 * Network containment, in two layers:
 *  1. Chrome is started with a host resolver rule that makes every hostname except localhost unresolvable.
 *  2. Every request the page makes is paused (CDP Fetch domain) and routed here: loopback requests continue, calls to
 *     the game's API hostname are answered by the local mock, anything else is failed and written to
 *     data/logs/blocked-requests.log.
 * So no request from this browser can reach the live game service, whatever the page tries.
 */
export class SandboxBrowser {
  readonly cfg: Config;
  cdp!: Cdp;
  private proc: ChildProcess | null = null;
  blocked = 0;
  routed = 0;
  onExit: () => void = () => {};

  constructor(cfg: Config) { this.cfg = cfg; }

  private get origin() { return sandboxOrigin(this.cfg); }
  private get debugUrl() { return `http://127.0.0.1:${this.cfg.browser.debugPort}`; }

  async launch(): Promise<Cdp> {
    const exe = findBrowser(this.cfg), b = this.cfg.browser;
    const profile = join(this.cfg.dataDir, 'browser-profile');
    mkdirSync(profile, { recursive: true });
    const args = [
      `--remote-debugging-port=${b.debugPort}`,
      `--user-data-dir=${profile}`,
      // Layer 1: nothing but localhost resolves.
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
      '--enable-automation',
      '--no-first-run', '--no-default-browser-check', '--disable-default-apps', '--disable-sync', '--disable-extensions',
      '--disable-component-update', '--disable-background-networking', '--disable-domain-reliability', '--no-pings',
      '--disable-features=Translate,OptimizationHints,MediaRouter,CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
      // The run should not slow down when the window is covered or in the background.
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--autoplay-policy=no-user-gesture-required',
      '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
      `--window-size=${b.width},${b.height}`,
      `--lang=${b.lang}`,
      ...(b.mute ? ['--mute-audio'] : []),
      // Running faster than real time needs more simulation steps per second: let the page draw as fast as it can.
      ...(this.cfg.bot.speed > 1 ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []),
      ...(b.headless ? ['--headless=new'] : []),
      'about:blank',
    ];
    log.info(`starting ${exe}${b.headless ? ' (headless)' : ''}`);
    this.proc = spawn(exe, args, { stdio: 'ignore', detached: false });
    this.proc.on('exit', (code) => { log.info(`browser exited (${code})`); this.proc = null; this.onExit(); });

    const target = await this.waitForPage();
    this.cdp = await Cdp.connect(target);
    await this.prepare();
    return this.cdp;
  }

  private async waitForPage(): Promise<string> {
    for (let i = 0; i < 80; i++) {
      try {
        const list = (await (await fetch(`${this.debugUrl}/json/list`)).json()) as any[];
        const page = list.find((t) => t.type === 'page');
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`The browser did not open its debugging port ${this.cfg.browser.debugPort}`);
  }

  private async prepare() {
    const c = this.cdp;
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    await c.send('Network.enable');
    // Layer 2: every request goes through route().
    await c.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    c.on('Fetch.requestPaused', (p) => { void this.route(p).catch((e) => log.debug(`route: ${e.message}`)); });
    // A fixed viewport, the same with or without a window, so screen coordinates and layouts are reproducible.
    await c.send('Emulation.setDeviceMetricsOverride', { width: this.cfg.browser.width, height: this.cfg.browser.height, deviceScaleFactor: 1, mobile: false }).catch(() => {});
    // The game pauses when the window loses focus; the sandbox window is often behind other windows.
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    c.on('Page.javascriptDialogOpening', () => { void c.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); });
    c.on('Runtime.exceptionThrown', (p) => log.debug('page exception', p.exceptionDetails?.exception?.description?.slice(0, 300) ?? p.exceptionDetails?.text));
    c.on('Inspector.targetCrashed', () => { log.error('page crashed'); });
  }

  private corsHeaders(origin: string | undefined) {
    return [
      { name: 'Access-Control-Allow-Origin', value: origin ?? this.origin },
      { name: 'Access-Control-Allow-Headers', value: 'authorization, content-type, x-device, x-client, x-admin-token' },
      { name: 'Access-Control-Allow-Methods', value: 'GET, POST, PUT, DELETE, OPTIONS' },
      { name: 'Access-Control-Max-Age', value: '600' },
      { name: 'Cache-Control', value: 'no-store' },
    ];
  }

  private async route(p: any) {
    const c = this.cdp, req = p.request, url: string = req.url;
    if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:') || url.startsWith('chrome')) {
      await c.send('Fetch.continueRequest', { requestId: p.requestId });
      return;
    }
    let u: URL;
    try { u = new URL(url); } catch { await c.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }); return; }

    if (LOOPBACK.has(u.hostname) && u.port === String(this.cfg.port)) {
      await c.send('Fetch.continueRequest', { requestId: p.requestId });
      return;
    }

    if (u.hostname === this.cfg.apiHost) {
      // The bundle addresses the API by its public hostname; here that name means the local mock.
      const headers = req.headers as Record<string, string>;
      const origin = headers.Origin ?? headers.origin;
      if (req.method === 'OPTIONS') {
        await c.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 204, responseHeaders: this.corsHeaders(origin) });
        return;
      }
      let body: string | undefined = req.postData;
      if (body === undefined && req.hasPostData) {
        const d = await c.send('Fetch.getRequestPostData', { requestId: p.requestId }).catch(() => null);
        body = d ? (d.base64Encoded ? Buffer.from(d.postData, 'base64').toString('utf8') : d.postData) : undefined;
      }
      const fwd: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) if (/^(authorization|content-type|x-device|x-client)$/i.test(k)) fwd[k] = v;
      const res = await fetch(`http://127.0.0.1:${this.cfg.port}/__api${u.pathname}${u.search}`, { method: req.method, headers: fwd, body });
      const buf = Buffer.from(await res.arrayBuffer());
      this.routed++;
      await c.send('Fetch.fulfillRequest', {
        requestId: p.requestId, responseCode: res.status,
        responseHeaders: [...this.corsHeaders(origin), { name: 'Content-Type', value: res.headers.get('content-type') ?? 'application/json' }],
        body: buf.toString('base64'),
      });
      return;
    }

    this.blocked++;
    try { appendFileSync(join(this.cfg.dataDir, 'logs', 'blocked-requests.log'), `${new Date().toISOString()} ${req.method} ${u.origin}${u.pathname}\n`); } catch { /* best effort */ }
    log.debug(`blocked ${req.method} ${u.origin}${u.pathname}`);
    await c.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' });
  }

  async navigate(path = '/') {
    await this.cdp.send('Page.navigate', { url: this.origin + path });
  }

  /** The bot only ever acts on the sandbox origin. */
  async assertSandboxPage(): Promise<void> {
    const href = await this.cdp.eval<string>('location.href');
    if (!href.startsWith(this.origin + '/')) throw new Error(`Refusing to act: the page is ${href}, not the sandbox (${this.origin})`);
  }

  async screenshot(file: string) {
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'png' }, 30_000);
    (await import('node:fs')).writeFileSync(file, Buffer.from(data, 'base64'));
  }

  async close() {
    try { await this.cdp?.send('Browser.close', {}, 3000); } catch { /* already gone */ }
    this.cdp?.close();
    const proc = this.proc;
    if (proc && !proc.killed) setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, 1500);
  }
}
