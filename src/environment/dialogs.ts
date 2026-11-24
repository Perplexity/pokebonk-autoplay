import type { GameFns } from './gamefns.ts';
import type { ChoiceAction, ChoiceMask, Decision, DecisionExtra, DecisionKind, DecisionOption, ExtraAction } from './types.ts';

/**
 * Dialogs as structured decisions.
 *
 * The game opens every in-run dialog by calling a method of its HUD object with the options and a callback
 * (`hud.showLevelUp(run, offers, cb)` …). `DialogCapture.install()` replaces those methods ON THE HUD INSTANCE of
 * the current run (a new HUD is created for every run). A replaced method builds no DOM: it keeps the game's own
 * option objects and callback, and exposes a copy of the options as a `Decision`. The agent's answer is passed to
 * the game's callback, exactly what the dialog's button would have done. No element is ever clicked.
 *
 * Two kinds of dialog exist (see docs/game-mechanics.md §4 for each protocol):
 *
 *   handled        the full choice is exposed
 *   refused        dialogs of other modes, the pause menu, the map: reaching one is an error with full details
 *
 * Four dialogs keep part of their logic in the HUD's own click handlers: the slot machine, Hypno, the dojo and the
 * shop's sell row. For those the environment does what the handler does, in the same order: it calls the same
 * functions of the game (src/environment/gamefns.ts, or the object the game hands to the dialog) with the same
 * arguments. Where a handler also writes a field itself, the same write is made here and listed in
 * `DialogCapture.writes`; getMetadata() reports the list.
 *
 * Anything else that tries to open a window while the run is live goes through `hud.modal`, which is guarded too:
 * an unknown dialog can not appear silently.
 */

interface Raised {
  decision: Decision;
  mask(): ChoiceMask;
  /**
   * Validity was already checked against `mask()`. May raise the next dialog synchronously. Returns a promise when the
   * game's own action is asynchronous (a slot-machine spin asks the game service for its draw).
   */
  answer(action: ChoiceAction): void | Promise<void>;
}

export interface DialogFailure { method: string; reason: string; args: string; stack?: string }

/** Deep copy of game data as plain JSON-like values: no functions, no DOM nodes, no object graphs. */
export function plain(value: unknown, depth = 3): unknown {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value as number) ? value : null;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'function' || t === 'symbol' || t === 'bigint') return null;
  if (depth <= 0) return null;
  if (Array.isArray(value)) return value.slice(0, 32).map((v) => plain(v, depth - 1));
  if (value instanceof Map) return Object.fromEntries([...value.entries()].slice(0, 32).map(([k, v]) => [String(k), plain(v, depth - 1)]));
  if (value instanceof Set) return [...value].slice(0, 32).map((v) => plain(v, depth - 1));
  const o = value as Record<string, unknown>;
  if (typeof o.nodeType === 'number') return null; // a DOM node
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const k of Object.keys(o)) {
    if (k === 'run' || k === 'el' || k === 'mesh') continue;
    const v = o[k];
    if (typeof v === 'function') continue;
    out[k] = plain(v, depth - 1);
    if (++n >= 40) break;
  }
  return out;
}
const data = (v: unknown): Record<string, unknown> => {
  const p = plain(v);
  return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : { value: p };
};
const summarize = (args: unknown[]): string => {
  try { return JSON.stringify(args.map((a) => (typeof a === 'function' ? '[function]' : plain(a, 2)))).slice(0, 1500); } catch { return '[unprintable]'; }
};
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback);

/** Names of build-specific methods, found by what their source does. */
export interface BuildNames {
  /** Run: buy a shop entry; returns false when sold, too expensive or the item cannot be taken. */
  shopBuy: string;
  /** Run: pay for a new stock; returns false when too expensive. */
  shopReroll: string;
  /** Run: price of the next restock. */
  shopRerollCost: string;
  /** Player: can one more of this item be taken. */
  playerCanTake: string;
  /** HUD: Bill's fusion machine dialog. */
  hudFusion: string;
  /** HUD: the pause menu. */
  hudPause: string;
}

function findMethod(proto: object, what: string, test: RegExp): { name: string; match: RegExpExecArray } {
  const found: { name: string; match: RegExpExecArray }[] = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue; // its source is the whole class
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d || typeof d.value !== 'function') continue;
    const m = test.exec(Function.prototype.toString.call(d.value));
    if (m) found.push({ name, match: m });
  }
  if (found.length !== 1) throw new Error(`[environment] could not identify the game's "${what}" method: ${found.length} candidates${found.length ? ` (${found.map((f) => f.name).join(', ')})` : ''}. The game build has changed; re-validate src/environment/dialogs.ts.`);
  return found[0];
}

/** Identify the minified methods the dialog layer calls. Throws when the build does not look as expected. */
export function resolveBuildNames(RunClass: { prototype: object }, hud: object): BuildNames {
  const run = RunClass.prototype, hudProto = Object.getPrototypeOf(hud);
  const buy = findMethod(run, 'shop: buy', /\.sold\|\|this\.gold<[\w$]+\.price\|\|!this\.player\.([\w$]+)\([\w$]+\.key\)/);
  return {
    shopBuy: buy.name,
    playerCanTake: buy.match[1],
    shopReroll: findMethod(run, 'shop: restock', /this\.shop\.rerolls\+\+/).name,
    shopRerollCost: findMethod(run, 'shop: restock price', /\*\*this\.shopRerolls\)/).name,
    hudFusion: findMethod(hudProto, 'HUD: fusion machine dialog', /this\.modal\([\w$]+\.el\);[\w$]+\.classList\.add\(`bm-modal`\)/).name,
    hudPause: findMethod(hudProto, 'HUD: pause menu', /`pz-bar /).name,
  };
}

/** HUD methods of the standard mode that are turned into decisions. */
export const HANDLED_METHODS = [
  'showLevelUp', 'showBranch', 'showItem', 'showItemChoice', 'showBlessing', 'showSeals', 'showSanctuaryPath', 'showLeaveSanctuary',
  'showOvertime', 'showOtOffer', 'showTrade', 'showShop', 'showDitto', 'showParty', 'showShinySwap', 'relicChoice',
  'showDojo', 'showSlots', 'showForget', '(fusion machine)',
] as const;
/**
 * Field writes the environment makes in place of a HUD click handler (the handler's own statements, in its order).
 * Everything else a dialog answer does is done by a function of the game.
 */
export const HANDLER_WRITES = [
  'Hypno, a lesson taken: run.lessonAt = <lesson key of the zone>; run.stats.lessons++ (after the game\'s own offer function and player.recompute())',
  'shop, an owned item sold: player.removeItem(key); run.<gain Pokédollars>(price); run.econ.sold++',
] as const;
/** HUD methods that must not be reached in this mode: other modes' dialogs, the map and the pause menu. */
export const REFUSED_METHODS = ['showPact', 'showBadges', 'showExpInventory', 'showTraining', 'showRelayRecruit', 'showMap', '(pause menu)'] as const;

export class DialogCapture {
  /** The dialog waiting for an answer, if any. */
  pending: Raised | null = null;
  /** Set when the game opened something the environment has no rule for. The environment turns it into an error. */
  failure: DialogFailure | null = null;
  /** Decisions raised in this episode. */
  serial = 0;
  /** kind → how many times it was raised in this episode. */
  readonly seen = new Map<string, number>();
  private names: BuildNames;
  private fns: GameFns;
  private run: any = null;
  /** Hypno's lesson offers of the current zone, kept while the lesson is not taken (the HUD keeps them the same way). */
  private lesson: { run: unknown; key: string; offers: any[] } | null = null;
  /** The last spin of the slot machine in this visit, for the next decision's context. */
  private lastSpin: Record<string, unknown> | null = null;
  /**
   * Items sold through the shop's sell list in this episode. The game's own `econ.sold` also counts a found item
   * that was turned down for Pokédollars; this is the shop alone.
   */
  shopSold = 0;

  constructor(names: BuildNames, fns: GameFns) { this.names = names; this.fns = fns; }

  reset(): void { this.pending = null; this.failure = null; this.serial = 0; this.seen.clear(); this.run = null; this.lesson = null; this.lastSpin = null; this.shopSold = 0; }

  private raise(kind: DecisionKind, method: string, title: string, options: DecisionOption[], extras: Partial<Record<ExtraAction, DecisionExtra>>, context: Record<string, unknown>, mask: () => Omit<ChoiceMask, 'phase'>, answer: (a: ChoiceAction) => void | Promise<void>): void {
    if (this.pending) {
      this.failure ??= { method, reason: `the game opened "${method}" while "${this.pending.decision.method}" was still waiting for an answer`, args: '' };
      return;
    }
    this.serial++;
    this.seen.set(kind, (this.seen.get(kind) ?? 0) + 1);
    const decision: Decision = { kind, method, title, options, extras, context: data(context), serial: this.serial };
    this.pending = {
      decision,
      mask: () => ({ phase: 'choice', ...mask() }),
      answer: (a) => { this.pending = null; return answer(a); },
    };
  }

  /** Replace the dialog methods on this run's HUD instance. Call once per run, right after the game created it. */
  install(hud: any, run: any): string[] {
    this.reset();
    this.run = run;
    const N = this.names, F = this.fns;
    const done: string[] = [];
    const set = (name: string, fn: (...args: any[]) => void) => {
      if (typeof hud[name] !== 'function') throw new Error(`[environment] the HUD has no method "${name}": the game build has changed`);
      hud[name] = fn;
      done.push(name);
    };
    const decline = (effect: string): DecisionExtra => ({ needsTarget: false, effect });
    const optIndex = (a: ChoiceAction): number => ('option' in a ? a.option : -1);
    const extraOf = (a: ChoiceAction): ExtraAction | null => ('extra' in a ? a.extra : null);
    const targetOf = (a: ChoiceAction): number => ('extra' in a ? a.target ?? -1 : -1);

    // ---- level-up: pick one offer, or refresh / skip / banish while uses remain ----
    set('showLevelUp', (r: any, offers: any[], cb: (offer: any, how?: string) => void) => {
      this.raise('levelup', 'showLevelUp', `level ${r.player?.level ?? '?'}`,
        offers.map((o) => ({ id: `${str(o.kind, '?')}:${str(o.key ?? o.id, '?')}`, label: str(o.name ?? o.title ?? o.key ?? o.id), data: data(o) })),
        {
          refresh: { needsTarget: false, effect: 'new offers (uses one refresh)' },
          skip: { needsTarget: false, effect: 'take nothing, gain Pokédollars (uses one skip)' },
          banish: { needsTarget: true, effect: 'remove the target from future offers, then new offers (uses one banish)' },
          banishKit: { needsTarget: true, effect: 'banish the target and every move of the same kit (new moves that come from another League member only)' },
        },
        { rerolls: r.rerolls, skips: r.skips, banishes: r.banishes, pendingLevels: r.pendingLevels, level: r.player?.level },
        () => ({
          options: offers.map(() => true),
          extras: {
            refresh: r.rerolls > 0, skip: r.skips > 0,
            banish: offers.map(() => r.banishes > 0),
            banishKit: offers.map((o) => r.banishes > 0 && o.kind === 'newMove' && o.from != null),
          },
        }),
        (a) => {
          const e = extraOf(a);
          if (e === 'refresh') cb(null, 'reroll');
          else if (e === 'skip') cb(null, 'skip');
          else if (e === 'banish') cb(offers[targetOf(a)], 'banish');
          else if (e === 'banishKit') cb(offers[targetOf(a)], 'banishKit');
          else cb(offers[optIndex(a)]);
        });
    });

    // ---- evolution: which form to take; "stay" needs an Everstone unless the Pokémon is a baby ----
    set('showBranch', (r: any, forms: number[], cb: (form: number) => void, info: any = {}) => {
      const canStay = !!info.stay;
      this.raise('evolution', 'showBranch', `species ${r.player?.speciesId ?? '?'} can evolve`,
        forms.map((f) => ({ id: String(f), label: `evolve into species ${f}`, data: { species: f } })),
        canStay ? { decline: decline('stay as it is') } : {},
        { from: r.player?.speciesId, stay: info.stay ?? null, stone: info.stone ?? null, baby: info.baby ?? null },
        () => ({ options: forms.map(() => true), extras: canStay ? { decline: info.stone !== 'missing' } : {} }),
        (a) => cb(extraOf(a) === 'decline' ? -1 : forms[optIndex(a)]));
    });

    // ---- found item: take it (option 0) or sell it ----
    set('showItem', (r: any, key: string, cb: (take: boolean) => void) => {
      this.raise('item', 'showItem', 'found an item',
        [{ id: key, label: key, data: { key, owned: r.player?.items?.get?.(key) ?? 0 } }],
        { sell: { needsTarget: false, effect: 'sell it for Pokédollars instead of taking it' } },
        { gold: r.gold },
        () => ({ options: [true], extras: { sell: true } }),
        (a) => cb(extraOf(a) !== 'sell'));
    });
    set('showItemChoice', (r: any, keys: string[], cb: (key: string | null) => void) => {
      this.raise('itemChoice', 'showItemChoice', 'found items: take one',
        keys.map((k) => ({ id: k, label: k, data: { key: k, owned: r.player?.items?.get?.(k) ?? 0 } })),
        { sell: { needsTarget: false, effect: 'take none, gain Pokédollars' } },
        { gold: r.gold },
        () => ({ options: keys.map(() => true), extras: { sell: true } }),
        (a) => cb(extraOf(a) === 'sell' ? null : keys[optIndex(a)]));
    });

    // ---- blessing (altars, dojo prizes): one must be taken ----
    set('showBlessing', (_r: any, title: string, offers: any[], cb: (offer: any) => void, sub?: string) => {
      this.raise('blessing', 'showBlessing', str(title),
        offers.map((o, i) => ({ id: str(o.key ?? o.id ?? o.label, String(i)), label: str(o.label), data: data(o) })),
        {}, { subtitle: sub ?? null },
        () => ({ options: offers.map(() => true), extras: {} }),
        (a) => cb(offers[optIndex(a)]));
    });

    // ---- challenge seals before waking a guardian: any subset of the offered seals, or not now ----
    set('showSeals', (_r: any, info: { species: number; legendary: boolean; offers: string[]; kept: number }, cb: (seals: string[] | null) => void) => {
      const subsets: string[][] = [];
      for (let m = 0; m < 1 << info.offers.length; m++) subsets.push(info.offers.filter((_, i) => m & (1 << i)));
      this.raise('seals', 'showSeals', `wake species ${info.species}${info.legendary ? ' (legendary)' : ''}`,
        subsets.map((s) => ({ id: s.join('+') || 'none', label: s.length ? `wake with ${s.join(' + ')}` : 'wake without seals', data: { seals: s } })),
        { decline: decline('not now: the guardian stays asleep') },
        { species: info.species, legendary: !!info.legendary, offers: info.offers, kept: info.kept },
        () => ({ options: subsets.map(() => true), extras: { decline: true } }),
        (a) => cb(extraOf(a) === 'decline' ? null : subsets[optIndex(a)]));
    });

    // ---- portal of zone 3 on a map with a sanctuary: fight the legendary, or go straight to overtime ----
    set('showSanctuaryPath', (r: any, species: number, cb: (path: string | null) => void) => {
      const paths = ['sanct', 'direct'];
      this.raise('sanctuaryPath', 'showSanctuaryPath', 'the sanctuary portal',
        [{ id: 'sanct', label: 'classic path: fight the legendary in the sanctuary', data: { species, countsForTimeTrial: true } },
         { id: 'direct', label: 'direct to overtime: no legendary fight', data: { countsForTimeTrial: false } }],
        { decline: decline('stay in the zone') },
        { species, competitive: !!r.competitive, sealsKept: r.seals?.kept ?? 0 },
        () => ({ options: [true, true], extras: { decline: true } }),
        (a) => cb(extraOf(a) === 'decline' ? null : paths[optIndex(a)]));
    });
    set('showLeaveSanctuary', (r: any, cb: (what: string | null) => void) => {
      const what = ['ot', 'leave'];
      // "ot" does not start overtime: the game then opens its overtime dialog (showOvertime) at the relit shrine, and
      // does nothing at all while the shrine has not relit yet (4.5 s after the legendary fell). Seen in real play.
      const relit = !!r?.interactables?.list?.some?.((i: any) => i?.kind === 'shrine' && i?.data?.ot);
      this.raise('leaveSanctuary', 'showLeaveSanctuary', 'leave without playing overtime?',
        [{ id: 'ot', label: 'go on to the overtime dialog (no effect until the shrine has relit)', data: { opensOvertimeDialog: relit } }, { id: 'leave', label: 'end the run now (victory)', data: {} }],
        { decline: decline('stay in the sanctuary') }, { shrineRelit: relit },
        () => ({ options: [true, true], extras: { decline: true } }),
        (a) => cb(extraOf(a) === 'decline' ? null : what[optIndex(a)]));
    });
    set('showOvertime', (r: any, cb: (start: boolean) => void) => {
      this.raise('overtimeStart', 'showOvertime', 'overtime',
        [{ id: 'start', label: 'start overtime', data: {} }],
        { decline: decline('not now') }, { sealsKept: r.seals?.kept ?? 0 },
        () => ({ options: [true], extras: { decline: true } }),
        (a) => cb(extraOf(a) !== 'decline'));
    });
    set('showOtOffer', (r: any, keys: string[], cb: (key: string | null) => void) => {
      const ot = r.overtime;
      this.raise('overtimeOffer', 'showOtOffer', `tide offering, round ${(ot?.round ?? 0) + 1}`,
        keys.map((k) => ({ id: k, label: k, data: { key: k } })),
        { decline: decline('take none') },
        { round: (ot?.round ?? 0) + 1, held: (ot?.picks ?? []).map((p: unknown[]) => p[0]), bonus: ot?.bonus ?? 0 },
        () => ({ options: keys.map(() => true), extras: { decline: true } }),
        (a) => cb(extraOf(a) === 'decline' ? null : keys[optIndex(a)]));
    });

    // ---- one-off trades (fossil ruins, Porygon altar, trick or treat) ----
    set('showTrade', (_r: any, info: { title: string; help: string; species: number; offers: any[] }, cb: (key: string | null) => void) => {
      this.raise('trade', 'showTrade', str(info.title),
        info.offers.map((o) => ({ id: str(o.key), label: str(o.name ?? o.key), data: data(o) })),
        { decline: decline('not now') }, { species: info.species, help: info.help },
        () => ({ options: info.offers.map((o) => !o.off), extras: { decline: true } }),
        (a) => cb(extraOf(a) === 'decline' ? null : info.offers[optIndex(a)].key));
    });

    // ---- shop: buy (stays open), restock (stays open), sell an owned item (a second list), leave ----
    const sellPrice = (r: any, key: string): number => F.sellPrice(r, F.items.get(key)?.rarity ?? 0);
    const sell = (r: any, close: () => void): void => {
      const items: [string, number][] = [...(r.player?.items ?? new Map()).entries()];
      this.raise('shopSell', 'showShop', 'shop: sell an owned item',
        items.map(([k, n]) => ({ id: k, label: k, data: { key: k, owned: n, refund: sellPrice(r, k), rarity: F.items.get(k)?.rarity ?? 0 } })),
        { leave: { needsTarget: false, effect: 'back to the shop' } },
        { gold: r.gold },
        () => ({ options: items.map(() => true), extras: { leave: true } }),
        (a) => {
          if (extraOf(a) === 'leave') { shop(r, close); return; }
          // The sell button's own statements (HANDLER_WRITES).
          const key = items[optIndex(a)][0], price = sellPrice(r, key);
          r.player.removeItem(key);
          r[F.runGainGold](price);
          r.econ.sold++;
          this.shopSold++;
          if (r.player.items.size) sell(r, close); else shop(r, close);
        });
    };
    const shop = (r: any, close: () => void): void => {
      const stock: any[] = r.shop?.stock ?? [];
      const canBuy = (e: any): boolean => !e.sold && r.gold >= e.price && !!r.player[N.playerCanTake](e.key);
      this.raise('shop', 'showShop', 'shop',
        stock.map((e) => ({ id: str(e.key), label: str(e.key), data: { key: e.key, price: e.price, sold: !!e.sold, owned: r.player?.items?.get?.(e.key) ?? 0 } })),
        { reroll: { needsTarget: false, effect: 'pay for a new stock' }, sell: { needsTarget: false, effect: 'open the list of owned items to sell one' }, leave: { needsTarget: false, effect: 'close the shop' } },
        { gold: r.gold, rerollCost: r[N.shopRerollCost]() },
        () => ({ options: stock.map(canBuy), extras: { reroll: r.gold >= r[N.shopRerollCost](), sell: (r.player?.items?.size ?? 0) > 0, leave: true } }),
        (a) => {
          const e = extraOf(a);
          if (e === 'leave') { close(); return; }
          if (e === 'sell') { sell(r, close); return; }
          const ok = e === 'reroll' ? r[N.shopReroll]() : r[N.shopBuy](stock[optIndex(a)]);
          if (!ok) this.failure ??= { method: 'showShop', reason: `the game refused a shop action the mask allowed (${e ?? 'buy ' + stock[optIndex(a)]?.key})`, args: summarize([stock]) };
          shop(r, close); // the window stays open, as in the game
        });
    };
    set('showShop', shop);

    // ---- Ditto: copy one owned item ----
    set('showDitto', (r: any, cb: (key: string | null) => void) => {
      const items: [string, number][] = [...(r.player?.items ?? new Map()).entries()];
      this.raise('ditto', 'showDitto', 'Ditto: which item to copy',
        items.map(([k, n]) => ({ id: k, label: k, data: { key: k, owned: n } })),
        { decline: decline('not now') }, {},
        () => ({ options: items.map(([k]) => !!r.player[N.playerCanTake](k)), extras: { decline: true } }),
        (a) => cb(extraOf(a) === 'decline' ? null : items[optIndex(a)][0]));
    });

    // ---- ally team is full: release one (not the shiny partner) or let the newcomer go ----
    set('showParty', (r: any, incoming: any, cb: (index: number) => void) => {
      const list: any[] = [...(r.allies?.list ?? [])];
      this.raise('party', 'showParty', `${str(incoming?.name, 'a Pokémon')} wants to join`,
        list.map((m, i) => ({ id: String(i), label: `release ${str(m?.name, '?')}`, data: { species: m?.species, name: m?.name, shiny: !!m?.shiny, bst: m?.bst } })),
        { decline: decline('the newcomer leaves') }, { incoming: { species: incoming?.species, name: incoming?.name, bst: incoming?.bst } },
        () => ({ options: list.map((m) => !m?.shiny), extras: { decline: true } }),
        (a) => cb(extraOf(a) === 'decline' ? -1 : optIndex(a)));
    });
    set('showShinySwap', (_r: any, current: any, incoming: any, _how: unknown, cb: (swap: boolean) => void) => {
      this.raise('shinySwap', 'showShinySwap', 'a second shiny partner',
        [{ id: 'swap', label: `replace ${str(current?.name, '?')} with ${str(incoming?.name, '?')}`, data: { current: current?.species, incoming: incoming?.species } }],
        { decline: decline('keep the current partner') }, {},
        () => ({ options: [true], extras: { decline: true } }),
        (a) => cb(extraOf(a) !== 'decline'));
    });

    // ---- relics: take one; with three held, the new one replaces a chosen slot ----
    set('relicChoice', (r: any, cards: any[], cb: (key: string | null, slot: number | null) => void) => {
      const held: string[] = [...(r.relicKeys ?? [])];
      const full = held.length >= 3;
      const picks = full ? cards.flatMap((c) => held.map((_, slot) => ({ c, slot: slot as number | null }))) : cards.map((c) => ({ c, slot: null as number | null }));
      this.raise('relic', 'relicChoice', 'rift relics',
        picks.map(({ c, slot }) => ({ id: slot === null ? str(c.key) : `${str(c.key)}@${slot}`, label: slot === null ? str(c.name ?? c.key) : `${str(c.name ?? c.key)} replacing ${held[slot]}`, data: { ...data(c), replaces: slot === null ? null : held[slot] } })),
        { decline: decline('take none') }, { held },
        () => ({ options: picks.map(() => true), extras: { decline: true } }),
        (a) => { if (extraOf(a) === 'decline') cb(null, null); else { const p = picks[optIndex(a)]; cb(p.c.key, p.slot); } });
    });

    // ---- Karate dojo: a trial (three are offered, one per belt), then the blessing to fight for; the trial itself is played ----
    set('showDojo', (r: any, trials: any[], stat: string, cb: (pick: { trial: unknown; stat: string } | null) => void) => {
      const prize = (trial: any): void => {
        const prizes: any[] = F.dojoPrizes(r, trial.belt);
        this.raise('dojoPrize', 'showDojo', `Karate dojo: the blessing of the ${str(trial.key)} trial`,
          prizes.map((p, i) => ({ id: str(p?.mods?.[0]?.stat, String(i)), label: str(p.label), data: data(p) })),
          { decline: decline('not now: close the dojo') }, { trial: { key: trial.key, belt: trial.belt }, lastStat: stat },
          () => ({ options: prizes.map(() => true), extras: { decline: true } }),
          (a) => cb(extraOf(a) === 'decline' ? null : { trial, stat: prizes[optIndex(a)].mods[0].stat }));
      };
      this.raise('dojo', 'showDojo', 'Karate dojo: choose a trial',
        trials.map((t) => ({ id: `${str(t.key)}:${t.belt}`, label: `${str(t.key)} (belt ${t.belt})`, data: { key: t.key, belt: t.belt, ...data(F.dojoParams(r, t)) } })),
        { decline: decline('not now: close the dojo') }, { lastStat: stat, onFailure: 'the dojo closes for the rest of the zone' },
        () => ({ options: trials.map(() => true), extras: { decline: true } }),
        (a) => { if (extraOf(a) === 'decline') cb(null); else prize(trials[optIndex(a)]); });
    });

    // ---- slot machine: one spin at a time (the dialog stays open after a spin without a prize), or leave ----
    const slots = (r: any, api: any, close: () => void): void => {
      this.raise('slots', 'showSlots', 'slot machine',
        [{ id: 'spin', label: 'spin once', data: { price: api.cost() } }],
        { leave: { needsTarget: false, effect: 'close the slot machine' } },
        {
          gold: r.gold, cost: api.cost(), spins: api.spins(), spinsUntilInsured: api.pity(), curseSpent: !!api.cursed(), last: this.lastSpin,
          notExposed: 'the ×10 batch and holding the key: the game gives them the price and the odds of the same number of single spins',
        },
        () => ({ options: [r.gold >= api.cost()], extras: { leave: true } }),
        async (a) => {
          if (extraOf(a) === 'leave') { this.lastSpin = null; close(); return; }
          // What the lever does: the game's own spin (it asks the game service for the draw), then its payout.
          const result = await api.spin();
          if (!result) { this.failure ??= { method: 'showSlots', reason: 'the game refused a spin the mask allowed', args: summarize([{ gold: r.gold, cost: api.cost() }]) }; return; }
          const paid = !!api.pay(result);
          this.lastSpin = { prize: result.prize, cost: result.cost, insured: !!result.insured };
          // A spin that pays an item (or sets off the Voltorb) closes the window, as the HUD does when the key is not held.
          if (paid) { this.lastSpin = null; close(); } else slots(r, api, close);
        });
    };
    set('showSlots', (r: any, api: any, close: () => void) => { this.lastSpin = null; slots(r, api, close); });

    // ---- Hypno: forget a move or a vitamin for Pokédollars; once per zone, a lesson for a free move slot ----
    const known = (r: any): Set<number> => {
      const ids = new Set<number>();
      for (const m of r.player.moves) if (m) { ids.add(m.def.id); for (const p of m.parents ?? []) ids.add(p); if (m.link) ids.add(m.link.def.id); }
      return ids;
    };
    const freeMoveSlot = (r: any): boolean => r.player.moves.some((m: unknown, i: number) => i < r.player.moveSlots && !m);
    const offerOption = (o: any): DecisionOption => ({ id: `${str(o.kind, '?')}:${str(o.key ?? o.id, '?')}`, label: str(o.name ?? o.title ?? o.key ?? o.id), data: data(o) });
    /** Open the lesson of this zone. False when the game has nothing to teach. */
    const lesson = (r: any, close: () => void): boolean => {
      const key = String(F.lessonKey(r)), have = known(r);
      const kept = this.lesson && this.lesson.run === r && this.lesson.key === key && !this.lesson.offers.some((o) => o.kind === 'newMove' && have.has(o.id)) ? this.lesson.offers : null;
      const offers: any[] = kept ?? F.lessonOffers(r, 3);
      if (!offers.length) return false;
      this.lesson = { run: r, key, offers };
      this.raise('lesson', 'showForget', "Hypno's lesson: a move for the free slot", offers.map(offerOption),
        { decline: decline('not now: the lesson is kept') }, { zoneKey: key },
        () => ({ options: offers.map((o) => !(o.kind === 'newMove' && known(r).has(o.id))), extras: { decline: true } }),
        (a) => {
          if (extraOf(a) !== 'decline') {
            // The offer card's own statements (HANDLER_WRITES).
            F.applyOffer(r, offers[optIndex(a)]);
            r.player.recompute();
            r.lessonAt = F.lessonKey(r);
            r.stats.lessons++;
          }
          hypno(r, close);
        });
      return true;
    };
    const hypno = (r: any, close: () => void): void => {
      const p = r.player;
      const moves: { m: any; i: number }[] = p.moves.map((m: any, i: number) => ({ m, i })).filter((x: { m: any; i: number }) => x.i < p.moveSlots && x.m);
      const vitamins: [string, any][] = [...(p.vitamins ?? new Map()).entries()];
      this.raise('forget', 'showForget', 'Hypno: forget a move or a vitamin',
        [
          ...moves.map(({ m, i }) => ({ id: `move:${i}`, label: `forget ${str(m.def.name ?? m.def.key)}`, data: { what: 'move', slot: i, key: m.def.key, level: m.level, refund: F.movePrice(r, m), fusion: !!m.def.fusion, linked: !!m.link } })),
          ...vitamins.map(([k, v]) => ({ id: `vitamin:${k}`, label: `forget ${k}`, data: { what: 'vitamin', key: k, level: v.level, refund: F.vitaminPrice(r, v) } })),
          { id: 'lesson', label: "take Hypno's lesson of this zone", data: { what: 'lesson' } },
        ],
        { leave: { needsTarget: false, effect: 'close' } },
        { gold: r.gold, lessonReady: !!F.lessonReady(r), freeMoveSlot: freeMoveSlot(r), rule: 'forgetting a move with the lesson ready opens the lesson at once' },
        () => ({ options: [...moves.map(() => moves.length > 1), ...vitamins.map(() => true), !!F.lessonReady(r) && freeMoveSlot(r)], extras: { leave: true } }),
        (a) => {
          if (extraOf(a) === 'leave') { close(); return; }
          const i = optIndex(a);
          if (i < moves.length) {
            F.forgetMove(r, moves[i].i);
            if (F.lessonReady(r) && lesson(r, close)) return;
          } else if (i < moves.length + vitamins.length) {
            F.forgetVitamin(r, vitamins[i - moves.length][0]);
          } else if (lesson(r, close)) return;
          hypno(r, close);
        });
    };
    set('showForget', (r: any, close: () => void) => hypno(r, close));

    // ---- Bill's fusion machine: fuse two moves into a new one, or link them (both keep firing); only ready pairs ----
    set(N.hudFusion, (r: any, list: any[], cb: (index: number | null, how?: string) => void) => {
      const picks: { i: number; how: 'fuse' | 'link' }[] = [];
      list.forEach((e, i) => { if (!e?.ready) return; picks.push({ i, how: 'fuse' }); if (e.boon) picks.push({ i, how: 'link' }); });
      const moveKey = (slot: number): string | null => r.player.moves[slot]?.def?.key ?? null;
      this.raise('fusion', N.hudFusion, "Bill's fusion machine",
        picks.map(({ i, how }) => {
          const e = list[i];
          return { id: `${how}:${e.a}+${e.b}`, label: `${how} ${str(e.names?.[0])} + ${str(e.names?.[1])}`, data: { how, a: e.a, b: e.b, moveA: moveKey(e.a), moveB: moveKey(e.b), recipe: str(e.r?.key), recipeKind: str(e.r?.kind) } };
        }),
        { leave: { needsTarget: false, effect: 'close without using it' } },
        { notReady: list.filter((e) => !e?.ready).map((e) => `${(e.names ?? []).map(String).join(' + ')}: ${(e.need ?? []).map(String).join('; ')}`), rule: 'a machine works once' },
        () => ({ options: picks.map(() => true), extras: { leave: true } }),
        (a) => { if (extraOf(a) === 'leave') cb(null); else { const p = picks[optIndex(a)]; cb(p.i, p.how); } });
    });

    // ---- refused: dialogs of other modes, the map and the pause menu ----
    const refuse = (name: string, label = name) => {
      if (typeof hud[name] !== 'function') return;
      hud[name] = (...args: unknown[]) => { this.failure ??= { method: label, reason: 'the environment has no rule for this dialog in the standard mode', args: summarize(args.slice(1)) }; };
      done.push(name);
    };
    for (const name of ['showPact', 'showBadges', 'showExpInventory', 'showTraining', 'showRelayRecruit', 'showMap']) refuse(name);
    refuse(N.hudPause, 'pause menu');

    // ---- anything else that opens a window while the run is live ----
    const modal = hud.modal;
    hud.modal = (...args: unknown[]) => {
      if (this.run?.state === 'over') return modal.apply(hud, args); // the game's own end-of-run screen
      this.failure ??= { method: 'modal', reason: 'a window was opened by a HUD method the environment does not know', args: summarize(args), stack: String(new Error().stack).split('\n').slice(2, 7).join('\n') };
      return modal.apply(hud, args);
    };
    done.push('modal');
    return done;
  }
}
