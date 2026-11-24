import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Enemy, Snapshot, UiModal, UiState } from '../src/bot/snapshot.ts';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** A snapshot recorded from real sandbox play (scripts/snap.ts --save <name>). */
export function recorded(name: string): { snap: Snapshot; ui: UiState } {
  return JSON.parse(readFileSync(join(DIR, name + '.json'), 'utf8'));
}

export function modals(): Record<string, UiModal> {
  return JSON.parse(readFileSync(join(DIR, 'modals.json'), 'utf8'));
}

/** A copy of a recorded snapshot with some fields replaced: recorded numbers, scripted situation. */
export function vary(base: Snapshot, patch: (s: Snapshot) => void): Snapshot {
  const s = structuredClone(base);
  patch(s);
  return s;
}

/** An enemy tuple at (x, z) relative to nothing: plain 70 HP walker unless overridden. */
export function enemy(i: number, x: number, z: number, over: Partial<{ vx: number; vz: number; hp: number; maxHp: number; r: number; dmg: number; speed: number; flags: number; atk: number }> = {}): Enemy {
  return [i, x, z, over.vx ?? 0, over.vz ?? 0, over.hp ?? 70, over.maxHp ?? 70, over.r ?? 0.6, over.dmg ?? 11, over.speed ?? 3.8, over.flags ?? 0, 19, over.atk ?? 3];
}

/** Put the player at the origin of an empty, flat, quiet arena. */
export function quiet(base: Snapshot): Snapshot {
  return vary(base, (s) => {
    s.state = 'play';
    s.player.x = 0; s.player.z = 0; s.player.vx = 0; s.player.vz = 0;
    s.player.hp = s.player.maxHp; s.player.dead = false; s.player.iframes = 0; s.player.grounded = true; s.player.dashReady = true; s.player.sliding = false;
    s.enemies = { count: 0, list: [] };
    s.shots = []; s.hazards = []; s.waves = []; s.boss = null; s.capture = null; s.friendBall = false; s.points = [];
    s.pickups = { xpN: 0, xpX: 0, xpZ: 0, heal: [], other: [] };
    s.terrain = { ring: new Array(16).fill(0), ring2: new Array(16).fill(0), blocked: new Array(16).fill(0), bounds: 168 };
    s.ult = { charge: 0.7, active: false, ready: false };
    s.bossSpawned = false; s.stageCleared = false; s.stage = 1; s.stageTime = 30; s.gold = 0; s.ballCost = 18;
    s.diff = { enemyHp: 1, enemyDamage: 1, enemySpeed: 1, enemyAmount: 1 };
  });
}
