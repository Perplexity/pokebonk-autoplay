# Phase 3 report, part 1: the reward, the warm start, and what was measured before any training

2026-11-26. Mewtwo, forest, tier 2, Ranked, build `mwsewi0r` (0.10.26), account preset `unlocked-v4:balanced`,
offline. **No PPO run has been made**: only a throughput measurement of 15,360 decisions in a scratch folder. This
part ends where the brief asks for agreement: the promotion metric and the budgets (§7). Sections are the
specification's seven. "Measured" figures were played headless; labels are those of `data/pokebonk.sqlite`.

**In one paragraph.** Reward v7 (the change of the root of the score, 5 for a run of 20 million) and its logarithm
twin are written and tested, also on 40 real episodes. The copy step now trains the value network too. Three things
were measured that change what phase 3 can be expected to show. The score of a run is very noisy (the same policy on
30 fresh seeds gives a median anywhere within ±30 %). The heuristic's figures on seeds 1–30 are a favourable draw: a
policy exactly as good as the heuristic, once it differs from it in any decision, beats them in about 1 trial in
1000. And sampled play, which is what PPO learns from, scores about half of what the heuristic does.

## 1. What was implemented

- **Reward v7** (`configs/reward-v7.yaml`, `python/pokebonk_rl/reward.py`; docs/training.md §3):
  - `score`: the change of `5 × sqrt(score / 20,000,000)`, score = KOs + the Overtime bonus as it stands; at the
    end, the evaluation's own score. Fainting in Overtime ends with a negative payment: the bonus part.
  - The smaller terms (map points, map uses, items, spending; earning; guardians, zones, the legendary, rifts) each
    saturate under a cap. The caps sum to 4.5 % of a 1-million run's return and keep decision 8's order; a
    configuration that breaks either is refused when it is loaded.
  - Penalties: fainting before the map is cleared (once), each sale in the shop (every time).
  - Nothing for healing, HP, time, damage or levels.
  - **One thing beyond the brief's words:** a run ended by a rule against standing still scores 0 in an evaluation,
    so v7 takes back everything `score` paid at that moment (v3 to v6 took a fixed 100 KOs).
- **Reward v7log** (`configs/reward-v7log.yaml`): the same with `log(1 + score / 10,000)`, 5 at 20 million too. The
  knee of 10,000 is my choice.
- **The value network's warm start** (`python/pokebonk_rl/bc.py`): `collect` stores the counters and flags a reward
  is computed from; `fit` computes the reward's returns of the heuristic with the trainer's own tracker and trains
  the value network on them; whole episodes are held back to measure it. `--policy-weight 0` leaves the policy as
  primed.
- **A prior against skills that cannot be taken back** (`manager.rare_actions`): `portal` and `wake` start 4 logits
  less likely than any other skill when the heuristic does not propose them, and as likely as any proposal when it
  does. Learnable like any weight.
- **Evaluation** prints median, mean, p90 and best; the promotion rule can hold floors under further metrics
  (`promotion.floors`). The metric agreed in §7 is configured in `configs/manager-evaluation.yaml`.
- `configs/manager.yaml`: reward v7, no running normalisation of rewards.

**Not done:** any PPO run; the comparison of sqrt against log; a promotion.

## 2. Files created or changed

| File | |
|---|---|
| `configs/reward-v7.yaml`, `reward-v7log.yaml` | new |
| `python/pokebonk_rl/reward.py` | v7 and v7log (v0 to v6 unchanged) |
| `python/pokebonk_rl/bc.py` | reward figures stored; `rewards_of`, `returns_of`; value network trained in `fit`; `--value-weight`, `--policy-weight` |
| `python/pokebonk_rl/manager.py`, `config.py` | `manager.rare_actions` |
| `python/pokebonk_rl/evaluate.py` | p90, best; `promotion.floors` |
| `configs/manager.yaml`, `manager-evaluation.yaml`, `evaluation.yaml` | reward v7; `rare_actions`; `floors` |
| `python/tests/test_units.py`, `test_game.py` | tests |
| `docs/training.md` §3, `docs/hybrid.md` §5 and §6, this report | |

No TypeScript file changed in this part.

## 3. Tests run and results

- `python -m pytest`: **48 pass** (44 before). `npm test`: **194 pass**. `npx tsc --noEmit`: clean.
  `export-encoding --check`: identical.
- New: the payments of v7 add up to the root of the final score, in one step or in many; cashing beats fainting at
  the same bonus; one more round then fainting is worth less than cashing now; the bonus part is taken back; an
  invalid run sums to 0; nothing for healing; the smaller terms stay under 5 % at a hundred times the heuristic's
  counts and keep the order; selling costs every time; configurations that break a rule are refused; v7log adds up
  too; the evaluation's p90 and floors; the prior on `portal` and `wake`.
- With the game: on two real episodes the stored figures give payments that add up, for v7 and v7log; the value
  network is trained and the model starts a PPO run.
- **On 40 real whole episodes** (`data/bc/plan3-v7`): the `score` payments equal the transform of the final score in
  40 of 40, for both versions.
- Not tested: what v7 does to learning. No training was run.

## 4. Sandbox and network isolation

Unchanged: headless, offline, nothing written under `mirror/`, no blocked request reported.

## 5. Performance measurements

- **PPO throughput**: 61 decisions a second, updates included, over the first three updates of ten fresh episodes
  (10 game processes + 2 spares, 5,120 decisions an update). Over whole episodes the ten processes advance in step
  and late hordes are slow: the copy data came in at **38 decisions a second, 43 episodes an hour** (128,961
  decisions in 3,388 s). About 3.3 million decisions or 1,000 episodes a day. The runner alone, not in step, plays
  67 episodes an hour.
- **Copy data**: 40 episodes, 128,961 decisions, 52 MB.
- **Value fit**: 6 s a pass.

## 6. Results, limitations and unresolved questions

### Measured: what v7 pays the heuristic

| Episodes | Return, mean | Median | Best | Smaller terms, mean (max) |
|---|---|---|---|---|
| seeds 1–30 | 1.65 | 1.65 | 3.01 | 2.2 % (3.3 %) of a 1-million run's return |
| held-out 50 | 1.56 | 1.40 | 3.40 | 2.2 % (3.2 %) |

Discounted with the 1000 s horizon, the return from a decision is 0.35 ± 0.16 over the 128,961 stored decisions.

### Measured: the value network does not generalise from 36 episodes

- Trained 12 passes: explained variance 0.99 on training episodes, 0.02 on the 4 held back. It memorises episodes.
- A least-squares fit on nine plain figures (time, KOs, bonus) does no better on the held-back episodes (−0.29).
- So most of what the return from a state will be is decided by what the rest of that episode brings, and 36
  episodes do not teach it. Stopped after 3 passes: it predicts about the mean (error 0.124, 0.235 before).
- What it means: PPO starts with a value estimate without bias but without insight. It will have to learn it from
  its own episodes, about 1,000 a day.

### Measured: the score of a run is very noisy

The heuristic (plan-3), one episode per process, on three sets of seeds:

| Seeds | n | Median | Mean | p90 | Best |
|---|---|---|---|---|---|
| 1–30 (the seeds the plans and the archive were chosen on) | 30 | 2,127,158 | 2,438,325 | 5,241,253 | 7,069,176 |
| held-out 900001–900050 | 50 | 1,528,620 | 2,114,671 | 4,034,675 | 9,052,797 |
| 1000000–1000039 (the copy data) | 40 | 1,174,675 | 1,508,616 | 3,036,749 | 6,823,205 |

- The standard deviation of a score is 0.7 to 0.8 of its mean.
- Resampling the 90 episodes on seeds the heuristic was never tuned on: the median of 30 runs of the same policy
  lies within ±30 % (95 %), of 50 runs ±22 %, of 100 runs ±15 %. The p90 is as wide.
- **Seeds 1–30 are a favourable draw.** The chance that 30 fresh runs of the heuristic reach its own median on
  seeds 1–30 is 0.9 %; both its median and its p90, 0.1 %.
- **A seed does not pair runs once play differs.** Five seeds played with 10 % random skill choices and five with
  10 % random dialog answers: the scores bear no relation to the heuristic's on the same seed (seed 4: 1.09 million
  for the heuristic, 4.54 million with random skills, 0.06 million with random dialog answers).
- **What it means for the gate as written** ("beat the phase 1 heuristic on median and p90", seeds 1–30): a policy
  exactly as good as the heuristic passes in about 1 trial in 1000; one 1.5 times as good in 19 %; one twice as
  good in 93 %. The gate measures the draw more than the policy.
- **20 million.** With every score of the heuristic doubled, no run of 20 million in 50; tripled, at least one in
  67 % of trials.

### Measured: sampled play costs about half (corrected in part 2: it costs far less)

**Correction, 2026-11-26.** The ten seeds below were too few. The 305 sampled episodes of the two short runs
(part 2) score a median 23 % and a mean 12 % under the heuristic's on untuned seeds, with the same p90. "About
half" was wrong.

PPO learns from sampled play. The start model's most probable action is the heuristic's (agreement 1.0000 on 13,209
held-back decisions); sampled, on seeds 1–10 (the heuristic there: median 1,244,430, mean 1,733,565):

| Start model | Share of decisions that are not the proposal | Median | Mean | Overtime rounds |
|---|---|---|---|---|
| the heuristic | 0 | 1,244,430 | 1,733,565 | 9.9 |
| logit 7 | 1.6 % | 886,056 | 923,846 | 8.5 |
| logit 6 | 4.1 % | 859,986 | 1,313,455 | 7.7 |
| logit 5 | 10.4 % | 604,773 | 691,089 | 6.5 |
| logit 6, `portal` and `wake` rare | 3.9 % | 651,614 | 916,756 | 7.4 |
| logit 5, `portal` and `wake` rare | 9.9 % | 516,736 | 694,630 | 6.4 |

- All five are below the heuristic, by a third to a half. Ten seeds cannot order them among themselves.
- **My first explanation was wrong.** I took the loss for sampled `portal` skills cashing Overtime early and added
  the prior against them. It changed nothing measurable. The prior stays (an unproposed `portal` is still
  irreversible) but it is not the cause.
- What the traces show instead: single events that end or cripple a run (one run ended as a victory without
  Overtime, one was ended by the standing-still rule at 498,749 KOs), random dialog answers that weaken the build
  (level-ups skipped, found items sold, shops left), and the fresh draw of everything after.
- Not measured: which kind of deviation costs how much. With this noise that needs about 100 episodes a condition.

### Limitations and unresolved questions

- **The manager cannot try "one more Overtime round" by chance.** When the heuristic decides to cash, it proposes
  the portal every second; staying a round longer means overriding it some 40 times in a row. PPO can only get
  there by many small steps.
- **Expectation, not measured:** with about 1,000 episodes a day and this noise, PPO can learn what shows within
  seconds (which skill makes more KOs now). What shows only in the final score (an item's worth, when to cash)
  needs effects much larger than the noise or far more episodes. I expect a first run of a few million decisions
  to end close to the heuristic, more likely a little below than above.
- The collection seeds are also the first seeds a PPO run plays (1000000 onwards).
- The copy of the heuristic was not played on the held-out seeds under the rules (on seeds 1–30 it equals the
  heuristic in 30 of 30).

## 7. Recommended next stage: to agree before any PPO run

1. **What the gate is measured on.** My recommendation: a development set of 100 seeds the heuristic was not tuned
   on (2000001–2000100), the heuristic played on them once as the reference (about 90 minutes), and the gate read
   there at the end of the budget. Regular evaluations during training stay on seeds 1–30 as the brief says, read
   as a trend. The alternative is the gate as written, on seeds 1–30, which only a policy about twice as good
   passes.
2. **The promotion metric**, on the 50 held-out seeds against `heldout-tier2-mewtwo-h2p3-balanced-fresh`: p90 at
   least the reference's and median at least 90 % of the reference's. Under the measured noise a policy as good as
   the heuristic passes in 8 % of trials, one 1.25 times as good in 86 %, one 1.5 times as good in 99 %.
3. **Budgets.**
   - sqrt against log: 500,000 decisions each (about 3.7 hours each), same start, then seeds 1–30 for both (about
     half an hour each). About 8.5 hours in all. At this size I expect the difference to be inside the noise; if it
     is, sqrt stays, as the brief's choice.
   - The long run: 5 million decisions (about a day and a half), seeds 1–30 every 1 million, the gate at the end.
4. **First settings of the run** (mine to set, listed for the record): start at logit 6 with the prior on `portal`
   and `wake`; penalty for straying 0.0005 a decision, fading to zero over the first half; 10 game processes + 2
   spares under `caffeinate -i`.

### Agreed with the owner, 2026-11-26

1. **The gate** is read on 100 development seeds the heuristic was not tuned on, 2000001–2000100, against the
   heuristic played on them once. Seeds 1–30 stay the regular check during training, read as a trend. The held-out
   seeds stay untouched.
2. **The promotion metric**: p90 at least the reference's and median at least 90 % of it, on the 50 held-out seeds
   (configured: `promotion.metric: score_p90`, `min_ratio: 1.0`, `floors: {score_median: 0.9}`).
3. **Budget**: the two short runs first (sqrt against log, 500,000 decisions each, then seeds 1–30 for both), then a
   report. The long run is decided after it, not before.
4. The taking back of what `score` paid when a rule against standing still ends a run stays in v7.


---

# Part 2: the two short runs (sqrt against log)

2026-11-26. Two PPO runs of 501,760 decisions each (98 updates of 5,120), 10 game processes + 2 spares, the same
priming (logit 6, `portal` and `wake` rare), the same episode seeds from 1000000 on, the penalty for straying 0.0005
a decision fading to zero over the first 250,000. `manager-v7-sqrt-01` under v7, `manager-v7-log-01` under v7log
(its value network fitted on v7log's returns). Then both on seeds 1–30, most probable action.

**In one paragraph.** Neither run changed a single choice of the heuristic: both models play seeds 1–30 exactly as
the heuristic does, 30 of 30. The comparison of sqrt against log is therefore a tie, and v7 (sqrt) stays, as the
brief's choice. The policies did move, but not far enough to change the most probable action anywhere, and the two
runs moved in unrelated directions: there is no sign yet that what moved was learned and not noise.

## Measured

**Seeds 1–30, most probable action** (batches 52 and 53, against batch 32):

| | Median | Mean | p90 | Best | Episodes equal to the heuristic's |
|---|---|---|---|---|---|
| the heuristic | 2,127,158 | 2,438,325 | 5,241,253 | 7,069,176 | |
| after 500k decisions, sqrt | 2,127,158 | 2,438,325 | 5,241,253 | 7,069,176 | 30 of 30 |
| after 500k decisions, log | 2,127,158 | 2,438,325 | 5,241,253 | 7,069,176 | 30 of 30 |

**The training episodes themselves** (sampled play, seeds 1000000 on; a run ended by an idle rule scores 0):

| | n | Median | Mean | p90 | Best | Overtime rounds |
|---|---|---|---|---|---|---|
| sqrt, all | 155 | 1,009,577 | 1,633,770 | 3,646,257 | 9,865,443 | 10.3 |
| sqrt, first half / second half | 77 / 78 | 1,031,189 / 907,614 | 1,772,775 / 1,496,548 | | | 10.5 / 10.0 |
| log, all | 150 | 1,021,961 | 1,629,589 | 3,702,641 | 7,247,611 | 10.3 |
| log, first half / second half | 75 / 75 | 935,568 / 1,152,574 | 1,556,289 / 1,702,890 | | | 10.0 / 10.6 |
| the heuristic, 90 episodes on untuned seeds | 90 | 1,319,398 | 1,845,313 | 3,740,033 | 9,052,797 | |
| the heuristic, seeds 1000000–39 | 40 | 1,174,675 | 1,508,616 | 3,036,749 | 6,823,205 | |
| sqrt / log on those 40 seeds | 40 | 1,008,918 / 862,440 | 1,542,143 / 1,410,796 | 2,946,356 / 3,111,439 | | |

- No trend within either run that the noise would not give (halves differ by 12 to 23 % in opposite directions).
- Of the 305 episodes: 291 cashed Overtime, 6 lost it by fainting, 4 fainted before it, 2 left without it, 2 were
  ended by the no-KO rule.
- 500,000 decisions are about 150 episodes (3,300 decisions an episode), 3.5 hours a run.

**How far the policies moved**, read on 30,000 stored decisions of the heuristic:

| | Most probable action = the proposal | Probability of the proposal | Lead of the proposal over the next action, in logits: median (smallest) |
|---|---|---|---|
| start | 1.0000 | 0.962 | 6.0 (6.0) |
| after sqrt | 1.0000 | 0.949 | 4.9 (1.6) |
| after log | 1.0000 | 0.931 | 4.5 (2.4) |

- The share of sampled decisions that are not the proposal rose from 3.7 % to 4.4 % (sqrt) and from 4.2 % to 5.3 %
  (log).
- **The two runs do not agree on what to prefer.** Over the 42 actions offered 300 times or more, the change of
  an action's logit against the proposal correlates −0.13 between the runs. Both raised `use:altar` (+1.3, +1.0)
  and `use:challenge`, both lowered `skill:retreat`, `use:berry` and `skill:farm`; the rest go in opposite
  directions (`use:rhydon` +2.6 and +0.1, `use:nest` −0.6 and +1.6, `use:cursedchest` −1.5 and +0.2).

## What it means

- **The gate.** At this budget the manager does not beat the heuristic on median and p90: it equals it. By the
  brief that is a stop, with the reason:
  1. *The start is 6 logits from any change of play, and the learner moves about 1 to 1.5 logits in 150 episodes.*
     That is my setting (priming at logit 6, learning rate 1e-4, clip 0.1), chosen so that sampled play stays close
     to the heuristic. It makes the most probable action change late or never.
  2. *What did move shows no common direction.* With one run under each reward I cannot separate "the two rewards
     teach different things" from "both are noise". Nothing measured here says the movement is learning.
- **sqrt against log**: no difference that can be measured. v7 stays.
- **Not tested**: the trained models sampled on fixed seeds; a second run under the same reward (which would tell
  noise from signal); a higher learning rate.

## Where a score three times as high would come from (from earlier measurements, not new ones)

- The Overtime multiplier rises by 1 a round from round 7 (docs/game-mechanics.md). At the same KOs a round, the
  bonus after 20 rounds is about three times the bonus after 12 (3.3 times without seals, 3.0 with ten kept).
- The heuristic's best runs already kill at the spawn ceiling from round 8 and cash in rounds 12 to 16 when the HP
  bar falls (phase 1b). Its mean is 11.4 rounds on seeds 1–30.
- So the lever is rounds survived in Overtime, and behind it the build's HP and healing against the tide and the
  horde. Phase 0 measured 16.5 million from Overtime alone with a leaderboard build's stats over 20 rounds.
- The manager can reach that lever only through hundreds of dialog answers whose worth shows in the final score,
  the signal PPO has least of (about 1,000 episodes a day, each ±75 %).
- **Not measured:** what takes the HP in the rounds before the heuristic cashes: the tide (no dodging helps, only
  HP and healing) or hits (positioning helps: phase 4's subject).

## Recommended next stage

1. **Do not start the 5 million decision run as configured.** I expect it to flip some choices, with no evidence
   yet that the flips would be the right ones, and no path to three times the score.
2. **Measure what ends Overtime for the heuristic** (about an hour: the heuristic on seeds 1–30 with HP lost per
   round split into tide and hits, and HP, healing and the round it cashes). It decides between phase 4 (a dodging
   and positioning policy) and build work.
3. If PPO over the manager is to be continued, first a second sqrt run from the same start (3.5 hours) to see
   whether two runs under one reward agree. If they do not, more decisions of the same will not help.

The heuristic's reference on the 100 development seeds (2000001–2000100) is being played (label
`dev100-tier2-mewtwo-h2p3-balanced-fresh`).


---

# Part 3: what ends Overtime for the heuristic

2026-11-26. No training. Stored run records of the heuristic's reference batches (30 runs on seeds 1–30, 50 on the
held-out seeds, all cashed), and two whole runs traced round by round (seeds 1 and 23; both reproduce their stored
run to the KO). **This corrects part 2**, which named "rounds survived" as the lever.

**In one paragraph.** Hits do not end Overtime: the traced runs take none while they still kill. The kill rate
falls first, because enemy HP outgrows the build's damage; then the tide, which nothing dodges, outgrows the
healing and the heuristic cashes. Neither a dodging policy (phase 4) nor a later cash-out can reach 20 million with
these builds: with both the kill rate and the survival made perfect on paper, the best of the 80 runs is 17.7
million. The gap to a 20 million run is the build that arrives at Overtime.

## Measured

**KOs a round fall long before the run cashes** (80 stored runs; the game's bonus formula reproduces every stored
bonus exactly):

- The best round is round 8 (median); the runs play 13 rounds (median). The last whole round has a third of the
  best round's KOs (median); under a quarter in 32 of 80.
- Against the spawn ceiling of phase 0 (94,500 a round from round 10), the median run kills 53 to 64 % in rounds 7
  to 9 on seeds 1–30 (about 30 % on the held-out seeds), then 13 % in round 12 and 8 % in round 14.

**Two traced runs:**

| | Seed 1 (score 2.03 million) | Seed 23 (score 7.07 million, the best of seeds 1–30) |
|---|---|---|
| KOs by round | 54,719 in round 8, then 10,880, 9,415, 5,140, 3,086 | 92,698 in round 10 (98 % of the ceiling), then 87,605, 67,398, 52,074, 31,289 |
| Enemies alive | 237 in round 8, 332 to 347 after | 109 in round 9, rising to 298 in round 14 |
| Hits taken in Overtime | none in rounds 1 to 8, 79 in rounds 9 to 13 | 1 |
| HP bar | 89 % or more until the last round | 90 % or more until the last round |
| Tide, in HP bars a round | 0.55 in round 8, 2.2 in round 12 | 0.75 in round 8, 5.9 in round 14 (×1.41 a round) |
| Healed, in HP bars a round | equal to what was taken until the last round | the same |
| Cashed | round 13, HP 73 %, tide 10 % of max HP a second | round 15, half the bar lost in 4 s, tide 26 % a second |

**What two changes would be worth, on paper** (same runs, the game's formula; not played):

| | Seeds 1–30: median / best | Held-out: median / best | Runs of 20 million |
|---|---|---|---|
| as played | 2.13 M / 7.07 M | 1.53 M / 9.05 M | 0 |
| A: KOs a round never fall below the run's best round, same cash time | 3.32 M / 9.80 M | 2.27 M / 11.0 M | 0 |
| B: as played, then on to the end of round 20 at the last round's rate | 4.09 M / 11.5 M | 3.31 M / 14.3 M | 0 |
| A and B together | 9.35 M / 17.7 M | 5.12 M / 17.6 M | 0 |

**The build that arrives** (final builds of the 80 runs against the leaderboard Mewtwo of phase 0 §6.7):

| | The heuristic, median (highest) | Leaderboard run |
|---|---|---|
| Run length | 49 min (58) | 96 min |
| Level | 794 (1,551) | 6,293 |
| Items held | 128 (171) | 313 |
| KOs before the bonus | 0.92 M (2.13 M) | 6.5 M |
| Damage × | 9.5 (19.1) | 152 |
| Special × | 7.5 (13.0) | 50.5 |
| Attack speed × | 4.7 (14.8) | 15.6 |
| Area × | 2.7 (8.7) | 76 |
| Max HP | 678 (1,176) | 19,650 |
| Healing × | 1.55 (2.6) | 15.7 |

Over the 80 runs the score follows the run's length (rank correlation +0.81), items held (+0.65) and level (+0.62).

## What it means

- **Phase 4 is not needed and would not help.** Its condition is "if Overtime deaths are the limit". No run of the
  heuristic dies in Overtime, and the HP it loses there is the tide's, which positioning cannot avoid.
- **A better cash rule or more rounds alone is worth about a factor of two** (row B), and less in play: the tide
  grows by 41 % a round while healing, which comes from kills, falls with the kill rate.
- **20 million needs a build several times stronger at the start of Overtime**: one that still kills at the
  ceiling in rounds 18 to 22 and heals through that tide. The leaderboard run gets it from 96 minutes, 6,300
  levels and 313 items; the heuristic arrives after 43 minutes with 800 levels and 128 items.
- **PPO near the heuristic cannot close that gap** by small deviations. It is a different plan for the 45 minutes
  before Overtime (how long to stay in each zone, experience gain as a stat, an economy that can be spent), which
  phase 0 §6.7 listed for the owner to decide and phase 1b only began (its plans leave a zone's final swarm after
  about 1,060 s because enemy damage there doubles every 45 s).
- Not measured here: why the kill rate falls so abruptly in seed 1 (one round) and gradually in seed 23; how the
  leaderboard builds survive long final swarms; whether any of it can be done within the heuristic's survival.

## Recommended next stage

A measured study of the long run before any more training, in the manner of phase 0's probes: with a handed-out
build, how long each zone's final swarm can be held and what a minute of it yields in levels, items and
Pokédollars; then a plan-4 of the heuristic that stays for it, tuned on seeds 1–30. The manager and reward v7 stay
as they are for the day the default plan is strong enough for deviations from it to matter.
