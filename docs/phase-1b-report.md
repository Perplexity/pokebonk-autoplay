# Phase 1b report: a second round on the heuristic (plan-2)

2026-11-25/26. Mewtwo, forest, **tier 2**, Ranked, build `mwsewi0r` (0.10.26), offline. No training was run. The owner
asked for one more round on the heuristic before the hybrid of phase 2 (docs/phase-1-report.md §7). Sections are the
specification's seven (docs/spec.md §16). "Measured" figures were played headless; the tuning batches are in scratch
databases and named by letter, the gate batches are in `data/pokebonk.sqlite` under the labels given. "Expected" is
said where it is only that.

**Result.** On the 50 held-out seeds, played once with the plan fixed: median **1,505,704**, mean 2,219,726, p90 4,195,666,
best **9,052,797**; 49 of 50 reach Overtime and all 49 cash it. plan-1 on the same seeds: median 71,181, best 269,223, 24 of 50. The 1 million
milestone is passed at the median and the 5 million milestone by single runs; **no run reaches 20 million**, and §6
says why this heuristic cannot.

## 1. What was implemented

Everything is in the second heuristic (`src/agents/heuristic2/`), as a new plan version **`plan-2`**. `plan-1` is
kept and playable (`--policy-options='{"plan":{"base":"plan-1"}}'`); replayed with the final code it gives the phase 1
scores to the KO (seed 3: 135,464, seed 4: 9,627). The policy version is `2`. The environment, the observation, the
actions, the reward and the account preset are unchanged.

What changed, in the order the measurements asked for it:

1. **The walk to a target is made through the horde.** Measured cause of most of phase 1's losses: guardian fights
   took about 30 s, but the *walk* to the altar took 150 to 320 s and in zone 2 often never ended. Altars stand 15 m
   from the map edge; the movement code weighs every enemy and the edge against the target and circled 7 to 17 m from
   the altar. The same held for Poké Balls: a 40-second give-up timer in the movement code ran across consecutive
   targets and then dropped every one it was sent to. The plan now orders its own walks (altar, map points, back to
   the portal) the way the first heuristic orders the walk to cash Overtime.
2. **Errands instead of looting** (`errandFor`): the nearest map point whose own condition holds. Free and paid Poké
   Balls, cages and the slot machine by price; the shop on a first visit and again when the Pokédollars have doubled;
   Ditto with an item to copy; Snorlax and Magnemite; Rhydon's roars before the guardian wakes (one more Great Ball
   each); cursed Poké Balls, the cursed altar and Gengar's altar while HP is high and the estimated spawn multiplier
   is under 3. Phase 1 ended runs with 30,000 to 160,000 Pokédollars unspent next to 37-Pokédollar slot spins.
3. **Dialog answers**: slot spins while one costs at most a tenth of the Pokédollars held; shop restocks under the
   same share; Challenge Seals by a list (`clock`, `swift`, `echo`, `fury`, `horde`; never `heal`), up to three a
   fight; a special move of another League member's kit goes into a free slot instead of being banished.
4. **The final swarm of a cleared zone is fought next to the portal**, and left when HP falls under 65 %, when a Max
   Revive is spent, or, without a Max Revive, when one hit of the horde would take all of max HP (`hordeHit`: read
   off the damage of the enemies and shots in view, after armor). The clock limit moved from 50 s into the swarm to
   just before the collapse.
5. **Overtime is cashed on the HP bar** (under 75 %, or half of max HP lost within 4 s, or a Max Revive spent), no
   longer on the size of the tide.

Every threshold is a key of the plan (`plan.ts`, 27 new keys, with the measurement behind each value that was tuned); `plan-1`
holds the values that switch each new rule off.

**Tried and not adopted** (measured, §6): leaving a swarm at the first heavy hit or on the lowest HP of the last
seconds; leaving and cashing on the horde's damage regardless of revives; a wider errand range with three times the
spending shares.

**Still not implemented, although the brief asks for it:** move, kit and type archives and Build Plan favourites; the
dojo, Bill's machine, Hypno's lessons, Porygon's and the fossil trades, eggs, rifts, Max forms; Overtime offerings
chosen by the survival model (the order is still fixed: Manantial, Dique, Rompeolas); a cash rule from the model's
balance of heal and tide.

## 2. Files created or changed

| File | |
|---|---|
| `src/agents/heuristic2/plan.ts` | `PLAN_V2`, 27 new keys, `PLANS`, `planWith` takes `base` |
| `src/agents/heuristic2/policy.ts` | errands, ordered walks, the swarm stay, `hordeHit`, `spawnEstimate`, HP log, revive tracking; version 2 |
| `src/agents/heuristic2/chooser.ts` | slot machine, restocks, seals from a list, borrowed moves |
| `test/agents/heuristic2.test.ts` | 5 new tests, 1 extended |
| `docs/phase-1b-report.md` | this report |

Phase 1's files (preset `unlocked-v4`, the dropped dialog, `heuristic2` itself) are still uncommitted with these.

## 3. Tests run and results

- `npm test`: **186 pass** (181 before). `python -m pytest`: **38 pass**. Parity digest `e1fa9a6fc55e0352` unchanged
  (`scripts/env-determinism.ts`, Mewtwo, seed 5, 240 s: fresh = fresh = reused process, 4,908 steps).
- New tests: every errand under its condition and its order; the ordered walk and the errand time-out; the shop
  revisit; waking through the horde; prizes before the portal; the swarm fought near the portal; the three stay rules
  (HP bar, heavy hit, horde damage) each on and off; a spent revive; the damage counter seeing a hit the HP bar does
  not; cashing on HP lost, not on the tide; slot, restock, seal and borrowed-move answers; the spawn estimate; plans
  by name, and that an overridden plan never writes into a default.
- `plan-1` reproduces phase 1 exactly (two seeds replayed, above).
- **Determinism:** batch g of the tuning (plan-2's settings given as overrides) and the gate batch (the same as
  defaults) are separate runs of the same play: all 30 episodes agree in KOs, bonus, level and game time.
- All 140 episodes of plan-2 stored in the main database ended without an error. One did not end as a run should:
  it stood in the sanctuary until the 7,200 s time cap (§6).

## 4. Sandbox and network isolation

Unchanged: everything ran through the headless environment with its network guard; no batch reports a blocked
request. Nothing was written under `mirror/` (the bundle was read to establish prices and odds). No browser, no
external service.

## 5. Performance measurements

- One episode of plan-2: about 2,900 s of game time (1,700 in phase 1) in about 690 s of wall time per process
  with 16 processes side by side on 18 cores (194 s in phase 1). A batch of 30 takes about 45 minutes at 8
  processes; the 50 held-out seeds took 64 minutes at 10.
- Expected, not measured: a run of leaderboard length (5,800 s) would take about twice that.

## 6. Results, limitations and unresolved questions

### Measured: tier 2, Mewtwo, forest, gate batches

| Batch (label) | Preset | Seeds | Median | Mean | p90 | Best | ≥ 1M | ≥ 5M | Reached Overtime | Rounds (mean / max) | Bonus cashed / lost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| random (phase 1) | unlocked-v3 | 1–30 | 133 | 258 | 447 | 2,122 | 0 | 0 | 0 | – | – |
| first heuristic (phase 1) | unlocked-v3 | 1–30 | 2,622 | 3,373 | 5,419 | 10,531 | 0 | 0 | 2 | 1.0 | 1 / 1 |
| plan-1, balanced (phase 1) | unlocked-v4:balanced | 1–30 | 99,159 | 95,208 | 163,291 | 208,029 | 0 | 0 | 16 | 5.3 | 15 / 1 |
| plan-1, balanced, fresh (phase 1) | unlocked-v4:balanced | 101–130 | 80,811 | 84,705 | 140,959 | 275,587 | 0 | 0 | 11 | 5.0 | 9 / 2 |
| plan-1, balanced, held-out (phase 1) | unlocked-v4:balanced | 900001–900050 | 71,181 | 86,224 | 148,079 | 269,223 | 0 | 0 | 24 | 4.3 | 24 / 0 |
| plan-2, empty archive (`tier2-mewtwo-h2p2-empty`) | unlocked-v4:empty | 1–30 | 1,257,546 | 1,727,622 | 3,826,436 | 4,521,974 | 18 | 0 | 30 | 10.9 / 17 | 30 / 0 |
| **plan-2, balanced** (`tier2-mewtwo-h2p2-balanced`) | unlocked-v4:balanced | 1–30 | **2,079,272** | 2,236,326 | 4,242,066 | 6,024,651 | 22 | 3 | **30** | 11.0 / 15 | 30 / 0 |
| plan-2, balanced, fresh (`fresh-tier2-mewtwo-h2p2-balanced`) | unlocked-v4:balanced | 101–130 | 1,242,148 | 1,871,651 | 4,666,919 | 6,436,518 | 17 | 3 | 29 | 10.5 / 17 | 29 / 0 |
| **plan-2, balanced, held-out** (`heldout-tier2-mewtwo-h2p2-balanced`) | unlocked-v4:balanced | 900001–900050 | **1,505,704** | 2,219,726 | 4,195,666 | **9,052,797** | 37 | 4 | **49** | 11.8 / 16 | 49 / 0 |

Score is KOs plus the cashed Overtime bonus. The held-out seeds were played once, with the plan already fixed.

- **Milestones:** 100,000 by every one of the 140 runs; 1 million by 37 of the 50 held-out runs; 5 million by 4 of
  them; 20 million by none.
- **Where runs end.** Seeds 1–30: all 30 cash Overtime. Fresh: 29 cash; one faints in zone 3's final swarm with
  811,120 KOs. Held-out: 49 cash; one (seed 900029) beats the legendary and then stands still 26 m from the portal
  until the time cap, with 798,464 KOs (it is counted with those). Traced: the Pokémon is wedged against a wall of
  the sanctuary and never counts as on the ground, so the first heuristic's movement code, which jumps when stuck
  only from the ground, keeps walking into the wall. Not fixed: it was found on a held-out seed, and the 60 runs on
  the other seeds do not show it.
- **Archive.** The balanced archive is worth 65 % on the median and 29 % on the mean of seeds 1–30 over no archive
  (in phase 1: a third on the median).
- **Seals:** 10 of 12 kept on average (`heal` is never taken). None was broken: 1,386 put on in the 140 runs, 1,386 kept.

### Measured: how plan-2 was arrived at (seeds 1–30, balanced archive, scratch databases)

| Batch | What it adds to the one before | Median | Mean | Best | Reached Overtime | Lost in a final swarm |
|---|---|---|---|---|---|---|
| plan-1 | | 99,159 | 95,208 | 208,029 | 16 | (ends before the swarm) |
| a | ordered walks, errands, seals, new answers; stay while the lowest HP of 20 s is over 80 % | 574,718 | 1,267,484 | 4,460,254 | 15 | 15 |
| b | swarm fought within 15 m of the portal; leave at a hit of 15 % of max HP | 1,482,852 | 1,738,857 | 4,595,333 | 24 | 6 |
| c | leave when the horde hits for half of max HP, cash at all of it (stopped after 11 seeds) | – | 496,888 | – | 11 of 11 | 0 |
| e | that rule only without a Max Revive; a spent Max Revive leaves | 1,284,045 | 1,593,155 | 4,187,033 | 30 | 0 |
| f | no cashing on the tide | 1,304,537 | 1,954,680 | 5,794,023 | 30 | 0 |
| **g** | no leaving on the HP bar's history (15 % hit, lowest HP): **plan-2** | **2,079,272** | 2,236,326 | 6,024,651 | 30 | 0 |
| h | f with errands across the whole map and three times the spending shares | 1,250,274 | 1,959,950 | 7,455,390 | 30 (1 bonus lost) | 0 |

- On the 11 seeds batch c played, batch b's mean is 1,245,038: leaving early cost 60 % of the score.
- The same seed can move by a factor of five between two batches (seed 2: 3.6M, 0.5M, 5.8M, 5.7M, 1.0M in b, c, f, g,
  h): any change in what is bought shifts every later item draw. Differences between batches are therefore read on
  the 30-seed median and mean, and h against f (mean 1.96M against 1.95M) is no difference.

### Measured: what was found on the way

- **Final swarms.** Enemy damage doubles about every 45 s once a final swarm begins (seed 16: 10 % of max HP a hit
  at its start, 56 % after 120 s, 4.8 times max HP after 256 s). A build that kills everything on arrival takes no
  hit at all until one lands that is several times its max HP; the HP bar reads full throughout. All 15 losses of
  batch a and all 6 of batch b are of this kind. The game's cap of 40 % of max HP a hit does not hold for every
  source of damage (single hits of 1,301 and 2,835 on a max HP of 254).
- **Overtime.** The best runs kill at the spawn ceiling from round 8 on (78,000 to 89,000 KOs a round against a
  ceiling of 94,500 at a spawn multiplier of 3; the estimate puts the mean run at 3.3 to 3.9 before the game's cap,
  mostly from Cursed Incense). They cash in rounds 12 to 16 when the HP bar falls.
- **Economy** (read in the bundle, used by the plan): a slot spin costs 40 × 2^(zone−1) × 1.08^spins; a paid Poké
  Ball rises about 37 % a ball from the thirteenth on; every shop purchase beyond 2 + (balls bought ÷ 3) multiplies
  all later shop prices by 1.15 to 2 by rarity. A run of plan-2 earns 1.6 million Pokédollars and spends a third of
  it on about 50 spins, 28 balls and 25 purchases; the rest has no outlet at those prices.

### What it means for 20 million

Measured, the mean run of the gate batch on seeds 1–30 at its end: level 792 after 2,885 s; max HP 674, armor 87,
healing ×1.48, lifesteal 0.098, regeneration 8.6 HP/s; damage ×9.6, special ×7.5, attack speed ×4.4, area ×3.0;
experience ×9.4, Pokédollars ×10.9, luck 139; 129 items, 10.0 seals kept; estimated spawn multiplier 3.5 before the
game's cap of 3. Overtime begins at 2,569 s with 656,245 KOs and lasts 11.0 rounds (at most 15); the mean KOs of a
round rise from 4,300 in round 1 to 46,800 in round 8.

- **Expected, from the Overtime model (`src/model/overtime.ts`, the game's own table):** at the spawn ceiling with
  10 seals the bonus is 4.6 million when cashed after round 12, 9.3 million after round 16, 15.5 million after round
  20, 19.2 million after round 22 and 23.3 million after round 24; the KOs themselves add 1.5 to 1.9 million, the
  zones 1 to 2 million. A 20 million run cashes after round 21 or 22 having killed at the ceiling throughout.
- **Expected, same model:** for a run that enters Overtime at 2,570 s (the mean here) the tide takes, with Dique,
  83 HP a second at the end of round 12, 331 at the end of round 16, 5,261 at the end of round 20 and 21,044 at the
  end of round 22. The runs here have a max HP of about 700 and cash in rounds 12 to 16, where the tide passes half
  of that a second. Round 22 needs a max HP of the order of the tide there: the leaderboard Mewtwo has 19,650.
- **Measured (phase 0 fixture against these runs):** that max HP comes from levels, 6,293 on the leaderboard against
  about 800 here, from an experience gain of ×44 against ×9 and a run of 96 minutes against 48. The leaderboard
  build's armor (471, a 91 % reduction, against 87 here, 66 %) is what lets it stay in final swarms until the
  collapse, where most of that experience is.

So the distance is no longer in getting to Overtime, which every run now does, nor in killing the horde there. It is
in the experience economy and in how long a final swarm can be held: more experience gain and armor early, and
with them longer stays. A heuristic can go some way on that (§7); the last factor of four is what the learner is for.

### Limitations and unresolved questions

- **Tuned on seeds 1–30, eight batches.** The fresh and the held-out seeds say how much of the gain carries over
  (table above).
- **The spread is wide.** Held-out: worst 382,096, 10th percentile 656,694, median 1.5 million, 90th percentile 4.2
  million, best 9.05 million. A run is made or lost by what its first two zones find; 1 of 50 held-out runs, 4 of 30
  fresh ones and 4 of 30 tuning ones stay under 500,000.
- **A stall** on one held-out seed (above). In training the environment's standing-still rule would end such an
  episode after 30 s; in these replays the rule is off.
- The stay rule rests on Max Revives being found (the run starts with one). A run without one leaves when the
  horde's hit reaches all of max HP; with one it stays until the revive is spent. Whether a limit between those
  pays was not tested.
- The spawn multiplier is an estimate from what the observation shows; the stat sheet's own figure is not in it.
- Why some sources of damage ignore the 40 % cap was not traced in the bundle.
- The valuation's weights are still phase 1's. Experience gain, max HP and armor are what the findings above say
  matter most, and they are not weighted for it; changing them changes the archive, which is a new preset version.
- Time: an episode now takes about 8 minutes of wall time, a full gate (140 episodes) over an hour.

## 7. Recommended next stage

Phase 2 (skills and a manager that copies this plan, then learns to deviate) can start from `plan-2`: it reaches
Overtime every time and its decisions are the ones the manager needs as a default (which errand, when to wake, when to
leave, when to cash). Three things would raise the default further and could come first or alongside:

1. **A build direction for the long run**: experience gain, max HP and armor weighted for what §6 found, with its
   own archive (preset `unlocked-v5`, compared against v4 on seeds 1–30).
2. **The stay limit as a function of the build**: how long past the first deadly hit a run with several Max Revives
   can stay, and the same question for Overtime.
3. **The remaining outlets and map services**: rifts (the zone clock stands still inside them, and their relics are
   what the leaderboard builds hold), the dojo, Bill's machine, altars by valuation.

The owner's call.
