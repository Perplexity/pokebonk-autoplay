import type { Cdp } from '../cdp/client.ts';
import { logger } from '../logger.ts';
import { extractSnapshot } from './extract.ts';
import { readUi } from './ui.ts';
import type { Snapshot, UiState } from './snapshot.ts';

const log = logger('perception');

/**
 * Find the game's live run object and return a handle to it (a CDP remote object id), or null when no run is active.
 *
 * The game keeps the run in a module-scoped object, so there is no global to read. The debugger can enumerate heap
 * objects by prototype (`Runtime.queryObjects`); the run is the object that looks like one: a player with a position
 * and hit points, an enemy pool, a clock and a state. Finished runs still in memory are skipped; of the rest the newest wins.
 * Nothing in the page is modified.
 */
export async function locateRun(cdp: Cdp): Promise<string | null> {
  const proto = await cdp.send('Runtime.evaluate', { expression: 'Object.prototype', objectGroup: 'pb-locate' });
  const all = await cdp.send('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId, objectGroup: 'pb-locate' }, 60_000);
  const found = await cdp.send('Runtime.callFunctionOn', {
    objectId: all.objects.objectId,
    objectGroup: 'pb-run',
    returnByValue: false,
    functionDeclaration: `function () {
      let best = null, bestScore = -1;
      for (const o of this) {
        try {
          if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
          const p = o.player;
          if (!p || typeof p !== 'object' || typeof o.state !== 'string' || typeof o.time !== 'number') continue;
          if (!p.pos || typeof p.pos.x !== 'number' || typeof p.hp !== 'number') continue;
          if (!o.enemies || !o.enemies.alive || typeof o.update !== 'function') continue;
          // A finished run stays in memory for a while (its result screen is up). It is never the one to play:
          // taking it would leave the bot watching a dead run while the next one starts without it.
          if (o.state === 'over') continue;
          const s = typeof o.bornAt === 'number' ? o.bornAt : 0;
          if (s > bestScore) { best = o; bestScore = s; }
        } catch (e) { /* exotic object: skip */ }
      }
      return best;
    }`,
  }, 60_000);
  await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'pb-locate' }).catch(() => {});
  if (found.exceptionDetails || !found.result?.objectId || found.result.subtype === 'null') return null;
  return found.result.objectId as string;
}

const EXTRACT_SRC = extractSnapshot.toString();
const UI_EXPR = `(${readUi.toString()})()`;

/** Reads the page: the DOM (`ui`) and, while a run is on, the run object (`snapshot`). */
export class Perception {
  private cdp: Cdp;
  private runId: string | null = null;
  private lastLocate = 0;
  /** How long the last snapshot took, for the log. */
  lastMs = 0;

  constructor(cdp: Cdp) { this.cdp = cdp; }

  async ui(): Promise<UiState> {
    return this.cdp.eval<UiState>(UI_EXPR);
  }

  /**
   * Faster runs (bot.speed > 1): set the game's own time scale. This is the only place the sandbox writes to the
   * game's state. The game's slow-motion moments (time scale below 1) are left alone.
   */
  async setTimeScale(v: number): Promise<void> {
    if (!this.runId) return;
    await this.cdp.send('Runtime.callFunctionOn', {
      objectId: this.runId, returnByValue: true, arguments: [{ value: v }],
      functionDeclaration: 'function (v) { if (this.state === "play" && this.timeScale >= 1 && this.timeScale !== v) this.timeScale = v; return this.timeScale; }',
    }, 3000).catch(() => {});
  }

  /** Forget the run handle (page reloaded, run over). The next snapshot looks for a new one. */
  async reset() {
    this.runId = null;
    await this.cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'pb-run' }).catch(() => {});
  }

  /** `route`: also plan a route to this point (A* over the height map) and return it as `nav`. */
  async snapshot(route?: { x: number; z: number } | null): Promise<Snapshot | null> {
    const t0 = performance.now();
    if (!this.runId) {
      // Looking through the heap costs a few hundred ms: not more than once a second.
      if (Date.now() - this.lastLocate < 1000) return null;
      this.lastLocate = Date.now();
      try { this.runId = await locateRun(this.cdp); } catch (e) { log.debug(`locate failed: ${(e as Error).message}`); return null; }
      if (!this.runId) return null;
      log.debug('run object located');
    }
    try {
      const r = await this.cdp.send('Runtime.callFunctionOn', { objectId: this.runId, returnByValue: true, functionDeclaration: EXTRACT_SRC, arguments: route ? [{ value: route.x }, { value: route.z }] : [] }, 5000);
      if (r.exceptionDetails) {
        log.warn('extract failed', r.exceptionDetails.exception?.description?.slice(0, 300));
        return null;
      }
      this.lastMs = performance.now() - t0;
      const snap = (r.result?.value ?? null) as Snapshot | null;
      // Once a run is over its handle is dropped, so the next run is looked for afresh.
      if (snap && snap.state === 'over') { this.runId = null; void this.cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'pb-run' }).catch(() => {}); }
      return snap;
    } catch (e) {
      // The handle dies with the page context (reload, crash recovery).
      log.debug(`snapshot failed: ${(e as Error).message}`);
      this.runId = null;
      return null;
    }
  }
}
