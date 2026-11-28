# pokebonk-autoplay

A rule-based player for PokéBonk (a free browser fan game), and the offline environment it plays in. A local copy of
the game runs **without a browser**, inside Node, as a deterministic environment: the same seed gives the same run.
The player plays whole runs in it, and every change to the player is measured over fixed seeds before it is kept.

**The goal:** the top of the game's KO leaderboard, where the best runs stand at 30 to 32 million KOs. A run's
**ranked KOs** are what that leaderboard shows: its own KOs plus the Overtime bonus when Overtime is cashed (the
game's "score" is another, larger number, and is not used here). Measured for Mewtwo, forest, tier 2, Ranked rules,
game build `mwsewi0r` (0.10.26), on 50 held-out seeds; 20 million is a waypoint.

**Offline by design.** Nothing here contacts the live game: no real account, no leaderboard, no other player. Every
game process refuses network connections. `./mirror` holds a copy of someone else's game for running it on your own
machine; it is git-ignored and must not be published.

## Where it stands

The best run stands at 15.0 million ranked KOs: half of what the top of the leaderboard reaches.

| Plan | What it added | Seeds | Median ranked KOs | p90 | Best |
|---|---|---|---|---|---|
| plan-3 | errands, seals, the final swarm fought by the portal | 100 development | 1,465,290 | 4,158,466 | 8,031,427 |
| plan-5 | items valued by what the KO count follows (luck, experience, Pokédollars) | 100 development | 4,821,770 | 8,287,315 | 11,201,881 |
| plan-6 | an item pool that stacks, a later cash-out, a later leave | 100 second development | 7,838,016 | 9,514,985 | 11,345,601 |
| plan-7 | vitamins by phase, changed at Hypno before the final stage | 100 second development | 11,373,575 | 12,446,802 | 12,979,411 |
| plan-8 | the leaderboard build: one fusion, two linked pairs, Encore | 100 second development | 13,803,730 | 14,467,683 | 15,039,733 |
| plan-9 | a cleared zone is no longer left before its final swarm | 100 second development | 13,884,013 | 14,560,342 | 15,039,733 |

`docs/results.md` has every figure, what was tried and was worse, and what ends a run today: from Overtime's
minute 8 the game makes enemy HP grow ×48 a minute and the tide ×4, and the player arrives there with about a
tenth of the max HP of a leaderboard run.

## How it is built

```
the game (mirror/, unmodified)
   └─ src/sim, src/environment   the headless environment: one game per process, reset(seed), step(action)
        ├─ src/observations      what the player sees: the surroundings (snapshot) and the run (state)
        ├─ src/player            the player: the plan, a Pokémon's build, dialog answers, the run's lifecycle
        │    └─ brain/           movement and fighting: sixteen headings scored at every decision
        ├─ src/runner            many episodes in parallel, each in its own process
        └─ src/storage           every episode and every answered dialog, in SQLite
src/dashboard                    the batch page: the database's batches, read-only, on a local page
src/knowledge                    the game's own tables (Pokémon, moves, items) exported as JSON
src/sandbox                      the tool that makes the local copy; the local stand-in for the game's service
src/fidelity, src/cdp            the same episode in a real local Chrome, to check the headless environment
```

- **The plan is data** (`src/player/plan.ts`): every threshold, the vitamins by phase, and a build per Pokémon. A
  rule never names a Pokémon, a map or a tier.
- **A change is measured.** One run's ranked KOs are noisy (the standard deviation is about three quarters of the mean),
  so a change is judged on a whole batch: 1–30 are tuning seeds, 3000001–3000100 check a change once, and
  900001–900050 are held out.
- **A kept change is a new plan version**; the one before leaves the code and its figures stay in `docs/results.md`.

## Run it

Needs Node.js 24 or newer. TypeScript runs directly: there is no build step.

```sh
npm install
npm run mirror -- --deep && node scripts/mirror-sprites.ts   # once: the local copy of the game's public files
npm run export:knowledge                                     # once per game build: the game's data tables

# The player over fixed seeds, into data/pokebonk.sqlite (about an hour on a laptop)
node scripts/run-episodes.ts --policy=player --episodes=30 --seed=1 --workers=10 --species=150 --map=forest --tier=2 \
  --max-time=7200 --label=my-batch
node scripts/baseline-report.ts --label=my-batch             # median, mean, p90, best, where runs ended

# Every batch on a local page: what is playing, its figures, its runs, one batch against another
npm run dashboard                                            # then open http://127.0.0.1:8090

# One run with a readable trace: the zone's state, every intent, every answered dialog
node scripts/trace.ts --seed=1

# One key of the plan changed for a batch or a trace
node scripts/trace.ts --seed=1 --plan='{"leaveHp":0.5}'

npm test && npm run typecheck
```

`npm run mirror` and `scripts/mirror-sprites.ts` are the only commands that download anything from the game's site
(plain static files). Do not edit `src/` while a batch is running from the same checkout: every episode starts a
fresh game process that loads the source as it is at that moment.

## Read more

| Read | For |
|---|---|
| `docs/player.md` | how the player works, what it does not do yet, and the loop for changing it |
| `docs/results.md` | what has been measured, what was tried and was worse, what ends a run today |
| `docs/game.md` | what the game does, each fact marked as verified, read in its code, or unknown |
| `docs/game-updates.md` | taking a new version of the game |
| `docs/environment.md`, `docs/observation.md`, `docs/snapshot.md` | the headless environment and what an observation holds |
| `docs/game-knowledge.md`, `docs/storage.md` | the exported game data; the episode database |
| `docs/fidelity.md` | how the headless environment was checked against the game in Chrome |

## Working on it

Changes go through pull requests: a branch per change, reviewed by Claude (`.github/workflows/claude-code-review.yml`,
with `REVIEW.md` as its guide). A pull request the reviewer calls ready is merged into `main` by the workflow; one it
does not is left open with its findings. `CLAUDE.md` has the rules that always hold.
