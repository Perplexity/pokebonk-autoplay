import type { Snapshot } from '../../bot/snapshot.ts';
import { validChoices } from '../../environment/policies.ts';
import type { ChoiceAction, ChoiceMask, Decision, DecisionOption, ExtraAction, Observation } from '../../environment/types.ts';
import { choose as chooseV1 } from '../heuristic/chooser.ts';
import type { Choice, ChooserContext } from '../heuristic/chooser.ts';
import type { Plan } from './plan.ts';
import { itemWorth, vitaminWorth } from './values.ts';
import type { Kit, Knowledge } from './values.ts';

/**
 * The second heuristic's answers. Level-ups, items, the shop, Ditto, seals and Overtime offerings follow the plan and
 * the valuation generated from the game's effect data (values.ts); every other dialog is answered as the first
 * heuristic answers it (src/agents/heuristic/chooser.ts).
 */
export interface Chooser2Context extends ChooserContext { plan: Plan; knowledge: Knowledge; kit: Kit }

const hpFrac = (s: Snapshot): number => (s.player.maxHp > 0 ? s.player.hp / s.player.maxHp : 0);

/** Worth of an item to this build now: the risky part counts only while the HP bar is high. */
export function worthNow(key: string, s: Snapshot, ctx: Chooser2Context): number {
  const item = ctx.knowledge.items.get(key);
  if (!item) return 0;
  const w = itemWorth(item, ctx.kit, ctx.plan.direction);
  return w.value + (hpFrac(s) >= ctx.plan.riskHp ? w.risk : Math.min(0, w.risk) - Math.max(0, w.risk));
}

/** Score of one level-up offer (0–100) and why. Exported for tests. */
export function scoreLevelUp2(opt: DecisionOption, s: Snapshot, ctx: Chooser2Context): { score: number; why: string; junk: boolean } {
  const d = opt.data as { kind?: string; slot?: number; vit?: string; rarity?: number; from?: number | null; id?: number };
  const rarity = Number(d.rarity) || 0;
  switch (d.kind) {
    case 'newMove': {
      const free = s.player.moves.length < s.player.moveSlots, own = d.from === undefined || d.from === null;
      if (!free) return { score: 0, why: 'new move, no slot', junk: true };
      if (own) return { score: 95 + rarity, why: 'a move of its own kit', junk: false };
      // A move of another League member: taken into a free slot when it is of the plan's damage class (it then gains
      // from the same stats as the kit), a little more when it is also of one of the kit's types.
      const info = ctx.knowledge.movesById.get(Number(d.id));
      if (ctx.plan.borrowClass && info?.class === ctx.plan.borrowClass) {
        const typed = (ctx.kit.types[info.type] ?? 0) > 0;
        return { score: (typed ? 88 : 80) + rarity, why: `a ${info.class} ${info.type} move borrowed from #${d.from}`, junk: false };
      }
      return { score: 10, why: `a move borrowed from #${d.from}: ${info ? `${info.class}, not the plan's class` : "the kit's own moves come first"}`, junk: true };
    }
    case 'upMove': {
      const move = s.player.moves[Number(d.slot)], info = move ? ctx.knowledge.moves.get(move.key ?? '') : undefined;
      const special = (info?.class ?? move?.cls) === 'special';
      return { score: 70 + rarity * 4 + (special ? 6 : 0), why: `upgrade ${move?.name ?? 'a move'}`, junk: false };
    }
    case 'newVit':
    case 'upVit': {
      const v = ctx.knowledge.vitamins.get(String(d.vit ?? ''));
      if (!v) return { score: 20, why: `vitamin "${String(d.vit)}" is not in the knowledge export`, junk: false };
      const w = vitaminWorth(v, ctx.kit, ctx.plan.direction), worth = w.value + (hpFrac(s) >= ctx.plan.riskHp ? w.risk : -Math.abs(w.risk));
      if (d.kind === 'newVit' && worth < ctx.plan.vitaminMin) return { score: 15, why: `${v.name}: one level is worth ${worth.toFixed(1)}, under ${ctx.plan.vitaminMin}`, junk: worth < ctx.plan.banishBelow };
      return { score: Math.min(94, (d.kind === 'newVit' ? 55 : 50) + 5 * worth + rarity * 2), why: `${v.name} (${v.desc.toLowerCase()}): ${worth.toFixed(1)} a level`, junk: false };
    }
    default: return { score: 20 + rarity * 3, why: `offer kind "${String(d.kind)}" has no rule`, junk: false };
  }
}

function levelUp(d: Decision, mask: ChoiceMask, s: Snapshot, ctx: Chooser2Context): Choice | null {
  const scored = d.options.map((o) => scoreLevelUp2(o, s, ctx));
  const can = (e: ExtraAction): boolean => mask.extras[e] === true;
  // Junk in the offer and a banish left: it never comes back.
  const banish = mask.extras.banish;
  if (Array.isArray(banish)) {
    const i = scored.findIndex((x, j) => x.junk && banish[j]);
    if (i >= 0) return { action: { type: 'choice', extra: 'banish', target: i }, reason: `banish ${d.options[i].id}: ${scored[i].why}` };
  }
  let bi = -1;
  scored.forEach((x, i) => { if (mask.options[i] && (bi < 0 || x.score > scored[bi].score)) bi = i; });
  const best = bi >= 0 ? scored[bi].score : -1;
  if (best < ctx.plan.rerollBelow && can('refresh')) return { action: { type: 'choice', extra: 'refresh' }, reason: `best offer scores ${Math.round(best)}: refresh` };
  if (best < ctx.plan.skipBelow && can('skip')) return { action: { type: 'choice', extra: 'skip' }, reason: `best offer scores ${Math.round(best)}: skip for Pokédollars` };
  return bi >= 0 ? { action: { type: 'choice', option: bi }, reason: `${scored[bi].why} (score ${Math.round(best)})` } : null;
}

export function choose2(obs: Observation, ctx: Chooser2Context): Choice {
  const d = obs.decision, mask = obs.mask as ChoiceMask;
  if (obs.phase !== 'choice' || !d) throw new Error('heuristic2 chooser: called outside the choice phase');
  const s = obs.snapshot, valid = validChoices(mask);
  if (!valid.length) throw new Error(`heuristic2 chooser: dialog "${d.kind}" (${d.method}) has no valid action`);
  const option = (i: number, reason: string): Choice | null => (i >= 0 && mask.options[i] ? { action: { type: 'choice', option: i } as ChoiceAction, reason } : null);
  const extra = (e: ExtraAction, reason: string): Choice | null => (mask.extras[e] === true ? { action: { type: 'choice', extra: e }, reason } : null);
  const fallback = (wanted: string): Choice => ({ action: valid[0], reason: `${wanted} is not possible: first valid action` });
  const worths = (): number[] => d.options.map((o) => worthNow(String(o.data.key ?? o.id), s, ctx));
  const bestOf = (w: number[]): number => { let b = -1; w.forEach((x, i) => { if (mask.options[i] && (b < 0 || x > w[b])) b = i; }); return b; };
  switch (d.kind) {
    case 'levelup': return levelUp(d, mask, s, ctx) ?? fallback('a level-up pick');
    case 'item': {
      const w = worths()[0];
      if (w < ctx.plan.itemSellBelow) return extra('sell', `sell ${d.options[0].id}: worth ${w.toFixed(1)} to this build`) ?? option(0, `take ${d.options[0].id}`) ?? fallback('selling');
      return option(0, `take ${d.options[0].id} (worth ${w.toFixed(1)})`) ?? extra('sell', 'cannot take: sell') ?? fallback('taking the item');
    }
    case 'itemChoice': {
      const w = worths(), b = bestOf(w);
      if (b < 0 || w[b] < ctx.plan.itemSellBelow) return extra('sell', 'none of these items is worth holding') ?? option(b, 'cannot refuse: best of them') ?? fallback('refusing the items');
      return option(b, `${d.options[b].id} (worth ${w[b].toFixed(1)})`)!;
    }
    case 'shop': {
      const w = worths(), b = bestOf(w);
      if (b >= 0 && w[b] >= ctx.plan.shopMinWorth) return option(b, `buy ${d.options[b].id} (worth ${w[b].toFixed(1)}) for ${String(d.options[b].data.price)}₽`)!;
      // Nothing left worth holding: a new stock while it costs a small share of the Pokédollars held.
      const cost = Number(d.context.rerollCost), gold = Number(d.context.gold);
      if (ctx.plan.restockShare > 0 && cost > 0 && cost <= ctx.plan.restockShare * gold) { const c = extra('reroll', `new stock for ${cost}₽ of ${Math.floor(gold)}₽`); if (c) return c; }
      return extra('leave', 'nothing on sale is worth holding') ?? fallback('leaving the shop');
    }
    case 'slots': {
      // One spin while it costs at most the plan's share of the Pokédollars held (the price rises 8 % a spin).
      const cost = Number(d.context.cost), gold = Number(d.context.gold);
      if (ctx.plan.slotShare > 0 && cost > 0 && cost <= ctx.plan.slotShare * gold) { const c = option(0, `spin for ${cost}₽ of ${Math.floor(gold)}₽`); if (c) return c; }
      return extra('leave', ctx.plan.slotShare > 0 ? `a spin costs ${cost}₽: over ${Math.round(ctx.plan.slotShare * 100)} % of ${Math.floor(gold)}₽` : 'slot machines are not used') ?? fallback('leaving the slot machine');
    }
    case 'ditto': {
      const w = worths(), b = bestOf(w);
      return option(b, `copy ${d.options[b]?.id} (worth ${w[b]?.toFixed(1)})`) ?? extra('decline', 'nothing can be copied') ?? fallback('declining Ditto');
    }
    case 'seals': {
      const zone = Math.max(1, s.stage), need = ctx.plan.sealLevel[Math.min(ctx.plan.sealLevel.length - 1, zone - 1)];
      const none = d.options.findIndex((o) => o.id === 'none');
      if (s.player.level >= need) {
        // The subset with the most seals of the plan's list (the game lists every subset), at most `sealMax` of them;
        // among subsets of the same size the one whose seals come first in the list.
        const max = ctx.plan.sealMax[Math.min(ctx.plan.sealMax.length - 1, zone - 1)], rank = (k: string): number => ctx.plan.sealsTake.indexOf(k);
        let pick = -1, n = 0, cost = Infinity;
        d.options.forEach((o, i) => {
          const seals: string[] = Array.isArray(o.data.seals) ? o.data.seals as string[] : [];
          if (!mask.options[i] || !seals.length || seals.length > max || seals.some((k) => rank(k) < 0)) return;
          const c = seals.reduce((a, k) => a + rank(k), 0);
          if (seals.length > n || (seals.length === n && c < cost)) { pick = i; n = seals.length; cost = c; }
        });
        const c = option(pick, `level ${s.player.level} ≥ ${need}: wake it with ${d.options[pick]?.id}`);
        if (c) return c;
      }
      return option(none, `level ${s.player.level} < ${need}: wake it without seals`) ?? fallback('waking without seals');
    }
    case 'overtimeOffer': {
      for (const key of ctx.plan.offerings) { const c = option(d.options.findIndex((o) => o.id === key), `offering "${key}"`); if (c) return c; }
      return extra('decline', 'none of the wanted offerings is offered') ?? fallback('declining the offering');
    }
    default: return chooseV1(obs, ctx);
  }
}
