/**
 * Virtual clock. Replaces every source of wall time the game can see (`performance.now`, `Date`, `setTimeout`,
 * `setInterval`, `requestAnimationFrame`, `requestIdleCallback`) with one counter that only moves when the driver
 * calls `advance()`. Nothing here sleeps: a 600 s run takes as long as the CPU needs to compute it.
 *
 * Node's own timers stay untouched under `real` (the driver uses `real.setImmediate` to let promise chains and
 * genuinely asynchronous Node work, such as zlib behind CompressionStream, complete between steps).
 */

type Fn = (...args: any[]) => void;
interface Timer { id: number; at: number; seq: number; fn: Fn; args: any[]; every: number }

export const real = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  setImmediate: globalThis.setImmediate,
  Date: globalThis.Date,
  performanceNow: globalThis.performance.now.bind(globalThis.performance),
};

export class VirtualClock {
  /** Virtual milliseconds since the page "loaded". */
  now = 0;
  /** Fixed wall-clock origin, so `Date.now()` is reproducible too. */
  readonly epoch: number;
  private timers = new Map<number, Timer>();
  private rafs = new Map<number, Fn>();
  private nextId = 1;
  private seq = 0;
  /** Errors thrown by timer callbacks (a browser would report them and carry on; so do we, but we keep them). */
  errors: unknown[] = [];
  onError: (where: string, e: unknown) => void = () => {};

  constructor(epoch = Date.UTC(2026, 0, 15, 12, 0, 0)) { this.epoch = epoch; }

  setTimeout = (fn: Fn | string, ms = 0, ...args: any[]): number => this.add(fn, ms, args, 0);
  setInterval = (fn: Fn | string, ms = 0, ...args: any[]): number => this.add(fn, ms, args, Math.max(1, Number(ms) || 0));
  clearTimeout = (id?: number | null): void => { if (id != null) this.timers.delete(Number(id)); };
  requestAnimationFrame = (fn: Fn): number => { const id = this.nextId++; this.rafs.set(id, fn); return id; };
  cancelAnimationFrame = (id: number): void => { this.rafs.delete(id); };

  private add(fn: Fn | string, ms: number, args: any[], every: number): number {
    if (typeof fn !== 'function') return 0; // string timers are never used by the bundle
    const id = this.nextId++;
    const delay = Math.max(0, Number(ms) || 0);
    this.timers.set(id, { id, at: this.now + delay, seq: this.seq++, fn, args, every });
    return id;
  }

  pendingTimers(): number { return this.timers.size; }
  pendingFrames(): number { return this.rafs.size; }

  /** Earliest pending timer, or null. */
  private due(limit: number): Timer | null {
    let best: Timer | null = null;
    for (const t of this.timers.values())
      if (t.at <= limit && (!best || t.at < best.at || (t.at === best.at && t.seq < best.seq))) best = t;
    return best;
  }

  /** Run every timer that is due at the current time (does not move the clock). */
  flush(): number { return this.runUntil(this.now); }

  /** Move the clock forward by `ms`, running timers in order at their own due time. */
  advance(ms: number): number {
    const end = this.now + ms;
    const n = this.runUntil(end);
    this.now = end;
    return n;
  }

  private runUntil(end: number): number {
    let n = 0;
    for (let t = this.due(end); t; t = this.due(end)) {
      if (t.at > this.now) this.now = t.at;
      if (t.every > 0) { t.at = this.now + t.every; t.seq = this.seq++; } else this.timers.delete(t.id);
      try { t.fn(...t.args); } catch (e) { this.errors.push(e); this.onError('timer', e); }
      if (++n > 1_000_000) throw new Error('virtual clock: timer storm');
    }
    return n;
  }

  /** Call the pending requestAnimationFrame callbacks once, the way a browser does per display frame. */
  frame(): number {
    const cbs = [...this.rafs.values()];
    this.rafs.clear();
    for (const fn of cbs) { try { fn(this.now); } catch (e) { this.errors.push(e); this.onError('raf', e); } }
    return cbs.length;
  }

  /** Install the clock over the globals. Call after the DOM shim (which defines its own timers) is registered. */
  install(g: any = globalThis): void {
    const clock = this;
    const RealDate = real.Date;
    // `new Date()` and `Date.now()` read the virtual clock; every other form behaves as usual.
    class VDate extends RealDate {
      constructor(...a: any[]) { if (a.length === 0) super(clock.epoch + clock.now); else super(...(a as [any])); }
      static now(): number { return clock.epoch + Math.floor(clock.now); }
    }
    const def = (k: string, v: unknown) => Object.defineProperty(g, k, { value: v, writable: true, configurable: true, enumerable: true });
    def('Date', VDate);
    def('setTimeout', this.setTimeout);
    def('setInterval', this.setInterval);
    def('clearTimeout', this.clearTimeout);
    def('clearInterval', this.clearTimeout);
    def('requestAnimationFrame', this.requestAnimationFrame);
    def('cancelAnimationFrame', this.cancelAnimationFrame);
    def('requestIdleCallback', (fn: Fn) => this.setTimeout(() => fn({ didTimeout: false, timeRemaining: () => 50 }), 1));
    def('cancelIdleCallback', this.clearTimeout);
    // A plain object instead of Node's Performance: the game only needs now(); the rest are inert.
    def('performance', {
      now: () => clock.now,
      timeOrigin: clock.epoch,
      mark: () => undefined, measure: () => undefined, clearMarks: () => undefined, clearMeasures: () => undefined,
      getEntries: () => [], getEntriesByType: () => [], getEntriesByName: () => [],
      timing: {}, navigation: { type: 0 },
    });
  }
}
