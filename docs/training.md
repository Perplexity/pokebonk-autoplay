# Training and evaluation (Stage 2)

Game build `mwsewi0r` (0.10.26), account preset `unlocked-v3`, Ranked rules, 60 Hz, 3 simulation steps per decision.
Python 3.13.17, PyTorch 2.11.0 (CUDA 12.8 build), Stable-Baselines3 2.9.2, sb3-contrib 2.9.2, Gymnasium 1.4.0.
Why these parts were chosen: `docs/architecture-decisions/0002-masked-ppo-over-pipes.md`.

```
python -m pokebonk_rl.train        trainer (one process)                 configs/training.yaml
        │  pipes (stdin/stdout), one per game process
        ├── node src/ipc/server.ts   one headless game environment each   src/environment
        └── …
python -m pokebonk_rl.evaluate     plays a saved model on fixed seeds    configs/evaluation.yaml
python -m pokebonk_rl.registry     candidate and stable models
data/pokebonk.sqlite               every episode, reward, checkpoint, evaluation, model (docs/storage.md)
models/                            checkpoints, candidates, stable models (git-ignored)
logs/tensorboard, logs/training    metrics, and the stderr of every game process (git-ignored)
```

## 1. The bridge (`src/ipc/server.ts`, `python/pokebonk_rl/bridge.py`)

One Node process holds one environment and is driven over its stdin and stdout. A frame, in both directions, is two
little-endian `uint32` (length of a JSON header, length of a binary payload), the header, the payload.

| Request | Reply |
|---|---|
| `{cmd: 'init', env: {…}, recordDecisions}` | `{t: 'hello', protocol, pid}` (the game is loaded by the first reset) |
| `{cmd: 'reset', seed, species?, map?, tier?}` | an observation |
| `{cmd: 'step', a: [move, jump, dash, ultimate, interact, form, incense, fuse, choice]}` | an observation |
| `{cmd: 'close'}` | none; the process exits with code 0 |

An observation reply carries `phase`, `term`, `trunc`, the run's cumulative counters `c`, the overtime state, and the
payload `float32[7553] | int32[195] | uint8[112]`: the encoded observation and the action mask
(docs/observation.md). The first observation of a process also carries the environment's metadata; the step that ends
an episode carries its `EpisodeRecord`, the same record the Stage 1 runner stores.

- An action is decoded by the same codec as everywhere else and checked against the mask by the environment. An action
  the mask forbids is an error, not a penalty: the learner only ever samples allowed actions, so one arriving means a
  defect.
- After any error the process replies `{t: 'error', …}` and exits with code 1. The trainer never reuses it.
- A rejected promise that nothing awaits is not an error, as in the Stage 1 runner and as in a browser: it is recorded
  as a page problem (`src/sim/browser.ts`). The first training run found why this matters: once a Pokémon has learned
  everything, every further level-up makes the HUD cancel a running Web Animation, and the DOM library rejects that
  animation's `finished` promise. The bridge at first ended the episode for it (2 episodes of that run, both recorded
  in `errors`); it no longer does.
- stdout carries frames only; anything printed goes to stderr, which the trainer writes to
  `logs/training/<run>/session-NNNN/worker-NNNN.log`.
- The layouts the trainer loaded from `data/encoding/<build>/` are compared with the hashes the running environment
  reports (`check_against_metadata`); a mismatch stops the trainer.

## 2. The vectorised environment (`python/pokebonk_rl/vec_env.py`)

`NodeVecEnv` implements Stable-Baselines3's `VecEnv` over `envs` game processes.

- **Spares.** `spares` further processes hold an episode that has already been reset. When a slot's episode ends, a
  ready spare takes the slot and the old process resets in the background. A reset costs 2.6 to 4.1 s; without
  spares each one would stall every slot.
- **Recycling.** A process is closed and replaced after `recycle_after` episodes (default 8) or above
  `recycle_rss_mb` (1,500).
- **Seeds and scenarios.** The run's k-th episode is played on seed `episode_seeds.first + k` and on the Pokémon, map
  and tier that `scenarios` gives for k (uniform over the configured lists, a function of k and the run's seed alone).
  A resumed run continues at the k its checkpoint recorded, so no seed is played twice.
- **End of an episode.** The slot reports `done`, the last observation as `terminal_observation`, `TimeLimit.truncated`
  when only the safety cap on game time ended it, the usual `episode` statistics, and under `pokebonk` the episode
  record, its reward split into components, its scenario and its number.
- **Errors.** A process that reports an error, exits or does not answer within the timeout is killed and replaced; its
  episode ends as truncated with reward 0 for that step, and the error goes to the `errors` table. After
  `max_errors` (default 20) in one session the trainer stops with the last error.

## 3. Reward (`python/pokebonk_rl/reward.py`, `configs/reward-v2.yaml`)

Computed in the trainer from the differences of the run's counters. Unit: one KO; the sum is multiplied by
`scale` = 0.01. **Current version: v2** (Stage 3): v1 plus a payment for using what is on the map and a penalty for
selling in the shop. v1 and the
Stage 2 version v0 are kept (`configs/reward-v1.yaml`, `configs/reward-v0.yaml`).

**The owner's decisions behind v1 and v2** (2026-11-24):
1. KOs matter more than finishing the run, because the ranking counts KOs.
2. Overtime is to be survived as long as possible, for its KO multipliers.
3. No shortcuts and no speedruns: the aim is the play that makes the most KOs. The heuristic baseline is not the
   standard a model is measured by, and nothing is learned by imitating it.
4. One Pokémon for now: Mewtwo.
5. "Without using everything on the map, you will never play optimally. These things need to be considered. … we
   should reward using things on the map as much as possible." So every part of the map was made playable
   (docs/environment.md §4, docs/baseline.md §12), and v2 pays for each use.
6. "Selling in the shop should take rewards away not add to it." v2 takes reward away for each owned item sold in
   the shop.

| Component | Paid for | v2 weight (KOs) | v1 | v0 |
|---|---|---|---|---|
| `ko` | each KO (`counters.kills`) | 1 | 1 | 1 |
| `overtime` | each overtime bonus KO. v1, v2: as the game's bonus builds up, taken back if overtime is lost. v0: at the end, when cashed | 1 | 1 | 1 |
| `overtime_void` | each KO made during an overtime that was lost by fainting, at the end | −1 | −1 | — |
| `guardian` | each zone guardian beaten | 100 | 100 | 250 |
| `zone` | each zone entered through a portal (zones 2, 3, the sanctuary) | 100 | 100 | 250 |
| `legendary` | the sanctuary's legendary beaten | 200 | 200 | 500 |
| `death` | fainting before the map is cleared | −100 | −100 | −100 |
| `map_use` | each use of the map (`counters.mapUse`): a map point used, a shop purchase, a slot-machine spin, a lesson of Hypno, a rift cleared, a Max form | 10 | — | — |
| `shop_sale` | each owned item sold in the shop (`counters.shopSold`) | −30 | — | — |

- **`ko` + `overtime` + `overtime_void` are the objective itself**: over an episode they sum to what the ranking
  counts, the run's KOs plus the cashed overtime bonus. The other three are hints.
- **Overtime in v1.** The bonus of a round is `KOs × (multiplier − 1)`, and the multiplier grows every round
  (1.25, 1.5, 2, 2.5, 3, 4, then +1 per round; docs/game-mechanics.md §1). Paying it as it builds up makes a KO in a
  late round worth several KOs at the moment it is made. The bonus only counts when overtime is *cashed* (at the
  portal, or by lasting all 24 rounds); a Pokémon that faints in overtime keeps the victory and loses the extra. So
  the best play is to stay as long as it can be survived and to walk out before fainting, and the reward says the
  same: on fainting in overtime the bonus paid so far is taken back.
- **Lost overtime: the stricter of the game's two statements is used.** The banner says "the victory is yours,
  without the overtime extra"; the run history says of a lost overtime that "its KOs are voided". Which one a ranking
  applies cannot be established offline. v1 voids them (`overtime_void` = KOs since the game's own `ot.k0`). Under
  either reading walking out is better than fainting; the stricter one only makes the difference larger. Setting
  the weight to 0 gives the other reading. The evaluation's score (KOs + cashed bonus) does not void them.
- **Why milestones at all, and why smaller.** They do not count in the ranking. But the KOs are in the later parts
  of a run: a zone's final swarm (800 enemies from zone minute 10) and overtime with its multipliers, and reaching
  those takes a sequence the learner will not find by chance (walk to the altar, answer the seals dialog, beat the
  guardian, walk to the portal). The payments mark that sequence. A complete run's milestones are worth 800 KOs
  (2,000 in v0); one final swarm gave the random policy 12,000 to 29,000 as Cyndaquil, so a policy that can survive a swarm gains nothing
  by hurrying past it. Whether they help at all is to be judged on the development seeds, not assumed.
- **Map use in v2.** One count, `counters.mapUse` (docs/observation.md §1), is the sum of:
  - map points used, each point once, at the moment the game marks it used: Poké Balls (paid, free, cursed), Unown
    altars, Gengar's altar, the cursed altar, challenge altars, Snorlax, cages, rocks, berries, Magnemite, Ditto,
    the fossil and Porygon trades, the dojo (when its trial ends), Bill's machine (when it fuses), Power Altars …;
    not the guardian altar, the shrine and the portal, which are paid as milestones;
  - shop purchases, slot-machine spins, lessons of Hypno, rifts cleared and Max forms used (things that are used
    more than once, or that are not a point).
  The first zone of the forest has 89 map points (seed 1: 19 paid Poké Balls, 19 rocks, 7 Unown altars, 7 berry
  bushes, 4 free and 3 cursed balls, 3 slot machines, 3 cages, 3 challenge altars, and one or two of each of the
  rest). At 10 KOs per use, a run that used every point of three zones would be paid about 2,600, against the
  12,872 KOs of Mewtwo's median random run on the held-out seeds: enough to make the agent try things, small next to
  the KOs. What a use is worth in KOs is not known for any of them; **10 is a first setting, not a tuned value**,
  and it is the same for every kind on purpose (no opinion about which feature is good is built in).
- **Selling in the shop in v2.** Each owned item sold through the shop's sell list costs 30 KOs' worth of reward.
  The size is chosen so that selling can never come out ahead through what its Pokédollars buy: the best sale of
  zone 1 (90 ₽) pays for two slot-machine spins, worth 20, and an item bought and sold again is +10 − 30. Like the
  10 of `map_use` it is a first setting. Not counted as selling in the shop, and neither paid nor penalised: a
  found item turned down for Pokédollars (the take-or-sell dialog of a Poké Ball), and moves or vitamins forgotten
  at Hypno. The count is the environment's own (`shopSold`: it makes those sales in place of the HUD's button);
  the game's `econ.sold` mixes shop sales with turned-down items.
- **What v2 does not change.** A model is still evaluated and promoted on score = KOs + cashed overtime bonus
  (§5). The payment for map use is not part of the score. If using something costs KOs (a curse taken too early,
  Pokédollars spent on spins instead of items), the evaluation on the development seeds shows it, and the answer is
  a lower weight or a per-kind weight in a new reward version, decided from those results.
- **A known side of it.** Spins and purchases are limited only by Pokédollars, and the price of a spin rises 8 %
  with each one (40 spins cost about 10,000 ₽), so the payment for them is bounded in practice; but a policy can
  learn to spend on spins what would have bought better items. That is one of the things to look at first.
- Nothing is paid for time survived, damage dealt, levels or pickups. Damage taken is measured per episode
  (`raw.damage_taken`) and has no weight.
- The version, the weights and each episode's components are stored (`training_runs.reward_json`,
  `batches.reward_version`, `episode_rewards`). A run refuses to resume under another reward; changing a weight means
  a new version name and a new run.
- The learner sees the reward divided by a running estimate of the spread of returns (`normalize_reward`); the
  stored components are the unnormalised values.

## 4. The learner (`python/pokebonk_rl/train.py`, `features.py`)

`sb3_contrib.MaskablePPO` with the `MultiInputPolicy` and the feature extractor "sets-v1" (1.4 M parameters):

- every category id (species, move, item, …) goes through an embedding table of its vocabulary;
- each list (enemies, projectiles, hazards, pickups, map points, move slots, dialog options) is encoded row by row
  by a small network shared by its rows; rows that are not present contribute nothing (tested);
- lists ordered only by distance are reduced with max and mean; move slots and dialog options keep their order,
  because an action refers to them by position (choice index = option row + 1);
- everything is concatenated and mixed into 512 features, followed by one layer of 256 units each for the policy and
  the value.

Segment offsets and vocabulary sizes come from the layout descriptor and are stored inside every saved model.
Hyper-parameters are in `configs/training.yaml` (`ppo`): 1,024 steps per process per update, batch 1,024, 4 epochs,
learning rate 3e-4, discount 0.999 (a horizon of about 50 game seconds), GAE 0.95, clip 0.2, entropy 0.01. They are
library defaults adapted to the episode length, not tuned.

```sh
python -m pokebonk_rl.train --config configs/training.yaml --name my-run
python -m pokebonk_rl.train --resume my-run [--timesteps 5000000]
python -m pokebonk_rl.train --config configs/training.yaml --set workers.envs=8 --set total_timesteps=1000000
```

- **A run is one model.** Its configuration is written to `models/runs/<name>/config.json` when it is created; a
  resume uses that file and accepts only a higher `--timesteps`. A run name is used once.
- **Stopping.** Ctrl+C, or creating `models/runs/<name>/STOP`: the current step finishes, a checkpoint of kind
  `interrupt` is written, the session is recorded as `interrupted`. A second Ctrl+C aborts without a checkpoint.
- **Configuration.** Every key has its default in `python/pokebonk_rl/config.py` and appears in the YAML file; an
  unknown key is an error.

### Checkpoints (`python/pokebonk_rl/checkpoints.py`)

`models/runs/<name>/checkpoints/ckpt_<timesteps>/` holds `model.zip` (policy, optimiser, timestep counter),
`vecnormalize.pkl` (the reward normaliser) and `state.json` (episode counters, layout hashes, reward version, the
sha256 of `model.zip`).

- Written every `checkpoint_every_timesteps` (at the end of the update that crosses it), at the end, and on a stop.
- Written into `<name>.partial` and renamed when complete. A folder without a `state.json` matching its `model.zip`
  is not a checkpoint; resume takes the newest one that passes this check. A checkpoint is never overwritten.
- What a resume loses: the episodes that were in progress (their seeds are not reused) and the steps collected since
  the last update.

### Metrics

TensorBoard files go to `logs/tensorboard/<run>_N` (`tensorboard --logdir logs/tensorboard --host 127.0.0.1`).
Besides the library's own `rollout/`, `train/` and `time/` series:

| Series | Meaning |
|---|---|
| `game/kos_mean`, `score_mean`, `time_mean`, `level_mean`, `zone_mean`, `guardians_mean`, `completed_share` | over the last 100 finished episodes (score = KOs + cashed overtime bonus) |
| `reward/<component>_mean`, `reward/total_mean` | reward per episode, by component, same window |
| `perf/decisions_per_second`, `episodes_per_hour` | throughput since the previous update |
| `perf/waiting_for_game_share` | share of wall time spent waiting for game processes |
| `perf/environment_errors`, `game_processes_started` | counts in this session |

Every finished training episode is also a row of `episodes` with its reward in `episode_rewards` (docs/storage.md).

## 5. Evaluation (`python/pokebonk_rl/evaluate.py`, `configs/evaluation.yaml`)

```sh
python -m pokebonk_rl.evaluate --model <checkpoint folder | run name | stable | candidate:<id>> [--seeds 1-30] [--reference <batch id or label> | stable | none]
```

- A separate process loads the model **from the file**, after checking the file's hash against its `state.json` and
  its layout hashes against the exported layouts. It shares nothing with a running trainer.
- Every seed is played once on one scenario (default: Mewtwo, forest, tier 0, the 50 held-out seeds 900001 to
  900050), with the most probable action at each step (`--stochastic` samples instead).
- The episodes are stored as a batch with every dialog decision (`policy_name` `ppo`, `policy_version` = first 12 hex
  digits of the model's sha256), the result as a row of `evaluations`.
- **Comparison.** Seed by seed against a reference: a stored batch (id or label), or the stable model's own
  evaluation on the same seeds and scenario. A reference played on another build, bundle, account preset, rule set, or with another action or
  decision schema (what the player can do: the baselines stored before the map features were playable have schema 1)
  cannot be passed.
- **The promotion rule** (`promotion` in the configuration): `metric` of the model divided by the reference's must
  reach `min_ratio`, and no episode may be lost to an error. Default: median score, ratio 1.0, against the stable
  model when there is one, else against the batch labelled `heldout-mewtwo-random`.
- **Only one kind of evaluation is a verdict**: one played on exactly the seeds `promotion.seeds` and compared with
  the reference the rule names. Any other (`--seeds`, `--reference`) is still compared and stored, with
  `evaluations.passed` NULL and the reason in `comparison_json` (`verdict`, `met_the_rule`,
  `not_a_verdict_because`); `promote` ignores it.
- Exit code: 0 passed (or nothing judged), 1 not passed, 2 bad arguments, 3 episodes lost to errors.
- Reproducible on one machine: the same file on the same seeds gave the same episodes twice (tested on three seeds:
  KOs, steps, game time, level, decision count, cause of end, every counter and the final build).

**Three disjoint seed lists** (per scenario; results: `docs/baseline.md` §10 and §11). For Mewtwo, the current scenario:

| Seeds | Used for | Baselines stored as |
|---|---|---|
| 1 to 30 | development: looking at a model while reward weights and hyper-parameters are being chosen (`--seeds 1-30 --reference baseline-mewtwo-random`) | `baseline-mewtwo-idle`, `-random`, `-heuristic` |
| 900001 to 900050 | held out: the promotion verdict, nothing else | `heldout-mewtwo-idle`, `-random`, `-heuristic` |
| 1000000 upward | training episodes | — |

Nothing is tuned on the held-out seeds: a weight or setting chosen because of a result on them makes them
development seeds, and a new list is then needed. Cyndaquil's baselines on the same two lists are stored without
`mewtwo` in the label. The two evaluations of §8 were made on seeds 1 to 30 before this
rule existed (they are stored with a verdict; both failed).

## 6. Candidate and stable models (`python/pokebonk_rl/registry.py`)

```sh
python -m pokebonk_rl.registry register --model <checkpoint folder | run name>
python -m pokebonk_rl.evaluate --model candidate:<id>
python -m pokebonk_rl.registry promote --candidate <id> --yes
python -m pokebonk_rl.registry rollback --to <id> --yes
python -m pokebonk_rl.registry list
```

- `register` copies a checkpoint folder to `models/candidates/<id>-<hash>/`.
- `promote` requires that the newest judged evaluation of exactly that file (same sha256) passed. It copies the
  candidate to a new folder `models/stable/<id>-<hash>/`, verifies the copy's hash, marks the previous stable model
  `retired` and replaces `models/stable/current.json` atomically.
- Nothing in this code overwrites, moves or deletes a stable model's folder; `rollback` points back at a retired
  one after checking its files are unchanged. Both need `--yes`.
- A failed or interrupted training run, and a failed evaluation, do not touch `models/stable` (tested by comparing
  the hashes of every file before and after).

## 7. Offline rule

- The trainer and the evaluator call `offline.install_network_guard()` before importing any library: from then on
  `connect`, `connect_ex`, `sendto`, `create_connection` and name lookups of their own process fail for anything but
  loopback, before anything is sent (tested in a child process against five kinds of attempt).
- A configuration that names a URL, an endpoint, an API key or a remote host is refused at start
  (`offline.check_config`, tested).
- The game processes have their own guard (docs/environment.md §5); every stored episode records the network
  attempts it blocked.
- Trainer and game talk over pipes. No port is opened by this code. TensorBoard, when started by hand, should be
  bound to `127.0.0.1` as shown above.
- Not done: an operating-system sandbox (deviation from the specification's §15, recorded in ADR 0001). The Python
  guard is in-process: a native library that opens a socket without going through Python's `socket` module would not
  be stopped by it.

## 8. The first run (`stage2-first`, 2026-11-24)

A run to prove the path, not to learn the game: 302,080 decisions, default configuration (5 game processes + 2
spares, CPU), Cyndaquil on forest, tier 0.

| | |
|---|---|
| Wall time | 868 s; 348 decisions/s over the whole session (simulation: 761,522 steps in finished episodes) |
| Where the time went | 46 to 74 % waiting for the game per update; the rest computing actions and the PPO updates |
| Episodes finished | 51, with 0 blocked network attempts |
| Environment errors | 2, both the unhandled-rejection case of §1, fixed afterwards |
| Game processes started | 12 |
| Checkpoints | at 102,400, 204,800 and 302,080 decisions |
| Resume | `--resume stage2-first --timesteps 312320` continued from 302,080 and wrote `ckpt_000000312320` |

Evaluation of the checkpoint at 302,080 decisions (model `e73530ff7f5e`) on seeds 1 to 30, against the stored
baselines on the same seeds (docs/baseline.md):

| | KOs mean | KOs median | KOs max | Game time mean (s) | Left zone 1 |
|---|---|---|---|---|---|
| model, most probable action (evaluation 1, batch 19) | 296 | 72.5 | 4,114 | 132 | 0 of 30 |
| model, sampled actions (evaluation 2, batch 20) | 4,702 | 714 | 33,564 | 365 | 0 of 30 |
| idle (batch 1) | 375 | 306 | 1,007 | 201 | 0 of 30 |
| random (batch 2) | 5,999 | 1,092 | 29,033 | 398 | 0 of 30 |
| heuristic (batch 4) | 3,475 | 3,349 | 7,413 | 673 | 27 of 30 |

- Both evaluations were judged against the random baseline by the promotion rule and **did not pass** (median score
  ratio 0.066 and 0.654, 1.0 needed). No model was registered or promoted; there is no stable model.
- With sampled actions the model plays about like the random policy, which is what 51 episodes of training can be
  expected to give. Taking the most probable action it does worse than standing still: a policy that is still close
  to uniform has no meaningful "most probable" action, and repeating one is worse than mixing them.
- In training, mean KOs per episode by quarter of the run were 560, 1,640, 1,835 and 896, each dominated by one or
  two episodes that reached a final swarm (up to 17,860 KOs). That is noise at this sample size, not a learning curve.
- A sampled evaluation is not reproducible episode for episode (its random draws depend on how episodes are batched);
  only evaluations with the most probable action are.
- **On the held-out seeds** (added afterwards, evaluation 3, batch 25, most probable action, default configuration):
  KOs mean 515, median 70, max 14,186, zone 1 in 50 of 50, against `heldout-random` mean 3,473, median 740. Ratio
  0.095, better on 3 seeds and worse on 47: **not passed**. The same picture as on seeds 1 to 30.

## 9. Tests

`python -m pytest` (27 tests): `python/tests/test_units.py` (20, no game process, 2 s) and
`python/tests/test_game.py` (7, real game processes, about 100 s; `-m "not game"` skips them).

| Requirement of the specification | Test |
|---|---|
| Short training run completes; checkpoints are saved | `test_short_training_run_completes_and_leaves_recoverable_checkpoints` |
| Training resumes | `test_training_resumes_from_the_newest_checkpoint_and_refuses_what_would_change_the_run` |
| Evaluation uses the requested model | `test_evaluation_plays_the_requested_model_reproducibly_and_promotion_follows_the_rule` |
| Candidate promotion requires passing evaluation | `test_promotion_needs_a_passed_evaluation_and_never_touches_an_earlier_stable_model` |
| Failed runs do not damage stable model files | same two tests (failed training, lost evaluation, tampered candidate) |
| Startup check against remote endpoints | `test_offline_rule_refuses_remote_endpoints_in_a_configuration`, `test_network_guard_blocks_everything_but_loopback` |
| Handle invalid actions safely | `test_bridge_reports_an_action_the_mask_forbids_and_the_process_ends` |
| Repeated episode execution; state consistent across resets | `test_vec_env_swaps_in_spares_recycles_processes_and_accounts_for_every_episode` |
| Reproducibility through the bridge | `test_bridge_delivers_the_layouts_buffers_and_the_same_episode_for_the_same_seed_and_actions` |
