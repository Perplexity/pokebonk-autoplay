# The headless game environment (Stage 1)

`src/environment/` is the stable interface over the headless game process (`src/sim/`, see docs/discovery.md and ADR 0001).
Game rules are documented in docs/game-mechanics.md. Numbers here were measured on build `mwsewi0r` (0.10.26), Node 24.22,
one process, on the development machine.

## 1. Interface

```ts
import { createEnvironment } from './src/environment/index.ts';

const env = createEnvironment({ actionRepeat: 3 });          // 60 Hz simulation, 20 decisions per second
let obs = await env.reset({ seed: 1, species: 155, map: 'forest', tier: 0 });   // Ranked rules by default
for (;;) {
  const action = obs.phase === 'choice' ? { type: 'choice', option: 0 } : { type: 'play', move: 'n', jump: false };
  const { observation, reward, terminated, truncated, info } = await env.step(action);
  obs = observation;
  if (terminated || truncated) break;
}
env.getMetadata();   // build, rates, schema versions, instrumentation points, shim hash, offline guard
await env.close();
```

- **One environment per Node process** (the browser shims are global). Parallelism is several processes.
- **Phases.** `play`: one `step` holds the action for `actionRepeat` simulation steps of 1/60 s and stops early when a
  dialog opens or the run ends. `choice`: one `step` answers the open dialog through the game's own callback; game time
  does not move. `over`: the episode ended, only `reset` is valid.
- After the action, states in which the player cannot act (zone loading, evolution and boss cut-scenes, a Poké Ball in
  flight, fainting) are stepped through with no key held; `info.idleSteps` counts those steps.
- **Observation** (`types.ts`): `phase`, `step`, `simStep`, the raw `snapshot` (docs/SNAPSHOT.md), the pending `decision`
  (kind, HUD method, options, extra actions, context), the `mask`, and `state`: build, economy, clocks, guardian / seal /
  overtime state, a histogram of all live enemies and the cumulative counters (docs/observation.md §1; the counters are
  also in `info.counters`). Everything is a deep-frozen copy made of plain objects and arrays; a test walks it and checks
  that nothing in it is, or can reach, a live game object.
- **Numeric encoding (optional).** `createEnvironment({ encode: true })` adds `observation.encoded`: a fixed-size
  `Float32Array` and `Int32Array` following a hashed layout descriptor, and the mask of the MultiDiscrete action codec
  (docs/observation.md). It needs the game-knowledge export of the running build (docs/game-knowledge.md). Default: off.
- **Actions.** Play: `{ type: 'play', move, jump?, dash?, ultimate?, interact?, form?, incense?, fuse? }` with `move` one of
  `none, n, ne, e, se, s, sw, w, nw` (or its index 0–8), world-relative (−z is north), turned into W/A/S/D with the camera yaw
  by the same rule as `keysFor` in `src/bot/session.ts`. The seven buttons act on the key-down edge: they are pressed for the
  first simulation step of the decision and released. `form` is the Max form key (F), `incense` opens a rift (C), `fuse`
  opens a fused rift (X). Choice: `{ type: 'choice', option: i }` or
  `{ type: 'choice', extra: 'refresh' | 'skip' | 'banish' | 'banishKit' | 'sell' | 'decline' | 'leave' | 'reroll', target?: i }`.
- **Mask.** Play: all nine moves, jump and dash are always accepted; `ultimate` only while the game reports it charged and
  idle; `interact` only while the game's own conditions say the key would use something (same checks, same order as its
  input code); `form` only while the game's `forms.ready` holds (a charge held, the form not running); `incense` and
  `fuse` only while the game's `rifts.useBlock()` says nothing stands in the way (Incense held, no rift open, no boss
  fight, not in the sanctuary, …). Choice: one flag per option, and per extra action a flag or one flag per target.
- **Invalid actions** (wrong phase, out of range, masked, malformed) are never mapped to something else:
  `invalidAction: 'throw'` (default) raises `InvalidActionError`; `'penalty'` does nothing in the game, counts the step and
  sets `info.invalidAction` to the reason.
- **`terminated`** when the game's run reaches `over` (fainted, or its real end); `info.end` then holds `how`, `victory` and
  the game's own end-of-run record. **`truncated`** only when `maxGameTime` (default: none) is reached; the open run is closed
  at the next `reset` through the game's own Restart path. `reward` is always 0 in this stage.
- **Unknown situations stop the episode with an `UnknownSituationError`** carrying seed, species, map, tier, step, simulation
  step, run state and time, the HUD method and a summary of its arguments: a dialog of another mode, a window opened by a
  HUD method nobody replaced, the run in `modal` without a captured dialog, the game pausing itself, a non-interactive state
  lasting more than 120 s of steps. Nothing is clicked.

`scripts/run-episodes.ts` is the unattended runner: N episodes of the `random`, `idle` or `heuristic` policy on several
worker processes, stored in SQLite (docs/baseline.md §1, docs/storage.md); `--jsonl` also writes
`data/runs/<timestamp>/episodes.jsonl` and `metadata.json`.

## 2. What makes a run "Ranked" here

The client's Ranked is the run option `competitive: true` on the standard mode (docs/game-mechanics.md §2). `reset()` calls
`app.startRun({ species, biome, tier, boosts: [], mode: 'standard', competitive: true })`, the call the game's Ranked map
screen makes, and then checks on the game's run object that mode, species, map, tier, seed and `competitive` are what was
asked for. Around it, the local stand-in for the service (`src/sandbox/mockApi.ts`) is configured so that the client sees
what it would see in Ranked:

| Piece | Value | Where |
|---|---|---|
| account | registered, not a guest | `Sim.boot({ registered: true })` |
| `GET /status` → `season` | `{ live: true, ranked: true, n: 4, name: 'Season 4', maps: [the ten maps of the bundle's season list] }` | `MockApi.season = localRankedSeason(…)`, re-read by the game with its own `backend.status()` |
| `POST /runs` request | carries `competitive: true` | sent by the game |
| `POST /runs` reply (ticket) | `ranked: true`, `competitive: true`; `seed` and `id` pinned from the episode seed | mock + fetch layer |
| `POST /runs/:id/finish` reply | `ranked: true` in the reply and in `record` | mock |
| `POST /dev/unlock` | the unlocked profile (preset `unlocked-v3`, docs/game-mechanics.md §6) | `MockApi.unlockPreset`, called through the game's `meta.devUnlock()` |

`reset({ ranked: false })` gives Classic (no `competitive`). The menu's Ranked gate (3 days, 20 runs) is not involved because
no menu is used. Nothing is submitted anywhere; every request ends in the in-process mock.

## 3. Reproducibility

`reset({ seed })` gives the same episode whether it is the first one of a fresh process or a later one in a reused process.
Per reset:

1. an open run is closed (the game's Restart path); finished run files are removed from the local store;
2. browser storage is restored to its content after boot; the profile is replaced by the preset through `devUnlock`,
   settings and last picks restored, and the result compared with the boot-time profile (mismatch is an error);
3. the random streams restart from the seed **when the game constructs the run** and again **each time a zone finishes
   loading** (stream index = zone number). "The streams" are `Math.random`, `crypto.getRandomValues` and the state of the
   game's own module-level generator;
4. the ticket `seed` and `id` are functions of the episode seed alone;
5. the account id is a fixed value, and the profile's legendary "hunt" counters are set from the episode seed;
6. the run's `realTime` counter is put back to its value before each loading phase (0 for the first zone);
7. a Pokémon sprite sheet is delivered inside the assignment that requests it, so a first load in a process behaves
   exactly like a load from the game's cache;
8. three.js draws its object UUIDs from a private stream, not from `Math.random`.

Evidence (`node scripts/env-determinism.ts`): three child processes play the same episode; A and B are fresh, C first
plays other seeds (the last one abandoned mid-run). The digest covers every environment step: run clock, position, HP,
level, KOs, live enemies, number of `Math.random` calls, phase and pending decision.

| Episode | Result |
|---|---|
| seed 1, Cyndaquil / forest / tier 0, random policy, 60 s | identical, 1223 steps |
| seed 3, same, full episode (fainted at 161.7 s, 202 KOs) | identical, 3307 steps, 354,145 random calls |
| seed 11, Pikachu / coast / tier 2, full episode (fainted at 65.4 s) | identical, 1327 steps |
| seed 4, four zones + overtime, cashed at 240.5 s (cheating scratch probe as the "policy") | identical in a fresh process and after two other episodes |

The table above was measured on the `unlocked-v1` profile, before the three fixes below. Current state
(`unlocked-v2`, measured 2026-11-23 after the fixes):

| Episode | Result |
|---|---|
| seed 3, Cyndaquil / forest / tier 0, full episode (fainted at 704.1 s, 14,666 KOs), reused process played two other episodes first | identical (fresh = fresh = reused), 14,518 steps, 6,671,479 random calls |
| seed 21, Pikachu / coast / tier 1, full episode (fainted at 699.6 s, 18,457 KOs), reused process played three other episodes first | identical, 14,475 steps, 16,256,854 random calls |
| seed 8, Cyndaquil / forest / tier 0, full episode (fainted at 272.6 s) | identical, 5,572 steps |

The `unlocked-v3` profile (the complete shiny collection added: +3 luck, +4 % experience, +3 % damage, Shiny Charm)
changes every episode again. Re-run on v3 (`node scripts/env-determinism.ts --seed=3 --max-time=0 --warmup=2`):

| Episode (unlocked-v3) | Result |
|---|---|
| seed 3, Cyndaquil / forest / tier 0, full episode (fainted at 272.0 s, 672 KOs), reused process played two other episodes first | identical (fresh = fresh = reused), 5,554 steps, 690,064 random calls |

**A defect found and fixed here.** With `unlocked-v2`, long episodes stopped being reproducible: the same seed gave a
different episode in a process that had played before, and occasionally between two fresh processes. Four independent
causes, each found by diffing a fresh process against a reused one (random-number call sites, then per-step sums over
the enemy arrays, then the fields of the run object):

1. **Random account id.** The local stand-in for the game service drew account ids from the operating system. The
   game hashes the account id, the species and a per-run counter (`profile.hunt[species].k`) to decide whether one of
   five legendaries (144, 145, 146, 150, 151) is "pending" as a capture encounter in a run, so the same seed could meet
   a legendary in one process and not in another. Now the account id comes from a fixed sequence
   (`MockApi.newId`, replaced in `src/sim/env.ts`), and the counter is set from the episode seed at every reset, so each
   seed has its own roll, as successive runs of one account have. The game's profile reader caps the counter at
   1,000,000 (`k: Math.min(1e6, …)`): seeds up to that value use the seed itself, larger seeds use the seed modulo
   1,000,001 (`huntCounter` in `src/environment/GameEnvironment.ts`). Before that rule, a second reset in one
   process on a seed above the cap was refused ("the game did not adopt the hunt counters"); it was found by the
   first training run, whose seeds start at 1,000,000. The species list is read from the bundle
   (`findHuntSpecies`); a build where it is not found exactly once is refused.
2. **The game's sheet cache.** Its sprite-sheet loader keeps a process-wide cache behind a four-at-a-time queue. A sheet
   first met in a process arrived a clock tick later than a cached one. The image shim now delivers Pokémon sheets
   (`pmd`, `pmd-forms`, `pmd-shiny`, `front`) synchronously when a handler is attached (`src/sim/browser.ts`), which is
   what the game sees from a warm cache.
3. **`run.realTime`.** The run counts the real seconds of every frame it goes through, loading included, and compares
   that counter with thresholds in play code. Loading takes a different number of frames depending on what the process
   has cached (8 against 13 frames in the case traced), and that offset moved a kill by one hit 512 s into the episode.
   The environment sets the counter back to its pre-loading value when a loading phase ends.

4. **three.js UUIDs** (found by the baseline runner on episodes that beat a guardian; the random policy never gets
   that far). three.js' `generateUUID` draws four numbers from `Math.random` for every object, texture, material and
   geometry, the same stream the game's rules use, and the game builds many of those lazily and caches them per process.
   A fresh process drew 24 numbers more than a reused one in the step the zone-1 guardian fell (the texture of that
   effect is built once per process). The loader now points those four calls at a private stream, in memory
   (`src/sim/loader.ts`); a build where the function is not found in exactly one chunk is refused. This is a class of
   cause, not one site: it covers every lazily created three.js object. Code of the game itself that draws from
   `Math.random` only the first time something is built in a process would still show; none is known.

Still depending on process history, without a known effect on play: the virtual wall clock keeps running from one
episode to the next (the game's date-dependent features outside a run would see a later time of day), `run.bornAt` and
the profiler's timestamps follow it, and which music track is picked.

The unit test `test/env/environment.test.ts` repeats the check inside one process (seed 5 first, then again after six
other resets). Not covered: maps other than forest and coast; zones 2–4 on anything but the one probe run; evolution, capture
and rift sequences.

Three of the four sources of history-dependence found on the way are documented in docs/game-mechanics.md §7. All were
found by diffing `Math.random` call sites between a fresh and a reused process.

## 4. Dialogs

`DialogCapture.install()` replaces 28 methods on the HUD instance of each run (a new HUD is created per run). Twenty are
turned into decisions, seven are refused, and `hud.modal` (the builder every window goes through) is guarded so that an
unknown dialog cannot open silently; it is let through only once the run is over (the game's end screen).

| Decision kind | HUD method | Options | Extra actions |
|---|---|---|---|
| `levelup` | `showLevelUp` | the offers | `refresh`, `skip`, `banish` (target), `banishKit` (target) |
| `evolution` | `showBranch` | forms | `decline` (stay) when offered |
| `item` | `showItem` | the item (option 0 = take) | `sell` |
| `itemChoice` | `showItemChoice` | the items | `sell` (none) |
| `blessing` | `showBlessing` | the blessings | — |
| `seals` | `showSeals` | every subset of the offered seals (`none` … all) | `decline` (not now) |
| `sanctuaryPath` | `showSanctuaryPath` | `sanct`, `direct` | `decline` |
| `leaveSanctuary` | `showLeaveSanctuary` | `ot`, `leave` | `decline` |
| `overtimeStart` | `showOvertime` | `start` | `decline` |
| `overtimeOffer` | `showOtOffer` | the offerings | `decline` |
| `trade` | `showTrade` | the trades (masked when the game marks one `off`) | `decline` |
| `shop` | `showShop` | stock entries (masked: sold, too expensive, at maximum); stays open after a purchase | `reroll`, `sell` (opens `shopSell`), `leave` |
| `shopSell` | `showShop` | owned items, each with what the shop pays for it; stays open while something is left | `leave` (back to `shop`) |
| `ditto` | `showDitto` | owned items (masked at maximum) | `decline` |
| `party` | `showParty` | allies to release (the shiny partner masked) | `decline` |
| `shinySwap` | `showShinySwap` | `swap` | `decline` |
| `relic` | `relicChoice` | relics, or relic × slot to replace when three are held | `decline` |
| `dojo` | `showDojo` | the three trials offered (key, belt, goal, time limit) | `decline` |
| `dojoPrize` | `showDojo` | the blessings that trial can be fought for (21 stats) | `decline` |
| `slots` | `showSlots` | `spin` (masked when too expensive); stays open after a spin that pays no item | `leave` |
| `forget` | `showForget` | each held move and vitamin to forget (the last move is masked), and `lesson` | `leave` |
| `lesson` | `showForget` | the three offers of Hypno's lesson, in the shape of level-up offers | `decline` (the lesson is kept) |
| `fusion` | fusion machine | `fuse` and, where the game allows it, `link` for every pair of moves that is ready | `leave` |

Exercised against the real game without cheats, by the baseline policies and scripted checks (the table with
answers and effects is docs/baseline.md §7 and §12): `levelup` (take, refresh, skip, banish, banish kit), `item`,
`itemChoice`, `blessing`, `seals` (wake without seals), `sanctuaryPath` (classic path), `leaveSanctuary` (`ot`),
`overtimeStart`, `overtimeOffer`, `evolution`, `trade` (accept and decline), `shop` (buy, restock, sell, leave),
`shopSell`, `ditto`, `relic`, `dojo` and `dojoPrize` (a trial taken and played), `slots` (spins with and without a
prize), `forget` (a move, the lesson), `lesson`, `fusion` (a fusion made). Seal subsets, the direct path and `leave`
were exercised with the cheating probe only. **`party` and `shinySwap` never appeared in real play**, and `link` at the
fusion machine and forgetting a vitamin were not met: they are tested against a stand-in HUD only
(`test/env/dialogs.test.ts`).

**Dialogs whose buttons carry logic.** In the slot machine, Hypno, the dojo and the shop's sell row, part of what a
button does is written inside the HUD's click handler instead of the run. The environment never builds or clicks a
button; it does what the handler does, in the handler's order, by calling the same functions of the game with the
same arguments:

- *Slot machine.* The game hands the dialog an object with `cost`, `spin`, `pay` … . One `spin` answer calls its
  `spin()` (which asks the game service for the draw, as in the browser, and takes the price) and then its `pay(result)`.
  A result that pays an item, or sets off the Voltorb, closes the window, as the HUD does when the key is not held; any
  other keeps it open. The ×10 batch and holding the key are not offered: the game gives them the price and the odds
  of the same number of single spins. The spin is asynchronous; the environment waits for it without moving the
  virtual clock, so no frame runs and no random number is drawn while it waits.
- *Hypno, the dojo's prize list, selling.* The handlers call module-level functions of the game chunks (forget a
  move, forget a vitamin, the lesson's offers, apply an offer, the prices, the dojo's prizes and trial numbers, the
  shop's sell price). `src/environment/gamefns.ts` finds each among the exports of the loaded chunks by what its
  source does; one that is not found exactly once refuses the build.
- *Two handlers also write fields themselves*, and the environment makes the same writes (`HANDLER_WRITES`, reported
  by `getMetadata().dialogs.handlerWrites`): after a lesson, `run.lessonAt = <key of the zone>` and
  `run.stats.lessons++`; after a sale, `player.removeItem(key)`, the run's own "gain Pokédollars" method with the
  price, and `run.econ.sold++`. These are the only places where the environment writes to the run outside the game's
  own callbacks.

The shop's buy / restock functions, the player's "can take one more" check, two HUD methods and the run's "gain
Pokédollars" method have minified names; they are found by what their source does (`resolveBuildNames`,
`resolveGameFns`), and a build where they are not found exactly once is refused.

## 5. Offline guard

`src/sim/guard.ts`, installed by the `Sim` constructor before any game or DOM code is loaded:

- 81 primitives replaced by record-and-throw: `net.Socket.prototype.connect`, `net.connect`, `net.createConnection`,
  `net.Server.prototype.listen`, `tls.connect`, `http(s).request/get`, `http2.connect`, every `dns` lookup / resolve / reverse
  function (callback API, promises API, both `Resolver` classes), `dgram.createSocket` and `Socket.bind/connect/send`, global
  `fetch`, `WebSocket`, `EventSource`.
- **Startup self-test** (`Sim.boot`): 22 probes against reserved addresses (192.0.2.1, `.invalid`), including Node's
  original `fetch` and `WebSocket` captured before the guard. Any probe that is not refused by the guard stops the boot.
- **Configuration check**: the page origin must be loopback, the API target must be `in-process-mock`, the mirror must
  exist locally; otherwise `Sim` throws before anything is installed (`apiTarget: 'https://…'` → "names a remote game
  endpoint").
- Attempts are in `info.blockedNetwork` on every step and in `getMetadata().offline.blocked` (Node-level and page-level
  together). In every run so far the list is empty.
- Above it, unchanged from Stage 0: the page's `fetch` serves files under `mirror/` and the in-process mock, and blocks the
  rest; WebSocket, WebRTC, XHR, EventSource and beacons are blocked.
- Not covered: `child_process`, `worker_threads`, Node's internal bindings. It is enforcement inside the process.

## 6. Instrumentation points (all in memory; `mirror/` is never written)

1. Module load hook: one statement after the app is constructed publishes the app instance and the App / Run classes;
   one more marks the end of `boot()`.
2. Fetch layer: API calls go to the in-process mock; in the `POST /runs` reply `seed` and `id` are replaced by values
   derived from the episode seed.
3. The in-process service stand-in: no progression between episodes, `/dev/unlock`, a local ranked season.
4. Read-only inspection of chunk exports to find the registries (League, Lab, shop items, maps, forms, tiers, season,
   friendship perks and the friendship level function, shiny perks, species rules, reference data), the release list and
   the game's generator object. The friendship level function is called with numbers only, to find the points of the top
   level.
5. `app.launch` wrapped on the app instance: restarts the random streams right before the run object is built.
6. Entropy: `Math.random`, `crypto`, and the `s` field of the game's module-level generator are set at run construction and
   after each zone load.
7. HUD instance of each run: 28 methods replaced (§4). Answers to the slot machine, Hypno, the dojo and the shop's
   sell list call the game's own functions in place of the HUD's click handlers, and make the two handlers' own field
   writes (§4, "Dialogs whose buttons carry logic").
8. Input: `press` / `release` on the game's input object (W A S D, Space, Shift, E, R, F, C, X).
9. Read-only state extraction for `observation.state` and `info.counters` (`src/observations/state.ts`), once per
   observation: fields of the live run object, and these members of it, none of which writes:
   `interactables.chestCost()`, `seals.kept`, `swarmSecs`, `collapseHp()`, `tideHealK()`, `nextBossSpecies()`,
   `overtime.offered / roundLeft / bonus / drainHp / healK / mult(round)`, `ult.ready`, `meta.runGain('healed')`,
   `forms.ready`, `forms.locked`, `rifts.incenseOn`, `rifts.useBlock(fused)`, `interactables.cageCost()`, and the
   game's exported slot-machine price function.
   A test shows that extra calls leave an episode's digest and its random-number count unchanged
   (docs/observation.md §1).
10. Read-only: the `used` flag of every map point (`run.interactables.list`) after each simulation step, to count
    the points used in the episode (`state.pointsUsed`, `counters.pointsUsed`). The game marks a point used but keeps
    no total, and rebuilds the list for every zone.

The numeric encoding (`encode: true`) and the action codec touch no game object: they are computed from the frozen
observation and from the exported knowledge files. The knowledge export (`scripts/export-knowledge.ts`,
docs/game-knowledge.md) is a separate process that reads the game's tables and plays no episode.

Where behaviour can differ from a browser:

- **Step size**: fixed 1/60 s. A browser's frame time varies; the game clamps a frame to 1/20 s.
- **Dialogs take no time.** A human needs frames to click; in `modal` the simulation is frozen either way, but the game's
  short invulnerability after closing a dialog (0.7 s) starts immediately.
- **Audio context suspended, its clock running**: the game starts no sound voice. Its sound code still draws from
  `Math.random` for each move sound that passes the game's per-sound rate limiter (pitch and kit values, about 28 per
  sound), and that limiter reads the audio clock. Here the clock runs, so every such sound draws, in every episode
  alike. In a browser tab nobody has clicked the clock stands at 0 and only the first sound of each kind per page
  draws; in a tab that has been clicked, voices start and draw more. Only which random numbers follow is affected, not
  the rules (docs/fidelity.md D3, where the choice is explained).
- **three.js UUIDs** come from a private stream, in a browser from `Math.random` (docs/fidelity.md D10).
- **No 3D model loads**: the shimmed `Request` rejects what three.js' loader passes to it, so map points, balls and
  props have no model. Nothing but effects and random draws was found to depend on a model (docs/fidelity.md D2).
- **Random streams restarted at zone starts** and the game's generator set from the seed: a browser session has one stream
  per page load.
- **Loading is instant on the virtual clock** and sprite sheets are measured from the mirrored PNGs (all 292 sheets present).
- **Service-dependent rolls**: without `wk` / `blk` in the ticket, shiny / classic encounter rolls and level-up roll seeds
  come from the client's own generators (docs/game-mechanics.md §2).
- **No progression between episodes**, by design.
- The game's tamper probe still logs one console error per process (it fails to create an iframe) and reports
  `end.env = 66`, `end.fns = 770` in the result record.

## 7. Measurements (60 Hz, action repeat 3)

`node scripts/env-measure.ts --resets=8 | --memory=12 | --horde=1150`, `node scripts/run-episodes.ts`.

| What | Value |
|---|---|
| boot (incl. offline self-test) | 0.39 s |
| first reset | 1.65 s |
| later resets | median 1.50 s (1.44–1.58); 0.48 s of it is the game building the run, about 1 s is the eight display frames of its loading phase (about 53 sprite sheets are decoded and measured again for every run) |
| throughput, 0–49 live enemies | 1,250 simulation steps/s = ×20.6 real time (0.80 ms/step) |
| 50–149 | 910 steps/s = ×15.1 |
| 300–499 | 384 steps/s = ×6.4 |
| 700–800 (final swarm) | 284 steps/s = ×4.7 (3.5 ms/step) |
| random policy, full episodes (seeds 1–3) | 162–707 s of game time, 202–15,312 KOs, 919–1,408 steps/s |
| frame-rate governor | measured fps 60.00; live cap 800/800 throughout, never cut (9 min at 800 alive) |

The horde figures come from one long zone-1 run kept alive by rewriting HP (a labelled cheat in the measurement script);
some of it ran while the test suite was running on the same machine.

**Memory.** With a forced GC after every episode, twelve 60 s episodes in one process grew from 352 to 627 MB RSS:
about **+25 MB per episode**, of which about +22 MB is ArrayBuffer memory and +5 MB JS heap. Each episode creates about 60
canvas contexts and decodes about 53 sprite sheets; what keeps their buffers alive was not found. Long episodes also raise
the heap by themselves (730 MB RSS after a 707 s run). **Workers need recycling**: restarting a process costs 0.4 s more than
a reset, so a fixed budget (for example every 20 episodes or above 1.2 GB) is cheap.

## 8. Tests

`npm test` runs everything (152 tests, about 55 s). `npm run test:env` runs only the
environment group:

- `test/env/actions.test.ts`: action validation, masks, key mapping, copies, baseline policies (no game);
- `test/env/dialogs.test.ts`: every dialog's callback protocol against a stand-in HUD, unknown dialogs, build names (no game);
- `test/env/guard.test.ts`: the offline guard, its self-test and the configuration check (no game);
- `test/env/mock-ranked.test.ts`: the service stand-in's additions: ranked season and tickets, `/dev/unlock`, no-progression switch (no game);
- `test/env/environment.test.ts`: **slow group, boots the real game** (about 23 s): unlocked Ranked reset, metadata,
  read-only observations, play steps, invalid actions, level-up decisions, truncation, a real fainted run with its record,
  in-process reset reproducibility, Classic.

The state extractor, the encoding, the action codec and the knowledge export have their own groups
(`test/observations`, `test/actions`, `test/knowledge`; 23 tests, one file of them boots the real game), listed in
docs/observation.md §6.

## 9. Limitations

- Every dialog of the standard mode is a full decision. Not offered: the slot machine's ×10 batch and key-holding
  (same price and odds as single spins), and the "are you sure" second press the HUD asks for before a fusion is
  forgotten or an item is sold.
- Which Max form a species takes (Mewtwo: Mega X, Mega Y or Dynamax) is a setting of the account, chosen in the
  menu before a run. The environment leaves the game's default (the first one, Mega Mewtwo X); choosing it belongs to
  the build decisions of Stage 4.
- Inputs not exposed: dismissing an ally (G), aim mode, auto-run, auto-ultimate, camera and manual aim.
- The map-point counter (`pointsUsed`) is the environment's count, not a figure of the game.
- Run boosts (the consumable bag) are not used; the mock's ticket always returns `boosts: []`.
- The shiny-swap decision has not met the real game yet (docs/baseline.md §7).
- The memory growth above.
- The build is pinned: registries, HUD methods, six minified names and twelve exported game functions are looked up by shape and refuse a build that does
  not match.
