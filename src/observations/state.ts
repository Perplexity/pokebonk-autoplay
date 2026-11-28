/**
 * Read-only state extraction: the parts of a run the raw snapshot (src/observations/extract.ts) does not carry.
 * The snapshot has the surroundings; this has the build, the economy, the progression clocks,
 * the guardian / seal / overtime state, a histogram of ALL live enemies and the run's cumulative counters.
 *
 * STRICTLY READ-ONLY. `extractState` reads fields of the game's live run object and calls only these members of it,
 * every one of which computes a value from fields without writing anything (their sources were read; the test
 * `test/observations/state.test.ts` checks that calling the extractor any number of times leaves an episode's digest
 * and its random-number count unchanged):
 *
 *   run.interactables.chestCost()      price of the next paid Poké Ball
 *   run.seals.kept (getter)            seals kept so far, capped as the game caps it
 *   run.swarmSecs (getter)             seconds since the final swarm began
 *   run.collapseHp()                   HP per second the zone collapse drains right now
 *   run.tideHealK()                    multiplier on healing from the collapse and the overtime tide
 *   run.nextBossSpecies()              species of the guardian / legendary of this zone
 *   run.overtime.offered / roundLeft / bonus / drainHp / healK (getters), run.overtime.mult(round)
 *   run.ult.ready (getter)
 *   run.meta.runGain('healed')         HP healed in this run (the game counts healing in a profile counter)
 *   run.forms.ready / locked (getters) Max form: a charge is held and can be spent
 *   run.rifts.incenseOn (getter), run.rifts.useBlock(fused)   whether the game would open a rift now (null = yes)
 *   run.interactables.cageCost()       price of opening a cage
 *
 * Two things the run object does not hold are handed in by the environment (`StateExtras`): the price of a
 * slot-machine spin (a module-level function of the game) and the count of map points used (the game marks a point
 * used but keeps no total).
 *
 * The result is plain data (numbers, strings, booleans, arrays, objects); it never holds a game object.
 */
/** 2: `forms`, `rift`, `dojo`, `mapUse`; economy has cage and slot prices; counters have the map-feature totals. */
export const STATE_SCHEMA = 2;

/** Dojo trials the game can offer (the keys of its trial table). */
export const DOJO_TRIALS = ['wave', 'rush', 'circle', 'chain', 'elites', 'statue', 'race', 'master', 'untouched'] as const;
/** Seconds outside the circle before the circle trial fails (the game's constant). */
const DOJO_CIRCLE_GRACE = 1.5;

/**
 * Map points that are steps of the run itself (guardian altar, sanctuary shrine, portal) or belong to other modes:
 * using them is not counted as map use.
 */
export const MAP_USE_EXCLUDED = ['boss', 'shrine', 'portal', 'tower', 'rush', 'exp'] as const;

/** What the environment hands to `extractState` besides the run. */
export interface StateExtras {
  /** kind → map points of that kind used so far in the episode (each point once, when the game marks it used). */
  pointsUsed: Readonly<Record<string, number>>;
  /** Price of the next slot-machine spin. */
  slotPrice: number;
  /** Items sold through the shop's sell list so far in the episode (the environment makes those sales itself). */
  shopSold: number;
}

/** Directions and distance bands of the all-enemies histogram. Direction k is the angle k·22.5° from +x towards +z, as in the snapshot's terrain rings. */
export const DENSITY_DIRECTIONS = 16;
export const DENSITY_BANDS = [10, 25] as const; // metres: [0, 10), [10, 25), [25, ∞)
export const DENSITY_SIZE = DENSITY_DIRECTIONS * (DENSITY_BANDS.length + 1);

export interface MoveState {
  slot: number;
  key: string;
  id: number;
  level: number;
  type: string;
  cls: string;
  arch: string;
  /** Seconds until the move fires again (the game's own timer; 0 when it is due). */
  cooldownLeft: number;
  /**
   * Seconds between two casts: the definition's cooldown × the move's cooldown modifier ÷ the player's attack speed.
   * DERIVED here with the formula read in the game's code; the game also applies a lower bound that is not reproduced.
   */
  cooldownTotal: number;
  /** The move is in the middle of a cast (a beam held, a burst being fired, a charge). */
  busy: boolean;
  /** Damage this move has dealt in the run. */
  damageDone: number;
  fusion: boolean;
  /** Key of the move linked to this one by a fusion-machine link, if any. */
  linked: string | null;
}

/** Cumulative counters of the run. All are the game's own figures; none is computed by the environment. */
export interface Counters {
  time: number;
  kills: number;
  damageDealt: number;
  damageTaken: number;
  /** HP healed (the game's own counter; overheal and blocked healing are not in it). */
  healed: number;
  /** Times the player was hit, and hits evaded. */
  hits: number;
  dodges: number;
  /** Zone guardians and legendaries defeated (the game's `stats.bosses` counts both; `legendaries` only the latter). */
  guardiansDefeated: number;
  legendariesDefeated: number;
  alphasDefeated: number;
  totemsDefeated: number;
  summonersDefeated: number;
  /** Zone the run is in (1–3 map zones, 4 = sanctuary): zones entered so far. */
  zonesEntered: number;
  zonesCleared: number;
  level: number;
  /** Items held now (sum of stacks) and the highest that sum has been. */
  itemsHeld: number;
  itemsPeak: number;
  movesLearned: number;
  evolutions: number;
  ultimatesUsed: number;
  goldEarned: number;
  goldSpent: number;
  ballsBought: number;
  captured: number;
  sealsKept: number;
  sealsBroken: number;
  /** Bonus KOs overtime would add if it were cashed now (0 outside overtime). */
  overtimeBonus: number;
  overtimeRounds: number;
  /**
   * Items bought in the shop (the game's list `shopBuys`), Pokédollars spent there (purchases and restocks) and items
   * sold (the game's `econ`), slot-machine spins, Hypno's lessons taken and things forgotten.
   */
  shopBought: number;
  shopSpent: number;
  /**
   * Owned items sold in the shop. COUNTED BY THE ENVIRONMENT (it makes those sales in place of the HUD's sell button);
   * `itemsSold` is the game's own count and also includes found items turned down for Pokédollars.
   */
  shopSold: number;
  itemsSold: number;
  slotSpins: number;
  lessons: number;
  forgets: number;
  /** Rifts cleared, Max forms used, moves linked at Bill's machine (the game's `stats`). */
  riftsCleared: number;
  formsUsed: number;
  movesLinked: number;
  /**
   * Map points used, each once (see StateExtras), not counting MAP_USE_EXCLUDED. COUNTED BY THE ENVIRONMENT from the
   * game's own `used` flag; the game keeps no such total.
   */
  pointsUsed: number;
  /**
   * Uses of the map: `pointsUsed` + shop purchases + slot-machine spins + Hypno's lessons + rifts cleared + Max forms
   * used. A sum of the counters above, kept as one figure.
   */
  mapUse: number;
}

export interface RunState {
  schema: typeof STATE_SCHEMA;
  build: {
    species: number;
    startSpecies: number;
    evoStage: number;
    passive: string;
    level: number;
    xp: number;
    xpNext: number;
    pendingLevels: number;
    moveSlots: number;
    moveSlotsFree: number;
    /** One entry per move slot, null where the slot is empty. */
    moves: (MoveState | null)[];
    vitaminSlots: number;
    vitaminSlotsFree: number;
    vitamins: { key: string; level: number }[];
    items: { key: string; count: number }[];
    relics: string[];
    refreshes: number;
    skips: number;
    banishes: number;
    /** Next evolution the game has scheduled: species and level. */
    nextEvolution: { to: number; level: number } | null;
    revives: number;
  };
  player: {
    /** Seconds until the dash is available again (0 = ready), and whether a dash is under way. */
    dashCooldown: number;
    dashing: boolean;
    grounded: boolean;
    jumpsLeft: number;
    diving: boolean;
    /** Vertical speed and height above the ground under the player. */
    vy: number;
    height: number;
  };
  ultimate: { charge: number; ready: boolean; /** seconds the running ultimate still lasts */ active: number; uses: number };
  economy: { gold: number; ballPrice: number; ballsBought: number; shopRerolls: number; /** price of opening a cage, and of the next slot-machine spin */ cagePrice: number; slotPrice: number };
  /** Max form: charges held (filled at a Power Altar, at most 3), whether one can be spent now, seconds the form still lasts. */
  forms: { charges: number; ready: boolean; active: number; locked: boolean };
  /** Rifts: Incense held (at most 3), whether the game would open a (fused) rift now, whether Hypno's lesson of the zone is unused. */
  rift: { incense: number; canOpen: boolean; canFuse: boolean };
  hypnoLessonReady: boolean;
  /** The dojo trial being played, null when none is. Positions are world coordinates. */
  dojo: {
    key: string;
    belt: number;
    timeLeft: number;
    /** What has been reached of `goal` (KOs, seconds held, marks touched: the trial's own unit). */
    progress: number;
    goal: number;
    /** Circle and statue: the area to stay in. Race: the next mark. null for the other trials. */
    area: { x: number; z: number; radius: number } | null;
    /** Seconds left before the trial fails for leaving the circle or breaking the chain (0 when the trial has no such clock). */
    graceLeft: number;
    /** Race with a hold: fraction of the hold completed at the current mark. */
    holdFrac: number;
    /** Live dojo fighters, and the nearest one. */
    fighters: number;
    nearestFighter: { x: number; z: number } | null;
  } | null;
  /** kind → map points of that kind used so far in the episode (every kind, MAP_USE_EXCLUDED included). */
  pointsUsed: Record<string, number>;
  zone: {
    zone: number;
    zoneTime: number;
    time: number;
    weather: string;
    finalSwarm: boolean;
    /** Seconds since the final swarm began (0 before). */
    finalSwarmSeconds: number;
    /** HP per second the zone collapse drains now (0 before the collapse). */
    collapseDrain: number;
    /** Multiplier on healing from the collapse and the overtime tide (1 = unaffected). */
    healMultiplier: number;
    /** The map has a sanctuary and the run is in it. */
    inSanctuary: boolean;
  };
  guardian: {
    /** Species of this zone's guardian (the legendary in the sanctuary); 0 when the zone has none. */
    species: number;
    /** Waiting at its altar: not woken yet in this zone. */
    asleep: boolean;
    alive: boolean;
    hp: number;
    maxHp: number;
    enraged: boolean;
    fightTime: number;
    /** Seals put on this fight, whether its clock seal ran out (prizes lost), and the clock seal's seconds left (0 = no clock). */
    seals: string[];
    sealsBroken: boolean;
    clockLeft: number;
  };
  stageCleared: boolean;
  regionCleared: boolean;
  overtime: {
    /** The game would open the overtime dialog at the shrine / portal now. */
    offered: boolean;
    live: boolean;
    over: boolean;
    cashed: boolean;
    lost: boolean;
    direct: boolean;
    /** 1-based. */
    round: number;
    roundTimeLeft: number;
    seconds: number;
    /** Multiplier of the current round, seals and offerings included. */
    multiplier: number;
    bonus: number;
    /** HP per second the tide drains. */
    drain: number;
    ringClosing: boolean;
    /** Radius of the closing ring and of the arena (0 outside a sanctuary). */
    ringRadius: number;
    arenaRadius: number;
    offerings: string[];
  };
  sealsKept: number;
  enemies: {
    /** Live enemies (map objects and other players' proxies excluded), and how many of them are elites / alphas / ranged. */
    live: number;
    elites: number;
    alphas: number;
    ranged: number;
    /** The game's cap on live bodies now, and the cap it never exceeds. */
    cap: number;
    capMax: number;
    /** Counts per direction × band, index = direction * 3 + band (see DENSITY_*). */
    density: number[];
  };
  counters: Counters;
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const call = (f: () => unknown): number => { try { return n(f()); } catch { return 0; } };

function dojoState(run: any): RunState['dojo'] {
  const d = run.dojo;
  if (!d || d.done) return null;
  const p = run.player.pos, o = d.p ?? {}, E = run.enemies;
  let fighters = 0, best: { x: number; z: number } | null = null, bestD = Infinity;
  for (const pair of Array.isArray(d.wave) ? d.wave : []) {
    const i = pair?.[0], gen = pair?.[1];
    if (!(i >= 0) || !E?.alive?.[i] || E.gen?.[i] !== gen || E.dying?.[i] > 0) continue;
    fighters++;
    const dist = Math.hypot(E.x[i] - p.x, E.z[i] - p.z);
    if (dist < bestD) { bestD = dist; best = { x: n(E.x[i]), z: n(E.z[i]) }; }
  }
  let area: { x: number; z: number; radius: number } | null = null, graceLeft = 0, holdFrac = 0;
  if (d.key === 'circle' && d.it) { area = { x: n(d.it.x), z: n(d.it.z), radius: n(o.radius) }; graceLeft = Math.max(0, DOJO_CIRCLE_GRACE - n(d.outT)); }
  else if (d.key === 'statue') area = { x: n(d.ax), z: n(d.az), radius: n(o.radius) };
  else if (d.key === 'race') {
    const mark = Array.isArray(d.marks) ? d.marks[d.n | 0] : null;
    if (mark) area = { x: n(mark.x), z: n(mark.z), radius: 0 };
    holdFrac = n(o.hold) > 0 ? Math.max(0, Math.min(1, n(d.holdT) / n(o.hold))) : 0;
  } else if (d.key === 'chain') graceLeft = Math.max(0, n(o.gap) - Math.max(0, n(d.gap)));
  return {
    key: String(d.key), belt: d.belt | 0, timeLeft: Math.max(0, n(d.limit) - n(d.t)), progress: n(d.n), goal: n(d.goal),
    area, graceLeft, holdFrac, fighters, nearestFighter: best,
  };
}

/** Copy the state out of the game's live run object. Reads only (see the list at the top). */
export function extractState(run: any, extras: StateExtras = { pointsUsed: {}, slotPrice: 0, shopSold: 0 }): RunState {
  const p = run.player, st = run.stats ?? {}, E = run.enemies, ot = run.overtime, seals = run.seals, B = run.boss, U = run.ult;
  const attackSpeed = n(p.stats?.attackSpeed) || 1;

  // ---- build ----
  const moveSlots = p.moveSlots | 0;
  const moves: (MoveState | null)[] = [];
  for (let slot = 0; slot < moveSlots; slot++) {
    const m = p.moves?.[slot];
    if (!m || !m.def) { moves.push(null); continue; }
    const d = m.def;
    moves.push({
      slot, key: String(d.key), id: d.id | 0, level: m.level | 0, type: String(d.type ?? ''), cls: String(d.cls ?? ''), arch: String(d.arch ?? ''),
      cooldownLeft: Math.max(0, n(m.timer)), cooldownTotal: (n(d.cd) * (n(m.mods?.cd) || 1)) / attackSpeed,
      busy: n(m.active) > 0 || !!m.charging || (Array.isArray(m.burst) && m.burst.length > 0),
      damageDone: n(m.damageDone), fusion: !!d.fusion, linked: m.link?.def ? String(m.link.def.key) : null,
    });
  }
  const vitamins: { key: string; level: number }[] = [];
  if (p.vitamins?.forEach) p.vitamins.forEach((v: any, k: string) => { vitamins.push({ key: String(k), level: (v && v.level) | 0 }); });
  const items: { key: string; count: number }[] = [];
  let itemsHeld = 0;
  if (p.items?.forEach) p.items.forEach((c: number, k: string) => { items.push({ key: String(k), count: c | 0 }); itemsHeld += c | 0; });
  const vitaminSlots = p.vitaminSlots | 0;
  const nextEvo = run.nextEvo && typeof run.nextEvo.to === 'number' ? { to: run.nextEvo.to | 0, level: run.nextEvo.level | 0 } : null;

  // ---- enemies: totals and the direction × distance histogram over ALL live ones ----
  const density = new Array<number>(DENSITY_SIZE).fill(0);
  let live = 0, elites = 0, alphas = 0, ranged = 0;
  if (E && E.alive) {
    const px: number = p.pos.x, pz: number = p.pos.z;
    const SKIP = 32768 | 65536; // map objects and other players' proxies, as in the snapshot
    const step = Math.PI / (DENSITY_DIRECTIONS / 2);
    for (let i = 0; i < E.n; i++) {
      if (!E.alive[i] || E.dying[i] > 0) continue;
      const f = E.flags[i];
      if (f & SKIP) continue;
      live++;
      if (f & 1) elites++;
      if (f & 2) alphas++;
      if (f & 8) ranged++;
      const dx = E.x[i] - px, dz = E.z[i] - pz, d = Math.sqrt(dx * dx + dz * dz);
      const dir = ((Math.round(Math.atan2(dz, dx) / step) % DENSITY_DIRECTIONS) + DENSITY_DIRECTIONS) % DENSITY_DIRECTIONS;
      const band = d < DENSITY_BANDS[0] ? 0 : d < DENSITY_BANDS[1] ? 1 : 2;
      density[dir * (DENSITY_BANDS.length + 1) + band]++;
    }
  }

  // ---- guardian ----
  const bi = typeof B?.bossIndex === 'number' ? B.bossIndex : -1;
  const bossAlive = bi >= 0 && !!E?.alive?.[bi] && !(E.dying[bi] > 0);
  const hasGuardian = (run.stage | 0) <= 3 || !!run.sanctuary;

  // ---- overtime ----
  const round = ot ? ot.round | 0 : 0;
  const sanct = run.sanctuary;
  let terrainH = n(p.pos?.y);
  try { terrainH = n(run.terrain.height(p.pos.x, p.pos.z)); } catch { /* keep the player's own height */ }

  const sealsKept = call(() => seals.kept);
  const pointsUsed: Record<string, number> = { ...extras.pointsUsed };
  let pointsCounted = 0;
  for (const [kind, count] of Object.entries(pointsUsed)) if (!(MAP_USE_EXCLUDED as readonly string[]).includes(kind)) pointsCounted += count;
  const econ = run.econ ?? {};
  const shopBought = Array.isArray(run.shopBuys) ? run.shopBuys.length : 0, slotSpins = run.slotSpins | 0, lessons = st.lessons | 0, riftsCleared = st.rifts | 0, formsUsed = st.forms | 0;
  const R = run.rifts, F = run.forms;
  const riftOpen = (fused: boolean): boolean => { try { return run.state === 'play' && !!R?.incenseOn && (!fused || !!R.fuseOn) && R.useBlock(fused) === null; } catch { return false; } };
  const counters: Counters = {
    time: n(run.time), kills: st.kills | 0, damageDealt: n(st.damage), damageTaken: n(st.damageTaken), healed: call(() => run.meta.runGain('healed')),
    hits: st.hits | 0, dodges: st.dodges | 0,
    guardiansDefeated: st.bosses | 0, legendariesDefeated: st.legendaries | 0, alphasDefeated: st.alphas | 0, totemsDefeated: st.totems | 0, summonersDefeated: st.summoners | 0,
    zonesEntered: run.stage | 0, zonesCleared: st.stagesCleared | 0, level: p.level | 0,
    itemsHeld, itemsPeak: run.peakItems | 0, movesLearned: st.movesLearned | 0, evolutions: st.evolutions | 0, ultimatesUsed: st.ultimates | 0,
    goldEarned: n(st.gold), goldSpent: n(run.goldSpent), ballsBought: run.chestsBought | 0, captured: Array.isArray(st.captured) ? st.captured.length : 0,
    sealsKept, sealsBroken: run.sealTally?.broken | 0,
    overtimeBonus: ot && (ot.live || ot.over) ? call(() => ot.bonus) : 0, overtimeRounds: ot && (ot.live || ot.over) ? round + 1 : 0,
    shopBought, shopSpent: n(econ.shop), shopSold: extras.shopSold | 0, itemsSold: econ.sold | 0, slotSpins, lessons, forgets: st.forgets | 0,
    riftsCleared, formsUsed, movesLinked: st.links | 0,
    pointsUsed: pointsCounted, mapUse: pointsCounted + shopBought + slotSpins + lessons + riftsCleared + formsUsed,
  };

  return {
    schema: STATE_SCHEMA,
    build: {
      species: p.speciesId | 0, startSpecies: run.startSpecies | 0, evoStage: p.evoStage | 0, passive: String(p.ability ?? ''),
      level: p.level | 0, xp: n(p.xp), xpNext: n(p.xpNext), pendingLevels: run.pendingLevels | 0,
      moveSlots, moveSlotsFree: moves.filter((m) => !m).length, moves,
      vitaminSlots, vitaminSlotsFree: Math.max(0, vitaminSlots - vitamins.length), vitamins, items,
      relics: Array.isArray(run.relicKeys) ? run.relicKeys.map(String) : [],
      refreshes: run.rerolls | 0, skips: run.skips | 0, banishes: run.banishes | 0, nextEvolution: nextEvo, revives: p.revives | 0,
    },
    player: {
      dashCooldown: Math.max(0, n(p.slideCd)), dashing: n(p.slideT) > 0, grounded: !!p.grounded, jumpsLeft: p.jumpsLeft | 0, diving: !!p.diving,
      vy: n(p.vel?.y), height: Math.max(0, n(p.pos?.y) - terrainH),
    },
    ultimate: { charge: Math.max(0, Math.min(1, n(U?.charge))), ready: !!U && !!U.ready && !(n(U.active) > 0), active: Math.max(0, n(U?.active)), uses: U?.uses | 0 },
    economy: {
      gold: Math.floor(n(run.gold)), ballPrice: call(() => run.interactables.chestCost()), ballsBought: run.chestsBought | 0, shopRerolls: run.shopRerolls | 0,
      cagePrice: call(() => run.interactables.cageCost()), slotPrice: n(extras.slotPrice),
    },
    forms: { charges: F?.charges | 0, ready: (() => { try { return !!F?.ready; } catch { return false; } })(), active: Math.max(0, n(F?.active)), locked: (() => { try { return !!F?.locked; } catch { return false; } })() },
    rift: { incense: run.incense | 0, canOpen: riftOpen(false), canFuse: riftOpen(true) },
    hypnoLessonReady: typeof run.lessonAt === 'string' && run.lessonAt !== `s${run.stage | 0}`,
    dojo: dojoState(run),
    pointsUsed,
    zone: {
      zone: run.stage | 0, zoneTime: n(run.stageTime), time: n(run.time), weather: String(run.weather ?? ''),
      finalSwarm: !!run.director?.finalSwarm, finalSwarmSeconds: call(() => run.swarmSecs), collapseDrain: call(() => run.collapseHp()),
      healMultiplier: (() => { try { const k = run.tideHealK(); return typeof k === 'number' && Number.isFinite(k) ? k : 1; } catch { return 1; } })(),
      inSanctuary: !!sanct,
    },
    guardian: {
      species: hasGuardian ? call(() => run.nextBossSpecies()) | 0 : 0,
      asleep: hasGuardian && !run.bossSpawned && !run.stageCleared, alive: bossAlive,
      hp: bossAlive ? n(E.hp[bi]) : 0, maxHp: bossAlive ? n(E.maxHp[bi]) : 0, enraged: bossAlive && !!B.enraged, fightTime: bossAlive ? n(B.fightT) : 0,
      seals: Array.isArray(seals?.active) ? seals.active.map(String) : [], sealsBroken: !!seals?.broken, clockLeft: Math.max(0, n(seals?.clockLeft)),
    },
    stageCleared: !!run.stageCleared, regionCleared: !!run.regionCleared,
    overtime: {
      offered: (() => { try { return !!ot.offered; } catch { return false; } })(),
      live: !!ot?.live, over: !!ot?.over, cashed: !!ot?.cashed, lost: !!ot?.lost, direct: !!ot?.direct,
      round: ot?.live || ot?.over ? round + 1 : 0, roundTimeLeft: ot?.live ? call(() => ot.roundLeft) : 0, seconds: n(ot?.secs),
      multiplier: ot?.live ? call(() => ot.mult(round)) : 0, bonus: counters.overtimeBonus, drain: ot?.live ? call(() => ot.drainHp) : 0,
      ringClosing: !!ot?.ringOn, ringRadius: sanct ? n(sanct.ringR) : 0, arenaRadius: sanct ? n(sanct.layout?.radius) : 0,
      offerings: Array.isArray(ot?.picks) ? ot.picks.map((x: unknown[]) => String(x[0])) : [],
    },
    sealsKept,
    enemies: { live, elites, alphas, ranged, cap: Math.min(n(run.maxEnemies), n(run.liveCap)) | 0, capMax: n(run.liveMax) | 0, density },
    counters,
  };
}
