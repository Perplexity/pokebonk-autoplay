/**
 * Functions that run UNCHANGED on both sides of the fidelity comparison: in the Node process of the headless
 * environment, and inside the page of the real browser (sent there as source text, `fn.toString()`).
 *
 * Rule for everything in this file, the same rule `extractSnapshot` follows: every function is self-contained. No
 * imports, no closures, nothing from this module's scope. Types are `any` because the arguments are live game objects.
 */

/**
 * State digest of one simulation step.
 *
 * `line` is what gets compared: a few readable values first (so a difference can be read without tooling), then one
 * hash per group of state. `groups` (only with `ctx.detail`) holds every hashed value by name, so that two sides which
 * differ in a hash can be compared field by field.
 *
 * Numbers are hashed by their IEEE-754 bits (NaN canonical), so "equal" means bit-identical, not "close".
 */
export function stepDigest(run: any, ctx: { i: number; math: number; crypto: number; rngS: number; pending: string | null; detail?: boolean }): { line: unknown[]; groups?: Record<string, Record<string, unknown>> } {
  const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);
  const hasher = () => {
    let a = 0x811c9dc5 | 0, b = 0x9e3779b9 | 0, n = 0;
    return {
      num(v: number) {
        if (v !== v) { u32[0] = 0; u32[1] = 0x7ff80000; } else f64[0] = v;
        a = Math.imul(a ^ u32[0], 16777619); b = Math.imul(b ^ u32[1], 0x85ebca6b);
        a ^= b >>> 15; b ^= a >>> 13; n++;
      },
      str(s: string) { for (let i = 0; i < s.length; i++) { a = Math.imul(a ^ s.charCodeAt(i), 16777619); b = Math.imul(b ^ a, 0x85ebca6b); } n++; },
      hex() { return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0') + '/' + n; },
    };
  };
  const isTyped = (v: any) => ArrayBuffer.isView(v) && !(v instanceof DataView);
  const hashTyped = (v: any, m: number) => { const h = hasher(); for (let i = 0; i < m; i++) h.num(v[i]); return h.hex(); };
  const prim = (v: any) => v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string';
  const SKIP = new Set(['run', 'meta', 'data', 'def', 'el', 'mesh', 'hud', 'ui', 'r', 'input', 'audio', 'sprites', 'vfx', 'terrain', 'scene', 'group', 'pool', 'glow', 'grid', 'cells', 'roster', 'biome', 'material', 'geometry', 'parent', 'children']);

  /** Struct-of-arrays pool: every typed array up to the high-water mark `n`, and the pool's own scalars. */
  const pool = (P: any): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    if (!P) return out;
    const cap = P.alive ? P.alive.length : 0, n = P.n | 0;
    for (const k of Object.keys(P).sort()) {
      const v = P[k];
      if (isTyped(v)) {
        const stride = cap && v.length >= cap ? Math.max(1, Math.floor(v.length / cap)) : 0;
        out[k] = hashTyped(v, stride ? Math.min(v.length, n * stride) : v.length);
      } else if (Array.isArray(v) && cap && v.length === cap) {
        const h = hasher();
        for (let i = 0; i < n; i++) { const e = v[i]; h.str(prim(e) ? String(e) : Array.isArray(e) && e.every(prim) ? e.join(',') : typeof e); }
        out[k] = h.hex();
      } else if (Array.isArray(v) && v.every(prim)) out[k] = v.length + ':' + v.slice(0, 64).join(',');
      else if (prim(v)) out[k] = v ?? null;
    }
    return out;
  };

  /** Plain walk of an object's own data, `depth` levels down: primitives as they are, typed arrays hashed. */
  const deep = (o: any, depth: number, out: Record<string, unknown> = {}, path = '', seen = new Set<any>()): Record<string, unknown> => {
    if (!o || typeof o !== 'object' || seen.has(o)) return out;
    seen.add(o);
    for (const k of Object.keys(o).sort()) {
      if (SKIP.has(k)) continue;
      const v = o[k], p = path + k;
      if (typeof v === 'function') continue;
      // 3D models of the capture balls: objects in a browser, null where no model loader runs. Not simulation state.
      if (v == null && (k === 'ball' || k === 'plain' || k === 'master')) continue;
      if (prim(v)) { out[p] = v ?? null; continue; }
      if (isTyped(v)) { out[p] = hashTyped(v, v.length); continue; }
      if (typeof v.nodeType === 'number' || v.isObject3D || v.isMaterial || v.isTexture || v.isBufferGeometry) continue;
      if (typeof v.x === 'number' && typeof v.z === 'number' && Object.keys(v).length <= 4) { out[p] = [v.x, v.y ?? 0, v.z, v.w ?? 0].join(','); continue; }
      if (v instanceof Map) {
        out[p + '.size'] = v.size;
        if (depth > 0) { let i = 0; for (const [mk, mv] of v) { if (i++ >= 48) break; if (prim(mv)) out[p + '.' + String(mk)] = mv ?? null; else if (prim(mk)) deep(mv, depth - 1, out, p + '.' + String(mk) + '.', seen); } }
        continue;
      }
      if (v instanceof Set) { out[p] = v.size + ':' + [...v].filter(prim).slice(0, 48).join(','); continue; }
      if (Array.isArray(v)) {
        if (v.every(prim)) { out[p] = v.length + ':' + v.slice(0, 96).join(','); continue; }
        out[p + '.length'] = v.length;
        if (depth > 0) for (let i = 0; i < v.length && i < 48; i++) { const e = v[i]; if (prim(e)) out[p + '.' + i] = e ?? null; else deep(e, depth - 1, out, p + '.' + i + '.', seen); }
        continue;
      }
      if (depth > 0) deep(v, depth - 1, out, p + '.', seen);
    }
    return out;
  };
  const hashGroup = (g: Record<string, unknown>) => { const h = hasher(); for (const k of Object.keys(g).sort()) { h.str(k); const v = g[k]; if (typeof v === 'number') h.num(v); else h.str(String(v)); } return h.hex(); };

  const p = run.player, E = run.enemies;
  let alive = 0;
  if (E && E.alive) for (let i = 0; i < E.n; i++) if (E.alive[i] && !(E.dying[i] > 0) && !(E.flags[i] & (32768 | 65536))) alive++;

  // Own scalars of the run object. Wall-clock stamps (values of performance.now() kept by the game) go in their own
  // group: they describe when something happened on the page clock, which loading time shifts, not what happened.
  const runAll = deep(run, 0), runState: Record<string, unknown> = {}, runClock: Record<string, unknown> = {};
  // `realTime` is NOT in this list (it was): play code compares it with thresholds, and the environment sets it back
  // after every loading phase, so it has to be equal.
  const CLOCK = new Set(['bornAt', 'profAt', 'resumedAt', 'autoAt', 'unstickAt', 'fanfareAt', 'realDt', 'fpsAcc', 'fpsN', 'fps', 'playFps', 'saveQueuedAt', 'musicT']);
  for (const k of Object.keys(runAll)) (CLOCK.has(k) ? runClock : runState)[k] = runAll[k];
  const points: Record<string, unknown> = {};
  const list = (run.interactables && run.interactables.list) || [];
  for (let i = 0; i < list.length; i++) { const it = list[i]; points[i] = [it.kind, it.x, it.z, it.used ? 1 : 0, it.cost ?? 0, it.dead ? 1 : 0].join(','); }
  const groups: Record<string, Record<string, unknown>> = {
    run: runState,
    runClock,
    player: deep(p, 3),
    enemies: pool(E),
    projectiles: pool(run.projectiles),
    pickups: pool(run.pickups),
    director: deep(run.director, 2),
    stats: deep(run.stats, 2),
    ult: deep(run.ult, 1),
    points,
    sides: { ...deep(run.boss, 1, {}, 'boss.'), ...deep(run.capture, 1, {}, 'capture.'), ...deep(run.seals, 1, {}, 'seals.'), ...deep(run.overtime, 1, {}, 'overtime.'), ...deep(run.allies, 1, {}, 'allies.'), ...deep(run.zone, 1, {}, 'zone.'), ...deep(run.econ, 1, {}, 'econ.'), ...deep(run.rollN, 1, {}, 'rollN.') },
  };
  const line: unknown[] = [
    ctx.i, String(run.state), run.time, run.stageTime, run.stage | 0,
    p.pos.x, p.pos.y, p.pos.z, p.hp, p.xp, p.level | 0, run.stats ? run.stats.kills | 0 : 0,
    E ? E.n | 0 : 0, alive, ctx.math, ctx.crypto, ctx.rngS >>> 0, ctx.pending,
  ];
  for (const name of Object.keys(groups)) line.push(name + '=' + hashGroup(groups[name]));
  return ctx.detail ? { line, groups } : { line };
}

/** Names of the leading columns of `stepDigest().line`, for reports. */
export function digestColumns(): string[] {
  return ['simStep', 'state', 'time', 'stageTime', 'stage', 'x', 'y', 'z', 'hp', 'xp', 'level', 'kills', 'enemySlots', 'enemiesAlive', 'mathRandomCalls', 'cryptoCalls', 'gameRngState', 'pendingDialog'];
}

/**
 * The scripted play action for play step `i` (0-based count of play decisions in the episode).
 *
 *   walk   eight directions in turn, 45 steps each, with a pause; a jump every 37 steps, a dash every 113
 *   idle   nothing
 *   dance  short direction changes (every 7 steps), jumps every 11 steps, dashes every 53: stresses collision edges
 */
export function scriptAction(script: string, i: number): { type: 'play'; move: string; jump: boolean; dash: boolean } {
  const DIRS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw', 'none'];
  if (script === 'walk') return { type: 'play', move: DIRS[Math.floor(i / 45) % 9], jump: i % 37 === 5, dash: i % 113 === 60 };
  if (script === 'dance') return { type: 'play', move: DIRS[(Math.floor(i / 7) * 5) % 9], jump: i % 11 === 3, dash: i % 53 === 20 };
  if (script === 'east') return { type: 'play', move: 'e', jump: i % 50 === 10, dash: i % 97 === 40 };
  return { type: 'play', move: 'none', jump: false, dash: false };
}

/**
 * Play mask of the environment, for the page side: a port of the play branch of `HeadlessGameEnvironment.mask()`
 * (the game's own conditions for the interact and ultimate keys). The headless side computes it too and checks it
 * against the mask the environment hands out, so a change of the original cannot go unnoticed.
 */
export function playMask(run: any): { ultimate: boolean; interact: boolean } {
  const can = (f: () => unknown): boolean => { try { return !!f(); } catch { return false; } };
  const near = (run.interactables && run.interactables.nearest) || null;
  const throwing = !!(run.capture && run.capture.throwing);
  const interact = run.state === 'play' && (
    can(() => run.rifts.nearEntrance()) ||
    (!throwing && (can(() => run.capture.canThrow()) || (!near && can(() => run.allies.canThrow())) || (!near && can(() => run.rifts.canCallWave())) || !!near)));
  return { ultimate: run.state === 'play' && !!(run.ult && run.ult.ready) && !(run.ult && run.ult.active > 0), interact };
}

/**
 * The `seek` script: a player that reads the live run object (this is a test script, not an agent). It walks to the
 * nearest map point that is not used yet and presses the interact key there, presses the ultimate key whenever the
 * mask allows it, and jumps and dashes like `walk`. With no target left it walks like `walk`.
 *
 * No trigonometry (the two engines round it differently): the direction is one of eight, chosen by comparing the two
 * coordinate differences. `memo` is a plain object the caller keeps for the episode: a point that was tried for a
 * while without becoming used (too expensive, on a cooldown, behind a rock) is given up.
 */
export function seekAction(run: any, i: number, mask: { ultimate: boolean; interact: boolean }, memo: any): { type: 'play'; move: string; jump: boolean; dash: boolean; interact: boolean; ultimate: boolean } {
  const p = run.player.pos, list = (run.interactables && run.interactables.list) || [];
  memo.given = memo.given || {}; memo.log = memo.log || [];
  const keyOf = (it: any) => String(it.kind) + '@' + it.x + ',' + it.z;
  // What a press of the key did to the target of the previous step: logged once, when the point becomes used.
  // Nothing is ever written to a game object: what was logged is remembered by key.
  memo.logged = memo.logged || {};
  if (memo.target && memo.target.used && !memo.logged[keyOf(memo.target)]) {
    memo.logged[keyOf(memo.target)] = true;
    if (memo.log.length < 200) memo.log.push([i, String(memo.target.kind), memo.pressedAt === undefined ? null : memo.pressedAt, memo.pressedDist === undefined ? null : memo.pressedDist, memo.target.r]);
  }
  memo.presses = memo.presses || {};
  let best: any = null, bestD = Infinity;
  for (const it of list) {
    if (it.used || it.dead || memo.given[keyOf(it)]) continue;
    if ((memo.presses[keyOf(it)] || 0) >= 3) continue; // pressed three times and still not used: a leave-only point, or too expensive
    if (it.kind === 'shroom' || it.kind === 'bonk') continue; // a bouncer and a pickup: nothing to "use"
    const d = (it.x - p.x) * (it.x - p.x) + (it.z - p.z) * (it.z - p.z);
    if (d < bestD) { bestD = d; best = it; }
  }
  const walk = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw', 'none'][Math.floor(i / 45) % 9];
  const base = { type: 'play' as const, move: walk, jump: i % 37 === 5, dash: i % 113 === 60, interact: false, ultimate: !!mask.ultimate && i % 5 === 0 };
  if (!best) { memo.target = null; if (mask.interact && i % 15 === 0) base.interact = true; return base; }
  if (memo.target !== best) { memo.target = best; memo.since = i; memo.pressedAt = undefined; memo.pressedDist = undefined; }
  if (i - memo.since > 1500) { memo.given[keyOf(best)] = true; memo.target = null; return base; }
  const dx = best.x - p.x, dz = best.z - p.z, ax = Math.abs(dx), az = Math.abs(dz), dist = Math.sqrt(bestD);
  let move = 'none';
  if (dist > (best.r || 2.6) * 0.5) {
    const ew = dx > 0 ? 'e' : 'w', ns = dz > 0 ? 's' : 'n';
    move = ax > 2.414 * az ? ew : az > 2.414 * ax ? ns : ns + ew;
  }
  const press = !!mask.interact && i % 15 === 0;
  if (press && run.interactables.nearest === best) { memo.pressedAt = i; memo.pressedDist = dist; memo.presses[keyOf(best)] = (memo.presses[keyOf(best)] || 0) + 1; }
  return { type: 'play', move, jump: base.jump, dash: base.dash && dist > 12, interact: press, ultimate: base.ultimate };
}

/**
 * The scripted answer to a dialog: a fixed rule over the mask, the same on both sides. `n` is the 0-based count of
 * dialogs answered so far: option choice rotates with it so that more than the first card gets exercised.
 */
export function scriptAnswer(mask: { options: boolean[]; extras: Record<string, boolean | boolean[]> }, n: number): { type: 'choice'; option?: number; extra?: string; target?: number } {
  const valid: number[] = [];
  mask.options.forEach((ok, i) => { if (ok) valid.push(i); });
  if (valid.length) return { type: 'choice', option: valid[n % valid.length] };
  for (const extra of ['leave', 'decline', 'sell', 'skip']) if (mask.extras[extra] === true) return { type: 'choice', extra };
  throw new Error('scriptAnswer: the dialog has no valid action');
}

/**
 * Everything about a freshly started run that does not depend on play: the generated map, the run's parameters, the
 * player's starting state, the spawn tables, what the sprite cache holds. Called on both sides right after loading.
 */
export function staticDump(run: any, app: any): Record<string, unknown> {
  const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);
  const hashNums = (v: ArrayLike<number>) => {
    let a = 0x811c9dc5 | 0, b = 0x9e3779b9 | 0;
    for (let i = 0; i < v.length; i++) { const x = v[i]; if (x !== x) { u32[0] = 0; u32[1] = 0x7ff80000; } else f64[0] = x; a = Math.imul(a ^ u32[0], 16777619); b = Math.imul(b ^ u32[1], 0x85ebca6b); a ^= b >>> 15; b ^= a >>> 13; }
    return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0') + '/' + v.length;
  };
  const prim = (v: any) => v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string';
  const plain = (v: any, depth: number): unknown => {
    if (prim(v)) return v ?? null;
    if (typeof v === 'function') return undefined;
    if (ArrayBuffer.isView(v)) return 'typed:' + hashNums(v as any);
    if (depth <= 0) return undefined;
    if (Array.isArray(v)) return v.slice(0, 400).map((x) => plain(x, depth - 1) ?? null);
    if (v instanceof Map) return Object.fromEntries([...v.entries()].slice(0, 200).map(([k, x]) => [String(k), plain(x, depth - 1) ?? null]));
    if (v instanceof Set) return [...v].slice(0, 200).map((x) => plain(x, depth - 1) ?? null);
    if (typeof v.nodeType === 'number' || v.isObject3D || v.isMaterial || v.isTexture) return undefined;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) { if (k === 'run' || k === 'meta' || k === 'el' || k === 'mesh' || k === 'group') continue; const x = plain(v[k], depth - 1); if (x !== undefined) out[k] = x; }
    return out;
  };
  const T = run.terrain, p = run.player;
  const heights: number[] = [];
  const G = 48;
  for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) heights.push(T.height(-T.play + (2 * T.play * i) / G, -T.play + (2 * T.play * j) / G));
  const walk: number[] = [];
  for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) {
    const x = -T.play + (2 * T.play * i) / G, z = -T.play + (2 * T.play * j) / G, h = T.height(x, z);
    walk.push((T.inBounds(x, z, 1.5) ? 1 : 0) | (T.hitProp(x, h + 0.3, z, 0.4) ? 2 : 0) | (T.hasWater && T.waterAt && h < T.waterAt(x, z) - 0.6 ? 4 : 0));
  }
  const batches: Record<string, unknown> = {};
  for (const [id, b] of run.sprites.batches) batches[id] = [b.ready ? 1 : 0, b.fallback ? 1 : 0, b.foot.foot, b.foot.top, b.foot.width, b.meta.w, b.meta.h].join(',');
  const moves = (p.moves || []).map((m: any) => (m && m.def ? { key: m.def.key, level: m.level, type: m.def.type, arch: m.def.arch, cls: m.def.cls, cd: m.def.cd, area: m.def.area, dmg: m.def.dmg ?? m.def.power ?? null, own: plain(Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'def')), 1) } : null));
  return {
    run: {
      seed: run.seed, mode: run.mode, biome: run.biome && run.biome.id, tier: run.tier, competitive: !!run.competitive, stage: run.stage, state: run.state,
      weather: run.weather, baseWeather: run.baseWeather, maxEnemies: run.maxEnemies, liveCap: run.liveCap, liveMax: run.liveMax, fpsCap: run.fpsCap,
      rerolls: run.rerolls, skips: run.skips, banishes: run.banishes, friendLv: run.friendLv, aimMode: run.aimMode, music: run.music, camYaw: run.camYaw, camPitch: run.camPitch, camDist: run.camDist,
      diff: plain(run.diff, 2), econ: plain(run.econ, 2), zone: plain(run.zone, 2), nextEvo: plain(run.nextEvo, 2), research: plain(run.research, 2), sealsEnabled: !!(run.seals && run.seals.enabled),
    },
    settings: plain(app.meta.profile.settings, 2),
    appFpsCap: app.fpsCap(),
    terrain: {
      seed: T.seed, world: T.world, res: T.res, cell: T.cell, play: T.play, minH: T.minH, maxH: T.maxH, waterLevel: T.waterLevel, hasWater: !!T.hasWater, isLava: !!T.isLava, frozen: !!T.frozen,
      arenaR: String(T.arenaR), ringR: String(T.ringR), colMaxR: T.colMaxR, spawn: [T.spawn.x, T.spawn.y, T.spawn.z],
      heightMap: hashNums(T.heights), pathMask: hashNums(T.pathMask), heightSamples: heights, walkSamples: walk,
      colliders: (T.colliders || []).map((c: any) => [c.x, c.z, c.r, c.h, c.off ? 1 : 0, c.y ?? null]),
      solidBoxes: plain(T.solidBoxes, 3), clearZones: plain(T.clearZones, 3), ponds: plain(T.ponds, 3), massifs: plain(T.massifs, 3),
      landmarks: (T.landmarks || []).map((l: any) => plain(l, 1)), colGridCells: T.colGrid ? T.colGrid.size : null, envListLength: T.envList ? T.envList.length : null,
    },
    points: (run.interactables.list || []).map((it: any) => [String(it.kind), String((it.data && it.data.sub) ?? ''), it.x, it.y ?? null, it.z, it.r, it.used ? 1 : 0, it.cost ?? null]),
    player: {
      species: p.speciesId, types: p.types, level: p.level, hp: p.hp, maxHp: p.maxHp, shield: p.shield, xpNext: p.xpNext, radius: p.radius, baseSpeed: p.baseSpeed, ability: p.ability,
      moveSlots: p.moveSlots, vitaminSlots: p.vitaminSlots, revives: p.revives, pos: [p.pos.x, p.pos.y, p.pos.z], stats: plain(p.stats, 2), pstat: plain(p.pstat, 2),
      items: plain(p.items, 2), vitamins: plain(p.vitamins, 2), kitCls: p.kitCls, kitKeys: plain(p.kitKeys, 1), moves,
    },
    director: plain({ cards: run.director.cards, pool: run.director.pool, timeline: run.director.timeline, latePool: run.director.latePool, residentPool: run.director.residentPool, cardsDrawn: run.director.cardsDrawn, weight: run.director.weight }, 4),
    spriteBatches: batches,
    boss: plain({ species: run.boss && run.boss.species, name: run.boss && run.boss.name }, 1),
  };
}

/**
 * Ask the game's own sprite cache for one sheet and report what its `measure()` derived from the pixels, plus the
 * collision radius and height the game would give an enemy of scale 1 (same expressions as the spawn code:
 * radius = clamp(bodyWidth·0.42, 0.45, 4), height = max(0.8, bodyHeight)). Returns null while the sheet is loading.
 */
export function sheetMeasure(run: any, id: number): unknown {
  const b = run.sprites.get(id);
  if (!b.ready) return null;
  const lunge: Record<string, string> = {};
  for (const [k, v] of b.lunge) lunge[k] = Array.from(v as ArrayLike<number>).join(',');
  const w = b.bodyWidth(1), h = b.bodyHeight(1);
  return { id, url: String(b.url).replace(/^.*\/assets\//, ''), fallback: !!b.fallback, w: b.meta.w, h: b.meta.h, foot: b.foot.foot, top: b.foot.top, width: b.foot.width, bodyWidth: w, bodyHeight: h, radius: Math.max(0.45, Math.min(4, w * 0.42)), height: Math.max(0.8, h), lunge };
}

/**
 * Results of the engine's Math functions on a fixed set of inputs (a small generator of its own, no Math.random).
 * Run in both engines and compared value by value: it shows which functions the two JavaScript engines compute
 * differently in the last bit.
 */
export function mathBattery(n: number): Record<string, number[]> {
  let s = 0x2545f491;
  const u = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
  const ranges: Record<string, [number, number]> = {
    sin: [-7, 7], cos: [-7, 7], tan: [-1.5, 1.5], asin: [-1, 1], acos: [-1, 1], atan: [-50, 50], sinh: [-5, 5], cosh: [-5, 5], tanh: [-3, 3],
    asinh: [-50, 50], acosh: [1, 50], atanh: [-1, 1], exp: [-20, 20], expm1: [-2, 2], log: [1e-6, 1000], log1p: [-0.9, 10], log2: [1e-6, 1000], log10: [1e-6, 1000],
    sqrt: [0, 1e6], cbrt: [-1e6, 1e6],
  };
  const out: Record<string, number[]> = {};
  for (const name of Object.keys(ranges)) {
    const [a, b] = ranges[name], f = (Math as any)[name] as (x: number) => number, list: number[] = [];
    for (let i = 0; i < n; i++) list.push(f(a + (b - a) * u()));
    out[name] = list;
  }
  const two: Record<string, [(x: number, y: number) => number, [number, number], [number, number]]> = {
    atan2: [Math.atan2, [-200, 200], [-200, 200]], pow: [Math.pow, [0, 50], [-3, 3]], hypot: [Math.hypot, [-200, 200], [-200, 200]],
    'sin(large)': [(x) => Math.sin(x * 1000), [-1000, 1000], [0, 1]], 'cos(large)': [(x) => Math.cos(x * 1000), [-1000, 1000], [0, 1]],
    'pow(x,0.5)': [(x) => Math.pow(x, 0.5), [0, 1e4], [0, 1]], 'pow(x,2)': [(x) => Math.pow(x, 2), [-100, 100], [0, 1]], 'x**1.5': [(x) => x ** 1.5, [0, 100], [0, 1]],
    'exp(-x*dt)': [(x) => Math.exp(-x / 60), [0, 40], [0, 1]], fround: [(x) => Math.fround(x), [-1e4, 1e4], [0, 1]],
  };
  for (const name of Object.keys(two)) {
    const [f, [a, b], [c, d]] = two[name], list: number[] = [];
    for (let i = 0; i < n; i++) list.push(f(a + (b - a) * u(), c + (d - c) * u()));
    out[name] = list;
  }
  return out;
}

/**
 * Where the current call came from: the first frames of the stack that are in the game's own chunks, as
 * "chunk:line:column" (both sides run the same bytes, so positions are comparable). `skip` frames are dropped from
 * the top (the tracer's own).
 */
export function callSite(skip: number, depth: number): string {
  const lines = String(new Error().stack).split('\n').slice(1 + skip);
  const out: string[] = [];
  for (const l of lines) {
    const m = /assets\/([\w-]+?)-[\w-]{8}(?:-\w+)?\.js:(\d+):(\d+)/.exec(l);
    if (!m) continue;
    out.push(m[1] + ':' + m[2] + ':' + m[3]);
    if (out.length >= depth) break;
  }
  return out.join(' < ');
}

/**
 * Which map points and capture balls have a 3D model right now. A map point's scene group is created with the point;
 * its model is added as a child when (if) the file arrives.
 */
export function modelFacts(run: any): Record<string, unknown> {
  const list = (run.interactables && run.interactables.list) || [];
  const kinds: Record<string, string> = {};
  let groups = 0, withModel = 0;
  for (const it of list) {
    const g = it.group;
    if (!g || (g.userData && g.userData.sprite)) continue; // drawn as a sprite (berries): never has a model
    groups++;
    const has = g.children && g.children.length > 0;
    if (has) withModel++;
    const k = String(it.kind), c = (kinds[k] || '0/0').split('/').map(Number);
    kinds[k] = (c[0] + (has ? 1 : 0)) + '/' + (c[1] + 1);
  }
  const cap = run.capture;
  return { points: list.length, pointsWithGroup: groups, pointsWithModel: withModel, byKind: kinds, captureBall: !!(cap && cap.plain), masterBall: !!(cap && cap.master) };
}

/**
 * What a page script can read about the platform it runs on (no game object involved): the values the shims choose on
 * one side, and what the real browser reports on the other. Compared as a list of known platform differences.
 */
export function platformFacts(): Record<string, unknown> {
  const g: any = globalThis, n: any = g.navigator || {}, d: any = g.document || {}, s: any = g.screen || {};
  const safe = (f: () => unknown): unknown => { try { const v = f(); return v === undefined ? 'undefined' : v; } catch (e: any) { return 'throws ' + String(e && e.name); } };
  const mm = (q: string) => safe(() => !!g.matchMedia(q).matches);
  const has: Record<string, string> = {};
  for (const k of ['createImageBitmap', 'OffscreenCanvas', 'Worker', 'SharedWorker', 'WebSocket', 'RTCPeerConnection', 'XMLHttpRequest', 'EventSource', 'BroadcastChannel', 'requestIdleCallback', 'indexedDB', 'caches', 'Notification', 'AudioContext', 'webkitAudioContext', 'CompressionStream', 'structuredClone', 'ResizeObserver', 'IntersectionObserver', 'PointerEvent', 'TouchEvent', 'GamepadEvent', 'VideoFrame', 'WebGL2RenderingContext', 'ImageDecoder', 'FontFace', 'Intl']) has[k] = typeof g[k];
  for (const k of ['gpu', 'serviceWorker', 'locks', 'wakeLock', 'vibrate', 'share', 'storage', 'connection', 'clipboard', 'mediaSession', 'keyboard', 'getBattery', 'sendBeacon', 'userAgentData']) has['navigator.' + k] = typeof n[k];
  has['performance.memory'] = typeof (g.performance && g.performance.memory);
  has['document.fonts'] = typeof d.fonts;
  has['screen.orientation'] = typeof s.orientation;
  return {
    userAgent: safe(() => n.userAgent), platform: safe(() => n.platform), vendor: safe(() => n.vendor), language: safe(() => n.language), languages: safe(() => [...n.languages]),
    webdriver: safe(() => n.webdriver), onLine: safe(() => n.onLine), hardwareConcurrency: safe(() => n.hardwareConcurrency), deviceMemory: safe(() => n.deviceMemory),
    maxTouchPoints: safe(() => n.maxTouchPoints), userActivation: safe(() => [n.userActivation.isActive, n.userActivation.hasBeenActive]), gamepads: safe(() => [...n.getGamepads()].filter(Boolean).length),
    cookieEnabled: safe(() => n.cookieEnabled), pdfViewerEnabled: safe(() => n.pdfViewerEnabled),
    devicePixelRatio: safe(() => g.devicePixelRatio), inner: safe(() => [g.innerWidth, g.innerHeight]), outer: safe(() => [g.outerWidth, g.outerHeight]),
    screen: safe(() => [s.width, s.height, s.availWidth, s.availHeight, s.colorDepth]), orientation: safe(() => s.orientation.type),
    hidden: safe(() => d.hidden), visibilityState: safe(() => d.visibilityState), hasFocus: safe(() => d.hasFocus()), pointerLock: safe(() => !!d.pointerLockElement), fullscreen: safe(() => !!d.fullscreenElement),
    fullscreenEnabled: safe(() => d.fullscreenEnabled), readyState: safe(() => d.readyState), referrer: safe(() => d.referrer), fontsStatus: safe(() => d.fonts.status),
    location: safe(() => g.location.href), isSecureContext: safe(() => g.isSecureContext), crossOriginIsolated: safe(() => g.crossOriginIsolated), topIsSelf: safe(() => g.top === g.self),
    media: {
      reducedMotion: mm('(prefers-reduced-motion: reduce)'), dark: mm('(prefers-color-scheme: dark)'), coarsePointer: mm('(pointer: coarse)'), finePointer: mm('(pointer: fine)'), hover: mm('(hover: hover)'),
      portrait: mm('(orientation: portrait)'), standalone: mm('(display-mode: standalone)'), maxWidth900: mm('(max-width: 900px)'), minWidth1200: mm('(min-width: 1200px)'), highContrast: mm('(forced-colors: active)'),
    },
    timezoneOffset: safe(() => new Date(2026, 0, 15).getTimezoneOffset()), timeZone: safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone), locale: safe(() => Intl.DateTimeFormat().resolvedOptions().locale),
    numberFormat: safe(() => (1234567.891).toLocaleString()), dateNowMinusPerformance: safe(() => Math.round(Date.now() - g.performance.now())), timeOrigin: safe(() => g.performance.timeOrigin),
    storageKeys: safe(() => g.localStorage.length), sessionStorage: safe(() => typeof g.sessionStorage), cookie: safe(() => d.cookie),
    canvas: safe(() => { const c = d.createElement('canvas'); return { webgl2: !!c.getContext('webgl2'), }; }),
    canvasOther: safe(() => { const c1 = d.createElement('canvas'), c2 = d.createElement('canvas'), c3 = d.createElement('canvas'); return { '2d': !!c1.getContext('2d'), webgl: !!c2.getContext('webgl'), bitmaprenderer: !!c3.getContext('bitmaprenderer') }; }),
    audioCanPlay: safe(() => { const a = d.createElement('audio'); return [a.canPlayType('audio/ogg; codecs="vorbis"'), a.canPlayType('audio/mpeg'), a.canPlayType('audio/webm; codecs="opus"')]; }),
    has,
  };
}

/** State of the game's sound object at the moment of the call (the run holds it as `run.audio`). */
export function audioFacts(run: any): Record<string, unknown> {
  const a = run.audio;
  if (!a) return { present: false };
  const ctx = a.ctx;
  return {
    present: true, hasContext: !!ctx, state: ctx ? String(ctx.state) : null, currentTime: ctx ? ctx.currentTime : null, sampleRate: ctx ? ctx.sampleRate : null,
    noiseSamples: a.noiseBuf ? a.noiseBuf.length : null, running: !!a.running, voices: a.vEnds ? a.vEnds.length : null, maxVoices: a.maxVoices,
    densityKeys: a.dens ? [...a.dens.keys()].slice(0, 40) : null, musicOn: !!a.musicOn, track: a.track ? 'playing' : null, trackWant: a.trackWant ?? null, hooked: !!a.hooked, watchRebuilds: a.watchRebuilds,
  };
}
