# Training dashboard

A local page over the episode database and the model registry: what was trained, how it scores, and the buttons to
train, stop, resume, evaluate, watch, promote and roll back. It implements §11 of the specification ("Metrics and
dashboard"), the lightweight version. Built with React, TypeScript and Tailwind (`dashboard/src`), served by a small
Node server without dependencies (`dashboard/server`).

```sh
npm run dashboard:install     # once: the page's packages (React, Vite, Tailwind), into dashboard/node_modules
npm run dashboard:build       # once, and after changing the page: dashboard/dist
npm run dashboard             # http://127.0.0.1:8090
node dashboard/server/main.ts --port=9000 --db=<file> --models=<folder> --python=<executable> --budget=12
npm run dashboard:dev         # while working on the page: hot reload on :5173, /api passed on to :8090
```

The root project still has no runtime dependency: the page is a package of its own under `dashboard/`, and the
server uses only what Node ships (`node:http`, `node:sqlite`, `node:child_process`).

## 1. What it shows

| Specification | Where |
|---|---|
| Total training episodes, training steps | Overview, the line of figures |
| Mean, median and best evaluation performance | Overview "Latest evaluation"; Evaluations (list and one evaluation) |
| Win / completion rate | every summary: "Runs completed" (the game's `victory`) |
| Average survival / progression | Overview "Survival and progression": game time, level, zone reached, guardians |
| Performance by Pokémon | Breakdowns "By Pokémon" |
| Performance by game version | Breakdowns "By game version" |
| Performance by build / move / item choices | Breakdowns "By what the run ended with" and "What was picked in dialogs" |
| Reward components | Overview "Reward components" (per episode, over the run); one episode's own on its page |
| Training throughput | Overview "Throughput": decisions a second, episodes an hour |
| Latest checkpoint and stable model identifiers | Overview figures; the run's route; Models |
| Current training / evaluation status | the lamp in the header and the sentence under the run's name |

- **Score** everywhere is KOs plus the overtime bonus when it was cashed: what the ranking counts and what a model
  is promoted on (docs/training.md §5). A run ended for going 30 game seconds without a KO (docs/training.md §3, "Standing still")
  is invalid and scores 0; the Overview and every evaluation count them.
- **The run's route** (Overview) draws the run as a track: every checkpoint a stop, evaluations pinned above the
  stop they were made at (median score, coloured by verdict), registered models named below. A stop can be selected
  to evaluate it, watch it play or register it as a candidate.
- **Score per training episode**: one dot per episode, the median of each stretch of the run as a line, and the
  median scores of the scripted baselines on the same Pokémon, map and tier as level lines. Training episodes are
  played with sampled actions on other seeds than the baselines; the chart says so. It is a direction, not a verdict.
- **By what the run ended with** compares the median score of the episodes that ended holding a move, vitamin, item
  or relic with those that did not. It is an association: a long run collects more of everything. The page says so.
- **Dialog answers** exist for scripted batches and evaluations; training episodes store them only with
  `store_decisions: true`.
- Every chart has a table behind "Show as a table".

## 2. What it can do

Every button ends in one of the project's own command lines. The dashboard has no code that trains, evaluates,
registers, promotes or rolls back.

| Button | Command | Checks before it is started |
|---|---|---|
| Start a training run | `python -m pokebonk_rl.train --config configs/training.yaml --name … --timesteps … --set workers.envs=… --set workers.spares=…` | name unused and well-formed; processes within the budget |
| Stop and save a checkpoint | writes `models/runs/<run>/STOP` (docs/training.md §4, "Stopping") | the run is training |
| Resume training | `… train --resume <run> [--timesteps <higher total>]` | a checkpoint exists; not training; a finished run needs a higher total |
| Run an evaluation | `… evaluate --model <run \| candidate:<id> \| stable \| checkpoint folder> [--seeds … --reference …]` | the model is one the database knows; processes within the budget |
| Evaluate against the stable model (Models) | `… evaluate --model candidate:<id>` (the promotion rule names the reference: the stable model when there is one) | as above |
| Two evaluations side by side (Evaluations) | none: read from the database | |
| Register as a candidate | `… registry register --model <checkpoint folder>` | the checkpoint is in the database |
| Promote | `… registry promote --candidate <id> --yes` | the words `promote <id>` typed; a passed verdict as the candidate's newest |
| Roll back to it | `… registry rollback --to <id> --yes` | the words `roll back to <id>` typed; the model is a retired stable one |
| Watch it play / Watch it again | `… watch --model … --seed … --speed …` | one game process within the budget |

- **A model is never named by a path from the page.** The request carries a run name, `stable`, `candidate:<id>` or
  `checkpoint:<id>`; the folder comes from the database.
- **Game processes are budgeted** (`--budget`, default 12: memory is the limit). A job that would exceed it is
  refused with the name of what is using them, including a training run started in a terminal.
- **Jobs outlive the page and the server.** Training and evaluation are started detached; their output goes to
  `logs/dashboard/job-NNNN-<kind>.log`, the list of started jobs to `data/dashboard/jobs.json`. "Started from this
  dashboard" on the Overview shows each with the end of its output.
- **Status of what was started elsewhere** comes from the database: a session marked `running` counts as training
  while its newest episode or checkpoint is less than ten minutes old. An older one is reported as left behind by a
  trainer that ended without saying so.
- **Stopping is not pausing a process.** The trainer finishes the step it is in, writes a checkpoint of kind
  `interrupt` and exits; "Resume" continues from it. The trainer removes a `STOP` file left by an earlier session
  when it starts (before this, a resumed run would have stopped at its first step).

### Watching (`python/pokebonk_rl/watch.py`)

- One game process of its own plays an episode with a stored model; the bridge is asked for a top-down view of
  every moment (`init` with `view: true`, `viewOf` in `src/ipc/server.ts`: positions, hit points, the open dialog,
  read from the frozen observation). The watcher prints a JSON line per frame, the server passes them to the page as
  server-sent events, the page draws them on a canvas: the player in the middle, north up, 46 m to each side.
- **Live** means: played now, by the model you chose. Training processes cannot be looked into; to see what a run
  has learned so far, watch its newest checkpoint.
- **Recorded** means: played again. An episode of an evaluation is watched from its own model file and seed, with the
  most probable action, which gives the same episode (docs/training.md §5); the page compares KOs and game time
  with the stored row when it ends. Nothing is recorded to disk.
- **The button on an episode's page** starts the game and opens this view in one press. For an evaluation's episode
  it is the replay above ("Watch the replay"). A **training episode** was not recorded move by move, and its model
  changed while it was played: "Watch this seed again" plays its seed with the checkpoint its run had when the
  episode ended (the newest one saved before that; the run's first when none was), with sampled actions as in
  training. The same map and start, the same model, other dice: not the same run, and both pages say so. An exact
  replay of a training episode would need the trainer to store every action (about 9 bytes per decision); it does
  not. A scripted baseline cannot be watched again yet: the watcher plays stored models only.
- The view does not change the episode: a test plays the same seed and actions with and without it.

## 3. The stable model cannot be damaged from here

- The database is opened **read-only** (`dashboard/server/reader.ts`, plus `PRAGMA query_only`): no row can be
  changed through the dashboard's connection. Tested.
- The dashboard's own code writes three things: its job list, its job logs, and a run's `STOP` file. It opens no
  model file and writes nothing under `models/stable` or `models/candidates`.
- Promotion and rollback are the registry's commands, whose rules are its own (python/pokebonk_rl/registry.py): a
  promotion copies into a new folder and verifies the copy, the previous stable model keeps its folder, the pointer
  file is replaced atomically, nothing is overwritten, moved or deleted, and a candidate without a passed verdict is
  refused. The dashboard checks the verdict too, to say so before starting anything.
- Both need the action's words typed, in the page and again in the request (`confirm`).
- Tested (`test/dashboard/server.test.ts`): after every page was read and every button pressed, including refused
  and malformed requests, the files under `models/stable` are byte for byte what they were, and the only new file
  anywhere under `models/` is the `STOP` file of the run that was asked to stop.

## 4. Offline and local

- The server listens on `127.0.0.1` only and makes no outgoing connection. The page loads nothing from anywhere
  else: its fonts (Archivo) are bundled into `dashboard/dist`.
- A request is answered only when it is addressed to a loopback host, so a name rebound to this machine reaches
  nothing. A request that changes something must carry a header only this page sends and come from a loopback
  origin, so a page on another site cannot press a button. No cross-origin header is ever sent.
- What it starts is the trainer, the evaluator, the registry and the watcher, each with the offline guard of
  docs/training.md §7 in its own process.
- Installing the page's packages (`npm run dashboard:install`) downloads from the npm registry; nothing else does.

## 5. Code

```
dashboard/shared/api.ts      every JSON shape, shared by server and page (types only)
dashboard/server/
  main.ts, app.ts            command line; HTTP routes, the loopback and same-page checks, static files
  reader.ts, stats.ts        read-only queries and summaries, cached until the database changes (PRAGMA data_version)
  actions.ts                 validation of every button, and the command line it becomes
  jobs.ts                    started processes, their logs, the persisted job list
  watch.ts                   one watched session, relayed as server-sent events
dashboard/src/
  App.tsx                    shell, navigation by the address' hash; every view but the overview is loaded on demand
  views/                     Overview, Evaluations, Breakdowns, Models, History, Episode, Watch
  components/                RunRoute (the run's track), XYChart, Sparkline, SegmentedBar, dialogs, JobList …
  styles.css                 the design tokens (both themes) and the few component classes
python/pokebonk_rl/watch.py  the watcher
```

Design: a handheld instrument. The page is the housing (pale LCD sage, or deep moss in the dark theme), data sits in
lighter "screens", one violet marks what can be pressed. Archivo's width axis carries the typography: wide for names,
condensed for columns of figures. Chart colours are a validated categorical palette (blue, orange, aqua), checked for
colour-vision separation and contrast against the screen colour of each theme. The theme follows the system and can
be switched at the foot of the page.

## 6. Tests

`npm test` includes `test/dashboard/server.test.ts` (8 tests, about 2 s, no game process and no Python: the command
lines are replaced by a script that writes down its arguments): the figures of the specification from a database
built in the test; the curve, breakdowns and episode pages; the read-only connection; the loopback and same-page
checks; each button's validation and the exact command it becomes; promotion and rollback (typed words, verdict,
untouched stable folders); the relay of a watched session. `python -m pytest` has one more game test,
`test_bridge_adds_a_top_down_view_only_when_asked_and_the_episode_stays_the_same`.

Checked by hand on 2026-11-24, against a copy of the database and an empty models folder: an evaluation on two
seeds, a registration, a refused promotion, a watched session, and a training run started, stopped (checkpoint of
kind `interrupt`) and resumed to its end.

## 7. Not done

- **The Training Observatory**: historical charts across runs, per-Pokémon breakdowns over time, plain-English
  diagnostics, experiment comparisons, alerts and explanations of what the training metrics mean. This dashboard is
  the lightweight specification; its API and components are the base for that.
- TensorBoard's learner series (losses, entropy, KL) are not shown; `tensorboard --logdir logs/tensorboard --host
  127.0.0.1` still has them.
- No sign-in: whoever can open a page on this machine can press the buttons.
- A watched session is not recorded, and there is one at a time.
- "By Pokémon" and "By game version" have one row per policy today: one Pokémon and one build have been played.
