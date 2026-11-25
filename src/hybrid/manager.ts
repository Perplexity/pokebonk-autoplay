import { heuristic2Advisor } from '../agents/heuristic2/policy.ts';
import type { Advice, Heuristic2Advisor } from '../agents/heuristic2/policy.ts';
import type { decide } from '../bot/brain/movement.ts';
import type { HeadlessGameEnvironment } from '../environment/GameEnvironment.ts';
import type { ChoiceMask, Decision, Observation, ResetOptions, StepInfo } from '../environment/types.ts';
import { M_ACTIONS, M_PLAY_BASE, ManagerActionError, actionNames, choiceMaskIds, choiceOfId, idOfChoice, playOfId } from './actions.ts';
import type { ManagerEncoder } from './observe.ts';
import { classify, playMaskIds, pointKey, quietTuning, skillOrder } from './skills.ts';
import type { SkillWorld } from './skills.ts';

/**
 * The manager's environment (phase 2 of the heuristic + RL refactor): the game environment seen at the level of
 * decisions a manager makes, about one a second.
 *
 *   dialog   one step = one answer (an option or an extra action), no game time passes
 *   play     one step = one skill, carried out by the heuristic's brain until
 *              - `sliceSeconds` of game time have passed (default 1), or
 *              - a dialog opens or the episode ends, or
 *              - the skill can no longer be carried out (its target was used, the zone changed), or
 *              - the heuristic's own proposal changes (the default plan sees a reason to do something else: the
 *                manager is asked again at that moment)
 *
 * Every observation carries the heuristic's PROPOSAL: the action the phase 1 heuristic would take here. A manager that
 * always takes the proposal plays the heuristic's own ticks, to the key press: the skill that equals the proposal is
 * carried out by the heuristic itself, order and tuning. Any other skill is carried out by the brain under the order
 * of skills.ts. The heuristic's plan keeps running as an adviser either way.
 */
export interface ManagerOptions {
  /** Keys of the heuristic's plan to replace (src/agents/heuristic2/plan.ts). */
  plan?: Record<string, unknown>;
  /** Game seconds a skill runs before the manager is asked again. */
  sliceSeconds?: number;
  /** End a slice when the heuristic's proposal changes. */
  endOnProposalChange?: boolean;
  /**
   * Bill's machine fuses or links only while this item is held ('' = no such rule). The owner: moves go to level 10
   * with a TM Case, "and we should realistically never fuse or join until we have this item".
   */
  fuseNeeds?: string;
}

export const MANAGER_DEFAULTS = { sliceSeconds: 1, endOnProposalChange: true, fuseNeeds: 'tm-case' } as const;

export interface ManagerObservation {
  /** The low-level observation the manager decides on. */
  obs: Observation;
  phase: Observation['phase'];
  /** 1 = allowed, over the whole action table. All zero when the episode is over. */
  mask: Uint8Array;
  /** The heuristic's action here (always allowed), or −1 when the episode is over. */
  proposal: number;
  /** Why the heuristic proposes it (its own words). */
  reason: string;
  encoded?: { float: Float32Array; int: Int32Array };
}

export interface ManagerStep {
  observation: ManagerObservation;
  terminated: boolean;
  truncated: boolean;
  /** The environment's info of the last low-level step. */
  info: StepInfo;
  /** Game seconds the step took (0 for a dialog answer) and low-level decisions it made. */
  dt: number;
  ticks: number;
  /** Why the slice ended: 'dialog' | 'over' | 'time' | 'proposal' | 'done' | 'choice'. */
  ended: string;
}

interface Pending { advice: Advice; peek: ReturnType<typeof decide> }

/**
 * Bill's machine: no fusion and no link while the item `need` is not held ('' = no such rule). Every option of the
 * dialog is taken out of the mask; leaving stays possible. Exported for tests.
 */
export function applyFusionRule(decision: Pick<Decision, 'kind' | 'options'>, items: readonly { key: string; count: number }[], need: string, mask: Uint8Array): void {
  if (!need || decision.kind !== 'fusion') return;
  if (items.some((it) => it.key === need && it.count > 0)) return;
  decision.options.forEach((_, i) => { mask[idOfChoice({ type: 'choice', option: i })] = 0; });
}

export class ManagerEnvironment {
  readonly env: HeadlessGameEnvironment;
  readonly advisor: Heuristic2Advisor;
  readonly options: Required<Pick<ManagerOptions, 'sliceSeconds' | 'endOnProposalChange' | 'fuseNeeds'>>;
  encoder: ManagerEncoder | null = null;
  private current: ManagerObservation | null = null;
  private pending: Pending | null = null;
  /** Points a skill of the manager's own gave up on in this zone, and the one it is trying. */
  private skipped = new Set<string>();
  private trying: { key: string; since: number } | null = null;
  private zone = 0;

  constructor(env: HeadlessGameEnvironment, options: ManagerOptions = {}) {
    this.env = env;
    this.advisor = heuristic2Advisor({ planRoute: (x, z) => env.planRoute(x, z), plan: options.plan });
    this.options = { sliceSeconds: options.sliceSeconds ?? MANAGER_DEFAULTS.sliceSeconds, endOnProposalChange: options.endOnProposalChange ?? MANAGER_DEFAULTS.endOnProposalChange, fuseNeeds: options.fuseNeeds ?? MANAGER_DEFAULTS.fuseNeeds };
    if (!(this.options.sliceSeconds > 0)) throw new Error(`manager: sliceSeconds must be positive, got ${this.options.sliceSeconds}`);
  }

  static readonly actionNames = actionNames();

  private world(obs: Observation): SkillWorld {
    const st = obs.state, ot = st.overtime;
    return { gold: obs.snapshot.gold, ballPrice: st.economy.ballPrice, cagePrice: st.economy.cagePrice, slotPrice: st.economy.slotPrice, overtime: !!(ot.live || ot.direct) && !ot.over };
  }

  /** The manager's view of a low-level observation. Called once per observation: it advances the adviser's plan. */
  private look(obs: Observation): ManagerObservation {
    const mask = new Uint8Array(M_ACTIONS);
    let proposal = -1, reason = '';
    this.pending = null;
    if (obs.phase === 'play') {
      const s = obs.snapshot;
      if (s.stage !== this.zone) { this.zone = s.stage; this.skipped = new Set(); this.trying = null; }
      const advice = this.advisor.advise(obs), peek = this.advisor.peek(advice);
      this.pending = { advice, peek };
      playMaskIds(s, this.world(obs), this.skipped, mask);
      proposal = classify(advice.directive, peek.action.intent, s);
      reason = `${peek.action.intent}: ${peek.action.note}`;
      // What the heuristic does is always possible, whatever the mask's own rules say.
      mask[proposal] = 1;
    } else if (obs.phase === 'choice') {
      const c = this.advisor.choose(obs);
      if (c.action.type !== 'choice') throw new Error('manager: the heuristic answered a dialog with a play action');
      choiceMaskIds(obs.mask as ChoiceMask, mask);
      this.fusionRule(obs, mask);
      proposal = idOfChoice(c.action);
      reason = c.reason;
      if (!mask[proposal]) {
        // The heuristic's answer is one the manager's rules forbid (Bill's machine without the TM Case): its default is to leave.
        const leave = idOfChoice({ type: 'choice', extra: 'leave' });
        if (!mask[leave]) throw new Error(`manager: the heuristic's answer to "${obs.decision?.kind}" is not allowed and the dialog cannot be left`);
        proposal = leave; reason = `${reason} (not allowed here: leave)`;
      }
    }
    const out: ManagerObservation = { obs, phase: obs.phase, mask, proposal, reason };
    if (this.encoder) out.encoded = this.encoder.encode(out, this);
    return out;
  }

  private fusionRule(obs: Observation, mask: Uint8Array): void {
    if (obs.decision) applyFusionRule(obs.decision, obs.state.build.items, this.options.fuseNeeds, mask);
  }

  /** Read-only figures for the encoder. */
  figures(): ReturnType<HeadlessGameEnvironment['survivalFigures']> { return this.env.survivalFigures(); }
  get skippedPoints(): ReadonlySet<string> { return this.skipped; }

  async reset(options: ResetOptions = {}): Promise<ManagerObservation> {
    this.advisor.reset();
    this.skipped = new Set(); this.trying = null; this.zone = 0;
    this.encoder?.reset();
    const obs = await this.env.reset(options);
    return (this.current = this.look(obs));
  }

  async step(id: number): Promise<ManagerStep> {
    const cur = this.current;
    if (!cur || cur.phase === 'over') throw new Error('manager: call reset() first (there is no episode, or it is over)');
    if (!Number.isInteger(id) || id < 0 || id >= M_ACTIONS) throw new ManagerActionError(`action ${id} is outside the manager's action table (0–${M_ACTIONS - 1})`);
    if (!cur.mask[id]) throw new ManagerActionError(`action ${id} (${ManagerEnvironment.actionNames[id]}) is not allowed here (${cur.phase}${cur.obs.decision ? `, dialog "${cur.obs.decision.kind}"` : ''})`);
    this.encoder?.acted(id, cur);
    if (cur.phase === 'choice') {
      const action = choiceOfId(id);
      this.advisor.noteChoice(cur.obs, action, id === cur.proposal ? cur.reason : `the manager: ${ManagerEnvironment.actionNames[id]}`);
      const res = await this.env.step(action);
      this.current = this.look(res.observation);
      return { observation: this.current, terminated: res.terminated, truncated: res.truncated, info: res.info, dt: 0, ticks: 1, ended: res.terminated || res.truncated ? 'over' : 'choice' };
    }
    if (id < M_PLAY_BASE) throw new ManagerActionError(`action ${id} is a dialog answer and no dialog is open`);
    // The run's own clock (the snapshot's is rounded to hundredths).
    const play = playOfId(id), t0 = cur.obs.state.zone.time, zone0 = cur.obs.snapshot.stage, proposal0 = cur.proposal;
    let now = cur, ticks = 0;
    for (;;) {
      const obs = now.obs, s = obs.snapshot, pending = this.pending!;
      let out: ReturnType<typeof decide>;
      if (id === now.proposal) {
        out = pending.peek;                                 // the heuristic's own tick
        this.trying = null;
      } else {
        const order = skillOrder(play, s, this.world(obs), this.advisor.plan, this.skipped);
        if (!order) throw new Error(`manager: skill ${ManagerEnvironment.actionNames[id]} is allowed by the mask and has no order`);
        this.attempt(play.skill === 'use' ? order.target : undefined, s.t);
        out = this.advisor.peek({ snap: pending.advice.snap, tuning: quietTuning(pending.advice.tuning, order.retreat), directive: order.directive });
      }
      const res = await this.env.step(this.advisor.commit(obs, out));
      ticks++;
      now = this.current = this.look(res.observation);
      const over = res.terminated || res.truncated;
      const ended = over ? 'over' : now.phase !== 'play' ? 'dialog'
        : now.obs.snapshot.stage !== zone0 || !now.mask[id] ? 'done'
          : this.options.endOnProposalChange && now.proposal !== proposal0 ? 'proposal'
            : now.obs.state.zone.time - t0 >= this.options.sliceSeconds ? 'time' : '';
      if (ended) return { observation: now, terminated: res.terminated, truncated: res.truncated, info: res.info, dt: Math.max(0, now.obs.state.zone.time - t0), ticks, ended };
    }
  }

  /**
   * A point a skill of the manager's own walks to and does not get used within the plan's `errandTimeout` seconds is
   * given up for the zone (out of reach, or the press went to another point): its `use` skill then names the next one.
   */
  private attempt(target: { kind: string; x: number; z: number } | undefined, t: number): void {
    if (!target) { this.trying = null; return; }
    const key = pointKey(target);
    if (this.trying?.key !== key) this.trying = { key, since: t };
    else if (t - this.trying.since > this.advisor.plan.errandTimeout) { this.skipped.add(key); this.trying = null; }
  }
}
