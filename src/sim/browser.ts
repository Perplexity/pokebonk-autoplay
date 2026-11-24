import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { PropertySymbol } from 'happy-dom';
import { VirtualClock } from './clock.ts';
import { createNullGL } from './gl.ts';
import { NullContext2D, PIXELS } from './canvas2d.ts';
import { decodePng, imageSize, isPng } from './png.ts';
import type { Pixels } from './png.ts';
import { Net, ORIGIN, PAGE_URL } from './net.ts';

/**
 * Everything the bundle expects from a browser, installed on Node's global object.
 *
 * The DOM itself (document, elements, events, localStorage, matchMedia, MutationObserver…) is happy-dom, registered
 * globally. On top of it this file adds what a DOM library does not have or must not do in the sim:
 *
 *   clock       performance/Date/timers/rAF           → VirtualClock (clock.ts)
 *   network     fetch, WebSocket, RTC, XHR…           → Net (net.ts): files, mock API, or record-and-throw
 *   canvas      getContext('webgl2'|'2d')             → null GL (gl.ts) / pixel-backed 2D (canvas2d.ts)
 *   images      <img>.src / new Image()               → size and pixels read from the mirror, load/error events on the virtual clock
 *   audio       AudioContext, <audio>                 → inert objects
 *   stylesheets <link rel=stylesheet>                 → never fetched or parsed; `load` fires on the virtual clock
 *   misc        Worker, pointer lock, focus/visibility, gamepads, web locks, user activation
 *
 * Each block below says what it replaces and whether the game logic can see a difference.
 */

export const VIEWPORT = { width: 1280, height: 720 };
/** Sprite sheets of Pokémon (animated, form, shiny, and the single-frame fallback): see the image loader below. */
const SPRITE_SHEET = /\/assets\/(?:pmd|pmd-forms|pmd-shiny|front)\/[^/]+\.png(?:\?|$)/;
const USER_AGENT ='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

export interface ImageStats { loaded: number; failed: number; decoded: number; decodeFailed: string[]; missing: Set<string> }

export interface Browser {
  clock: VirtualClock;
  net: Net;
  images: ImageStats;
  /** Messages the page wrote with console.warn/error, and uncaught errors from event handlers. */
  problems: string[];
  /** Errors the game caught and logged itself (its "pb-errs" log), in order of first appearance. */
  gameErrors: string[];
  /** Things the page asked for that the sim does not do (reloads, navigation…). */
  ignored: string[];
}

/** An inert stand-in for Web Audio nodes/params: any method is a no-op, any property is another inert object. */
function audioHole(extra: Record<string, unknown> = {}): any {
  const store: Record<string | symbol, unknown> = { value: 0, ...extra };
  return new Proxy(store, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined;
      if (/^on[a-z]+$/.test(prop)) return null;
      if (prop === 'connect') return (t[prop] = (dest: unknown) => dest);
      if (/^(start|stop|disconnect|close|resume|suspend|set[A-Z]|get[A-Z]|cancel[A-Z]|linearRamp|exponentialRamp|addEventListener|removeEventListener|dispatchEvent)/.test(prop))
        return (t[prop] = () => undefined);
      return (t[prop] = audioHole());
    },
    set(t, prop, v) { t[prop] = v; return true; },
  });
}

export function installBrowser(opt: { net: Net; clock: VirtualClock; quietConsole?: boolean }): Browser {
  const { net, clock } = opt;
  const g = globalThis as any;
  const out: Browser = { clock, net, images: { loaded: 0, failed: 0, decoded: 0, decodeFailed: [], missing: new Set() }, problems: [], gameErrors: [], ignored: [] };

  // Node's own implementations of the platform classes we want to keep (the DOM library would replace them with
  // versions wired to its own network stack).
  const native = {
    URL: g.URL, URLSearchParams: g.URLSearchParams, Blob: g.Blob, TextEncoder: g.TextEncoder, TextDecoder: g.TextDecoder,
    Response: g.Response, Request: g.Request, Headers: g.Headers, FormData: g.FormData,
    ReadableStream: g.ReadableStream, WritableStream: g.WritableStream, TransformStream: g.TransformStream,
    CompressionStream: g.CompressionStream, DecompressionStream: g.DecompressionStream,
    crypto: g.crypto, structuredClone: g.structuredClone, queueMicrotask: g.queueMicrotask, console: g.console,
  };

  // ---- console: keep the terminal readable, keep the evidence (installed first so the DOM library logs here too) ----
  const note = (level: string) => (...a: unknown[]) => {
    const line = `[page ${level}] ` + a.map((x) => (x instanceof Error ? (x.stack ?? x.message) : typeof x === 'string' ? x : safeJson(x))).join(' ');
    out.problems.push(line.slice(0, 2000));
    if (!opt.quietConsole) process.stderr.write(line.slice(0, 600) + '\n');
  };
  const pageConsole = { ...native.console, log: () => undefined, info: () => undefined, debug: () => undefined, warn: note('warn'), error: note('error') };
  g.console = pageConsole;

  // ---- DOM: happy-dom. No script evaluation, no file loading of any kind (it would use real sockets). ----
  GlobalRegistrator.register({
    url: PAGE_URL,
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    settings: {
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
      disableComputedStyleRendering: true,
      navigator: { userAgent: USER_AGENT, maxTouchPoints: 0 },
      device: { prefersColorScheme: 'light', prefersReducedMotion: 'no-preference', mediaType: 'screen', forcedColors: 'none' },
      navigation: { disableMainFrameNavigation: true, disableChildFrameNavigation: true, disableChildPageNavigation: true, disableFallbackToSetURL: true } as any,
    } as any,
  });
  const def = (k: string, v: unknown, target: any = g) => Object.defineProperty(target, k, { value: v, writable: true, configurable: true, enumerable: true });
  for (const [k, v] of Object.entries(native)) if (v !== undefined) def(k, v);
  def('console', pageConsole);
  g.addEventListener('error', (e: any) => { out.problems.push('[page uncaught] ' + String(e?.error?.stack ?? e?.message ?? e)); });
  g.addEventListener('unhandledrejection', (e: any) => { out.problems.push('[page unhandledrejection] ' + String(e?.reason?.stack ?? e?.reason)); });
  def('window', g); def('self', g); def('top', g); def('parent', g);

  // A rejected promise nobody handles is a console message in a browser, not the end of the process (the DOM
  // library rejects `animation.finished` whenever the game cancels a Web Animation, for one).
  process.on('unhandledRejection', (reason) => {
    const line = '[page unhandledrejection] ' + String((reason as Error)?.stack ?? reason).slice(0, 600);
    if (!out.problems.includes(line)) out.problems.push(line);
  });

  // happy-dom keeps its own window object behind the globals, with timers bound to Node's real ones; its Web
  // Animations (`el.animate()` → finish/onfinish) and smooth scrolling run on those. Point them at the virtual clock
  // too, or a 300 ms animation would end 300 ms of WALL time later: hundreds of simulation steps away, at a step
  // that depends on how fast the machine happens to be.
  const innerWindow = g.document[PropertySymbol.window];
  if (!innerWindow || innerWindow === g) throw new Error('[sim] could not reach the DOM library\'s window object to redirect its timers');
  for (const [k, v] of Object.entries({
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: clock.setInterval, clearInterval: clock.clearTimeout,
    requestAnimationFrame: clock.requestAnimationFrame, cancelAnimationFrame: clock.cancelAnimationFrame,
  })) Object.defineProperty(innerWindow, k, { value: v, writable: true, configurable: true });

  // ---- network ----
  def('fetch', net.fetch);
  def('WebSocket', net.blockedClass('WebSocket'));
  def('RTCPeerConnection', net.blockedClass('RTCPeerConnection'));
  def('XMLHttpRequest', net.blockedClass('XMLHttpRequest'));
  def('EventSource', net.blockedClass('EventSource'));
  def('BroadcastChannel', class { postMessage() {} close() {} addEventListener() {} removeEventListener() {} });

  // ---- blob URLs: remembered in-process so the fake Image can size them without any async I/O ----
  const blobs = new Map<string, any>();
  class SimBlob extends native.Blob {
    parts: unknown[];
    constructor(parts: unknown[] = [], o?: any) { super(parts as any, o); this.parts = parts; }
  }
  def('Blob', SimBlob);
  let blobN = 0;
  native.URL.createObjectURL = (b: any) => { const u = `blob:${ORIGIN}/sim-${++blobN}`; blobs.set(u, b); return u; };
  native.URL.revokeObjectURL = (u: string) => { blobs.delete(u); };
  const blobBytes = (u: string): Uint8Array | null => {
    const p = blobs.get(u)?.parts?.[0];
    if (p instanceof Uint8Array) return p;
    if (p instanceof ArrayBuffer) return new Uint8Array(p);
    if (ArrayBuffer.isView(p)) return new Uint8Array(p.buffer, p.byteOffset, p.byteLength);
    return null;
  };

  // ---- page state: a visible, focused desktop tab that the user has clicked in ----
  const doc = g.document;
  const getter = (o: any, k: string, get: () => unknown) => Object.defineProperty(o, k, { get, configurable: true });
  getter(doc, 'hidden', () => false);
  getter(doc, 'visibilityState', () => 'visible');
  doc.hasFocus = () => true;
  getter(doc, 'fonts', () => fonts);
  const fonts = { ready: Promise.resolve(), status: 'loaded', load: async () => [], check: () => true, addEventListener() {}, removeEventListener() {}, forEach() {}, add() {}, size: 0 };
  def('devicePixelRatio', 1);
  const nav = g.navigator;
  const navDef = (k: string, v: unknown) => Object.defineProperty(nav, k, { get: () => v, configurable: true });
  navDef('webdriver', false);
  navDef('onLine', true);
  navDef('language', 'en-US');
  navDef('languages', ['en-US', 'en']);
  navDef('platform', 'Win32');
  navDef('hardwareConcurrency', 8);
  navDef('deviceMemory', 8);
  navDef('maxTouchPoints', 0);
  navDef('userActivation', { isActive: true, hasBeenActive: true });
  navDef('getGamepads', () => []); // no controller: the game's pad polling sees an empty list
  // Web Locks: the game holds one named lock per live run so other tabs can tell. One tab here: grant at once.
  navDef('locks', { request: async (_name: string, a: any, b?: any) => (typeof a === 'function' ? a : b)({ name: _name, mode: 'exclusive' }), query: async () => ({ held: [], pending: [] }) });
  navDef('clipboard', { writeText: async () => undefined, readText: async () => '' });
  navDef('sendBeacon', (url: unknown) => { try { net.block('sendBeacon', url); } catch { /* recorded */ } return false; });

  // location.reload()/replace()/assign(): the page asking for a reload is recorded, never performed.
  for (const k of ['reload', 'replace', 'assign'])
    try { Object.defineProperty(g.location, k, { value: (u?: unknown) => { out.ignored.push(`location.${k}(${u ?? ''})`); }, configurable: true }); } catch { /* read-only in this DOM */ }

  // ---- Worker: the only one in the bundle is a 50 ms ticker that keeps co-op runs alive in hidden tabs. Never ticks here. ----
  def('Worker', class { onmessage: unknown = null; onerror: unknown = null; postMessage() {} terminate() {} addEventListener() {} removeEventListener() {} });

  // ---- canvas ----
  const Canvas = g.HTMLCanvasElement.prototype;
  const ctxKey = Symbol('pb.sim.ctx');
  Canvas.getContext = function (this: any, type: string, attrs?: Record<string, unknown>) {
    const have = this[ctxKey];
    if (have) return have.type === type || (have.type === 'webgl2' && type === 'webgl') ? have.ctx : null;
    let ctx: unknown = null;
    if (type === 'webgl2') ctx = createNullGL(this, attrs);
    else if (type === '2d') ctx = new NullContext2D(this);
    else return null; // 'webgl' (v1), 'bitmaprenderer', 'webgpu': not offered
    this[ctxKey] = { type, ctx };
    return ctx;
  };
  Canvas[PIXELS] = function (this: any): Pixels | null { const c = this[ctxKey]; return c?.type === '2d' ? c.ctx[PIXELS]() : null; };
  Canvas.toDataURL = () => 'data:image/png;base64,';
  Canvas.toBlob = function (cb: (b: unknown) => void) { clock.setTimeout(() => cb(new SimBlob([], { type: 'image/png' })), 0); };
  // Pointer lock is granted at once (the "user" never presses Escape); the change event arrives on the virtual clock.
  let lockEl: unknown = null;
  getter(doc, 'pointerLockElement', () => lockEl);
  const lockChange = () => clock.setTimeout(() => doc.dispatchEvent(new g.Event('pointerlockchange')), 0);
  g.HTMLElement.prototype.requestPointerLock = function (this: unknown) { lockEl = this; lockChange(); return Promise.resolve(); };
  doc.exitPointerLock = () => { if (lockEl) { lockEl = null; lockChange(); } };
  getter(doc, 'fullscreenElement', () => null);
  g.HTMLElement.prototype.requestFullscreen = async () => undefined;
  doc.exitFullscreen = async () => undefined;
  if (!g.HTMLElement.prototype.scrollIntoView) g.HTMLElement.prototype.scrollIntoView = () => undefined;

  // ---- images: `img.src = url` reads the file from the mirror; size from the header, pixels decoded on first use ----
  const Img = g.HTMLImageElement.prototype;
  const st = Symbol('pb.sim.img');
  const srcDesc = Object.getOwnPropertyDescriptor(Img, 'src')!;
  const load = (img: any, url: string) => {
    const state: any = (img[st] = { url, bytes: null as Uint8Array | null, size: null, pixels: undefined, done: false });
    let abs = url;
    try { abs = new native.URL(url, PAGE_URL).href; } catch { /* stays as written */ }
    if (abs.startsWith('blob:')) state.bytes = blobBytes(abs);
    else if (abs.startsWith('data:')) { const m = /^data:[^,]*;base64,(.*)$/s.exec(abs); state.bytes = m ? Buffer.from(m[1], 'base64') : null; }
    else if (abs.startsWith(ORIGIN + '/')) { state.bytes = net.readLocal(abs); if (!state.bytes) out.images.missing.add(new native.URL(abs).pathname); }
    else { try { net.block('img', abs); } catch { /* recorded */ } }
    state.size = state.bytes ? imageSize(state.bytes) : null;
    // Sprite sheets are delivered at once, inside the assignment, when a handler is already attached.
    //
    // The game's sheet loader keeps a process-wide cache (url → promise of the image) behind a four-at-a-time queue.
    // A sheet met for the first time in a process would arrive a clock tick later (and behind the queue), a cached
    // one within the same step, and the game spawns and sizes a Pokémon from its sheet: the same episode then ran
    // differently in a fresh process and in one that had already played. Delivering the load synchronously makes a
    // first load indistinguishable from a cached one (the loader's promise is resolved before it is returned, its
    // continuation runs as a microtask either way), so every episode sees the browser's warm-cache behaviour.
    if (state.size && typeof img.onload === 'function' && SPRITE_SHEET.test(abs)) {
      state.done = true;
      out.images.loaded++;
      img.dispatchEvent(new g.Event('load'));
      return;
    }
    // Everything else: the event is delivered by the virtual clock, asynchronous like a real load, but at a reproducible time.
    clock.setTimeout(() => {
      if (img[st] !== state) return; // src changed meanwhile
      state.done = true;
      if (state.size) out.images.loaded++; else out.images.failed++;
      img.dispatchEvent(new g.Event(state.size ? 'load' : 'error'));
    }, 0);
  };
  Object.defineProperty(Img, 'src', {
    configurable: true,
    get(this: any) { return srcDesc.get!.call(this); },
    set(this: any, v: string) { srcDesc.set!.call(this, v); load(this, String(v)); },
  });
  getter(Img, 'naturalWidth', function (this: any) { const s = this[st]; return s?.done && s.size ? s.size.width : 0; } as any);
  getter(Img, 'naturalHeight', function (this: any) { const s = this[st]; return s?.done && s.size ? s.size.height : 0; } as any);
  getter(Img, 'complete', function (this: any) { const s = this[st]; return !s || s.done; } as any);
  getter(Img, 'currentSrc', function (this: any) { return this.src; } as any);
  for (const dim of ['width', 'height'] as const) {
    const d = Object.getOwnPropertyDescriptor(Img, dim)!;
    Object.defineProperty(Img, dim, {
      configurable: true,
      get(this: any) { const a = Number(this.getAttribute(dim)); if (a > 0) return a; const s = this[st]; return s?.done && s.size ? s.size[dim] : 0; },
      set(this: any, v: number) { d.set ? d.set.call(this, v) : this.setAttribute(dim, String(v)); },
    });
  }
  Img.decode = function (this: any) { const s = this[st]; return s?.size ? Promise.resolve() : Promise.reject(new g.DOMException('The source image cannot be decoded.', 'EncodingError')); };
  // Decoded pixels are big (a sprite sheet is several MB of RGBA) and only needed for a moment (the game measures a
  // sheet with three consecutive drawImage calls), so only the few most recent decodes are kept.
  const recent = new Map<object, Pixels>();
  Img[PIXELS] = function (this: any): Pixels | null {
    const s = this[st];
    if (!s?.bytes || !s.done || s.undecodable) return null;
    let px = recent.get(s) ?? null;
    if (!px) {
      if (!isPng(s.bytes)) { s.undecodable = true; out.images.decodeFailed.push(`${s.url}: not a PNG (no decoder in the sim)`); return null; }
      try { px = decodePng(s.bytes); out.images.decoded++; } catch (e) { s.undecodable = true; out.images.decodeFailed.push(`${s.url}: ${(e as Error).message}`); return null; }
      recent.set(s, px);
      if (recent.size > 4) recent.delete(recent.keys().next().value!);
    }
    return px;
  };
  // Not offered: three.js then loads textures through <img>, which the block above handles.
  def('createImageBitmap', undefined);
  def('OffscreenCanvas', undefined);

  // ---- stylesheets: happy-dom reports `load` synchronously while the <link> is being inserted, before the page's
  // preload helper has attached its listener. Report it (again) on the next clock tick to whoever listens. ----
  const Link = g.HTMLLinkElement.prototype;
  const linkAdd = Link.addEventListener;
  const told = new WeakSet<object>();
  Link.addEventListener = function (this: any, type: string, ...rest: any[]) {
    linkAdd.call(this, type, ...rest);
    if (type === 'load' && this.rel === 'stylesheet' && !told.has(this)) {
      told.add(this);
      clock.setTimeout(() => this.dispatchEvent(new g.Event('load')), 0);
    }
  };

  // ---- audio: inert, and SUSPENDED ----
  // The context reports the state a browser tab has before its first user gesture and never leaves it. The game
  // then starts no sound voice at all. That matters beyond silence: its sound code draws from Math.random (noise
  // offsets, pitch) only when a voice actually starts, and whether one starts depends on its voice limiter, i.e. on
  // what was played earlier in the process. With a running context an episode's random stream would depend on the
  // episodes before it.
  class NullAudioContext {
    state = 'suspended'; sampleRate = 48000; baseLatency = 0; outputLatency = 0; onstatechange: unknown = null;
    destination = audioHole({ maxChannelCount: 2 }); listener = audioHole();
    // The clock RUNS although the context is suspended (Chrome reports 0 until the context is resumed). Deliberate: the game
    // rate-limits each move's sound with this clock, in a table that lives as long as the process, and draws the sound's
    // pitch from Math.random when the limiter lets it through. With a clock that stands still only the first sound of each
    // kind IN A PROCESS would draw, and an episode would depend on the episodes before it (measured: 27 draws apart at
    // step 27). With a running clock every sound draws, in every episode alike. Known difference from a browser tab
    // nobody has clicked: docs/fidelity.md D3. It shifts which random numbers follow, not a rule.
    get currentTime() { return clock.now / 1000; }
    createBuffer(channels: number, length: number, sampleRate: number) {
      const data = Array.from({ length: Math.max(1, channels) }, () => new Float32Array(Math.max(1, length)));
      return { numberOfChannels: data.length, length, sampleRate, duration: length / sampleRate, getChannelData: (i: number) => data[i] ?? data[0], copyToChannel() {}, copyFromChannel() {} };
    }
    /** No decoder: every sound is one second of silence. */
    decodeAudioData(_bytes: ArrayBuffer, ok?: (b: unknown) => void) { const b = this.createBuffer(1, this.sampleRate, this.sampleRate); ok?.(b); return Promise.resolve(b); }
    resume() { return Promise.resolve(); }
    suspend() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    addEventListener() {} removeEventListener() {}
    getOutputTimestamp() { return { contextTime: clock.now / 1000, performanceTime: clock.now }; }
  }
  // createGain(), createOscillator(), createBufferSource()… every factory returns an inert node.
  const audioProto = new Proxy(NullAudioContext.prototype, {
    get(t: any, prop, recv) {
      if (prop in t || typeof prop === 'symbol') return Reflect.get(t, prop, recv);
      if (/^create[A-Z]/.test(prop)) return () => audioHole();
      return undefined;
    },
  });
  const AudioCtx = function (this: any) { return Object.setPrototypeOf(new NullAudioContext(), audioProto); } as any;
  def('AudioContext', AudioCtx);
  def('webkitAudioContext', AudioCtx);
  const Media = g.HTMLMediaElement?.prototype;
  if (Media) { Media.play = () => Promise.resolve(); Media.pause = () => undefined; Media.load = () => undefined; Media.canPlayType = () => 'probably'; }

  // ---- the game's own error log: it swallows errors in many places and keeps the last few under localStorage
  // "pb-errs". Reading every write of that key gives the full list without touching game code. ----
  const setItem = g.Storage.prototype.setItem;
  g.Storage.prototype.setItem = function (this: unknown, k: string, v: string) {
    if (k === 'pb-errs') { try { for (const l of JSON.parse(v).l ?? []) if (!out.gameErrors.includes(l)) out.gameErrors.push(l); } catch { /* not ours to fix */ } }
    return setItem.call(this, k, v);
  };

  clock.onError = (where, e) => { out.problems.push(`[page ${where} error] ${(e as Error)?.stack ?? e}`); if (!opt.quietConsole) process.stderr.write(`[page ${where} error] ${(e as Error)?.stack ?? e}\n`); };
  clock.install(g);
  return out;
}

function safeJson(x: unknown): string { try { return JSON.stringify(x) ?? String(x); } catch { return String(x); } }
