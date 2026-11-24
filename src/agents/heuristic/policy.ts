import type { Nav, Snapshot } from '../../bot/snapshot.ts';
import { buildFor } from '../../bot/brain/builds.ts';
import type { Build } from '../../bot/brain/builds.ts';
import { decide, markVisited, newMemory } from '../../bot/brain/movement.ts';
import type { Directive, Memory } from '../../bot/brain/movement.ts';
import { DEFAULT_TUNING } from '../../bot/brain/tuning.ts';
import type { Tuning } from '../../bot/brain/tuning.ts';
import type { Policy } from '../../environment/policies.ts';
import type { Action, Observation, PlayMask } from '../../environment/types.ts';
import type { RunState } from '../../observations/state.ts';
import { toPlayAction } from './adapter.ts';
import { choose } from './chooser.ts';

/**
 * The heuristic baseline: the hand-written brain of src/bot/brain behind the environment's interface.
 *
 *   play phase     `decide(snapshot, memory, tuning, directive)` → nearest of the eight directions + masked buttons
 *   choice phase   `choose(observation)` (chooser.ts)
 *   lifecycle      the snapshot does not say whether overtime is running; `observation.state.overtime` does, and is
 *                  turned into a `Directive` for the brain (below): hold the portal, stay near it, cash out
 *
 * It sees the observation and nothing else, plus the read-only route planner when one is given (far goals are walked
 * along planned routes, as in the browser harness the brain was written for). It is deterministic: same observations,
 * same actions.
 */

export const HEURISTIC_VERSION = '3';

/** Dialogs that are opened by walking to a service point and pressing interact there (the brain's `visit` goal). */
const SERVICE_DIALOGS = new Set(['shop', 'ditto', 'trade', 'dojo', 'slots', 'forget', 'fusion']);

/** What the policy remembers about the run's lifecycle. */
export interface Lifecycle {
  /** The policy decided to end the run through the portal: not called off again when a heal lifts the HP bar. */
  cashing: boolean;
  /** Run time at which the policy first saw the sanctuary cleared with overtime still to start (null before that). */
  restSince: number | null;
}

/** The part of `observation.state.overtime` the lifecycle is steered by. */
export type OvertimeView = Pick<RunState['overtime'], 'live' | 'over' | 'direct'>;

export interface HeuristicTuning {
  /** Overtime: below this fraction of HP the run is cashed out through the portal. */
  cashHp: number;
  /** Overtime: fight within this distance of the exit portal, so that cashing out is a short walk. */
  leash: number;
  /**
   * Sanctuary, legendary beaten: overtime is not started below this fraction of HP (nothing spawns there meanwhile, so
   * the HP bar refills by itself), for at most `restSec` game seconds.
   */
  restHp: number; restSec: number;
  /** Game seconds between two route plans while the goal is far, and how long a plan is reused. */
  routeEvery: number; routeKeep: number;
}
export const DEFAULT_HEURISTIC: HeuristicTuning = { cashHp: 0.7, leash: 10, restHp: 0.9, restSec: 45, routeEvery: 0.45, routeKeep: 1.5 };

export interface HeuristicOptions {
  /** Read-only route planner (`HeadlessGameEnvironment.planRoute`). Without it far goals are walked in a straight line. */
  planRoute?: (x: number, z: number) => Nav | null;
  tuning?: Partial<Tuning>;
  heuristic?: Partial<HeuristicTuning>;
  /** Called with every decision answered and every change of intent: for traces and tests. */
  onEvent?: (e: { t: number; what: string; detail: string }) => void;
}

export interface HeuristicPolicy extends Policy {
  /** What the policy is doing and what it remembers (read-only view). */
  readonly state: { intent: string; note: string; lifecycle: Readonly<Lifecycle>; build: string };
}

/**
 * The directive for the brain. Exported for tests.
 *
 *   before overtime   none: the brain plays the zone (in the sanctuary: wake the legendary at the shrine, then the
 *                     portal, whose dialog leads to the overtime dialog once the shrine has relit)
 *   legendary beaten  overtime is started with a full HP bar: below `restHp` the portal is left alone for up to
 *                     `restSec` seconds (seen in real play before this rule: overtime was started with the HP bar
 *                     under `cashHp` and cashed 1.2 s later with a bonus of 0)
 *   overtime live     the portal would cash it: it is left alone and the fight is kept near it; below `cashHp` the
 *                     policy walks to the portal and cashes out, whatever else is going on
 *   direct path       overtime starts by itself a few seconds after arrival: the portal is left alone meanwhile
 *   overtime over     none again: the portal ends the run
 */
export function directiveFor(s: Snapshot, ot: OvertimeView, life: Lifecycle, h: HeuristicTuning): Directive {
  const hp = s.player.maxHp > 0 ? s.player.hp / s.player.maxHp : 0;
  if (ot.over) return {};
  if (!(ot.live || ot.direct)) {
    if (s.stage >= 4 && s.stageCleared) {
      life.restSince ??= s.t;
      if (hp < h.restHp && s.t - life.restSince < h.restSec) return { holdPortal: true };
    }
    return {};
  }
  const portal = s.points.filter((q) => q.kind === 'portal').sort((a, b) => a.d - b.d)[0];
  if (!portal) return { holdPortal: true };
  if (life.cashing || hp < h.cashHp) {
    life.cashing = true;
    return { holdPortal: true, goto: { kind: 'cash', x: portal.x, z: portal.z, reach: Math.max(1, portal.r * 0.5), interact: true, force: true, note: `cash out overtime (hp ${Math.round(hp * 100)}%)` } };
  }
  return { holdPortal: true, leash: { x: portal.x, z: portal.z, r: h.leash } };
}

export function heuristicPolicy(options: HeuristicOptions = {}): HeuristicPolicy {
  const tuning: Tuning = { ...DEFAULT_TUNING, ...options.tuning, wakeLevel: [...(options.tuning?.wakeLevel ?? DEFAULT_TUNING.wakeLevel)] };
  const h: HeuristicTuning = { ...DEFAULT_HEURISTIC, ...options.heuristic };
  let mem: Memory = newMemory();
  let build: Build | null = null;
  let life: Lifecycle = { cashing: false, restSince: null };
  let nav: Nav | null = null, navAt = -Infinity, navGoal: { x: number; z: number } | null = null;
  let intent = '', note = '';
  const emit = (t: number, what: string, detail: string) => options.onEvent?.({ t, what, detail });

  return {
    name: 'heuristic',
    get state() { return { intent, note, lifecycle: life, build: build?.name ?? '' }; },
    reset() {
      mem = newMemory(); build = null; nav = null; navAt = -Infinity; navGoal = null; intent = ''; note = '';
      life = { cashing: false, restSince: null };
    },
    act(obs: Observation): Action {
      const s = obs.snapshot;
      // The build plan belongs to the Pokémon the run started with (it evolves on the way).
      build ??= buildFor(s.player.species);
      if (obs.phase === 'choice') {
        const c = choose(obs, { build, tuning });
        // A service point's dialog was answered: that point is done for this zone.
        if (SERVICE_DIALOGS.has(obs.decision!.kind)) mem = markVisited(mem);
        emit(s.t, `choice:${obs.decision!.kind}`, c.reason);
        return c.action;
      }
      if (obs.phase !== 'play') throw new Error('heuristic policy: the episode is over');

      // A far goal is walked along a planned route. A plan is asked for at most every `routeEvery` seconds of game time
      // and reused for `routeKeep` seconds; the brain ignores a route that was planned for another goal.
      let snap: Snapshot = s;
      if (options.planRoute && navGoal && (s.t - navAt >= h.routeEvery || s.t < navAt)) { nav = options.planRoute(navGoal.x, navGoal.z); navAt = s.t; }
      if (nav && s.t - navAt < h.routeKeep && s.t >= navAt) snap = { ...s, nav };

      const out = decide(snap, mem, tuning, directiveFor(s, obs.state.overtime, life, h));
      mem = out.mem;
      navGoal = out.goal?.far ? { x: out.goal.x, z: out.goal.z } : null;
      if (out.action.intent !== intent) emit(s.t, `intent:${out.action.intent}`, out.action.note);
      intent = out.action.intent; note = out.action.note;
      return toPlayAction(out.action, obs.mask as PlayMask).action;
    },
  };
}
