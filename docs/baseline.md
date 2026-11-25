# Runner and baselines (Stage 1)

How episodes are played unattended, what the heuristic baseline is, and the numbers a trained agent has to beat.
Storage is documented in docs/storage.md, the environment in docs/environment.md, game rules in docs/game-mechanics.md.

Everything below was measured on game build `mwsewi0r` (0.10.26), **account preset `unlocked-v3`**, Ranked rules, 60 Hz,
action repeat 3, on 2026-11-23, after the reproducibility fix described in §4. Results recorded before that fix or on
another preset are not comparable and were deleted. `data/pokebonk.sqlite` holds 17 batches, all on `unlocked-v3`
with one bundle hash, one shim hash and one profile summary: 1, 2 and 4 are the baseline, 3 is an earlier version
of the heuristic on the same seeds (its label says "superseded"; §8), 5–7 and 14–17 are the replays of §4 and §5,
8–13 the spread of §3. Batches 22–24, added later, are the same policies on the held-out seeds (§10).

## 1. The unattended runner

```
node scripts/run-episodes.ts --policy=heuristic --episodes=30 --seed=1 --workers=5 --max-time=3600
node scripts/run-episodes.ts --policy=random --episodes=30 --workers=3 --species=25 --map=coast --tier=1
node scripts/baseline-report.ts --preset=unlocked-v3 --label=baseline --ends --decisions      # tables from the database
node scripts/compare-batches.ts --a=3 --b=10                                                  # same seeds, same episodes?
node scripts/heuristic-trace.ts --seed=3 --quiet                                              # one heuristic episode, readable
```

- `scripts/run-episodes.ts` is the **parent**: it never loads the game. It starts `--workers` child processes
  (`src/runner/worker.ts`, one environment each: the browser shims are global to a process), hands out seeds one at a
  time over Node's IPC channel, and is the only writer of the SQLite database (`src/runner/pool.ts`,
  `src/storage/database.ts`). Options are listed in the script's header.
- **An episode is a function of its batch settings and its seed**: which worker plays it, in which order, as which
  episode of its process, and how many workers there are does not change it (§4).
- **Recycling.** (Since 2026-11-25 the default is `--recycle-after=1`, every episode in a fresh process: see the note
  under "Recycling default" in §4.) A worker is replaced by a fresh process after `--recycle-after` episodes (then: default 8) or as soon as it
  reports more than `--recycle-rss` MB (default 1500) after an episode: the environment's memory grows by about 25 MB per
  episode, and long episodes with large hordes grow the heap by themselves. `--recycle-after=1` plays every episode in
  a fresh process (§4 says when that is worth its cost).
- **Failures are recorded, never hidden, never retried.** An episode that throws: the worker sends the error (message,
  stack, the environment's own details of an `UnknownSituationError`) and exits; the parent writes a row in `errors`
  and starts a fresh worker. A worker that delivers nothing for `--episode-timeout` wall seconds (default 1800) is
  killed and recorded as `worker-timeout` with its last progress report; a worker that dies is recorded as
  `worker-exit`. The batch goes on with the remaining seeds, ends with status `failed`, and the exit code is 1
  (0 = every seed played and stored, 2 = bad command line, 130 = interrupted).
- `--max-time=<game seconds>` is the environment's safety cap (episode ends as `truncated`). Without it an episode ends
  only when the run does; the sanctuary has no clock, so a policy that never wakes the legendary would never end.
- `--policy-options=<json>` passes the policy's own settings (heuristic: `{"tuning":{…},"heuristic":{…}}`) and is stored
  with the batch.
- **The account preset is stored with every batch** (`batches.profile_preset`), every worker of a batch must report the
  same one, and `scripts/baseline-report.ts` refuses to print batches of different presets together
  (docs/storage.md, "Reports").

## 2. The heuristic baseline (`src/agents/heuristic/`)

A deterministic policy `(observation) → action`: the hand-written brain of `src/bot/brain/` (written against the browser
sandbox) behind the environment's interface. It sees the observation and the read-only route planner
(`HeadlessGameEnvironment.planRoute`), nothing else. **It is a baseline, not a strategy.** What was changed and what
was looked at while writing it: §8.

| Part | File | What it does |
|---|---|---|
| play phase | `policy.ts`, `adapter.ts` | `decide(snapshot, memory, tuning, directive)` → nearest of the eight world directions (a heading exactly between two goes to the diagonal, as the browser harness's key mapping did), jump / dash / ultimate / interact only while the mask allows them. Far goals (> 14 m) are walked along routes planned at most every 0.45 s of game time. |
| choice phase | `chooser.ts`, `knowledge.ts` | One rule per decision kind (table below). |
| lifecycle | `policy.ts` (`directiveFor`) | From `observation.state.overtime`. Legendary beaten: overtime is started with at least 90 % HP, after a rest of at most 45 s (nothing spawns in the sanctuary meanwhile). Overtime live (or about to start by itself on the direct path): the portal is not used and the fight is kept within 10 m of it; below 70 % HP the run is cashed out: straight to the portal, ignoring every threat, and interact. |

What the brain does in a zone, in order of priority: **the portal once the zone is cleared**, straight through whatever
is in the way (threats do not count, jump and dash) → flee and heal below 42 % HP → fight a woken guardian at the far
end of its longest move → capture windows → **wake the guardian** when the level is reached (16 / 32 / 44 in zones
1 / 2 / 3) with the ultimate at 60 %, or after 420 s in the zone, in both cases with at least 70 % HP. The walk to the
altar does not wait for a gap in the horde; while the altar is more than 14 m away it is made "with determination"
(threats count for 35 %, the goal pulls 2.5 times as hard as an ordinary one); once begun it is only broken off below
55 % HP, and the guardian is only woken with 70 % → loot, altars and service points while calm → experience → fight
(priority targets, else herd the nearest pack). In the sanctuary the legendary is woken at 90 % HP or after 45 s.

| Decision | Rule |
|---|---|
| `levelup` | Score every offer and take the best; refresh when the best is under 38 and a refresh is left. Never skips, never banishes. Scores reuse `scoreOffer` of `src/bot/brain/choices.ts`: upgrade of a core move of the build 100 − 2·rank (other moves 74); vitamins by what they raise (a stat the build scales with 64 − 3·rank, damage 50, utility 42 before level 15 and 26 after, +6 for an upgrade; survival 88 when under 50 % HP, 70 when one hit of an enemy around takes over 22 % of the HP bar, else at most 34); new move of the own kit with a free slot 86, borrowed from another League member 60 before level 8 and 40 after, no slot 12; +3 per rarity step; −30 for "more and stronger enemies" and "elite spawns". |
| `evolution` | Evolve, into the first form offered. |
| `item` | Take it; sell the few that make the run harder (`white-flute`, `lure-ball`, `rage-candy-bar`, `fast-ball`, `life-orb`, `macho-brace`). |
| `itemChoice`, `ditto`, `shop` | Worth of an item from a small hand-made table (`knowledge.ts`: revives 95, large multipliers 85, sustain 78 / 68, experience 72, plain damage 66, type and class items 80 when the kit has a move of that type / class and 25 otherwise, unknown 50). Choice: the best, or none when all are harmful. Ditto: copy the best owned. Shop: buy the best affordable one worth ≥ 70, repeat, leave; never restock. |
| `blessing` | The blessing whose text scores best with the level-up rules. |
| `seals` | Wake without seals. |
| `sanctuaryPath` | Classic path (fight the legendary). |
| `leaveSanctuary` | `ot` (go on to the overtime dialog). |
| `overtimeStart` | Start. |
| `overtimeOffer` | A "hold" offering (`manantial`, `dique`, `rompeolas`, in that order) when offered, else none. |
| `trade` | Decline. |
| `party` | Release the weakest ally (lowest base stat total, never the shiny partner) when the newcomer is stronger, else decline. |
| `shinySwap` | Keep the current partner. |
| `relic` | Take the first relic while a slot is free, else decline. |
| `dojo`, `slots`, `forget`, `fusion` | Leave (nothing else is exposed). |

Service points (`meowth` = shop with at least 150 ₽, `ditto` with an item to copy, `fossil` and `porygon` = trades) are
walked to once per zone when they are within 28 m and things are calm.

## 3. Baseline results (preset `unlocked-v3`)

Cyndaquil (#155) on `forest`, tier 0, Ranked rules, **the same seeds 1–30 for every policy**, full episodes (the safety
cap of 3600 game seconds was never reached). Database `data/pokebonk.sqlite`, batches 1, 2 and 4;
`node scripts/baseline-report.ts --preset=unlocked-v3 --label=baseline --markdown --ends --decisions` prints these
tables. KOs are the run's own count (`run.stats.kills`); the bonus of a cashed overtime is given separately.

| | idle (batch 1) | random (batch 2) | heuristic (batch 4) |
|---|---|---|---|
| policy version | `1+e9dcaf8a7329` | `1+e9dcaf8a7329` | `3+66cdc6cf1dbf` |
| episodes / errors | 30 / 0 | 30 / 0 | 30 / 0 |
| **KOs** mean / median / min / max | 375 / 306 / 18 / 1007 | 5999 / 1092 / 113 / 29033 | 3475 / 3349 / 572 / 7413 |
| KOs + cashed overtime bonus, mean / max | 375 / 1007 | 5999 / 29033 | 3509 / 7832 |
| game time (s) mean / median / min / max | 201 / 203 / 62 / 314 | 398 / 345 / 134 / 767 | 673 / 648 / 260 / 1086 |
| level mean / median / min / max | 13.4 / 13 / 1 / 24 | 37.7 / 26 / 9 / 99 | 38.0 / 38.5 / 16 / 54 |
| zone reached (episodes) | 1: 30 | 1: 30 | 1: 3, 2: 19, 3: 4, 4: 4 |
| guardians beaten (episodes) | 0: 30 | 0: 30 | 0: 3, 1: 19, 2: 4, 3: 4 |
| legendary beaten / overtime started / cashed | 0 / 0 / 0 | 0 / 0 / 0 | 4 / 4 / 4 |
| causes of end | died: 30 | died: 30 | died: 26, won (victory) with overtime cashed: 4 |

What the three do:

- **idle** never moves and takes the first option of every dialog. It lives 201 s on average: the moves fire by
  themselves and level it to 13 before the horde gets through.
- **random** never leaves zone 1 (it would have to answer the seals dialog at the altar; it never got there). Its
  KOs are bimodal: 22 episodes end before the zone clock reaches 600 s (113 to 2,569 KOs), 8 survive into the
  **final swarm** and make 12,679 to 29,033 KOs in the 78 to 167 s they last there.
- **heuristic** plays the lifecycle: it beat the zone-1 guardian in 27 of 30 episodes, the zone-2 guardian in 8, the
  zone-3 guardian in 4, and in those 4 also the legendary; all 4 started overtime and cashed it through the portal
  (bonus 141 to 419). §6 says where the other 26 ended.

**KOs and progress pull in opposite directions.** Random's mean (5,999) is above the heuristic's (3,475) although it
never beats a guardian: KOs come from being alive in a zone whose clock has passed 600 s, when the game fills the map
to its cap of 800 enemies, and a run that moves on to the next zone resets that clock. The median says the opposite
(1,092 against 3,349), and every one of the heuristic's four complete runs (5,463 to 7,413 KOs) is below what a
zone-1 final swarm gives. A development variant of the heuristic that sat in zone 2 until its final swarm made
17,949 KOs on average and completed nothing (§8). Anything that rewards KOs alone will learn to camp in zone 1; the
objective "complete the run, then maximise KOs" needs the completion to be worth more than a final swarm (an open
question for the reward design, §9).

### Spread: the heuristic on other Pokémon and maps

Seeds 1–10 each, tier 0, Ranked rules, batches 8–13: heuristic `3+66cdc6cf1dbf`, preset `unlocked-v3`, 10 of 10
episodes and 0 errors in each.

| Batch | Pokémon, map | KOs mean / median / min / max | KOs + cashed bonus, mean | Game time (s) mean / median | Level mean | Zone reached | Guardians beaten | Legendary beaten / overtime started / cashed | Causes of end |
|---|---|---|---|---|---|---|---|---|---|
| 8 | Bulbasaur (#1), forest | 7273 / 7582 / 1245 / 12454 | 7462 | 1100 / 1232 | 50.8 | 2: 4, 3: 1, 4: 5 | 1: 4, 2: 1, 3: 5 | 5 / 5 / 5 | died: 5, won with overtime cashed: 5 |
| 9 | Pikachu (#25), forest | 3655 / 3117 / 983 / 9330 | 3655 | 703 / 685 | 37.7 | 2: 9, 3: 1 | 1: 9, 2: 1 | 0 / 0 / 0 | died: 10 |
| 10 | Eevee (#133), forest | 6601 / 3042 / 491 / 26758 | 6601 | 724 / 642 | 42.4 | 1: 1, 2: 7, 3: 2 | 0: 1, 1: 7, 2: 2 | 0 / 0 / 0 | died: 10 |
| 11 | Mewtwo (#150), forest | 4404 / 3919 / 466 / 9444 | 4532 | 810 / 689 | 40.5 | 1: 1, 2: 5, 3: 1, 4: 3 | 0: 1, 1: 4, 2: 2, 3: 3 | 3 / 3 / 3 | died: 7, won with overtime cashed: 3 |
| 12 | Cyndaquil (#155), coast | 3601 / 3195 / 931 / 11014 | 3601 | 710 / 730 | 38.5 | 1: 2, 2: 3, 3: 4, 4: 1 | 1: 5, 2: 4, 3: 1 | 0 / 0 / 0 | died: 10 |
| 13 | Cyndaquil (#155), glacier | 4941 / 4217 / 1031 / 13938 | 4941 | 796 / 742 | 42.8 | 2: 5, 3: 3, 4: 2 | 1: 5, 2: 3, 3: 2 | 1 / 1 / 0 | died: 9, won with overtime lost: 1 |

- **The Pokémon matters more than the map.** Bulbasaur (a healer, and one of the six lines the brain has a build plan
  for) completes 5 of 10 runs and Mewtwo 3 of 10; Pikachu and Eevee (no build plan: generic damage picks) none.
  Cyndaquil completes 4 of 30 on forest; on coast and glacier one of 20 beat the legendary (glacier, and then lost
  overtime) and two more fainted fighting it.
- Overtime: 9 started in these batches, 8 cashed after 13–67 s in round 1–3 with a bonus of 26–1,215 KOs; one was
  lost (glacier, seed 4: fainted 17.5 s into overtime, the run ends as a victory with `ot.cashed = false` and its
  bonus of 35 does not count). Five tide offerings were met and a "hold" one taken each time.
- Eevee's maximum (26,758 KOs) is a run that stayed in a zone into its final swarm, like random's best ones.
- Ten seeds per row: a difference of one or two complete runs between rows is within noise.

## 4. Reproducibility and independence of workers

**Claim.** With the current environment an episode is a function of (preset, build, policy version and options,
species, map, tier, rules, seed). It does not depend on the number of workers, on the order in which seeds are handed
out, or on how many episodes the worker process played before.

**Check.** `scripts/compare-batches.ts` compares two stored batches seed by seed: all 30 columns of `episodes` that
describe the episode (everything except ids, wall and reset seconds, worker id / pid / episode number / memory,
wall-clock stamps), including the counters, the final build and the game's own end record as JSON text, and every
column of every decision row. It refuses batches that were not played the same way.

| Batches compared | What differs between them | Seeds | Result |
|---|---|---|---|
| 4 against 16 (heuristic) | 5 workers / 1 worker; seeds handed out 1…30 / 12…1; episodes 1st–3rd / 1st–8th of their process | 1–12 | identical: 12 episodes, 523 decisions, 483,608 simulation steps |
| 4 against 15 (heuristic) | 5 workers / 3 workers | 1–12 | identical: 12 episodes, 523 decisions, 483,608 steps |
| 4 against 14 (heuristic) | 5 workers / 6 workers | 1–12 | identical: 12 episodes, 523 decisions, 483,608 steps |
| 4 against 5 (heuristic) | 5 workers / 1 worker replaced every 3 episodes, seeds 6…1 | 1–6 | identical: 6 episodes, 245 decisions, 231,077 steps |
| 4 against 6 (heuristic) | reused processes (episodes 2nd–3rd) / **every episode in a fresh process**, 2 workers, seeds 12…7 | 7–12 | identical: 6 episodes, 278 decisions, 252,531 steps |
| 2 against 17 (random) | reused processes (episodes 4th–7th) / every episode in a fresh process, 2 workers | 13, 20, 21, 24, 25 | identical: 5 episodes of 703–767 s that end in the final swarm (15,921–29,033 KOs), 702 decisions, 237,244 steps |
| 2 against 7 (random) | 5 workers / 2 workers, seeds 4…1, fresh processes on both sides | 1–4 | identical: 4 episodes, 274 decisions, 85,739 steps |

Each of the heuristic's seeds 1–12 was thus played five times, with 1, 3, 5 and 6 workers (seeds 7–12 also with 2,
each in a fresh process), as first to eighth episode of its process, with one result. They include two complete runs
(seeds 2 and 12: three guardians, the legendary, overtime cashed; seed 12 with a tide offering) and episodes that end
in every zone.

Before the final batches the same check was made on development seeds 3001–3012 (heuristic policy of that moment,
full episodes of 345–832 s): 6 workers against 3 workers, both with `--recycle-after=12`, episodes played as 1st–3rd
against 1st–5th of their process: 12 of 12 identical, 476 decisions, 365,053 simulation steps. And one episode step by
step: seed 3012 in a fresh process against the same seed as third episode of a process (after full episodes of seeds
3005 and 3007): 7,858 steps with position, HP, KOs, live enemies, damage dealt and the number of `Math.random` calls
at every step, identical.

What this does not cover: Pokémon other than Cyndaquil and maps other than `forest` in the replays; tiers 1–2;
episodes with an evolution choice, a capture or a rift; the unit test (`test/runner/runner.test.ts`) repeats the comparison on five 25-second episodes
only.

**History: a defect found with this runner, fixed in the environment.** The first comparison (same development seeds,
6 against 3 workers, process reuse) gave 2 different episodes of 12, and 3 of 11 against a single worker; for example
seed 3012 ended at 1147.6 s with 28,638 KOs in a fresh process (twice) and at 999.9 s with 29,038 KOs as the third or
fifth episode of a process. Fresh against fresh always agreed. The first differing step was the one in which the
zone-1 guardian fell (step 5130, 254.22 s): everything equal except the number of `Math.random` calls, 720,870 in the
fresh process against 720,846. Recording the call stacks of that step in both processes showed the 24 extra calls:
three.js draws four `Math.random` numbers for the UUID of every object it creates, from the same stream gameplay uses,
and `onBossKilled → spawnBonk` loads a texture only the first time in a process (the game caches it at module level).
Any lazily created, cached three.js object shifts the gameplay stream in the same way. The random policy never gets
past a guardian, which is why the environment's own reproducibility checks had passed. The fix is in `src/sim`
(three.js UUIDs come from a private stream; docs/environment.md §3, cause 4); all results recorded before it were
discarded. With the fix the comparisons above are identical.

**Recycling default: 1 since 2026-11-25.** The evidence below was gathered on episodes of 345–832 s and holds for
them. Episodes of the second heuristic on tier 2 (2,200–3,400 s) are NOT reproduced by a reused process: the game's
virtual wall clock keeps running between episodes and its value changes play (docs/environment.md §3, cause 5). So
every episode is now played in a fresh process. What was written then: `--recycle-after=8`: process reuse is reproducible on the evidence above, a reused process
saves loading the game (the first reset of a process takes 4.1 s on average against 2.6–2.8 s for later ones, §5),
and 8 episodes bound the memory growth (§5). `--recycle-after=1` (every episode in a fresh process) stays available
for when a result must not be able to depend on process history at all; the table above includes one such batch.

## 5. Throughput and memory

**Conditions.** AMD Ryzen 5 7500F (6 cores, 12 threads), 16 GB, Windows 11, Node 24.22. The machine was shared during
every measurement with other work (two other agents' headless simulations and test runs, a visible Chrome window);
3.1–4.3 GB of memory were free when these batches started. Heuristic policy (it also calls the route planner about
twice per game second while a goal is far), full episodes, default recycling, wall time of the whole batch including
process starts, resets and workers idle at the end. Read them as lower bounds.

| Workers | Batch | Episodes (seeds) | Simulation steps | Batch wall (s) | Steps/s over the batch | × real time | Steps/s per worker while playing | Episodes/hour | Peak worker memory |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 16 | 12 (1–12) | 483,608 | 572 | 845 | ×14 | 883 | 76 | 726 MB |
| 3 | 15 | 12 (1–12) | 483,608 | 286 | 1,690 | ×28 | 660 | 151 | 636 MB |
| 5 | 4 | 30 (1–30) | 1,263,560 | 529 | 2,389 | ×40 | 537 | 204 | 1,141 MB |
| 6 | 14 | 12 (1–12) | 483,608 | 240 | 2,011 | ×34 | 475 | 180 | 787 MB |

- Three workers give twice the single worker; beyond that each added worker slows the others (883 → 660 → 537 → 475
  steps/s per worker). Six workers on twelve episodes look worse than five on thirty also because the batch ends with
  one long episode and five idle workers. On this machine, under this load, **4–5 workers** is the useful setting.
- Other policies at 5 workers: idle 2,413 steps/s and 713 episodes/hour (short episodes); random 1,515 steps/s and
  214 episodes/hour (its long episodes sit in the final swarm with 800 enemies alive, the slowest regime of the
  simulation: docs/environment.md §7).
- **Resets** (all 237 episodes of the database): the first reset of a process, which loads the game, 4.1 s on average
  (2.7–6.5); later resets 2.6–2.8 s (1.6–4.5).
- **Memory** (resident, after an episode, all batches): 500 MB on average after a process's first episode (at most
  733), 704 MB after its sixth (at most 1,141, the peak of all 237 episodes). No worker reached the 1,500 MB recycling
  threshold. Five workers need 3–5 GB.
- The 237 episodes are 9,060,764 simulation steps (40 hours of game time); no network attempt was blocked in any of
  them (`blocked_network` = 0 in every row) and there is no row in `errors`.

## 6. How far the heuristic gets, and what stops it

The 30 baseline episodes (batch 4; `--ends` of the report script), by where they ended:

| Ended | Episodes |
|---|---|
| fainted fighting the zone-1 guardian | 3 |
| fainted in zone 2 before waking its guardian | 11 |
| fainted fighting the zone-2 guardian | 8 |
| fainted in zone 3 before waking its guardian | 1 |
| fainted fighting the zone-3 guardian | 3 |
| complete run: three guardians, the legendary, overtime started and cashed | 4 |

| Step of the lifecycle | Reached | Passed |
|---|---|---|
| zone-1 guardian woken (mean level 16.7) | 30 | 27 beaten |
| zone-2 guardian woken (mean level 37.3) | 16 of the 27 in zone 2 | 8 beaten |
| zone-3 guardian woken (mean level 47.0) | 7 of the 8 in zone 3 | 4 beaten |
| sanctuary path chosen, legendary woken (mean level 48.8) | 4 | 4 beaten |
| overtime started | 4 | 4 cashed (in round 1, 2, 1 and 1) |

- **Zone 2 is the wall.** Of the 27 episodes that got there, 11 fainted before the guardian was woken: 2 below the
  wake level of 32, 9 at or above it (levels 32–42), on the way to the altar or while waiting for 70 % HP and the
  ultimate. The last hit came from an ordinary enemy in 7 of the 11 (elite 2, totem 1, a roaming legendary 1). Most
  of them still had the 197 max HP of the evolved starter: the chooser takes survival offers only once "one hit
  takes over 22 % of the HP bar" or the bot is under half its HP.
- **Guardian fights.** 14 of 53 fights with a zone guardian were lost (zone 1: 3 of 30, zone 2: 8 of 16, zone 3: 3
  of 7), after 28 s on average (11–53 s), the last hit dealt by the guardian itself in 11 of them. Fights that are
  won take 22–51 s in zone 1, 29–51 s in zone 2, 37–62 s in zone 3. The brain circles the guardian at the far end
  of its longest move and dodges telegraphed strikes, charges and shock rings; what hits it in between was not
  analysed.
- **The legendary and overtime are not what stops it**: 4 of 4 legendary fights (Mew) were won, in 110–175 s;
  overtime was cashed below 70 % HP after 16–32 s, in its first or second round, with a bonus of 141–419 KOs, a small
  part of the run's 5,463–7,413. One tide offering was met and taken (`manantial`).
- Earlier versions of the brain failed before the fights: they never arrived at the altar or the portal (§8).

## 7. Dialogs met in real play

Counted over every batch of `data/pokebonk.sqlite` (11,610 decisions in 237 episodes of 17 batches) and the
checks named below. No `UnknownSituationError` and no row in `errors` in any batch. "Effect seen" means the answer's consequence was read
back from the observation or from the stored records, not only that the run went on.

| Kind | Met in real play by | Answers given | Effect seen |
|---|---|---|---|
| `levelup` | every policy | take; refresh, skip, banish, banish kit (random policy); refresh (heuristic) | moves, vitamins and stats change; refresh and banish re-open the dialog with new offers |
| `item` | random, heuristic | take, sell | `items.<key>` +1 and the stat it raises; sell: Pokédollars +36 |
| `itemChoice` | random, heuristic | one of the items; none (random) | as `item` |
| `blessing` | every policy | one of the offers | the stat changes (`regen 2.7 → 3.66`) |
| `seals` | heuristic | wake without seals (every time) | the guardian spawns (`bossSpawned`), the fight follows. Seal subsets and "not now": cheating probe only |
| `sanctuaryPath` | heuristic | classic path | zone 4 with the shrine. `direct` and "stay": cheating probe only |
| `leaveSanctuary` | heuristic | `ot` | before the shrine has relit: nothing (the policy asks again 1.2 s later); after: the overtime dialog. `leave`: cheating probe only |
| `overtimeStart` | heuristic | start | overtime is live; `record_json.ot` |
| `overtimeOffer` | heuristic | `dique`, `manantial` | `record_json.ot.picks` |
| `evolution` | heuristic: Eevee in 4 episodes of batch 10 (five forms offered, "stay" masked because the game reports the Everstone missing); Pichu in a trace (seed 4003) | the first form (Vaporeon at level 36; Pikachu at 20, Raichu at 38) | `final_species` 134; in the trace species 172 → 25 → 26 with max HP and damage changing. "Stay" was not exercised |
| `trade` | heuristic (declines), random (accepts) | decline; `dome`, `amber` (fossils), `critChance>damage` (Porygon) | decline: play resumes. Accepted: the run went on and its final stats fit the trade (crit chance 0.10 → 0.25), not read back at the step itself |
| `ditto` | heuristic, random | copy an item; decline (random) | `items.max-revive 1 → 2` |
| `shop` | heuristic (4 visits in batches 9, 12 and 13, one item bought in each; one more in the superseded batch 3, nothing bought); `scripts/probes/shop-dialog-check.ts` on seed 27 for the restock | buy, leave; restock (check script) | buy, read from the next decision of the same visit: Pokédollars 593 → 307 for a 286 ₽ `muscle-band`, the entry marked sold, `owned` 0 → 1, the window still open with the mask recomputed; restock: 89 → 1, four new entries, next restock 88 → 132 ₽; leave: play resumes |
| `dojo`, `forget`, `fusion`, `slots` | random (`slots` also heuristic) | leave (all that is exposed) | play resumes; the next interact press at the point opens it again (87, 251, 188 and 34 times) |
| `party` | heuristic, twice (batch 8 seed 9, batch 12 seed 9): a fourth ally with a team of three | newcomer leaves (Golbat, base stats 455, against a team of 483 / 483 / 490); release the weakest (Dodrio 470 for Kingdra 540) | newcomer leaves: play resumes. Release: the game's own ally list read before and after the answer in a replay of that episode, `[Omastar, Kabutops, Dodrio]` → `[Omastar, Kabutops, Kingdra]` |
| `shinySwap`, `relic` | **never appeared** | – | – |

Why the last two did not appear: a shiny swap needs a second shiny partner, and by the game's code a run on the
complete shiny collection of `unlocked-v3` has no wild shiny to meet (docs/game-mechanics.md §6); relics come from
rifts, which no policy here enters.

Two checks outside the batches, both without any cheat: four traced episodes of the heuristic with every service
point in `visitKinds` (`scripts/heuristic-trace.ts --tuning={"visitKinds":[…]}`, seeds 4001–4004, Eevee, Pichu and
Cyndaquil), which is where the evolution was met; and `scripts/probes/shop-dialog-check.ts`, the heuristic with the
shop rule replaced by "buy the first thing the mask allows, restock once, leave" (seed 27; seeds 5 and 11 met no shop).

No bug was found in `src/environment/dialogs.ts`: every callback protocol was also re-read against the game's call
sites (argument order of `showShinySwap`, `showParty`, `relicChoice`, `showDojo`, `showBranch` and the others).

## 8. What was changed in the brain, and what was looked at

The brain was written against the browser sandbox, where it survived 5–10 minutes and never beat a guardian. Changes
made for this stage, each with a unit test in `test/brain.test.ts` or `test/agents/chooser.test.ts`:

| Change | Why (what was seen in headless play) |
|---|---|
| `Directive` from the lifecycle layer: hold the portal, a leash, a forced order | overtime is cashed by the portal; the snapshot does not say that overtime runs |
| a forced order ignores enemies, shots and ground hazards, jumps and dashes | cashing out: 15 m from the portal when it decided, 46 m away 30 s later, fainted |
| `liveBoss`: a guardian is live between its wake and its fall | the game reuses the boss record; in later zones it described an ordinary enemy |
| service points (`visit`), sanctuary wake rule | shop / Ditto / trades were never used; the legendary sleeps at a shrine, not an altar |
| a walk to the altar that has begun is finished (`wakeKeepHp`), the guardian is woken with `wakeHp` | the wake goal came up eleven times in four minutes and was dropped each time; 12 minutes in zone 3 at level 98 with the guardian asleep |
| wake levels 16 / 32 / 44 instead of 16 / 24 / 32 | at 16 / 24 / 32 the zone-2 guardian was woken at level 25 on average and won 7 of 12 fights, in 24 s on average |
| rest before overtime (`restHp`, `restSec`) | overtime started under `cashHp` and was cashed 1.2 s later with a bonus of 0 |
| cleared zone: the portal is a forced goal and comes before fleeing | 13 m from the portal when the zone-2 guardian fell, 70 m away 20 s later, fainted in that zone 4 minutes later (4 of 30 episodes ended like this) |
| the walk to the altar does not wait for a gap in the horde, and is made "with determination" while far (`wakeThreat`, `wakePull`) | 11 of 30 episodes ended in zone 2 above the wake level with the guardian never woken; one spent four minutes of "wake" between 120 m and 240 m from the altar |

**Not tuned against the baseline seeds.** All of this was developed on seeds 3001–3012 (and single traces of seeds
1001, 3004, 3007, 3012, 4001–4004); the numbers `wakeKeepHp` 0.55, `wakeThreat` 0.35, `wakePull` 2.5, `restHp` 0.9
and `restSec` 45 were each set once and not searched. Two things were decided by comparing 12-seed batches
(`data/heuristic-dev.sqlite`, batches 3–7, all on `unlocked-v3` after the reproducibility fix; batches 1 and 2 of
that file are the 6-against-3-workers check of §4):

| Development batch (seeds 3001–3012) | Zone-2 guardian woken | Guardians beaten 0 / 1 / 2 / 3 (episodes) | Complete runs | KOs mean / median |
|---|---|---|---|---|
| 3: wake at 16 / 24 / 32, walk finished once begun | 12 | 0 / 7 / 4 / 1 | 0 | 1483 / 1169 |
| 4: wake at 16 / 32 / 44 | 7 | 0 / 8 / 2 / 2 | 2 | 6039 / 3908 |
| 5: wake at 20 / 40 / 56, clock rule at 560 s | 3 | 1 / 9 / 2 / 0 | 0 | 17949 / 19483 |
| 6: 16 / 32 / 44, forced portal, no waiting for a gap | 5 | 0 / 10 / 2 / 0 | 0 | 7699 / 3829 |
| 7: as 6, plus the determined walk (the baseline policy) | 10 | 0 / 8 / 3 / 1 | 0 | 4287 / 4307 |

Twelve seeds do not separate these by complete runs (2, 0, 0, 0, 0); the choice was made by whether the policy does
what its own rules say (reaches the altar, takes the portal), which batch 7 does and the others do not. One exception
to "not looked at": the policy of batch 4 of this table was first run on the baseline seeds 1–30 (stored as batch 3
of `data/pokebonk.sqlite`, labelled superseded: 1 complete run, guardians 0 / 1 / 2 / 3 beaten in 2 / 17 / 10 / 1
episodes, KOs mean 8076, median 3603), and what was seen there (the portal not taken in 4 episodes, the guardian
never woken in 11; one of them, seed 12, was traced) is what led to the last two rows of the table of changes. They
were then validated on the development seeds before the baseline was run again. The checks of single dialogs in §7
also used baseline seeds (27, 29, 5, 11); nothing was changed because of them.

## 9. Not verified, and open questions

- Tiers 1 and 2, the other seven maps, co-op and other modes: not played by any batch here.
- `shinySwap` and `relic` decisions never appeared in real play (§7); their handling is tested against a stand-in
  HUD and was re-read against the game's call sites only.
- The direct sanctuary path, leaving the sanctuary without overtime, overtime's 24-round end and the zone collapse
  were not met by a policy without cheats (overtime lost by fainting was, once: §3).
- The heuristic never puts on a seal, never banishes or skips a level-up, never takes a trade and never restocks a
  shop: those answers were exercised by the random policy or by a scripted check, or not at all (§7).
- Throughput was measured on a machine shared with other work (§5); the numbers are lower bounds.
- **For the owner.** (1) KOs alone favour camping in a zone's final swarm over completing the run (§3): how much is
  a completed run worth in KOs? (2) What the real service counts when overtime is lost is unknown
  (docs/game-mechanics.md §1); the baseline therefore cashes early (below 70 % HP). (3) Is the objective judged on
  `kills` or on `kills` plus the cashed overtime bonus? The table gives both.

## 10. Held-out seeds (added 2026-11-24, Stage 3 preparation)

The same three policies, unchanged, on **seeds 900001–900050**: the same scenario (Cyndaquil, forest, tier 0, Ranked,
preset `unlocked-v3`, cap 3600 s never reached), batches 22, 23 and 24, labels `heldout-idle`, `heldout-random`,
`heldout-heuristic`. 150 episodes, no errors, no blocked network attempt.
`node scripts/baseline-report.ts --preset=unlocked-v3 --label=heldout --markdown --ends` prints the tables.

| | idle (batch 22) | random (batch 23) | heuristic (batch 24) |
|---|---|---|---|
| episodes / errors | 50 / 0 | 50 / 0 | 50 / 0 |
| **KOs** mean / median / min / max | 417 / 290 / 13 / 1916 | 3473 / 740 / 74 / 26676 | 3564 / 3016 / 1611 / 12186 |
| KOs + cashed overtime bonus, mean / median / max | 417 / 290 / 1916 | 3473 / 740 / 26676 | 3600 / 3016 / 12958 |
| game time (s) mean / median | 201 / 197 | 336 / 284 | 691 / 626 |
| zone reached (episodes) | 1: 50 | 1: 50 | 2: 40, 3: 6, 4: 4 |
| guardians beaten (episodes) | 0: 50 | 0: 50 | 1: 39, 2: 7, 3: 4 |
| legendary beaten / overtime started / cashed | 0 / 0 / 0 | 0 / 0 / 0 | 3 / 3 / 3 |
| causes of end | died: 50 | died: 50 | died: 47, won with overtime cashed: 3 |

- **What these seeds are for.** A trained model's promotion verdict is taken on them and on nothing else
  (`configs/evaluation.yaml`, docs/training.md §5). No policy, reward weight or setting was or may be chosen by
  looking at them; seeds 1–30 (§3) are the ones to look at while tuning.
- **The heuristic was not developed on them** and behaves as on seeds 1–30: median 3,016 against 3,349, the zone-1
  guardian beaten in 50 of 50 episodes (27 of 30 there), a complete run in 3 of 50 (4 of 30).
- **Random again has two kinds of episode**: 43 end with 74 to 3,264 KOs, 7 reach the zone-1 final swarm and make
  13,866 to 26,676. Its mean (3,473) depends on how many of those a seed list happens to hold (8 of 30 in §3,
  mean 5,999); its median (740 here, 1,092 there) does not, which is why the promotion rule uses the median.

## 11. Mewtwo (added 2026-11-24): the scenario of Stage 3

> **These batches were played before the map features of §12 were made playable** (action layout 1: no Max form,
> no Incense; the slot machine, the dojo, Hypno and Bill's machine could only be closed). The random policy now also
> presses the new keys and answers the new dialogs, so its episodes are different ones. The numbers below stay as
> the record of that state; the reference batches a model is compared with have to be played again on the current
> environment before the first verdict (`promotion.first_reference`).

The owner chose Mewtwo (#150) as the one Pokémon to train first. Same policies, unchanged, on `forest`, tier 0, Ranked,
preset `unlocked-v3`, cap 3600 s never reached; no errors, no blocked network attempt.
`node scripts/baseline-report.ts --preset=unlocked-v3 --label=mewtwo --markdown --ends` prints the tables.

Development seeds 1–30 (batches 26, 27, 28; labels `baseline-mewtwo-*`):

| | idle | random | heuristic |
|---|---|---|---|
| **KOs** mean / median / min / max | 814 / 456 / 32 / 8719 | 11111 / 14200 / 166 / 20919 | 6585 / 6050 / 466 / 25605 |
| KOs + cashed overtime bonus, mean / median / max | 814 / 456 / 8719 | 11111 / 14200 / 20919 | 7509 / 6050 / 28510 |
| game time (s) mean / median | 254 / 232 | 583 / 698 | 941 / 941 |
| zone reached (episodes) | 1: 30 | 1: 30 | 1: 1, 2: 11, 3: 6, 4: 12 |
| legendary beaten / overtime started / cashed | 0 / 0 / 0 | 0 / 0 / 0 | 12 / 12 / 10 |

Held-out seeds 900001–900050 (batches 29, 30, 31; labels `heldout-mewtwo-*`):

| | idle | random | heuristic (**33 of 50 seeds**) |
|---|---|---|---|
| **KOs** mean / median / min / max | 1364 / 685 / 15 / 10172 | 9750 / 12872 / 182 / 20831 | 6486 / 5935 / 849 / 13428 |
| KOs + cashed overtime bonus, mean / median / max | 1364 / 685 / 10172 | 9750 / 12872 / 20831 | 6866 / 6147 / 17957 |
| zone reached (episodes) | 1: 50 | 1: 50 | 1: 1, 2: 8, 3: 4, 4: 20 |
| legendary beaten / overtime started / cashed | 0 / 0 / 0 | 0 / 0 / 0 | 18 / 18 / 16 |

- **Batch 31 is incomplete.** It was stopped at 33 of 50 episodes when the machine ran out of free memory, and is
  stored with status `interrupted`. It is not a reference for anything; `heldout-mewtwo-random` (batch 30), the
  reference of the promotion rule, is complete.
- **With Mewtwo, random play beats the heuristic by a factor of two** (median 14,200 against 6,050; 12,872 against
  about 6,000 held out). Mewtwo is strong enough that moving at random survives to the zone-1 final swarm in 22 of
  30 and 30 of 50 episodes, and a swarm gives 10,000 to 21,000 KOs before it kills (all of them die between 660 and
  736 s, the swarm having begun at 600 s). The heuristic leaves zone 1 at level 17, long before the swarm; 9 of its
  10 complete runs with overtime cashed score 6,990 to 16,172, about what one swarm gives.
- **The highest score of all is an overtime.** The best episode on seeds 1–30 is the heuristic's seed 12: 11,746 KOs and
  a cashed overtime bonus of 16,764 after 12 rounds, together 28,510. Overtime's multipliers are worth more than a
  swarm when it is survived that long.
- **What this says about the objective.** Nobody here survives a final swarm for more than about two minutes, and
  nobody reaches a later zone *after* farming one. A policy that did either would be far above every row of these
  tables. That, not the heuristic's route, is what the trained model is after (docs/training.md §3).
- **The bar for a first stable model** is therefore high for Mewtwo: a median score of at least 12,872 on the
  held-out seeds, which means reaching and using the final swarm in most episodes.

## 12. Map features made playable (added 2026-11-24)

The owner's decision: without using everything on the map the agent will never play optimally. Until then the slot
machine, the dojo, Hypno and Bill's fusion machine could only be closed, items could not be sold, and the keys for
Max form and Incense were not connected (so no rifts and no relics). All of it is now part of the action space and
of the decisions (docs/environment.md §3–§4), and was checked against the real game by a script that does not cheat:
`scripts/probes/map-features-check.ts` walks to map points with the route planner and acts only through the
environment. Mewtwo, forest, tier 0.

| Feature | Seed, game time | What was done | What the game did |
|---|---|---|---|
| Hypno, lesson | 1, 7.4 s | `forget` → `lesson` (allowed: a free slot, the lesson unused) → the first of three offers | Swift learned into slot 2; back in `forget` the lesson is masked |
| Hypno, forget | 1, 7.4 s | forget the move in slot 2 | Pokédollars 0 → 8 (level 1 × 8 × zone 1), the slot is free; with one move left, forgetting is masked |
| Dojo | 1, 18.1 s | `dojo`: three trials offered (`rush` belt 1, `circle` belt 2, `race` belt 3) → `rush`; `dojoPrize`: 21 blessings → damage | the trial runs on the map: 28 KOs in 20 s; it ended at 27 of 28 (failed); the dojo point is marked used |
| Shop, sell | 1, 92.2 s | `shop` → `sell` → the one owned item (rarity 4) | Pokédollars 37 → 127 (+90), the item gone, back in the shop |
| Power Altar, Max form | 2, 20.8 s | stand in the altar; press `form` when the mask allows | charge 0 → 1, the altar used; the form runs 26.1 s, `formsUsed` 1, the charge spent |
| Slot machine | 2, 127.5 s | `spin` at 40 ₽ with 43 ₽ | a miss: 3 ₽ left, the window stays open, the next spin costs 43 ₽ and is masked |
| Slot machine | 3, 142–535 s | 15 spins over several visits | nine misses kept the window open; six spins paid and closed it, and the game's item dialogs followed; the price rose from 40 to 235 ₽, 1,410 ₽ spent in all |
| Bill's machine | 2, 37–303 s | opened five times with no pair at level 8 | no option, only `leave`; the context names what is missing |
| Bill's machine | 2, 441.9 s | three moves at level 8: six options (`fuse` and `link` for three pairs) → `fuse` Psystrike + Psycho Boost | the signature fusion `fu-150` in slot 2, slot 4 free, the machine used |
| Incense, rift | 1, 240–333 s | `incense` → walk into the entrance → call the waves → `relic` dialog → the rift's portal | two rifts cleared in 34 s and 39 s, relics `c-die` and `c-fang` held (the first time the `relic` dialog met the real game) |
| Fused rift | 1, 300 s | `fuse` with 3 Incense | Incense 3 → 0, the entrance opens, the rift is entered; the run ended in it (fainted at 359 s) |
| Gengar's altar, cursed Poké Ball, cage, berries, Ditto, a trade | 1 and 3 | interact (they needed nothing new) | each marked used and counted in `pointsUsed` |

Not met in these games: `link` at Bill's machine, forgetting a vitamin, a slot-machine curse or ambush, the `party`
and `shinySwap` dialogs. They are covered by the stand-in tests only (`test/env/dialogs.test.ts`).

**Reproducibility.** A game with slot-machine spins, Hypno, a dojo trial, a sale and three rifts (seed 3, 350 s) was
played twice: the two logs are identical (1,445 lines). `scripts/env-determinism.ts` with the random policy, which now
presses the new keys (Mewtwo, seed 5, 240 s): fresh process = fresh process = reused process, 4,908 steps, digest
`e1fa9a6fc55e0352…`. The slot machine's spin is the one asynchronous answer (it asks the game service for its draw);
the environment waits for it without moving the virtual clock.

**Not done.** These features were not compared step by step with the browser (the fidelity runs of
docs/fidelity.md predate them); what is verified is that each answer has the effect the game's own code describes.
No baseline has been played on the new environment yet.

## 13. The rule against standing still, checked on the baselines (added 2026-11-24)

The owner's rule (docs/training.md §3): an episode with no KO and no movement for 30 game seconds ends there and is
invalid. Before it was switched on for training and evaluation, the three scripted policies were played again on
seeds 1–30 with the rule on (`node scripts/run-episodes.ts … --max-idle=30`, Mewtwo, forest, tier 0, cap 3600 s; a
scratch database, not `data/pokebonk.sqlite`) and compared seed by seed with batches 1 to 3 (KOs, game time, steps,
cause of end):

| Policy | Episodes ended by the rule | Identical to the stored baseline |
|---|---|---|
| heuristic | 0 of 30 | 30 of 30 |
| random | 0 of 30 | 30 of 30 |
| idle (never moves) | 1 of 30 | 29 of 30 |

- **The heuristic plays the whole lifecycle** (guardian fights, the walk to each portal, the sanctuary, overtime;
  13 complete runs on these seeds) and never goes 30 s without a KO and without moving 3 m. The rule ends nothing
  that play of that kind does.
- **Random never meets it either**, so the reference of the promotion rule (`heldout-mewtwo-random`) and
  `baseline-mewtwo-random` are what they would have been with the rule on. They were not played again.
- **The one episode it ended** is the standing-still policy on seed 14: no enemy reached it in the first 30 s, so
  it had 0 KOs and had not moved (32 KOs in 77 s without the rule). That is the rule doing what it says.
- Not checked: the held-out seeds, and the same on other Pokémon and maps.

