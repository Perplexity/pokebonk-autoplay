/**
 * The state snapshot: everything the strategy layer knows about a moment of a run. Plain JSON, produced ~10 times a
 * second by `extractSnapshot` (src/observations/extract.ts). The brain is a pure function
 * of snapshots, so recorded snapshots (test/fixtures) replay exactly. Field-by-field notes: docs/snapshot.md.
 *
 * World axes: x and z span the ground, y is up. Distances are metres, times are seconds of the run clock.
 */

/** Bits of `Enemy.flags` (the game's own enemy flags). */
export const EF = {
  Elite: 1, Alpha: 2, Boss: 4, Ranged: 8, Flying: 16, Healer: 32, Shielder: 64, Capture: 128, Charger: 256,
  Swarm: 512, Stampede: 1024, Shiny: 2048, Totem: 4096, Summoner: 8192, Treasure: 16384, Object: 32768, Remote: 65536,
  Classic: 131072, Horde: 8388608,
} as const;

/** One enemy, as a tuple to keep snapshots small: see the `E_*` indexes. */
export type Enemy = [i: number, x: number, z: number, vx: number, vz: number, hp: number, maxHp: number, radius: number, dmg: number, speed: number, flags: number, species: number, atk?: number];
export const E_I = 0, E_X = 1, E_Z = 2, E_VX = 3, E_VZ = 4, E_HP = 5, E_MAXHP = 6, E_R = 7, E_DMG = 8, E_SPEED = 9, E_FLAGS = 10, E_SPECIES = 11;
/** Seconds until the enemy's next attack (a Charger launches its dash when this reaches 0). Absent in old recordings. */
export const E_ATK = 12;

/** A hostile projectile: position, velocity, radius, damage. */
export type Shot = [x: number, z: number, vx: number, vz: number, radius: number, dmg: number];

export interface Move { key: string; name: string; level: number; type: string; arch: string; cls: string; cd: number; area: number }

export interface Player {
  x: number; y: number; z: number;
  vx: number; vz: number;
  hp: number; maxHp: number; shield: number;
  level: number; xp: number; xpNext: number;
  dead: boolean;
  /** Seconds of invulnerability left. */
  iframes: number;
  grounded: boolean;
  /** Ground speed in m/s the player moves at when a direction is held. */
  speed: number;
  radius: number;
  pickupRange: number;
  /** In the middle of a dash. */
  sliding: boolean;
  /** The dash (slide) is off cooldown. */
  dashReady: boolean;
  jumpsLeft: number;
  species: number;
  ability: string;
  moves: Move[];
  moveSlots: number;
  vitaminSlots: number;
  items: Record<string, number>;
  vitamins: Record<string, number>;
  stats: Record<string, number>;
}

/** A circle on the ground that hurts (or is about to): boss pools, telegraphed strikes. `t` is seconds left when known. */
export interface Hazard { x: number; z: number; r: number; t: number; kind: string }
/** An expanding shock ring from a boss: jump over it or be outside `max`. */
export interface Wave { x: number; z: number; r: number; max: number; speed: number }

export interface Boss {
  i: number; name: string; species: number;
  x: number; z: number; hp: number; maxHp: number; radius: number;
  enraged: boolean;
  /** > 0 while the boss is winding up or running a charge along (cdx, cdz). */
  chargeT: number; cdx: number; cdz: number;
  move: string; moveT: number;
  /** Seconds the fight has lasted. */
  fightT: number;
  /** Phase or epoch label when the boss has one (e.g. a time boss shifting arena epochs). */
  phase: string;
}

/** Something on the map the player can walk to or use. */
export interface Point { kind: string; sub: string; x: number; z: number; r: number; used: boolean; cost: number; d: number }

export interface Capture { state: string; index: number; species: number; mode: string; shiny: boolean; x: number; z: number; weakT: number; canThrow: boolean }

export interface Terrain {
  /** Ground height change 2.5 m away in 16 directions (index k = angle k·22.5°, measured from +x towards +z). */
  ring: number[];
  /** The same 5 m away. */
  ring2: number[];
  /** 1 where that direction is water/lava or outside the playable area at 2.5 m. */
  blocked: number[];
  /** Metres that can be walked in each direction before a step up, a prop, water or the map edge stops a walker (0–9). Absent in old recordings. */
  free?: number[];
  /** Metres that can be covered in each direction when jumping all the way (0–9). */
  hop?: number[];
  /** Half the side of the playable square: the map ends at |x| or |z| = bounds. */
  bounds: number;
}

/** A route to a far goal, planned over the height map (A*): the next waypoint to walk to. */
export interface Nav {
  /** The goal this route was planned for. */
  tx: number; tz: number;
  /** A route to the goal exists (else the waypoint leads to the closest reachable point). */
  ok: boolean;
  /** Route length in metres (cost units). */
  len: number;
  /** The next stretch climbs: jump all the way. */
  jump: boolean;
  /** The waypoint, about 8 m along the route. */
  x: number; z: number;
}

export interface Snapshot {
  v: 1;
  /** Run clock. */
  t: number;
  /** play | paused | modal | transition | dead | over ... (the game's own run state). */
  state: string;
  mode: string;
  biome: string;
  tier: number;
  stage: number;
  stageTime: number;
  /** Key of the arena-wide modifier in the daily mutation mode, else null. */
  mutation: string | null;
  /** Multipliers the run applies to enemies (difficulty tier and mutation). */
  diff: { enemyHp: number; enemyDamage: number; enemySpeed: number; enemyAmount: number };
  timeScale: number;
  /** Frames per second the game measured. */
  fps: number;
  camYaw: number;
  gold: number;
  /** Price of the next paid Poké Ball (it rises with every one bought). Great Balls and cursed balls are free. */
  ballCost: number;
  pendingLevels: number;
  bossSpawned: boolean;
  stageCleared: boolean;
  victory: boolean;
  weather: string;
  kills: number;
  player: Player;
  ult: { charge: number; active: boolean; ready: boolean };
  enemies: {
    /** All living enemies in the arena. */
    count: number;
    /** The nearest ones, closest first (at most 160, within 45 m). */
    list: Enemy[];
  };
  shots: Shot[];
  hazards: Hazard[];
  waves: Wave[];
  boss: Boss | null;
  pickups: { xpN: number; xpX: number; xpZ: number; heal: [x: number, z: number][]; other: [kind: number, x: number, z: number][] };
  points: Point[];
  capture: Capture | null;
  /** A fallen Alpha is in reach and can be recruited with a Friend Ball (interact). */
  friendBall: boolean;
  rift: { inside: boolean; entrance: { x: number; z: number } | null };
  terrain: Terrain;
  /** Present when a route was requested with this snapshot (or carried over from a recent one by the session). */
  nav?: Nav | null;
}

// ---------------- the DOM side ----------------

export interface UiOption {
  text: string; cls: string; x: number; y: number; w: number; h: number; disabled: boolean; key?: string;
  /** Offer cards only: the name on the card, its rarity label, its tag (NEW / UPGRADE), the line under the name and the effect lines. */
  name?: string; rarity?: string; tag?: string; sub?: string; effects?: string[];
}

export interface UiModal {
  /** levelup | item | shop | blessing | branch | confirm | end | pause | unknown ... */
  kind: string;
  title: string;
  /** The things to choose between (cards). */
  options: UiOption[];
  /** The other buttons of the dialog (reroll, skip, close, confirm...). */
  actions: UiOption[];
  cls: string;
}

export interface UiState {
  /** loading | auth | starter | menu | playmenu | select | map | run | end | offline | blocked | unknown */
  screen: string;
  /** Dialogs on top of the screen, outermost last. */
  modal: UiModal | null;
  /** Every visible enabled button, for recovery and logging. */
  buttons: UiOption[];
  notices: string[];
  /** Short text of the current screen, for logs. */
  text: string;
  href: string;
}
