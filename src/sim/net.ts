import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import type { MockApi } from '../sandbox/mockApi.ts';

/**
 * The sim's whole "network". Nothing here opens a socket.
 *
 *   same origin (http://localhost:8080)  → a file under mirror/ (query string dropped), 404 when the mirror lacks it
 *   https://api.pokebonk.com             → the in-process mock API (src/sandbox/mockApi.ts)
 *   anything else                        → recorded in `blocked`, then the call throws (fetch rejects like a network error)
 *
 * WebSocket, RTCPeerConnection, XMLHttpRequest, EventSource and sendBeacon are replaced by stubs that record and throw.
 */

export const ORIGIN = 'http://localhost:8080';
export const PAGE_URL = ORIGIN + '/?lang=en';
export const API_HOST = 'api.pokebonk.com';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.ogg': 'audio/ogg', '.glb': 'model/gltf-binary', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

export interface NetLog {
  /** Everything that tried to leave the process: `"<kind> <url>"`. */
  blocked: string[];
  /** Same-origin paths the mirror does not have (the browser would get a 404 from the local server too). */
  missing: Map<string, number>;
  /** API calls answered by the mock: `"METHOD /path → status"` with a count. */
  api: Map<string, number>;
  files: number;
  /** Value of the `x-client` header the game sent with its API calls (its own client version string), once seen. */
  client: string | null;
}

export interface NetOptions {
  mirrorDir: string;
  api: MockApi;
  /**
   * Pin what the mock draws at random when it issues a run ticket (POST /runs): the run seed, and the ticket id.
   * The id matters as much as the seed: the game hashes it into the seed of its level-up and drop rolls.
   * The mock keeps its own id (it names its run file after it); the pinned one is what the game sees, and request
   * paths that carry it are translated back.
   */
  pinTicket?: () => { seed: number; id: string };
  /** The platform's own Response class (not the DOM library's). */
  Response: typeof Response;
}

export class Net {
  readonly log: NetLog = { blocked: [], missing: new Map(), api: new Map(), files: 0, client: null };
  private opt: NetOptions;
  private mirrorRoot: string;
  /** Pinned ticket id (what the game uses) → the mock's own id. */
  private ticketIds = new Map<string, string>();

  constructor(opt: NetOptions) { this.opt = opt; this.mirrorRoot = normalize(opt.mirrorDir + sep); }

  /** Map a same-origin URL to a file under the mirror, or null when the mirror has no such file. */
  fileFor(url: URL): string | null {
    let p: string;
    try { p = decodeURIComponent(url.pathname); } catch { return null; }
    if (p === '/' || p === '') p = '/index.html';
    const f = normalize(join(this.opt.mirrorDir, p));
    if (!f.startsWith(this.mirrorRoot)) return null; // no ../ escapes
    try { if (existsSync(f) && statSync(f).isFile()) return f; } catch { /* treated as missing */ }
    return null;
  }

  /** Bytes of a same-origin resource, or null. Used by fetch and by the fake Image. */
  readLocal(href: string): Buffer | null {
    let u: URL;
    try { u = new URL(href, PAGE_URL); } catch { return null; }
    if (u.origin !== ORIGIN) return null;
    const f = this.fileFor(u);
    if (!f) { this.log.missing.set(u.pathname, (this.log.missing.get(u.pathname) ?? 0) + 1); return null; }
    this.log.files++;
    return readFileSync(f);
  }

  block(kind: string, url: unknown): never {
    const s = `${kind} ${String(url)}`;
    this.log.blocked.push(s);
    throw new TypeError(`[sim] network is disabled: ${s}`);
  }

  fetch = async (input: any, init: any = {}): Promise<Response> => {
    const R = this.opt.Response;
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input?.url ?? input);
    const method = String(init.method ?? input?.method ?? 'GET').toUpperCase();
    let u: URL;
    try { u = new URL(href, PAGE_URL); } catch { return this.block('fetch', href); }
    if (init.signal?.aborted) throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });

    // Not network, but not implemented either (the bundle never fetched one in any run so far): fail loudly.
    if (u.protocol === 'data:' || u.protocol === 'blob:') return this.block('fetch (local URL, unsupported by the sim)', href.slice(0, 80));

    if (u.origin === ORIGIN) {
      const f = this.fileFor(u);
      if (!f) {
        this.log.missing.set(u.pathname, (this.log.missing.get(u.pathname) ?? 0) + 1);
        return new R('Not found', { status: 404, statusText: 'Not Found', headers: { 'content-type': 'text/plain' } });
      }
      this.log.files++;
      const body = method === 'HEAD' ? null : readFileSync(f);
      return new R(body, { status: 200, headers: { 'content-type': MIME[extname(f).toLowerCase()] ?? 'application/octet-stream', 'content-length': String(statSync(f).size) } });
    }

    if (u.hostname === API_HOST) {
      const headers: Record<string, string> = {};
      const h = init.headers ?? input?.headers;
      if (h && typeof h.forEach === 'function') h.forEach((v: string, k: string) => { headers[k.toLowerCase()] = v; });
      else if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
      if (headers['x-client']) this.log.client = headers['x-client'];
      let body: unknown;
      if (typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch { body = undefined; } }
      const path = u.pathname.replace(/^\/runs\/([\w-]+)/, (all, id: string) => (this.ticketIds.has(id) ? `/runs/${this.ticketIds.get(id)}` : all));
      const out = await this.opt.api.handle(method, path + u.search, headers, body);
      const key = `${method} ${u.pathname.replace(/\/[0-9a-f]{16,}(?=\/|$)/g, '/:id')} → ${out.status}`;
      this.log.api.set(key, (this.log.api.get(key) ?? 0) + 1);
      let json: any = out.json;
      if (this.opt.pinTicket && method === 'POST' && u.pathname === '/runs' && out.status === 200 && json && typeof json.id === 'string') {
        const pin = this.opt.pinTicket();
        this.ticketIds.set(pin.id, json.id);
        json = { ...json, id: pin.id, seed: pin.seed };
      }
      if (json === undefined) return new R(null, { status: out.status });
      return new R(JSON.stringify(json), { status: out.status, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }

    return this.block('fetch', u.href);
  };

  /** Classes that would open a connection: constructing one records the target and throws. */
  blockedClass(kind: string): any {
    const net = this;
    return class { constructor(url?: unknown) { net.block(kind, url ?? ''); } };
  }
}
