import { EF, E_ATK, E_DMG, E_FLAGS, E_HP, E_MAXHP, E_R, E_SPEED, E_VX, E_VZ, E_X, E_Z, type Enemy, type Point, type Snapshot } from '../snapshot.ts';
import { adaptTuning, type Tuning } from './tuning.ts';

/**
 * The in-run policy: a pure function from (snapshot, memory) to (action, memory). No I/O, no clocks, no randomness:
 * the same inputs always give the same decision, which is what makes it testable against recorded snapshots.
 */

export interface Vec { x: number; z: number }

export interface Action {
  /** Unit direction on the ground to walk in, or null to stand still. */
  move: Vec | null;
  dash: boolean;
  jump: boolean;
  ult: boolean;
  interact: boolean;
  /** What the bot is trying to do, for the log and the dashboard. */
  intent: string;
  /** Why, in a few words. */
  note: string;
}

export interface Memory {
  /** Heading chosen last tick. */
  dir: Vec | null;
  /** Position and run time of the last progress check. */
  px: number; pz: number; pt: number;
  /** Seconds of commanded movement that produced none. */
  stuck: number;
  /** While > run time: walk around an obstacle on this side (+1 left, -1 right). */
  detourUntil: number; detourSide: number;
  /** Fastest ground speed seen: the player's real walking speed. */
  speed: number;
  /** Keys ("kind:x:z") of map points given up on (unreachable, too expensive). */
  skip: string[];
  /** Run time the current goal was picked, and what it is. */
  goal: string; goalSince: number;
  /** Run time of the last interact press, to space them out. */
  lastInteract: number;
  /** Heading used when there is nothing to do: turned a little whenever it runs into something. */
  wander: number;
  lastStage: number;
  /** Run time until which priority targets are ignored (the last hunt went nowhere). */
  noHuntUntil: number;
  /** Interact presses made at the service point being visited: after two it is done with for this zone. */
  visitPresses: number;
  /** Key of the service point being visited ("" when none): see `markVisited`. */
  visitKey: string;
}

/**
 * The service point the brain was walking to has been used (its dialog was answered): it is not visited again in this
 * zone. Called by whoever answers the dialogs; without it the brain gives a point up after two interact presses.
 */
export function markVisited(mem: Memory): Memory {
  if (!mem.visitKey || mem.skip.includes(mem.visitKey)) return mem;
  return { ...mem, skip: [...mem.skip, mem.visitKey], visitKey: '', visitPresses: 0 };
}

/**
 * What the layer above (the run's lifecycle, src/agents/heuristic) wants on top of the brain's own goals. The snapshot
 * does not say whether overtime is running, so the caller, who answered the dialogs, tells the brain.
 */
export interface Directive {
  /** Do not take the portal although the zone is cleared: overtime is being played and the portal would cash it. */
  holdPortal?: boolean;
  /** Walk here (and press interact there). With `force` it comes before everything, fleeing at low HP included. */
  goto?: { kind: string; x: number; z: number; reach: number; interact: boolean; force: boolean; note: string };
  /** Fight within `r` metres of this point (overtime: stay close to the exit portal). */
  leash?: { x: number; z: number; r: number };
}

/**
 * The guardian that is up right now, or null. `snapshot.boss` alone is not enough: the game keeps its boss object
 * after the guardian fell, and its enemy slot is reused, so in later zones and in overtime the field can describe an
 * ordinary enemy. A guardian is live between its wake (`bossSpawned`) and its fall (`stageCleared`).
 */
export function liveBoss(s: Snapshot): Snapshot['boss'] {
  return s.boss && s.bossSpawned && !s.stageCleared ? s.boss : null;
}

export const newMemory = (): Memory => ({
  dir: null, px: 0, pz: 0, pt: -1, stuck: 0, detourUntil: 0, detourSide: 1, speed: 6, skip: [], goal: '', goalSince: 0, lastInteract: -10, wander: 0.7, lastStage: 0, noHuntUntil: 0, visitPresses: 0, visitKey: '',
});

/** How much of the threats (enemies, crowding, shots, ground hazards) still counts on the way to a forced goal: none. In a horde of hundreds any share of it outweighs the goal. */
const FORCED_THREAT = 0;
/** Look-ahead instants for the homing model. */
const CHASE = [0.2, 0.4];
/** The homing model only vetoes a heading that ends in (near) contact; keeping distance is the straight-line model's job. */
const TOUCH = 1.6;
const DIRS: Vec[] = Array.from({ length: 16 }, (_v, k) => ({ x: Math.cos((k * Math.PI) / 8), z: Math.sin((k * Math.PI) / 8) }));
const len = (x: number, z: number) => Math.hypot(x, z);
const norm = (x: number, z: number): Vec => { const l = len(x, z) || 1; return { x: x / l, z: z / l }; };
const pkey = (p: Point) => `${p.kind}:${Math.round(p.x)}:${Math.round(p.z)}`;

/** How dangerous one enemy is relative to a plain one. */
function weight(e: Enemy, s: Snapshot): number {
  const f = e[E_FLAGS];
  let w = 1;
  if (f & EF.Boss) w = 3;
  else if (f & (EF.Alpha | EF.Totem | EF.Summoner)) w = 2.2;
  else if (f & EF.Elite) w = 1.6;
  if (f & EF.Charger) w *= 1.3;
  if (f & EF.Capture) w *= 0.3; // a weakened capture target does not fight back
  // An enemy that takes a large share of the health bar per hit counts for more.
  w *= 0.6 + Math.min(2, (e[E_DMG] / Math.max(1, s.player.maxHp)) * 6);
  return w;
}

export interface Situation {
  hpFrac: number;
  /** Enemies within 3.5 m, 8 m and 15 m. */
  n3: number; n8: number; n15: number;
  /** Σ weight / (distance + 1) over enemies within 12 m: how hot the spot is. */
  pressure: number;
  /** Weighted enemy presence per direction sector within 9 m. */
  occ: number[];
  /** Distance to the closest enemy edge. */
  nearest: number;
  surrounded: boolean;
}

export function assess(s: Snapshot): Situation {
  const p = s.player, occ = new Array(16).fill(0);
  let n3 = 0, n8 = 0, n15 = 0, pressure = 0, nearest = 99;
  for (const e of s.enemies.list) {
    const dx = e[E_X] - p.x, dz = e[E_Z] - p.z, d = len(dx, dz) - e[E_R];
    if (e[E_FLAGS] & EF.Capture) continue;
    if (d < nearest) nearest = d;
    if (d < 3.5) n3++;
    if (d < 8) n8++;
    if (d < 15) n15++;
    const w = weight(e, s);
    if (d < 12) pressure += w / (Math.max(0, d) + 1);
    if (d < 9) {
      const k = ((Math.round(Math.atan2(dz, dx) / (Math.PI / 8)) % 16) + 16) % 16;
      const v = w * (1 - d / 9.5);
      occ[k] += v; occ[(k + 1) % 16] += v * 0.5; occ[(k + 15) % 16] += v * 0.5;
    }
  }
  // Surrounded: enemies in at least 5 of the 8 double-sectors close by.
  let filled = 0;
  for (let k = 0; k < 16; k += 2) if (occ[k] + occ[k + 1] > 0.5) filled++;
  return { hpFrac: p.maxHp > 0 ? Math.max(0, p.hp) / p.maxHp : 0, n3, n8, n15, pressure, occ, nearest, surrounded: filled >= 5 && n8 >= 5 };
}

/** The pack we are fighting: centre and looseness of what is within 16 m (the nearest 30 at most). */
export function pack(s: Snapshot): { x: number; z: number; n: number; spread: number } {
  const p = s.player;
  let x = 0, z = 0, n = 0;
  const near: Enemy[] = [];
  for (const e of s.enemies.list) {
    if (e[E_FLAGS] & EF.Capture) continue;
    if (len(e[E_X] - p.x, e[E_Z] - p.z) > 16 || near.length >= 30) break;
    near.push(e); x += e[E_X]; z += e[E_Z]; n++;
  }
  if (!n) { const e = s.enemies.list[0]; return { x: e ? e[E_X] : p.x, z: e ? e[E_Z] : p.z, n: e ? 1 : 0, spread: 0 }; }
  x /= n; z /= n;
  let spread = 0;
  for (const e of near) spread += len(e[E_X] - x, e[E_Z] - z);
  return { x, z, n, spread: spread / n };
}

/** How far the kit's longest move reaches. */
export function maxReach(s: Snapshot): number {
  let best = 0;
  for (const m of s.player.moves) {
    const a = m.arch;
    const r = a === 'shot' || a === 'beam' || a === 'bolt' || a === 'homing' || a === 'lob' || a === 'smite' || a === 'meteor' ? 10
      : a === 'cone' || a === 'wave' ? Math.max(4, Math.min(9, m.area))
      : a === 'nova' || a === 'aura' || a === 'orbit' || a === 'trail' ? Math.max(3, Math.min(6, m.area)) : 4;
    if (r > best) best = r;
  }
  return best || 5.5;
}

/** The distance the kit likes to fight at: short for auras and strikes, long for shots. */
export function kitRange(s: Snapshot): number {
  let best = 0, n = 0;
  for (const m of s.player.moves) {
    const a = m.arch;
    const r = a === 'shot' || a === 'beam' || a === 'smite' || a === 'meteor' ? 8.5
      : a === 'cone' || a === 'wave' ? Math.max(3.5, Math.min(7, m.area * 0.65))
      : a === 'nova' || a === 'aura' || a === 'orbit' || a === 'trail' ? Math.max(3, Math.min(5.5, m.area * 0.8))
      : a === 'strike' || a === 'spin' ? 3.2 : 5.5;
    best += r; n++;
  }
  return n ? best / n : 5.5;
}

interface Goal { kind: string; x: number; z: number; /** Stop this close. */ reach: number; interact: boolean; urgency: number; note: string; ring?: number; /** Get there through whatever is in the way. */ forced?: boolean }

/** Priority targets when it is safe: ranged and fast enemies first, then elites that are nearly down. */
export function pickFocus(s: Snapshot): Enemy | null {
  let best: Enemy | null = null, bestScore = 0;
  const p = s.player;
  for (const e of s.enemies.list) {
    const f = e[E_FLAGS];
    if (f & (EF.Boss | EF.Capture)) continue;
    const d = len(e[E_X] - p.x, e[E_Z] - p.z);
    if (d > 12) break;
    let sc = 0;
    if (f & EF.Ranged) sc += 3;
    if (f & (EF.Healer | EF.Shielder)) sc += 3.5;
    if (e[E_SPEED] > 5) sc += 1.5;
    if (f & (EF.Elite | EF.Alpha) && e[E_HP] < e[E_MAXHP] * 0.35) sc += 4;
    if (!sc) continue;
    sc -= d * 0.12;
    if (sc > bestScore) { bestScore = sc; best = e; }
  }
  return best;
}

function chooseGoal(s: Snapshot, sit: Situation, m: Memory, t: Tuning, dir: Directive): Goal {
  const p = s.player;
  const boss = liveBoss(s);
  const ordered = (g: NonNullable<Directive['goto']>): Goal => ({ kind: g.kind, x: g.x, z: g.z, reach: g.reach, interact: g.interact, urgency: g.force ? 1.5 : 1, note: g.note, forced: g.force });

  // 0. An order that comes before survival (cashing overtime out through the portal while there is HP left to get there).
  if (dir.goto?.force) return ordered(dir.goto);
  const find = (kind: string, pred: (q: Point) => boolean = () => true) =>
    s.points.filter((q) => q.kind === kind && !m.skip.includes(pkey(q)) && pred(q)).sort((a, b) => a.d - b.d)[0];

  // 0b. Zone cleared: the portal, through whatever is in the way, and before fleeing. A cleared zone has nothing left
  // that the run needs, the next zone starts empty, and the horde that gathered during the guardian fight is exactly
  // what keeps a careful walker away from the portal (seen in headless play: 13 m from the portal when the zone-2
  // guardian fell, 70 m away twenty seconds later, fainted in the same zone four minutes after that).
  const portal = find('portal') ?? find('rush', (q) => q.sub === 'gate');
  if (s.stageCleared && portal && !dir.holdPortal) return { kind: 'portal', x: portal.x, z: portal.z, reach: Math.max(1, portal.r * 0.5), interact: true, urgency: 1.5, note: 'portal', forced: true };

  // 1. Hurt: get away and heal. Nothing else matters.
  if (sit.hpFrac < t.lowHp) {
    const berry = find('berry', (q) => !q.used && q.d < 30);
    if (berry && sit.pressure < t.lootCalm * 2) return { kind: 'heal', x: berry.x, z: berry.z, reach: 1, interact: true, urgency: 0.8, note: 'low hp: berry' };
    return { kind: 'flee', x: p.x, z: p.z, reach: 0, interact: false, urgency: 0, note: `low hp ${(sit.hpFrac * 100) | 0}%` };
  }

  // 2. The guardian is up: fight it at the kit's range, a little wider when it is enraged.
  if (boss) {
    // From the far end of the longest move: a guardian's touch or charge takes a large part of the HP bar, and its
    // bursts of shots spread out with distance.
    const ring = Math.max(kitRange(s) + t.kiteSlack, maxReach(s) - 0.8) + (boss.enraged ? 1.5 : 0) + boss.radius;
    return { kind: 'boss', x: boss.x, z: boss.z, reach: 0, interact: false, urgency: 1, note: `${boss.name || 'guardian'} ${Math.round((boss.hp / Math.max(1, boss.maxHp)) * 100)}%`, ring };
  }

  // An order of the lifecycle layer (the relit shrine, the way back to the portal…).
  if (dir.goto) return ordered(dir.goto);

  // 3. A capture window is open: rare targets first, never from inside a crowd.
  if (s.capture && s.capture.index >= 0 && (s.capture.state === 'weak' || s.capture.canThrow) && sit.pressure < t.lootCalm * 2.5 && sit.hpFrac > t.surviveHp) {
    return { kind: 'capture', x: s.capture.x, z: s.capture.z, reach: 2.2, interact: true, urgency: s.capture.shiny || s.capture.mode !== 'league' ? 1.2 : 0.9, note: `capture #${s.capture.species}${s.capture.shiny ? ' shiny' : ''}` };
  }

  // 4. Strong enough (or the zone has run long): wake the guardian.
  // (In the sanctuary, zone 4, the legendary sleeps at the shrine. Nothing spawns there before it wakes, so there is
  // nothing to level on: it is woken as soon as the HP bar is full enough, or after a short rest.)
  const sanctuary = s.stage >= 4 && !s.points.some((q) => q.kind === 'boss');
  const altar = find('boss', (q) => !q.used) ?? (sanctuary ? find('shrine', (q) => !q.used) : undefined);
  const wakeLv = sanctuary ? 0 : t.wakeLevel[Math.min(t.wakeLevel.length - 1, Math.max(0, s.stage - 1))];
  if (sanctuary && altar && !s.bossSpawned && !s.stageCleared && (sit.hpFrac >= t.sanctuaryHp || s.stageTime >= t.sanctuaryRestSec)) {
    return { kind: 'wake', x: altar.x, z: altar.z, reach: Math.max(1.5, altar.r * 0.6), interact: true, urgency: 0.9, note: `wake the legendary (hp ${Math.round(sit.hpFrac * 100)}%)` };
  }
  // (With the ultimate close to charged: it is saved for this fight, so the fight starts when it is there.)
  // The walk to the altar does not wait for a gap in the horde, and once begun it is finished. In zones 2 and 3 the
  // horde leaves no gap that lasts as long as the walk: a bot that waits for one, or turns to fight whenever the horde
  // closes in, never arrives, and the run sits in the zone until it is worn down or the final swarm ends it. Seen in
  // headless play: 12 minutes in zone 3 at level 98 with the guardian still asleep; and of 30 episodes, 11 ended in
  // zone 2 above the wake level with the guardian never woken.
  // While under way the walk only needs `wakeKeepHp`, and an ultimate spent on the way does not call it off; the
  // guardian itself is woken with `wakeHp` or more, so a bot that arrives hurt waits at the altar.
  const walking = m.goal === 'wake';
  const strong = walking || (p.level >= wakeLv && s.ult.charge >= t.wakeUlt) || s.stageTime >= t.wakeAfterSec;
  if (!s.bossSpawned && !s.stageCleared && altar && strong && sit.hpFrac >= (walking ? t.wakeKeepHp : t.wakeHp)) {
    return { kind: 'wake', x: altar.x, z: altar.z, reach: Math.max(1.5, altar.r * 0.6), interact: sit.hpFrac >= t.wakeHp, urgency: 0.9, note: `wake guardian (lv ${p.level}, ${Math.round(s.stageTime)}s)` };
  }

  // Loot waits while the horde is large: thinning it is what keeps the run alive.
  // And a fight within reach is finished first: enemies left behind are experience left behind.
  const calm = sit.pressure < t.lootCalm && s.enemies.count < t.hordeSize && sit.n15 <= 2;
  // 5. Loot within reach while things are calm: free chests, chests the gold covers, altars, berries when scratched.
  if (calm) {
    if (sit.hpFrac < 0.75) { const b = find('berry', (q) => q.d < t.lootRange * 0.6); if (b) return { kind: 'heal', x: b.x, z: b.z, reach: 1, interact: true, urgency: 0.6, note: 'berry' }; }
    // Balls, cheapest first: Great Balls and cursed balls are free, a paid Poké Ball only when the Pokédollars
    // earned from KOs cover its current price (it goes up with every one bought).
    const ball = find('freechest', (q) => q.d < t.lootRange * 1.6)
      ?? find('cursedchest', (q) => q.d < t.lootRange * 1.3)
      ?? (s.gold >= s.ballCost && s.ballCost > 0 ? find('chest', (q) => q.d < t.lootRange) : undefined);
    if (ball) {
      const label = ball.kind === 'freechest' ? 'Great Ball (free)' : ball.kind === 'cursedchest' ? 'cursed ball (free)' : `Poké Ball ${s.ballCost}₽ of ${s.gold}₽`;
      return { kind: 'loot', x: ball.x, z: ball.z, reach: Math.max(1, ball.r * 0.7), interact: true, urgency: 0.55, note: label };
    }
    const al = find('altar', (q) => q.d < t.lootRange * 0.7);
    if (al && p.level >= 3) return { kind: 'altar', x: al.x, z: al.z, reach: Math.max(1, al.r * 0.45), interact: false, urgency: 0.45, note: 'altar blessing' };
    // Service points (shop, Ditto, trades…): each is used once per zone. The shop waits for Pokédollars, Ditto for an item to copy.
    const service = s.points.filter((q) => t.visitKinds.includes(q.kind) && !q.used && q.d < t.visitRange && !m.skip.includes(pkey(q))
      && (q.kind !== 'meowth' || s.gold >= t.shopGold) && (q.kind !== 'ditto' || Object.keys(p.items).length > 0)).sort((a, b) => a.d - b.d)[0];
    if (service) return { kind: 'visit', x: service.x, z: service.z, reach: Math.max(1, service.r * 0.6), interact: true, urgency: 0.5, note: `visit ${service.kind}` };
  }

  // 6. Experience on the ground.
  // (Once it is going for a pile it finishes it, so the goal does not flip every tick.)
  if (s.pickups.xpN >= (m.goal === 'xp' ? 1 : 5) && sit.pressure < t.lootCalm * 1.4) {
    const d = len(s.pickups.xpX - p.x, s.pickups.xpZ - p.z);
    if (d > p.pickupRange * 0.5) return { kind: 'xp', x: s.pickups.xpX, z: s.pickups.xpZ, reach: 1, interact: false, urgency: 0.5, note: `xp ×${Math.round(s.pickups.xpN)}` };
  }

  // Kept on a leash by the lifecycle layer: back towards its point before anything else that wanders.
  if (dir.leash && len(dir.leash.x - p.x, dir.leash.z - p.z) > dir.leash.r) {
    return { kind: 'leash', x: dir.leash.x, z: dir.leash.z, reach: dir.leash.r * 0.5, interact: false, urgency: 0.9, note: 'back towards the portal' };
  }

  // 7. Fight: a priority target when healthy, otherwise the nearest pack, at the kit's range.
  const ring = kitRange(s) + t.kiteSlack;
  // (A target that has been hunted for a while without the goal changing is out of reach: back to the pack.)
  if (m.goal === 'hunt' && s.t - m.goalSince > 8) m.noHuntUntil = s.t + 15;
  const focus = sit.hpFrac >= t.huntHp && sit.pressure < t.lootCalm * 1.5 && s.t >= m.noHuntUntil ? pickFocus(s) : null;
  if (focus) {
    // A wounded elite is finished from further out than its reach.
    const hard = focus[E_FLAGS] & (EF.Elite | EF.Alpha);
    return { kind: 'hunt', x: focus[E_X], z: focus[E_Z], reach: 0, interact: false, urgency: 0.6, note: `focus #${focus[E_FLAGS] & EF.Ranged ? 'ranged' : hard ? 'elite' : 'fast'}`, ring: hard ? Math.max(ring, t.dangerRadius * 1.5 + 1) : ring };
  }
  if (s.enemies.list.length) {
    // Herding: circle the pack at move range instead of running from it. Everything that chases us ends up in one
    // clump on the same side, which is where the cone, the shockwave and the ultimate hit the most at once.
    const pk = pack(s);
    // A loose pack is circled a little wider so the stragglers close up before we turn in.
    const herd = ring + Math.min(2.5, pk.spread * 0.3);
    return { kind: 'farm', x: pk.x, z: pk.z, reach: 0, interact: false, urgency: 0.6, note: `herding ${pk.n} (spread ${pk.spread.toFixed(1)} m)`, ring: herd };
  }

  // 8. Nothing around: head for the guardian's altar so the walk is not wasted, else wander.
  if (altar && !s.bossSpawned) return { kind: 'roam', x: altar.x, z: altar.z, reach: 12, interact: false, urgency: 0.3, note: 'towards the altar' };
  return { kind: 'roam', x: p.x + Math.cos(m.wander) * 20, z: p.z + Math.sin(m.wander) * 20, reach: 0, interact: false, urgency: 0.25, note: 'wander' };
}

/** Distance from point (x, z) to the segment a→b. */
function segDist(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz;
  const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / l2)) : 0;
  return len(x - (ax + vx * u), z - (az + vz * u));
}

export function decide(s: Snapshot, mem: Memory, base: Tuning, directive: Directive = {}): { action: Action; mem: Memory; sit: Situation; /** Where the current goal is: the session plans a route to it when it is far. */ goal?: { kind: string; x: number; z: number; far: boolean }; /** Score of standing still, then of the 16 headings (lower is better): for debugging. */ scores?: number[] } {
  const idle: Action = { move: null, dash: false, jump: false, ult: false, interact: false, intent: 'idle', note: s.state };
  const m: Memory = { ...mem, skip: mem.skip };
  const sit = assess(s);
  if (s.state !== 'play' || s.player.dead) return { action: idle, mem: m, sit };

  const t = adaptTuning(base, s.diff);
  const p = s.player;
  if (s.stage !== m.lastStage) { m.lastStage = s.stage; m.skip = []; m.stuck = 0; }

  // ---- how fast do we really walk, and are we getting anywhere? ----
  // (Walking speed only: a dash is faster and would make every prediction overshoot.)
  const sp = len(p.vx, p.vz);
  if (!p.sliding && p.grounded && sp > 3 && sp < 14) m.speed = sp > m.speed ? sp : m.speed * 0.98 + sp * 0.02;
  const dtp = m.pt >= 0 ? s.t - m.pt : 0;
  if (m.pt < 0 || dtp >= 0.5 || dtp < 0) {
    if (dtp > 0 && m.dir) {
      const moved = len(p.x - m.px, p.z - m.pz);
      m.stuck = moved < m.speed * dtp * 0.25 ? m.stuck + dtp : 0;
    }
    m.px = p.x; m.pz = p.z; m.pt = s.t;
  }

  const goal = chooseGoal(s, sit, m, t, directive);
  const boss = liveBoss(s);
  if (goal.kind !== m.goal) { m.goal = goal.kind; m.goalSince = s.t; m.visitPresses = 0; }
  { const q = goal.kind === 'visit' ? s.points.find((x) => Math.abs(x.x - goal.x) < 0.6 && Math.abs(x.z - goal.z) < 0.6) : undefined; m.visitKey = q ? pkey(q) : ''; }

  // A map point that cannot be reached in a reasonable time is dropped for this zone.
  if ((goal.kind === 'loot' || goal.kind === 'altar' || goal.kind === 'heal' || goal.kind === 'visit') && s.t - m.goalSince > 40) {
    const q = s.points.find((x) => Math.abs(x.x - goal.x) < 0.6 && Math.abs(x.z - goal.z) < 0.6);
    if (q && !m.skip.includes(pkey(q))) m.skip = [...m.skip, pkey(q)];
  }

  // ---- where the goal pulls ----
  const gx = goal.x - p.x, gz = goal.z - p.z, gd = len(gx, gz);
  let pull: Vec | null = null, pullW = goal.urgency;
  // A forced goal (cashing overtime out) is run to through everything: with hundreds of enemies and dozens of shots
  // around, keeping away from each of them outweighs any goal and the bot drifts away from the portal until it faints
  // (seen in real play: 15 m from the portal when it decided to cash out, 46 m away half a minute later). Enemies,
  // shots and ground hazards then do not count at all; walls and the map edge count as always.
  // The walk to a far altar is made with determination: threats count for a part only and the goal pulls harder. At
  // the ordinary weights the horde of zones 2 and 3 (60 to 170 alive, new ones spawning ahead) turns the bot around
  // every few seconds: seen in headless play, four minutes of "wake" spent between 120 m and 240 m from the altar.
  const determined = goal.kind === 'wake' && gd > 14;
  const threatK = goal.forced ? FORCED_THREAT : determined ? t.wakeThreat : 1;
  if (goal.kind === 'flee') {
    // Away from the weighted centre of what is near.
    let ax = 0, az = 0;
    for (const e of s.enemies.list.slice(0, 24)) { const dx = p.x - e[E_X], dz = p.z - e[E_Z], d = len(dx, dz) || 1; ax += dx / (d * d); az += dz / (d * d); }
    pull = ax || az ? norm(ax, az) : null;
    pullW = 0.8;
  }
  else if (goal.ring) {
    // Keep the target on a ring: close in when far, back off when near, circle when on it.
    const g = norm(gx, gz), tan = { x: -g.z * m.detourSide, z: g.x * m.detourSide };
    const err = gd - goal.ring;
    if (err > 1.5) pull = g;
    else if (err < -1.2) pull = { x: -g.x, z: -g.z };
    else pull = norm(tan.x + g.x * err * 0.3, tan.z + g.z * err * 0.3);
  } else if (gd > goal.reach) pull = norm(gx, gz);
  if (goal.forced) pullW = 4;
  else if (determined) pullW = t.wakePull;

  // Near the edge, circling and fleeing bend back towards the middle of the map: the pack is led inwards, not into
  // a corner. The side we circle on is the one that takes us away from the edge.
  const marginNow = s.terrain.bounds - Math.max(Math.abs(p.x), Math.abs(p.z));
  if (marginNow < t.edgeMargin * 1.3 && (goal.ring || goal.kind === 'flee')) {
    const inward = norm(-p.x, -p.z), k = 1.6 * (1 - marginNow / (t.edgeMargin * 1.3));
    if (goal.ring) {
      const g = norm(gx, gz), tan = { x: -g.z * m.detourSide, z: g.x * m.detourSide };
      if (tan.x * inward.x + tan.z * inward.z < -0.2) m.detourSide = -m.detourSide;
    }
    pull = pull ? norm(pull.x + inward.x * k, pull.z + inward.z * k) : inward;
    pullW = Math.max(pullW, 0.7 + k * 0.4);
  }

  // A far goal is reached along the planned route (around cliffs, props and water), not along the straight line.
  let routeJump = false, routed = false;
  const nav = s.nav;
  if (nav && pull && goal.kind !== 'flee' && gd > 14 && Math.abs(nav.tx - goal.x) < 5 && Math.abs(nav.tz - goal.z) < 5) {
    const wd = len(nav.x - p.x, nav.z - p.z);
    if (wd > 1.5) { pull = norm(nav.x - p.x, nav.z - p.z); routeJump = nav.jump; routed = true; }
  }

  // Walking around an obstacle: lean to one side of the pull for a moment.
  if (pull && s.t < m.detourUntil && !goal.ring && !routed) {
    const a = Math.atan2(pull.z, pull.x) + m.detourSide * 1.15;
    pull = { x: Math.cos(a), z: Math.sin(a) };
  }

  // ---- chargers: enemies that dash in a straight line, faster than we walk ----
  // Running away along the line gets us caught; the answer is to leave the lane sideways. A lane is either the dash
  // under way (along its velocity) or the one about to start (from the charger to where we stand now).
  const lanes: { ax: number; az: number; bx: number; bz: number; w: number; r: number; live: boolean }[] = [];
  for (const e of s.enemies.list) {
    if (!(e[E_FLAGS] & (EF.Charger | EF.Stampede))) continue;
    const dx = p.x - e[E_X], dz = p.z - e[E_Z], d = len(dx, dz);
    if (d > 18) break;
    const v = len(e[E_VX], e[E_VZ]);
    if (v > e[E_SPEED] * 1.6 && v > 6) {
      // Only if it is coming our way.
      if ((e[E_VX] * dx + e[E_VZ] * dz) / (v * (d || 1)) > 0.5) lanes.push({ ax: e[E_X], az: e[E_Z], bx: e[E_X] + (e[E_VX] / v) * (d + 5), bz: e[E_Z] + (e[E_VZ] / v) * (d + 5), w: 1, r: e[E_R], live: true });
    } else if ((e[E_ATK] ?? 9) < 0.9 && d < 15) {
      lanes.push({ ax: e[E_X], az: e[E_Z], bx: e[E_X] + (dx / (d || 1)) * (d + 5), bz: e[E_Z] + (dz / (d || 1)) * (d + 5), w: 0.6, r: e[E_R], live: false });
    }
    if (lanes.length >= 6) break;
  }

  // Ordinary enemies are kept just inside the kit's reach: a bot that stays out of its own range kills nothing,
  // and in this game the horde only gets bigger.
  const room = Math.max(2.2, kitRange(s) - 1.6);

  // ---- score the 16 headings (and standing still) ----
  const speed = Math.max(3, m.speed);
  let best = -1, bestScore = Infinity;
  const scores: number[] = [];
  const horizon = [0.3, 0.7, 1.2];
  for (let k = -1; k < 16; k++) {
    const d = k < 0 ? { x: 0, z: 0 } : DIRS[k];
    let sc = 0;
    // Enemies: how close does each one get if we walk this way? Two models, and the worse one counts:
    //  - it keeps its current velocity: the closest approach of two straight paths over the next 1.3 s. This is what
    //    sees a head-on meeting coming from far enough away to step aside;
    //  - it turns and runs straight at wherever we go: most enemies home in, so a path that only "misses" a
    //    straight-line enemy by a few metres does not miss.
    {
      const H = 1.3, vx = d.x * speed, vz = d.z * speed, air = !p.grounded;
      let danger = 0;
      for (const e of s.enemies.list) {
        if (e[E_FLAGS] & EF.Capture) continue;
        const rx = e[E_X] - p.x, rz = e[E_Z] - p.z;
        if (len(rx, rz) > 24) break;
        // Hard hitters (elites, alphas, chargers) are given more room than the rank and file.
        const reach = e[E_FLAGS] & EF.Boss ? t.dangerRadius * 2.2 : e[E_FLAGS] & (EF.Elite | EF.Alpha | EF.Charger | EF.Totem) ? t.dangerRadius * 1.5 : Math.min(t.dangerRadius, room);
        const wx = e[E_VX] - vx, wz = e[E_VZ] - vz, w2 = wx * wx + wz * wz;
        const tc = w2 > 1e-6 ? Math.max(0, Math.min(H, -(rx * wx + rz * wz) / w2)) : 0;
        const straight = len(rx + wx * tc, rz + wz * tc);
        // Homing: at each moment ahead, how near could it be if it ran straight at us the whole time?
        let chased = Infinity, chasedAt = 0;
        for (const tau of CHASE) { const c = len(rx - vx * tau, rz - vz * tau) - e[E_SPEED] * tau; if (c < chased) { chased = c; chasedAt = tau; } }
        const body = e[E_R] + p.radius;
        // Two closeness scores, each on its own scale; the worse one counts.
        const cs = Math.max(0, 1 - Math.max(0, straight - body) / reach), ch = Math.max(0, 1 - Math.max(0, chased - body) / TOUCH);
        if (cs <= 0 && ch <= 0) continue;
        const c = Math.max(cs, ch), when = ch > cs ? chasedAt : tc, dist = Math.min(straight, chased) - body;
        // A touch is much worse than a near miss, and sooner is worse than later.
        // In the air only what flies (or towers, like a boss) reaches us: jumping over a crowd is a way through it.
        const over = air && !(e[E_FLAGS] & (EF.Flying | EF.Boss | EF.Alpha)) ? 0.3 : 1;
        danger += over * weight(e, s) * c * c * (dist < 0.5 ? 3 : 1) * (1.15 - 0.5 * Math.min(1, when / H));
      }
      sc += danger * t.wDanger * 2.2 * (p.iframes > 0.5 ? 0.35 : 1) * threatK;
    }
    for (const h of horizon) {
      const x = p.x + d.x * speed * h, z = p.z + d.z * speed * h;
      // Ground hazards: inside one soon is bad; inside one now and leaving is good.
      for (const hz of s.hazards) {
        const dist = len(x - hz.x, z - hz.z);
        if (dist >= hz.r + 0.9) continue;
        if (hz.kind === 'telegraph') {
          // A strike on its way: what counts is being out of the circle when it lands.
          if (h + 0.25 >= hz.t || hz.t < 0.5) sc += t.wHazard * 1.6 * threatK;
          else sc += t.wHazard * 0.25 * threatK;
        } else sc += t.wHazard * (hz.kind.startsWith('boss') ? 1.2 : 0.8) * threatK;
      }
      // Shots: stay out of the lane they fly along.
      for (const b of s.shots) {
        // Where the shot is around the time we would be there.
        const dist = segDist(x, z, b[0] + b[2] * Math.max(0, h - 0.2), b[1] + b[3] * Math.max(0, h - 0.2), b[0] + b[2] * (h + 0.3), b[1] + b[3] * (h + 0.3));
        if (dist < b[4] + p.radius + 0.7) sc += t.wHazard * (0.5 + Math.min(1, (b[5] / Math.max(1, p.maxHp)) * 5)) * threatK;
      }
      for (const ln of lanes) {
        if (segDist(x, z, ln.ax, ln.az, ln.bx, ln.bz) < ln.r + p.radius + 1.4) sc += t.wHazard * 0.8 * ln.w * threatK;
      }
      // A boss charge: leave the lane sideways.
      if (boss && boss.chargeT > 0 && (boss.cdx || boss.cdz)) {
        const dist = segDist(x, z, boss.x, boss.z, boss.x + boss.cdx * 40, boss.z + boss.cdz * 40);
        if (dist < boss.radius + 2.2) sc += t.wHazard * 1.1 * threatK;
      }
      // The edge of the arena.
      // The map is a square: its edge is where |x| or |z| reaches the bound.
      const edge = Math.max(Math.abs(x), Math.abs(z)) - (s.terrain.bounds - 5);
      if (edge > 0) sc += t.wTerrain * (1 + edge * 0.5);
      // Long before that: a horde that follows us into a corner has us. Ground near the edge costs more the nearer it is.
      const margin = s.terrain.bounds - Math.max(Math.abs(x), Math.abs(z));
      if (margin < t.edgeMargin) { const u = (t.edgeMargin - margin) / t.edgeMargin; sc += t.wEdge * u * u; }
    }
    if (k >= 0) {
      // Cliffs and water in that direction.
      const fr = s.terrain.free?.[k], hp = s.terrain.hop?.[k];
      if (fr !== undefined && hp !== undefined) {
        // What the game's own height map and colliders say about walking that way.
        if (hp < 1.5) sc += t.wTerrain * 3;                                      // a wall, a tree, water or the map edge right there
        else if (fr < 1.5) sc += t.wTerrain * 0.3;                               // a climb: jumps get up it, slowly
        else if (fr < 4.5) sc += t.wTerrain * 0.5 * (1 - fr / 4.5) * (hp > fr + 1 ? 0.5 : 1); // something a few steps ahead
      } else {
        const rise = s.terrain.ring[k], rise2 = s.terrain.ring2[k];
        if (s.terrain.blocked[k]) sc += t.wTerrain * 3;
        else if (rise > 1.1) sc += t.wTerrain * 1.5;
        else if (rise2 > 2.6) sc += t.wTerrain * 0.5;
      }
      // A crowd on that side.
      sc += t.wCrowd * (sit.occ[k] + 0.5 * (sit.occ[(k + 1) % 16] + sit.occ[(k + 15) % 16])) * threatK;
      // The goal.
      if (pull) sc -= t.wGoal * pullW * (d.x * pull.x + d.z * pull.z);
      // Steady heading.
      if (m.dir) sc -= t.wInertia * (d.x * m.dir.x + d.z * m.dir.z);
    } else {
      // Standing still is right only when the goal is here and nothing is near.
      sc += pull ? 0.6 : goal.kind === 'flee' ? 0.5 : 0.05;
      if (sit.nearest < t.dangerRadius) sc += 0.4;
    }
    scores.push(sc);
    if (sc < bestScore) { bestScore = sc; best = k; }
  }

  let move: Vec | null = best >= 0 ? DIRS[best] : null;

  // ---- stuck: jump, and start walking around whatever it is ----
  let jump = false;
  if (m.stuck >= 0.5 && move) {
    jump = p.grounded;
    if (s.t >= m.detourUntil) { m.detourSide = -m.detourSide; m.detourUntil = s.t + 1.6 + Math.min(4, m.stuck); m.wander += 1.3; }
    if (m.stuck > 6 && goal.kind !== 'boss' && goal.kind !== 'farm' && goal.kind !== 'hunt' && goal.kind !== 'flee') {
      // (Guardian altars, shrines and portals are never given up on: the run cannot go on without them.)
      const q = s.points.find((x) => Math.abs(x.x - goal.x) < 0.6 && Math.abs(x.z - goal.z) < 0.6);
      if (q && !m.skip.includes(pkey(q)) && q.kind !== 'portal' && q.kind !== 'boss' && q.kind !== 'shrine') m.skip = [...m.skip, pkey(q)];
      m.stuck = 0;
    }
  }
  // A low ledge ahead: hop it instead of walking around.
  // Hills are climbed by jumping all the way up: whenever the way ahead stops a walker but not a jumper.
  if (move && best >= 0 && p.grounded) {
    const fr = s.terrain.free?.[best], hp = s.terrain.hop?.[best];
    if (fr !== undefined && hp !== undefined ? fr < 2.5 && hp > fr + 0.4 : s.terrain.ring[best] > 0.45 && s.terrain.ring[best] <= 1.6) jump = true;
    if (routeJump && pull && move.x * pull.x + move.z * pull.z > 0.5) jump = true;
  }

  // ---- a forced goal: over the crowd rather than around it ----
  if (goal.forced && p.grounded && move && sit.n8 >= 1) jump = true;

  // ---- ringed in: go over them ----
  // Jumping clears a crowd of walkers. With the pack bunched around us this is also the best place to be hitting it
  // from, so the jump comes before the hits do, not after.
  if (p.grounded && move && (sit.surrounded || sit.n3 >= Math.max(3, t.dashSurround - 1) || (sit.n8 >= 10 && sit.nearest < 1.5))) jump = true;

  // ---- shock rings: jump as the ring reaches us ----
  for (const w of s.waves) {
    const dist = len(p.x - w.x, p.z - w.z);
    if (dist <= w.max + 1 && Math.abs(dist - w.r) < Math.max(1.2, w.speed * 0.22) && w.r <= dist + 0.6) { if (p.grounded) jump = true; }
  }

  // ---- dash out of a surround or an imminent hit ----
  let dash = false;
  // (A strike that lands sooner than walking gets us out of its circle.)
  const hazardNow = s.hazards.some((hz) => { const d = len(p.x - hz.x, p.z - hz.z); return d < hz.r + 0.3 && (hz.kind !== 'telegraph' || hz.t < (hz.r + 0.6 - d) / Math.max(3, m.speed) + 0.25); });
  const charged = !!(boss && boss.chargeT > 0 && segDist(p.x, p.z, boss.x, boss.z, boss.x + boss.cdx * 40, boss.z + boss.cdz * 40) < boss.radius + 2);
  const laneNow = lanes.some((ln) => ln.live && segDist(p.x, p.z, ln.ax, ln.az, ln.bx, ln.bz) < ln.r + p.radius + 0.9 && len(p.x - ln.ax, p.z - ln.az) < 8);
  if (p.dashReady && move && (laneNow || (goal.forced && sit.n8 >= 1) || sit.n3 >= t.dashSurround || (sit.surrounded && sit.nearest < 2) || hazardNow || charged || (sit.hpFrac < t.lowHp && sit.nearest < 2.5))) dash = true;

  // ---- the ultimate ----
  let ult = false, why = '';
  if (s.ult.ready) {
    const wakeLv = t.wakeLevel[Math.min(t.wakeLevel.length - 1, Math.max(0, s.stage - 1))];
    const bossSoon = !s.bossSpawned && !s.stageCleared && (goal.kind === 'wake' || p.level >= wakeLv - 1 || s.stageTime >= t.wakeAfterSec - t.ultHoldSec);
    if (boss && boss.fightT > 1.5 && boss.hp > boss.maxHp * 0.08) { ult = true; why = 'boss phase'; }
    else if (sit.surrounded || sit.n8 >= t.ultCrowd) { ult = true; why = 'surrounded'; }
    // The herd is bunched up next to us: this is what the ultimate was saved for outside boss fights.
    else if (!bossSoon && sit.n8 >= t.ultHerd && sit.n8 >= sit.n15 * 0.6) { ult = true; why = `herd of ${sit.n8} in range`; }
    else if (sit.hpFrac < t.surviveHp && sit.n3 >= 2) { ult = true; why = 'hurt and pressed'; }
    else if (!bossSoon && sit.pressure >= t.ultPressure) { ult = true; why = 'arena pressure'; }
    else if (!bossSoon && s.enemies.count >= t.hordeSize * 1.5 && sit.n15 >= 8) { ult = true; why = 'horde'; }
  }

  // ---- use what we came for ----
  let interact = false;
  if (goal.interact && gd <= goal.reach + 1.2 && s.t - m.lastInteract > 0.6) {
    interact = true; m.lastInteract = s.t;
    // A service point is used once: whatever its dialog was answered, it is not walked to again in this zone.
    if (goal.kind === 'visit' && ++m.visitPresses >= 2) {
      const q = s.points.find((x) => Math.abs(x.x - goal.x) < 0.6 && Math.abs(x.z - goal.z) < 0.6);
      if (q && !m.skip.includes(pkey(q))) m.skip = [...m.skip, pkey(q)];
      m.visitPresses = 0;
    }
  }
  // A fallen Alpha within reach joins the team for the rest of the run: always worth the key press.
  else if (s.friendBall && s.t - m.lastInteract > 0.6) { interact = true; m.lastInteract = s.t; }
  // A capture target that can be thrown at from here.
  else if (s.capture?.canThrow && sit.hpFrac >= t.lowHp && s.t - m.lastInteract > 0.6) { interact = true; m.lastInteract = s.t; }

  if (move) m.dir = move;
  if (!s.enemies.list.length && goal.kind === 'roam' && m.stuck > 1) m.wander += 0.4;

  const action: Action = { move, dash, jump, ult, interact, intent: goal.kind, note: ult ? `${goal.note} · ult: ${why}` : goal.note };
  return { action, mem: m, sit, scores, goal: { kind: goal.kind, x: goal.x, z: goal.z, far: goal.kind !== 'flee' && gd > 14 } };
}
