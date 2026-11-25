import { createHash } from 'node:crypto';
import { scoreLevelUp2, worthNow } from '../agents/heuristic2/chooser.ts';
import { heaviestHit, hordeHit, hpLost, lowestHp, spawnEstimate, wakeAfter } from '../agents/heuristic2/policy.ts';
import { itemWorth, textMultiplier, vitaminWorth } from '../agents/heuristic2/values.ts';
import type { StatMod } from '../agents/heuristic2/values.ts';
import { loadKnowledge } from '../knowledge/load.ts';
import type { EncoderKnowledge } from '../knowledge/load.ts';
import { ObservationEncoder, applyScale } from '../observations/encode.ts';
import type { LayoutSegment, Scale } from '../observations/encode.ts';
import { M_ACTIONS, M_OPTION_BASE, M_OPTION_SLOTS, M_PLAY_BASE, USE_KINDS, actionNames, managerActionLayout, useId } from './actions.ts';
import { loadRegistry, registryKnowledge } from './ids.ts';
import type { IdRegistry } from './ids.ts';
import type { ManagerEnvironment, ManagerObservation } from './manager.ts';
import { portalPoint, wakePoint } from './skills.ts';

/**
 * The manager's observation (phase 2 of the heuristic + RL refactor), version 1.
 *
 *   kept from the low-level encoding (src/observations/encode.ts, with 144 dialog-option rows and the registry's
 *   append-only ids): global, stats, density, xp, moves, vitamins, items, relics, choice, options, and the id
 *   segments ids, move_slots, option_entity
 *   left out: the lists a manager does not steer by (single enemies, shots, hazards, pickups, terrain, the 16 nearest
 *   map points)
 *   added:
 *     mgr         figures at Overtime sizes (the low-level scales are flat from 100,000 KOs and level 150 on), the
 *                 survival figures (overheal held, lifesteal budget, tide, the horde's hit, HP history, revives), the
 *                 plan's clocks, the guardian's altar and the portal, the build's caps
 *     proposal    the heuristic's action here, one-hot over the action table
 *     prev_play   the manager's previous skill, one-hot
 *     kinds       per map point kind a `use` skill exists for: possible now, how many unused, the nearest
 *     option_fx   per dialog option: the heuristic's score and what the offered item, vitamin or move DOES in numbers
 *                 (its worth to the build, up to three stat changes, type bonus, a move's damage and cooldown)
 *     option_fx_stats   the stats those changes are of (ids)
 *
 * The layout carries two hashes. `hash` is over everything, names included: it identifies the layout exactly. `compat`
 * is over what a network depends on (segments, shapes, scales, table capacities, the action table's size): it stays
 * the same when a later game build adds keys to the registry within its capacities, and a model is refused only when
 * `compat` differs or the registry it was trained with is not a prefix of the current one.
 */
export const MANAGER_OBS_VERSION = 1;

const KEPT_FLOAT = ['global', 'stats', 'density', 'xp', 'moves', 'vitamins', 'items', 'relics', 'choice', 'options'] as const;
const KEPT_INT = ['ids', 'move_slots', 'option_entity'] as const;
const FX_MODS = 3;

const BOOL: Scale = { kind: 'bool' };
const unit = (max: number): Scale => ({ kind: 'unit', max });
const sym = (max: number): Scale => ({ kind: 'sym', max });
const log = (max: number): Scale => ({ kind: 'log', max });
const slog = (max: number): Scale => ({ kind: 'slog', max });

interface Feature<C> { name: string; scale: Scale; raw: (c: C) => number | boolean }
const f = <C>(name: string, scale: Scale, raw: (c: C) => number | boolean): Feature<C> => ({ name, scale, raw });

interface Ctx {
  m: ManagerObservation; mgr: ManagerEnvironment;
  fig: { overheal: number; leechBudget: number; referenceHp: number; spawnMultiplier: number; roars: number };
  maxHp: number;
}
interface Fx { score: number; junk: boolean; value: number; risk: number; proposed: boolean; typeShare: number; textLn: number; damage: number; cooldown: number; special: boolean; kitType: number; mods: StatMod[] }
interface KindRow { available: boolean; count: number; d: number; dx: number; dz: number; cost: number }

export interface ManagerLayout {
  version: number;
  build: string;
  /** Hash of the low-level layout the kept segments are cut from. */
  base: string;
  action: { version: number; size: number; hash: string };
  capacities: Record<string, number>;
  floatSize: number;
  intSize: number;
  segments: LayoutSegment[];
  compat: string;
  hash: string;
}

export class ManagerEncoder {
  readonly layout: ManagerLayout;
  readonly registry: IdRegistry;
  private readonly base: ObservationEncoder;
  private readonly k: EncoderKnowledge;
  private readonly copies: { from: number; to: number; n: number; int: boolean }[] = [];
  private readonly mgrF: Feature<Ctx>[];
  private readonly fxF: Feature<Fx>[];
  private readonly kindF: Feature<KindRow>[];
  private readonly off: Record<string, number> = {};
  private floatSize = 0;
  private intSize = 0;
  /** The manager's previous skill (an action id from M_PLAY_BASE on), and how often it took the proposal. */
  private prevPlay = -1;
  private prevFollowed = false;
  private decisions = 0;
  private followed = 0;

  constructor(build: string, registry: IdRegistry = loadRegistry()) {
    this.registry = registry;
    this.k = registryKnowledge(loadKnowledge(build), registry);
    this.base = new ObservationEncoder(this.k, { optionSlots: M_OPTION_SLOTS });
    const B = this.base.layout, segments: LayoutSegment[] = [];
    const keep = (name: string, int: boolean): void => {
      const seg = B.segments.find((x) => x.name === name);
      if (!seg) throw new Error(`manager observation: the low-level layout has no segment "${name}"`);
      const n = seg.shape[0] * seg.shape[1], to = int ? this.intSize : this.floatSize;
      this.copies.push({ from: seg.offset, to, n, int });
      segments.push({ ...seg, offset: to });
      if (int) this.intSize += n; else this.floatSize += n;
    };
    const add = (name: string, rows: number, features: { name: string; scale?: Scale; vocab?: string }[], note: string, int = false): void => {
      const to = int ? this.intSize : this.floatSize;
      this.off[name] = to;
      segments.push({ name, dtype: int ? 'int32' : 'float32', offset: to, shape: [rows, features.length], note, features });
      if (int) this.intSize += rows * features.length; else this.floatSize += rows * features.length;
    };
    for (const name of KEPT_FLOAT) keep(name, false);

    const plan = (c: Ctx) => c.mgr.advisor.plan, life = (c: Ctx) => c.mgr.advisor.life, s = (c: Ctx) => c.m.obs.snapshot, st = (c: Ctx) => c.m.obs.state;
    const has = (c: Ctx, key: string): boolean => st(c).build.items.some((it) => it.key === key && it.count > 0);
    const cap = (c: Ctx): number => 8 + (has(c, 'tm-case') ? 2 : 0);
    const sleeping = (c: Ctx): boolean => !s(c).bossSpawned && !s(c).stageCleared;
    this.mgrF = [
      // The low-level scales stop at 100,000 KOs, level 150 and 5,000 max HP: these go on.
      f('kills_big', log(1e8), (c) => st(c).counters.kills),
      f('overtime_bonus_big', log(1e8), (c) => st(c).overtime.bonus),
      f('level_big', log(20000), (c) => st(c).build.level),
      f('max_hp_big', log(1e6), (c) => s(c).player.maxHp),
      f('gold_big', log(1e8), (c) => s(c).gold),
      f('run_time_big', unit(7200), (c) => st(c).zone.time),
      f('guardian_max_hp_big', log(1e13), (c) => st(c).guardian.maxHp),
      // Survival: what the tide and the collapse take a second, and what stands against them.
      f('tide_frac_big', log(20), (c) => st(c).overtime.drain / c.maxHp),
      f('tide_hp', log(1e6), (c) => st(c).overtime.drain),
      f('collapse_frac_big', log(20), (c) => st(c).zone.collapseDrain / c.maxHp),
      f('reference_hp', log(1e5), (c) => c.fig.referenceHp),
      f('overheal_frac', unit(1), (c) => c.fig.overheal / c.maxHp),
      f('lifesteal_budget_frac', unit(1), (c) => c.fig.leechBudget / (0.08 * c.maxHp)),
      f('spawn_multiplier', unit(3), (c) => c.fig.spawnMultiplier),
      f('spawn_estimate', unit(8), (c) => spawnEstimate(s(c), st(c), c.mgr.advisor.knowledge, life(c).gengar)),
      f('horde_hit', log(20), (c) => hordeHit(s(c))),
      f('hp_lowest_20s', unit(1), (c) => lowestHp(life(c), s(c).t, 20)),
      f('hp_lost_4s', unit(2), (c) => hpLost(life(c), s(c).t, 4)),
      f('heaviest_hit_20s', unit(2), (c) => heaviestHit(life(c), s(c).t, 20)),
      f('revives_held', unit(5), (c) => st(c).build.revives),
      f('revive_spent_since_cleared', BOOL, (c) => life(c).revivedAt >= (life(c).clearedAt ?? Infinity)),
      f('revive_spent_in_overtime', BOOL, (c) => life(c).revivedAt >= (life(c).otAt ?? Infinity)),
      // The plan's clocks.
      f('guardian_asleep', BOOL, sleeping),
      f('wake_due', BOOL, (c) => sleeping(c) && s(c).stage < 4 && s(c).stageTime >= wakeAfter(plan(c), s(c).stage)),
      f('wake_in', sym(600), (c) => (sleeping(c) && s(c).stage < 4 ? wakeAfter(plan(c), s(c).stage) - s(c).stageTime : 0)),
      f('swarm_in', sym(600), (c) => (s(c).stage < 4 ? 600 - s(c).stageTime : 0)),
      f('collapse_in', sym(1200), (c) => (s(c).stage < 4 ? 1080 - s(c).stageTime : 0)),
      f('plan_leaving', BOOL, (c) => life(c).leaving.has(s(c).stage)),
      f('plan_cashing', BOOL, (c) => life(c).cashing),
      f('rhydon_roars', unit(3), (c) => c.fig.roars),
      f('points_given_up', unit(20), (c) => life(c).skip.size + c.mgr.skippedPoints.size),
      // The guardian's altar (the shrine in the sanctuary) and the portal.
      f('altar_present', BOOL, (c) => !!wakePoint(s(c))),
      f('altar_dist', log(400), (c) => wakePoint(s(c))?.d ?? 0),
      f('altar_dx', sym(200), (c) => { const q = wakePoint(s(c)); return q ? q.x - s(c).player.x : 0; }),
      f('altar_dz', sym(200), (c) => { const q = wakePoint(s(c)); return q ? q.z - s(c).player.z : 0; }),
      f('portal_present', BOOL, (c) => !!portalPoint(s(c))),
      f('portal_dist', log(400), (c) => portalPoint(s(c))?.d ?? 0),
      f('portal_dx', sym(200), (c) => { const q = portalPoint(s(c)); return q ? q.x - s(c).player.x : 0; }),
      f('portal_dz', sym(200), (c) => { const q = portalPoint(s(c)); return q ? q.z - s(c).player.z : 0; }),
      // The build's caps: moves go to level 10 with a TM Case (fusions to ★6), vitamins to 12 with a Max Ether.
      f('items_total', log(2000), (c) => st(c).build.items.reduce((a, it) => a + it.count, 0)),
      f('items_distinct', unit(M_OPTION_SLOTS), (c) => st(c).build.items.length),
      f('tm_case', BOOL, (c) => has(c, 'tm-case')),
      f('max_ether', BOOL, (c) => has(c, 'max-ether')),
      f('move_level_cap', unit(10), cap),
      f('moves_at_cap', unit(4), (c) => st(c).build.moves.filter((m) => m && !m.fusion && m.level >= cap(c)).length),
      f('moves_at_8', unit(4), (c) => st(c).build.moves.filter((m) => m && !m.fusion && m.level >= 8).length),
      f('moves_fused', unit(4), (c) => st(c).build.moves.filter((m) => m && (m.fusion || m.linked)).length),
      // The manager's own record in this episode.
      f('prev_followed', BOOL, () => this.prevFollowed),
      f('followed_share', unit(1), () => (this.decisions ? this.followed / this.decisions : 1)),
    ];
    add('mgr', 1, this.mgrF, 'figures at Overtime sizes, the survival figures, the plan\'s clocks, the altar and the portal, the build\'s caps, the manager\'s own record');
    const names = actionNames();
    add('proposal', 1, names.map((n) => ({ name: `proposal:${n}`, scale: BOOL })), 'the heuristic\'s action here, one-hot over the action table (all zero when the episode is over)');
    add('prev_play', 1, names.slice(M_PLAY_BASE).map((n) => ({ name: `prev:${n}`, scale: BOOL })), 'the manager\'s previous skill, one-hot over the play actions (all zero before the first one)');
    this.kindF = [
      f('available', BOOL, (e) => e.available), f('unused', unit(20), (e) => e.count), f('dist', log(400), (e) => e.d),
      f('dx', sym(200), (e) => e.dx), f('dz', sym(200), (e) => e.dz), f('cost', log(1e8), (e) => e.cost),
    ];
    add('kinds', 1, USE_KINDS.flatMap((kind) => this.kindF.map((x) => ({ name: `${kind}:${x.name}`, scale: x.scale }))), 'per map point kind with a `use` skill (in action-id order): possible now, unused points of the kind, the nearest unused one, its price');
    for (const name of KEPT_INT) keep(name, true);
    this.fxF = [
      f('present', BOOL, () => true), f('score', unit(100), (e) => e.score), f('junk', BOOL, (e) => e.junk), f('value', slog(200), (e) => e.value), f('risk', slog(200), (e) => e.risk),
      f('proposed', BOOL, (e) => e.proposed), f('type_share', unit(1), (e) => e.typeShare), f('text_multiplier_ln', sym(1.5), (e) => e.textLn),
      f('move_damage', log(500), (e) => e.damage), f('move_cooldown', unit(20), (e) => e.cooldown), f('move_special', BOOL, (e) => e.special), f('move_kit_type', unit(1), (e) => e.kitType),
      ...Array.from({ length: FX_MODS }, (_, i) => [
        f<Fx>(`mod${i + 1}_mul_ln`, sym(1.5), (e) => { const m = e.mods[i]?.mul; return m && m > 0 ? Math.log(m) : 0; }),
        f<Fx>(`mod${i + 1}_add`, slog(200), (e) => e.mods[i]?.add ?? 0),
      ]).flat(),
    ];
    // (the float segment is declared after the kept int segments only in this list; offsets are per dtype)
    const fxTo = this.floatSize;
    this.off.option_fx = fxTo;
    segments.push({ name: 'option_fx', dtype: 'float32', offset: fxTo, shape: [M_OPTION_SLOTS, this.fxF.length], note: 'per option of the open dialog (row = option index): the heuristic\'s score, and the numeric effect of the item, vitamin or move offered', features: this.fxF.map((x) => ({ name: x.name, scale: x.scale })) });
    this.floatSize += M_OPTION_SLOTS * this.fxF.length;
    add('option_fx_stats', M_OPTION_SLOTS, Array.from({ length: FX_MODS }, (_, i) => ({ name: `mod${i + 1}_stat`, vocab: 'stat' })), 'the stat each of the option\'s changes is of (0 = none)', true);

    const A = managerActionLayout();
    const capacities = Object.fromEntries(Object.entries(registry.tables).map(([n, t]) => [n, t.capacity]));
    const shape = segments.map((x) => ({ name: x.name, dtype: x.dtype, offset: x.offset, shape: x.shape, scales: x.features.map((y) => y.scale ?? y.vocab) }));
    const compat = createHash('sha256').update(JSON.stringify({ version: MANAGER_OBS_VERSION, shape, capacities, actions: A.size, actionVersion: A.version })).digest('hex');
    const body = { version: MANAGER_OBS_VERSION, build, base: B.hash, action: { version: A.version, size: A.size, hash: A.hash }, capacities, floatSize: this.floatSize, intSize: this.intSize, segments, compat };
    this.layout = { ...body, hash: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
  }

  reset(): void { this.prevPlay = -1; this.prevFollowed = false; this.decisions = 0; this.followed = 0; }

  /** The manager took `id` on `cur`. */
  acted(id: number, cur: ManagerObservation): void {
    this.decisions++;
    this.prevFollowed = id === cur.proposal;
    if (this.prevFollowed) this.followed++;
    if (id >= M_PLAY_BASE) this.prevPlay = id;
  }

  private fx(c: Ctx): (Fx | null)[] {
    const d = c.m.obs.decision;
    if (c.m.phase !== 'choice' || !d) return [];
    const snap = c.m.obs.snapshot, adv = c.mgr.advisor, ctx = adv.context(snap.player.species), K = adv.knowledge, kit = ctx.kit;
    const blank = (): Fx => ({ score: 0, junk: false, value: 0, risk: 0, proposed: false, typeShare: 0, textLn: 0, damage: 0, cooldown: 0, special: false, kitType: 0, mods: [] });
    return d.options.map((opt, i) => {
      const e = blank(), x = opt.data as Record<string, unknown>;
      e.proposed = c.m.proposal === M_OPTION_BASE + i;
      const move = (key: string | undefined, id?: number): void => {
        const info = (key ? K.moves.get(key) : undefined) ?? (id !== undefined ? K.movesById.get(id) : undefined);
        if (!info) return;
        e.damage = info.damage; e.cooldown = info.cooldown; e.special = info.class === 'special'; e.kitType = kit.types[info.type] ?? 0;
      };
      switch (d.kind) {
        case 'levelup': case 'lesson': {
          const sc = scoreLevelUp2(opt, snap, ctx);
          e.score = sc.score; e.junk = sc.junk;
          if (x.kind === 'newVit' || x.kind === 'upVit') {
            const v = K.vitamins.get(String(x.vit ?? ''));
            if (v) {
              const w = vitaminWorth(v, kit, ctx.plan.direction);
              e.value = w.value; e.risk = w.risk;
              e.mods = [v.kind === 'mul' ? { stat: v.stat, mul: 1 + v.perLevel } : { stat: v.stat, add: v.perLevel }, ...v.extra.map((m) => (m.mul != null && m.mul < 1 ? { stat: m.stat, mul: 1 + m.mul } : m))];
            }
          } else if (x.kind === 'newMove') move(undefined, Number(x.id));
          else if (x.kind === 'upMove') move(snap.player.moves[Number(x.slot)]?.key);
          break;
        }
        case 'item': case 'itemChoice': case 'shop': case 'ditto': case 'shopSell': {
          const key = String(x.key ?? opt.id), item = K.items.get(key);
          if (!item) break;
          const w = itemWorth(item, kit, ctx.plan.direction);
          e.value = w.value; e.risk = w.risk; e.score = Math.max(0, Math.min(100, worthNow(key, snap, ctx)));
          e.junk = w.value + Math.max(0, w.risk) < ctx.plan.itemSellBelow;
          e.mods = item.mods; e.typeShare = item.typeBoost ? kit.types[item.typeBoost] ?? 0 : 0;
          const tm = item.typeBoost ? 1 : textMultiplier(item.desc.toLowerCase());
          e.textLn = tm > 0 ? Math.log(tm) : 0;
          break;
        }
        case 'fusion': move(String(x.moveA ?? '')); break;
        default: break;
      }
      return e;
    });
  }

  private kinds(c: Ctx): KindRow[] {
    const s = c.m.obs.snapshot, st = c.m.obs.state, px = s.player.x, pz = s.player.z;
    return USE_KINDS.map((kind) => {
      let count = 0, near: (typeof s.points)[number] | undefined;
      for (const q of s.points) if (q.kind === kind && !q.used) { count++; if (!near || q.d < near.d) near = q; }
      const cost = kind === 'chest' ? st.economy.ballPrice : kind === 'cage' ? st.economy.cagePrice : kind === 'slots' ? st.economy.slotPrice : 0;
      return { available: c.m.phase === 'play' && !!c.m.mask[useId(kind)], count, d: near?.d ?? 0, dx: near ? near.x - px : 0, dz: near ? near.z - pz : 0, cost };
    });
  }

  encode(m: ManagerObservation, mgr: ManagerEnvironment): { float: Float32Array; int: Int32Array } {
    const float = new Float32Array(this.floatSize), int = new Int32Array(this.intSize);
    const low = this.base.encode(m.obs, null);
    for (const cp of this.copies) (cp.int ? int : float).set((cp.int ? low.int : low.float).subarray(cp.from, cp.from + cp.n), cp.to);
    const c: Ctx = { m, mgr, fig: mgr.figures(), maxHp: Math.max(1, m.obs.snapshot.player.maxHp) };
    this.mgrF.forEach((x, i) => { float[this.off.mgr + i] = applyScale(x.scale, x.raw(c)); });
    if (m.proposal >= 0) float[this.off.proposal + m.proposal] = 1;
    if (this.prevPlay >= M_PLAY_BASE) float[this.off.prev_play + this.prevPlay - M_PLAY_BASE] = 1;
    const kw = this.kindF.length;
    this.kinds(c).forEach((row, r) => { this.kindF.forEach((x, i) => { float[this.off.kinds + r * kw + i] = applyScale(x.scale, x.raw(row)); }); });
    const fw = this.fxF.length, stat = this.k.tables.stat;
    this.fx(c).forEach((e, r) => {
      if (!e) return;
      this.fxF.forEach((x, i) => { float[this.off.option_fx + r * fw + i] = applyScale(x.scale, x.raw(e)); });
      for (let j = 0; j < FX_MODS; j++) int[this.off.option_fx_stats + r * FX_MODS + j] = e.mods[j] ? stat[e.mods[j].stat] ?? 0 : 0;
    });
    return { float, int };
  }
}

export const M_ACTION_COUNT = M_ACTIONS;
