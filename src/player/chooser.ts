import type { Snapshot } from '../observations/snapshot.ts';
import { validChoices } from '../environment/policies.ts';
import type { ChoiceAction, ChoiceMask, Decision, DecisionOption, ExtraAction, Observation } from '../environment/types.ts';
import { scoreOffer } from './brain/choices.ts';
import type { Build } from './brain/builds.ts';
import type { Tuning } from './brain/tuning.ts';
import type { UiOption } from '../observations/snapshot.ts';
import { kitState } from './kit.ts';
import type { HeldMove, KitState } from './kit.ts';
import type { Plan } from './plan.ts';
import { itemWorth, vitaminWorth } from './values.ts';
import type { Kit, Knowledge } from './values.ts';

/**
 * The player's answer to every dialog the environment raises, as a pure function of the observation.
 *
 *   levelup          the plan's kit and vitamins first (kit.ts, `vitaminPhase`); junk is banished, a weak offer refreshed or skipped
 *   lesson, forget, fusion   Hypno and Bill's machine, for the kit and the vitamins of the final stage
 *   item, itemChoice, shop, ditto   by what the item is worth to the build (values.ts)
 *   slots            spun while a spin is a small share of the Pokédollars held
 *   seals            the plan's seals, most first
 *   overtimeOffer    the plan's offerings in order, else none
 *   evolution        evolve, into the first form offered
 *   blessing         the blessing whose text scores best (brain/choices.ts)
 *   sanctuaryPath, leaveSanctuary, overtimeStart   the classic path, then Overtime
 *   party            release the weakest ally when the newcomer is stronger
 *   relic            the first relic while a slot is free
 *   trade, shinySwap, dojo, dojoPrize, shopSell   declined or left: no rule uses them yet
 */
export interface Choice { action: ChoiceAction; reason: string }
/** Effects a blessing is never picked for: they make the horde harder. */
const ALWAYS_AVOID = ['more and stronger enemies', 'elite spawns'];
const card = (text: string): UiOption => ({ text, cls: '', x: 0, y: 0, w: 0, h: 0, disabled: false });

export interface ChooserContext {
  /** The text build and the brain's tuning: what a blessing's text is scored with (brain/choices.ts). */
  build: Build; tuning: Tuning;
  plan: Plan; knowledge: Knowledge; kit: Kit;
  /** What the plan remembers of earlier answers (policy.ts, `noteChoice`). Absent: nothing banished, no lesson passed. */
  memo?: KitMemo;
}
/** Moves banished in this run, and the zone whose lesson at Hypno was taken or turned down (0: none). */
export interface KitMemo { banished: Set<string>; lessonZone: number }

/** The kit's state for an observation (kit.ts): from the run state's moves, the held items, the zone and the map points. */
export function kitOfObservation(obs: Pick<Observation, 'snapshot' | 'state'>, ctx: Pick<ChooserContext, 'plan' | 'knowledge'>): KitState {
  const s = obs.snapshot, moves: HeldMove[] = [];
  for (const m of obs.state?.build?.moves ?? []) if (m) moves.push({ slot: m.slot, key: m.key, level: m.level, fusion: m.fusion, linked: m.linked });
  return kitState(moves, s.player.moveSlots, s.player.items ?? {}, s.player.species, s.stage, s.points ?? [], ctx.plan, ctx.knowledge);
}

const hpFrac = (s: Snapshot): number => (s.player.maxHp > 0 ? s.player.hp / s.player.maxHp : 0);

/** Worth of an item to this build now: the risky part counts only while the HP bar is high. */
export function worthNow(key: string, s: Snapshot, ctx: ChooserContext): number {
  const item = ctx.knowledge.items.get(key);
  if (!item) return 0;
  const w = itemWorth(item, ctx.kit, ctx.plan.direction);
  return w.value + (hpFrac(s) >= ctx.plan.riskHp ? w.risk : Math.min(0, w.risk) - Math.max(0, w.risk));
}

/**
 * The plan's vitamins for this moment of the run, or null when the plan has none (plan.ts, `vitaminsFarm`): the
 * wanted ones in order of preference, those of the later phase (kept out of the banishes), and whether the final
 * phase has begun. A function of the zone and its clock alone.
 */
export function vitaminPhase(s: Snapshot, plan: Plan): { wanted: string[]; later: string[]; final: boolean } | null {
  if (!plan.vitaminsFarm.length && !plan.vitaminsFinal.length) return null;
  const final = plan.vitaminsFinal.length > 0 && (s.stage > plan.swapZone || (s.stage === plan.swapZone && s.stageTime >= plan.swapAtSec));
  if (final || !plan.vitaminsFarm.length) return { wanted: plan.vitaminsFinal, later: [], final };
  return { wanted: plan.vitaminsFarm, later: plan.vitaminsFinal, final };
}

/** Score of one level-up offer (0–100) and why. Exported for tests. */
export function scoreLevelUp(opt: DecisionOption, s: Snapshot, ctx: ChooserContext, kit?: KitState): { score: number; why: string; junk: boolean; must?: boolean } {
  const d = opt.data as { kind?: string; slot?: number; vit?: string; rarity?: number; from?: number | null; id?: number };
  const rarity = Number(d.rarity) || 0;
  switch (d.kind) {
    case 'newMove': {
      const free = s.player.moves.length < s.player.moveSlots, own = d.from === undefined || d.from === null;
      if (!free) return { score: 0, why: 'new move, no slot', junk: true };
      if (kit?.on) {
        // With a build: only the moves of the plan's kit, and the two of its fusion until it is made.
        const key = ctx.knowledge.movesById.get(Number(d.id))?.key ?? '';
        if (!kit.fused && kit.pair.includes(key)) return { score: 99, why: `${key}: one of the two moves of the plan's fusion`, junk: false };
        const rank = kit.takeable.indexOf(key);
        if (rank >= 0) return { score: 98 - rank, why: `${key}: a move of the plan's kit`, junk: false };
        if (kit.wanted.includes(key)) return { score: 5, why: `${key}: of the plan's kit, but ${kit.missing.includes(key) ? 'not into this slot (it cannot be linked, and a pair is still to be learned, or the slot is owed to the fusion)' : 'held'}`, junk: false };
        // One of the species' own moves comes back in every offer until it is banished: that one use is kept for it.
        if (kit.ownJunk.includes(key)) return { score: 0, why: `${key}: the plan's kit has no place for it`, junk: true, must: true };
        return { score: 10, why: `${key}: not a move of the plan's kit`, junk: false };
      }
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
      // With a build: the two moves the machine waits for first; a move that will be forgotten last, but over a refresh.
      // (The run state's moves are by slot; the snapshot's list closes the gap a forgotten move leaves.)
      const held = kit?.on ? kit.held.find((m) => m.slot === Number(d.slot)) : undefined;
      if (kit && held) {
        if (!kit.fused && kit.pair.includes(held.key)) return { score: 86 + rarity, why: `upgrade ${held.key}: the plan's fusion needs it at level ${kit.cap}`, junk: false };
        if (kit.junk.includes(held.slot)) return { score: 64, why: `upgrade ${held.key}: a move the plan's kit will drop`, junk: false };
        return { score: 76 + rarity * 4, why: `upgrade ${held.key}`, junk: false };
      }
      return { score: 70 + rarity * 4 + (special ? 6 : 0), why: `upgrade ${move?.name ?? 'a move'}`, junk: false };
    }
    case 'newVit':
    case 'upVit': {
      const v = ctx.knowledge.vitamins.get(String(d.vit ?? ''));
      if (!v) return { score: 20, why: `vitamin "${String(d.vit)}" is not in the knowledge export`, junk: false };
      const phase = vitaminPhase(s, ctx.plan);
      if (phase) {
        const rank = phase.wanted.indexOf(v.key);
        // The ones that make the horde bigger or stronger wait until the build can take it (plan.ts, `vitaminsRiskLevel`).
        // (Under any move upgrade, over everything else: left at the bottom, the refreshes and skips were spent on
        // waiting for it and the two slots went to whatever was offered when they ran out.)
        if (rank >= 0 && s.player.level < ctx.plan.vitaminsRiskLevel && ctx.plan.direction.risk.includes(v.stat)) return { score: 60 - rank, why: `${v.name}: a vitamin of the plan, after the moves until level ${ctx.plan.vitaminsRiskLevel}`, junk: false };
        if (rank >= 0) return { score: Math.min(94, 91 - rank + rarity), why: `${v.name}: a vitamin of the plan${phase.final ? ' for the final stage' : ''}`, junk: false };
        if (d.kind === 'upVit') return { score: 25, why: `${v.name}: held, but not one of the plan's vitamins now`, junk: false };
        return { score: 12, why: `${v.name}: not one of the plan's vitamins${phase.later.includes(v.key) ? ' yet' : ''}`, junk: !phase.later.includes(v.key) };
      }
      const w = vitaminWorth(v, ctx.kit, ctx.plan.direction), worth = w.value + (hpFrac(s) >= ctx.plan.riskHp ? w.risk : -Math.abs(w.risk));
      if (d.kind === 'newVit' && worth < ctx.plan.vitaminMin) return { score: 15, why: `${v.name}: one level is worth ${worth.toFixed(1)}, under ${ctx.plan.vitaminMin}`, junk: worth < ctx.plan.banishBelow };
      return { score: Math.min(94, (d.kind === 'newVit' ? 55 : 50) + 5 * worth + rarity * 2), why: `${v.name} (${v.desc.toLowerCase()}): ${worth.toFixed(1)} a level`, junk: false };
    }
    default: return { score: 20 + rarity * 3, why: `offer kind "${String(d.kind)}" has no rule`, junk: false };
  }
}

function levelUp(d: Decision, mask: ChoiceMask, s: Snapshot, ctx: ChooserContext, kit?: KitState): Choice | null {
  const scored = d.options.map((o) => scoreLevelUp(o, s, ctx, kit));
  const can = (e: ExtraAction): boolean => mask.extras[e] === true;
  // Junk in the offer and a banish left: it never comes back. (With a build, one banish is kept back for each move of the
  // species' own kit that the plan drops and that is not banished yet; such a move is banished before anything else.)
  const banish = mask.extras.banish;
  if (Array.isArray(banish)) {
    const kept = kit?.on ? kit.ownJunk.filter((key) => !ctx.memo?.banished.has(key)).length : 0, left = Number(d.context.banishes);
    const spare = !(kept > 0) || !Number.isFinite(left) || left > kept;
    let i = scored.findIndex((x, j) => x.must && banish[j]);
    if (i < 0 && spare) i = scored.findIndex((x, j) => x.junk && banish[j]);
    if (i >= 0) return { action: { type: 'choice', extra: 'banish', target: i }, reason: `banish ${d.options[i].id}: ${scored[i].why}` };
  }
  let bi = -1;
  scored.forEach((x, i) => { if (mask.options[i] && (bi < 0 || x.score > scored[bi].score)) bi = i; });
  const best = bi >= 0 ? scored[bi].score : -1;
  if (best < ctx.plan.rerollBelow && can('refresh')) return { action: { type: 'choice', extra: 'refresh' }, reason: `best offer scores ${Math.round(best)}: refresh` };
  if (best < ctx.plan.skipBelow && can('skip')) return { action: { type: 'choice', extra: 'skip' }, reason: `best offer scores ${Math.round(best)}: skip for Pokédollars` };
  return bi >= 0 ? { action: { type: 'choice', option: bi }, reason: `${scored[bi].why} (score ${Math.round(best)})` } : null;
}

export function choose(obs: Observation, ctx: ChooserContext): Choice {
  const d = obs.decision, mask = obs.mask as ChoiceMask;
  if (obs.phase !== 'choice' || !d) throw new Error('player chooser: called outside the choice phase');
  const s = obs.snapshot, valid = validChoices(mask);
  if (!valid.length) throw new Error(`player chooser: dialog "${d.kind}" (${d.method}) has no valid action`);
  const option = (i: number, reason: string): Choice | null => (i >= 0 && mask.options[i] ? { action: { type: 'choice', option: i } as ChoiceAction, reason } : null);
  const extra = (e: ExtraAction, reason: string): Choice | null => (mask.extras[e] === true ? { action: { type: 'choice', extra: e }, reason } : null);
  const fallback = (wanted: string): Choice => ({ action: valid[0], reason: `${wanted} is not possible: first valid action` });
  const byId = (id: string, reason: string): Choice | null => option(d.options.findIndex((o) => o.id === id), reason);
  const worths = (): number[] => d.options.map((o) => worthNow(String(o.data.key ?? o.id), s, ctx));
  const bestOf = (w: number[]): number => { let b = -1; w.forEach((x, i) => { if (mask.options[i] && (b < 0 || x > w[b])) b = i; }); return b; };
  switch (d.kind) {
    case 'levelup': return levelUp(d, mask, s, ctx, kitOfObservation(obs, ctx)) ?? fallback('a level-up pick');
    case 'lesson': {
      // Hypno's lesson: the best move of the plan's kit among the offers; otherwise it is kept.
      const kit = kitOfObservation(obs, ctx);
      if (!kit.on) return extra('decline', 'the plan lists no kit for this Pokémon: the lesson is kept') ?? fallback('declining');
      let pick = -1, rank = Infinity;
      d.options.forEach((o, i) => { const r = kit.takeable.indexOf(ctx.knowledge.movesById.get(Number(o.data.id))?.key ?? ''); if (mask.options[i] && o.data.kind === 'newMove' && r >= 0 && r < rank) { pick = i; rank = r; } });
      return option(pick, `${kit.takeable[rank]}: a move of the plan's kit`) ?? extra('decline', "none of the lesson's moves is of the plan's kit") ?? fallback('declining the lesson');
    }
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
      const zone = Math.max(1, s.stage), none = d.options.findIndex((o) => o.id === 'none');
      {
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
        const c = option(pick, `wake it with ${d.options[pick]?.id}`);
        if (c) return c;
      }
      return option(none, 'none of the plan\'s seals is offered: wake it without seals') ?? fallback('waking without seals');
    }
    case 'overtimeOffer': {
      for (const key of ctx.plan.offerings) { const c = option(d.options.findIndex((o) => o.id === key), `offering "${key}"`); if (c) return c; }
      return extra('decline', 'none of the wanted offerings is offered') ?? fallback('declining the offering');
    }
    case 'forget': {
      // Hypno: a move the kit has no place for is forgotten out of a full set of slots, and this zone's
      // lesson is taken for the free slot, once (turned down, it would offer the same moves again).
      const kit = kitOfObservation(obs, ctx);
      if (kit.on) {
        const i = d.options.findIndex((o, j) => mask.options[j] && o.data.what === 'move' && kit.forget.includes(Number(o.data.slot)));
        if (i >= 0) { const c = option(i, `forget ${String(d.options[i].data.key)}: the plan's kit has no place for it, and ${kit.missing.length} of its moves are still to be learned`); if (c) return c; }
        const lesson = d.options.findIndex((o) => o.data.what === 'lesson');
        if (kit.takeable.length && ctx.memo?.lessonZone !== s.stage && s.player.level >= kit.lessonFrom) { const c = option(lesson, "Hypno's lesson for the free slot"); if (c) return c; }
      }
      // Hypno: in the final phase the vitamins that are not of it are forgotten, one answer each (he pays for them).
      const phase = vitaminPhase(s, ctx.plan);
      if (phase?.final) {
        const i = d.options.findIndex((o, j) => mask.options[j] && o.data.what === 'vitamin' && !phase.wanted.includes(String(o.data.key)));
        if (i >= 0) { const c = option(i, `forget ${String(d.options[i].data.key)}: a vitamin of the final stage takes its place`); if (c) return c; }
      }
      return extra('leave', phase?.final ? 'the vitamins held are those of the final stage' : 'nothing to forget') ?? fallback('leaving Hypno');
    }
    case 'fusion': {
      // Bill's machine: the plan's fusion when its two moves are ready, else a link of two moves of the kit.
      const kit = kitOfObservation(obs, ctx);
      if (kit.on) {
        const of = (how: string, pair: [string, string] | null): number => (pair ? d.options.findIndex((o, j) => mask.options[j] && o.data.how === how && pair.includes(String(o.data.moveA)) && pair.includes(String(o.data.moveB)) && o.data.moveA !== o.data.moveB) : -1);
        return option(of('fuse', kit.fuse), `fuse ${kit.fuse?.join(' and ')}: both at level ${kit.cap}`)
          ?? option(of('link', kit.link), `link ${kit.link?.join(' and ')}: both at level ${kit.cap}, and the slot it frees is for ${kit.missing[0] ?? 'nothing more'}`)
          ?? extra('leave', `no two moves of the plan's kit are at level ${kit.cap}`) ?? fallback("leaving Bill's machine");
      }
      return extra('leave', "the plan lists no build for this Pokémon: Bill's machine is not used") ?? fallback("leaving Bill's machine");
    }
    case 'evolution': return option(mask.options.indexOf(true), `evolve into ${d.options[mask.options.indexOf(true)]?.id}`) ?? extra('decline', 'no form can be taken: stay') ?? fallback('evolving');
    case 'blessing': {
      const build: Build = { ...ctx.build, avoid: [...ctx.build.avoid, ...ALWAYS_AVOID] };
      let b = -1, bs = -Infinity;
      d.options.forEach((o, i) => { if (!mask.options[i]) return; const sc = scoreOffer(card(o.label || o.id), s, build, ctx.tuning).score; if (sc > bs) { bs = sc; b = i; } });
      return option(b, `${d.options[b]?.label || d.options[b]?.id} (score ${Math.round(bs)})`) ?? fallback('a blessing');
    }
    case 'sanctuaryPath': return byId('sanct', 'classic path: fight the legendary') ?? fallback('the classic path');
    case 'leaveSanctuary': return byId('ot', 'start overtime') ?? fallback('starting overtime');
    case 'overtimeStart': return byId('start', 'start overtime') ?? fallback('starting overtime');
    case 'trade': return extra('decline', 'trades are declined: no rule prices them yet') ?? fallback('declining the trade');
    case 'party': {
      const bst = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      const incoming = bst((d.context.incoming as Record<string, unknown> | null)?.bst);
      let w = -1, ws = -Infinity;
      d.options.forEach((o, i) => { if (!mask.options[i]) return; const sc = -bst(o.data.bst); if (sc > ws) { ws = sc; w = i; } });
      if (w >= 0 && incoming > -ws) return option(w, `release the weakest ally (${-ws} < ${incoming})`)!;
      return extra('decline', 'the team is at least as strong as the newcomer') ?? fallback('keeping the team');
    }
    case 'shinySwap': return extra('decline', 'keep the current shiny partner') ?? fallback('keeping the partner');
    case 'relic': {
      const held = Array.isArray(d.context.held) ? d.context.held.length : 0;
      if (held < 3) { const c = option(mask.options.indexOf(true), `take relic ${d.options[mask.options.indexOf(true)]?.id}`); if (c) return c; }
      return extra('decline', held >= 3 ? 'three relics held: keep them' : 'no relic can be taken') ?? fallback('declining the relic');
    }
    case 'dojo':
    case 'dojoPrize': return extra('decline', `${d.kind}: no rule uses it yet`) ?? fallback('declining');
    case 'shopSell': return extra('leave', 'nothing is sold') ?? fallback('leaving');
    default: throw new Error(`player chooser: no rule for decision kind "${String((d as Decision).kind)}" (${d.method})`);
  }
}
