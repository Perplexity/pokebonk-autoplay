import { createHash } from 'node:crypto';

/**
 * Seeded replacements for the page's entropy sources, so that two processes started with the same seed see the same
 * numbers in the same order:
 *
 *   Math.random              → sfc32 stream A   (the bundle calls it ~1,300 places, gameplay and effects alike)
 *   crypto.getRandomValues   → sfc32 stream B   (device id, run idempotency key, offline seed)
 *   crypto.randomUUID        → from stream B
 *   crypto.subtle.digest     → same hashes, computed synchronously (the native one finishes on a thread-pool
 *                              thread, i.e. at a wall-clock-dependent moment relative to the sim steps)
 *
 * The game's own seeded generators (fed from the run ticket's seed) are left alone.
 */

export function sfc32(seed: number): () => number {
  let a = 0x9e3779b9 ^ seed, b = 0x243f6a88 + seed, c = 0xb7e15162 ^ (seed * 2654435761), d = 1;
  const next = () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 16; i++) next();
  return next;
}

export interface SeededEntropy {
  mathCalls: () => number;
  cryptoCalls: () => number;
  /**
   * Restart both streams from a seed. `stream` selects an independent sequence of the same seed (the environment
   * uses 0 for building the run and one more per zone, see src/environment). The call counters restart with every
   * reseed: they count calls since the last one.
   */
  reseed: (seed: number, stream?: number) => void;
}

export function installSeededEntropy(seed: number, g: any = globalThis): SeededEntropy {
  let a = sfc32(seed >>> 0), b = sfc32((seed ^ 0x5bd1e995) >>> 0);
  let nMath = 0, nCrypto = 0;
  const reseed = (next: number, stream = 0) => {
    const s = (next + Math.imul(stream, 0x9e3779b1)) >>> 0;
    a = sfc32(s); b = sfc32((s ^ 0x5bd1e995) >>> 0);
    nMath = 0; nCrypto = 0;
  };
  Math.random = () => { nMath++; return a(); };

  const native = g.crypto;
  const getRandomValues = <T extends ArrayBufferView>(arr: T): T => {
    nCrypto++;
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (b() * 256) | 0;
    return arr;
  };
  const randomUUID = () => {
    const h = [...getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  const ALG: Record<string, string> = { 'SHA-1': 'sha1', 'SHA-256': 'sha256', 'SHA-384': 'sha384', 'SHA-512': 'sha512' };
  const digest = (alg: string | { name: string }, data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer> => {
    const name = ALG[String(typeof alg === 'string' ? alg : alg.name).toUpperCase()];
    if (!name) return native.subtle.digest(alg, data);
    const view = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    const out = createHash(name).update(view).digest();
    return Promise.resolve(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer);
  };
  const subtle = new Proxy(native.subtle, { get: (t, p) => (p === 'digest' ? digest : typeof t[p] === 'function' ? t[p].bind(t) : t[p]) });
  Object.defineProperty(g, 'crypto', { value: { getRandomValues, randomUUID, subtle }, writable: true, configurable: true, enumerable: true });
  return { mathCalls: () => nMath, cryptoCalls: () => nCrypto, reseed };
}
