# Phase 0 report: is 20 million plausible?

2026-11-24. Mewtwo, forest, tier 2, Ranked, build `mwsewi0r` (0.10.26), offline. No training was run. The specification
is not on this machine; the sections below are those of the two stage reports in this folder.

**Answer: yes, 20 million is plausible on this build.** My first answer was "no", and it was wrong: see §6.7. A
leaderboard Mewtwo build, handed to our pinned headless game and played through Overtime with no cheat inside it,
kills all of the ×3 horde for 18 rounds and cashes **16.5 million from Overtime alone**. With the 5 million KOs such
a run makes in the zones before Overtime, that is past 20 million. The question is no longer whether the game allows
it, but whether an agent can build that Pokémon: a 96-minute run, level 6,000, more than 300 items.

Marks: **[C]** read in the bundle's code. **[P]** measured in play with a cheating probe (never an agent, never used
for training or evaluation). **[N]** not checked.

## 1. What was done

1. The brief's facts were checked against the bundle, and the checkable ones in play (§6.1).
2. A cheating probe plays Overtime on tier 2 and measures spawns, KOs, bodies alive and time per decision (§6.2, §6.3).
3. A survival model of Overtime was written and checked against probe runs (§6.4).
4. The item archive was set through the profile the game adopts and played with; the other archives were read (§6.5).
5. The observation was checked for Overtime-sized values and for the healing figures (§6.6).

## 2. Files

| File | What |
|---|---|
| `scripts/probes/overtime-ceiling-probe.ts` | the cheating Overtime probe (kill everything, kill with own moves at a damage multiple, no heal, experience cheat, no-hit cheat) |
| `scripts/probes/archive-check.ts` | sets an item archive through the preset the game adopts, plays heuristic episodes, reports what was offered |
| `src/model/overtime.ts` | Overtime in numbers: multipliers, spawns, kill weight, tide, heal factor, ceiling, and the survival model |
| `test/model/overtime.test.ts` | the constants against the mirrored bundle; the formulas against probe measurements; the survival model against a probe run |

Nothing under `mirror/` was written. No observation, action, reward or preset was changed.

## 3. Tests

`npm test`: 173 pass (169 before, 4 new). The parity digest `e1fa9a6fc55e0352` is unchanged. Python tests were not run:
no Python file changed.

- The Overtime table in `src/model/overtime.ts` is compared key by key with the table in the mirrored bundle.
- The ceiling formula is within 3 % of the probe's KOs in rounds 1, 2, 3, 10 and 16.
- The bonus recomputed from a probe run's 23 rounds equals the game's own figure (21,715,026).
- The survival model puts the no-heal probe's fainting between 540 and 600 s; the game put it at 567 s.

## 4. Isolation

Everything ran headless and offline through the environment. The probes write to game objects in their own process
only. The archive probe has to replace the environment's stored starting profile to get past its own check that a
profile never changes between resets; the environment itself was not changed.

## 5. Performance

| Measured in Overtime, one process | |
|---|---|
| Time per decision, about 160 bodies alive (everything killed at once) | 2.1 to 5.1 ms |
| Time per decision, 350 bodies alive (killing with own moves) | 3.8 to 5.6 ms |
| A whole probe run to round 23 (about 14,000 Overtime decisions) | 52 to 70 s |
| Live-enemy cap in the sanctuary, and the frame-rate governor | 800, never cut |

## 6. Results

### 6.1 The brief's facts

| Claim | Result |
|---|---|
| 24 rounds of 30 s | **[C]**. In play the probe never passed round 23 (below). The cash by itself after round 24: **[C]** only |
| Multipliers 1.25, 1.5, 2, 2.5, 3, 4, then +1; +0.1 per seal, 12 at most | **[C] [P]**: ×2.45 in round 1 with 12 seals kept |
| Pleamar +0.5 | **[C] [P]**, from the round it is taken in. **It also raises the tide by 25 %** (not in the brief) |
| Bonus = sum of round KOs × (multiplier − 1), rounded down | **[C] [P]**: equal to the game's figure in every probe run |
| Offerings on entering every second round | **[C] [P]**: rounds 2, 4, 6 …; three are shown (one that holds, one that risks, one more); each can be taken once |
| An enemy counts 1 + seconds/45 KOs, up to 7 | **[C] [P]**. The same weight multiplies its drops (Pokédollars, berries) |
| Spawn rate 30 + 0.8/s up to 150/s, × clamp(difficulty × enemy amount × tier amount, 1, 3) | **[C] [P]** at ×3. What is not spawned because the cap is reached is lost |
| At most 350 bodies | **[C] [P]** for the horde; elites come on top (400 seen) |
| Elites | **[C]**: every 20 s, 6 + 2 per round, twice as many with Cebo; each counts 1 |
| HP ×4 and damage ×2 a minute; after 480 s a further ×12 and ×4 a minute | **[C]**; **[P]** indirectly (§6.3) |
| The ring closes from 90 to 240 s, to 40 % | **[C]** (60 % with Rompeolas). **[N]** in play |
| Fainting loses the bonus, the portal cashes it | **[P]** both |
| Tier 2: enemy amount ×1.6 | **[P]**; also HP ×1.9, damage ×1.96, speed ×1.16 |
| The tier's `kills` [1, 1.25, 1.5] | **[C]**: no code of the client reads it (nor `level`). A tier-2 kill counts what the weight says **[P]**. If anything uses it, it is the service |
| Cursed Incense, White Flute, curses raise the spawn multiplier | **[N]** |
| Tide from 120 s at 0.25 %/s, doubling a minute, ×4 a minute after 480 s | **[C] [P]** |
| … of an expected max HP for the run time | **[C] [P]**: 400 + 1 per second of run time **when Overtime starts** (541 for a start at 141 s). A later start means a stronger tide |
| Overheal and shield absorb the tide first | **[C]** |
| Lifesteal and Shell Bell share 5 % of max HP a second (8 % stored), before the healing stat | **[C]**. **[N]** in play |
| Regeneration is outside that budget | **[C]** |
| Heal factor fades to 0.5 by 330 s | **Different [C] [P]**: it reaches 0.5 at **225 s**. Manantial doubles it, 1 at most |
| Dique cuts the tide 30 % | **[C]** |

**Not in the brief, and they matter:**

- **Berries are the main heal [C] [P].** Every kill drops a healing berry with chance 0.6 % × power-up stat × the kill's
  weight. A berry heals 25 % of max HP through the healing stat and the heal factor, outside the lifesteal budget. In
  the no-heal probe 39,032 of 40,731 HP healed came from pickups. So a build heals as long as it kills.
- **Training [C] [P].** A level-up with nothing left to offer heals 20 % of max HP and adds a small permanent stat
  (one of damage, max HP, attack speed, area, crit, luck, armor). Level-ups go on in Overtime: 394 Training levels.
- **A hit takes at most 40 % of max HP [C]** (25 % for elites and Alphas), then nothing lands for 0.45 s. Late in
  Overtime every hit is at that cap. Evasion is capped at 60 %; armor reduces by armor / (armor + 45).

### 6.2 The spawn ceiling

Every body killed the moment it arrives, spawn multiplier 3 **[P]**: 5,269, 11,995, 21,747, 34,321, 49,820, 62,971,
72,027, 81,026, 90,084 KOs in rounds 1 to 9 and **94,500 a round from round 10**. Each is within 0.3 % of the formula.

Score of Overtime alone if cashed at the end of a round, at that ceiling (from the formula, in millions):

| Cashed after round | Tide, % of reference HP per second | ×3 spawns, 12 seals, Pleamar | ×3 spawns, no seals | ×1.6 spawns, 12 seals |
|---|---|---|---|---|
| 6 (3 min) | 0.5 | 0.87 | 0.56 | 0.42 |
| 10 (5 min) | 2 | 3.67 | 2.79 | 1.82 |
| 14 (7 min) | 8 | 8.29 | 6.76 | 4.18 |
| 16 (8 min) | 16 | 11.16 | 9.31 | 5.66 |
| 18 (9 min) | 64 | 14.41 | 12.24 | 7.35 |
| 20 (10 min) | 256 | 18.04 | 15.54 | 9.23 |
| 22 (11 min) | 1,024 | 22.05 | 19.23 | 11.32 |
| 24 (12 min) | 4,096 | 26.43 | 23.29 | 13.61 |

- **26.4 million is the most this build can pay**, with every enemy dying on arrival for twelve minutes.
- **20 million needs round 21 or 22 at that ceiling.**
- The probe never got there even with HP set to its maximum every decision: it fainted at 672 to 679 s, because the
  tide then takes more than a whole HP bar between two decisions.

### 6.3 What damage it takes

A full kit (level 400 by an experience cheat, four moves and five vitamins maxed from the first offers), ×3 spawns,
12 seals, no hit landing, its damage stat multiplied **[P]**:

| Damage multiplied by | KOs in Overtime | Share of the ceiling it kills | Score if cashed at the end |
|---|---|---|---|
| 1 (honest) | 2,054 | 9 % of round 1, then nothing | 0.03 M |
| 30 | 8,985 | 42 %, 16 %, 6 %, then about 1 % | 0.06 M |
| 1,000 | 47,535 | 59 % falling to 2 % by round 10 | 0.25 M |
| 1,000,000 | 552,553 | up to 85 % in round 9, under 10 % from round 16 | 5.18 M |
| 1,000,000,000 | 985,738 | about 85 % in rounds 9 to 17, 3 % in round 21 | 11.74 M |

- Coverage alone costs about 15 %: with any damage the kit reaches about 85 % of what spawns.
- Each ×1,000 of damage buys about five more rounds before minute 8, and less than one after it.
- The stored heuristic's Overtime on tier 0 (1,065 and 632 KOs in rounds 1 and 2) sits near the ×30 row. That is one
  run on another tier: a rough placing, not a measurement.
- Damage that grows with enemy HP was looked for **[C]**: executes below a share of HP (Razor Fang, a relic, a
  passive) and Foul Play, which is capped at three times the hit. Nothing found that scales without limit.
  Not every move and item was read.

### 6.4 The survival model (`src/model/overtime.ts`)

Per second: heal = healing stat × heal factor × (berries + lifesteal up to the budget + regeneration + Training
levels); taken = tide share × reference HP + hits. Overheal and shield go first. Heals above max HP are lost.

- **Check [P].** The no-heal probe (max HP about 360, healing 1, everything killed at ×3 spawns) fainted 567 s into
  Overtime. The model says 540 to 600 s with every berry picked up, and 360 to 480 s without berries.
- **What gives the longest survival**, by the formulas (**expected, not measured with a real build**):
  1. **Max HP.** Every heal is a share of max HP and the tide is a share of the reference HP, so max HP above the
     reference multiplies everything.
  2. **Healing stat**, and **Manantial** (doubles the heal factor). Both multiply berries, which the budget does not cap.
  3. **Killing fast**, and the **power-up stat**: berries per second are 0.6 % × power-up × KOs per second.
  4. **Dique** (tide −30 %); avoid **Pleamar** unless the build has room (tide +25 %).
  5. **Pick-up range**: a berry on the ground heals nothing.
  6. Lifesteal and Shell Bell only up to 5 % of max HP a second; regeneration is small; overheal and shield are a
     buffer of a second or two late on.
  7. **Start Overtime early in run time** if the build allows: the reference HP is 400 + the run clock in seconds.
- Which items, vitamins, relics and passives carry those stats was **not** worked out: that is the item-effect
  table phase 1 needs anyway.

### 6.5 Archives and Build Plan

- **Item archive [P].** `profile.itemsOff`, given to the game through the preset its own `devUnlock` adopts, is taken
  by the run (`run.itemsOff`, 75 of 75) and the game's pool test refuses an archived item. Three heuristic episodes on
  tier 2: 18 different items offered in item, item-choice and shop dialogs, none archived.
- **Slots [P].** 5 × Lab level `archive` (6) + owned shop items (75) = **105** for this account. The game applies the
  limit when an item is toggled, and to a Build Plan's own archive at the start of a run, but **not** to the general
  archive at the start of a run **[C]**: a preset has to keep to it itself.
- **Read, not played [C]:**
  - Move archive: per Pokémon, 40 moves at most, never a move of its own kit.
  - Type archive: per Pokémon, types switched off take their items out; at least three types stay on.
  - Pre-banished list (`profile.banished`): taken by every run. Its limit was not found.
  - Build Plan (the game's local storage): 8 moves, 5 vitamins, 3 fusions, 3 relics, 4 favourites (among its moves),
    and optionally its own item archive, which replaces the general one.
- **[N]:** how the game fills a dialog when the pool is small, and a "kit archive" other than banishing in the run.

### 6.6 The observation

| Feature | Scale | At Overtime sizes |
|---|---|---|
| `overtime_bonus`, `kills` | log to 100,000 | flat from 100,000 on |
| `overtime_drain_frac` | 0 to 10 % of max HP a second | flat from about minute 7 |
| `level` | log to 150 | flat from 150 (the probe reached 534) |
| enemy `max_hp` | log to 1,000,000 | flat early in Overtime |
| `max_hp` | log to 5,000 | fine for now |
| `overtime_multiplier` | 0 to 25 | fine (24.2 at most) |

Present: HP, shield, the heal factor, and every stat (healing, lifesteal, regeneration, overheal, shield maximum).
**Missing:** the overheal held now, how full the lifesteal budget is, Training levels, the spawn multiplier as the game
computes it, the reference HP and the tide in HP. A new observation version is needed (phase 2 plans one).

### 6.7 The leaderboard builds: what was wrong with the first answer

The owner disagreed with "no" and gave two leaderboard run records (tier 2, Ranked, coast): a Nidoking shown as over
30 million and a **Mewtwo shown as 29.4 million**. Both are kept without the players' names in
`test/fixtures/leaderboard/`.

- **They are runs of our build.** Every one of their items, vitamins, relics and moves exists in `mwsewi0r`, and their
  limits are ours: vitamins at level 12 (10 + Max Ether), moves at 10 (8 + TM Case), fusions at 6, damage capped at 10¹².
- **What such a run looks like** (the Mewtwo): 5,779 s (96 minutes), level 6,293, 6.5 million KOs before the bonus, 313
  items held (ten each of the multipliers: Wise Glasses, Twisted Spoon, Razor Claw, Dusk Stone, Shiny Stone, PP Max,
  Metronome, Big Root, Assault Vest, Exp. Share, Lucky Egg, Comet Shard, Cleanse Tag). Stats: damage ×152, special
  ×50.5, attack speed ×15.6, crit damage ×15, area ×76, 19 projectiles, max HP 19,650, healing ×15.7, power-ups ×4.8,
  luck 944, experience ×43.7, Pokédollars ×54.7.
- **Measured [P]:** that build on our game, forest tier 2, run clock set to 5,060 s before Overtime (reference HP
  5,465), 12 seals, no kill, heal or no-hit cheat in Overtime:

  | Replica | Rounds with every body killed | Then | Overtime score |
  |---|---|---|---|
  | its items, vitamins and relics handed out (weaker than the original: special ×13.8, max HP 11,793, healing ×4.3) | 1 to 17 (99 % in 18) | 84 %, 32 %, 9 %, 1 %; fainted at 636 s | 14.3 M if cashed after round 18, 16.3 M after round 20 |
  | the same with its own stat sheet written over the stats | 1 to 18 | 85 %, 34 % | **16,545,214, cashed at the portal after round 20** (the game's own figure) |

  The record itself implies about 22.9 million of bonus, which is every body killed to about round 23. The replica
  falls short of that from round 19: it plays Mewtwo's first-offered moves, not the player's kit (Trick Room, Future
  Sight, Perish Song, Mist, Encore and the Psycho Boost + Psystrike fusion). What in that kit keeps killing when HP
  grows ×48 a minute was not found.
- **What the first answer got wrong.** §6.3's table is right, and so is its scale; the reading of it was wrong. I
  placed an honest strong build near the ×30 row from one stored tier-0 heuristic run. A real top build sits at the
  **×1,000,000,000 row**. I had listed that placing as not measured and concluded "no" anyway.
- **What heals a real build [P].** In the replica with the full stat sheet 41.7 of 46.9 million HP healed came on
  kills (Berry Juice: a chance per KO to heal a share of max HP), 2.9 million from lifesteal within its budget, 1.9
  million from berries on the ground. §6.4's model has no on-kill heal yet; it needs one.
- **What it changes in the plan** (for the owner to decide):
  - The run is about 96 minutes, not 20: about 29 minutes per zone. Top runs stay deep into every final swarm and
    its collapse; "leave before the collapse drain" is not how these scores are made. 5 million KOs come from the zones.
  - About 5,900 of the 6,293 levels are Training levels: experience gain is a build stat of its own.
  - More than 300 items means an economy build first (Pokédollars ×54.7, luck 944) and spending all of it.
  - An episode is about 115,000 decisions at 20 a second. Its wall time in the long final swarms was not measured.

## 7. Limitations and open questions

- **Which part of the leaderboard kit keeps killing after round 18 is not known** (§6.7).
- **Whether an agent can reach such a build is not known**: no stored run comes near its length, level or item count.
- The probes of §6.2 to §6.4 reach Overtime in about 150 s of run time, so their reference HP is a tenth of a top run's; those of §6.7 set the run clock to 5,060 s.
- Lifesteal, Shell Bell, the ring and the spawn-multiplier items were not exercised in play.
- The move, type and plan archives were not played.
- The dialog raised while fainting (found earlier, `mewtwo-v2-01` seed 8) is still open.

## 8. Target

The brief's target stands: **one run of 20 million or more in an evaluation of the 50 held-out seeds**, with 100,000,
1 million and 5 million on the way, and median, mean, p90 and best reported every time.

What phase 0 adds to it:

- The Overtime part of such a run is measured: 16.5 million cashed after round 20 with a leaderboard build's stats.
- The part that is not shown is the 86 minutes before it: reaching level 6,000 with 300 items on tier 2. Neither the
  stored heuristic (best 33,564 on tier 0, portal as soon as the guardian falls) nor any model has stayed in a final
  swarm for long.
- **First thing in phase 1:** find out how long a zone can be farmed and what it yields: a probe that stays in zone
  1's final swarm and collapse with a handed-out mid-game build, measuring KOs, experience, Pokédollars and wall time
  per minute.
