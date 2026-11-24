# PokéBonk Offline Reinforcement Learning Agent

## Project Specification for Claude Code

**Status:** Initial implementation brief\
**Primary objective:** Build an agent that learns to play PokéBonk
through repeated offline training in a sandboxed environment, improving
its gameplay and build decisions over thousands of simulated games.

**Core implementation constraint:** The game will be run as a local copy
using **Node.js and TypeScript**. Training and evaluation will take
place offline in an isolated sandbox. Do **not** use Playwright, browser
automation, a live hosted game, or any external service to play or train
the agent.

------------------------------------------------------------------------

## 1. Project vision

Build a local training system that can:

1.  Run a local copy of the PokéBonk game using Node.js and TypeScript.
2.  Start, reset, step, and inspect simulated game episodes without a
    browser.
3.  Expose a reliable structured observation and action interface to an
    AI agent.
4.  Run thousands of games offline at accelerated speed.
5.  Train a reinforcement-learning policy using outcomes and reward
    signals.
6.  Evaluate candidate policies against repeatable benchmark scenarios.
7.  Save, restore, compare, and promote model checkpoints.
8.  Adapt to changes in Pokémon, moves, items, enemies, balance, and
    game versions without discarding useful previous learning.

The long-term goal is a strong general-purpose agent that can play
different Pokémon effectively, choose good moves and items, and develop
robust builds.

The first goal is not perfect play. It is a trustworthy, reproducible,
end-to-end training loop.

------------------------------------------------------------------------

## 2. Non-negotiable operating constraints

These requirements apply to all development, training, and evaluation
work.

### 2.1 Offline-only training

-   All gameplay used for training and evaluation must run locally.
-   Training must use a local copy of the game, not the live hosted
    game.
-   The training environment must not require internet access.
-   Do not send observations, actions, gameplay data, model weights, or
    training results to external services.
-   Do not use hosted inference, cloud training, remote APIs, or
    third-party gameplay services.
-   Claude Code may be used by the project owner as a development
    assistant, but the running agent must not depend on Claude or
    another external LLM API.

### 2.2 Sandboxed execution

Run the local game copy and training workers in a controlled, isolated
environment.

The sandbox should: - Have no network access by default. - Have access
only to the local game files, required runtime, project code, and
designated training-data/model directories. - Avoid access to personal
files, browser profiles, credentials, and unrelated system resources. -
Use explicit resource limits where practical. - Keep generated data and
checkpoints inside the project workspace. - Make it possible to stop or
terminate a training run without corrupting saved models.

Document the chosen sandbox mechanism. Suitable options may include a
dedicated local process/container or another OS-level isolation
approach. Do not assume a particular container runtime is installed;
inspect the development environment and recommend the simplest reliable
option.

If the game requires assets or dependencies, obtain and prepare them
before entering the offline training environment. The training runtime
itself must not fetch dependencies or contact external hosts.

### 2.3 No browser automation

-   Do not use Playwright.
-   Do not use Selenium, Puppeteer, browser remote debugging, or
    screenshot-driven browser control.
-   Do not automate the hosted website.
-   Do not use DOM interaction as the agent's gameplay interface.

The agent must interact directly with the local Node.js/TypeScript game
simulation through a programmatic interface.

### 2.4 Preserve game fidelity

The local copy must reproduce the actual game mechanics relevant to
gameplay. Do not replace the game with a simplified mock environment and
then treat its results as representative of the real game.

If parts of the game cannot be run outside a browser or depend on
rendering, identify those dependencies and isolate or replace only the
presentation layer where possible. Core game rules, timing, collision,
damage, progression, randomisation, and upgrade logic must remain
faithful.

Clearly document any differences between the local simulation and the
original game.

------------------------------------------------------------------------

## 3. Game-specific working assumptions

These assumptions were supplied by the project owner and must be
validated against the local game code.

-   The core gameplay loop and moment-to-moment mechanics are broadly
    shared across Pokémon.
-   Pokémon differ primarily in the moves they can learn or share, based
    on their type, and in which moves are optimal to select.
-   Most item builds are shared across Pokémon.
-   Type-boosting items may have different priorities depending on the
    Pokémon and its type.
-   A shared policy conditioned on Pokémon/type/move information is
    therefore the preferred starting point, rather than one independent
    model per Pokémon.

Do not treat these assumptions as confirmed until the game code has been
inspected. Record exceptions and character-specific mechanics.

------------------------------------------------------------------------

## 4. Recommended technical architecture

The game simulation should remain native to its existing
Node.js/TypeScript implementation. Do not rewrite the game engine in
Python merely to accommodate an RL library.

A likely architecture is:

``` text
                OFFLINE SANDBOX
+----------------------------------------------------+
|                                                    |
|  Node.js / TypeScript                              |
|  +----------------------------------------------+  |
|  | Local PokéBonk game copy                     |  |
|  |                                              |  |
|  | Game state / rules / RNG / progression       |  |
|  +----------------------+-----------------------+  |
|                         |                          |
|                 Structured API                     |
|            reset / step / observe                  |
|                         |                          |
|  +----------------------+-----------------------+  |
|  | Training bridge / episode runner             |  |
|  +----------------------+-----------------------+  |
|                         |                          |
|  Local IPC: stdin/stdout, sockets, or files       |
|  (choose after measuring reliability/performance) |
|                         |                          |
|  Python RL process (if selected)                  |
|  +----------------------------------------------+  |
|  | Gymnasium adapter                             |  |
|  | Policy / Trainer / Evaluator                  |  |
|  | PyTorch / Stable-Baselines3                   |  |
|  +----------------------+-----------------------+  |
|                         |                          |
|  Checkpoints / metrics / SQLite / logs             |
+----------------------------------------------------+
```

### 4.1 Technology defaults

  -----------------------------------------------------------------------
  Area                                Preferred starting point
  ----------------------------------- -----------------------------------
  Game simulation                     Existing Node.js + TypeScript game
                                      code

  Local game API                      TypeScript module or local process
                                      interface

  RL environment                      Gymnasium adapter, if using Python
                                      RL tooling

  RL library                          Stable-Baselines3, subject to
                                      algorithm suitability

  ML framework                        PyTorch, if using the Python route

  Experiment metrics                  TensorBoard

  Metadata/run history                SQLite

  Configuration                       YAML or TOML

  Tests                               Existing TypeScript test framework
                                      plus pytest if Python is used

  IPC                                 Start with the simplest reliable
                                      local interface; benchmark before
                                      optimising
  -----------------------------------------------------------------------

Claude Code must inspect the existing repository before selecting or
adding dependencies. Do not introduce Python if an effective
TypeScript-native training approach is more appropriate, but explain the
trade-offs. Do not port the game simulation out of TypeScript without a
compelling, measured reason.

### 4.2 Game simulation API

Create a stable programmatic interface around the local game.

Conceptually, it should support:

``` ts
interface GameEnvironment {
  reset(options?: ResetOptions): Observation;
  step(action: Action): StepResult;
  getObservation(): Observation;
  getMetadata(): GameMetadata;
  close(): void;
}
```

The actual types and return values must be designed after inspecting the
game code.

The interface should support: - Starting a new episode. - Resetting to a
known initial state. - Supplying a seed or controlled RNG state where
feasible. - Advancing the simulation by a defined action or number of
frames/ticks. - Returning structured observations. - Applying valid
player actions. - Detecting game over, victory, and other terminal
states. - Recording episode outcomes. - Running without graphical
rendering. - Running faster than real time where the game logic permits.

The interface must not expose mutable internal state in a way that lets
the agent accidentally bypass game rules. Provide observations as
read-only snapshots or serialised data.

### 4.3 Deterministic and accelerated execution

Investigate whether the game can run deterministically when given a
fixed seed.

Prefer: - A controllable random-number generator. - Fixed
simulation-step semantics. - No dependency on wall-clock timing. - A
headless mode that skips rendering and animation. - Fast-forward
execution that advances game logic without waiting for real time. -
Repeatable episode replay for debugging.

Do not change game logic merely to make training easier. If timing or
randomness must be abstracted, preserve the original rules and document
the implementation.

------------------------------------------------------------------------

## 5. Discovery phase: inspect the game before training

**Do not begin by implementing an RL model.**

First inspect the local Node.js/TypeScript game copy and establish:

1.  How the game starts and initialises.
2.  Which modules implement the actual game rules.
3.  How player input is represented.
4.  How movement, attacks, cooldowns, collision, damage, and enemy
    behaviour work.
5.  How progression, level-ups, move choices, and item choices work.
6.  How Pokémon-specific move compatibility and type effects are
    represented.
7.  How an episode ends and how a new episode starts.
8.  How random numbers are generated.
9.  Whether rendering can be disabled without changing game behaviour.
10. Whether the simulation can run faster than real time.
11. Whether the simulation can be stepped and observed programmatically.
12. Whether game version/build information is available.

Produce `docs/discovery.md` containing: - Repository structure relevant
to the game. - Important game modules and their responsibilities. -
Proposed observation schema. - Proposed action schema. - Episode
lifecycle. - Randomness and determinism findings. - Headless/accelerated
execution findings. - Differences or risks compared with the original
game. - Unknowns requiring further investigation.

Also produce an architecture decision record describing the proposed
game API and RL integration.

**Discovery exit criteria:** A small test program can instantiate the
local game, reset an episode, read a structured observation, perform a
valid action, advance the game, and detect a terminal state without a
browser.

------------------------------------------------------------------------

## 6. Agent design: shared gameplay with conditioned build decisions

The preferred starting point is one shared policy that receives Pokémon
and game context as part of its observation.

### 6.1 Two decision layers

Investigate a hierarchical policy with two conceptual layers.

**Low-level gameplay** - Movement and positioning. - Dodging and
avoiding damage. - Attacking or using available abilities. - Surviving
and navigating the active gameplay loop. - Responding to nearby enemies,
hazards, and objectives.

**High-level strategy** - Selecting moves. - Choosing move upgrades. -
Choosing items. - Prioritising type synergies. - Making longer-term
build decisions.

These can initially be handled by one policy with phase-aware
observations and action masks. Split them into separate policies only if
experiments show a clear benefit.

### 6.2 Pokémon conditioning

Include relevant character information in the observation, such as: -
Pokémon identifier. - Type or types. - Starting moves. - Available and
compatible moves. - Character-specific stats/passives, if present.

Use a representation that can generalise across characters. Do not rely
solely on arbitrary integer IDs if structured categorical features or
embeddings would be more suitable.

### 6.3 Move knowledge

Maintain a versioned move dataset containing, where applicable: - Stable
move identifier and display name. - Type. - Pokémon compatibility. -
Damage/effect details. - Cooldown or activation frequency. - Area,
range, and targeting behaviour. - Upgrade paths and synergies. - Game
version and source of the recorded data.

The policy should learn which compatible moves are useful in context. Do
not hard-code one fixed best build.

### 6.4 Item knowledge

Maintain a versioned item dataset containing: - Stable item identifier
and display name. - Effect and affected stats. - Type interactions or
type boosts. - Upgrade/evolution requirements. - Relevant synergies. -
Game version and source of the recorded data.

Start with shared item-selection behaviour, conditioned on Pokémon type
and current build.

### 6.5 Valid actions

Where possible, expose valid action masks for: - Move choices. - Item
choices. - Upgrade choices. - Other phase-specific decisions.

The agent should not be trained to choose options that are not currently
available if validity can be determined reliably.

------------------------------------------------------------------------

## 7. Observation and action design

The exact schemas must be based on the actual game implementation. Start
with the smallest useful observation and expand only when measurements
show the policy needs additional information.

Potential observation fields:

-   Game phase.
-   Player position, health, and relevant stats.
-   Nearby enemies, projectiles, hazards, and their positions.
-   Level, experience, score, elapsed simulation time, and progression.
-   Current Pokémon, type(s), and passive effects.
-   Current moves, move levels, and cooldowns.
-   Available choices at upgrade screens.
-   Current inventory and equipped items.
-   Relevant enemy or objective state.
-   Game version and scenario metadata.

Potential action categories:

-   Movement direction or movement vector.
-   Attack/ability inputs where applicable.
-   No-op/wait where valid.
-   Selection of an offered move, item, or upgrade.
-   Other inputs confirmed by the game implementation.

Avoid passing the entire internal game object to the model. Construct a
documented, bounded observation representation.

------------------------------------------------------------------------

## 8. Reward design

The reward function should encourage actual game success rather than
easily exploitable proxy behaviour.

Potential components, depending on available game telemetry: - Total number of KOs is the biggest contributor to positive score. Victory
or successful completion. - Meaningful progression. - Score or other
objective performance. - Damage dealt or objectives completed, if
useful. - Damage received, deaths, or avoidable failures. - Quality of
build decisions, only where this can be measured without hard-coding the
desired answer.

Requirements: 1. Prefer objective outcomes over arbitrary activity
rewards. 2. Do not reward repetitive actions that produce no meaningful
progress. 3. Do not let survival time dominate if it encourages passive
play. 4. Do not encourage reckless damage trading through poorly
weighted damage rewards. 5. Track each reward component separately. 6.
Keep held-out evaluation scenarios separate from reward tuning. 7.
Version the reward function and record its version for every run.

Do not finalise reward weights before inspecting the game and collecting
baseline results. Start with a transparent reward function and tune it
based on independent evaluation.

------------------------------------------------------------------------

## 9. Training plan

### Stage 0 --- Offline simulation discovery

Deliver: - `docs/discovery.md`. - Architecture decision record. -
Documented local game API proposal. - Proof-of-concept reset, observe,
act, and terminal-state detection. - Headless and accelerated execution
feasibility measurements. - Sandbox design.

**Exit:** A local episode can be run and controlled programmatically
without a browser or network.

### Stage 1 --- Environment foundation

Deliver: - Stable Node.js/TypeScript game environment API. - Headless
simulation mode. - Deterministic seeding where feasible. -
Observation/action schemas. - Episode runner. - Random-action
baseline. - Smoke and integration tests.

**Exit:** Many episodes can run unattended and produce structured
records.

### Stage 2 --- RL integration

Deliver: - Gymnasium adapter or justified alternative. - Initial
algorithm selection with reasoning. - Baseline reward function. -
Training script. - Checkpoint save/resume. - Experiment metrics. -
Independent evaluation script.

**Exit:** A short offline training run completes, saves a recoverable
model, and can be evaluated against a baseline.

### Stage 3 --- Shared gameplay policy

Train the common gameplay behaviour: - Basic control. - Positioning and
survival. - Consistent action execution. - Generalisation across
different game states.

Evaluate across multiple Pokémon as soon as practical.

### Stage 4 --- Build strategy

Improve: - Move selection. - Move upgrades. - Item selection. -
Type-aware item priorities. - Long-term build synergies.

Evaluate complete runs and build outcomes, not just immediate upgrade
rewards.

### Stage 5 --- Generalisation

Test: - Pokémon not heavily represented in training. - Different valid
move/item combinations. - Different random seeds. - Different enemy
patterns and difficulty states. - Unusual but valid game states.

Use curriculum learning or domain randomisation only when justified by
the real game mechanics. Keep evaluation on the actual current game
rules as the primary benchmark.

### Stage 6 --- Continuous offline improvement

Support: - Repeatable training jobs. - Candidate model evaluation. -
Candidate/stable comparisons. - Model promotion and rollback. -
Version-aware retraining after game changes.

------------------------------------------------------------------------

## 10. Game version and balance updates

Keep game knowledge separate from model weights.

Version the data for: - Pokémon and types. - Moves and compatibility. -
Items and effects. - Enemy types and behaviours. - Character stats and
passives. - Upgrade/evolution rules. - Game build/version. - Sources and
confidence.

When the local game copy is updated: 1. Record the new game version or
source revision. 2. Compare relevant game data and mechanics with the
previous version. 3. Identify changed, added, or removed Pokémon, moves,
items, and rules. 4. Run the existing stable model against the new
version's benchmark. 5. Fine-tune or retrain a candidate if needed. 6.
Test for regressions and catastrophic forgetting. 7. Promote only after
the candidate passes evaluation.

Preserve historical checkpoints and run data. Never overwrite the only
stable model.

Do not assume that the system can infer every change automatically. Use
version identifiers, source diffs, structured data comparisons, and
explicit review where required.

------------------------------------------------------------------------

## 11. Checkpoints, storage, and experiment tracking

Use local storage only.

Persist: - Model weights and checkpoints. - Training configuration. -
Evaluation results. - Per-episode summaries. - Game version/source
revision. - Reward-function version. - Random seeds. - Pokémon, moves,
and items selected. - Build decisions. - Key performance metrics. -
Error logs and diagnostic information.

Use SQLite for metadata and summaries initially. Store larger model
files and optional replay buffers on disk.

Suggested structure:

``` text
pokebonk-agent/
  README.md
  package.json
  pyproject.toml                 # only if Python training is selected
  .gitignore
  configs/
    default.yaml
    training.yaml
    evaluation.yaml
  docs/
    discovery.md
    game-mechanics.md
    architecture-decisions/
  game/                          # local Node/TypeScript game copy or adapter
  src/
    game-adapter/
    simulation/
    environment/
    observations/
    actions/
    knowledge/
    rewards/
    agents/
    training/
    evaluation/
    storage/
    dashboard/
  data/
    game-knowledge/
    runs/
  models/
    checkpoints/
    candidates/
    best/
    stable/
  logs/
  tests/
    unit/
    integration/
    smoke/
  scripts/
```

Adapt this structure to the existing repository rather than moving or
duplicating the game unnecessarily.

Do not commit model files, generated run data, secrets, credentials, or
local environment files to Git.

------------------------------------------------------------------------

## 12. Metrics and dashboard

A local dashboard is desirable after the training loop works.

Track: - Training episodes and steps. - Episodes per hour and simulation
steps per second. - Mean, median, and best evaluation performance. -
Win/completion rate, if applicable. - Average survival/progression. -
Performance by Pokémon. - Performance by game version. - Performance by
build, move, and item choices. - Reward components. - Current
training/evaluation status. - Latest checkpoint and stable model
identifiers.

Potential controls: - Start training. - Pause or stop gracefully. -
Resume from checkpoint. - Run evaluation. - Compare candidate against
stable. - View run history. - Watch a recorded simulation. - Promote or
roll back a model with confirmation.

The dashboard must not be required for training and must not be able to
overwrite the only stable checkpoint accidentally.

------------------------------------------------------------------------

## 13. Performance and hardware

Measure before optimising or purchasing hardware.

The most important performance metric is how many complete simulation
episodes can be run per hour.

Prioritise: 1. Headless execution. 2. Avoiding unnecessary rendering and
animation. 3. Efficient state observation and action application. 4.
Avoiding expensive serialisation or IPC in the inner loop. 5. Parallel
independent environments, if safe and beneficial. 6. GPU acceleration
only if model training is the bottleneck.

Structured, low-dimensional observations may train adequately on CPU.
Screenshot-based vision is explicitly out of scope for the initial
system.

Benchmark: - Simulation steps per second. - Episodes per hour. - CPU and
memory usage. - IPC overhead. - Training throughput. - Time spent in
simulation versus policy inference and learning.

If IPC becomes a bottleneck, consider an in-process bridge, batched
stepping, or another measured optimisation. Preserve a clean boundary
between game simulation and policy.

------------------------------------------------------------------------

## 14. Testing and reliability

### Unit tests

-   Observation conversion.
-   Action validation and translation.
-   Reward calculation.
-   Game knowledge lookups.
-   Version comparison.
-   Checkpoint metadata.
-   Metric aggregation.

### Integration tests

-   Game initialisation and reset.
-   Reading an observation.
-   Executing an action.
-   Major game phases.
-   Game over and terminal outcomes.
-   Repeated episode execution.
-   Checkpoint save and load.

### Training tests

-   Short training run completes.
-   Checkpoints are saved.
-   Training resumes.
-   Evaluation uses the requested model.
-   Candidate promotion requires passing evaluation.
-   Failed runs do not damage stable model files.

### Reliability requirements

-   Recover after interruption from the latest checkpoint.
-   Handle invalid actions safely.
-   Detect malformed or unknown observations.
-   Do not silently fabricate missing game state.
-   Log enough information to reproduce failures.
-   Keep simulation and model state consistent when stepping or
    resetting.

------------------------------------------------------------------------

## 15. Sandbox and network verification

The offline constraint must be enforced technically, not merely
documented.

Implement and test a sandbox configuration that: - Denies outbound and
inbound network access for training processes unless explicitly required
for local IPC. - Uses local-only IPC between the game process and
trainer. - Restricts filesystem access to the project and designated
data/model directories where practical. - Does not mount browser
profiles, home directories, SSH keys, or unrelated credentials. - Does
not invoke external APIs. - Does not download packages or game assets
during training. - Logs sandbox configuration and relevant run metadata.

Add a test or startup check that fails clearly if the training process
is configured to use a remote game endpoint or external inference
service.

If the selected IPC mechanism uses localhost networking, bind only to
loopback and document the restriction. Prefer stdin/stdout pipes or
in-process calls if they meet performance and reliability needs.

------------------------------------------------------------------------

## 16. Instructions for Claude Code

Work incrementally. Keep the project understandable and changes
reviewable.

### Before substantial implementation

1.  Inspect the existing repository and its package scripts.
2.  Identify the local game copy and its entry points.
3.  Trace the actual game rules, state, input, RNG, and episode
    lifecycle.
4.  Identify presentation/rendering code that can be separated from
    simulation.
5.  Complete Stage 0 discovery.
6.  Write `docs/discovery.md`.
7.  Write an architecture decision record.
8.  Propose the smallest viable end-to-end implementation plan.

### While implementing

-   Preserve the Node.js/TypeScript game implementation.
-   Do not use Playwright, Selenium, Puppeteer, or browser automation.
-   Do not connect to the hosted game.
-   Keep training and evaluation offline and sandboxed.
-   Do not use external LLM inference in the agent's gameplay loop.
-   Do not fabricate mechanics, moves, items, or game data.
-   Distinguish observed facts from assumptions and unknowns.
-   Add tests with each component.
-   Benchmark before adding complexity.
-   Keep configuration outside source code.
-   Do not silently change the observation schema, action mapping, or
    reward function.
-   Preserve stable models and historical run data.

If an important part of the local game copy cannot run headlessly, stop
and explain the dependency and options. Do not quietly fall back to
browser automation or a mock game.

### End-of-stage report

At the end of each stage, report: 1. What was implemented. 2. Files
created or changed. 3. Tests run and results. 4. Sandbox/network
isolation verification. 5. Performance measurements. 6. Limitations and
unresolved questions. 7. Recommended next stage.

------------------------------------------------------------------------

## 17. First task for Claude Code

**Start with discovery only. Do not implement the RL model yet.**

Inspect the local Node.js/TypeScript game copy and answer these
questions:

1.  Can the game rules run without a browser or renderer?
2.  What is the smallest reliable way to instantiate, reset, step, and
    observe a game?
3.  Can simulation time be advanced deterministically and faster than
    real time?
4.  What are the valid action types and decision phases?
5.  What data is needed to represent the game state without exposing the
    entire internal object?
6.  How are Pokémon, moves, items, types, and compatibility represented?
7.  How can complete episodes be run and recorded?
8.  What sandbox mechanism is available locally, and how will network
    access be denied?
9.  What is the likely bottleneck when running thousands of episodes?
10. What is the smallest proof of concept that validates the
    architecture?

Write the discovery report and propose a staged implementation plan.
Wait for review before making broad architectural changes.

------------------------------------------------------------------------

## 18. Initial definition of done

The first major milestone is achieved when:

-   A local Node.js/TypeScript copy of PokéBonk runs without browser
    automation.
-   Training and evaluation run offline in a sandbox with network access
    disabled.
-   The simulation can be reset, observed, and stepped programmatically.
-   A valid action can be applied by an external policy.
-   Complete episodes can be run repeatedly and recorded.
-   A Gymnasium-compatible interface or justified alternative is
    available.
-   A baseline agent can run multiple episodes.
-   A first RL training run can learn and save a checkpoint.
-   Evaluation can compare the trained model with the baseline.
-   Run metadata and game version are recorded.
-   The stable model is protected from accidental replacement.

The priority is a faithful, fast, reproducible offline simulation.
Training sophistication and performance optimisation come only after
this foundation works.
