import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { logger } from '../logger.ts';

const log = logger('mirror');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.webm': 'video/webm',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
};

/** A plain browser user agent: the copy is made the way a normal visit downloads these files. */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export interface MirrorOptions { dir: string; upstream: string; fillMisses: boolean; dataDir?: string }

/**
 * The local copy of the game's public static files (HTML, JS chunks, data, sprites, audio). `serve` answers from disk.
 * With `fillMisses` a file that is not on disk yet is downloaded once from the public site and kept: that is the
 * explicit warm-up mode. Without it the mirror never opens a connection anywhere.
 */
export class Mirror {
  readonly opt: MirrorOptions;
  private inflight = new Map<string, Promise<boolean>>();
  private missed = new Set<string>();
  stats = { served: 0, filled: 0, missing: 0 };

  constructor(opt: MirrorOptions) {
    this.opt = opt;
    mkdirSync(opt.dir, { recursive: true });
  }

  hasIndex() { return existsSync(join(this.opt.dir, 'index.html')); }

  /** URL path → file inside the mirror folder, or null for anything that would leave it. */
  fileFor(urlPath: string): string | null {
    let p: string;
    try { p = decodeURIComponent(urlPath.split('?')[0]); } catch { return null; }
    if (p.endsWith('/')) p += 'index.html';
    const full = normalize(join(this.opt.dir, p));
    return full === this.opt.dir || full.startsWith(this.opt.dir + sep) ? full : null;
  }

  /** Download one public static file into the mirror. Returns false when the site does not have it. */
  async fetchOne(urlPath: string): Promise<boolean> {
    const file = this.fileFor(urlPath);
    if (!file) return false;
    const key = urlPath.split('?')[0];
    const running = this.inflight.get(key);
    if (running) return running;
    const job = (async () => {
      try {
        const res = await fetch(this.opt.upstream + urlPath, { headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'follow' });
        if (!res.ok) { log.debug(`upstream ${res.status} ${urlPath}`); return false; }
        const type = res.headers.get('content-type') ?? '';
        // A missing file answered with the site's HTML shell is not the file.
        if (type.includes('text/html') && !/\.html?$|\/$/.test(key)) return false;
        const buf = Buffer.from(await res.arrayBuffer());
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, buf);
        this.stats.filled++;
        return true;
      } catch (e) {
        log.warn(`fetch failed ${urlPath}: ${(e as Error).message}`);
        return false;
      } finally { this.inflight.delete(key); }
    })();
    this.inflight.set(key, job);
    return job;
  }

  private noteMissing(urlPath: string) {
    const key = urlPath.split('?')[0];
    this.stats.missing++;
    if (this.missed.has(key)) return;
    this.missed.add(key);
    if (this.opt.dataDir) { try { appendFileSync(join(this.opt.dataDir, 'logs', 'missing-assets.log'), key + '\n'); } catch { /* best effort */ } }
  }

  async serve(req: IncomingMessage, res: ServerResponse, urlPath: string): Promise<void> {
    const file = this.fileFor(urlPath);
    if (!file) { res.writeHead(400).end('Bad path'); return; }
    let ok = existsSync(file) && statSync(file).isFile();
    if (!ok && this.opt.fillMisses) ok = await this.fetchOne(urlPath);
    if (!ok) {
      this.noteMissing(urlPath);
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('Not in the local mirror');
      return;
    }
    const st = statSync(file), ext = extname(file).toLowerCase(), html = ext === '.html';
    const etag = `"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`;
    const head: Record<string, string | number> = {
      'Content-Type': TYPES[ext] ?? 'application/octet-stream',
      'Cache-Control': html ? 'no-store' : 'public, max-age=86400',
      ETag: etag,
      'Accept-Ranges': 'bytes',
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, head).end(); return; }
    this.stats.served++;
    // Audio elements ask for byte ranges.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end(); return; }
      res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') { res.end(); return; }
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...head, 'Content-Length': st.size });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file).pipe(res);
  }

  // ---------------- one-time copy (`npm run mirror`) ----------------

  /**
   * Copy the page shell and everything it links to: index.html, the JS/CSS chunk graph, the data files and the files
   * named literally in the bundles. Sprites and audio that the game addresses by id are picked up by `deep` (ids read
   * from the data files) or, lazily, by the warm-up mode.
   */
  async crawl(opt: { deep: boolean; concurrency?: number; onProgress?: (done: number, total: number, last: string) => void }) {
    const seen = new Set<string>(), queue: string[] = [];
    const add = (p: string) => {
      const clean = p.split('#')[0];
      const key = clean.split('?')[0];
      if (!key.startsWith('/') || seen.has(key)) return;
      seen.add(key);
      queue.push(clean);
    };
    const text = (p: string) => { const f = this.fileFor(p); return f && existsSync(f) ? readFileSync(f, 'utf8') : ''; };

    if (!(await this.fetchOne('/'))) throw new Error(`Could not download the page from ${this.opt.upstream}`);
    seen.add('/index.html');
    const html = text('/');
    for (const m of html.matchAll(/(?:src|href)="\.?\/?([^"#?:]+\.[a-z0-9]+)(\?[^"]*)?"/g)) add('/' + m[1].replace(/^\.\//, ''));
    for (const f of ['/manifest.webmanifest', '/favicon.ico', '/version.json', '/desktop.json', '/creditos.txt']) add(f);

    let done = 0;
    const scan = (p: string) => {
      const key = p.split('?')[0], ext = extname(key);
      if (ext !== '.js' && ext !== '.css' && ext !== '.webmanifest') return;
      const src = text(key), base = key.slice(0, key.lastIndexOf('/') + 1);
      // Sibling chunks: "./name-hash.js" in import statements and in Vite's preload lists.
      for (const m of src.matchAll(/["'`]\.\/([\w.@~-]+\.(?:js|css))["'`]/g)) add(base + m[1]);
      // url(...) in stylesheets, relative to the stylesheet.
      if (ext === '.css') for (const m of src.matchAll(/url\(\s*["']?(?!data:)([^"')]+)["']?\s*\)/g)) add(new URL(m[1], 'http://x' + key).pathname);
      if (ext === '.webmanifest') for (const m of src.matchAll(/"src"\s*:\s*"([^"]+)"/g)) add(new URL(m[1], 'http://x' + key).pathname);
      if (ext === '.js') {
        // The bundle's own version table: `"data/pokemon.json": "hash"` → /data/pokemon.json?v=hash
        for (const m of src.matchAll(/["']?(data\/[\w/.-]+\.json)["']?:\s*`([\w-]+)`/g)) add(`/${m[1]}?v=${m[2]}`);
        // Files named in full inside the code (icons, banners, fixed sprites): assets/<family>/<name>.<ext>
        for (const m of src.matchAll(/[`"']((?:ui|items|env|icons|portraits|models|music|front|gear)\/[\w/-]+\.(?:png|jpg|webp|ogg|mp3|glb|json))[`"']/g)) add('/assets/' + m[1]);
      }
    };

    const conc = opt.concurrency ?? 4;
    const worker = async () => {
      for (;;) {
        const p = queue.shift();
        if (p === undefined) return;
        const f = this.fileFor(p);
        const have = !!f && existsSync(f) && p !== '/';
        if (have || (await this.fetchOne(p))) scan(p);
        done++;
        opt.onProgress?.(done, done + queue.length, p.split('?')[0]);
        if (!have) await new Promise((r) => setTimeout(r, 60)); // easy on the site: a handful of requests per second
      }
    };
    const drain = async () => { while (queue.length) await Promise.all(Array.from({ length: conc }, worker)); };
    await drain();

    if (opt.deep) {
      for (const p of this.deepList()) add(p);
      await drain();
    }
    return { files: seen.size, downloaded: this.stats.filled };
  }

  /** Per-species files (sprites, portraits, icons, cries), with ids read from the mirrored data files. */
  private deepList(): string[] {
    const out: string[] = [];
    try {
      const raw = JSON.parse(readFileSync(join(this.opt.dir, 'data', 'pokemon.json'), 'utf8'));
      const list: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.pokemon) ? raw.pokemon : Object.values(raw);
      const ids = [...new Set(list.map((p) => Number(p?.id)).filter((n) => Number.isInteger(n) && n > 0))];
      for (const idNum of ids) for (const [dir, ext] of [['pmd', 'png'], ['portraits', 'png'], ['icons', 'png'], ['cries', 'ogg']])
        out.push(`/assets/${dir}/${idNum}.${ext}`);
    } catch (e) { log.warn(`deep list skipped: ${(e as Error).message}`); }
    try {
      const raw = JSON.parse(readFileSync(join(this.opt.dir, 'data', 'items.json'), 'utf8'));
      const list: any[] = Array.isArray(raw) ? raw : Object.values(raw);
      for (const it of list) if (typeof it?.key === 'string' && /^[\w-]+$/.test(it.key)) out.push(`/assets/items/${it.key}.png`);
    } catch { /* optional */ }
    return out;
  }
}
