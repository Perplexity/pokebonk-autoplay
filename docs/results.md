# Results so far

Game build `mwsewi0r` (0.10.26). Mewtwo, forest, tier 2, Ranked rules, one episode per game process, no cheat, no
learning. Score = KOs + the Overtime bonus when it is cashed. The goal: one run of 20 million or more in a single
evaluation of the 50 held-out seeds. **No run has reached 20 million; the best is 14.5 million.**

The episodes behind every figure are in `data/pokebonk.sqlite` (batch numbers in brackets; docs/storage.md). The
plans before the current one are no longer in the code: their figures are kept here, and the code that played them
is in the repository's history.

## 1. Where the player stands

| Plan | What it added | Seeds | Median | Mean | p90 | Best |
|---|---|---|---|---|---|---|
| plan-3 | errands, seals, the final swarm by the portal, Rhydon's roars | 100 first development [54] | 1,465,290 | 1,964,935 | 4,158,466 | 8,031,427 |
| | | 50 held-out | 1,528,620 | 2,114,671 | 4,034,675 | 9,052,797 |
| plan-5 | items valued by what the score follows: luck, experience, Pokédollars | 100 first development | 4,821,770 | | 8,287,315 | 11,201,881 |
| plan-6 | an item pool that stacks (`stack-2`), a later cash-out, a later leave | 100 first development [71] | 7,430,752 | 7,087,624 | 9,221,229 | 10,899,768 |
| | | 50 held-out | 7,780,684 | | 9,619,558 | 10,299,849 |
| | | 100 second development [87] | 7,838,016 | 7,514,490 | 9,514,985 | 11,345,601 |
| plan-7 | vitamins by phase, changed at Hypno before the final stage | 100 second development [86] | 11,373,575 | 10,572,553 | 12,446,802 | 12,979,411 |
| | | 1–30 [84] | 11,396,169 | 10,588,606 | 12,348,931 | 12,946,200 |
| plan-8 | the build: one fusion, two linked pairs, Encore; the account's build plan | 1–30 [89] | 13,854,144 | 11,875,904 | 14,409,773 | 14,539,765 |

- plan-8 against plan-7 on seeds 1–30, seed by seed: ×1.13 (95 %: 0.87 to 1.53), better on 23 of 30. 22 of 30 runs
  end with the whole build, every linked pair at level 10; those runs kill at the Overtime ceiling through round 16
  (plan-7: round 14). One run fainted in Overtime's round 19 and lost a bonus of 10.9 million.
- plans 1, 2 and 4 were steps on the way to plan-3 and plan-5 and were never the best plan.
- The held-out seeds have not been played since plan-6.

## 2. What ends a run today

- **The game's own wall at Overtime's second 480.** From there enemy HP grows ×48 a minute and the tide ×4
  (docs/game.md §8.1). Runs with the whole build hold the ceiling through round 16, kill 75,000 in round 17 (median)
  and end 515 to 547 s into Overtime, most with a full HP bar: at second 535 the tide takes about 1,400 HP a second
  against a max HP of 1,500 to 2,200.
- **Expected, not measured:** 20 million is round 21 or 22 at the ceiling. That asks for a max HP of 15,000 to
  30,000 and for damage 16,000 to 110,000 times what is enough at second 480. A leaderboard Mewtwo did it with 96
  minutes (ours: 60), level 6,293 (ours: 2,558), 313 items, max HP 19,650. What is carried into Overtime decides,
  and it is made in the fifty minutes before.
- **A zone left in its first minutes** (plan-7 and plan-8): the rule "leave a cleared zone under 40 % HP" counted
  from the moment the guardian fell, and fired when the guardian itself had emptied the bar, ten minutes before the
  final swarm. 8 of 30 runs of plan-8 (5 of 30 of plan-7) lost a zone that way, and with it the zone's machine and
  often the change of vitamins; those 8 score a median of 6.8 million. plan-9 counts the HP bar only once the final
  swarm has begun.

## 3. What was learned on the way

**What a score follows** (probes that multiplied one stat of the build from the first second; never a result):
luck ×3 gave ×2.8 of the score, experience ×5 gave ×2.4, Pokédollars ×5 gave ×1.8, damage ×10 gave ×1.5; armor ×3
and healing ×5 gave nothing. The direction in `values.ts` is those weights.

**Things that were tried and were worse or no better:**

- Leaving a final swarm on the HP bar's lowest value of the last seconds, or on one heavy hit: in zones 2 and 3 an
  ordinary hit takes 20 to 33 % of max HP, so those rules left at the swarm's first second (median 1.30 million
  against 2.08 without them).
- Cashing Overtime early: when the tide takes 6 % of max HP a second (rounds 10 or 11 for runs that go to 13 to 16
  without it), or under 75 % HP or on half a bar lost in four seconds (cashing under 30 % HP alone was ×1.13,
  better on 29 of 30, with no bonus lost).
- The five farm vitamins for the whole run, without the change before the final stage: more levels (2,586 for
  1,570), harder enemies, the same score.
- Fusing every pair of moves at the cap: ×0.74. The slots it freed filled with borrowed moves that did no damage.
  What works is one fusion and links, with every move chosen (plan-8).
- A reinforcement-learning manager on top of the player (PPO over the player's proposals). Two runs of 500,000
  decisions each changed none of the player's choices. At about 1,000 episodes a day, each with a score noise of
  ±75 %, the signal was too weak, and the gains here came from facts about the game that reading its code gives in
  minutes. It was removed on 2026-11-28.

**A stall rule in the movement code:** about one run in forty used to stand, or walk into a wall, in the sanctuary
until the time cap. After two seconds of walking that moves nothing, on the way to a portal with no enemy near, the player
takes another way.

## 4. How results are measured

- **A score is noisy.** Its standard deviation is 0.7 to 0.8 of its mean. The median of 30 runs of the same player
  lies within ±30 % (95 %), of 100 runs within ±15 %.
- **A seed does not pair runs once play differs anywhere:** the same seed under two plans gives two unrelated runs.
  "Seed by seed" figures here are the geometric mean of the per-seed ratios with a bootstrap interval over the
  seeds: a summary of two batches, not a paired test.
- **Seeds.** 1–30: tuning (and a favourable draw: 30 fresh runs of plan-3 reach its median there one time in a
  hundred). 2000001–2000100: the first development set; a setting of plan-7 was chosen on it, so it is a tuning set
  since. 3000001–3000100: the second development set, on which nothing has been chosen: a plan is played there
  once. 900001–900050: held out, never tuned on; seed 900038 is spent (a stall was diagnosed on it), so held-out
  results are given over all 50 and over the other 49.
- **Speed.** A full run is 60 game minutes and about 15 minutes of wall time; ten game processes play 30 seeds in
  under an hour on an Apple-silicon laptop.
- **A refactor is shown by a replay:** the same seeds give the same episodes, decision for decision.

## 5. Not known

- What plan-8's settings would be if any had been varied: the build, the favourites and the order of the machine's
  uses were set once.
- Why one run in ten never changes its vitamins when no zone was lost.
- What the real service counts when Overtime is lost (docs/game.md §1).
- Any Pokémon but Mewtwo, any map but the forest, any tier but 2: the rules are written without them, and none has
  been measured since plan-3.
