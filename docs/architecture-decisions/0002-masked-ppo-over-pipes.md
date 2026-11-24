# ADR 0002: masked PPO in Python, driving Node game processes over pipes

Status: accepted for Stage 2 (2026-11-24). Measurements: this machine (Ryzen 5 7500F, 16 GB, RTX 5060), game build
`mwsewi0r`.

## Context

Stage 1 delivered the environment in Node (the unmodified bundle under shims), an observation encoding of 5,651
floats and 163 category ids, and an action space `MultiDiscrete [9, 2, 2, 2, 2, 73]` with a per-dimension mask of 90
entries. Stage 2 needs a learner on top of it. The specification names Python, PyTorch, Stable-Baselines3 and
Gymnasium as defaults, asks for the reasoning behind the algorithm, and forbids network use in training.

Facts the choice rests on:

- One decision is 3 simulation steps (20 decisions per game second). An episode is 1,000 to 22,000 decisions.
- Real-time play and dialogs share one action vector; in each phase the mask leaves the other phase's entries one
  legal value. Up to 48 dialog options are legal or not from step to step.
- A reset takes 2.6 to 4.1 s (the game loads a zone). A game process grows 25 to 40 MB per episode.
- The game is the cost: 5 processes give about 2,400 simulation steps (800 decisions) per second with a scripted
  policy that costs nothing.

## Decisions

**1. Algorithm: PPO with invalid-action masking (`sb3_contrib.MaskablePPO`).**
- The action space is discrete and multi-dimensional with a mask that changes every step. Masking removes illegal
  actions from the distribution instead of teaching the policy to avoid them by penalty; the environment still
  refuses an illegal action, so a masking bug shows as an error.
- On-policy learning needs no replay buffer of 23 KB observations and tolerates the reward's wide range once returns
  are normalised.
- It is the maintained masked algorithm of the library the specification names; DQN-family methods do not handle a
  6-dimensional action, and no recurrent masked PPO exists in the library.
- Not chosen now: a recurrent policy (the observation already carries cooldowns, clocks and the previous action);
  imitation of the heuristic baseline (possible later, the decisions are stored); population or league methods.

**2. Bridge: one Node process per environment, length-prefixed frames over stdin/stdout** (`src/ipc/server.ts`,
`python/pokebonk_rl/bridge.py`). No socket exists, so "bind to loopback only" does not arise. Measured cost of the
pipe: about 12 % (357 decisions/s through the bridge against 405 in-process, one process, random policy).
- Not chosen: an in-process bridge (the game's shims are global to a Node process, Python would have to embed V8);
  sockets (nothing gained, and a port to guard).

**3. A vectorised environment of our own instead of Gymnasium's `SubprocVecEnv`** (`python/pokebonk_rl/vec_env.py`).
Each slot talks to its Node process directly, so there is one process per environment, not two. It adds what the
game's reset cost and memory growth require: spare processes that are reset in the background and swapped in when an
episode ends, and replacement of a process after 8 episodes. It implements Stable-Baselines3's `VecEnv` interface
(terminal observation, truncation flag, episode statistics, action masks), so the learner is used unchanged.
- Consequence: there is no single-environment `gymnasium.Env` class. The specification allows "Gymnasium adapter or
  justified alternative"; the spaces are Gymnasium spaces and the interface is the vectorised one the learner
  consumes. A single-environment wrapper would be a second code path nobody trains through.

**4. The reward is computed in Python from the game's own cumulative counters**, which the environment sends with
every step (`python/pokebonk_rl/reward.py`, `configs/reward-v0.yaml`). A reward version changes without touching the
environment or its hashes, and every component is stored per episode.

**5. Decisions on the CPU.** With 5 game processes the policy is asked for 5 actions at a time. Measured with this
network (1.4 M parameters): 392 decisions/s on the CPU against 252 on the GPU, where every small operation pays a
fixed launch cost. With 8 processes the CPU reaches 489 decisions/s. `device: cuda` remains a configuration value.
- Known cost: about 40 % of the loop's time is waiting for the game, 30 % computing actions, 20 % the PPO update.
  Computing actions on the CPU and updating on the GPU would need the learner to hold two copies of the policy; not
  done until the update is the bottleneck.

**6. Rewards are normalised by the running spread of returns** (`VecNormalize`, observations untouched: they are
already scaled by the encoder). Its statistics are part of every checkpoint.

## Consequences

- A model is tied to the observation and action layout hashes it was trained on; the trainer, the evaluator and the
  resume path refuse any other.
- Episode seeds of training are `first + k` for the run's k-th episode; which process plays which episode is not
  fixed, and does not matter (an episode depends on its seed, scenario and actions only).
- An evaluation is reproducible on this machine: the same model file on the same seeds gives the same episodes
  (tested with the most probable action). Across machines or library versions, floating-point differences in the
  network can change an action and with it an episode.
