# pokebonk-autoplay

An offline practice environment for PokéBonk (a free browser fan game, three.js/WebGL) and an AI player for it. A
local copy of the game runs **without a browser**, inside Node, as a deterministic environment. A rule-based player
(the *heuristic*) plays whole runs in it, every change to that player is measured over fixed seeds, and a learned
*manager* on top of it is trained with PyTorch.

**The goal:** Mewtwo, forest, tier 2, Ranked rules, game build `mwsewi0r` (0.10.26). Score = KOs plus the Overtime
bonus when it is cashed. Success is one run of 20 million or more in a single evaluation of the 50 held-out seeds.

**Offline by design.** Nothing here contacts the live game: no real account, no leaderboard, no other player. The
game processes and the trainer each refuse network connections in their own process and talk over pipes. `./mirror`
holds a copy of someone else's game for running it on your own machine; it is git-ignored and must not be published.

## Where it stands

Median, 90th percentile and best score of the heuristic's plans, one episode per game process, no learning:

| Plan | What it adds | Seeds | Median | p90 | Best |
|---|---|---|---|---|---|
| plan-3 (the default) | the phase 1 heuristic | 100 development | 1,465,290 | 4,158,466 | 8,031,427 |
| | | 50 held-out | 1,528,620 | 4,034,675 | 9,052,797 |
| plan-5 | items valued by what the score follows (luck, experience, Pokédollars) | 100 development | 4,821,770 | 8,287,315 | 11,201,881 |
| plan-6 | an item pool that stacks, a later cash-out, a later leave | 100 development | 7,430,752 | 9,221,229 | 10,899,768 |
| | | 50 held-out | 7,780,684 | 9,619,558 | 10,299,849 |

No run has reached 20 million. `docs/phase-3-report.md` has every measurement, including what failed: the first
PPO runs on top of plan-3 changed none of its choices, and what limits a run today is how long its build keeps
killing at the spawn ceiling in Overtime.

## How it is built

```
the game (mirror/, unmodified)
   └─ src/sim, src/environment     the headless environment: one game per process, reset(seed), step(action)
        ├─ src/bot/brain           movement: 16 headings scored every decision (dodging, terrain, goals)
        ├─ src/agents/heuristic2   the heuristic: a run plan (plan.ts), dialog answers (chooser.ts), item values (values.ts)
        ├─ src/hybrid              skills and the manager's view: the heuristic proposes, a model may override
        └─ src/runner, src/ipc     many episodes in parallel into SQLite; the pipe bridge to Python
python/pokebonk_rl                 PPO for the manager, copying the heuristic first, rewards, evaluation, model registry
```

- **A plan is data.** `plan-1` to `plan-6` live in `src/agents/heuristic2/plan.ts`; an old plan is never edited, a
  new one is added and measured. The same holds for rewards (`configs/reward-v*.yaml`), item archives and
  observation and action layouts: new versions only, old ones kept.
- **Seeds.** 1–30 are for tuning. 2000001–2000100 are development seeds nothing is chosen on: a change that wins
  on 1–30 is checked there. 900001–900050 are held out and are never tuned on.
- **One run's score is noisy** (its standard deviation is about three quarters of its mean), so nothing is
  concluded from a few runs. Reports give median, mean, p90 and best over a whole batch.

## Run it

Needs Node.js 24 or newer and Python 3.13. TypeScript runs directly: there is no build step.

```sh
npm install
npm run mirror                                        # once: the local copy of the game's public static files
npm run export:knowledge && npm run export:encoding   # once per game build: data tables and buffer layouts

# The heuristic over fixed seeds, into data/pokebonk.sqlite
node scripts/run-episodes.ts --policy=heuristic2 --episodes=30 --seed=1 --workers=10 \
  --species=150 --map=forest --tier=2 --max-time=7200 --archive=balanced --label=my-batch
# A named plan, with the item archive it was measured on
node scripts/run-episodes.ts --policy=heuristic2 --policy-options='{"plan":{"base":"plan-6"}}' \
  --episodes=30 --seed=1 --workers=10 --species=150 --map=forest --tier=2 --max-time=7200 --archive=stack-2 --label=my-plan-6

npm test && npm run typecheck                         # 197 tests
```

The learned manager (parked while the default plan is still improving):

```sh
python3.13 -m venv .venv && .venv/bin/python -m pip install torch && .venv/bin/python -m pip install -e '.[test]'
.venv/bin/python -m pokebonk_rl.bc collect --config configs/manager.yaml --seeds 1000000-1000039 --out data/bc/plan3
.venv/bin/python -m pokebonk_rl.bc fit --config configs/manager.yaml --data data/bc/plan3 --name manager-copy-01
.venv/bin/python -m pokebonk_rl.train --config configs/manager.yaml --name my-run --set manager.init_from=manager-copy-01
.venv/bin/python -m pokebonk_rl.evaluate --config configs/manager-evaluation.yaml --model my-run --seeds 1-30
.venv/bin/python -m pytest python/tests                # 48 tests
```

On Windows the Python commands are `py -3.13 -m venv .venv` and `.venv\Scripts\python -m …`. `device: cpu` is the
measured choice on an Apple-silicon Mac too. Do not edit `src/` while a batch is running: every episode starts a
fresh game process that loads the source as it is at that moment.

## Read more

| Read | For |
|---|---|
| `docs/phase-3-report.md` | the current work: rewards, the PPO runs, what limits a run, plans 5 and 6 |
| `docs/phase-0-report.md` to `docs/phase-2-report.md` | Overtime and its ceiling, the heuristic's first plans, the hybrid |
| `docs/environment.md`, `docs/fidelity.md` | the headless environment and how it was checked against the game in Chrome |
| `docs/game-mechanics.md`, `docs/game-knowledge.md` | what the game does, as verified, and the exported game data |
| `docs/hybrid.md`, `docs/training.md` | skills, the manager, rewards, training, evaluation, promotion |
| `docs/baseline.md`, `docs/storage.md`, `docs/dashboard.md` | the episode runner, the database, the training dashboard |
| `docs/browser-autopilot.md` | the older part: the sandbox host and the autopilot that plays in a real browser |

## Working on it

Changes go through pull requests: a branch per change, reviewed by Claude (`.github/workflows/claude-code-review.yml`,
with `REVIEW.md` as its guide) before it is merged into `main`. A change to how anything plays comes with a test and
with a measured batch on seeds 1–30; a change meant to become a default is also played on the development seeds.
