# The snapshot

`observation.snapshot` is the run's surroundings as plain JSON: player, enemies, hazards, the guardian, pickups, map
points. Types: `src/observations/snapshot.ts`. Reader: `src/observations/extract.ts`, one self-contained function that
only reads the game's live run object.

The movement code (`src/player/brain/`) is a pure function of a snapshot, so a snapshot saved to disk replays exactly:
`test/fixtures/*.json` are recorded ones, and `node scripts/explain.ts test/fixtures/<name>.json` prints how every
heading scored for one.

## Conventions

- World axes: **x and z are the ground, y is up**. Distances in metres, times in seconds of the run clock.
- Directions as an index `k` (0–15) mean the angle `k · 22.5°`, measured from +x towards +z.
- The camera looks along `(-sin camYaw, -cos camYaw)`; "up" on the keyboard moves that way.
- Numbers are rounded to two decimals.

## `Snapshot`

| Field | Meaning |
|---|---|
| `v` | Format version: `1`. |
| `t` | Run clock. |
| `state` | The game's run state: `play`, `paused`, `modal` (a dialog is open), `transition`, `dead`, `over`. The policy only acts in `play`. |
| `mode`, `biome`, `tier` | `standard` / `endless` / `mutation` / ..., map id, difficulty tier (0–2). |
| `stage`, `stageTime` | Zone number (1-based) and seconds spent in it. |
| `mutation` | Key of the daily arena-wide modifier, or `null`. |
| `diff` | `{ enemyHp, enemyDamage, enemySpeed, enemyAmount }`: multipliers the run applies to enemies (tier and mutation). The policy adapts to these numbers, not to mutation names. |
| `timeScale`, `camYaw`, `weather` | Game speed factor, camera yaw in radians, current weather. |
| `gold`, `ballCost` | Pokédollars held (earned from KOs), and the price of the next paid Poké Ball. The game prices paid balls with one counter that rises with every ball bought; Great Balls and cursed balls are free. |
| `pendingLevels`, `kills` | Level-ups waiting for a choice, KOs so far. |
| `bossSpawned`, `stageCleared`, `victory` | Zone guardian woken; guardian down (portal open); run won. |

### `player`

| Field | Meaning |
|---|---|
| `x`, `y`, `z`, `vx`, `vz` | Position and ground velocity. |
| `hp`, `maxHp`, `shield` | Hit points. |
| `level`, `xp`, `xpNext` | Level and progress to the next. |
| `dead`, `iframes`, `grounded` | Fainted; seconds of invulnerability left (≤ 0: none); on the ground. |
| `speed`, `radius`, `pickupRange` | Current ground speed, body radius, pickup radius. |
| `sliding`, `dashReady`, `jumpsLeft` | In the middle of a dash; dash off cooldown; extra jumps left. |
| `species`, `ability` | Current Pokédex id (changes on evolution) and passive. |
| `moves[]` | `{ key, name, level, type, arch, cls, cd, area }`. `arch` is the move's shape (`cone`, `shot`, `nova`, `aura`, `strike`...): the policy derives its fighting distance from it. |
| `moveSlots`, `vitaminSlots` | How many moves / vitamins the run can hold. |
| `items`, `vitamins` | Key → count / level. |
| `stats` | The game's computed stat block (damage, area, armor, regen, moveSpeed, critChance...). |

### `ult`
`{ charge, active, ready }` — `charge` runs 0 → 1; `ready` means charged and not already running.

### `enemies`
`{ count, list }` — `count` is every living enemy in the arena; `list` holds the nearest (at most 160, within 45 m),
closest first, each as a 13-number tuple:

| Index | Constant | Meaning |
|---|---|---|
| 0 | `E_I` | Index in the game's enemy pool (stable while it lives). |
| 1, 2 | `E_X`, `E_Z` | Position. |
| 3, 4 | `E_VX`, `E_VZ` | Velocity. |
| 5, 6 | `E_HP`, `E_MAXHP` | Hit points. |
| 7 | `E_R` | Body radius. |
| 8 | `E_DMG` | Contact damage. |
| 9 | `E_SPEED` | Move speed. |
| 10 | `E_FLAGS` | Bit set, see `EF`: `Elite 1`, `Alpha 2`, `Boss 4`, `Ranged 8`, `Flying 16`, `Healer 32`, `Shielder 64`, `Capture 128` (weakened, can be caught), `Charger 256`, `Swarm 512`, `Stampede 1024`, `Shiny 2048`, `Totem 4096`, `Summoner 8192`, `Treasure 16384`. |
| 11 | `E_SPECIES` | Pokédex id. |
| 12 | `E_ATK` | Seconds until its next attack. A Charger launches its dash when this reaches 0. |

Map objects and other players' proxies are left out.

### Threats

| Field | Meaning |
|---|---|
| `shots[]` | Hostile projectiles within 30 m: `[x, z, vx, vz, radius, dmg]`. |
| `hazards[]` | Circles on the ground that hurt or are about to: `{ x, z, r, t, kind }`. `kind: "telegraph"` is a strike on its way (the warning circle the game draws before an attack lands: a boss's bolt, a totem's slam), with `t` = seconds until impact; these are read from the game's effects pool, the only place they exist. `boss.pools` and the like are areas that hurt for as long as they are there, with `t` = seconds left. Collected generically, so a new boss's circles show up without a code change. |
| `waves[]` | Expanding shock rings from a boss: `{ x, z, r, max, speed }`. Jump as `r` reaches you, or stand beyond `max`. |
| `boss` | `null`, or `{ i, name, species, x, z, hp, maxHp, radius, enraged, chargeT, cdx, cdz, move, moveT, fightT, phase }`. `chargeT > 0` with `(cdx, cdz)` is a charge along that lane. `phase` carries the boss's own phase or epoch label when it has one. **Not reliable on its own:** the game keeps its boss object after the guardian fell and reuses the enemy slot, so in later zones (before the next wake) and in overtime this field can describe an ordinary enemy under the old guardian's name (seen headless: `Golduck` with species 14 in zone 2). A guardian is up exactly while `bossSpawned && !stageCleared` (`liveBoss` in `src/player/brain/movement.ts`; `observation.state.guardian.alive` in the environment). |

### World

| Field | Meaning |
|---|---|
| `pickups` | `{ xpN, xpX, xpZ, heal, other }`: weight and centre of the experience lying within 20 m; `other` lists non-XP pickups within 40 m as `[kind, x, z]`. |
| `points[]` | Things on the map: `{ kind, sub, x, z, r, used, cost, d }` (`d` = distance). Every `boss` altar (where the zone guardian is woken) and `portal`, plus the two nearest unused of each other kind (`chest`, `freechest`, `altar`, `berry`, `challenge`, `slots`...). |
| `capture` | `null`, or the open capture window: `{ state, index, species, mode, shiny, x, z, weakT, canThrow }`. |
| `friendBall` | A fallen Alpha is in reach and can be recruited (interact). |
| `rift` | `{ inside, entrance }`: inside a rift's bonus area; where an open rift is. |
| `terrain` | Walkability around the player in 16 directions, measured with the game's own height map and prop colliders. `free[k]`: metres that can be walked before a step up, a prop, water or the map edge stops a walker (0–9). `hop[k]`: metres that can be covered when jumping all the way (steps a jump clears, props low enough to clear). `hop < 1.5` is a wall; `free` small with `hop` large is a climb. Also `ring[k]` / `ring2[k]` (height change 2.5 m and 5 m away), `blocked[k]`, and `bounds`: half the side of the playable **square** (the map ends at \|x\| or \|z\| = bounds). |
| `nav` | A route to a far goal, when one was requested with the snapshot: `{ tx, tz, ok, len, jump, x, z }`. A* over the height map on a ~2.2 m grid: steps are walkable, climbable by jumping (costlier), or blocked (walls, tall props, deep water, the edge); dropping down is free. `(x, z)` is the waypoint about 8 m along the route, `jump` says the next stretch climbs, `ok: false` means the goal is unreachable and the waypoint leads to the closest point. Planned in the page in a few milliseconds, twice a second while the goal is more than 14 m away. The environment plans one with `planRoute(x, z)`. |

## Example

```json
{ "v": 1, "t": 126.4, "state": "play", "mode": "standard", "biome": "forest", "tier": 0, "stage": 1, "stageTime": 126.4,
  "mutation": null, "diff": { "enemyHp": 1, "enemyDamage": 1, "enemySpeed": 1, "enemyAmount": 1 },
  "camYaw": 0, "gold": 46, "pendingLevels": 0, "bossSpawned": false, "stageCleared": false, "kills": 104,
  "player": { "x": 21.4, "y": 6.1, "z": -33.9, "hp": 89, "maxHp": 109, "level": 7, "dashReady": true,
              "moves": [{ "key": "burning-jealousy", "name": "Burning Jealousy", "level": 3, "arch": "cone", "area": 7 }] },
  "ult": { "charge": 0.65, "active": false, "ready": false },
  "enemies": { "count": 17, "list": [[12, 24.1, -31.0, -2.1, -1.9, 81.5, 81.5, 0.59, 12.4, 3.9, 8, 81]] },
  "shots": [], "hazards": [], "waves": [], "boss": null,
  "points": [{ "kind": "boss", "sub": "", "x": 66.3, "z": 132.1, "r": 4, "used": false, "cost": 0, "d": 171.9 }],
  "terrain": { "ring": [0.1, 0.0, "…16"], "ring2": ["…16"], "blocked": ["…16"], "bounds": 168 } }
```
