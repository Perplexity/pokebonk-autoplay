# Stage 0 discovery: can PokéBonk run offline in Node as a training environment?

Status: discovery complete, awaiting review. No RL has been built.
Game build inspected: `mwsewi0r` (client version 0.10.26), mirrored into `./mirror`.

**Short answer: yes.** The game's production bundle boots, plays and ends a run inside a plain Node process with
no browser, no DevTools connection and no network. It is deterministic for a fixed seed and runs 65–80× faster than
real time on one core in the early and mid game. The proof is `scripts/sim-poc.ts`.

Everything below is marked as one of: **verified** (run and observed), **read** (seen in the bundle, not exercised),
or **unknown**.

## 1. What "the local game copy" is

There is no TypeScript source on this machine.

- The desktop install (`AppData\Local\Programs\PokeBonk`) is an Electron shell. Its `app.asar` contains only the
  shell (`main.js`, `preload.js`, updater, splash art); `main.js` loads the game from the website. **verified**
- The game is the website's minified production bundle: about 5 MB of JavaScript in 25 ES-module chunks built by
  Vite from TypeScript we do not have, plus JSON data files and sprite/audio assets. `./mirror` holds a copy
  (`npm run mirror`). **verified**

The environment therefore runs **that bundle, unmodified on disk**, under a browser shim. Nothing is reimplemented.

## 2. Relevant structure

| Path | What it is |
|---|---|
| `mirror/index.html`, `mirror/assets/*.js` | The game. `main-BX…js` (language, hostname check) → `main-Dh48…js` (App, Run, HUD, combat) → `moves-…`, `boss-…`, `machine-…`, `buildshare-…`, `menus-…`, `three-…` and others |
| `mirror/data/*.json` | Reference data: 1,025 species, 919 moves, learnsets, type chart, abilities, item names, sprite-sheet layouts |
| `mirror/assets/<family>/…` | Sprites, portraits, icons, audio, map textures. Sprite sheets are gameplay data (see §7) |
| `src/sim/` | **New.** The headless harness: `env.ts` (the `Sim` class), `browser.ts`, `gl.ts`, `canvas2d.ts`, `png.ts`, `clock.ts`, `rng.ts`, `net.ts`, `loader.ts` |
| `scripts/sim-poc.ts` | **New.** The proof of concept and determinism check |
| `src/sandbox/mockApi.ts`, `store.ts`, `progress.ts` | The stand-in for the game service, now called in-process |
| `src/bot/extract.ts` | Reads a run object into a JSON snapshot; works headless unchanged |
| `src/bot/brain/` | The hand-written policy: becomes a baseline agent |
| `src/cdp/`, `src/bot/session.ts`, `executor.ts`, `perception.ts` | The browser-driven harness. Not used for training or play; kept only to record ground truth for fidelity checks |

### Game modules and responsibilities (identifiers are minified and change every build)

| In build `mwsewi0r` | Role |
|---|---|
| `ZE` (App) | Boot, menus, frame loop, starts and ends runs. `startRun(cfg)` → `launch(cfg)` |
| `xw` (Run) | One run: `update(dt)`, state machine, player, zones, level-ups, result. Constructed as `new Run(renderer, input, audio, hud, meta, cfg)` |
| `Dd` (Input) | Keyboard/mouse state: `press`, `release`, `hit`, `axis`, `endFrame` |
| `CE` (HUD) | DOM presentation and every dialog (`showLevelUp`, `showItem`, `showShop`, `showBlessing`, …) |
| enemy pool `ep`, projectiles `hE`, pickups `am`, combat `fD` | Struct-of-arrays simulation state |
| director | Spawns waves, hordes, the final swarm; holds the live-enemy cap |
| `br` (boss), minibosses, capture, rifts, relics, seals, overtime | Encounters and side systems |
| terrain `wa` | Height map, prop colliders, walkability (`height`, `hitProp`, `walkClear`, `inBounds`) |
| `Ip` (meta) + backend client | Profile, run ticket, checkpoints, finish. Talks HTTP to the game service |

## 3. Answers to the ten discovery questions

**1. Can the game rules run without a browser or renderer?** Yes. **verified** The real `boot()` completes under
happy-dom plus hand-written null WebGL2, 2D canvas, audio, image, worker and pointer-lock shims. Rendering can be
skipped entirely; its only coupling to gameplay is that visual effects draw from the same `Math.random` stream.

**2. Smallest reliable way to instantiate, reset, step, observe?** **verified**
- *Instantiate:* load the entry chunk through a Node module hook that, in memory, exposes the app instance and the
  App/Run classes (three identifiers found by pattern, not hard-coded).
- *Reset:* `app.startRun({ species, biome, tier, boosts, mode })`, then let the game's own "preparing the zone"
  phase finish. About 1.65 s wall clock, mostly sprite decoding.
- *Step:* advance the virtual clock by `dt`, run due timers, call `run.update(dt)` and `input.endFrame()`.
- *Act:* `app.input.press(code)` / `release(code)` — the game's own input object, not DOM events.
- *Observe:* `extractSnapshot.call(run)`; all 35 fields work headless.
- *Terminal:* `run.state` goes `play` → `dead` → `over`; the game posts its result to the in-process mock.

**3. Deterministic and faster than real time?** Yes to both. **verified**
- Two separate processes with the same seed produce identical per-second digests of time, position, HP, level, KOs
  and the count of `Math.random` calls (seeds 1, 2, 3, 7, 2746754828; my own re-run of seed 3 matched).
- Determinism needs three things pinned: the ticket `seed`, the ticket `id` (the game hashes it into level-up and
  drop rolls), and `Math.random` (one stream shared by gameplay and effects).
- Speed on this machine, one process: 1,300–1,600 steps/s at 20 Hz in the early and mid game (65–80× real time);
  about 390 steps/s with 500 live enemies; about 350 steps/s at 60 Hz with 800.

**4. Action types and decision phases.**
- *Real-time phase* (`state === 'play'`): movement (8 directions or none, relative to camera yaw), jump (Space),
  dash (Shift), ultimate (R), interact (E: balls, altars, guardian altar, portal, capture throw, Friend Ball). Aim is
  automatic in the default setting; the camera does not need to be moved.
- *Choice phases* (`state === 'modal'`): level-up offers (pick one of up to 4, or refresh / skip / banish while
  uses remain), found item (take / sell), shop, altar blessing, evolution branch, challenge seals before a guardian,
  overtime offer, and a few rarer ones. Each arrives as a call on the HUD with the options and a callback. **read**
  for all but level-up, which is **verified**.

**5. State needed without exposing the internal object.** See §5. The existing snapshot is the starting point.

**6. How Pokémon, moves, items and types are represented.**
- The JSON files are **generic reference data**: species (types, base stats, evolution family), mainline move
  stats, level-up learnsets, the type chart. Items have only a name, description and icon. **verified**
- What matters in play is **defined in code**: each move's shape (`arch`: cone, nova, shot, orbit, strike, …),
  damage, cooldown, area, status; each item's stat modifiers; each Pokémon's kit, class and passive. Example:
  Cyndaquil's kit (Burning Jealousy, Temper Flare, Fire Pledge, Blast Burn) is not in its learnset. **verified**
- So the versioned move/item datasets (spec §6.3, §6.4) must be exported from the running game's own registries,
  per build, not read from the JSON files.

**7. Running and recording complete episodes.** **verified** for death; the game's own end-of-run record (species,
map, time, KOs, level, build, counters) reaches the mock's `finish` handler and can be stored as-is. Victory,
zone changes and guardian fights have not been exercised headless. **unknown**

**8. Sandbox and network denial.** No Docker or Podman is installed, WSL has no distribution, and this Node build
has no network permission switch. Per the owner's decision there is no OS-level isolation. What exists:
- every browser-facing network API in the game process (`fetch`, WebSocket, WebRTC, XHR, EventSource, beacon)
  either serves local files, calls the in-process mock, or records the attempt and throws; **verified**, and no
  attempt was recorded in any run;
- to add in Stage 1: the same record-and-throw for Node's own `net`, `tls`, `http`, `https`, `dns`, `dgram`; a
  startup self-test that fails if a socket can be opened; pipes only (stdin/stdout) between trainer and workers;
  the equivalent socket guard in the Python process.

This is enforcement inside the process, not around it. It is weaker than spec §15 asks and is recorded as a
deviation.

**9. Likely bottleneck.** The simulation itself: about 0.72 ms per step in `run.update`, rising with enemy count.
Episode reset (1.65 s) matters for short episodes. IPC and inference are expected to be small beside it but are
unmeasured. Memory is about 350–450 MB per process, so roughly 10 parallel workers fit in 16 GB.

**10. Smallest proof of concept.** Done: `node scripts/sim-poc.ts --seed=1` and `--determinism`.

## 4. Episode lifecycle

1. Process start: install shims, virtual clock and seeded entropy; import the entry chunk; the game boots and signs
   in from a prepared local session (about 0.35 s).
2. Reset: `startRun(cfg)`; the mock issues a ticket whose `seed` and `id` are pinned by the harness; the game
   generates the map and enters `play`.
3. Loop: observe → act → step. Level-ups and other dialogs switch to a choice phase until answered.
4. End: the player faints (or the run is won, or it is ended); the game writes its result; the harness records it.
5. Next episode in the same process works (four in a row tested), but profile progression and the random stream
   carry over, so a reproducible episode currently needs a fresh process or an explicit reset of both.

## 5. Proposed observation and action schemas (to be confirmed in Stage 1)

**Observation** — fixed-size, bounded, built from the snapshot:
- *Run:* phase, zone, zone time, run time, Pokédollars, next ball price, pending level-ups, guardian woken / zone
  cleared, seals held, difficulty multipliers.
- *Player:* HP, max HP, shield, level, XP fraction, speed, dash ready, jumps left, grounded, ultimate charge.
- *Pokémon conditioning:* types (multi-hot), base stats, class, passive (categorical), evolution stage.
- *Build:* per move slot: move features (type, shape, damage, cooldown, area, level); items and vitamins as counts.
- *Threats:* the K nearest enemies as relative position, velocity, HP fraction, radius, damage, flag bits, attack
  timer; 16-sector crowd histogram; shots; strike circles with time to impact; pools; shock rings; guardian state.
- *World:* walkable and jumpable distance in 16 directions; distance to the map edge; relative position of the
  guardian altar, portal, nearest free and paid balls, altars, berries; experience on the ground.
- *Choice phase:* each offer as features (kind, target move or item features, rarity, new / upgrade), plus counts
  of refresh / skip / banish left.

**Action** — one policy, phase-aware, with masks:
- real time: `move ∈ {none, 8 directions}`, `jump`, `dash`, `ultimate`, `interact` (each 0/1);
- choice: `pick ∈ {offer 1..N, refresh, skip, banish, take, sell, decline}`, masked to what is valid.

## 6. Checking the working assumptions (spec §3)

| Assumption | Finding |
|---|---|
| Core loop is shared across Pokémon | Consistent with the code: one Run class, species passed as config. **read** |
| Pokémon differ mainly in moves | Partly. Each also has a class, base stats, an evolution line and its own passive (e.g. Cyndaquil's Heat Haze, Squirtle's shell shield). **verified** for the starters shown in game text |
| Item builds are mostly shared | Plausible: one item table, effects as stat modifiers. Type-boost items exist. **read**, not measured |
| A shared, conditioned policy is the right start | Nothing found against it |

## 7. Differences from the original game, and risks

1. **Step rate changes late-game rules.** The game measures its own frame rate and, below 45 fps, lowers the
   live-enemy cap from 800 to 500 once a horde is large. Stepping at 20 Hz triggers that; 60 Hz does not. Options:
   step at 60 Hz and act every few steps, or use the game's own "FPS limit 30" setting with 30 Hz stepping
   (threshold then 22.5; read, not long-run tested). **Decision needed.**
2. **Step size changes trajectories.** `dt = 1/20` and `1/60` give different runs for the same seed. Whatever is
   chosen must be fixed and recorded per run.
3. **Sprite pixels are gameplay data.** Enemy collision radius and height come from the opaque width of the
   sprite sheet. The harness decodes the real PNGs, and radii and speeds match values recorded in the browser. But a
   species whose sheet is missing from the mirror falls back to a default size. The mirror must be completed
   (`npm run mirror -- --deep`, then a check that every species sheet is present) before training.
4. **Everything loads instantly** on the virtual clock, so the "preparing the zone" wait is shorter than in a
   browser. No rule depends on it as far as seen.
5. **Not exercised headless:** guardian fights, portals and zone changes, victory, shops and slot machines,
   save / suspend, Ranked specifics (seals, zone 4 overtime), other modes.
6. **Ranked.** The mock issues unranked tickets and reports no season. What the client needs to run a Ranked-rules
   episode offline (ticket flags, season map list) is **unknown** and is the first thing to establish in Stage 1.
7. **Game's own telemetry.** One console error per run comes from its anti-tamper probe failing to create an
   iframe. It does not affect play; not every consumer of those flags was traced.
8. **Memory growth.** RSS rose from 353 to 458 MB over four episodes in one process; not yet known whether it is a
   leak. Workers may need recycling.
9. **Build pinning.** The harness finds three identifiers by pattern, but the observation reader depends on field
   names that are stable only within a build. Each game update is an explicit re-validation.
10. **Cross-check so far:** for one browser-recorded seed, all 37 map points, terrain heights, enemy radii, speeds
    and the spawned species set match headless. No full trajectory comparison has been done.

## 8. Proposed staged plan

- **Stage 1 — environment.** Freeze step rate; `GameEnvironment` (`reset`, `step`, `getObservation`,
  `getMetadata`, `close`) over `Sim`; all choice dialogs as structured decisions with masks; Ranked-rules episodes;
  profile preset (fresh, everything unlocked); per-episode reset of random stream and profile; Node-level network
  guard and self-test; complete the mirror; episode records in SQLite; random and heuristic baselines; a browser
  vs headless trajectory comparison for a handful of seeds.
- **Stage 2 — RL.** Python 3.12/3.13 with PyTorch and Stable-Baselines3; Gymnasium adapter over pipes to N Node
  workers; masked PPO as the first algorithm; reward v0 (KOs dominant, zone and guardian progress, death and
  damage penalties, each tracked separately); checkpoints, resume, TensorBoard; a separate evaluation script on
  held-out seeds; stable-model protection.
- **Stages 3–6** as in the spec.
