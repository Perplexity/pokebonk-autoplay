# Stage 2 report: RL integration

Game build `mwsewi0r` (0.10.26), account preset `unlocked-v3`, Ranked rules, 60 Hz, 3 simulation steps per decision.
Written 2026-11-24 on this machine (Ryzen 5 7500F, 16 GB, RTX 5060). Details: `docs/training.md`; reasons for the
design: `docs/architecture-decisions/0002-masked-ppo-over-pipes.md`.

**Exit criterion** ("a short offline training run completes, saves a recoverable model, and can be evaluated against
a baseline"): met. The model that run produced is not good and was not promoted; see §6.

## 1. What was implemented

- **Bridge.** One Node process per game environment, driven over stdin/stdout with length-prefixed frames
  (`src/ipc/server.ts`, `python/pokebonk_rl/bridge.py`). No socket.
- **Vectorised environment** for Stable-Baselines3 with spare, pre-reset processes and process recycling
  (`vec_env.py`). The justified alternative to a single-environment Gymnasium class (ADR 0002 §3).
- **Algorithm.** Masked PPO (`sb3_contrib.MaskablePPO`); reasoning in ADR 0002 §1.
- **Network input** "sets-v1": embeddings for category ids, shared row networks for lists, 1.4 M parameters
  (`features.py`).
- **Reward v0**, versioned, six components, each stored per episode (`reward.py`, `configs/reward-v0.yaml`).
- **Training script** with checkpoints, resume, graceful stop, TensorBoard metrics (`train.py`, `checkpoints.py`).
- **Independent evaluation script** with seed-by-seed comparison against a stored baseline or the stable model, and
  a promotion rule (`evaluate.py`).
- **Model registry**: candidates, stable models, promotion, rollback (`registry.py`).
- **Storage** schema 2: training runs, sessions, checkpoints, episode rewards, evaluations, models
  (`src/storage/migrations/002_training.sql`, `storage.py`).
- **Offline rule in the trainer's process**: a network guard and a configuration check (`offline.py`).

## 2. Files

| Area | Where |
|---|---|
| Node side of the bridge | `src/ipc/server.ts` |
| Python package | `python/pokebonk_rl/` (`bridge`, `layout`, `vec_env`, `reward`, `features`, `config`, `train`, `checkpoints`, `evaluate`, `registry`, `storage`, `offline`) |
| Configuration | `configs/training.yaml`, `configs/evaluation.yaml`, `configs/reward-v0.yaml`, `pyproject.toml` |
| Schema | `src/storage/migrations/002_training.sql` |
| Tests | `python/tests/test_units.py`, `python/tests/test_game.py`; one addition in `test/env/environment.test.ts` |
| Documents | `docs/training.md`, ADR 0002, this report; additions in `docs/storage.md`, `docs/environment.md`, `docs/game-mechanics.md`, `README.md` |
| Changed in Stage 1 code | `src/environment/GameEnvironment.ts` (`huntCounter`, §7) |
| Not in git | `.venv/`, `models/`, `logs/`, `data/` |

## 3. Tests

- `python -m pytest`: 27 passing (20 without a game process in 2 s; 7 with real game processes in about 90 s).
- `npm test`: 152 passing. `npm run typecheck`: clean.
- The specification's training tests, each covered (`docs/training.md` §9): short run completes, checkpoints saved,
  training resumes, evaluation uses the requested model, promotion requires a passed evaluation, failed runs do not
  damage stable model files.
- Two of the tests were checked by breaking the code they guard (row masking in the network, the promotion
  requirement); both failed as they should.

## 4. Isolation

- Trainer and evaluator install a network guard before importing any library; five kinds of non-loopback attempt are
  refused in a test, loopback is allowed.
- A configuration naming a URL, endpoint, API key or remote host is refused at start (tested).
- All 111 episodes played by training and evaluation record 0 blocked network attempts in the game processes.
- Trainer and game talk over pipes; this code opens no port.
- Downloads happened once, at setup: Python 3.13 and the Python packages. Nothing is downloaded while training or
  evaluating.
- Unchanged deviation from the specification's §15: no operating-system sandbox. The Python guard is in-process; a
  native library that opened a socket without Python's `socket` module would not be stopped by it.

## 5. Performance

| Measurement | Result |
|---|---|
| Bridge overhead, one process, random policy | 357 decisions/s through the pipe, 405 in-process (12 %) |
| Training loop, 5 game processes + 2 spares, CPU | 392 decisions/s in a 2,560-decision benchmark; 348 over the 868 s run |
| Same, GPU | 252 decisions/s |
| Same, CPU, 8 / 10 game processes | 489 / 500 decisions/s |
| Where the time goes (CPU, 5 processes) | about 43 % waiting for the game, 32 % computing actions, 20 % PPO updates |
| First run | 302,080 decisions and 51 finished episodes in 868 s |

- One decision is 3 simulation steps: 392 decisions/s is 1,176 simulation steps/s, about 20 times real time. The
  scripted baseline, whose decisions cost nothing, reached 2,389 simulation steps/s with 5 processes.
- The GPU is slower here because decisions are computed for 5 observations at a time. It stays a setting.
- 8 processes are faster than 5 but need about 7 GB for the game alone; the default stays at 5 + 2.

## 6. Result of the first run

51 episodes of training prove the path and nothing about learning. Evaluation of its final checkpoint on seeds
1 to 30 (Cyndaquil, forest, tier 0):

| | KOs mean | KOs median | KOs max | Left zone 1 |
|---|---|---|---|---|
| model, most probable action | 296 | 72.5 | 4,114 | 0 of 30 |
| model, sampled actions | 4,702 | 714 | 33,564 | 0 of 30 |
| idle | 375 | 306 | 1,007 | 0 of 30 |
| random | 5,999 | 1,092 | 29,033 | 0 of 30 |
| heuristic | 3,475 | 3,349 | 7,413 | 27 of 30 |

Both evaluations failed the promotion rule (median score at 0.066 and 0.654 of the random baseline). No model was
registered or promoted. The run was then resumed from its last checkpoint for 10,240 more decisions, which worked.

## 7. Defects found and fixed on the way

1. **Seeds above 1,000,000 could not be reset twice in one process.** The game caps its legendary-hunt counter at
   1,000,000 and the environment set it to the seed. Larger seeds now use the seed modulo 1,000,001; seeds up to the
   cap, including every stored baseline episode, are unchanged. Found by the first training attempt.
2. **The bridge ended an episode on a rejected promise nobody awaited.** Once a Pokémon has learned everything, each
   level-up makes the HUD cancel a Web Animation and the DOM library rejects its `finished` promise. The Stage 1
   runner already treated this as a page message; the bridge now does too. Two long training episodes were lost to
   it and are recorded in `errors`. Neither scripted baseline had ever reached that state.

## 8. Limitations and open questions

Limitations:
- Only one scenario was trained and evaluated (Cyndaquil, forest, tier 0). Scenario sampling over several Pokémon,
  maps and tiers exists and is tested, not used in a real run.
- Hyper-parameters and reward weights are first choices, not tuned.
- The evaluation seeds 1 to 30 are also the seeds the scripted baseline was developed on. A held-out seed list, with
  the baselines played on it, is needed before anything is tuned.
- An evaluation with sampled actions is not reproducible episode for episode.
- About a third of the training loop is spent computing actions one small batch at a time.
- The policy picks a dialog option from a flat list of 73 choices; nothing ties option 3's features to choice 3
  except position. Stage 4 (build strategy) will probably want a head that scores each option from its own features.
- A stop request waits for the current step, not for running episodes: episodes in progress are abandoned on resume.

Open questions for the owner (the first two repeat Stage 1's):
1. **KOs against completing the run.** Reward v0 pays 250 KOs per guardian and per portal and 500 for the legendary,
   so that finishing is worth something while KOs stay the largest share. Is that the balance you want?
2. **Lost overtime.** v0 counts the KOs made in overtime either way and pays the bonus only when cashed.
3. **What a first stable model must beat.** The rule as configured: median score at least that of the random
   baseline on the same seeds. The heuristic baseline (median 3,349) would be a much higher bar.
4. **Training budget.** One day at the measured speed is about 30 million decisions (roughly 5,000 episodes of the
   length seen so far). Should Stage 3 start with a run of that order on one Pokémon, or with several Pokémon at once?

## Addendum (same day): held-out seeds

Done after this report, as the first step of §9:
- Idle, random and heuristic were played on 50 held-out seeds, 900001 to 900050 (batches 22 to 24, 150 episodes, no
  errors; `docs/baseline.md` §10): KOs median 290, 740 and 3,016.
- The evaluator's default is now those seeds against `heldout-random`, and only such an evaluation is a promotion
  verdict; a comparison on other seeds or with a hand-picked reference is stored as information and cannot
  authorise a promotion (`docs/training.md` §5; tested, and the test fails when the rule is removed).
- The model of §6 on the held-out seeds: KOs median 70 against 740, ratio 0.095, not passed.
- Tests after the change: 27 passing.

## 9. Recommended next stage

Stage 3, shared gameplay policy:
1. A held-out seed list, with idle, random and heuristic played on it.
2. A first long run (millions of decisions) on the current scenario, to see whether the policy learns to survive
   and to wake a guardian at all.
3. Depending on that: imitation of the heuristic's stored decisions as a starting point, a longer discount horizon,
   reward weights.
4. Evaluation across several Pokémon as soon as one learns.
