/**
 * What the watch page is sent about a run (scripts/watch.ts): a small frame for every decision of play, and the
 * build whenever it changes. Pure functions of an observation, so they are tested without a game.
 *
 * Positions are metres on the ground (x to the right, z down the page), rounded to a tenth.
 */
import { E_FLAGS, E_R, E_X, E_Z, EF } from '../observations/snapshot.ts';
import type { Observation } from '../environment/types.ts';
import type { Knowledge } from '../player/values.ts';

const r1 = (v: number): number => Math.round(v * 10) / 10;

/** An enemy's class on the map: 0 ordinary, 1 elite, 2 Alpha, totem or summoner, 3 guardian, 4 a thing to catch or open. */
export const enemyClass = (flags: number): number =>
  flags & EF.Boss ? 3 : flags & (EF.Capture | EF.Treasure | EF.Object) ? 4 : flags & (EF.Alpha | EF.Totem | EF.Summoner) ? 2 : flags & EF.Elite ? 1 : 0;

export interface Frame {
  /** The run clock, the zone and its clock, in seconds. */
  t: number; zone: number; zoneT: number;
  /** Guardian: asleep, awake or fallen. */
  guardian: 'asleep' | 'awake' | 'fallen';
  swarm: boolean; swarmT: number; collapse: number; sanctuary: boolean; rift: boolean;
  ot: { live: boolean; round: number; left: number; bonus: number; drain: number } | null;
  kills: number; gold: number; incense: number;
  p: { x: number; z: number; hp: number; maxHp: number; shield: number; level: number; xp: number };
  /** Enemies as x, z, radius, class, one after another. */
  e: number[]; enemies: number;
  /** Hostile shots (x, z, radius) and ground hazards (x, z, radius). */
  shots: number[]; hazards: number[];
  boss: { x: number; z: number; hp: number; maxHp: number; name: string } | null;
  points: { kind: string; x: number; z: number; r: number; used: boolean }[];
  entrance: { x: number; z: number } | null;
  /** Where the player is heading, and why. */
  goal: { x: number; z: number; kind: string } | null;
  intent: string; note: string;
}

export function frameOf(obs: Pick<Observation, 'snapshot' | 'state'>, now: { intent: string; note: string; goal?: { x: number; z: number; kind: string } | null }): Frame {
  const s = obs.snapshot, st = obs.state, o = st.overtime;
  const e: number[] = [];
  for (const x of s.enemies?.list ?? []) e.push(r1(x[E_X]), r1(x[E_Z]), r1(x[E_R]), enemyClass(x[E_FLAGS]));
  const shots: number[] = [], hazards: number[] = [];
  for (const b of s.shots ?? []) shots.push(r1(b[0]), r1(b[1]), r1(b[4]));
  for (const h of s.hazards ?? []) hazards.push(r1(h.x), r1(h.z), r1(h.r));
  const up = !!s.boss && s.bossSpawned && !s.stageCleared;
  return {
    t: r1(s.t), zone: s.stage, zoneT: r1(s.stageTime),
    guardian: s.stageCleared ? 'fallen' : s.bossSpawned ? 'awake' : 'asleep',
    swarm: st.zone.finalSwarm, swarmT: Math.round(st.zone.finalSwarmSeconds), collapse: r1(st.zone.collapseDrain), sanctuary: st.zone.inSanctuary, rift: s.rift.inside,
    ot: o.live || o.over ? { live: o.live, round: o.round, left: Math.round(o.roundTimeLeft), bonus: Math.round(o.bonus), drain: r1(o.drain) } : null,
    kills: s.kills, gold: s.gold, incense: st.rift.incense,
    p: { x: r1(s.player.x), z: r1(s.player.z), hp: Math.round(s.player.hp), maxHp: Math.round(s.player.maxHp), shield: Math.round(s.player.shield), level: s.player.level, xp: s.player.xpNext > 0 ? Math.round(100 * s.player.xp / s.player.xpNext) / 100 : 0 },
    e, enemies: s.enemies?.count ?? 0, shots, hazards,
    boss: up && s.boss ? { x: r1(s.boss.x), z: r1(s.boss.z), hp: Math.round(s.boss.hp), maxHp: Math.round(s.boss.maxHp), name: s.boss.name } : null,
    points: (s.points ?? []).map((q) => ({ kind: q.kind, x: r1(q.x), z: r1(q.z), r: r1(q.r), used: q.used })),
    entrance: s.rift.entrance,
    goal: now.goal ? { x: r1(now.goal.x), z: r1(now.goal.z), kind: now.goal.kind } : null,
    intent: now.intent, note: now.note,
  };
}

/** The build as the page lists it. It changes at dialogs, so it is sent only when `key` differs from the last one sent. */
export interface BuildView {
  key: string;
  moves: { name: string; level: number; linked: string | null; fusion: boolean }[];
  vitamins: { name: string; level: number }[];
  /** Items, most held first. */
  items: { name: string; count: number }[]; itemCount: number;
  relics: string[];
  /** The stats a score follows, as the game holds them. */
  stats: { name: string; value: number }[];
  revives: number;
}

const STATS: [key: string, name: string][] = [
  ['damage', 'Damage'], ['special', 'Special'], ['physical', 'Physical'], ['critDamage', 'Crit damage'], ['attackSpeed', 'Attack speed'], ['area', 'Area'],
  ['maxHp', 'Max HP'], ['armor', 'Armor'], ['healing', 'Healing'], ['luck', 'Luck'], ['xpGain', 'Experience'], ['gold', 'Pokédollars'],
];
const title = (key: string): string => key.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

export function buildOf(obs: Pick<Observation, 'snapshot' | 'state'>, k: Pick<Knowledge, 'items' | 'vitamins'>): BuildView {
  const b = obs.state.build, stats = obs.snapshot.player.stats ?? {};
  const named = new Map((obs.snapshot.player.moves ?? []).map((m) => [m.key, m.name]));
  const moves = b.moves.filter((m) => !!m).map((m) => ({ name: named.get(m!.key) || title(m!.key), level: m!.level, linked: m!.linked ? title(m!.linked) : null, fusion: !!m!.fusion }));
  const vitamins = b.vitamins.map((v) => ({ name: k.vitamins.get(v.key)?.name ?? title(v.key), level: v.level }));
  const items = b.items.map((it) => ({ name: k.items.get(it.key)?.name ?? title(it.key), count: it.count })).sort((x, y) => y.count - x.count || x.name.localeCompare(y.name));
  const shown = STATS.filter(([key]) => typeof stats[key] === 'number').map(([key, name]) => ({ name, value: Math.round(stats[key] * 100) / 100 }));
  const view = { moves, vitamins, items, itemCount: items.reduce((n, it) => n + it.count, 0), relics: b.relics.map(title), stats: shown, revives: b.revives };
  return { key: JSON.stringify(view), ...view };
}
