# Observation state, numeric encoding and action codec

Three layers, each built on the one before and none of them changing the game:

| Layer | Code | What it is |
|---|---|---|
| state | `src/observations/state.ts` → `observation.state`, `info.counters` | plain data read from the live run: build, economy, clocks, guardian / seals / overtime, a histogram of all live enemies, cumulative counters. Always present |
| encoding | `src/observations/encode.ts` → `observation.encoded` | a fixed-size `Float32Array` + `Int32Array` computed from the observation alone. Only with `createEnvironment({ encode: true })` |
| action codec | `src/actions/codec.ts` | one MultiDiscrete action for both phases, its mask, and the translation to and from environment actions |

The contracts for Python are two JSON files written by `node scripts/export-encoding.ts`:
`data/encoding/<build>/observation-layout.json` and `action-layout.json`. Each carries a version and a sha256 of its
own content; `getMetadata().encoding` reports both, and `observation.encoded.layoutHash` repeats the first on every
observation. For build `mwsewi0r`:

| | Version | Size | Hash |
|---|---|---|---|
| observation layout | `OBS_ENCODING_VERSION` = 2 | 7553 floats + 195 ints, 20 segments | `931bad6648618489…` |
| action layout | `ACTION_ENCODING_VERSION` = 2 | MultiDiscrete `[9, 2, 2, 2, 2, 2, 2, 2, 89]`, mask of 112 | `56445f5eaf2e4ceb…` |

The observation layout's hash covers the feature names, scales, sizes and the sha256 of the vocabulary **tables** of
`vocab.json` (docs/game-knowledge.md): it changes with the code **or** with a key or index of the vocabulary. The
file's header is not hashed, so re-exporting the knowledge under another account preset (`unlocked-v3` here) leaves
the layout hash where it was. A policy belongs to the layout hash it was trained with.

## 1. State (`observation.state`, schema 2)

The raw snapshot (docs/SNAPSHOT.md) was built for the hand-written bot: surroundings, no build. `extractState(run)`
adds the rest. `src/bot/extract.ts` is unchanged.

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
`test/observations/episode.test.ts` plays the same seed twice, the second time calling the extractor, the encoder
and the mask five extra times per step, and compares a digest over every step that includes the number of
`Math.random` draws and the whole state: identical.

## 2. Encoding

### Conventions

- **Bounded.** Every float is in [0, 1] (`bool`, `unit`, `log`) or [−1, 1] (`sym`, `slog`); values beyond a scale are
  clipped; a non-finite input becomes 0.

  | Scale | Value |
  |---|---|
  | `bool` | 0 or 1 |
  | `unit m` | clip(v / m, 0, 1) |
  | `sym m` | clip(v / m, −1, 1) |
  | `log m` | clip(ln(1 + max(v, 0)) / ln(1 + m), 0, 1) — HP, Pokédollars, counts |
  | `slog m` | sign(v) · clip(ln(1 + \|v\|) / ln(1 + m), 0, 1) |

- **Positions are relative to the player and world-axis aligned**: +x east, +z south, so the action's move `n` is −z.
  Nothing is rotated by the camera, because the action's directions are world-relative too. Direction index `d`
  means the angle `d · 22.5°` from +x towards +z, as in the snapshot.
- **Entity segments** hold the K nearest, nearest first. A row starts with `present`; an absent row is all zeros.
- **Damage fractions** are relative to the player's maximum HP.
- **Integers** are indexes of `vocab.json`; 0 is none / unknown.
- **Pokémon conditioning** does not rest on the species number: `global` has the types as a multi-hot and the rank,
  `stats` the run stats, and `ids` the role and passive indexes next to the species.

Each feature is declared once in `encode.ts` with its name, scale and reader; the descriptor and the values come
from that one declaration.

### Layout

| Segment | dtype | offset | rows × features | Content |
|---|---|---|---|---|
| `global` | float32 | 0 | 1 × 207 | player, progression, zone, guardian and seals, overtime, capture and rift, Max form, the dojo trial, phase, previous play action, type and rank of the Pokémon |
| `stats` | float32 | 207 | 1 × 39 | the player's run stats |
| `enemies` | float32 | 246 | 48 × 38 | the 48 nearest live enemies within 45 m |
| `density` | float32 | 2070 | 1 × 48 | all live enemies: counts per direction (16) and distance band ([0, 10) m, [10, 25) m, beyond) |
| `shots` | float32 | 2118 | 24 × 10 | the 24 nearest hostile projectiles within 30 m |
| `hazards` | float32 | 2358 | 16 × 14 | the 16 ground hazards whose edge is nearest: telegraphed strikes, boss and miniboss pools, boss shock rings |
| `xp` | float32 | 2582 | 1 × 4 | experience within 20 m: amount and centre |
| `pickups` | float32 | 2586 | 12 × 20 | the 12 nearest other pickups within 40 m |
| `points` | float32 | 2826 | 16 × 43 | the 16 nearest map points of the snapshot |
| `terrain` | float32 | 3514 | 1 × 84 | per direction: metres walkable, metres coverable by jumping, ground rise, blocked; distance to each map edge |
| `moves` | float32 | 3598 | 4 × 28 | one row per move slot |
| `vitamins` | float32 | 3710 | 1 × 26 | level of every vitamin of the vocabulary |
| `items` | float32 | 3736 | 1 × 142 | stack count of every held item of the vocabulary |
| `relics` | float32 | 3878 | 1 × 47 | which relics are held |
| `choice` | float32 | 3925 | 1 × 44 | the open dialog: kind, number of options, untargeted extras present and allowed. All zero in the play phase |
| `options` | float32 | 3969 | 64 × 56 | one row per option of the dialog (row = option index = choice index − 1) |
| `ids` | int32 | 0 | 1 × 11 | categorical identity of the run |
| `move_slots` | int32 | 11 | 4 × 2 | the move in each slot |
| `enemy_species` | int32 | 19 | 48 × 1 | species of each row of `enemies` |
| `option_entity` | int32 | 67 | 64 × 2 | what each option of the dialog is |

Slice `buffer[offset : offset + rows × features]` and reshape to `(rows, features)`. The per-feature list below is
the content of `observation-layout.json` (`segments[].features[]`, each with its `scale` or `vocab`).

#### `global` (207)

Player: `hp_frac` (unit 1) · `max_hp` (log 5000) · `shield_frac` (unit 1) · `map_x`, `map_z` (sym 1: position ÷ half
the map side) · `vx`, `vz`, `vy` (sym 25) · `speed` (unit 25) · `height` (unit 10) · `grounded` · `jumps_left`
(unit 3) · `diving` · `invulnerable_for` (unit 2) · `dash_ready` · `dash_cooldown` (unit 2) · `dashing` ·
`ultimate_charge` (unit 1) · `ultimate_ready` · `ultimate_active_for` (unit 10) · `radius` (unit 2) · `pickup_range`
(unit 30) · `dead`

Progression: `level` (log 150) · `xp_frac` (unit 1) · `pending_levels` (unit 5) · `run_time` (log 3600) ·
`zone_time` (unit 1200) · `zone:1…4` · `tier:0…2` · `gold` (log 100000) · `ball_price` (log 100000) ·
`ball_affordable` · `cage_price`, `slot_price` (log 100000) · `slot_affordable` · `map_points_used` (log 500) ·
`kills` (log 100000) · `refreshes`, `skips`, `banishes` (unit 12) · `move_slots_free` (unit 4) ·
`vitamin_slots_free` (unit 5) · `revives` (unit 3) · `has_next_evolution` · `levels_to_evolution` (unit 50) ·
`evolution_stage` (unit 3) · `enemy_hp_mult`, `enemy_damage_mult`, `enemy_amount_mult` (unit 5) · `enemy_speed_mult`
(unit 3)

Zone: `final_swarm` · `final_swarm_for` (unit 600) · `collapse_drain_frac` (unit 0.1) · `heal_multiplier` (unit 1) ·
`weather:` ash, clear, fog, hail, rain, sand, sun · `boss_spawned` · `stage_cleared` · `region_cleared` ·
`in_sanctuary` · `enemies_live` (log 1000) · `enemies_cap_frac` (unit 1) · `enemies_elite` (log 200) ·
`enemies_alpha` (log 50) · `enemies_ranged` (log 300)

Guardian and seals: `guardian_asleep` · `guardian_alive` · `guardian_hp_frac` (unit 1) · `guardian_max_hp` (log 10⁷) ·
`guardian_enraged` · `guardian_fight_time` (unit 300) · `seal_active:` clock, echo, fury, heal, horde, swift ·
`seals_broken` · `seal_clock_running` · `seal_clock_left` (unit 300) · `seals_kept` (unit 12) · `boss_present` ·
`boss_dx`, `boss_dz` (sym 60) · `boss_dist` (unit 90) · `boss_radius` (unit 8) · `boss_charging` · `boss_charge_for`
(unit 3) · `boss_charge_dx`, `boss_charge_dz` (sym 1) · `boss_move_for` (unit 5)

Overtime: `overtime_offered` · `overtime_live` · `overtime_over` · `overtime_round` (unit 24) · `overtime_round_left`
(unit 30) · `overtime_multiplier` (unit 25) · `overtime_bonus` (log 100000) · `overtime_drain_frac` (unit 0.1) ·
`overtime_ring_closing` · `overtime_ring_radius`, `overtime_arena_radius` (unit 80) · `overtime_centre_dist_frac`
(unit 1.5: distance from the arena centre ÷ ring radius) · `overtime_offering:` cebo, corriente, dique, manantial,
pleamar, rompeolas

Capture and rift: `capture_active` · `capture_can_throw` · `capture_weak_for` (unit 10) · `capture_dx`, `capture_dz`
(sym 45) · `friend_ball` · `rift_inside` · `rift_entrance` · `rift_entrance_dx`, `rift_entrance_dz` (sym 200)

Max form, Incense, Hypno: `form_charges` (unit 3) · `form_ready` · `form_active_for` (unit 30) · `incense` (unit 3) ·
`rift_can_open` · `rift_can_fuse` · `hypno_lesson_ready`

Dojo trial (all zero when none is played): `dojo_active` · `dojo:` wave, rush, circle, chain, elites, statue, race,
master, untouched · `dojo_belt` (unit 3) · `dojo_time_left` (unit 90) · `dojo_progress_frac` (unit 1) · `dojo_goal`
(log 1000) · `dojo_area` · `dojo_area_dx`, `dojo_area_dz` (sym 60: the circle, the statue's spot or the next mark of
the race) · `dojo_area_radius` (unit 12) · `dojo_grace_left` (unit 6) · `dojo_hold_frac` (unit 1) · `dojo_fighters`
(log 400) · `dojo_fighter` · `dojo_fighter_dx`, `dojo_fighter_dz` (sym 45: the nearest live dojo fighter)

Phase and action: `phase:` play, choice, over · `can_ultimate` · `can_interact` · `can_form` · `can_incense` ·
`can_fuse` (the play mask) · `prev_move:` none, n, ne, e, se, s, sw, w, nw · `prev_jump` · `prev_dash` ·
`prev_ultimate` · `prev_interact` · `prev_form` · `prev_incense` · `prev_fuse`. The previous action is
the last play action of the episode (all zero before the first one); a dialog in between does not clear it, because
the game keeps the movement keys held across a dialog.

Pokémon: `type:` × 18 (multi-hot, the types of the current form) · `rank:` common, legendary, rare, uncommon

#### `stats` (39)

One feature per key of the `stat` table, scaled by the kind the game gives the stat: `mult` → `sym 2` of
(value − 1); `pctpts` → `unit 1`; `flat` → `slog 500`.

#### `enemies` (48 × 38) and `enemy_species` (48 × 1)

`present` · `dx`, `dz` (sym 45) · `dist` (unit 45) · `vx`, `vz` (sym 15) · `approach_speed` (sym 15, positive when
closing) · `radius` (unit 5) · `hp_frac` (unit 1) · `max_hp` (log 10⁶) · `contact_damage_frac` (unit 1) · `speed`
(unit 20) · `attack_in` (unit 5: seconds until its next attack; a Charger dashes at 0) · `is_boss` · `flag:` × 24
(Elite, Alpha, Boss, Ranged, Flying, Healer, Shielder, Capture, Charger, Swarm, Stampede, Shiny, Totem, Summoner,
Treasure, Object, Remote, Classic, Burrow, Glide, Roll, Spite, Show, Horde)

#### `density` (48)

`dir<d>_band<b>` (log 200), index `d × 3 + b`.

#### `shots` (24 × 10)

`present` · `dx`, `dz` (sym 30) · `dist` (unit 30) · `vx`, `vz` (sym 40) · `radius` (unit 3) · `damage_frac` (unit 1) ·
`closest_approach_in` (unit 3: seconds until it is nearest on its current line) · `closest_approach_dist` (unit 10)

#### `hazards` (16 × 14)

`present` · `dx`, `dz` (sym 60) · `dist` (unit 60) · `radius` (unit 25) · `edge_dist` (sym 30, negative inside) ·
`inside` · `time_left` (unit 5) · `kind:` telegraph, boss, miniboss, wave · `wave_max_radius` (unit 40) · `wave_speed`
(unit 30)

#### `xp` (4), `pickups` (12 × 20)

`xp`: `present` · `amount` (log 500) · `dx`, `dz` (sym 20). `pickups`: `present` · `dx`, `dz` (sym 40) · `dist`
(unit 40) · `kind:0…15` (the game's numeric pickup kind; a kind of 16 or more has no bit and is counted in
`env.encoderUnknown`)

#### `points` (16 × 43)

`present` · `dx`, `dz` (sym 200) · `dist` (log 400) · `in_reach` · `used` · `cost` (log 100000) · `affordable` ·
`kind:` × 35 (the `interactable` table). `cost` is the Poké Ball price for paid balls, the cage price for cages and
the price of the next spin for slot machines; 0 for the others.

#### `terrain` (84)

`free0…15`, `hop0…15` (unit 9) · `rise_near0…15` (sym 5) · `rise_far0…15` (sym 8) · `blocked0…15` · `edge_east`,
`edge_west`, `edge_south`, `edge_north` (unit 60: metres to that edge of the playable square)

#### `moves` (4 × 28) and `move_slots` (4 × 2)

`present` · `level` (unit 10) · `cooldown_frac` (unit 1) · `cooldown_left`, `cooldown_total` (unit 10) · `busy` ·
`fusion` · `linked` · `damage_share` (unit 1: this move's share of the damage dealt so far) · `physical` · `type:` × 18.
Ints: `entity` (the move in the `entity` table), `archetype`.

#### `vitamins` (26), `items` (142), `relics` (47)

One feature per key of the table, in index order: vitamin level (unit 12), item stack (unit 10), relic held (bool).

#### `choice` (44), `options` (64 × 56), `option_entity` (64 × 2)

`choice`: `kind:` × 23 (the `decisionKind` table) · `options` (unit 64) · `shop_restock_cost` (log 100000) ·
`slot_spins_until_insured` (unit 6) · `hypno_lesson_ready` ·
`legendary` (the seals dialog is the legendary's) · `has:` and `allowed:` for refresh, skip, take, sell, decline,
leave, confirm, reroll

`options`: `present` · `allowed` (the mask) · `offer:` newMove, upMove, newVit, upVit · `has_rarity` · `rarity`
(unit 4) · `current_level` (unit 12: level of the move or vitamin an upgrade applies to) · `owned` (unit 10) ·
`has_price` · `price` (log 100000) · `affordable` · `from_other_kit` · `banish_allowed` · `banish_kit_allowed` ·
`stat_add` (slog 100), `stat_mul` (sym 1: a blessing's amount) · `seal_count` (unit 3) · `seal:` × 6 (the seals of a
subset) · `upgrade:` area, bounce, cd, count, crit, dmg, dur, pierce, speed, status (sym 2: what an offered move
upgrade adds) · `replaces_held` (a relic that would replace a held one) · `has_refund`, `refund` (log 100000: what
Hypno pays for forgetting, what the shop pays for an item) · `link` (the fusion machine: link instead of fuse) ·
`recipe:` signature, reaction, type, glitch · `trial:` × 9 (the dojo trial offered), `trial_belt` (unit 3),
`trial_limit` (unit 90), `trial_goal` (log 1000) · `lesson` (Hypno's "take the lesson" option)

`option_entity`: `entity` — `move:` (a new move, the held move an upgrade applies to, a move to forget, the first
move of a fusion), `vitamin:`, `item:` (item, item choice, shop, selling, Ditto), `relic:`, `offering:`, `species:`
(evolution, party, shiny swap) or `stat:` (the stat a blessing or a dojo prize changes); `secondary` — the League
member a new move comes from, the relic a new one would replace, or the second move of a fusion. A lesson's offers
are encoded as level-up offers; a slot machine's one option carries its price.
Dialogs whose options are fixed positions (sanctuary path, leave sanctuary, overtime start, trades, the seals
subsets, a dojo trial, a spin) carry 0: the dialog kind and the row say what the option is.

#### `ids` (11)

`species`, `start_species`, `guardian_species`, `boss_species` (table `species`) · `type1`, `type2` (`type`) · `role` ·
`rank` · `passive` · `map` · `decision_kind`

### What is never guessed

- A dialog with more than 64 options → `EncodingError` (and `ActionSpaceOverflowError` from the codec). Nothing is
  truncated.
- A move, vitamin, item, relic or overtime offering that is not in the vocabulary, a level-up offer of an unknown
  kind, a dialog of an unknown kind → `EncodingError`: the exported knowledge does not match the running game.
- Keys that may legitimately be outside the vocabulary encode as 0 and are counted in `env.encoderUnknown`
  (`ObservationEncoder.unknown`): a species number beyond the Pokédex, a stat outside the stat table, an
  interactable kind the map-point class does not name, a pickup kind ≥ 16. In the test episodes the count is empty.

### Deliberately left out

- The camera (yaw, pitch): actions are world-relative and the environment turns them into keys.
- Enemies beyond the 48 nearest as individuals (they are in `density`), enemies beyond 45 m as individuals, enemy
  types (the snapshot does not carry them; the species index is given), status effects on enemies.
- Allies / captured partners: they are not in the snapshot.
- Ground height as a map: only the 16-direction rings of the snapshot. The route planner (`planRoute`) is not part
  of the observation.
- Text: option labels, titles, descriptions. A dojo trial's rule is given by its kind, belt, goal and time limit.
- The reels of a slot-machine spin and what the last spin paid (it is in `decision.context.last`, not encoded): the
  outcome is what changes afterwards (Pokédollars, the item dialogs that follow).
- Trade options beyond their position; the contents of a shop beyond item, price and owned count.
- Reward: none is defined in this stage; `counters` are what rewards will be computed from.

## 3. Action codec

One flat MultiDiscrete vector `[move, jump, dash, ultimate, interact, form, incense, fuse, choice]` =
`[9, 2, 2, 2, 2, 2, 2, 2, 89]`:

| Dimension | Values |
|---|---|
| `move` | 0 none, 1–8 = n, ne, e, se, s, sw, w, nw (world-relative) |
| `jump`, `dash`, `ultimate`, `interact`, `form`, `incense`, `fuse` | 0 no, 1 press (`form` = Max form, `incense` = open a rift, `fuse` = open a fused rift) |
| `choice` | 0 none · 1–64 option 0–63 · 65–72 refresh, skip, take, sell, decline, leave, confirm, reroll · 73–80 banish option 0–7 · 81–88 banishKit option 0–7 |

- `encodeMask(observation)` → `Uint8Array(112)`: the per-dimension masks concatenated (offsets 0, 9, 11, 13, 15, 17,
  19, 21, 23).
  Play phase: the play dimensions follow the game's mask and `choice` allows only 0. Choice phase: the play
  dimensions allow only 0 and `choice` allows exactly the options and extras the dialog allows, never 0. Over: only
  the zeros (so that a sampler does not fail); decoding then throws.
- `decodeAction(vector, observation)` → `Action`; `encodeAction(action, observation?)` is its inverse. Decoding checks
  shape, ranges and the phase rules and translates; it never remaps. A well-formed action the mask forbids reaches
  the environment, which rejects or penalises it as configured.
- **Slots.** The dialogs of `dialogs.ts` have few options (the 8 subsets of three seals; relic cards × three slots
  when three relics are held; up to 4 level-up offers; the dojo's 21 prizes) except Ditto and the shop's sell list,
  which have one option per distinct held item (at most the game's 142). 64 option slots is a choice, not a bound of
  the game: the most distinct items a stored run has held is 15, how many a strong policy that spends all its
  Pokédollars holds has not been measured, and such a dialog beyond 64 stops the episode with an error. 8 target
  slots cover the level-up dialog's 4 offers. A
  dialog that does not fit throws `ActionSpaceOverflowError` in every function; a dialog with an extra action the
  codec has no index for throws `ActionCodecError`.

## 4. Use

```ts
const env = createEnvironment({ encode: true });
let obs = await env.reset({ seed: 1 });
env.observationLayout;                         // the descriptor (also in data/encoding/<build>/observation-layout.json)
obs.encoded;                                   // { version, layoutHash, float: Float32Array(7553), int: Int32Array(195), mask: Uint8Array(112) }
const { observation } = await env.step(decodeAction(vector, obs));
```

With `encode` off (the default) nothing of this is computed and `observation.encoded` is absent; `observation.state`
is always there.

## 5. Cost

`node scripts/export-encoding.ts --measure` (one zone-1 run kept alive by rewriting HP, a labelled cheat; 40 samples
per load level, each the mean of 20 calls on the same state; development machine, one process):

| Live enemies (mean) | `extractState` | `encode` | `encodeMask` | snapshot extractor (existing) | one simulation step |
|---|---|---|---|---|---|
| 0–10 (2) | 0.005 ms | 0.051 ms | 0.001 ms | 0.455 ms | 0.91 ms |
| 100–200 (123) | 0.012 ms | 0.112 ms | 0.001 ms | 0.681 ms | 2.03 ms |
| 700–800 (758) | 0.060 ms | 0.076 ms | < 0.001 ms | 0.576 ms | 2.96 ms |

"One simulation step" is the wall time of `env.step` divided by the simulation steps it ran, so it already contains
one snapshot and one state extraction per decision. A decision is three simulation steps: the state extraction and
the encoding together cost 0.06–0.14 ms against 2.7–8.9 ms, between 1 % and 5 % of a decision. State extraction
grows with the horde (it visits every live enemy for the histogram); encoding does not (it takes the 48 nearest
from the snapshot) and varies with how many entity rows are filled. The largest per-observation cost is the
existing snapshot extractor (its terrain probing), which this stage did not change.

## 6. Tests

- `test/actions/codec.test.ts` (no game): layout, masks in both phases, round trips of all 144 play actions and all
  72 choice indexes, malformed vectors, overflow.
- `test/knowledge/vocab.test.ts` (no game): table construction, headers, pinned vocabulary of the build, the
  vocabulary against the datasets, species / moves / items content, the loader.
- `test/observations/encode.test.ts` (no game): scales, layout, synthetic observations for every segment, errors.
- `test/observations/episode.test.ts` (**slow, boots the real game**, about 25 s): a real episode sampled from the
  vector mask with every step checked for bounds, finiteness and consistency with the observation; the state at the
  start of a run against the game's objects; the read-only proof.
