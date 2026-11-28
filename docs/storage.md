# Episode storage

One SQLite file, by default `data/pokebonk.sqlite` (`data/` is git-ignored; `--db=<file>` chooses another). It is
written by the parent process of the episode runner (`scripts/run-episodes.ts`, `src/runner/pool.ts`). Code:
`src/storage/database.ts` (`EpisodeStore`), record types in `src/storage/records.ts`, schema in
`src/storage/migrations/*.sql`. The file is plain SQLite 3 with no extensions and no custom functions.

## Conventions

- **Times** are ISO 8601 UTC text (`2026-11-23T18:41:07.123Z`). **Booleans** are `0` / `1`. Columns ending in `_json` hold
  JSON text (`json_extract(record_json, '$.end.by')` works in SQL; `json.loads` in Python).
- **Game time** is seconds of the run clock; **wall** times are seconds of real time. A *step* is one call of
  `env.step`; a *simulation step* is 1/`hz` s of game time (`hz` = 60, `action_repeat` = 3 unless a batch says otherwise).
- The connection uses `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 10000`. WAL means a reader does not block
  the runner; next to the file there are `-wal` and `-shm` files while it is open. Another writer should set
  `PRAGMA foreign_keys = ON` and a busy timeout too, and keep its transactions short.
- An episode and all its decisions are written in **one transaction**. A batch row is written when the batch starts
  (`status = 'running'`) and closed when it ends; a batch left at `running` belongs to a runner that was killed.
- Nothing is updated in place after a batch ended, and nothing is ever deleted by the runner. (By hand: a `label` may
  be rewritten to annotate a batch, as was done for the superseded batch 3 of `data/pokebonk.sqlite`, and a batch
  left at `running` by a killed runner may be deleted with its episodes, decisions and errors.)

## Schema versions and migrations

`schema_version (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)` has one row per applied migration. Migrations
are plain SQL files `src/storage/migrations/NNN_name.sql`, numbered without gaps; opening a database applies the missing
ones in order, each in its own transaction, and records them. A database with a higher version than the code knows is
refused ("update the code"), so an old runner cannot write into a newer file. The current version is **2**
(`001_initial.sql`: batches, episodes, decisions, errors; `002_training.sql`: tables of the reinforcement-learning
trainer that was removed on 2026-11-28. Nothing reads or writes them; the file stays because a migration that was
applied is never edited, and existing databases hold those tables with the old training runs in them).

To change the schema: add `003_….sql` (never edit an applied file), update this document and
`src/storage/records.ts` / `database.ts`.

## `batches`: one row per runner invocation

| Column | Type | Meaning |
|---|---|---|
| `id` | INTEGER PK | Batch id. |
| `started_at`, `finished_at` | TEXT | When the runner started / ended the batch. `finished_at` is NULL while it runs. |
| `status` | TEXT | `running` · `completed` (every seed played and stored, no error) · `failed` (at least one row in `errors`, or a seed without an episode) · `interrupted` (Ctrl-C). |
| `label` | TEXT NULL | Free text given with `--label`. |
| `policy_name` | TEXT | `random`, `idle`, `heuristic`. |
| `policy_version` | TEXT | `<version>+<12 hex digits>`: a hand-bumped version and a sha256 over the policy's source files (`src/runner/policies.ts` lists which). Same value = same policy code. |
| `config_json` | TEXT | The runner's configuration: `policy`, `policyOptions` (the policy's own settings, when given), `episodes`, `seed`, `seeds` (the list actually played), `workers`, `species`, `map`, `tier`, `ranked`, `maxGameTime`, `hz`, `actionRepeat`, `recycleAfter`, `recycleRssMB`, `episodeTimeoutSec`, `label`. |
| `game_build`, `game_version` | TEXT NULL | Build id in the bundle's file names (`mwsewi0r`) and the version its release list gives (`0.10.26`). NULL until the first worker has loaded the game (they stay NULL if no episode ever ran). |
| `bundle_sha256` | TEXT NULL | sha256 over the bytes of every loaded chunk of the game, in load order. |
| `shim_hash` | TEXT NULL | sha256 over the browser shims (`src/sim/*.ts`) and the DOM library version. |
| `observation_schema`, `action_schema`, `decision_schema`, `snapshot_schema` | INTEGER NULL | Schema versions of the environment interface (`src/environment/types.ts`). |
| `profile_preset` | TEXT NULL | The account preset the episodes were played on, as `getMetadata().profile.preset` reports it (e.g. `unlocked-v3`; docs/game.md §6). Player stats depend on it: compare results only within one preset (the report script enforces it, see "Reports"). The preset's content as the game confirmed it is in `metadata_json` under `profile.summary`. |
| `ranked` | INTEGER NULL | 1 = Ranked rules, 0 = Classic. |
| `hz`, `action_repeat` | INTEGER | Simulation steps per game second, and per decision. |
| `reward_version` | TEXT NULL | Version of the reward function. Always NULL: nothing defines a reward. |
| `host_json` | TEXT | `platform`, `release`, `arch`, `cpu`, `logicalCpus`, `totalMemoryMB`, `freeMemoryMB` (at batch start), `node`. |
| `metadata_json` | TEXT NULL | The whole `getMetadata()` of the batch's first worker: instrumentation points, shims, profile summary, season, offline guard, dialogs handled. Every later worker must agree with it on build, hashes, schemas and preset, or an error of kind `metadata-mismatch` is recorded. |
| `episodes_planned` | INTEGER | Number of seeds handed to the batch. |
| `episodes_done`, `error_count` | INTEGER | Rows in `episodes` / `errors` of this batch (kept current while it runs). |
| `wall_seconds` | REAL NULL | Wall time of the whole batch. |

## `episodes`: one row per finished episode

`UNIQUE (batch_id, seed)`: a batch plays a seed once. An episode is identified across batches by
(`species`, `map`, `tier`, `ranked`, `seed`) plus the batch's policy, preset and build.

| Column | Type | Meaning |
|---|---|---|
| `id` | INTEGER PK | Episode id. |
| `batch_id` | INTEGER FK | → `batches.id`. |
| `seed` | INTEGER | Episode seed (0 … 2³²−1). |
| `species`, `final_species` | INTEGER | Pokédex number the run started with, and at its end (evolution). |
| `map`, `tier`, `ranked` | TEXT, INTEGER, INTEGER | Map id, difficulty tier 0–2, Ranked (1) or Classic (0). |
| `end_cause` | TEXT | The environment's cause of end: `died`, `won (victory)`, `won (victory), overtime cashed`, `won (victory), overtime lost`, `truncated: game time reached the cap of N s`, `idle: no KO for N s of game time` (the rule against going without a KO), `idle: no KO and no movement for N s of game time` (the rule against standing still; such a run is invalid and counts as 0 ranked KOs; stored with `truncated` = 1). |
| `end_how` | TEXT NULL | The game's own `end.how` (`died`, `won`, …; docs/game.md §1.6). NULL when truncated: the run never closed. |
| `terminated`, `truncated` | INTEGER | Exactly one is 1. |
| `victory` | INTEGER | The game's `victory`: the map was cleared (legendary beaten or direct path taken). It says nothing about overtime. |
| `game_time` | REAL | Run clock at the end. |
| `kills` | INTEGER | KOs counted by the run (`run.stats.kills`), **without** any overtime bonus. |
| `overtime_started` | INTEGER | Overtime ran in this episode. |
| `overtime_bonus` | INTEGER | Bonus KOs overtime had accumulated at the end (`Σ round KOs × (multiplier − 1)`). It counts only when cashed. |
| `overtime_rounds` | INTEGER | Overtime rounds entered. |
| `overtime_cashed` | INTEGER | Overtime was cashed (portal, or round 24). KOs for the objective: `kills + CASE WHEN overtime_cashed THEN overtime_bonus ELSE 0 END`. What the real service counts for a lost overtime is unknown (docs/game.md §1.6). |
| `level` | INTEGER | Player level at the end. |
| `zone` | INTEGER | Zone the run ended in: 1–3, 4 = sanctuary / final arena. |
| `guardians_defeated` | INTEGER | Zone guardians beaten (0–3): the run's own count of guardians and legendaries minus the legendaries (`counters.guardiansDefeated − counters.legendariesDefeated`). |
| `legendaries_defeated` | INTEGER | 1 when the map's legendary fell. |
| `seals_kept` | INTEGER | Challenge seals kept in the run. |
| `steps`, `sim_steps` | INTEGER | Environment steps and simulation steps of the episode (loading phases excluded). |
| `decision_count` | INTEGER | Rows in `decisions` for this episode. |
| `wall_seconds`, `reset_seconds` | REAL | Wall time of the episode's steps, and of its `reset` (a worker's first reset includes loading the game). |
| `final_build_json` | TEXT | The build the run ended with, from the last observation (`observation.state.build`, move names and the stat block from its snapshot): `{ species, startSpecies, evoStage, passive, level, maxHp, moveSlots, moves: [{ slot, key, id, name, level, type, arch, cls, damageDone, fusion, linked }], vitaminSlots, vitamins: [{ key, level }], items: [{ key, count }], relics: [key], refreshes, skips, banishes, revives, stats: { damage, area, armor, … } }`. `moves[].id` is the id level-up offers use (`m<id>`); `damageDone` is the damage that move dealt in the run. |
| `counters_json` | TEXT | The run's cumulative counters at the end (`info.counters`, `src/observations/state.ts`), all the game's own figures: `time`, `kills`, `damageDealt`, `damageTaken`, `healed`, `hits`, `dodges`, `guardiansDefeated` (guardians **and** legendaries), `legendariesDefeated`, `alphasDefeated`, `totemsDefeated`, `summonersDefeated`, `zonesEntered`, `zonesCleared`, `level`, `itemsHeld`, `itemsPeak`, `movesLearned`, `evolutions`, `ultimatesUsed`, `goldEarned`, `goldSpent`, `ballsBought`, `captured`, `sealsKept`, `sealsBroken`, `overtimeBonus`, `overtimeRounds`. |
| `record_json` | TEXT NULL | The game's own end-of-run record as the local stand-in for the service stored it: `kills`, `time`, `level`, `stage`, `bosses`, `legendaries`, `splits` (run clock at each guardian's fall), `ot` (`t0`, `k0`, `secs`, `rounds`, `cashed`, `picks`), `seals`, `end` (`how`, `by`, `sp`, `swarm`, `hits`, `dodges`, `taken`, …) and more. NULL when truncated. |
| `blocked_network`, `blocked_network_json` | INTEGER, TEXT NULL | Network attempts the offline guard had blocked in the worker process by the end of the episode (count, and the list when not empty). Expected: 0. |
| `worker_id`, `worker_pid`, `worker_episode` | INTEGER | Which worker process played it (numbered 1, 2, … per batch in start order), its PID, and the episode's number in that process's life (1 = first after loading the game). |
| `worker_rss_mb` | INTEGER | Resident memory of the worker after the episode. |
| `started_at`, `finished_at` | TEXT | Wall-clock start (before reset) and end. |

## `decisions`: every answered dialog

One row per decision of an episode, whatever the policy: level-up picks, items, blessings, seals, the sanctuary path,
overtime … (kinds: docs/game.md §4, docs/environment.md §4). `UNIQUE (episode_id, serial)`.

| Column | Type | Meaning |
|---|---|---|
| `id` | INTEGER PK | |
| `episode_id` | INTEGER FK | → `episodes.id`. |
| `serial` | INTEGER | Number of the decision in its episode, from 1 (`Decision.serial`). A refresh or banish re-opens the dialog: that is a new decision. |
| `step` | INTEGER | Environment step at which it was answered. |
| `game_time`, `zone`, `level` | REAL, INTEGER, INTEGER | Run clock, zone and player level when it was raised. |
| `kind` | TEXT | `levelup`, `evolution`, `item`, `itemChoice`, `blessing`, `seals`, `sanctuaryPath`, `leaveSanctuary`, `overtimeStart`, `overtimeOffer`, `trade`, `shop`, `ditto`, `party`, `shinySwap`, `relic`, `dojo`, `slots`, `forget`, `fusion`. |
| `method` | TEXT | The HUD method the game called (`showLevelUp`, …). |
| `options_json` | TEXT | The options as offered: `[{ id, label, data }]` (`data` is the game's own option object, copied). |
| `context_json` | TEXT | Dialog-wide facts: uses left, prices, who is asking. |
| `mask_json` | TEXT | Which options and extra actions were valid: `{ phase: 'choice', options: [bool], extras: { name: bool \| [bool] } }`. |
| `chosen_json` | TEXT | The action given: `{ type: 'choice', option: i }` or `{ type: 'choice', extra, target? }`. |
| `chosen_id` | TEXT | The same in words, for SQL: the option's `id` (`upMove:m915`, `none`, `sanct`), or `extra:<name>` / `extra:<name>><target option id>`. |

## `errors`: everything that went wrong in a batch

A batch with a row here ends with status `failed` and the runner exits with code 1. Nothing is retried.

| Column | Type | Meaning |
|---|---|---|
| `id` | INTEGER PK | |
| `batch_id` | INTEGER FK | → `batches.id`. |
| `episode_id` | INTEGER FK NULL | The stored episode the error is about, when there is one (normally NULL: a failed episode is not stored). |
| `seed` | INTEGER NULL | The seed that was lost, when known. |
| `worker_id` | INTEGER NULL | The worker process involved. |
| `kind` | TEXT | `episode-error` (the episode threw: the worker reported it and exited) · `worker-timeout` (no result within `episodeTimeoutSec`: killed) · `worker-exit` (the process died by itself) · `worker-start` (it never became ready) · `metadata-mismatch` · `runner` (the parent itself). |
| `occurred_at` | TEXT | |
| `message` | TEXT | First line of the error. |
| `details_json` | TEXT | `stack`; `environment` (the details object of an `UnknownSituationError`: seed, step, run state and time, HUD method, arguments …); `seedReportedByWorker`; the batch's `policy`, `species`, `map`, `tier`; `workerOutput` (tail of the process's stderr / stdout); `lastProgress` (step, game time, KOs, zone a few seconds before); `episodesPlayedByWorker`; `timeoutSec`, `code`, `signal` where they apply. |

## JSONL (optional)

`--jsonl[=<folder>]` additionally writes `<folder, default data/runs>/<timestamp>/episodes.jsonl`, one JSON object per
episode (`policy` plus the `EpisodeRecord` of `src/storage/records.ts`, decisions included), and `metadata.json` (the
environment's metadata). `--no-db` turns the database off.

## Reports

`npm run dashboard` (`scripts/dashboard.ts`) serves the batches on a local page, `http://127.0.0.1:8090`: every batch
with its state, runs played and median, mean, p90 and best ranked KOs; the runs of one batch; and one batch against
another on the seeds both played. It opens the database read-only and refreshes while a batch is being played. A
batch whose runner was killed stays marked `running`, because the runner writes a batch's end only when it ends by
itself: the page says so when no run of such a batch has finished for 100 minutes.

`node scripts/baseline-report.ts [--db=<file>] [--batches=1,2,3] [--label=<text>] [--preset=<name>] [--markdown] [--decisions] [--ends]`
prints the summary of each batch: KOs, KOs with the cashed overtime bonus, game time and level (mean, median, min,
max), zones reached, guardians beaten, legendary / overtime counts, causes of end, errors; with `--decisions` the
dialog kinds met; with `--ends` where in the lifecycle the episodes ended (which fight was lost, or before which wake),
the level at which each guardian was woken (a wake is a `seals` decision answered with a set of seals) and what the
game's end record names as the last hit (`record_json.end.by`).

**Presets are never mixed silently.** Every line and table row names the batch's `profile_preset`. When the selected
batches were played on more than one preset the script prints nothing and exits with code 2, naming the presets and
their batches; `--preset=<name>` selects one, `--all-presets` prints one section per preset. A batch whose workers
disagree on the preset (or build, hashes, schemas) gets a `metadata-mismatch` row in `errors`.

`node scripts/compare-batches.ts --a=<id> --b=<id> [--db=<file>] [--verbose]` compares two batches seed by seed: every
column of `episodes` except the ones that say where and how fast it was played (`id`, `batch_id`, `wall_seconds`,
`reset_seconds`, `worker_id`, `worker_pid`, `worker_episode`, `worker_rss_mb`, `started_at`, `finished_at`) and every
decision row. It refuses batches that were not played the same way (policy version and options, build, hashes, preset,
rules, rates, species, map, tier, time cap). Exit code 0 = identical, 1 = different, 2 = not comparable. With
`--refactor` the two batches may have been played by different code of this repository (policy name, version and
options, and the hash of the environment's source files, which are printed): that is the replay of a refactor. The
game's build and bundle, the schemas, the preset and the rules must still match.
