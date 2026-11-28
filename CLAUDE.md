# pokebonk-autoplay

A local copy of a browser game runs headless as a deterministic environment, and a rule-based player (`src/player`)
plays whole runs in it. The player is the product: it is improved by rules and data, measured over fixed seeds.
`README.md` has the layout, the commands and where the project stands; `docs/player.md` has the loop for changing
the player.

## Rules that always hold

- **Offline only.** Nothing contacts the live game or any external service at run time. Nothing is written under
  `mirror/`. No mock of the game. `npm run mirror` and `scripts/mirror-sprites.ts` download the game's public files:
  only the owner runs them, never an assistant.
- **Rules are general, data is specific.** Nothing in a rule assumes one Pokémon, map or tier: a Pokémon's build, the
  vitamins, the item archive and every threshold are data of the plan (`src/player/plan.ts`).
- **A new version, not an edit.** A change to how the player plays that is kept becomes a new plan version; the one
  before leaves the code and its figures stay in `docs/results.md`. A change that must not alter play (a refactor)
  shows a replay: the same seeds give the same episodes, decision for decision.
- **Seeds.** 1–30 are for tuning. Development seeds are for checking a change once, and nothing is chosen on them:
  3000001–3000100 now (2000001–2000100 are tuning seeds since a setting was chosen on them). 900001–900050 are held
  out: never tune on them. Seed 900038 is spent (a stall was diagnosed on it): give held-out results with and
  without it. A set that a choice was made on stops being a check: say so and name the next one.
- **Measure before concluding.** One run's ranked KOs (its KOs plus the Overtime bonus: what the leaderboard shows)
  have a standard deviation of about three quarters of their mean. A
  change to how anything plays is judged on a whole batch on the same seeds and code for both sides, and reported
  with median, mean, p90 and best.
- **A test for every change.** `npm test`, `npm run typecheck`.
- **Do not edit `src/` while a batch is running** from the same checkout: every episode starts a fresh game process
  that loads the source as it is at that moment. Use a second working copy (`git worktree`).
- **A branch per change and a pull request**; nothing goes straight to `main`. The review workflow merges a pull
  request its reviewer calls ready.

## Reviewing a pull request

Review as a senior engineer who measures before concluding, and follow `REVIEW.md`: it says what to look for in this
repository, in which order, how to write the review, and what the verdict does.
