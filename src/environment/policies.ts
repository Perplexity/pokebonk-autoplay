import { sfc32 } from '../sim/rng.ts';
import { MOVES } from './types.ts';
import type { Action, ChoiceAction, ChoiceMask, ExtraAction, Observation, PlayMask } from './types.ts';

/**
 * Baseline policies for the episode runner. A policy sees only what an agent sees (the observation) and has its own
 * random stream, seeded per episode, separate from the game's.
 */
export interface Policy {
  name: string;
  /** Called at the start of every episode. */
  reset(seed: number): void;
  act(observation: Observation): Action;
}

/** Every action a choice mask allows, in a fixed order: options first, then extras in key order (with targets). */
export function validChoices(mask: ChoiceMask): ChoiceAction[] {
  const out: ChoiceAction[] = [];
  mask.options.forEach((ok, i) => { if (ok) out.push({ type: 'choice', option: i }); });
  for (const extra of Object.keys(mask.extras).sort() as ExtraAction[]) {
    const m = mask.extras[extra];
    if (Array.isArray(m)) m.forEach((ok, target) => { if (ok) out.push({ type: 'choice', extra, target }); });
    else if (m) out.push({ type: 'choice', extra });
  }
  return out;
}

/** Uniformly random valid actions: a random direction, each allowed button with probability 1/2, any allowed choice. */
export function randomPolicy(): Policy {
  let rnd = sfc32(0);
  const coin = () => rnd() < 0.5;
  return {
    name: 'random',
    reset(seed) { rnd = sfc32((seed ^ 0x9e3779b9) >>> 0); },
    act(obs) {
      if (obs.phase === 'choice') {
        const valid = validChoices(obs.mask as ChoiceMask);
        if (!valid.length) throw new Error(`random policy: dialog "${obs.decision?.kind}" has no valid action`);
        return valid[Math.floor(rnd() * valid.length)];
      }
      const mask = obs.mask as PlayMask;
      const moves = MOVES.map((_, i) => i).filter((i) => mask.move[i]);
      return {
        type: 'play', move: moves[Math.floor(rnd() * moves.length)],
        jump: mask.jump && coin(), dash: mask.dash && coin(), ultimate: mask.ultimate && coin(), interact: mask.interact && coin(),
        form: mask.form && coin(), incense: mask.incense && coin(), fuse: mask.fuse && coin(),
      };
    },
  };
}

/** Never moves and presses nothing. Dialogs still need an answer: the first valid option, else the first valid extra. */
export function idlePolicy(): Policy {
  return {
    name: 'idle',
    reset() { /* stateless */ },
    act(obs) {
      if (obs.phase === 'choice') {
        const valid = validChoices(obs.mask as ChoiceMask);
        if (!valid.length) throw new Error(`idle policy: dialog "${obs.decision?.kind}" has no valid action`);
        return valid[0];
      }
      return { type: 'play', move: 0 };
    },
  };
}

export const POLICIES: Record<string, () => Policy> = { random: randomPolicy, idle: idlePolicy };
