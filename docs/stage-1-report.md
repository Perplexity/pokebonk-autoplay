# Stage 1 report: environment foundation

Game build `mwsewi0r` (0.10.26), account preset `unlocked-v3`, Ranked rules, 60 Hz, action repeat 3.
Written 2026-11-24. Every number below was measured on this machine (Ryzen 5 7500F, 16 GB) and is either
re-run by the coordinator or taken from a stored batch in `data/pokebonk.sqlite`.

## 1. What was implemented

- **Headless environment.** The unmodified game bundle runs in Node under shims; `reset / step / getObservation /
  getMetadata / close`; phases play, choice, over; 20 dialog kinds as structured decisions with action masks;
  anything unknown raises `UnknownSituationError` (docs/environment.md).
- **Ranked run, everything unlocked.** Zones 1–3, sanctuary, legendary, overtime; fresh account with all Pokémon,
  items, upgrades, friendship, research and the complete shiny collection (docs/game-mechanics.md §6).
- **Reproducibility.** Same seed, same episode, in a fresh or a reused process and on any number of workers. Four
  causes of history dependence were found and removed (docs/environment.md §3).
- **Knowledge export.** Species, moves, items and vocabularies read from the bundle, versioned by build
  (docs/game-knowledge.md).
- **Observation encoding v1 and action codec.** 5,651 floats + 163 category ids; actions `[9,2,2,2,2,73]`, mask
  length 90 (docs/observation.md).
- **Fidelity check against Chrome**, used only as an oracle (docs/fidelity.md).
- **Runner and records.** Worker processes, one SQLite writer, batches / episodes / decisions / errors
  (docs/storage.md).
- **Baselines.** Idle, random and a rule-based heuristic (docs/baseline.md).

## 2. Files

| Area | Where |
|---|---|
| Shims and loader | `src/sim/` |
| Service stand-in | `src/sandbox/` |
| Environment, dialogs, profile preset | `src/environment/` |
| Knowledge export | `src/knowledge/`, `scripts/export-knowledge.ts`, `data/game-knowledge/mwsewi0r/` |
| Observation and actions | `src/observations/`, `src/actions/`, `scripts/export-encoding.ts`, `data/encoding/` |
| Fidelity oracle | `src/fidelity/`, `scripts/fidelity/`, `data/fidelity/` |
| Runner, storage, baselines | `src/runner/`, `src/storage/`, `src/agents/heuristic/`, `scripts/run-episodes.ts`, `scripts/baseline-report.ts`, `scripts/compare-batches.ts` |
| Tests | `test/` |
| Documents | `docs/` (environment, game-mechanics, game-knowledge, observation, fidelity, storage, baseline, ADR 0001) |

## 3. Tests

`npm test`: 152 passing, 0 failing (55 s). `npm run typecheck`: clean. Both re-run by the coordinator after the last
change.

## 4. Isolation

- All 237 stored episodes (9.06 M simulation steps) record 0 blocked network attempts; so do the coordinator's four
  replayed episodes.
- The fetch router serves only files under `mirror/` and the in-process service stand-in; anything else is refused and
  counted. The guard has a self-test and a configuration check (`test/env/guard.test.ts`).
- Chrome was used for the fidelity comparison only, against the local mirror, never as the gameplay interface.
- Deviation from spec §15, recorded in ADR 0001: no OS-level sandbox; the guard is in-process.

## 5. Performance

Heuristic policy, full episodes, machine shared with other work (lower bounds):

| Workers | Simulation steps/s (3 per decision) | × real time | Episodes/hour |
|---|---|---|---|
| 1 | 845 | 14 | 76 |
| 3 | 1,690 | 28 | 151 |
| 5 | 2,389 | 40 | 204 |
| 6 | 2,011 | 34 | 180 |

A reset takes 2.6–4.1 s. A worker grows about 25–40 MB per episode and is replaced after 8 episodes.

## 6. Results

**Reproducibility, checked by the coordinator.** Seeds 12, 9, 2 and 5 of the heuristic baseline, replayed with 2
workers in another order: all episode columns and all 195 decision rows equal the stored baseline (5 workers). Two of
the four are complete runs (legendary beaten, overtime cashed).

**Fidelity.** With the known differences equalised, 14 episodes (239,746 steps) are bit-identical to Chrome 157,
including 535 dialogs of 12 kinds and the end-of-run record.

**Baselines (Cyndaquil, forest, tier 0, seeds 1–30).**

| | idle | random | heuristic |
|---|---|---|---|
| KOs mean / median / max | 375 / 306 / 1,007 | 5,999 / 1,092 / 29,033 | 3,475 / 3,349 / 7,413 |
| Complete runs (overtime cashed) | 0 | 0 | 4 |
| Zone reached 1 / 2 / 3 / 4 | 30 / 0 / 0 / 0 | 30 / 0 / 0 / 0 | 3 / 19 / 4 / 4 |

The random policy's mean is carried by 8 episodes that survive in zone 1 past the 600 s zone clock into the final
swarm (12,679–29,033 KOs each) without ever leaving zone 1.

## 7. Limitations and open questions

Not covered:
- Tiers 1–2 and seven of the ten maps were not played by any batch.
- The direct sanctuary path, overtime's 24-round end and the zone collapse were not reached without cheats.
- The shiny-swap and relic dialogs never appeared in real play; their handling is tested against a stand-in only.
- Dojo, slot machine, move tutor and fusion machine can only be left; shop selling, Max form and incense are not in
  the action space.
- The fidelity comparison did not reach zones 3–4.

Open questions for the owner:
1. **KOs against completing the run.** Staying in a zone's final swarm yields more KOs than finishing the run. How
   much should finishing be worth? Stage 2 starts with KOs as the largest term plus milestone bonuses sized so a
   complete run beats camping; the reward is versioned, so this can change.
2. **Lost overtime.** The game's banner says the victory stays "without the extra"; a profile tooltip says "its KOs
   are voided". Which should the reward assume? Stage 2 starts with: KOs count, the bonus does not.
3. **Max form and incense** are not in the action space. Add them?
4. **`data/game-knowledge/` and `data/encoding/`** are git-ignored (they contain game texts), and two tests need
   them to exist. Version them or keep them generated?
5. **48 option slots** per decision is a chosen limit; a Ditto list longer than that raises an error instead of
   being cut.

## 8. Recommended next stage

Stage 2: Python 3.12/3.13 with PyTorch, Stable-Baselines3 and Gymnasium; a Gymnasium adapter over stdin/stdout pipes
to Node workers; masked PPO; reward v0; checkpoints and resume; TensorBoard; independent evaluation; stable-model
protection.
