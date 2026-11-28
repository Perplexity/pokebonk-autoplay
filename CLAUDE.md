# pokebonk-autoplay

A local copy of a browser game runs headless as a deterministic environment; a rule-based player (the heuristic,
`src/agents/heuristic2`) plays whole runs in it and a learned manager (`python/pokebonk_rl`) is trained on top.
`README.md` has the layout, the commands and where the project stands.

## Rules that always hold

- **Offline only.** Nothing contacts the live game or any external service at run time. Nothing is written under
  `mirror/`. No mock of the game.
- **Versions, not edits.** Observation layouts, the action table, rewards (`configs/reward-v*.yaml`), account presets
  and item archives, and the heuristic's plans (`plan.ts`) are versioned: add a new one, keep the old ones as they
  were. A change that makes an existing plan play differently must say so and show the replay.
- **Seeds.** 1–30 are for tuning. Development seeds are for checking a change once, and nothing is chosen on them:
  3000001–3000100 now (2000001–2000100 were that until one setting of plan-7 was chosen on them: for plan-7 and later
  they are tuning seeds). 900001–900050 are held out: never tune on them. Seed 900038 is spent (a stall was
  diagnosed on it): give held-out results with and without it. A set that a choice was made on stops being a check:
  say so and name the next one.
- **Measure before concluding.** One run's score has a standard deviation of about three quarters of its mean. A
  change to how anything plays is judged on a whole batch on the same seeds and code for both sides, and reported
  with median, mean, p90 and best.
- **A test for every change.** `npm test`, `npm run typecheck`, `.venv/bin/python -m pytest python/tests`.
- **Do not edit `src/` while a batch is running:** every episode starts a fresh game process that loads the source
  as it is at that moment.
- **A branch per change and a pull request**; nothing goes straight to `main`. The review workflow merges a pull
  request its reviewer calls ready.

## Reviewing a pull request

Review as a senior machine learning engineer and programmer, and follow `REVIEW.md`: it says what to look for in
this repository, in which order, how to write the review, and what the verdict does.
