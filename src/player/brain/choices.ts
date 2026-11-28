import type { Snapshot, UiModal, UiOption } from '../../observations/snapshot.ts';
import type { Build } from './builds.ts';
import type { Tuning } from './tuning.ts';

/**
 * Picks for the game's dialogs (level-up offers, item and blessing choices, shops). Pure functions of the dialog as
 * read from the DOM plus the snapshot.
 */

export interface Pick {
  /** Index into modal.options, or -1 when an action button is used instead. */
  option: number;
  /** Index into modal.actions when `option` is -1. */
  action: number;
  reason: string;
  score: number;
}

const SURVIVE = /\b(max(imum)? hp|regen|armor|armour|shield|heal|evasion|lifesteal|life steal|revive|defen[cs]e|dodge|recover)/i;
const DAMAGE = /\b(damage|area|attack speed|cooldown|crit|projectile|pierce|duration|special|physical|status|burn|poison|super effective|elite)/i;
const UTILITY = /\b(experience|xp|luck|pok[eé]dollars?|gold|pickup|magnet|move speed|speed|jump)/i;
const RARITY: Record<string, number> = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4, mythic: 4 };

export type OfferKind = 'move-upgrade' | 'move-new' | 'vitamin-upgrade' | 'vitamin-new' | 'item' | 'other';

export interface OfferInfo {
  kind: OfferKind;
  name: string;
  /** Position in the build's core list, -1 when it is not part of the plan. */
  coreRank: number;
  rarity: number;
  /** What the card does, lower case: the effect lines when the card has them, else its whole text. */
  effects: string;
  survive: boolean;
  damage: boolean;
  utility: boolean;
}

/** Understand one offer card. Works from the card's parts when the DOM reader found them, else from its text. */
export function readOffer(o: UiOption, s: Snapshot | null, build: Build): OfferInfo {
  const text = o.text;
  const name = (o.name || text.split(/[·\n(]/)[0]).trim().slice(0, 48);
  const lname = name.toLowerCase();
  const sub = (o.sub ?? '').toLowerCase(), tag = (o.tag ?? '').toLowerCase();
  const owned = s?.player.moves.some((m) => m.name.toLowerCase() === lname || (!o.name && text.toLowerCase().includes(m.name.toLowerCase()))) ?? false;
  const coreRank = build.core.findIndex((n) => n.toLowerCase() === lname || (!o.name && text.toLowerCase().includes(n.toLowerCase())));
  const upgrade = tag === 'upgrade' || /level\s*\d+\s*(→|->)\s*\d+/i.test(sub) || owned;
  let kind: OfferKind = 'other';
  if (/move|attack/.test(sub) || (o.rarity ?? '').toLowerCase() === 'move' || owned || coreRank >= 0) kind = upgrade && (owned || !/new/.test(sub)) ? 'move-upgrade' : 'move-new';
  else if (/vitamin/.test(sub)) kind = 'vitamin-new';
  else if (/item|held|berry/.test(sub)) kind = 'item';
  else if (upgrade) kind = 'vitamin-upgrade';
  else if (tag === 'new') kind = 'vitamin-new';
  const effects = (o.effects?.length ? o.effects.join(' · ') : text).toLowerCase();
  return {
    kind, name, coreRank, rarity: RARITY[(o.rarity ?? '').toLowerCase()] ?? 0, effects,
    survive: SURVIVE.test(effects), damage: DAMAGE.test(effects), utility: UTILITY.test(effects),
  };
}

export function scoreOffer(o: UiOption, s: Snapshot | null, build: Build, t: Tuning): { score: number; why: string; info: OfferInfo } {
  const info = readOffer(o, s, build);
  const hpFrac = s && s.player.maxHp > 0 ? s.player.hp / s.player.maxHp : 1;
  const level = s?.player.level ?? 1;
  // The hardest hit around, as a share of the HP bar: fragile builds need defence before they are hurt.
  const hit = s && s.player.maxHp > 0 ? s.enemies.list.reduce((a, e) => Math.max(a, e[8]), 0) / s.player.maxHp : 0;
  const moveSlot = s ? s.player.moves.length < s.player.moveSlots : true;
  const vitSlot = s ? Object.keys(s.player.vitamins).length < (s.player.vitaminSlots || 3) : true;
  const scaleRank = build.scale.findIndex((k) => info.effects.includes(k));
  let score = 20, why = 'filler';

  // What the effect is worth to this build, whatever carries it.
  const effect = (): [number, string] => {
    if (scaleRank >= 0) return [64 - scaleRank * 3, `scales with ${build.scale[scaleRank]}`];
    if (info.damage) return [50, 'damage'];
    if (info.utility) return [level < 15 ? 42 : 26, 'utility'];
    return [22, 'filler'];
  };

  switch (info.kind) {
    case 'move-upgrade':
      // Levelling what the build is made of beats anything new.
      if (info.coreRank >= 0) { score = 100 - info.coreRank * 2; why = `upgrade core move ${info.name}`; }
      else { score = 74; why = `upgrade ${info.name}`; }
      break;
    case 'move-new':
      if (info.coreRank >= 0 && moveSlot) { score = 92 - info.coreRank * 3; why = `core move ${info.name}`; }
      else if (moveSlot) { score = level < 8 ? 60 : 40; why = `new move ${info.name} (situational)`; }
      else { score = 12; why = 'new move, no slot'; }
      break;
    case 'vitamin-upgrade': { const [v, w] = effect(); score = v + 6; why = `upgrade ${info.name}: ${w}`; break; }
    case 'vitamin-new': {
      const [v, w] = effect();
      // Vitamin slots are few: a new one has to be worth a slot.
      score = vitSlot ? v : 10;
      why = vitSlot ? `${info.name}: ${w}` : `${info.name}: no vitamin slot`;
      break;
    }
    default: { const [v, w] = effect(); score = v; why = `${info.name}: ${w}`; }
  }

  // Survivability is a pick of need: it jumps the queue when hurt and waits its turn otherwise.
  if (info.survive && info.kind !== 'move-upgrade' && !(info.kind === 'move-new' && info.coreRank >= 0)) {
    if (hpFrac < t.surviveHp) { score = Math.max(score, 88); why = `${info.name}: survive (hp ${(hpFrac * 100) | 0}%)`; }
    else if (hit > t.surviveHit) { score = Math.max(score, 70); why = `${info.name}: survive (one hit takes ${(hit * 100) | 0}% of HP)`; }
    else if (scaleRank < 0 && !info.damage) { score = Math.min(score, 34); why = `${info.name}: survivability, not needed`; }
  }
  if (build.avoid.some((k) => info.effects.includes(k))) { score -= 30; why += ', avoided by build'; }
  score += info.rarity * 3;
  if (o.disabled) score = -100;
  return { score, why, info };
}

const actionIndex = (m: UiModal, re: RegExp) => m.actions.findIndex((a) => !a.disabled && re.test(a.text));
/** "Refresh (2) F" → 2. A button without a counter counts as available. */
const usesLeft = (text: string) => { const n = /\((\d+)\)/.exec(text); return n ? Number(n[1]) : 1; };

/** Choose among level-up offers; refresh a weak hand when a refresh is left. */
export function pickLevelUp(m: UiModal, s: Snapshot | null, build: Build, t: Tuning): Pick {
  let best = -1, bestScore = -Infinity, why = '';
  m.options.forEach((o, i) => { const r = scoreOffer(o, s, build, t); if (r.score > bestScore) { bestScore = r.score; best = i; why = r.why; } });
  if (best < 0) {
    const a = actionIndex(m, /skip|continue|close|ok|accept|done/i);
    return { option: -1, action: a >= 0 ? a : 0, reason: 'nothing to choose', score: 0 };
  }
  if (bestScore < t.rerollBelow) {
    const re = actionIndex(m, /refresh|reroll/i);
    if (re >= 0 && usesLeft(m.actions[re].text) > 0) return { option: -1, action: re, reason: `weak hand (best ${Math.round(bestScore)}): refresh`, score: bestScore };
  }
  return { option: best, action: -1, reason: why, score: bestScore };
}

const NEVER = /give up|restart|delete|reset|log ?out|report|save and quit|view my team|sell|glossary|settings|banish|fullscreen/i;

/**
 * Any other dialog. One card with buttons under it is a notice ("You found an item!"): answer with its button.
 * Several cards: best score the gold covers. No cards: the button that moves the run on, never a destructive one.
 * Returns null when the dialog should be left alone.
 */
export function pickGeneric(m: UiModal, s: Snapshot | null, build: Build, t: Tuning): Pick | null {
  // Optional handicaps (challenge seals, pacts: a harder fight for more reward). Survival first: decline them.
  const plain = m.actions.findIndex((a) => !a.disabled && /without seals|no seals|decline|no pact/i.test(a.text));
  if (plain >= 0) return { option: -1, action: plain, reason: 'no handicaps: survival first', score: 0 };
  if (m.options.some((o) => /\b(pact|seal|curse)\b/.test(o.cls))) {
    const no = m.actions.findIndex((a) => !a.disabled && /not now|skip|none|no thanks|refuse|leave/i.test(a.text));
    if (no >= 0) return { option: -1, action: no, reason: 'optional handicap declined', score: 0 };
  }
  const take =m.actions.findIndex((a) => !a.disabled && /^(take|equip|learn|keep|accept|claim|open|buy)/i.test(a.text));
  if (m.options.length <= 1 && take >= 0) return { option: -1, action: take, reason: `take "${(m.options[0]?.name || m.options[0]?.text || m.title).slice(0, 30)}"`, score: 0 };
  if (m.options.length) {
    let best = -1, bestScore = -Infinity, why = '';
    m.options.forEach((o, i) => {
      const r = scoreOffer(o, s, build, t);
      // A price on the card ("120 ₽") the run cannot pay rules it out.
      const price = /(\d[\d.,]*)\s*₽/.exec(o.text);
      if (price && s && Number(price[1].replace(/[.,]/g, '')) > s.gold) r.score = -50;
      if (r.score > bestScore) { bestScore = r.score; best = i; why = r.why; }
    });
    if (best >= 0 && bestScore > 0) return { option: best, action: -1, reason: why, score: bestScore };
  }
  const order = [/^continue|resume|keep playing|back to the choice/i, /accept|confirm|^ok|^yes|got it|understood|claim|take|choose|start now|let'?s go|next|done/i, /skip|close|leave|exit|back|later|no thanks|cancel/i];
  for (const re of order) {
    const a = m.actions.findIndex((x) => !x.disabled && re.test(x.text) && !NEVER.test(x.text));
    if (a >= 0) return { option: -1, action: a, reason: `button "${m.actions[a].text.slice(0, 24)}"`, score: 0 };
  }
  return null;
}
