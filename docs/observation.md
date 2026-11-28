# What the player sees

An observation (`src/environment/types.ts`) has two parts read from the live run, neither of them changing the game:

| Part | Code | What it is |
|---|---|---|
| snapshot | `src/observations/extract.ts` → `observation.snapshot` | the surroundings at this moment: the player, every enemy near, shots, hazards, pickups, map points, the guardian. docs/snapshot.md |
| state | `src/observations/state.ts` → `observation.state`, `info.counters` | the run: build, economy, clocks, guardian / seals / Overtime, a histogram of all live enemies, cumulative counters |

In the choice phase it also carries the open dialog as a `decision` with its options and a `mask` of what may be
answered (docs/environment.md §4).

## The state (`observation.state`, schema 2)

The raw snapshot (docs/snapshot.md) is the surroundings: enemies, shots, hazards, map points. It carries no build. `extractState(run)`
adds the rest; the snapshot's own extractor is `src/observations/extract.ts`.

| Group | Fields |
|---|---|
| `build` | species, start species, evolution stage, passive, level, XP and XP to the next level, pending levels; per move slot `{key, id, level, type, cls, arch, cooldownLeft, cooldownTotal, busy, damageDone, fusion, linked}` or null; move and vitamin slots and how many are free; vitamins `{key, level}`; items `{key, count}`; relics; refreshes / skips / banishes left; next evolution; revives |
| `player` | dash cooldown and whether a dash is under way, grounded, jumps left, diving, vertical speed, height above the ground |
| `ultimate` | charge 0–1, ready, seconds the running one still lasts, uses |
| `economy` | Pokédollars, price of the next paid Poké Ball, balls bought, shop restocks, price of opening a cage, price of the next slot-machine spin |
| `forms` | Max form: charges held (0–3, gained by standing in a Power Altar), whether one can be spent now, seconds the running form still lasts, locked |
| `rift` | Incense held (0–3), whether the game would open a rift / a fused rift now |
| `hypnoLessonReady` | Hypno's lesson of this zone has not been taken |
| `dojo` | the trial being played, or null: key, belt, time left, progress and goal (the trial's own unit), the area to stay in or the next mark (circle, statue, race), seconds of grace left (circle: outside; chain: since the last KO), hold fraction (race), live dojo fighters and the nearest one |
| `pointsUsed` | kind → map points of that kind used so far in the episode |
| `zone` | zone, zone time, run time, weather, final swarm and seconds since it began, HP per second the collapse drains, healing multiplier, in the sanctuary |
| `guardian` | species, asleep, alive, HP, max HP, enraged, fight time, seals put on the fight, seals broken, clock seal seconds left |
| flags | `stageCleared`, `regionCleared`, `sealsKept` |
| `overtime` | offered, live, over, cashed, lost, direct, round, time left in the round, seconds, multiplier, bonus, tide drain per second, ring closing, ring and arena radius, offerings taken |
| `enemies` | live count, elites, alphas, ranged, the cap now and the cap it never exceeds, `density[48]` (16 directions × 3 distance bands over **all** live enemies) |
| `counters` | time, kills, damage dealt, damage taken, healed, hits, dodges, guardians / legendaries / alphas / totems / summoners defeated, zones entered and cleared, level, items held and peak, moves learned, evolutions, ultimates used, Pokédollars earned and spent, balls bought, captures, seals kept and broken, overtime bonus and rounds, shop purchases, Pokédollars spent in the shop, owned items sold in the shop (`shopSold`), all items sold, slot-machine spins, Hypno lessons and things forgotten, rifts cleared, Max forms used, moves linked, map points used, and `mapUse` (map points used + shop purchases + spins + lessons + rifts cleared + Max forms: the figure reward v2 pays for) |

`info.counters` is the same object as `observation.state.counters`. Every counter is the game's own figure
(`run.stats`, `run.econ`, the profile's `healed` counter, the seal tally) with two exceptions. `shopSold` (owned items
sold in the shop) is counted by the environment, which makes those sales itself; the game's own `itemsSold` also
includes found items turned down for Pokédollars. And **`pointsUsed` is counted
by the environment**. The game marks a map point `used` but keeps no total and rebuilds its list for every zone, so
the environment reads the flags after each simulation step and counts a point once, when a point it has seen unused
turns used. The guardian altar, the sanctuary shrine and portals are counted in `state.pointsUsed` but not in
`counters.pointsUsed` or `mapUse` (they are steps of the run, paid as milestones). `mapUse` is a sum of counters.

One value is **derived**: `cooldownTotal` = definition cooldown × the move's cooldown modifier ÷ attack speed, the
formula read in the game's code, without the lower bound the game also applies. `cooldownLeft` is the game's own
timer.

**Read-only.** The extractor reads fields and calls only members that compute a value from fields (listed at the top
of `state.ts`, in `getMetadata().instrumentation`, and in docs/environment.md §6). The test
`test/observations/state.test.ts` plays the same seed twice, the second time calling the extractor five
extra times at every step, and compares a digest over every step that includes the number of
`Math.random` draws and the whole state: identical.
