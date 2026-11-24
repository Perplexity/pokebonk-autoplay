# Fidelity check: the headless environment against the same game in a real local Chrome

Question: *given the same seed and the same inputs, does the game in real Chrome (real DOM, real canvas, real WebGL)
evolve exactly as it does under the Node shims (`src/sim/`)?*

Game build `mwsewi0r` (0.10.26). Headless: Node v24.22.1 (V8 13.6.233.17). Browser: Chrome 157.0.8103.51
(V8 15.7.112.23), Windows 11, ANGLE / Direct3D 11 on an NVIDIA GeForce RTX 5060, visible window. Profile preset
`unlocked-v3` (the same profile JSON on both sides of every case, sha256 `50d3ceab45b360de…` without the hunt
counters), account id `8cd9d31e4eec4a25` on both sides. Measured 2026-11-23 on the environment as it stood after the
change that takes three.js' UUIDs off the game's random stream (sha256 of `src/sim/*.ts`, `src/environment/*.ts`,
`src/sandbox/mockApi.ts` and `store.ts` concatenated: `f21bcd1351ad2694…`). Everything is local: the browser's
requests are
answered from `mirror/` and by the in-process mock; the list of refused requests is empty in every run on both sides.

The browser is used as a fidelity oracle only (ADR 0001, item 8). Nothing here trains or plays in a browser.

## 1. Answer

**As they are, no.** A headless episode and a browser episode with the same seed and inputs differ in the last bit of
some map coordinates before the first step, and draw different random numbers from the first step on. They are the
same game with the same rules and the same generated map, but not the same sequence of events: after 60 s of the same
scripted inputs the two players are at the same level in 7 of 8 cases and within 4 KOs of each other, but the
level-ups come at different steps (the first at step 1,518 against 1,549 for forest seed 1), the players are up to
14 m apart, and an idle player fainted at 52.7 s headless and at 55.6 s in the browser.

**Four causes explain all of it (D1, D2, D3, D10 below), and with those four made equal the two are bit-identical for
whole episodes**: every enemy, projectile and pickup array, the player, the director, both random streams and their
call counts, at every simulation step of 14 episodes (239,746 steps in all, the longest 39,985 steps = 654.5 s of
game time), through 535 dialogs of 12 kinds, 206 map points used, a guardian fight, a portal and a zone load, to the
end-of-run record (§4). In that
configuration the **headless side is the unmodified training environment**; it is the browser that is brought to the
environment's behaviour in the places listed below. So nothing else in the shims (the DOM library, the null WebGL
context, the 2D canvas and PNG decoder, storage, fetch, the virtual clock) changes the simulation on the paths these
episodes cover.

| # | Cause | Whose | First visible | Effect | State |
|---|---|---|---|---|---|
| D1 | The two JavaScript engines round `Math.sin`, `cos`, `exp`, `log`, `atan2` … differently (2–17 % of results differ by one unit in the last place) | the engines, not the shims | before step 1 | 3 to 8 map-point coordinates per map differ by 1 ulp, and two presentation values (the player sprite's squash, the camera target) in their last digits. In six episodes with only this difference (66,995 steps) nothing else ever differed: no position, no enemy, no random draw | inherent |
| D2 | Headless, **no 3D model ever loads**: the shimmed `Request` rejects what three.js passes to it | shim (`src/sim/browser.ts`) | step 1 | code that only runs once a model is present never runs; some of it draws random numbers, so both random streams are offset from a browser's from the first step | known, left as it is (§6) |
| D3 | The shimmed audio context is "suspended" but its **clock runs**; a suspended context's clock in a browser stands still | shim (`src/sim/browser.ts`) | step 184 (forest, seed 1: the first time a move's sound repeats) | the game's per-sound rate limiter lets sounds through headless that it blocks in a browser tab nobody clicked; each one draws random numbers | known, deliberate (§6) |
| D10 | Headless, **three.js draws its UUIDs from a private stream**; in a browser every object, texture, material and geometry three.js creates takes four values from `Math.random` | environment (`src/sim/loader.ts`), deliberate | before step 1 (the music track, 5 of 6 seeds); in play at step 7,830 (forest, seed 1) and 5,772 (coast, seed 11) | the browser's gameplay stream is shifted every time three.js creates something during play | known, deliberate (§6) |
| D4 | **The step at which a sprite sheet arrives.** Headless a sheet is usable in the step that asks for it (what the game sees from its own warm cache); in a browser with a cold cache later, and never the same twice | inherent to a browser; the environment picks the warm-cache behaviour | not visible in this check's browser, whose driver waits for every image between two steps: the *timing* cases, with a cold cache, are identical for 17,251 and 7,083 steps | until the sheet arrives enemies of that species have the default collision size, and a stand-in is drawn | browser-side state, not a shim defect |

D2, D3 and D10 change *which* random numbers follow, not a rule. D1 moves a few map points by parts in 10¹⁶; that
could decide a distance comparison the other way some day, and did not in the episodes run. D4 is a fifth difference
from a player's browser that this check's browser does not have. None of them was found to change a rule, a stat, a
table or the generated map (other than the 1 ulp of D1). For D2 that was looked at separately (§5, D2): with and without
models the freshly generated run is identical in all 11,404 compared values, and a scripted player used the
same map points at the same steps from the same distances.

What this means for training: the headless environment is the same game as the browser's, verified exactly on the
compared paths, **but an episode trained on is not the episode a browser would produce for that seed**, and cannot be:
a real session also renders (rendering draws from the same `Math.random`), plays sound, and loads over a network.

## 2. Method

Both sides run the unmodified bundle from `mirror/` and are driven by the same code where that is possible.

- **Headless side** (`src/fidelity/headlessRun.ts`, one child process per episode): the real training environment,
  `createEnvironment({ actionRepeat: 1 })`, `reset`, `step`. Nothing under `src/sim` or `src/environment` was changed.
  The script only looks: it wraps `sim.step` on the instance to take a state digest after every simulation step, and
  records API calls, reseed points, `Request` constructions that throw and (when asked) the call site of every
  `Math.random` call.
- **Browser side** (`src/fidelity/chrome.ts`, `browserRun.ts`, `pageAgent.ts`): a local Chrome with its own profile
  (`data/fidelity/browser-profile`), a visible window, no HTTP server at all. Every request is paused through CDP and
  answered from memory: files of `mirror/` and the mock API through the *same* `Net` and `MockApi` classes the
  headless side uses, under the same origin (`http://localhost:8080`; nothing listens on that port). Anything else is
  refused and listed; Chrome is also started with a resolver rule that resolves nothing but localhost.
- **Determinism in the browser** comes from a script evaluated before any page script
  (`Page.addScriptToEvaluateOnNewDocument`): the *source text* of `VirtualClock` (`src/sim/clock.ts`) and of
  `sfc32` / `installSeededEntropy` (`src/sim/rng.ts`), so the clock and the entropy are the same code on both sides.
  The driver advances the clock by exactly 1/60 s per step and calls `run.update(dt)` and `input.endFrame()` itself,
  as `Sim.step` does; the game's own `requestAnimationFrame` loop only runs during boot and loading, as headless.
- **Same reset**: the browser side makes the calls of `Sim.boot`, `HeadlessGameEnvironment.boot` and `.reset` in the
  same order: prepared session in `localStorage`, registries read with the same `readRegistries`, local ranked season,
  three `devUnlock` calls (preset, hunt counters, reset), baseline, `app.launch` wrapped,
  `app.startRun({ …, competitive: true })`, streams restarted and `run.realTime` set back to 0 when loading ends
  (and again after every later zone load), the same formula for the game's own generator.
- **Same account and profile.** The account (id `8cd9d31e4eec4a25`, the first id of the environment's fixed
  sequence) and every `/dev/unlock` reply are taken from the headless run of the same episode: the profile is computed
  once per comparison, by the environment, and both sides adopt the identical JSON, hunt counters included
  (`hunt[144|145|146|150|151] = { k: seed, m: 0 }`). The browser side refuses to go on if the game did not adopt
  them, or if the headless side made a different number of `devUnlock` calls than the port.
- **Same inputs**: a scripted action per step, sent through the game's input object with the environment's
  `keysForMove`. `walk`: eight directions in turn, 45 steps each, a jump every 37 steps, a dash every 113. `dance`:
  direction changes every 7 steps, jumps every 11, dashes every 53. `idle`: nothing. `seek` (new): walks to the
  nearest map point that is not used yet and presses **interact** there, presses **ultimate** whenever the mask
  allows, gives a point up after three presses that did not use it. `seek` reads the live run object (it is a test
  script, not an agent) and uses no trigonometry; the page side has a port of the environment's play mask, which the
  headless side checks against the environment's own mask at every step.
- **Same dialogs**: the environment's own `DialogCapture` class (type-stripped source of `src/environment/dialogs.ts`)
  is installed on the HUD in the page; both sides answer with `scriptAnswer` (the valid options in rotation, else
  leave / decline / sell / skip).
- **Asynchronous work.** Headless, a fetch or an image "load" finishes within one turn of the event loop. In a browser
  it takes real time. Between two steps the browser side therefore waits until nothing the page started is still in
  flight (fetches and their bodies, image loads, bitmap and audio decodes, stylesheet and module links).
- **The digest** (`stepDigest` in `shared.ts`, the same function on both sides, sent to the page as source): per step,
  readable values (state, clocks, position, HP, XP, level, KOs, enemy counts, `Math.random` and crypto call counts,
  the state of the game's generator, the open dialog) and one hash per group: every scalar of the run object
  (`realTime` included); the player three levels deep (stats, moves, items, timers); **every typed array of the enemy,
  projectile and pickup pools** up to their high-water mark; the director; statistics; map points; boss, capture,
  seals, overtime, allies. Numbers are hashed by their IEEE-754 bits: "identical" means bit-identical. When two lines
  differ, both sides are run again with every hashed value kept by name, which gives the differing fields; `--trace`
  gives the `Math.random` call sites of a step on both sides.
- **A second, independent state comparison**: the game's own autosave of the run (`localStorage`
  `pb.runauto.<account>`: run, player, enemies, pickups, items, director and its generators, events, combat, map) is
  compared between the two sides when one exists at the end of the episode, and the game's own end-of-run record
  when the run ended.

## 3. Configurations, and how to reproduce

| Name | Headless side | Browser side | What it shows |
|---|---|---|---|
| **as is** | the environment | cold sheet cache, its own Math, models, real audio context, three.js as shipped | what a seeded, fixed-step browser does next to the environment |
| **equal** (`--equal`) | the environment, with the common Math | common Math; `Request` throws as under the shims (D2); a suspended audio context's clock runs (D3); three.js' UUIDs from the private stream (D10); the game's sheet cache warm and kept warm (D4) | whether anything *else* differs. Identity is expected |
| **models** | the environment with the three rejected shim patches applied in memory (models load, audio clock frozen), common Math | common Math, D10, warm sheets; models load, audio as it is | the same question on the code paths that need a model |
| **math** | common Math | common Math | what the shims and the cold cache change without D1 |
| **shims** | the environment | as *equal* but each engine its own Math | what D1 alone does over time |
| **timing** | as *equal* | as *equal* but a cold sheet cache | what D4 alone does |
| **single** | as *equal* | as *equal* minus one of D2, D3, D10 | each of the three by itself |

```
node scripts/fidelity/math.ts                      # which Math functions differ between the two engines (D1)
node scripts/fidelity/compare.ts --seed=1 --steps=0 --static --sheets          # stage 1, incl. all 543 sheets
node scripts/fidelity/compare.ts --seed=1 --steps=3600                          # as is
node scripts/fidelity/compare.ts --seed=1 --steps=45000 --equal                 # equal, until the run ends
node scripts/fidelity/compare.ts --seed=1 --steps=45000 --equal --script=seek   # equal, a player that uses map points
node scripts/fidelity/compare.ts --seed=1 --steps=45000 --common-math --patch=native-abort,request-base,audio-clock --browser-as-shim=uuid --warm-sheets   # models
node scripts/fidelity/compare.ts --seed=1 --steps=2 --common-math --trace=1,2 --no-detail     # Math.random call sites of steps 1–2
node scripts/fidelity/models.ts --seed=1 --steps=9000 --script=seek             # headless with and without models (D2), no browser
node scripts/fidelity/suite.ts                     # the whole matrix below (about an hour with three Chrome profiles side by side, see `--profile`; about two and a half hours in one go)
node scripts/fidelity/suite.ts --table             # rebuild data/fidelity/suite/results.md and results.json
```

Other flags of `compare.ts`: `--map= --species= --tier= --script=walk|dance|idle|seek`, `--stop-at-dialog`,
`--native-hud` (the browser keeps the game's own dialogs and stops at the first), `--render=N` (the browser draws
every N-th step with the real renderer, random streams protected), `--browser-twice`, `--no-align`,
`--browser-as-shim=request,audio-clock,uuid` and `--warm-sheets` (the parts of `--equal`), `--preload=…` (both sides
ask for given sheets before play; from the draft, no longer needed), `--profile=<folder>` (a second Chrome profile,
to run two comparisons at once). Results: `data/fidelity/<name>/` (`headless.json`, `browser.json`,
`comparison.json`, `summary.txt`, a screenshot); the matrix: `data/fidelity/suite/results.md` and `results.json`.

What the equalising switches do, so that nobody mistakes them for the environment:

- `--common-math` replaces twenty Math functions **on both sides** by the same plain-JavaScript code
  (`src/fidelity/commonMath.ts`, fdlibm/musl kernels, about 1 ulp accurate; identical in both engines for all 600,000
  inputs of the battery).
- `--browser-as-shim=…` and `--warm-sheets` change **the page in the browser only, in memory** (§7, items 10–13). They
  copy into the browser what the environment does, so that the rest can be compared exactly. They are not what a
  browser does.
- `--patch=…` applies the three rejected shim patches of §6 **in the headless child process only, in memory**. Used
  only by the *models* group and by `scripts/fidelity/models.ts`.

## 4. Results

The tables are `data/fidelity/suite/results.md` as `suite.ts` wrote it. Every case of the matrix ran on the same
environment sources and adopted the same profile on both sides (one sha256 over all cases).

### 4.1 Stage 1: static comparison

Same map, seed, species and profile; taken right after the reset.

| What | Compared | Result |
|---|---|---|
| Collision radius and height the game derives from **every sprite sheet** (its own `measure()` through `run.sprites.get(id)`): opaque box of the walk frame, `bodyWidth`, `bodyHeight`, radius, height, and the per-frame foot tables of the attack and hurt animations | 543 sheets: 251 species, 41 forms, **251 shiny** (new: the preset's shiny collection is complete, so shiny sheets are in play) | **identical**, all 543 |
| Terrain: the full height map (103,684 heights, hashed) and path mask; `height(x, z)`, walkable / prop / water flags on a 49 × 49 grid; all prop colliders; solid boxes, ponds, massifs, landmarks | 6 episodes | **identical** in every episode, with either Math |
| Map points (kind, sub-kind, position, radius, used, cost) and the zones reserved around them | 89 points (forest), 75 (coast) | each engine's own Math: 3 to 8 point coordinates per map differ by 1 ulp (D1), and the same coordinates again in the reserved zones; nothing else. Common Math: identical |
| Player: species, types, level, HP, all stats, moves (key, level, cooldown, area, own state), slots, items, ability, radius, speed, start position | | identical |
| Run parameters: seed, mode, tier, `competitive`, weather, enemy caps (`liveMax` 800, `liveCap` 800, `maxEnemies` 1400), `fpsCap` 0, difficulty multipliers, refresh / skip / banish counts, zone look; director cards, spawn pools and timeline; settings chosen by the game (quality `high` on both) | | identical, except `run.music` (which music track) in 5 of 6 episodes unless D10 is equalised |
| Sprite cache after loading (which sheets, each one's measured box) | | identical |
| `localStorage` after the reset; script chunks and their load order; registries found; the profile adopted | | identical |
| API calls up to the start of play (method, path, body, reply) | 15 (16 headless: it creates the account itself) | identical (the page clock equalised, see D5) |

| Case | Episode | Static values compared | Differ | Which | Map points | Sprite sheets (measured / differ) | API calls (h / b), differ | Storage, chunks |
|---|---|---|---|---|---|---|---|---|
| static-asis-forest-155-t0-s1 | forest, #155, tier 0, seed 1 | 11404 | 16 | 1 × run.music, 6 × terrain.clearZones[].z, 1 × terrain.clearZones[].x, 8 × points[] | 89 | 543 / 0 | 16 / 15, 0 | identical |
| static-asis-forest-155-t0-s2 | forest, #155, tier 0, seed 2 | 11442 | 9 | 1 × run.music, 2 × terrain.clearZones[].z, 2 × terrain.clearZones[].x, 4 × points[] | 89 | — | 16 / 15, 0 | identical |
| static-asis-forest-155-t0-s3 | forest, #155, tier 0, seed 3 | 11416 | 10 | 1 × run.music, 2 × terrain.clearZones[].z, 2 × terrain.clearZones[].x, 5 × points[] | 89 | — | 16 / 15, 0 | identical |
| static-asis-coast-25-t2-s11 | coast, #25, tier 2, seed 11 | 7485 | 14 | 3 × terrain.clearZones[].z, 4 × terrain.clearZones[].x, 7 × points[] | 75 | — | 16 / 15, 0 | identical |
| static-asis-coast-25-t2-s12 | coast, #25, tier 2, seed 12 | 7487 | 8 | 1 × run.music, 2 × terrain.clearZones[].z, 1 × terrain.clearZones[].x, 4 × points[] | 75 | — | 16 / 15, 0 | identical |
| static-asis-coast-25-t2-s13 | coast, #25, tier 2, seed 13 | 7485 | 7 | 1 × run.music, 2 × terrain.clearZones[].x, 1 × terrain.clearZones[].z, 3 × points[] | 75 | — | 16 / 15, 0 | identical |
| static-math-forest-155-t0-s1 | forest, #155, tier 0, seed 1 | 11404 | 1 | 1 × run.music | 89 | — | 16 / 15, 0 | identical |
| static-math-forest-155-t0-s2 | forest, #155, tier 0, seed 2 | 11442 | 1 | 1 × run.music | 89 | — | 16 / 15, 0 | identical |
| static-math-forest-155-t0-s3 | forest, #155, tier 0, seed 3 | 11416 | 1 | 1 × run.music | 89 | — | 16 / 15, 0 | identical |
| static-math-coast-25-t2-s11 | coast, #25, tier 2, seed 11 | 7485 | 0 | — | 75 | — | 16 / 15, 0 | identical |
| static-math-coast-25-t2-s12 | coast, #25, tier 2, seed 12 | 7487 | 1 | 1 × run.music | 75 | — | 16 / 15, 0 | identical |
| static-math-coast-25-t2-s13 | coast, #25, tier 2, seed 13 | 7485 | 1 | 1 × run.music | 75 | — | 16 / 15, 0 | identical |
| static-equal-forest-155-t0-s1 | forest, #155, tier 0, seed 1 | 11404 | 0 | — | 89 | — | 16 / 15, 0 | identical |
| static-equal-forest-155-t0-s2 | forest, #155, tier 0, seed 2 | 11442 | 0 | — | 89 | — | 16 / 15, 0 | identical |
| static-equal-forest-155-t0-s3 | forest, #155, tier 0, seed 3 | 11416 | 0 | — | 89 | — | 16 / 15, 0 | identical |
| static-equal-coast-25-t2-s11 | coast, #25, tier 2, seed 11 | 7485 | 0 | — | 75 | — | 16 / 15, 0 | identical |
| static-equal-coast-25-t2-s12 | coast, #25, tier 2, seed 12 | 7487 | 0 | — | 75 | — | 16 / 15, 0 | identical |
| static-equal-coast-25-t2-s13 | coast, #25, tier 2, seed 13 | 7485 | 0 | — | 75 | — | 16 / 15, 0 | identical |

Cases with a result: 64. Profile preset: unlocked-v3; sha256 (first 16 hex) of the adopted profile without the hunt
counters, over both sides of all cases: 50d3ceab45b360de (one value: every case, both sides, the same profile).
Account id: 8cd9d31e4eec4a25. Engines: v24.22.1 (V8 13.6.233.17-node.58) / Chrome/157.0.8103.51 (V8 15.7.112.23).

### 4.2 Stages 2 and 3: trajectories

"Bit-identical steps": simulation steps from the start for which every hashed value is equal. "Discrete values": state,
level, KOs, enemy counts, number of `Math.random` and crypto calls, the game generator's state, the open dialog.
Episodes run until the run ends unless a step limit is given (45,000 steps for the long groups; no case reached it).

| Case | Episode | Steps (headless / browser), stop | Bit-identical steps | First difference | Discrete values equal until | Dialogs (h / b) | End-of-run record |
|---|---|---|---|---|---|---|---|
| equal-walk-forest-155-t0-s1 | forest, #155, tier 0, seed 1, walk | 17251 / 17251 (run over) | all 17251 | — | the end (17251) | 19 / 19 | 1 field(s) differ: record.end.env |
| equal-walk-forest-155-t0-s2 | forest, #155, tier 0, seed 2, walk | 39985 / 39985 (run over) | all 39985 | — | the end (39985) | 63 / 63 | 1 field(s) differ: record.end.env |
| equal-walk-forest-155-t0-s3 | forest, #155, tier 0, seed 3, walk | 16730 / 16730 (run over) | all 16730 | — | the end (16730) | 19 / 19 | 1 field(s) differ: record.end.env |
| equal-walk-coast-25-t2-s11 | coast, #25, tier 2, seed 11, walk | 7083 / 7083 (run over) | all 7083 | — | the end (7083) | 11 / 11 | 1 field(s) differ: record.end.env |
| equal-walk-coast-25-t2-s12 | coast, #25, tier 2, seed 12, walk | 11912 / 11912 (run over) | all 11912 | — | the end (11912) | 21 / 21 | 1 field(s) differ: record.end.env |
| equal-walk-coast-25-t2-s13 | coast, #25, tier 2, seed 13, walk | 12199 / 12199 (run over) | all 12199 | — | the end (12199) | 21 / 21 | 1 field(s) differ: record.end.env |
| equal-idle-forest-155-t0-s1 | forest, #155, tier 0, seed 1, idle | 3289 / 3289 (run over) | all 3289 | — | the end (3289) | 3 / 3 | 1 field(s) differ: record.end.env |
| equal-idle-coast-25-t2-s11 | coast, #25, tier 2, seed 11, idle | 7176 / 7176 (run over) | all 7176 | — | the end (7176) | 11 / 11 | 1 field(s) differ: record.end.env |
| equal-dance-forest-155-t0-s2 | forest, #155, tier 0, seed 2, dance | 39027 / 39027 (run over) | all 39027 | — | the end (39027) | 56 / 56 | 1 field(s) differ: record.end.env |
| equal-dance-coast-25-t2-s12 | coast, #25, tier 2, seed 12, dance | 9067 / 9067 (run over) | all 9067 | — | the end (9067) | 14 / 14 | 1 field(s) differ: record.end.env |
| equal-seek-forest-155-t0-s1 | forest, #155, tier 0, seed 1, seek | 31360 / 31360 (run over) | all 31360 | — | the end (31360) | 130 / 130 | 1 field(s) differ: record.end.env |
| equal-seek-forest-155-t0-s3 | forest, #155, tier 0, seed 3, seek | 19666 / 19666 (run over) | all 19666 | — | the end (19666) | 56 / 56 | 1 field(s) differ: record.end.env |
| equal-seek-coast-25-t2-s11 | coast, #25, tier 2, seed 11, seek | 6373 / 6373 (run over) | all 6373 | — | the end (6373) | 28 / 28 | 1 field(s) differ: record.end.env |
| equal-seek-coast-25-t2-s12 | coast, #25, tier 2, seed 12, seek | 18628 / 18628 (run over) | all 18628 | — | the end (18628) | 83 / 83 | 1 field(s) differ: record.end.env |
| models-walk-forest-155-t0-s1 | forest, #155, tier 0, seed 1, walk | 17002 / 17002 (run over) | all 17002 | — | the end (17002) | 19 / 19 | 1 field(s) differ: record.end.env |
| models-walk-coast-25-t2-s11 | coast, #25, tier 2, seed 11, walk | 6381 / 6381 (run over) | all 6381 | — | the end (6381) | 9 / 9 | 1 field(s) differ: record.end.env |
| models-seek-forest-155-t0-s1 | forest, #155, tier 0, seed 1, seek | 31222 / 31222 (run over) | all 31222 | — | the end (31222) | 120 / 120 | 1 field(s) differ: record.end.env |
| asis-walk-forest-155-t0-s1 | forest, #155, tier 0, seed 1, walk | 3600 / 3600 (step limit) | 0 | step 0: run, points | step 0 (then mathRandomCalls, gameRngState) | 3 / 3 (differ) | — |
| asis-walk-forest-155-t0-s2 | forest, #155, tier 0, seed 2, walk | 3600 / 3600 (step limit) | 0 | step 0: run, points | step 0 (then mathRandomCalls) | 3 / 3 (differ) | — |
| asis-walk-forest-155-t0-s3 | forest, #155, tier 0, seed 3, walk | 3600 / 3600 (step limit) | 0 | step 0: run, points | step 0 (then mathRandomCalls) | 3 / 3 (differ) | — |
| asis-walk-coast-25-t2-s11 | coast, #25, tier 2, seed 11, walk | 3600 / 3600 (step limit) | 0 | step 0: points | step 0 (then mathRandomCalls) | 0 / 0 | — |
| asis-walk-coast-25-t2-s12 | coast, #25, tier 2, seed 12, walk | 3600 / 3600 (step limit) | 0 | step 0: run, points | step 0 (then mathRandomCalls) | 5 / 5 (differ) | — |
| asis-walk-coast-25-t2-s13 | coast, #25, tier 2, seed 13, walk | 3600 / 3600 (step limit) | 0 | step 0: run, points | step 0 (then mathRandomCalls, gameRngState) | 5 / 5 (differ) | — |
| asis-idle-forest-155-t0-s1 | forest, #155, tier 0, seed 1, idle | 3289 / 3462 (run over) | 0 | step 0: run, points | step 0 (then mathRandomCalls, gameRngState) | 3 / 3 (differ) | 19 field(s) differ: record.time, record.kills, record.damage, record.dmgTotal |
| asis-idle-coast-25-t2-s11 | coast, #25, tier 2, seed 11, idle | 3600 / 3600 (step limit) | 0 | step 0: points | step 0 (then mathRandomCalls) | 5 / 4 (differ) | — |
| math-walk-forest-155-t0-s1 | forest, #155, tier 0, seed 1, walk | 3600 / 3600 (step limit) | 0 | step 0: run | step 0 (then mathRandomCalls, gameRngState) | 3 / 3 (differ) | — |
| math-walk-coast-25-t2-s11 | coast, #25, tier 2, seed 11, walk | 3600 / 3600 (step limit) | 0 | step 1: mathRandomCalls | step 0 (then mathRandomCalls) | 0 / 0 | — |
| shims-walk-forest-155-t0-s1 | forest, #155, tier 0, seed 1, walk | 12000 / 12000 (step limit) | 0 | step 0: points | the end (12000) | 13 / 13 | — |
| shims-walk-forest-155-t0-s2 | forest, #155, tier 0, seed 2, walk | 12000 / 12000 (step limit) | 0 | step 0: points | the end (12000) | 14 / 14 | — |
| shims-walk-forest-155-t0-s3 | forest, #155, tier 0, seed 3, walk | 12000 / 12000 (step limit) | 0 | step 0: points | the end (12000) | 14 / 14 | — |
| shims-walk-coast-25-t2-s11 | coast, #25, tier 2, seed 11, walk | 7083 / 7083 (run over) | 0 | step 0: points | the end (7083) | 11 / 11 | 1 field(s) differ: record.end.env |
| shims-walk-coast-25-t2-s12 | coast, #25, tier 2, seed 12, walk | 11912 / 11912 (run over) | 0 | step 0: points | the end (11912) | 21 / 21 | 1 field(s) differ: record.end.env |
| shims-walk-coast-25-t2-s13 | coast, #25, tier 2, seed 13, walk | 12000 / 12000 (step limit) | 0 | step 0: points | the end (12000) | 21 / 21 | — |
| timing-walk-forest-155-t0-s1 | forest, #155, tier 0, seed 1, walk | 17251 / 17251 (run over) | all 17251 | — | the end (17251) | 19 / 19 | 1 field(s) differ: record.end.env |
| timing-walk-coast-25-t2-s11 | coast, #25, tier 2, seed 11, walk | 7083 / 7083 (run over) | all 7083 | — | the end (7083) | 11 / 11 | 1 field(s) differ: record.end.env |
| single-models-forest-155-t0-s1 | forest, #155, tier 0, seed 1, walk | 3600 / 3600 (step limit) | 0 | step 1: mathRandomCalls, gameRngState | step 0 (then mathRandomCalls, gameRngState) | 3 / 3 (differ) | — |
| single-audio-forest-155-t0-s1 | forest, #155, tier 0, seed 1, walk | 3600 / 3600 (step limit) | 183 | step 184: mathRandomCalls, gameRngState | step 183 (then mathRandomCalls, gameRngState) | 3 / 3 (differ) | — |
| single-uuid-forest-155-t0-s1 | forest, #155, tier 0, seed 1, walk | 17251 / 20678 (run over) | 0 | step 0: run | step 7829 (then mathRandomCalls) | 19 / 24 (differ) | 49 field(s) differ: record.finalSpecies, record.time, record.kills, record.damage |
| single-models-coast-25-t2-s11 | coast, #25, tier 2, seed 11, walk | 3600 / 3600 (step limit) | 0 | step 1: mathRandomCalls | step 0 (then mathRandomCalls) | 0 / 5 | — |
| single-audio-coast-25-t2-s11 | coast, #25, tier 2, seed 11, walk | 3600 / 3600 (step limit) | 266 | step 267: mathRandomCalls, gameRngState | step 266 (then mathRandomCalls, gameRngState) | 0 / 6 | — |
| single-uuid-coast-25-t2-s11 | coast, #25, tier 2, seed 11, walk | 7083 / 7084 (run over) | 5771 | step 5772: mathRandomCalls, gameRngState, pickups | step 5771 (then mathRandomCalls, gameRngState) | 11 / 11 (differ) | 18 field(s) differ: record.time, record.damage, record.dmgTotal, record.econ.gold |
| variant-first-dialog | forest, #155, tier 0, seed 1, walk | 1518 / 1518 (first dialog) | all 1518 | — | the end (1518) | 1 / 1 | — |
| variant-native-hud | forest, #155, tier 0, seed 1, walk | 17251 / 1518 (run over) | 1517 | step 1518: pendingDialog | step 1517 (then pendingDialog) | 19 / 0 | — |
| variant-render | forest, #155, tier 0, seed 1, walk | 6000 / 6000 (step limit) | all 6000 | — | the end (6000) | 6 / 6 | — |
| variant-no-align | forest, #155, tier 0, seed 1, walk | 3600 / 3600 (step limit) | 0 | step 0: runClock | the end (3600) | 3 / 3 | — |
| variant-browser-twice | forest, #155, tier 0, seed 1, walk | 6000 / 6000 (step limit) | all 6000 | — | the end (6000) | 6 / 6 | — |

Reading the groups:

- **equal** (14 episodes, 239,746 steps): identical to the last step in every one. All 14 runs ended (the player
  fainted), so every comparison includes the end-of-run record. Players: `walk` on 3 + 3 seeds, `idle` and `dance`
  on both maps, `seek` on 2 + 2 seeds.
- **models** (3 episodes, 54,605 steps): identical likewise, with every map point's model present on both sides
  (77 of 77, 63 of 63, 78 of 78 at the end) and no `Request` thrown on either. The shim differences D2 and D3 are
  removed on the headless side here, so this group is the same check on the code paths that need a model.
- **timing** (cold sheet cache in the browser, 2 episodes): identical to the last step (D4).
- **shims** (each engine its own Math, everything else as *equal*; 6 episodes, 66,995 steps): not bit-identical from
  step 0, but only three of the eleven hashed groups ever differ: the map points (their 1-ulp coordinates, every
  step), the
  player group (from step 7) and the run's scalars (first between steps 7 and 47). Looked at by field at steps 7 to 10
  of forest
  seed 1, those are `player.squash` (the landing squash of the player's sprite) and `run.camTarget` (the camera's
  target), in the last one or two digits. Everything else is equal at every step of all six episodes: all enemy,
  projectile and pickup arrays, the player's position, HP, XP and level, the director, the statistics, both random
  streams and their call counts, the dialogs and their steps. Two of the six ran to the end of the run and stopped at
  the same step
  with the same record. The game's own autosave at 200 s agrees: 6 to 9 of about 1,900 values differ, namely those
  coordinates,
  `player.squash`, once an item's `spin`, and D6. The
  draft expected positions to drift apart under D1; in these episodes they did not.
- **single**: with only D2 left in, the first difference is at step 1 (the slot machines' lamps: 26 calls against 29
  on forest, 23 against 25 on coast); with only D3, at step 184 (forest) and 267 (coast); with only D10,
  at step 0 the music track only (forest; nothing on coast), and the first random draw apart at step 7,830
  (forest) and 5,772 (coast), when three.js first creates objects during play.
- **math** (common Math on both, nothing else): `run.music` at step 0 where it differs (D10), random draws from
  step 1 (D2).
- **asis**: the map-point coordinates and `run.music` at step 0, random draws from step 1. After 3,600 steps the two
  episodes are different episodes of the same game: same level in 7 of 8, KOs 23 / 24, 27 / 27, 32 / 33, 2 / 2,
  52 / 51, 52 / 50 (walk) and 18 / 19, 44 / 40 (idle), players 0.00006 m to 14 m apart.

### 4.3 Dialogs, map points, and the end of the run

Dialogs are answered identically on both sides by the same `DialogCapture` code, so stage 3 is the continuation of
stage 2 in the same runs. In the 14 *equal* episodes 535 dialogs were raised and answered, the same ones at the same
steps with the same options and masks on both sides:

| Kind (HUD method) | equal | models | Answer the script gives |
|---|---|---|---|
| `levelup` | 372 | 77 | an offer, in rotation |
| `item` | 40 | 9 | take |
| `itemChoice` | 26 | 11 | one of the items, in rotation |
| `blessing` | 25 | 10 | one of the blessings, in rotation |
| `shop` | 20 | 10 | buys what it can afford, in rotation; leaves when nothing is valid |
| `forget` (move tutor) | 13 | 10 | leave (the environment exposes nothing else) |
| `slots` | 12 | 8 | leave |
| `trade` | 7 | 4 | a trade, or decline |
| `dojo` | 6 | 0 | leave |
| `ditto` | 5 | 2 | an item, or decline |
| `seals` | 5 | 2 | a subset of the offered seals |
| `fusion` | 4 | 5 | leave |

Not reached: `evolution` (branch choice), `sanctuaryPath`, `leaveSanctuary`, `overtimeStart`, `overtimeOffer`,
`party`, `shinySwap`, `relic`. Refresh, skip, banish, reroll and sell were never chosen.

**Map points.** The `seek` player used 206 map points in its four *equal* episodes (and 77 in the *models* episode),
of 19 kinds: rocks 59, chests 31, free chests 22, berries 21, altars 14, cursed chests 9, Snorlax 6, challenge
shrines 6, Ditto 5, the guardian's altar 5, cages 4, fossils 4, Rhydon totems 4, Porygon 3, magnets 3, greed shrines
3, cursed shrines 3, nests 2, power altars 2. The log of what was used, at which step and from which distance is
identical between the two sides in every one of them. Interact and ultimate are pressed through the same key taps the
environment sends.

**Beyond the first zone.** In three of the *equal* `seek` episodes and in the *models* one the player woke the zone's
guardian, beat it, took the portal and fainted in zone 2 (at 500 s, 306 s, 297 s and 479 s of game time): a guardian
fight, a portal, a zone load with its stream restart and `run.realTime` set back, all identical on both sides.
Evolution happened in five *equal* episodes (Cyndaquil to Quilava and Typhlosion, Pikachu to Raichu) through the
game's own cut-scene state, without a dialog. One episode in states (`seek`, forest, seed 3; 19,666 steps): 18,507
steps of `play`, 56 dialogs, 156 steps of `cinematic` (the guardian), 548 of `capturing` (two Poké Ball sequences:
the interact key also throws), 37 of `transition` (the zone load; streams restarted with stream index 2 at step
11,918), 217 of `evolving`, 145 of `dead`.

**The end of the run.** All 14 *equal* and all 3 *models* episodes ended with the player fainting; in each the game's
end-of-run record (species, time, KOs, damage, level, moves, items, economy, the level-up roll log, progress counters:
about 3,000 characters) is identical on both sides except `end.env` (D6). The API transcripts are identical call for
call (method, path, body, reply, page-clock time) except that same value in the `finish` body and the autosave hash
that depends on it (D6).

### 4.4 Variants on forest, seed 1 (equal configuration)

| Variant | Result |
|---|---|
| stop at the first dialog | identical for all 1,518 steps; the same dialog on both sides (`showLevelUp`, the same four offers) |
| the browser keeps the game's own HUD (no `DialogCapture`) | identical for 1,517 steps; at step 1,518 the game's own level-up window opens in the browser where headless has the captured decision, and every hashed value is still equal (only the "open dialog" column differs, as it must). Replacing the HUD methods changes nothing up to and including the step that raises the first dialog |
| the browser draws every step with the real renderer (WebGL on the GPU, the random streams put aside during the draw) | identical for all 6,000 steps; the game's autosave at 100 s (1,934 values, 139,066 characters) differs in `end.env` only |
| page clock not equalised after boot (D5) | page-clock stamps differ (`run.bornAt` 16.67 / 0, `run.profAt` 150 / 133.33, the times of API calls, the idempotency key of `POST /runs`); with those stamps left out, identical for all 3,600 steps |
| browser against browser (the same episode twice in Chrome) | identical for all 6,000 steps, and each identical to headless |

## 5. Every difference found

**D1. The engines' Math functions (not a shim).** `node scripts/fidelity/math.ts`, 20,000 inputs per function, Node's
V8 13.6 against Chrome's V8 15.7, re-run for this report with the same result as the draft: `sin` 3.25 % of results
differ, `cos` 3.38 %, `tan` 3.81 %, `asin` 6.13 %, `acos` 7.72 %, `atan` 2.29 %, `atan2` 17.54 %, `sinh` 8.97 %,
`cosh` 8.06 %, `tanh` 16.15 %, `asinh` 3.40 %, `acosh` 3.21 %, `atanh` 7.53 %, `exp` 9.87 %, `expm1` 11.48 %, `log`
2.01 %, `log1p` 6.67 %, `log2` 0.07 %, `log10` 3.60 %, `cbrt` 8.46 %; always by 1 ulp (2 for the hyperbolic ones).
`sqrt`, `pow`, `**`, `hypot`, `fround` and arithmetic are identical. First consequence: map points placed with an
angle (altars, chests, berries …) get a coordinate one ulp apart, e.g. altar z −60.16609236154048 (Node) against
−60.16609236154047 (Chrome). Raw: `data/fidelity/math.json`.

**D2. Headless, three.js cannot load any file (shim).** three.js' `FileLoader` does
`fetch(new Request(url, { headers, credentials, signal }))`, and it is the only `new Request` in the bundle. Under the
shims that constructor always throws, for two independent reasons:

1. `Request` is Node's (kept in `browser.ts`), `AbortController` / `AbortSignal` are the DOM library's (not kept):
   `TypeError: RequestInit: Expected signal ("AbortSignal {…}") to be an instance of AbortSignal`;
2. the game passes page-relative URLs (`./assets/models/slots.glb?v=…`), and Node's `Request` has no document to
   resolve them against: `TypeError: Failed to parse URL from ./assets/models/ball.glb?v=aMaZX7FF`.

The game treats it as a failed download, retries eleven times with back-off (each retry is a new URL, `&r=1` …), then
gives the model up. Headless, 0 of the 26 `.glb` models are ever requested; every map point has no model (forest:
0 of 75 points that would have one; a browser: 75 of 75 right after the reset). What that changes in play: at step 1
the browser makes 3 more `Math.random` calls than headless (2 on coast), all at one site,
`s.kind==='slots' && c?.userData.lamp && (…, Math.random()<e*1.5 && t.vfx.add.spawn({x: s.x+N.range(…), …}))`
(`buildshare-…js`, line 80, column 56026): once per slot machine per step, only when the model's `Lamp` exists, and
when the test passes three more values from the game's own generator `N`.

*Does anything other than effects and random draws depend on a model?* Three pieces of evidence, all saying no:

- **The freshly generated run is the same with and without models.** `node scripts/fidelity/models.ts`: the same
  episode twice headless, once as it is (0 of 75 models) and once with patches (a) + (b) of §6 in memory (75 of 75),
  no browser involved. The static dump right after the reset is identical in all 11,404 values (forest, seed 1; 7,485
  on coast, seed 11): generated terrain, all prop colliders and solid boxes, every map point with its position,
  **interaction radius**, used flag and cost, the player, the director's tables. At step 1 the only values that
  differ are the number of `Math.random` calls (26 against 29) and the state of the game's generator; every hashed
  state group is still equal.
- **A scripted player uses the same map points from the same distance.** Same tool with `--script=seek`, 9,000
  steps, forest, seed 1: both runs used 24 map points; the first 12 are the same point at the same play step from
  the same distance to the millimetre (rocks at 1.799 m and 1.083 m, a chest at 2.598 m, Porygon, berries, a Rhydon
  totem, a cursed chest, an altar), 4,336 play steps into episodes whose random streams differ from step 1. After
  that the enemies have moved the two players apart. On coast (seed 11) the episodes part earlier (2 points the
  same); both runs then used rocks, chests, a cursed chest, Snorlax, a totem, the guardian's altar, a cage and a
  challenge shrine. Every kind of point that was reached was usable in both.
- **Reading the code** (partial, see below). A map point is created as
  `{ kind, x, y, z, r: 2.6, used: false, cost: 0, … }`, its drawing height from a table in the code, before its model
  is asked for; the model is added to the point's scene group when it arrives. Of the 56 places in that chunk that
  mention the group's `userData`, the 33 from the model's arrival onward were read: lid, lever, cap, gem, lamp, ring
  and slab animations, dimming, the portal's vortex, level-of-detail visibility, the sprite draw, and the lamp effect
  above. None of those is in the nearest-point search or in the use / cost code. Prop models (torii, towers, bridges)
  are instanced for drawing; the prop colliders in the static dump are the same with and without them.

What was not done: reading the other users of the model loader (the capture ball in the moves chunk beyond its
`start` method, which only picks the ball to draw, and the boss, main and relay chunks). The one guardian fight
reached (§4.3) was identical in the *models* configuration and in *equal*; that compares shim with browser in each
condition, not one condition with the other.

**D3. The suspended audio context's clock (shim, deliberate).** `NullAudioContext` reports `state: 'suspended'` and
`currentTime = clock.now / 1000`. A suspended `AudioContext` in Chrome reports `currentTime` 0 until it is resumed
(measured again: after 60 s of play headless 60.15, browser 0). The game's `audio.move(key, phase)` rate-limits each
move's sound with that clock in a table that lives on the sound object (`dens`):
`if (c && s - c.t < gap) return true`, and only then draws: `this.kp = .95 + Math.random()*.1` and the kit sound's
own values. So the first sound of each kind draws on both sides, and every later one draws headless and not in the
browser: at step 184 (forest, seed 1) headless has drawn 28 values more than the browser (5,554 calls against 5,526),
every hashed value still being equal at step 183. No sound voice starts on either side.

**D4. The step at which a sprite sheet arrives.** The game's sheet loader (`ku` in `moves-…js`) keeps a module-level
cache, url → promise of the image, behind a four-at-a-time queue. Headless, the image shim now delivers a Pokémon
sheet inside the `src` assignment, so the promise is resolved before it is returned and the sheet is measured and
ready in the step that asked for it, in a fresh process as in a reused one. A browser gives the same only from a warm
cache; from a cold one the sheet arrives one step later in this instrumented browser (which waits for every load
between two steps) and later still in a player's. In this check that difference does not show: with a cold cache and
everything else equal (*timing*), both episodes are identical to the end (17,251 and 7,083 steps), because the
driver's wait between two steps is long enough for the load, and because the UUIDs of the new texture no longer come
from the game's stream (D10). What remains is a statement about a player's browser, which this check cannot observe:
there the sheet is late, and until it arrives an enemy of that species has the default size (radius 0.588 × scale,
height 1.6 × scale) and a stand-in is drawn. Two things to know about the browser side's warm
cache: (a) it is filled through the game's own loader, with the game's own URLs (`./assets/pmd/1.png?v=…`), so the
game finds exactly the entries it would have made; (b) the game's memory trim (`sprites.trim()`, when the sheets in
use exceed about 440 MB) deletes entries from the cache. Headless the next request is again delivered inside the
request; in a browser it would be a new asynchronous load. The browser side therefore puts a trimmed entry back when
it is asked for again. It happened: in the longest episodes the game trimmed up to 44 entries and asked for up to 20
of them again (`seek`, coast, seed 12), and those episodes are among the identical ones.

**D5. One display frame of page clock.** Headless boot needs 1 pumped frame (its image and stylesheet "load" events
are virtual timers); the browser needs 0. Unequalised, the page clock is 16.67 ms behind in the browser: `run.bornAt`
16.67 / 0, the idempotency key of `POST /runs`, the `now` of two boot-time replies, and the pre-reseed state of the
game's generator (4184117190 / 4184117206). Nothing else (variant `no-align`, §4.4). The runs above pump that one
frame in the browser right after boot. Loading takes 8 display frames on both sides.

**D6. The game's environment report.** `end.env` in the result record, in the autosave and in `pb.live`: 66 headless,
82 in the instrumented browser (`end.fns` 802 on both). It is the game's own tamper probe; both values describe an
instrumented page (headless the probe's iframe cannot load; in the browser the clock and `Math.random` are replaced).
What an untouched browser reports was not measured. It is the only difference in the end-of-run record of every
episode that ended in the equal configuration, and the only difference in the autosave (1,934 values, 139,066
characters at 100 s of game time). Because
the autosave differs in that one value, so does its hash, which the game sends with every third checkpoint
(`POST /runs/:id/checkpoint`, field `auto`): the only differences in the API transcripts.

**D7. Pointer lock.** Headless the lock is granted at once (`input.locked` true). In the browser nobody clicks, the
request fails (`pointerlockerror` at run start and after every dialog), and after two failures the game switches to
drag-look (`dragLook` true). With no mouse input neither changes anything in the digest. A player has the lock and
moves the camera, which the environment does not do at all.

**D8. Random draws before play.** `Math.random` calls during boot and menu: 1 headless (it was 1,937 before D10:
almost all of them were UUIDs), 4,697 in the browser as it is, 65 in the browser of the equal configuration; during
the loading phase: 48,090 headless, 66,285 in the browser as it is, the same 48,090 in the equal configuration. Both
streams are restarted when the run is built and when loading ends, so none of it reaches play: the digest of the
state right after the reset is identical in every hashed value in the equal configuration.

**D9. Platform values a page script can read.** A list of 110 values taken on both sides after the episode
(`platformFacts` in `shared.ts`); 46 differ. The shim's choices against this machine's Chrome: user agent
(Chrome 142 / 157), `navigator.vendor` ('' / 'Google Inc.'), `webdriver` (false / true: the oracle is started with
`--enable-automation`), `hardwareConcurrency` (8 / 12), `deviceMemory` (8 / 16), `userActivation` (active / not:
nobody clicks the oracle), screen (1024 × 768 / 1920 × 1080), outer window size, `pointerLockElement` (D7),
`prefers-color-scheme: dark` (false / true: this machine's setting), locale (`en-GB` from Node / `en-US`),
`isSecureContext`, `fullscreenEnabled`, `screen.orientation`; a canvas gives a `webgl` (v1) and a `bitmaprenderer`
context in the browser and not under the shims; and 23 interfaces exist on one side only
(`createImageBitmap`, `OffscreenCanvas`, `indexedDB`, `caches`, `Notification`, `SharedWorker`, `VideoFrame` … in the
browser; `webkitAudioContext` only under the shims). Equal on both: viewport 1280 × 720, device pixel ratio 1,
visibility, focus, language `en-US`, platform `Win32`, `maxTouchPoints` 0, no gamepad, time zone, WebGL 2 present,
the game's own choice of graphics quality (`high`, so the enemy caps are equal: `liveMax` 800, `maxEnemies` 1400).
With all 46 present, the equal configuration is bit-identical: none of them reaches the simulation on the compared
paths. (`prefers-color-scheme` and the locale would show in the game's menus, which are not compared.)

**D10. three.js' UUIDs (environment, deliberate; new since the draft).** `generateUUID` in the three.js chunk takes
four values from `Math.random` for every object, texture, material and geometry. The headless module hook
(`src/sim/loader.ts`) rewrites those four calls in memory to a private stream, so creating a three.js object no
longer moves the game's random numbers. A browser has no such rewrite. Two consequences seen in the *as is* and
*single* cases: (a) **before the first step**, the run picks its music track with a draw whose position in the stream
depends on how many objects were created before it: `run.music` is `ingame1` headless and `ingame5` in the browser
for forest seed 1, and differs in 5 of the 6 seeds (music only: the audio context is suspended); (b) during play,
the first time three.js creates objects during play the browser's stream moves and the environment's does not: at step
7,830 of forest seed 1 the browser has made 17 `Math.random` calls more than headless (301,177 against 301,160), at
step 5,772 of coast seed 11 15 more (182,836 against 182,821). From there the two are different episodes (pickups,
enemies and projectiles differ within a few steps). For the first 3,600 steps of both episodes the music track is the
only difference. With the rewrite mirrored in the browser (`--browser-as-shim=uuid`) both are gone.

**Not differences.** `settings.quality` is `high` on both sides with a real GPU. The browser logs one HLSL warning
from a shader compile; headless logs the known failed iframe. `items/max-revive.png` is missing from the mirror on
both sides (HUD icon; the game retries). Neither side logged a game error (`pb-errs` empty) in any case.

## 6. What in the environment is known to differ from a browser, and why each is left as it is

The draft of this report proposed three shim patches (keep Node's `AbortController` / `AbortSignal`, resolve relative
`Request` URLs, freeze the suspended audio clock). **None was applied; two were decided against.** This is the list of
what the environment is known to do differently from a browser, with the reason each stays.

| | Difference | Kind | Why it stays |
|---|---|---|---|
| D1 | `Math.sin`, `cos`, `exp`, `atan2` … of Node's V8 round differently from Chrome's in 2–17 % of calls | inherent | Not a shim. Any other browser or Chrome version rounds differently again, so no fixed-seed run of this game is bit-reproducible across browsers in the first place. Replacing Math in the environment would make it slower and no closer to any particular browser. |
| D2 | No 3D model ever loads (the shimmed `Request` throws) | shim, known | **Patches not applied.** "No model, ever" is the same in every process. With the patches, models load, and a model first needed during play (a portal after a guardian, a chest dropped by an event) would arrive over several steps in a fresh process and at once in a process that has it cached: one more history dependence of the kind D4 was. The evidence found says no rule depends on a model (D2 in §5): only effects, animations and the random draws that go with them. What would change this decision: a rule found to read a model. None was. |
| D3 | The suspended audio context's clock runs | shim, deliberate | **Patch tried and rejected** by the environment's owner. With `currentTime` frozen at 0 the game's per-sound limiter table, which lives as long as the process, lets only the first sound of each kind *in a process* draw from `Math.random`, so a reused process differed from a fresh one at step 27. With a running clock every sound draws, in every episode alike. The reason is in `src/sim/browser.ts` next to the code. A browser tab nobody clicked is not what a player has either: once clicked, the context runs and voices draw as well. |
| D10 | three.js' UUIDs come from a private stream, not from `Math.random` | environment, deliberate | The game creates three.js objects lazily and caches them per process, so a reused process drew fewer numbers than a fresh one (24 apart when the "guardian fell" texture was first built). UUID values reach no game rule. In a browser these draws are part of the one stream; here they are not. Reason in `src/sim/loader.ts`. |
| D4 | A sprite sheet reaches the game in the step that asks for it | environment, deliberate | It is what the game sees from its own warm cache, and it is the same in a fresh and in a reused process. A browser with a cold cache is later by an amount that depends on the network and the decoder. |
| — | Random streams restarted at run construction and after each zone load; the game's own generator set from the seed; `run.realTime` set back after loading; hunt counters and account id fixed per seed; fixed 1/60 s steps; dialogs answered through HUD method replacement, taking no time | instrumentation (environment.md §3, §6) | Reproducibility. The browser side of this check does the same, so these are **not tested here as differences**: they are part of what both sides share (§8). |
| D5 | Headless boot takes one display frame more than a browser's | shim (virtual load events) | 16.67 ms of page clock, visible only in page-clock stamps and in an idempotency key. No effect on play found. |
| D6 | The game's environment report `end.env` is 66 headless (82 in the instrumented browser) | shim (no iframe) | It describes the page, not the run. It is in the end-of-run record, in the autosave and therefore in the autosave hash sent with checkpoints. Nothing is submitted anywhere. |
| D7 | Pointer lock is granted at once | shim | The environment sends no mouse input; with none, the lock changes nothing in the simulation. |
| D9 | Platform values a page script can read (§5, D9) | shim | None was seen to reach the simulation: with these differences present, the equal configuration is bit-identical. |

For the record, the three rejected patches as they were measured (in memory, in the comparison's own headless
process, `--patch=native-abort,request-base,audio-clock`; the *models* group still uses them, to reach the code paths
that need a model):

```ts
// (a) `native`: keep Node's own classes next to `Request`, which checks for them.
  const native = { …, AbortController: g.AbortController, AbortSignal: g.AbortSignal, … };
// (b) three.js' FileLoader does `new Request(relativeUrl, { signal })`; Node's Request has no document base.
  class SimRequest extends native.Request {
    constructor(input: RequestInfo | URL, init?: RequestInit) { super(typeof input === 'string' ? new native.URL(input, PAGE_URL).href : input, init); }
  }
  def('Request', SimRequest);
// (c) in NullAudioContext: a suspended context's clock stands still.
    get currentTime() { return 0; }
```

If (a) + (b) were ever wanted, every model would have to be loaded before the first run of a process (or delivered
inside the request, as sheets are), for the reason given under D2. If equality with an unclicked browser tab were ever
wanted for D3, (c) alone is not enough, as the owner found; the limiter table is `run.audio.dens` (a `Map` on the
game's sound object), and clearing it at every reset together with (c) would give "first sound of each kind per
episode". **That combination was not tried here.**

Two statements in other documents that the D3 finding contradicts (not edited here, they are not this report's):
`docs/environment.md` §6 ("the game starts no sound voice, so sound code never draws from `Math.random`") and
`docs/game-mechanics.md` §7 ("Sound code draws from `Math.random` only when a voice really starts"). No voice starts,
but `audio.move()` draws a pitch value and the move's sound kit draws its own values before any voice would start:
28 values at step 184 of forest seed 1, with the audio context suspended on both sides.

## 7. What was changed in the browser (all in memory)

Always (every configuration, "as is" included): this is what makes a browser seeded and fixed-step at all.

1. A script evaluated before any page script (about 110,000 characters): the virtual clock (`performance`, `Date`,
   `setTimeout`, `setInterval`, `requestAnimationFrame`, `requestIdleCallback`), seeded `Math.random`,
   `crypto.getRandomValues`, `crypto.randomUUID`, synchronous `crypto.subtle.digest('SHA-256')`.
2. The same script wraps, only to know when asynchronous work has finished: `window.fetch` and the body readers of its
   responses, the `src` setter of `HTMLImageElement`, `createImageBitmap`, `BaseAudioContext.decodeAudioData`; it
   observes `<link>` insertions; it subclasses `AudioContext` to remember the instances; it wraps `console.warn` /
   `console.error` to keep the messages.
3. `localStorage` and `sessionStorage` of the origin cleared, the prepared session written to `pb.session`.
4. The main chunk gets the same two statements the headless module hook inserts (`globalThis.__pb = { app, App, Run }`
   and `__pb.booted = true`).
5. Requests: all answered by CDP `Fetch` from `mirror/` and the mock (ticket `seed` and `id` pinned as headless, the
   mock's ids from the environment's fixed sequence, the mock's `Date.now()` set to the page's clock); every other
   host refused. No HTTP server.
6. CDP emulation: viewport 1280 × 720 at device pixel ratio 1, focus emulation, user input ignored. No autoplay flag:
   the audio context stays suspended as in a tab nobody clicked. Audio muted.
7. `app.launch` wrapped, the random streams and the game generator's state set at run construction and when loading
   ends, `run.realTime` set back when loading ends, 28 HUD methods replaced by `DialogCapture`: the same
   instrumentation as headless (environment.md §6).
8. One extra display frame after boot (D5). The game's registries read by `import()` of already-loaded chunk URLs.

Only with the switches of §3 (all of them in the *equal* configuration):

9. `--common-math`: the twenty Math functions, as on the headless side.
10. `--browser-as-shim=request` (D2): `new Request(url, { signal })` and `new Request(relativeUrl)` throw a
    `TypeError`, at the point where they throw under the shims. three.js' `FileLoader` is the only caller in the
    bundle. Both sides then see the same number of failed constructions (for example 312 on each side in a 17,251-step
    forest episode: 26 models, 12 attempts each).
11. `--browser-as-shim=audio-clock` (D3): while an `AudioContext` is suspended, its `currentTime` and
    `getOutputTimestamp()` report the page clock.
12. `--browser-as-shim=uuid` (D10): the three.js chunk is served with the rewrite the headless module hook makes
    (`generateUUID` takes its four numbers from `globalThis.__pbUuidRandom`), and that stream is defined before any
    page script: `sfc32(0x7e3d1f05)`, never restarted. Pattern, replacement and seed are read from the text of
    `src/sim/loader.ts`, and the run stops unless exactly one chunk was rewritten on each side.
13. `--warm-sheets` (D4): one statement appended to the chunk that holds the game's sprite-sheet loader
    (`;globalThis.__pbSheets={load:ku,cache:xu,url:E};`, names found by shape; appended after the last statement, so
    no position in the chunk moves). Before any run exists, all 543 sheets of `mirror/assets/{pmd,pmd-forms,pmd-shiny}`
    are loaded once through that loader (about 1–2 s; the page clock does not move). `get` and `delete` of the cache
    map are wrapped: an entry the game's own memory trim removes is put back when it is asked for again, so a sheet
    always reaches the game in the step that asks for it. (In the long episodes the game trimmed up to 44 entries and
    asked for up to 20 of them again; each was put back, and the episodes stayed identical.)

`src/cdp/` and `src/sandbox/` were not modified. No npm dependency was added. Nothing under `mirror/`, `src/sim/` or
`src/environment/` was written.

## 8. What this does not show

The browser of this check is itself an instrumented browser. Each of the following separates it from a player's
ordinary session, is shared by both sides, and is therefore **not covered**:

- **Fixed steps.** Every step is exactly 1/60 s. A player's frame time varies; the game clamps a frame to 1/20 s.
- **Seeded randomness.** `Math.random` and `crypto` are seeded generators on both sides; a browser's are not.
- **Streams restarted** when the run is built and after every zone load, and the game's own generator set from the
  seed; a browser session has one stream per page load.
- **The profile and the account**: the unlocked preset through the game's `devUnlock`, hunt counters set from the
  seed, a fixed account id, a pinned ticket seed and id, a local ranked season from the mock. A player's profile comes
  from the real service, which also sends ticket fields the mock does not (`wk`, `blk`; game-mechanics §2).
- **No rendering between updates.** The game's renderer draws from the same `Math.random`. (One variant draws every
  step with the real renderer while the streams are put aside; it shows that drawing changes no simulation state, not
  what a session's stream looks like.)
- **No sound.** The audio context stays suspended on both sides; in a session it runs and voices draw from
  `Math.random`.
- **Dialogs take no time** and are answered through replaced HUD methods (one variant keeps the game's own HUD until
  the first dialog opens). The game's own dialog code, its buttons and its timing are not exercised.
- **Loading**: the page clock stands still while the browser loads, so loading takes no game-visible time, and
  `run.realTime` is set back after it.
- **No pointer, no camera, no gamepad, no focus loss, no pause**, and no input other than the scripted keys.

Not covered for other reasons:

- **Zones 3–4, the sanctuary, overtime, victory**: zone 2 was reached in four episodes (the `seek` player woke and
  beat the first guardian, took the portal and fainted in zone 2), so one guardian fight, one portal and one zone load
  with its stream restart are covered. Zones 3–4, the sanctuary, overtime and victory were not reached.
- **Dialog kinds** other than those in §4.3, and of each kind only the answers `scriptAnswer` gives (options in
  rotation; refresh, banish and reroll never chosen).
- **Maps other than forest and coast; species other than Cyndaquil (155) and Pikachu (25); tiers other than 0 and 2;
  Classic.**
- **Rifts, allies, Max form, incense, manual aim**; capture only as far as §4.3 says.
- **Models first needed during play** in the *models* configuration: their arrival step was not equalised, and no
  difference came from it in the episodes run.
- **Cosmetics**: the preset leaves them at the fresh-account value. One of them asks the game's sheet loader for an
  extra image per species (`mythic/<key>/…png`) that the environment's image shim does not deliver inside the request
  (its pattern covers `pmd`, `pmd-forms`, `pmd-shiny`, `front`). Not reachable with this profile; untested.
- **Other engines**: only this Chrome build. D1 says other builds will differ in the last bit again.
- **Reused headless processes**: every headless episode here is the first of a fresh process. Fresh against reused
  is `scripts/env-determinism.ts` (environment.md §3), not this check.
- Anything the digest does not hash: the effects pools (`run.vfx`), the scene graph, the DOM. The autosave
  comparison, the end-of-run record and the equal `Math.random` call counts at every step make an unseen simulation
  difference unlikely, not impossible.

## 9. Files

| Path | What |
|---|---|
| `src/fidelity/shared.ts` | functions that run unchanged on both sides: digest, static dump, sheet measurement, scripts (`walk`, `dance`, `idle`, `seek`), the play-mask port, model and platform facts, call sites |
| `src/fidelity/headlessRun.ts` | headless side (child process); the in-memory hook for the three rejected shim patches |
| `src/fidelity/chrome.ts` | the oracle Chrome: launch, containment, request routing |
| `src/fidelity/pageAgent.ts` | the script injected into the page; the page-side port of reset / step; the three "as the shim" switches and the warm sheet cache |
| `src/fidelity/browserRun.ts` | browser side: the port of boot and reset, the episode loop |
| `src/fidelity/commonMath.ts` | the common Math implementation |
| `src/fidelity/compare.ts`, `types.ts` | comparison and report |
| `scripts/fidelity/compare.ts`, `suite.ts`, `math.ts`, `models.ts` | command-line entry points |
| `data/fidelity/` | raw results (`data/` is git-ignored), the Chrome profiles. `suite/`: this report's matrix. `suite-before-uuid-change/`, `suite-draft-old/`: earlier partial matrices on earlier states of the environment, kept for reference only |
