# Phase 2 report: the hybrid (skills and a manager)

2026-11-25. Mewtwo, forest, **tier 2**, Ranked, build `mwsewi0r` (0.10.26), account preset `unlocked-v4:balanced`,
offline. No PPO training beyond smoke runs of a few hundred decisions. Sections are the specification's seven
(docs/spec.md §16). "Measured" figures were played headless and are stored in `data/pokebonk.sqlite` under the labels
given. How the hybrid works is in docs/hybrid.md; this report says what was done, what was measured and what is not
there.

**In one paragraph.** The manager's environment, its skills, its action table and observation, the Python side
(network, discount by game time, penalty for straying, copy step) are written and tested. The copy of the heuristic,
played from its file through the whole chain, is the heuristic: on seeds 1–30 it plays 29 of the heuristic's 30
episodes to the KO, and the 30th the same way once the no-KO rule is off. Two things were found on the way. An episode
played in a reused game process is not the episode its seed names; every episode now gets a fresh process (§6). And
the heuristic's own opening breaks the owner's no-KO rule in about one run in 25; the owner chose a grace for the
opening, and with it the copy equals the heuristic on 30 of 30 seeds under the rules (§6). Rifts, dojo trials and the Max form are not skills yet.

## 1. What was implemented

- **Skills** (`src/hybrid/skills.ts`): `farm`, `near_portal`, `wake`, `portal`, `retreat` and `use:<kind>` for 29 map
  point kinds. A skill is an order to the phase 1 heuristic's brain and ends after a game second, at a dialog, when it
  is done, or when the heuristic's own proposal changes.
- **The manager's environment** (`src/hybrid/manager.ts`, manager mode of `src/ipc/server.ts`): one step is a skill
  or a dialog answer; every observation carries the heuristic's proposal, which is always allowed. Taking the
  proposal is the heuristic to the key press.
- **Action table** version 1 (`manager-action-layout.json`): 226 ids, append-only, 144 dialog-option slots.
- **Observation** version 1 (`manager-observation-layout.json`): 15,474 floats and 739 ids. It adds the heuristic's
  proposal, what each offered item, vitamin or move does in numbers, figures at Overtime sizes, and the survival
  figures phase 0 found missing: overheal held, how full the lifesteal budget is, the tide's reference HP, the game's
  own spawn multiplier.
- **Ids that survive a patch** (`src/hybrid/ids.ts`): one registry for all builds, keys keep their index, tables have
  spare capacity that sizes the observation. A model is refused only if a shape, a capacity, the meaning of an id it
  knows or the action table changed.
- **Network** `manager-v1` (`python/pokebonk_rl/manager_net.py`): the proposal has a direct weight to the action, set
  to 8 before training.
- **Warm start** (`python/pokebonk_rl/bc.py`): `collect` stores the heuristic's decisions; `fit` trains the policy on
  them and writes a model.
- **PPO for the manager** (`train.py`, `vec_env.py`): start from the copy; a penalty per decision that is not the
  proposal, fading to zero; discount by elapsed game time with a horizon of 1000 s.
- **Preset bound to the model**: a checkpoint records its account preset and item archive and is refused on another.
- **The owner's rule on Bill's machine** (2026-11-25): no fusion and no link without a TM Case. It is a mask of the
  manager (`fuse_needs`), and the heuristic's default answer in a new plan-4 (fuse two moves at level 10 once the TM
  Case is held). plan-4 is a candidate: not measured, not the default.
- **One episode per game process**, the new default everywhere (§6).
- A read-only accessor of the environment for the survival figures (`survivalFigures`).

**Not implemented, although the brief or my last message named it:**

- **Rifts, the dojo, Hypno as defaults.** The manager can walk to Hypno, the dojo and Bill's machine (`use:` skills)
  and answer their dialogs. Nothing opens a rift (Incense is not a skill), nothing plays a dojo trial on purpose, and
  the heuristic's default answer at Hypno and the dojo is still to leave. I had said these four would come in this
  phase as skills with a rule default; only Bill's machine got one.
- **The Max form** and the fused rift: no skill.
- **The value network's warm start**: it needs the reward, which is phase 3. The stored decisions carry the KOs and
  the Overtime bonus, so it can be trained from the same files.
- **A plan-4 measurement.**

## 2. Files created or changed

| File | |
|---|---|
| `src/hybrid/actions.ts`, `skills.ts`, `manager.ts`, `observe.ts`, `ids.ts` | new: the hybrid's Node side |
| `src/ipc/server.ts` | manager mode |
| `src/agents/heuristic2/policy.ts` | the heuristic taken apart into an adviser (`heuristic2Advisor`); the policy is built from it and plays as before |
| `src/agents/heuristic2/plan.ts`, `chooser.ts` | plan key `fuseNeeds`, plan-4 (candidate), the answer at Bill's machine |
| `src/observations/encode.ts` | the number of dialog-option rows is a parameter (the default layout is unchanged, hash `931bad66…`) |
| `src/environment/GameEnvironment.ts` | `survivalFigures()` (read-only) |
| `src/runner/pool.ts`, `scripts/run-episodes.ts` | one episode per process by default |
| `scripts/export-encoding.ts` | writes the manager's layouts and the id registry |
| `python/pokebonk_rl/manager.py`, `manager_net.py`, `bc.py` | new |
| `python/pokebonk_rl/bridge.py`, `vec_env.py`, `train.py`, `evaluate.py`, `config.py` | manager mode; `env.archive`; preset check; `recycle_after` 1 |
| `configs/manager.yaml`, `manager-evaluation.yaml` | new; `training.yaml`, `evaluation.yaml`: the new keys |
| `test/hybrid/hybrid.test.ts`, `manager.test.ts`, `play-heuristic.ts`; `python/tests/test_units.py`, `test_game.py` | tests |
| `docs/hybrid.md`, `docs/phase-2-report.md` | new; `docs/environment.md` (cause 5), `baseline.md`, `training.md`, `phase-1b-report.md` (correction), `README.md` |

`src/agents/heuristic` and `src/bot/brain` are untouched. The low-level observation and action layouts are unchanged
(`export-encoding --check`: identical).

## 3. Tests run and results

- `npm test`: **194 pass** (187 before). `python -m pytest`: **44 pass** (38 before). `npx tsc --noEmit`: clean.
  `export-encoding --check`: identical. All run at the end, with nothing else playing.
- New, without a game: the action table pinned id by id; masks, orders and the proposal's skill; Bill's machine with
  and without the TM Case (the plan's answer and the manager's mask); the id registry (a key keeps its index, a new
  one is appended, a table over its capacity is refused); the layout and its two hashes; layouts accepted and refused
  on the Python side; the discount by game time against the formula by hand and against ordinary GAE; an untrained
  manager takes the proposal and obeys the mask.
- New, with the game: the manager that takes every proposal against the heuristic in a second process (same low-level
  steps, same end, every counter equal), every observation bounded; a second episode played against the proposal
  with every allowed skill in turn; collect → fit → evaluate → train → resume through the command lines; the copy
  refused on another item archive.
- Not tested: a model on a registry that really grew (only simulated); the penalty's effect on learning; a dojo trial
  or a fusion in play (no run reached one).

## 4. Sandbox and network isolation

Unchanged. Everything ran through the headless environment with its network guard and the Python guard; no batch
reports a blocked request. Nothing was written under `mirror/`. No browser, no external service.

## 5. Performance measurements

- **Manager decisions** (the heuristic's, over the 19 full episodes of the copy data): 3,192 per episode (2,421 to
  3,742) for 2,756 game seconds, of which 310 are dialog answers; 1.05 skills per game second, a skill lasting 0.96 s
  on average. What the heuristic proposes: `farm` 36 % of the skills, `near_portal` 31 %, a `use` of a map point
  30 % (chests first), `wake` 2 %, `portal` 1 %, `retreat` never (the heuristic retreats inside its own tick, not as
  a plan step, so the copy data has no example of that skill).
- **Cost of the manager's environment**: 6.0 s against 5.6 s of wall time for the heuristic alone on the first 120
  game seconds of seed 5 (one process each): about 5 % for the adviser, the second brain call and the encoding.
- **A fresh process per episode**: the first reset of a process takes 2.4 s against 1.6–1.8 s for a later one
  (measured over 80 episodes); an episode of this heuristic takes about 8 minutes of wall time.
- **Stored decisions**: 24 MB for 20 episodes and 60,685 decisions (sparse and compressed, about 400 bytes a
  decision; the dense observation is 62 kB). Collecting them took 1,542 s of wall time with 10 game processes.
- **Copy step**: 3 s per pass over 54,617 decisions on the CPU.
- PPO throughput was not measured: only smoke runs were made.

## 6. Results, limitations and unresolved questions

### Measured: the copy of the heuristic

- **The data.** The heuristic (plan-3) through the manager's environment on seeds 1,000,000–1,000,019 (neither the
  tuning seeds nor the held-out ones), rules on: 20 episodes, 60,685 decisions (`data/bc/plan3`). 18 cashed Overtime,
  one fainted in Overtime and lost its bonus (seed 1000018), one was ended by the no-KO rule at 30 s (seed 1000007).
- **The fit.** On the 6,068 decisions held back, the network gives the proposal in 100.00 % of them before any
  training step (probability 0.9943) and in 100.00 % after one pass (0.9988). The pass changes nothing that decides
  an action: the copy is exact from the start weight of the proposal's path.
- **The copy played** (`manager-copy-01`, model `d4965d3072ee`, from its file, through Python, the pipes and the
  manager's environment; most probable action; rules on; one episode per process), against the heuristic played by
  the runner (`tier2-mewtwo-h2p3-balanced-fresh`):

| Seeds 1–30 | Median | Mean | p90 | Best | ≥ 1M | ≥ 5M | ≥ 20M | Cashed Overtime |
|---|---|---|---|---|---|---|---|---|
| Heuristic (batch 32) | 2,127,158 | 2,438,325 | 5,241,253 | 7,069,176 | 24 | 4 | 0 | 30 of 30 |
| Copy (batch 34, `copy-seeds1-30:manager-copy-01`) | 2,042,752 | 2,315,060 | 5,241,253 | 7,069,176 | 23 | 4 | 0 | 29 of 30 |

- **Seed by seed**: 29 of 30 episodes equal the heuristic's in KOs, Overtime bonus, level and game time to the last
  digit. The 30th, seed 19, was ended by the no-KO rule at 53.4 s with 2 KOs and scores 0; it is the whole of the
  difference in the median and the mean. Played again with both rules off (`copy-seed19-norule:manager-copy-01`,
  batch 36), it is the heuristic's episode too: 1,487,778 KOs, bonus 2,210,144, 3,259.5 s. So 30 of 30 without the
  rule.

### Found: the heuristic's opening breaks the no-KO rule

- **What happens.** The heuristic opens a run by walking to the free chests and other points near the start. Mewtwo
  is level 1, few enemies are out yet, and it walks past those that are. Seed 19: 2 KOs by 23.7 s, the third at
  64.2 s. Seed 1000007: the first KO at 33 s. The rule (no KO for 30 game seconds, docs/training.md §3) ends both.
- **How often.** 2 of the 50 episodes played under the rule here (1 of 30, 1 of 20). Never after the first minute.
- **Why it was not seen before.** The rule was checked against the first heuristic on tier 0 (16 s at most without a
  KO in a zone). Every batch of the second heuristic was played by the runner, where the rule is off by default.
- **What it means.** Nothing for the heuristic's stored scores: they are what it scores in the game. For a manager it
  means that taking every proposal loses about one episode in 25 at its start. Nothing was changed: the rule is the
  owner's and the heuristic's opening earns items. The options were put to the owner (§7).
- **Decided and done (the owner, 2026-11-25): a grace for the opening.** The no-KO rule does not run during the
  first 90 game seconds of a run; its stretch without a KO starts when the grace is over. A new setting, off by
  default (`koGapGraceGameTime`, `env.ko_gap_grace_game_time`, `--ko-gap-grace`), 90 in `configs/manager.yaml` and
  `manager-evaluation.yaml`. The rule against standing still is unchanged. Tested in the environment's test (an
  episode that ended at 2 s ends at 3.5 s with a grace of 1.5 s) and in the configuration's.
- **Measured with the grace**, both rules on:
  - the copy on seeds 1–30 (`copy-seeds1-30-grace:manager-copy-01`, batch 37): **30 of 30 episodes equal the
    heuristic's** in KOs, bonus, level and game time. Median 2,127,158, mean 2,438,325, p90 5,241,253, best
    7,069,176; 24 of 1M or more, 4 of 5M or more, none of 20M; 30 of 30 cashed Overtime;
  - the heuristic on seed 1000007, which the rule had ended at 30 s: a full run, 210,856 KOs and a bonus of 593,757.
- **Not redone:** the copy data keeps its one episode cut at 30 s (38 of 60,685 decisions). To be collected again
  with the grace when the value network is trained from it.

### Found: an episode in a reused process is not the episode its seed names

- **How it showed.** Two batches of the same plan-3 code on seeds 1–30 differed on 16 seeds. The 14 that agreed were
  nearly all episodes that were the first of their game process in both batches.
- **Cause, measured** (docs/environment.md §3, cause 5): the game's virtual wall clock keeps running from one episode
  to the next in a process, and its value changes play. Seed 21 capped at 640 game seconds: 26,659 KOs in a fresh
  process and in one that was only reset once; 26,845 with the clock advanced by 11 minutes first, exactly what a
  process that had played an episode before gives. The same seed twice in one process at full length: 1,487,778 KOs,
  then 1,498,866. Which code of the game reads the clock is not identified.
- **What was done.** Every episode is played in a fresh process, by default, in the runner, the trainer, the
  evaluator and the copy step. Measured after the change: the 30 episodes of `tier2-mewtwo-h2p3-balanced-fresh`
  equal, to the KO, all 26 episodes of the two earlier batches that had been the first of their process.
- **What it means for earlier results.**
  - Every stored episode is a real episode. What is lost is that a seed names it: in the batches of phase 1 and 1b
    about two thirds of the episodes were not the first of their process.
  - The medians, means and bests reported stand as measured.
  - **My reading of plan-3 against plan-2 was wrong** ("17 identical, 9 higher, 4 lower" as the roar rule's effect):
    most of those differences are this. What is established for the rule is the trace of seeds 4 and 7 in fresh
    processes. Corrected in docs/phase-1b-report.md.
  - The comparisons of archive versions and of plan variants in phases 1 and 1b were on 30-seed medians and means,
    which this adds noise to but does not bias one way.
  - The tier-0 baselines of Stage 1 and 2 are not affected in what was checked then: their episodes are short and
    repeat exactly in a reused process.

### The heuristic, one episode per process (the reference from now on)

| Batch (label) | Seeds | Median | Mean | p90 | Best | ≥ 1M | ≥ 5M | Reached Overtime |
|---|---|---|---|---|---|---|---|---|
| plan-3 (`tier2-mewtwo-h2p3-balanced-fresh`) | 1–30 | 2,127,158 | 2,438,325 | 5,241,253 | 7,069,176 | 24 | 4 | 30 of 30 |
| plan-3 (`heldout-tier2-mewtwo-h2p3-balanced-fresh`, batch 35) | 900001–900050 | 1,528,620 | 2,114,671 | 4,034,675 | 9,052,797 | 37 | 2 | 50 of 50 |

- No run of 20 million in either; all 80 runs cashed their Overtime bonus. Both batches were played by the runner,
  with the standing-still and no-KO rules off.
- The held-out batch replaces `heldout-tier2-mewtwo-h2p3-balanced` (batch 30, reused processes: median 1,552,786,
  mean 2,313,503, p90 4,195,666, best 9,052,797) as the reference a model is compared with
  (`configs/manager-evaluation.yaml`). All 23 episodes that were the first of their process in batch 30 are equal
  here; of the 27 played in a reused process there, 7 are equal and 20 differ. The held-out seeds were played, not tuned on.

### Limitations and unresolved questions

- **The copy is exact by construction.** The network has a direct path from the proposal to the action, so the copy
  check proves the chain, not that a network learned the heuristic's reasons. Whether PPO can move away from the
  proposal where that pays, and stay on it where it does not, is the open question of phase 3. The penalty and the
  size of that path's weight are first settings.
- **The adviser keeps its own clocks.** If the manager does not follow an errand for 40 s, the heuristic gives the
  point up for the zone and stops proposing it. The manager can still choose it.
- **`use` targets the nearest point of a kind.** A manager cannot name one of two shops.
- **The observation has no single enemies.** A manager cannot see a dangerous elite as such; it sees density, the
  horde's hit as a share of max HP, and the HP history.
- **The standing-still and no-KO rules** are on for training, for the copy data and for evaluating a model. They
  were off in every batch of the heuristic (the runner's default), which is how the opening above went unseen in
  phase 1. No rule ended an episode after its first minute (0 of 48 full episodes).
- **`retreat` has no example** in the copy data, and neither has any `use` of Hypno, the dojo or Bill's machine.
  PPO starts those from the mask and the proposal's weight alone.
- **TM Case.** 9 of 50 held-out runs hold one at the end, so the rule "never fuse without it" means Bill's machine is
  left alone in most runs. Getting the item more often (shop restocks until it shows, for instance) is not planned
  yet.
- **20 million.** Nothing here changes the distance: the copy scores what the heuristic scores.

## 7. Recommended next stage

Phase 3 as written, with these settled first:

0. **The no-KO rule and the heuristic's opening** (§6). Settled on 2026-11-25: the first option, done. The options
   were:
   - *A grace for the opening* (my recommendation): the no-KO clock starts at the run's first KO, or after the
     first 90 s. The rule keeps catching what it was made for (pacing, hiding in a rift) and the heuristic's opening
     stays as it is. It is a change of the environment's rule, so it gets a new setting, off by default.
   - *Leave the rule as it is*: about 4 % of the copy's episodes score 0 from the first minute; PPO has to learn to
     fight first in those openings, and the heuristic's reference has to be replayed under the rule to compare like
     with like.
   - *Change the heuristic's opening* (fight until the first level, then the chests): a new plan version, to be
     measured on seeds 1–30 before it becomes the default.
1. **The reward** (sqrt of KOs + current Overtime bonus, scaled so 20 million returns about 5) and its tests, then the
   value network trained on the stored decisions before any PPO step.
2. **The promotion metric** to agree on before use. My proposal: p90 score over the 50 held-out seeds, with the
   median not below 90 % of the heuristic's, both against `heldout-tier2-mewtwo-h2p3-balanced-fresh`.
3. **A budget** for the two short runs (sqrt against log) and for the long one. With about 10 game processes one
   episode takes 8 minutes, so 100 episodes are about 80 minutes.

Also the owner's call, before or alongside: rifts as a skill (the largest missing part of the map), Hypno's lesson and a
dojo default, and a plan-4 measurement.
