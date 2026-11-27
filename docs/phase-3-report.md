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


---

# Part 4: what the build needs, and a first plan built on it (plan-5)

2026-11-27. No training. The study part 3 recommended, as far as it has got. Everything marked **cheat** is a
probe in the manner of phase 0: the real game and the phase 1 heuristic, with a stat of the build multiplied from
the first second of the run; never training, never evaluation, nothing stored in the database. The probe without a
multiplier reproduces the stored runs of seeds 1, 7 and 23 to the KO.

**In one paragraph.** Luck, experience and Pokédollars are what the score follows; armor and healing are worth
nothing to the heuristic as it plays. With luck, experience, Pokédollars and damage raised together the heuristic
scores a median of 14.0 million and kills at the spawn ceiling until it cashes in round 18. The heuristic's item
valuation had it the other way round. A valuation with the measured weights, **without any cheat**, raises the
median on seeds 1–30 from 2.13 to 5.73 million (plan-5), and on 100 seeds that were never used to choose
anything from 1.47 to 4.82 million.

## Measured

**A zone, minute by minute** (seeds 1 and 23 traced):

- Before the final swarm (zone clock under 600 s) a minute gives at most 17,000 KOs and 27 levels. In the
  final swarm it gives 26,000 to 108,000 KOs and 45 to 90 levels; 108,600 KOs a minute is the swarm's ceiling
  (seed 23, zone 3, four minutes in a row).
- The heuristic holds a swarm 3 to 7 minutes and takes no hit in it. It leaves when the enemies' HP has outgrown its
  damage: the number alive rises from about 100 to 600 and more, the KOs of a minute fall, and one hit of the
  horde, 0.2 to 0.3 of the HP bar in the swarm's first minute, would take 1 to 46 bars by the time it leaves. The
  same thing as in Overtime.
- **Correction:** an interim note said the heuristic leaves zone 1 before the swarm. That read the record's
  `splits` as zone exits; they are the times the guardians fell.

**Experience** (read in the bundle): a level costs `8 + 5.5 L + L^1.8` experience, so the level grows with the
total experience to the power 0.36: five times the experience is 1.8 times the levels. A level with nothing left to
offer (Training) heals 20 % of max HP and adds a small permanent stat.

**One stat multiplied, seeds 1–30, cheat.** "Seed by seed" is the mean ratio of the score to the heuristic's own
score on the same seed (geometric), with a 95 % range from resampling the seeds:

| Stat | Median | Mean | p90 | Best | ≥ 5 M | Seed by seed |
|---|---|---|---|---|---|---|
| none (the heuristic, batch 32) | 2,127,158 | 2,438,325 | 5,241,253 | 7,069,176 | 4 | |
| luck ×3 | 7,469,516 | 6,646,165 | 9,601,637 | 11,464,602 | 22 | ×2.82 (1.85 to 4.20), better on 26 |
| experience ×5 | 4,835,202 | 4,837,811 | 7,568,871 | 8,997,542 | 15 | ×2.40 (1.83 to 3.19), 27 |
| Pokédollars ×5 | 5,230,653 | 4,601,201 | 8,546,316 | 10,273,072 | 16 | ×1.78 (1.31 to 2.40), 22 |
| damage ×10 | 5,221,722 | 4,350,860 | 7,649,002 | 9,059,138 | 15 | ×1.52 (0.90 to 2.43), 20 |
| armor ×3 | 1,815,064 | 2,134,706 | 3,594,876 | 6,709,881 | 1 | ×0.99 (0.77 to 1.28), 11 |
| healing ×5 | 2,258,117 | 2,344,809 | 3,909,676 | 9,212,879 | 2 | ×0.91 (0.66 to 1.24), 15 |
| luck ×3 and experience ×5 | 9,076,060 | 8,870,610 | 11,690,917 | 13,175,905 | 28 | ×4.59 (3.45 to 6.14), 29 |
| luck ×3, experience ×5, Pokédollars ×5, damage ×10 | 14,004,486 | 13,505,776 | 14,655,060 | 15,345,339 | 30 | ×7.53 (5.57 to 10.43), 30 |

- The leaderboard Mewtwo of phase 0 has luck 944 against the heuristic's 150, experience ×44 against ×9 and
  Pokédollars ×55 against ×7.6: the three stats that pay here.
- With all four raised the runs last 62 minutes, reach level 2,380, stay in every zone until the plan's own limit
  (1,060 s) and kill at the Overtime ceiling (94,500 a round) from round 10 until they cash in round 18 or 19. No
  run reaches 20 million. By phase 0's table the ceiling pays 15.5 million of bonus after round 20 and 19.2 after
  round 22: two to four more rounds at the ceiling. **Expected, not measured:** what is missing then is surviving
  the tide of those rounds, and zone time beyond the plan's limit.
- **Not valid: max HP.** Two attempts to multiply max HP failed as measurements: the game adds only the unmultiplied
  amount of HP when max HP grows, the bar stands nearly empty and the heuristic plays as if dying (23 of 30 runs
  fainted). Discarded. Nothing here says what max HP is worth.
- Three single cheated runs I looked at before the arms were played pointed the other way for experience (two of
  three scored lower). One run says nothing at this noise; the 30-seed arm is the measurement.

**The valuation's weights against what was measured.** The first direction (`special-sustain-1`) gives damage 1,
healing 0.7, armor 0.8 a point, experience 0.8, Pokédollars 0.45, luck 0.25 a point. Measured as the gain in
log-score per unit, with damage as the yardstick: luck about 1.2 a point, experience 1.7, Pokédollars 1.5, armor and
healing about 0.

**plan-5: plan-3 with the second direction** (`luck-experience-1`: damage as before; luck 1.2, experience 1.7,
Pokédollars 1.5; armor, healing, regeneration, lifesteal, evasion and overheal at a fifth to a quarter; max HP a
little lower; a second life as before). No cheat, the same account preset and item archive (the two directions
archive the same items but for five), seeds 1–30, one episode per process, rules off as the reference:

| | Median | Mean | p90 | Best | ≥ 1 M | ≥ 5 M | Level | Luck | Experience × | Pokédollars × |
|---|---|---|---|---|---|---|---|---|---|---|
| plan-3 (batch 32) | 2,127,158 | 2,438,325 | 5,241,253 | 7,069,176 | 24 | 4 | 817 | 149 | 8.9 | 7.2 |
| plan-5 (batch 55) | 5,732,607 | 5,467,547 | 8,357,433 | 10,479,709 | 29 | 18 | 1,076 | 343 | 12.3 | 14.6 |

- Seed by seed ×2.51 (1.64 to 3.87), better on 24 of 30.
- 29 of 30 cashed Overtime. **One run (seed 9) did not end**: it reached the sanctuary and played to the 7,200 s
  cap without starting Overtime (561,881 KOs). Under the evaluation's rules it would score 0.
- Its damage did not fall for it (×15.1 against ×9.1): more luck brings better rarities of everything.
- **These are the seeds the weights were measured on.** The check on seeds they were not:

**The 100 development seeds** (2000001–2000100, never used to choose anything; one episode per process, rules off):

| | Median | Mean | p90 | Best | Worst | ≥ 1 M | ≥ 5 M | Level | Minutes | Overtime rounds |
|---|---|---|---|---|---|---|---|---|---|---|
| plan-3 (batch 54) | 1,465,290 | 1,964,935 | 4,158,466 | 8,031,427 | 92,527 | 69 | 8 | 825 | 47.7 | 11 |
| plan-5 (batch 56) | 4,821,770 | 4,622,592 | 8,287,315 | 11,201,881 | 133,459 | 85 | 46 | 1,071 | 52.4 | 14 |

- Seed by seed ×2.20 (1.72 to 2.80), better on 75 of 100. No run of 20 million.
- 99 of 100 cashed Overtime; one fainted in it and lost the bonus (seed 2000022, 1,050,386 KOs kept).
- The gain on seeds 1–30 (×2.51) was not a fit to those seeds.

**The run that stood still (seed 9), found and fixed.** In its second phase the legendary raises three walls of
roots, each 10 m wide, 21 m from the shrine; they are solid and stay standing when it falls (read in the bundle:
only the brambles and spores are removed at the victory). The run stood directly behind one with the portal 10 m
beyond it. Every heading with a step towards the portal read as blocked, standing still scored best, and it stood
there for 74 minutes. Checked in play: walking straight at the portal does not move it, walking away does; the
environment's route planner does not know the roots and gives the straight line. It is probably not of plan-5 alone: one run in
each of two cheat arms also played to the time cap, and phase 1b's held-out seed 900029 ("stands still 26 m from
the portal") reads like it. Those were not traced.
- **Fix** (`src/bot/brain/movement.ts`): a forced goal out of reach is not waited for. After two seconds of standing
  in front of it the bot walks round, well to one side and a little away, the other side each time. With a test
  that reproduces the standing and the way round.
- **Checked in play, seeds 1–30 again with the fix.** plan-3 (batch 58): all 30 runs identical to batch 32, to the
  KO. plan-5 (batch 57): 28 of 30 identical to batch 55; seed 9 now cashes Overtime (3,809,040); seed 7 took the
  new rule once and went another way (6,526,524 against 8,216,550). plan-5 with the fix: median 5,732,607, mean
  5,519,452, p90 8,265,300, best 10,479,709; 30 of 30 cash Overtime, 30 reach 1 million, 18 reach 5 million.

## What it means

- **The default plan can be made about three times as good without any learning**, by valuing what the score
  follows. plan-5 is that for the item valuation alone.
- **20 million is still a factor of two beyond its best run** (11.2 million). The cheat arms say where the rest is:
  the same three stats further up (with all four levers the median is 14 million), then two to four more Overtime
  rounds at the ceiling.
- **The manager is still a copy of plan-3.** Making plan-5 the default means collecting the copy data again and
  fitting a new start model (about two hours); the observation, the action table and the reward do not change.

## Limitations and unresolved questions

- The weights of the second direction were set from six single-stat arms, by hand, once. No second setting was
  tried: stronger or weaker weights may do better.
- Max HP was not measured (above). Attack speed, area, crit and the spawn stats were not played as arms.
- The cheat arms multiply a stat from the first second; a real build earns it over the run. The honest gain (×2.2
  to ×2.5) is the measurement; the arms only said where to look.
- plan-5 was not played on the held-out seeds: they are kept for a candidate that could reach 20 million.
- The fainting in Overtime on development seed 2000022 was not looked into.
- The account preset is unchanged (`unlocked-v4:balanced`, its archive made with the first direction). An archive
  made with the second direction would be a new preset version and was not tried.

## Recommended next stage

1. More of the same, each as one batch on seeds 1–30 and the survivors on the development seeds: where the
   Pokédollars go (the plan spends a third of what it earns; the money arm paid ×1.8), how long a zone is held,
   the cash rule in Overtime, and the weights of the direction themselves.
2. Then an archive made with the second direction (preset `unlocked-v5`, the old one kept).
3. Then plan-5 or its successor as the manager's default, a new copy, and PPO only if the gate of part 2 can be
   met on the development seeds.


---

# Part 5: plan-6 and an item archive that stacks

2026-11-27. No training, no cheat. Every batch: tier 2, Mewtwo, forest, one episode per process, rules off as the
references. "Seed by seed" as in part 4.

**In one paragraph.** A smaller item pool that keeps what can be held ten times (`stack-2`), a later cash-out and a
later leave make plan-6. On the 100 development seeds its median is 7.43 million against plan-3's 1.47 and plan-5's
4.82; 86 runs of 100 pass 5 million. The best run is 10.9 million: the top has not moved since plan-5. Every run now
stops at the same wall, the enemies' HP in Overtime rounds 13 to 16.

## Measured

**Single changes to plan-5, seeds 1–30** (against plan-5 on the same pool, batch 57 or 65):

| Change | Median | Mean | p90 | Best | Seed by seed |
|---|---|---|---|---|---|
| plan-5, pool `balanced` (batch 57) | 5,732,607 | 5,519,452 | 8,265,300 | 10,479,709 | |
| three times the spending shares (slots, restocks) | 6,370,536 | 6,009,663 | 8,455,200 | 9,771,746 | ×1.10 (0.83 to 1.44) |
| zone limit 1,300 s for 1,060 s | 5,801,962 | 5,625,763 | 8,326,505 | 10,564,270 | ×1.04 (1.00 to 1.09) |
| luck, experience, Pokédollar weights doubled again | 5,998,630 | 5,939,815 | 8,739,558 | 10,303,672 | ×1.11 (0.92 to 1.35) |
| cash under 50 % HP, 80 % lost in 4 s | 5,903,039 | 5,780,796 | 8,349,195 | 11,157,242 | ×1.08 (1.02 to 1.17) |
| cash under 30 % HP, no loss rule | 5,981,208 | 5,908,198 | 8,994,898 | 11,378,722 | ×1.10 (1.03 to 1.19) |
| pool `narrow` (57 items out, by the first direction) | 5,402,411 | 5,136,605 | 8,958,332 | 9,788,217 | ×0.75 (0.51 to 1.09) |
| pool `balanced-2` (40 out, by the second direction) | 4,832,448 | 4,671,143 | 7,324,898 | 9,757,771 | ×0.84 (0.63 to 1.12) |
| **pool `stack-2`** (105 out: batch 65) | 6,715,430 | 6,179,225 | 7,941,530 | 9,739,369 | ×1.20 (0.91 to 1.56) |
| `stack-2` and fusing two moves at level 10 (all 30 fused) | 4,783,630 | 4,855,447 | 8,600,966 | 10,289,904 | ×0.74 (0.57 to 1.00) of batch 65 |
| `stack-2` and cash under 30 % HP | 7,053,472 | 6,735,386 | 9,059,141 | 10,518,079 | ×1.13 (1.06 to 1.27) of batch 65, better on 29 |
| `stack-2` and leaving a cleared zone under 40 % HP | 7,100,940 | 6,748,294 | 8,493,006 | 9,878,260 | ×1.10 (1.04 to 1.19) of batch 65 |

- **`stack-2`** takes as many items out of the pool as the account has archive slots (105 of 142), the ones that
  cannot be stacked without limit first. What a run then holds: 153 items of 35 kinds against 142 of 70; 8.5 Comet
  Shards against 1.9, 10 Exp. Shares against 2.7, 10 Star Pieces against 1.7. Luck 811 against 343, experience ×25.9
  against ×12.3, Pokédollars ×31.4 against ×14.8, damage ×23.5 against ×15.1, level 1,435 against 1,076. The
  leaderboard Mewtwo: luck 944, experience ×44, Pokédollars ×55, damage ×152, level 6,293.
- The cash rule and the leave rule are compared run by run with the same play up to the point they differ: their
  ranges are narrow for that reason.
- Fusing lowers the score. plan-4's fusion stays out.

**plan-6** = plan-5 with cash under 30 % HP (no loss rule) and leave under 40 % HP, on the pool `stack-2`
(account preset `unlocked-v4:stack-2`):

| | Seeds | Median | Mean | p90 | Best | ≥ 1 M | ≥ 5 M | Level | Minutes | Rounds |
|---|---|---|---|---|---|---|---|---|---|---|
| plan-3, `balanced` (batch 32) | 1–30 | 2,127,158 | 2,438,325 | 5,241,253 | 7,069,176 | 24 | 4 | 817 | 49.4 | 13 |
| plan-5, `balanced` (batch 57) | 1–30 | 5,732,607 | 5,519,452 | 8,265,300 | 10,479,709 | 30 | 18 | 1,076 | 53.1 | 14 |
| plan-6, `stack-2` (batch 70) | 1–30 | 7,552,407 | 7,490,980 | 10,021,713 | 10,518,079 | 30 | 27 | 1,537 | 55.1 | 16 |
| plan-3, `balanced` (batch 54) | development 100 | 1,465,290 | 1,964,935 | 4,158,466 | 8,031,427 | 69 | 8 | 825 | 47.7 | 11 |
| plan-5, `balanced` (batch 56) | development 100 | 4,821,770 | 4,622,592 | 8,287,315 | 11,201,881 | 85 | 46 | 1,071 | 52.4 | 14 |
| **plan-6, `stack-2`** (batch 71) | development 100 | **7,430,752** | 7,087,624 | 9,221,229 | 10,899,768 | 98 | 86 | 1,613 | 54.4 | 15.5 |

- Development seeds, plan-6 against plan-3: seed by seed ×4.44 (3.69 to 5.32), better on 95 of 100. Against
  plan-5: ×2.01 (1.64 to 2.47), better on 80.
- 99 of 100 cash Overtime; one faints before it (209,738 KOs).
- **The top does not move**: best 10.9 million, 3 runs of 100 over 10 million (plan-5: 4). The median run kills at
  the Overtime ceiling in rounds 10 and 11 (94,000 a round), 85,000 in round 12, 63,000 in round 13, 30,000 in
  round 15; half the runs have cashed by round 16, none plays round 18. Three rounds at 85,000 KOs or more in the
  median run, six at most.

## What it means

- The default plan is five times as good as it was (median, development seeds), without learning and without a
  cheat. 1 million and 5 million are now what an ordinary run does.
- **20 million is not nearer at the top.** It needs the ceiling held through round 21 or 22; plan-6 holds it to
  round 12, its best runs to round 14. Past that the enemies' HP grows faster than anything in the pool adds
  damage: the stackable damage items are at 8 to 10 of 10 already. What the leaderboard build has beyond them is
  levels (6,293 against 1,600), from runs of 96 minutes against 54.
- So the next question is the one part 3 ended on, now with a build that can use the answer: what ends a stay in a
  final swarm, and can it be survived for another ten minutes a zone.

## Limitations and unresolved questions

- `stack-2`'s rule (three times the worth for an item without a stack limit of its own) was set once and not varied.
- plan-6 was chosen on seeds 1–30 from single changes; their combination was played once there (batch 70) and once
  on the development seeds (batch 71). It was not played on the held-out seeds.
- The manager is still a copy of plan-3 on `unlocked-v4:balanced`. plan-6 as its default is a new account preset for
  the model as well: a new copy and a new start model.
- The faint before Overtime on one development seed (batch 71) and the lost Overtime of plan-5's batch 56 were not looked into.
