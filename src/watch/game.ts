/**
 * The game process of the watch page: one run of the player at a chosen speed, reported to its parent
 * (scripts/watch.ts) over the process pipe. A game process may not open a socket, so the page is served by the parent.
 *
 * It plays as `playerPolicy` does (advise, peek, commit; choose, noteChoice). The speed and a pause change when a
 * decision is made on the wall clock, not what is decided: test/watch/game.test.ts plays a paced, paused run and an
 * unpaced one and compares them.
 * Messages to the parent: ready, frame, build, event, end. From the parent: speed, pause.
 */
import { createEnvironment } from '../environment/index.ts';
import type { StepResult } from '../environment/index.ts';
import { accountOptions } from '../player/plan.ts';
import { playerAdvisor } from '../player/policy.ts';
import { real } from '../sim/clock.ts';
import { buildOf, frameOf } from './frame.ts';

export interface WatchOptions { seed: number; species: number; map: string; tier: number; maxTime: number; speed: number; plan?: Record<string, unknown>; archive?: string; buildPlan?: string }

const send = (m: unknown): void => { process.send?.(m); };
// The environment replaces this process's `setTimeout` and `performance.now` with the game's simulated clock, which
// moves only when the game is stepped. Pacing and pausing are about wall time, so they use Node's own.
const sleep = (ms: number): Promise<void> => new Promise((r) => { real.setTimeout(r, ms); });
const wallNow = (): number => real.performanceNow();

const o = JSON.parse(process.argv[2] ?? '{}') as WatchOptions;
let speed = o.speed > 0 ? o.speed : 1, paused = false;
// The run clock is tied to the wall clock from an anchor that moves whenever the speed changes or the run is paused.
let anchorWall = 0, anchorGame = 0, reanchor = true;
process.on('message', (m: { type?: string; value?: number; on?: boolean }) => {
  if (m?.type === 'speed' && typeof m.value === 'number' && m.value > 0) { speed = Math.min(64, m.value); reanchor = true; }
  if (m?.type === 'pause') { paused = !!m.on; reanchor = true; }
});
process.on('disconnect', () => process.exit(0));

const env = createEnvironment({
  species: o.species, map: o.map, tier: o.tier, ranked: true, maxGameTime: o.maxTime,
  ...accountOptions(o.species, { ...(o.archive ? { archive: o.archive } : {}), ...(o.buildPlan ? { buildPlan: o.buildPlan } : {}) }),
});
let obs = await env.reset({ seed: o.seed });
const adv = playerAdvisor({
  planRoute: (x, z) => env.planRoute(x, z),
  build: env.getMetadata().game.build,
  plan: o.plan,
  onEvent: (e) => send({ type: 'event', event: { t: Math.round(e.t), what: e.what, detail: e.detail } }),
});
adv.reset();
const meta = env.getMetadata();
send({ type: 'ready', meta: { seed: o.seed, species: o.species, map: o.map, tier: o.tier, plan: adv.plan.version, game: `${meta.game.build} (${meta.game.version})`, speed } });

let res: StepResult | null = null, lastBuild = '', lastFrameAt = 0;
for (;;) {
  while (paused) await sleep(50);
  let action;
  if (obs.phase === 'choice') {
    const c = adv.choose(obs);
    adv.noteChoice(obs, c.action, c.reason);
    action = c.action;
  } else {
    const out = adv.peek(adv.advise(obs));
    action = adv.commit(obs, out);
    // The run clock against the wall clock; at high speeds not every decision is drawn (20 frames a second at most).
    const t = obs.snapshot.t, wall = wallNow();
    if (reanchor) { anchorWall = wall; anchorGame = t; reanchor = false; }
    const due = anchorWall + (t - anchorGame) * 1000 / speed;
    if (due - wall > 1) await sleep(Math.min(250, due - wall));
    else if (wall - due > 500) reanchor = true;
    if (wallNow() - lastFrameAt >= 45) {
      lastFrameAt = wallNow();
      send({ type: 'frame', frame: frameOf(obs, { ...adv.state, goal: out.goal ?? null }) });
      const b = buildOf(obs, adv.knowledge);
      if (b.key !== lastBuild) { lastBuild = b.key; send({ type: 'build', build: b }); }
    }
  }
  res = await env.step(action);
  if (res.terminated || res.truncated) break;
  obs = res.observation;
}
const info = res.info, ot = info.overtime;
// The map as the run ended, not as it was a decision earlier.
send({ type: 'frame', frame: frameOf(res.observation, { ...adv.state, goal: null }) });
send({ type: 'build', build: buildOf(res.observation, adv.knowledge) });
send({ type: 'end', summary: { cause: info.endCause ?? 'unknown', score: info.kills + (ot?.cashed ? ot.bonus : 0), kills: info.kills, round: ot?.round ?? 0, bonus: ot?.cashed ? ot.bonus : 0, time: Math.round(info.time), level: info.level } });
await env.close();
process.exit(0);
