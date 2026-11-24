import type { Snapshot, UiOption } from '../../bot/snapshot.ts';
import type { Build } from '../../bot/brain/builds.ts';
import { scoreOffer } from '../../bot/brain/choices.ts';
import type { Tuning } from '../../bot/brain/tuning.ts';
import { validChoices } from '../../environment/policies.ts';
import type { ChoiceAction, ChoiceMask, Decision, DecisionOption, ExtraAction, Observation } from '../../environment/types.ts';
import { ALWAYS_AVOID, OVERTIME_HOLD, VITAMIN_EFFECT, itemScore } from './knowledge.ts';

/**
 * The heuristic baseline's answer to every dialog the environment raises (docs/game-mechanics.md §4), as a pure function
 * of the observation. Simple, transparent rules; it is a baseline, not a strategy:
 *
 *   levelup          score every offer (below); refresh when the best one is weak and a refresh is left. Never skips,
 *                    never banishes.
 *   evolution        evolve, into the first form offered.
 *   item             take it, unless it is one of the few items that make the horde harder (then sell).
 *   itemChoice       the item worth most to the kit (knowledge.ts); none of them when all are harmful.
 *   blessing         the blessing whose text scores best with the level-up rules.
 *   seals            wake the guardian without seals (survival first).
 *   sanctuaryPath    the classic path: fight the legendary.
 *   leaveSanctuary   start overtime.
 *   overtimeStart    start.
 *   overtimeOffer    a "hold" offering when one is offered, else none.
 *   trade            decline (the price of a trade is not in the decision).
 *   shop             buy the best affordable item worth at least SHOP_MIN, repeat; then leave. Never restocks.
 *   ditto            copy the owned item worth most.
 *   party            release the weakest ally (lowest base stat total) when the newcomer is stronger, else decline.
 *   shinySwap        keep the current partner.
 *   relic            take the first relic while a slot is free, else decline.
 *   dojo, slots, forget, fusion    decline / leave (the baseline does not use them).
 *
 * Level-up scores reuse `scoreOffer` (src/bot/brain/choices.ts), which reads offer cards as text: an upgrade of an owned
 * move is given its name from the snapshot, a vitamin the stat line of the game's registry (knowledge.ts). A NEW move
 * arrives as a bare id, so it is scored by rule: a move of the Pokémon's own kit with a free slot 86 (just under
 * upgrading a core move, above everything else), a move borrowed from another League member 60 before level 8 and 40
 * after, any new move without a free slot 12.
 */

export interface ChooserContext { build: Build; tuning: Tuning }
export interface Choice { action: ChoiceAction; reason: string }

/** Minimum worth of a shop item for the baseline to spend Pokédollars on it. */
export const SHOP_MIN = 70;
/** Items scoring this or less are sold / left. */
export const ITEM_HARMFUL = 20;

const RARITY_NAME = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const card = (text: string, more: Partial<UiOption> = {}): UiOption => ({ text, cls: '', x: 0, y: 0, w: 0, h: 0, disabled: false, ...more });

/** Score of one level-up offer, with the reason. Exported for tests. */
export function scoreLevelUp(opt: DecisionOption, s: Snapshot, ctx: ChooserContext): { score: number; why: string } {
  const d = opt.data as { kind?: string; slot?: number; vit?: string; rarity?: number; from?: number | null };
  const rarity = Number(d.rarity) || 0;
  const build: Build = { ...ctx.build, avoid: [...ctx.build.avoid, ...ALWAYS_AVOID] };
  switch (d.kind) {
    case 'upMove': {
      const name = s.player.moves[Number(d.slot)]?.name ?? '';
      const r = scoreOffer(card(name, { name, tag: 'upgrade', sub: 'move', rarity: RARITY_NAME[rarity] }), s, build, ctx.tuning);
      return { score: r.score, why: r.why };
    }
    case 'newMove': {
      const slot = s.player.moves.length < s.player.moveSlots;
      const own = d.from === undefined || d.from === null;
      const base = !slot ? 12 : own ? 86 : s.player.level < 8 ? 60 : 40;
      return { score: base + rarity * 3, why: !slot ? 'new move, no slot' : own ? 'new move of its own kit' : `new move borrowed from #${d.from}` };
    }
    case 'newVit':
    case 'upVit': {
      const vit = String(d.vit ?? ''), effect = VITAMIN_EFFECT[vit] ?? '';
      const r = scoreOffer(card(effect, { name: vit, tag: d.kind === 'upVit' ? 'upgrade' : 'new', sub: '', effects: effect ? [effect] : [], rarity: RARITY_NAME[rarity] }), s, build, ctx.tuning);
      return { score: r.score, why: r.why };
    }
    default:
      // An offer kind this build of the game did not have when the rules were written: neutral, never preferred.
      return { score: 20 + rarity * 3, why: `offer kind "${String(d.kind)}" has no rule: neutral` };
  }
}

function best<T>(items: T[], allowed: boolean[], score: (x: T, i: number) => number): { i: number; score: number } {
  let bi = -1, bs = -Infinity;
  items.forEach((x, i) => { if (!allowed[i]) return; const sc = score(x, i); if (sc > bs) { bs = sc; bi = i; } });
  return { i: bi, score: bs };
}

export function choose(obs: Observation, ctx: ChooserContext): Choice {
  const d = obs.decision, mask = obs.mask as ChoiceMask;
  if (obs.phase !== 'choice' || !d) throw new Error('heuristic chooser: called outside the choice phase');
  const s = obs.snapshot;
  const valid = validChoices(mask);
  if (!valid.length) throw new Error(`heuristic chooser: dialog "${d.kind}" (${d.method}) has no valid action`);

  const can = (extra: ExtraAction): boolean => mask.extras[extra] === true;
  const option = (i: number, reason: string): Choice | null => (i >= 0 && mask.options[i] ? { action: { type: 'choice', option: i }, reason } : null);
  const extra = (e: ExtraAction, reason: string): Choice | null => (can(e) ? { action: { type: 'choice', extra: e }, reason } : null);
  const byId = (id: string, reason: string): Choice | null => option(d.options.findIndex((o) => o.id === id), reason);
  // What the rule wanted is not possible: the first valid action, said so in the reason.
  const fallback = (wanted: string): Choice => ({ action: valid[0], reason: `${wanted} is not possible: first valid action` });
  const items = (): number[] => d.options.map((o) => itemScore(String(o.data.key ?? o.id), s.player.moves));

  switch (d.kind) {
    case 'levelup': return chooseLevelUp(d, mask, s, ctx) ?? fallback('a level-up pick');
    case 'evolution': return option(mask.options.indexOf(true), `evolve into ${d.options[mask.options.indexOf(true)]?.id}`) ?? extra('decline', 'no form can be taken: stay') ?? fallback('evolving');
    case 'item': {
      const sc = items()[0];
      if (sc <= ITEM_HARMFUL) return extra('sell', `sell ${d.options[0].id}: it makes the run harder`) ?? option(0, `take ${d.options[0].id}`) ?? fallback('selling');
      return option(0, `take ${d.options[0].id}`) ?? extra('sell', 'cannot take: sell') ?? fallback('taking the item');
    }
    case 'itemChoice': {
      const sc = items(), b = best(d.options, mask.options, (_o, i) => sc[i]);
      if (b.i < 0 || b.score <= ITEM_HARMFUL) return extra('sell', 'none of these items is wanted') ?? option(b.i, 'cannot refuse: best of them') ?? fallback('refusing the items');
      return option(b.i, `${d.options[b.i].id} (worth ${b.score})`)!;
    }
    case 'blessing': {
      const build: Build = { ...ctx.build, avoid: [...ctx.build.avoid, ...ALWAYS_AVOID] };
      const b = best(d.options, mask.options, (o) => scoreOffer(card(o.label || o.id), s, build, ctx.tuning).score);
      return option(b.i, `${d.options[b.i]?.label || d.options[b.i]?.id} (score ${Math.round(b.score)})`) ?? fallback('a blessing');
    }
    case 'seals': return byId('none', 'wake it without seals: survival first') ?? fallback('waking without seals');
    case 'sanctuaryPath': return byId('sanct', 'classic path: fight the legendary') ?? fallback('the classic path');
    case 'leaveSanctuary': return byId('ot', 'start overtime') ?? fallback('starting overtime');
    case 'overtimeStart': return byId('start', 'start overtime') ?? fallback('starting overtime');
    case 'overtimeOffer': {
      for (const key of OVERTIME_HOLD) { const c = byId(key, `offering "${key}": it helps to hold out`); if (c) return c; }
      return extra('decline', 'only risk offerings: none') ?? fallback('declining the offering');
    }
    case 'trade': return extra('decline', 'trades are declined: their price is not known to the baseline') ?? fallback('declining the trade');
    case 'shop': {
      const sc = items(), b = best(d.options, mask.options, (_o, i) => sc[i]);
      if (b.i >= 0 && b.score >= SHOP_MIN) return option(b.i, `buy ${d.options[b.i].id} (worth ${b.score}) for ${String(d.options[b.i].data.price)}₽`)!;
      return extra('leave', 'nothing worth its price') ?? fallback('leaving the shop');
    }
    case 'ditto': {
      const sc = items(), b = best(d.options, mask.options, (_o, i) => sc[i]);
      return option(b.i, `copy ${d.options[b.i]?.id} (worth ${b.score})`) ?? extra('decline', 'nothing can be copied') ?? fallback('declining Ditto');
    }
    case 'party': {
      const bst = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      const incoming = bst((d.context.incoming as Record<string, unknown> | null)?.bst);
      const weakest = best(d.options, mask.options, (o) => -bst(o.data.bst));
      if (weakest.i >= 0 && incoming > -weakest.score) return option(weakest.i, `release the weakest ally (${-weakest.score} < ${incoming})`)!;
      return extra('decline', 'the team is at least as strong as the newcomer') ?? fallback('keeping the team');
    }
    case 'shinySwap': return extra('decline', 'keep the current shiny partner') ?? fallback('keeping the partner');
    case 'relic': {
      const held = Array.isArray(d.context.held) ? d.context.held.length : 0;
      if (held < 3) { const c = option(mask.options.indexOf(true), `take relic ${d.options[mask.options.indexOf(true)]?.id}`); if (c) return c; }
      return extra('decline', held >= 3 ? 'three relics held: keep them' : 'no relic can be taken') ?? fallback('declining the relic');
    }
    // The baseline does not use these: its rules predate their being playable (docs/baseline.md).
    case 'dojo':
    case 'dojoPrize':
    case 'lesson': return extra('decline', `${d.kind}: not used by the baseline`) ?? fallback('declining');
    case 'slots':
    case 'forget':
    case 'fusion':
    case 'shopSell': return extra('leave', `${d.kind}: not used by the baseline`) ?? fallback('leaving');
    default: throw new Error(`heuristic chooser: no rule for decision kind "${String((d as Decision).kind)}" (${d.method})`);
  }
}

function chooseLevelUp(d: Decision, mask: ChoiceMask, s: Snapshot, ctx: ChooserContext): Choice | null {
  let bi = -1, bs = -Infinity, why = '';
  d.options.forEach((o, i) => {
    if (!mask.options[i]) return;
    const r = scoreLevelUp(o, s, ctx);
    if (r.score > bs) { bs = r.score; bi = i; why = r.why; }
  });
  if (bs < ctx.tuning.rerollBelow && mask.extras.refresh === true) return { action: { type: 'choice', extra: 'refresh' }, reason: `weak hand (best ${Math.round(bs)}): refresh` };
  if (bi < 0) return null;
  return { action: { type: 'choice', option: bi }, reason: `${d.options[bi].id}: ${why} (score ${Math.round(bs)})` };
}
