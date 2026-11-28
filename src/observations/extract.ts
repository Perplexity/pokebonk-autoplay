/**
 * `extractSnapshot` runs INSIDE the sandbox page, with `this` bound to the game's live run object (it is sent as source
 * text through the debugger). It only reads: it copies the numbers the strategy needs into a plain JSON object and
 * returns it. Keep it self-contained: no imports, no closures, nothing from this module's scope.
 *
 * The result is a `Snapshot` (src/bot/snapshot.ts); docs/SNAPSHOT.md documents every field.
 */
export function extractSnapshot(this: any, navX?: number, navZ?: number): unknown {
  const run = this;
  const p = run.player;
  if (!p || !p.pos) return null;
  const r2 = (v: any) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : 0);
  const px: number = p.pos.x, pz: number = p.pos.z;

  // ---- player ----
  const moves: any[] = [];
  for (const m of p.moves || []) {
    if (!m || !m.def) continue;
    moves.push({ key: m.def.key, name: m.def.name, level: m.level | 0, type: m.def.type || '', arch: m.def.arch || '', cls: m.def.cls || '', cd: r2(m.def.cd), area: r2(m.def.area) });
  }
  const items: Record<string, number> = {};
  if (p.items && p.items.forEach) p.items.forEach((n: number, k: string) => { items[k] = n; });
  const vitamins: Record<string, number> = {};
  if (p.vitamins && p.vitamins.forEach) p.vitamins.forEach((v: any, k: string) => { vitamins[k] = (v && v.level) | 0; });
  const stats: Record<string, number> = {};
  for (const k of Object.keys(p.stats || {})) if (typeof p.stats[k] === 'number') stats[k] = r2(p.stats[k]);
  const player = {
    x: r2(px), y: r2(p.pos.y), z: r2(pz), vx: r2(p.vel?.x), vz: r2(p.vel?.z),
    hp: r2(p.hp), maxHp: r2(p.maxHp), shield: r2(p.shield),
    level: p.level | 0, xp: r2(p.xp), xpNext: r2(p.xpNext),
    dead: !!p.dead, iframes: r2(p.iframes), grounded: !!p.grounded,
    speed: r2(p.speedNow), radius: r2(p.radius), pickupRange: r2(p.stats?.pickupRange),
    sliding: p.slideT > 0,
    dashReady: typeof p.slideCd === 'number' ? p.slideCd <= 0 || run.time >= p.slideCd : true,
    jumpsLeft: p.jumpsLeft | 0, species: p.speciesId | 0, ability: String(p.ability || ''),
    moves, moveSlots: p.moveSlots | 0, vitaminSlots: p.vitaminSlots | 0, items, vitamins, stats,
  };

  // ---- enemies: the nearest ones, closest first ----
  const E = run.enemies;
  const near: any[] = [];
  let count = 0;
  const SKIP = 32768 | 65536; // map objects and other players' proxies are not threats
  if (E && E.alive) {
    for (let i = 0; i < E.n; i++) {
      if (!E.alive[i] || E.dying[i] > 0) continue;
      const f = E.flags[i];
      if (f & SKIP) continue;
      count++;
      const dx = E.x[i] - px, dz = E.z[i] - pz, d2 = dx * dx + dz * dz;
      if (d2 > 2025) continue;
      near.push([d2, i]);
    }
  }
  near.sort((a, b) => a[0] - b[0]);
  const list: any[] = [];
  for (let k = 0; k < near.length && k < 160; k++) {
    const i = near[k][1];
    list.push([i, r2(E.x[i]), r2(E.z[i]), r2(E.vx[i]), r2(E.vz[i]), r2(E.hp[i]), r2(E.maxHp[i]), r2(E.radius[i] * (E.scale[i] || 1)), r2(E.dmg[i]), r2(E.speed[i]), E.flags[i], E.species[i], r2(E.atk ? E.atk[i] : 9)]);
  }

  // ---- hostile projectiles near the player ----
  const shots: any[] = [];
  const P = run.projectiles;
  if (P && P.alive) {
    for (let i = 0; i < P.n && shots.length < 60; i++) {
      if (!P.alive[i] || !(P.flags[i] & 1)) continue;
      const dx = P.x[i] - px, dz = P.z[i] - pz;
      if (dx * dx + dz * dz > 900) continue;
      shots.push([r2(P.x[i]), r2(P.z[i]), r2(P.vx[i]), r2(P.vz[i]), r2(P.rad[i] || P.size[i] || 0.4), r2(P.dmg[i])]);
    }
  }

  // ---- boss, its ground hazards and shock rings ----
  const hazards: any[] = [], waves: any[] = [];
  const B = run.boss;
  let boss: any = null;
  const circles = (src: any, kind: string, depth: number) => {
    if (!src || typeof src !== 'object' || depth < 0) return;
    for (const k of Object.keys(src)) {
      if (k === 'run' || k === 'waves' || k === 'escorts') continue;
      const v = src[k];
      if (Array.isArray(v)) {
        for (const o of v) {
          if (o && typeof o === 'object' && typeof o.x === 'number' && typeof o.z === 'number' && typeof o.r === 'number' && hazards.length < 60) {
            const dx = o.x - px, dz = o.z - pz;
            if (dx * dx + dz * dz < 3600) hazards.push({ x: r2(o.x), z: r2(o.z), r: r2(o.r), t: r2(typeof o.t === 'number' ? o.t : typeof o.life === 'number' ? o.life : 0), kind: kind + '.' + k });
          }
        }
      } else if (v && typeof v === 'object' && depth > 0 && (k === 'kit' || k === 'mech' || k === 'flame' || k === 'spiral')) circles(v, kind + '.' + k, depth - 1);
    }
  };
  if (B) {
    circles(B, 'boss', 2);
    for (const w of B.waves || []) if (w && typeof w.r === 'number') waves.push({ x: r2(w.x), z: r2(w.z), r: r2(w.r), max: r2(w.max), speed: r2(w.speed) });
    const bi = B.bossIndex;
    if (typeof bi === 'number' && bi >= 0 && E && E.alive[bi]) {
      const mech = B.mech || B.kit || {};
      const phase = mech.epoch ?? mech.phase ?? B.phase ?? '';
      boss = {
        i: bi, name: String(B.name || ''), species: E.species[bi], x: r2(E.x[bi]), z: r2(E.z[bi]), hp: r2(E.hp[bi]), maxHp: r2(E.maxHp[bi]),
        radius: r2(E.radius[bi] * (E.scale[bi] || 1)), enraged: !!B.enraged, chargeT: r2(B.chargeT), cdx: r2(B.cdx), cdz: r2(B.cdz),
        move: String(B.moveName || B.last || ''), moveT: r2(B.moveT), fightT: r2(B.fightT), phase: String(phase),
      };
    }
  }
  for (const m of run.minibosses?.list || []) circles(m, 'mini', 0);
  // Telegraphed strikes: the warning circle the game draws before an attack lands (a boss's bolt, a totem's slam).
  // They only exist as "held" rings in the effects pool: where, how wide, and how long until impact.
  const G = run.vfx?.rings;
  if (G && G.hold && G.life) {
    for (let i = 0; i < G.n && hazards.length < 60; i++) {
      if (!G.hold[i] || !(G.life[i] > 0) || G.r0[i] < 0.8) continue;
      const dx = G.px[i] - px, dz = G.pz[i] - pz;
      if (dx * dx + dz * dz < 2500) hazards.push({ x: r2(G.px[i]), z: r2(G.pz[i]), r: r2(Math.max(G.r0[i], G.r1[i])), t: r2(G.life[i]), kind: 'telegraph' });
    }
  }

  // ---- pickups ----
  const K = run.pickups;
  let xpN = 0, xpX = 0, xpZ = 0;
  const heal: any[] = [], other: any[] = [];
  if (K && K.alive) {
    for (let i = 0; i < K.n; i++) {
      if (!K.alive[i]) continue;
      const dx = K.x[i] - px, dz = K.z[i] - pz, d2 = dx * dx + dz * dz;
      if (K.kind[i] === 0) { if (d2 < 400) { const w = K.value[i] || 1; xpN += w; xpX += K.x[i] * w; xpZ += K.z[i] * w; } }
      else if (d2 < 1600 && other.length < 24) other.push([K.kind[i], r2(K.x[i]), r2(K.z[i])]);
    }
  }
  if (xpN > 0) { xpX /= xpN; xpZ /= xpN; }

  // ---- map points: the nearest unused of each kind, plus every boss altar and portal ----
  const points: any[] = [];
  const byKind: Record<string, any[]> = {};
  // The game prices paid Poké Balls with one rising counter, not per ball: the list's own `cost` is always 0.
  let ballCost = 0;
  try { ballCost = Number(run.interactables.chestCost()) || 0; } catch { /* not every build */ }
  for (const it of run.interactables?.list || []) {
    if (!it || typeof it.x !== 'number') continue;
    const dx = it.x - px, dz = it.z - pz;
    const pt = { kind: String(it.kind), sub: String(it.data?.sub ?? ''), x: r2(it.x), z: r2(it.z), r: r2(it.r), used: !!it.used, cost: it.kind === 'chest' ? r2(ballCost) : r2(it.cost), d: r2(Math.sqrt(dx * dx + dz * dz)) };
    (byKind[pt.kind] ||= []).push(pt);
  }
  for (const kind of Object.keys(byKind)) {
    const arr = byKind[kind].sort((a, b) => a.d - b.d);
    const keep = kind === 'boss' || kind === 'portal' || kind === 'rush' ? arr : arr.filter((q) => !q.used).slice(0, 2);
    for (const q of keep) if (points.length < 60) points.push(q);
  }

  // ---- capture window ----
  let capture: any = null;
  const C = run.capture;
  if (C && C.state && C.state !== 'idle') {
    const ci = C.index;
    let canThrow = false;
    try { canThrow = !!C.canThrow?.(); } catch { /* not every build */ }
    capture = {
      state: String(C.state), index: ci, species: C.species | 0, mode: String(C.mode || ''), shiny: !!C.shiny,
      x: ci >= 0 && E?.alive[ci] ? r2(E.x[ci]) : 0, z: ci >= 0 && E?.alive[ci] ? r2(E.z[ci]) : 0, weakT: r2(C.weakT), canThrow,
    };
  }

  let friendBall = false;
  try { friendBall = !!run.allies?.canThrow?.(); } catch { /* not every build */ }

  // ---- terrain around the player ----
  // Measured with the game's own height map and prop colliders, the way the game itself decides what can be walked.
  //   free[k]  metres that can be walked in direction k before something stops a walker (a step up, a prop, the edge)
  //   hop[k]   metres that can be covered when jumping all the way (steps a jump clears, props low enough to clear)
  const T = run.terrain;
  const ring: number[] = [], ring2: number[] = [], blocked: number[] = [], free: number[] = [], hop: number[] = [];
  const REACH = 9, STEP = 0.5, WALK_UP = 0.6, JUMP_UP = 1.5;
  let h0 = p.pos.y;
  try { h0 = T.height(px, pz); } catch { /* keep the player's own height */ }
  const wet = (x: number, z: number, h: number) => { try { return T.hasWater && T.waterAt && h < T.waterAt(x, z) - 0.6; } catch { return false; } };
  for (let k = 0; k < 16; k++) {
    const a = (k * Math.PI) / 8, cx = Math.cos(a), cz = Math.sin(a);
    let d1 = 0, d2 = 0, bl = 0, fr = REACH, hp = REACH;
    try {
      d1 = T.height(px + cx * 2.5, pz + cz * 2.5) - h0;
      d2 = T.height(px + cx * 5, pz + cz * 5) - h0;
      let prev = h0, walking = true;
      for (let q = STEP; q <= REACH; q += STEP) {
        const x = px + cx * q, z = pz + cz * q, h = T.height(x, z);
        const out = T.inBounds ? !T.inBounds(x, z, 1.5) : false;
        const prop = T.hitProp ? T.hitProp(x, h + 0.3, z, 0.4) : false;
        const tall = prop && T.hitProp(x, h + 2.2, z, 0.4);
        const up = h - prev;
        if (out || tall || wet(x, z, h)) { if (walking) fr = q - STEP; hp = q - STEP; if (q <= 2.5) bl = 1; break; }
        if (walking && (up > WALK_UP || prop)) { fr = q - STEP; walking = false; }
        if (up > JUMP_UP) { hp = q - STEP; break; }
        prev = h;
      }
    } catch { /* leave the defaults */ }
    ring.push(r2(d1)); ring2.push(r2(d2)); blocked.push(bl); free.push(fr); hop.push(hp);
  }

  // ---- route to a far goal (only when the caller asks: it costs a few milliseconds) ----
  // A* over the height map on a coarse grid (one node every 2 cells, about 2.2 m). A step is walkable when it is
  // not too steep, jumpable when it is steeper but a run of jumps climbs it, and blocked by tall props, deep water
  // and the edge of the map. Dropping down is always allowed. Returns the next waypoint, about 8 m along the route.
  let nav: any = null;
  if (typeof navX === 'number' && typeof navZ === 'number' && T && T.heights) {
    try {
      const ST = 2, cell = T.cell * ST, half = T.world / 2, N = Math.floor((T.res - 1) / ST) + 1, lim = T.play - 2;
      const toI = (v: number) => Math.max(0, Math.min(N - 1, Math.round((v + half) / cell)));
      const toW = (i: number) => i * cell - half;
      const si = toI(px), sj = toI(pz), ti = toI(Math.max(-lim, Math.min(lim, navX))), tj = toI(Math.max(-lim, Math.min(lim, navZ)));
      // Search window: the box around start and target, with a margin to go around things.
      const M = 22, i0 = Math.max(0, Math.min(si, ti) - M), i1 = Math.min(N - 1, Math.max(si, ti) + M), j0 = Math.max(0, Math.min(sj, tj) - M), j1 = Math.min(N - 1, Math.max(sj, tj) + M);
      const W = i1 - i0 + 1, Hh = j1 - j0 + 1, size = W * Hh;
      const hgt = new Float32Array(size), solid = new Uint8Array(size);
      for (let j = 0; j < Hh; j++) for (let i = 0; i < W; i++) {
        const x = toW(i + i0), z = toW(j + j0), h = T.height(x, z), id = j * W + i;
        hgt[id] = h;
        if (Math.abs(x) > lim || Math.abs(z) > lim || wet(x, z, h)) solid[id] = 1;
      }
      for (const c of T.colliders || []) {
        if (c.off || c.r < 0.35) continue;
        const ci = toI(c.x) - i0, cj = toI(c.z) - j0, rr = Math.ceil((c.r + 0.5) / cell);
        for (let dj = -rr; dj <= rr; dj++) for (let di = -rr; di <= rr; di++) {
          const i = ci + di, j = cj + dj;
          if (i < 0 || j < 0 || i >= W || j >= Hh) continue;
          const x = toW(i + i0) - c.x, z = toW(j + j0) - c.z;
          // Only props that stand well above the ground there: the low ones are jumped.
          if (x * x + z * z <= (c.r + 0.5) * (c.r + 0.5) && c.h > hgt[j * W + i] + 2.2) solid[j * W + i] = 1;
        }
      }
      const start = (sj - j0) * W + (si - i0), goal = (tj - j0) * W + (ti - i0);
      solid[start] = 0; solid[goal] = 0;
      const g = new Float32Array(size).fill(Infinity), from = new Int32Array(size).fill(-1), closed = new Uint8Array(size);
      // Binary heap of [f, id].
      const heapF: number[] = [], heapI: number[] = [];
      const push = (f: number, id: number) => { let n = heapF.length; heapF.push(f); heapI.push(id); while (n > 0) { const m = (n - 1) >> 1; if (heapF[m] <= f) break; heapF[n] = heapF[m]; heapI[n] = heapI[m]; n = m; } heapF[n] = f; heapI[n] = id; };
      const pop = () => { const top = heapI[0], f = heapF.pop()!, id = heapI.pop()!; const L = heapF.length; if (L) { let n = 0; for (;;) { let c = 2 * n + 1; if (c >= L) break; if (c + 1 < L && heapF[c + 1] < heapF[c]) c++; if (heapF[c] >= f) break; heapF[n] = heapF[c]; heapI[n] = heapI[c]; n = c; } heapF[n] = f; heapI[n] = id; } return top; };
      const gi = goal % W, gj = (goal / W) | 0;
      const hEst = (id: number) => { const dx = Math.abs((id % W) - gi), dz = Math.abs(((id / W) | 0) - gj); return (Math.max(dx, dz) + 0.414 * Math.min(dx, dz)) * cell; };
      g[start] = 0; push(hEst(start), start);
      let found = false, best = start, bestH = hEst(start), expanded = 0;
      while (heapF.length && expanded < 30000) {
        const cur = pop();
        if (closed[cur]) continue;
        closed[cur] = 1; expanded++;
        const he = hEst(cur);
        if (he < bestH) { bestH = he; best = cur; }
        if (cur === goal) { found = true; break; }
        const ci = cur % W, cj = (cur / W) | 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const i = ci + di, j = cj + dj;
          if (i < 0 || j < 0 || i >= W || j >= Hh) continue;
          const nb = j * W + i;
          if (closed[nb] || solid[nb]) continue;
          const dist = (di && dj ? 1.414 : 1) * cell, up = hgt[nb] - hgt[cur];
          let cost = dist;
          if (up > dist * 1.8) continue;                 // a wall
          else if (up > dist * 1.0) cost += 4 + up;      // a climb of jumps: possible, slow
          else if (up < -6) cost += 2;                   // a long drop: fine, but not the first choice
          const ng = g[cur] + cost;
          if (ng < g[nb]) { g[nb] = ng; from[nb] = cur; push(ng + hEst(nb), nb); }
        }
      }
      // Walk the route back from the goal (or from the closest point reached) and take the node ~8 m from us.
      const chain: number[] = [];
      for (let c = found ? goal : best; c >= 0 && chain.length < 4000; c = from[c]) chain.push(c);
      chain.reverse();
      let wp = chain[chain.length - 1], climb = false, walked = 0;
      for (let n = 1; n < chain.length; n++) {
        const A = chain[n - 1], B = chain[n];
        walked += Math.hypot((B % W) - (A % W), ((B / W) | 0) - ((A / W) | 0)) * cell;
        if (walked <= 9 && hgt[B] - hgt[A] > cell * 0.9) climb = true;
        if (walked >= 8) { wp = B; break; }
      }
      nav = {
        tx: r2(navX), tz: r2(navZ), ok: found, len: r2(g[found ? goal : best]), jump: climb,
        x: chain.length > 1 ? r2(toW((wp % W) + i0)) : r2(navX), z: chain.length > 1 ? r2(toW(((wp / W) | 0) + j0)) : r2(navZ),
      };
    } catch (e) { nav = null; }
  }

  const R = run.rifts;
  let riftInside = false, entrance: any = null;
  try { riftInside = !!(R && (R.inside || R.isInside?.())); } catch { /* optional */ }
  if (R && R.entrance && typeof R.entrance.x === 'number') entrance = { x: r2(R.entrance.x), z: r2(R.entrance.z) };

  const mut = run.mutation;
  const d = run.diff || {};
  return {
    v: 1,
    t: r2(run.time), state: String(run.state), mode: String(run.mode), biome: String(run.biome?.id || ''), tier: run.tier | 0,
    stage: run.stage | 0, stageTime: r2(run.stageTime),
    mutation: mut ? String(mut.def?.id ?? mut.def?.key ?? mut.key ?? mut.id ?? 'on') : null,
    diff: { enemyHp: r2(d.enemyHp ?? 1), enemyDamage: r2(d.enemyDamage ?? 1), enemySpeed: r2(d.enemySpeed ?? 1), enemyAmount: r2(d.enemyAmount ?? 1) },
    timeScale: r2(run.timeScale), fps: Math.round(run.playFps || run.fps || 60), camYaw: Math.round((run.camYaw || 0) * 1000) / 1000,
    gold: Math.floor(run.gold || 0), ballCost: r2(ballCost), pendingLevels: run.pendingLevels | 0,
    bossSpawned: !!run.bossSpawned, stageCleared: !!run.stageCleared, victory: !!run.victory,
    weather: String(run.weather || ''), kills: run.stats?.kills | 0,
    player,
    ult: { charge: r2(run.ult?.charge), active: !!(run.ult?.active > 0), ready: (run.ult?.charge ?? 0) >= 1 && !(run.ult?.active > 0) },
    enemies: { count, list },
    shots, hazards, waves, boss,
    pickups: { xpN: r2(xpN), xpX: r2(xpX), xpZ: r2(xpZ), heal, other },
    points, capture, friendBall,
    rift: { inside: riftInside, entrance },
    terrain: { ring, ring2, blocked, free, hop, bounds: r2(T?.play ?? 168) },
    nav,
  };
}
