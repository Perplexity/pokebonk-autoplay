import type { Directive } from '../bot/brain/movement.ts';
import type { Tuning } from '../bot/brain/tuning.ts';
import type { Point, Snapshot } from '../bot/snapshot.ts';
import type { Plan } from '../agents/heuristic2/plan.ts';
import { M_ACTIONS, SKILLS, USE_KINDS, skillId, useId } from './actions.ts';
import type { ManagerPlay } from './actions.ts';

/**
 * The manager's skills (the "how" is the heuristic's brain; a skill is the order the brain is given):
 * which skills are possible now (the mask), what order a skill is, and which skill the heuristic's own order amounts
 * to (its proposal).
 */

/** What the skills need to know beyond the snapshot. */
export interface SkillWorld { gold: number; ballPrice: number; cagePrice: number; slotPrice: number; overtime: boolean }

export const pointKey = (q: Pick<Point, 'kind' | 'x' | 'z'>): string => `${q.kind}:${Math.round(q.x)}:${Math.round(q.z)}`;
const nearest = (s: Snapshot, pred: (q: Point) => boolean): Point | undefined => s.points.filter(pred).sort((a, b) => a.d - b.d)[0];

/** The guardian's altar while it sleeps (in the sanctuary: the shrine of the legendary), or undefined. */
export function wakePoint(s: Snapshot): Point | undefined {
  if (s.bossSpawned || s.stageCleared) return undefined;
  return nearest(s, (q) => q.kind === 'boss' && !q.used) ?? (s.stage >= 4 ? nearest(s, (q) => q.kind === 'shrine' && !q.used) : undefined);
}
export const portalPoint = (s: Snapshot): Point | undefined => nearest(s, (q) => q.kind === 'portal');

/** The point a `use:<kind>` skill would walk to: the nearest unused one that has not been given up, when it can be used now. */
export function usePoint(s: Snapshot, kind: string, w: SkillWorld, skipped: ReadonlySet<string> | readonly string[] = []): Point | undefined {
  const given = (key: string): boolean => (Array.isArray(skipped) ? skipped.includes(key) : (skipped as ReadonlySet<string>).has(key));
  switch (kind) {
    case 'chest': if (!(w.ballPrice > 0 && w.gold >= w.ballPrice)) return undefined; break;
    case 'cage': if (!(w.cagePrice > 0 && w.gold >= w.cagePrice)) return undefined; break;
    case 'slots': if (!(w.slotPrice > 0 && w.gold >= w.slotPrice)) return undefined; break;
    // Rhydon answers only while the guardian sleeps.
    case 'rhydon': if (s.bossSpawned || s.stageCleared) return undefined; break;
    default: break;
  }
  return nearest(s, (q) => q.kind === kind && !q.used && !given(pointKey(q)));
}

/** The play mask over the whole action table (1 = allowed). */
export function playMaskIds(s: Snapshot, w: SkillWorld, skipped: ReadonlySet<string>, out: Uint8Array = new Uint8Array(M_ACTIONS)): Uint8Array {
  out[skillId('farm')] = 1;
  out[skillId('retreat')] = 1;
  const portal = portalPoint(s);
  if (portal) out[skillId('near_portal')] = 1;
  if (wakePoint(s)) out[skillId('wake')] = 1;
  if (portal && (s.stageCleared || w.overtime)) out[skillId('portal')] = 1;
  for (const kind of USE_KINDS) if (usePoint(s, kind, w, skipped)) out[useId(kind)] = 1;
  return out;
}

/**
 * The brain's tuning under the manager: the brain neither wakes a guardian nor the legendary by itself (that is the
 * skill `wake`). `retreat` also makes it treat any HP as low, which is its own rule for getting away and healing.
 */
export function quietTuning(base: Tuning, retreat = false): Tuning {
  return { ...base, wakeLevel: base.wakeLevel.map(() => 9999), wakeAfterSec: Infinity, sanctuaryHp: 2, sanctuaryRestSec: Infinity, ...(retreat ? { lowHp: 1.01 } : {}) };
}

/** The order a skill is, or null when it cannot be carried out now (its mask bit is off). */
export function skillOrder(play: ManagerPlay, s: Snapshot, w: SkillWorld, plan: Plan, skipped: ReadonlySet<string>): { directive: Directive; retreat: boolean; target?: Point } | null {
  const portal = portalPoint(s);
  switch (play.skill) {
    case 'farm': return { directive: { holdPortal: true }, retreat: false };
    case 'retreat': return { directive: { holdPortal: true }, retreat: true };
    case 'near_portal': {
      if (!portal) return null;
      const r = plan.stayLeash > 0 ? plan.stayLeash : plan.leash;
      if (portal.d > r) return { directive: { holdPortal: true, goto: { kind: 'stay', x: portal.x, z: portal.z, reach: r * 0.5, interact: false, force: true, note: `back to the portal (${Math.round(portal.d)} m)` } }, retreat: false };
      return { directive: { holdPortal: true, leash: { x: portal.x, z: portal.z, r } }, retreat: false };
    }
    case 'wake': {
      const altar = wakePoint(s);
      if (!altar) return null;
      return { directive: { goto: { kind: 'wake', x: altar.x, z: altar.z, reach: Math.max(1.5, altar.r * 0.6), interact: true, force: true, note: 'wake (the manager)' } }, retreat: false, target: altar };
    }
    case 'portal': {
      if (!portal || !(s.stageCleared || w.overtime)) return null;
      // In Overtime the portal cashes the bonus; elsewhere the brain's own rule takes the portal of a cleared zone.
      if (w.overtime) return { directive: { holdPortal: true, goto: { kind: 'cash', x: portal.x, z: portal.z, reach: Math.max(1, portal.r * 0.5), interact: true, force: true, note: 'cash out overtime (the manager)' } }, retreat: false, target: portal };
      return { directive: {}, retreat: false, target: portal };
    }
    case 'use': {
      const q = usePoint(s, play.kind, w, skipped);
      if (!q) return null;
      // An Unown altar blesses whoever stands in it; everything else is pressed.
      const stand = play.kind === 'altar';
      return { directive: { holdPortal: true, goto: { kind: 'errand', x: q.x, z: q.z, reach: Math.max(1, q.r * (stand ? 0.45 : 0.6)), interact: !stand, force: true, note: `${play.kind} (the manager)` } }, retreat: false, target: q };
    }
    default: return null;
  }
}

/**
 * The skill the heuristic's own order amounts to. `intent` is what its brain answered to that order: the brain wakes
 * guardians and takes portals by rules of its own, which no order shows.
 */
export function classify(directive: Directive, intent: string, s: Snapshot): number {
  const g = directive.goto;
  if (g) {
    if (g.kind === 'wake') return skillId('wake');
    if (g.kind === 'cash') return skillId('portal');
    if (g.kind === 'stay') return skillId('near_portal');
    const q = s.points.find((x) => Math.abs(x.x - g.x) < 0.01 && Math.abs(x.z - g.z) < 0.01);
    const id = q ? useId(q.kind) : -1;
    if (id >= 0) return id;
  }
  if (intent === 'portal') return skillId('portal');
  if (intent === 'wake') return skillId('wake');
  if (directive.leash) return skillId('near_portal');
  return skillId('farm');
}

export const SKILL_COUNT = SKILLS.length + USE_KINDS.length;
