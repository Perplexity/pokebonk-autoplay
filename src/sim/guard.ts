import { createRequire, syncBuiltinESMExports } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Offline guard for the environment process: Node's own ways of opening a connection are replaced by functions that
 * record the attempt and throw. Installed before the game bundle is loaded (the `Sim` constructor calls it first).
 *
 *   net      Socket.prototype.connect, connect, createConnection, Server.prototype.listen
 *   tls      connect
 *   http(s)  request, get
 *   http2    connect
 *   dns      lookup, lookupService, resolve*, reverse (callback API, promises API and both Resolver classes)
 *   dgram    createSocket, Socket.prototype.bind / connect / send
 *   globals  fetch, WebSocket, EventSource
 *
 * Patching the prototypes (not only the module functions) also covers code that captured `net.connect` earlier, and
 * Node's built-in fetch, whose HTTP client ends in `net.Socket.prototype.connect` / `tls.connect`.
 *
 * This is enforcement inside the process, not around it. Not covered: `child_process`, `worker_threads`, and Node's
 * internal bindings (`process.binding`). The game bundle is browser code and uses none of them.
 *
 * Stdin/stdout pipes keep working: they are existing handles, never opened with `connect`.
 */

const require = createRequire(import.meta.url);

export const GUARD_ERROR = 'ERR_OFFLINE_GUARD';

export interface NetworkAttempt { kind: string; target: string }

export interface SelfTestProbe { name: string; blocked: boolean; detail: string }
export interface SelfTestResult { ok: boolean; probes: SelfTestProbe[] }

export interface NetworkGuard {
  /** Every blocked attempt since installation, self-test probes excluded. */
  readonly attempts: NetworkAttempt[];
  /** What was replaced, for metadata. */
  readonly primitives: string[];
  record(kind: string, target: unknown): void;
  /** Try every primitive against reserved test addresses; `ok` only if each one was refused by the guard. */
  selfTest(): Promise<SelfTestResult>;
  /** Result of the last self-test, if one ran. */
  lastSelfTest: SelfTestResult | null;
}

class OfflineError extends Error {
  code = GUARD_ERROR;
  constructor(what: string) { super(`[offline guard] network is disabled: ${what}`); this.name = 'OfflineGuardError'; }
}

const describe = (args: unknown[]): string => {
  const parts: string[] = [];
  for (const a of args.slice(0, 3)) {
    if (a == null || typeof a === 'function') continue;
    if (typeof a === 'string' || typeof a === 'number') { parts.push(String(a)); continue; }
    if (a instanceof URL) { parts.push(a.href); continue; }
    if (typeof a === 'object') {
      const o = a as Record<string, unknown>;
      if (typeof o.href === 'string') { parts.push(o.href); continue; }
      const host = o.host ?? o.hostname ?? o.address ?? o.path ?? o.servername;
      if (host != null || o.port != null) parts.push(`${String(host ?? '')}${o.port != null ? ':' + String(o.port) : ''}`);
      else if (typeof o.url === 'string') parts.push(o.url);
    }
  }
  return parts.join(' ').slice(0, 300) || '(no target)';
};

let installed: NetworkGuard | null = null;

/** Install once per process; later calls return the same guard. */
export function installNetworkGuard(): NetworkGuard {
  if (installed) return installed;
  const attempts: NetworkAttempt[] = [];
  const primitives: string[] = [];
  let probing = false;
  let probeHits = 0;
  const record = (kind: string, target: unknown) => {
    if (probing) { probeHits++; return; }
    attempts.push({ kind, target: String(target).slice(0, 300) });
  };
  const blocker = (kind: string) => function blocked(this: unknown, ...args: unknown[]): never {
    const target = describe(args);
    record(kind, target);
    throw new OfflineError(`${kind} ${target}`);
  };
  const rejecter = (kind: string) => function blocked(this: unknown, ...args: unknown[]): Promise<never> {
    const target = describe(args);
    record(kind, target);
    return Promise.reject(new OfflineError(`${kind} ${target}`));
  };
  const patch = (obj: any, key: string, kind: string, fn: (kind: string) => unknown = blocker) => {
    if (!obj || typeof obj[key] !== 'function') return;
    try {
      Object.defineProperty(obj, key, { value: fn(kind), writable: true, configurable: true, enumerable: true });
      primitives.push(kind);
    } catch { /* a frozen builtin would show up as a failed self-test */ }
  };

  const net = require('node:net'), tls = require('node:tls'), http = require('node:http'), https = require('node:https');
  const http2 = require('node:http2'), dns = require('node:dns'), dgram = require('node:dgram');

  patch(net.Socket.prototype, 'connect', 'net.Socket.connect');
  patch(net, 'connect', 'net.connect');
  patch(net, 'createConnection', 'net.createConnection');
  patch(net.Server.prototype, 'listen', 'net.Server.listen');
  patch(tls, 'connect', 'tls.connect');
  for (const [mod, name] of [[http, 'http'], [https, 'https']] as const) {
    patch(mod, 'request', `${name}.request`);
    patch(mod, 'get', `${name}.get`);
  }
  patch(http2, 'connect', 'http2.connect');
  const DNS_FN = /^(lookup|lookupService|reverse|resolve\w*)$/;
  for (const k of Object.keys(dns)) if (DNS_FN.test(k)) patch(dns, k, `dns.${k}`);
  for (const k of Object.keys(dns.promises ?? {})) if (DNS_FN.test(k)) patch(dns.promises, k, `dns.promises.${k}`, rejecter);
  for (const [proto, name, how] of [[dns.Resolver?.prototype, 'dns.Resolver', blocker], [dns.promises?.Resolver?.prototype, 'dns.promises.Resolver', rejecter]] as const)
    for (const k of proto ? Object.getOwnPropertyNames(proto) : []) if (DNS_FN.test(k)) patch(proto, k, `${name}.${k}`, how);
  patch(dgram, 'createSocket', 'dgram.createSocket');
  for (const k of ['bind', 'connect', 'send']) patch(dgram.Socket.prototype, k, `dgram.Socket.${k}`);
  syncBuiltinESMExports();

  // Globals. The browser shim replaces fetch/WebSocket again later with the sim's router (local files, in-process
  // mock, or record-and-throw); these are what anything running before or outside the shim sees.
  const g = globalThis as any;
  const nativeFetch: ((...a: unknown[]) => Promise<unknown>) | undefined = typeof g.fetch === 'function' ? g.fetch.bind(g) : undefined;
  const NativeWebSocket = g.WebSocket;
  Object.defineProperty(g, 'fetch', { value: rejecter('globalThis.fetch'), writable: true, configurable: true, enumerable: true });
  primitives.push('globalThis.fetch');
  const guardClasses: Record<string, new (...args: unknown[]) => unknown> = {};
  for (const name of ['WebSocket', 'EventSource']) {
    const kind = `globalThis.${name}`;
    const block = blocker(kind);
    guardClasses[name] = class { constructor(...args: unknown[]) { block(...args); } };
    Object.defineProperty(g, name, { value: guardClasses[name], writable: true, configurable: true, enumerable: true });
    primitives.push(kind);
  }

  /** Reserved addresses only (TEST-NET-1, the .invalid TLD): nothing real is contacted even if a probe got through. */
  const selfTest = async (): Promise<SelfTestResult> => {
    const probes: SelfTestProbe[] = [];
    const settle = (name: string, run: () => unknown) => new Promise<void>((done) => {
      let finished = false;
      const finish = (blocked: boolean, detail: string) => { if (finished) return; finished = true; clearTimer(timer); probes.push({ name, blocked, detail: detail.slice(0, 200) }); done(); };
      // Real timers: the page's virtual clock may already be installed over the globals.
      const { setTimeout: realSetTimeout, clearTimeout: clearTimer } = require('node:timers');
      const timer = realSetTimeout(() => finish(false, 'no refusal within 3 s: the call was not blocked'), 3000);
      const before = probeHits;
      const judge = (e: unknown) => {
        let err: any = e;
        for (let i = 0; i < 4 && err && err.code !== GUARD_ERROR && err.cause; i++) err = err.cause;
        // Some clients (the built-in fetch) drop the cause; a guard hit during this probe is the same evidence.
        finish(err?.code === GUARD_ERROR || probeHits > before, String(err?.message ?? e));
      };
      try {
        const out: any = run();
        if (out && typeof out.then === 'function') out.then(() => finish(false, 'the call resolved'), judge);
        else if (out && typeof out.on === 'function') {
          out.on('error', judge);
          out.on('connect', () => { try { out.destroy?.(); } catch { /* closing */ } finish(false, 'a connection was opened'); });
          if (probeHits > before) finish(true, 'refused by the guard (reported on the object)');
        } else finish(false, 'the call returned without refusing');
      } catch (e) { judge(e); }
    });
    const HOST = '192.0.2.1', NAME = 'offline-guard-self-test.invalid';
    probing = true;
    try {
      await settle('net.connect', () => require('node:net').connect(9, HOST));
      await settle('net.createConnection', () => require('node:net').createConnection({ host: HOST, port: 9 }));
      await settle('new net.Socket().connect', () => new (require('node:net').Socket)().connect(9, HOST));
      await settle('net.createServer().listen', () => require('node:net').createServer().listen(0, '127.0.0.1'));
      await settle('tls.connect', () => require('node:tls').connect(443, HOST));
      await settle('http.request', () => require('node:http').request(`http://${HOST}:9/`));
      await settle('http.get', () => require('node:http').get(`http://${HOST}:9/`));
      await settle('https.request', () => require('node:https').request(`https://${HOST}/`));
      await settle('https.get', () => require('node:https').get(`https://${HOST}/`));
      await settle('http2.connect', () => require('node:http2').connect(`https://${HOST}`));
      await settle('dns.lookup', () => require('node:dns').lookup(NAME, () => undefined));
      await settle('dns.resolve4', () => require('node:dns').resolve4(NAME, () => undefined));
      await settle('dns.promises.lookup', () => require('node:dns').promises.lookup(NAME));
      await settle('dns.promises.resolve', () => require('node:dns').promises.resolve(NAME));
      await settle('new dns.Resolver().resolve4', () => new (require('node:dns').Resolver)().resolve4(NAME, () => undefined));
      await settle('dgram.createSocket', () => require('node:dgram').createSocket('udp4'));
      await settle('dgram.Socket.send', () => require('node:dgram').Socket.prototype.send.call({}, Buffer.from('x'), 9, HOST));
      await settle('globalThis.fetch (guard)', () => rejecter('globalThis.fetch')(`http://${HOST}/`));
      if (nativeFetch) await settle('Node built-in fetch (original function)', () => nativeFetch(`http://${HOST}/`));
      if (typeof NativeWebSocket === 'function') await settle('Node built-in WebSocket (original class)', () => new Promise((_, reject) => {
        const ws = new NativeWebSocket(`ws://${HOST}/`);
        ws.addEventListener('open', () => { try { ws.close(); } catch { /* closing */ } _(undefined); });
        // The built-in client reports a refused connect as an `error` event without the cause; a guard hit during the
        // probe is the evidence that it was our refusal.
        const before = probeHits;
        ws.addEventListener('error', () => reject(probeHits > before ? new OfflineError('WebSocket connect') : new Error('WebSocket error that did not come from the guard')));
      }));
      await settle('globalThis.WebSocket (guard)', () => new guardClasses.WebSocket(`ws://${HOST}/`));
      await settle('globalThis.EventSource (guard)', () => new guardClasses.EventSource(`http://${HOST}/`));
    } finally { probing = false; }
    const result = { ok: probes.every((p) => p.blocked), probes };
    guard.lastSelfTest = result;
    return result;
  };

  const guard: NetworkGuard = { attempts, primitives, record, selfTest, lastSelfTest: null };
  installed = guard;
  return guard;
}

/** The guard of this process, or null when none was installed. */
export function networkGuard(): NetworkGuard | null { return installed; }

export interface OfflineConfig {
  /** Origin the page is "loaded" from. Must be a loopback origin: it is only a name for files under mirror/. */
  pageOrigin: string;
  /** Who answers the game's API calls: the literal `in-process-mock`, or a URL (which is refused unless loopback). */
  apiTarget: string;
  mirrorDir: string;
  env?: Record<string, string | undefined>;
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i;

/** Reasons this configuration is not offline. Empty when it is. */
export function offlineConfigProblems(cfg: OfflineConfig): string[] {
  const out: string[] = [];
  const hostOf = (s: string): string | null => { try { return new URL(s).hostname; } catch { return null; } };
  const pageHost = hostOf(cfg.pageOrigin);
  if (!pageHost || !LOOPBACK.test(pageHost)) out.push(`the page origin "${cfg.pageOrigin}" is not a loopback origin`);
  if (cfg.apiTarget !== 'in-process-mock') {
    const apiHost = hostOf(cfg.apiTarget);
    out.push(apiHost && LOOPBACK.test(apiHost)
      ? `the API target "${cfg.apiTarget}" is a local server; the environment only talks to the in-process mock`
      : `the API target "${cfg.apiTarget}" names a remote game endpoint`);
  }
  if (!existsSync(join(cfg.mirrorDir, 'index.html'))) out.push(`no local game copy at "${cfg.mirrorDir}" (index.html missing)`);
  return out;
}

/** Throws with every problem listed when the configuration is not offline. */
export function assertOfflineConfig(cfg: OfflineConfig): void {
  const problems = offlineConfigProblems(cfg);
  if (problems.length) throw new Error(`[offline guard] refusing to start: ${problems.join('; ')}`);
}
