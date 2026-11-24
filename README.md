# pokebonk-autoplay

A private practice environment for PokéBonk (a free browser fan game, three.js/WebGL) with an AI player in it.

- **Sandbox host** — a small Node server that serves a local copy of the game's public static files and stands in
  for the game's API. Sessions, profiles, runs, saves and results live in `./data` on this machine.
- **Autopilot** — drives the sandboxed game through the Chrome DevTools Protocol: it reads the run's state about
  ten times a second, decides with a pure-function policy, and sends real key presses and clicks.

**Offline by design.** The bot plays the copy on `localhost`. The sandbox browser cannot resolve any hostname but
`localhost`, every request it makes is routed (API calls → the local mock, anything else → blocked and logged), and
the bot refuses to act on a page that is not the sandbox origin. Nothing is submitted to the live game service, no
real account is used, no leaderboard or other player is involved. This project is not for playing on the live
service and has no option to point it there.

Two things worth knowing:

- The game's own code marks automated clients in the result it reports at the end of a run. The sandbox browser is
  started with Chrome's standard automation flag and makes no attempt to hide: you will see that marker
  (`end.env`) in the run files under `data/runs/`. Here it is just a number in a local file.
- `./mirror` holds a copy of someone else's game. It is for running the game on your own machine; it is
  git-ignored: do not publish or redistribute it.

## Offline reinforcement learning (headless)

The project's current direction. The same local copy of the game runs **without a browser**, inside Node, as a
training environment, and a policy is trained on it with PyTorch. The browser autopilot described in the rest of
this file is the older part; it is kept as the reference the headless environment is checked against
(`docs/fidelity.md`), not as a way to train or play.

```sh
npm run export:knowledge && npm run export:encoding   # once per game build: data tables and buffer layouts
node scripts/run-episodes.ts --policy=heuristic --episodes=30 --workers=5   # scripted baselines into data/pokebonk.sqlite

py -3.13 -m venv .venv                                 # once: Python side (training)
.venv\Scripts\python -m pip install torch --index-url https://download.pytorch.org/whl/cu128
.venv\Scripts\python -m pip install -e .[test]

.venv\Scripts\python -m pokebonk_rl.train --config configs/training.yaml --name my-run
.venv\Scripts\python -m pokebonk_rl.train --resume my-run
.venv\Scripts\python -m pokebonk_rl.evaluate --model my-run
.venv\Scripts\python -m pokebonk_rl.registry list
.venv\Scripts\tensorboard --logdir logs/tensorboard --host 127.0.0.1
```

Training and evaluation use no network: the game processes and the trainer each refuse connections in their own
process, and they talk to each other over pipes. Installing the Python packages is the only step that downloads
anything.

| Read | For |
|---|---|
| `docs/environment.md` | the headless environment: interface, reproducibility, what is instrumented |
| `docs/observation.md`, `docs/game-knowledge.md` | what the policy sees, and the exported game data |
| `docs/baseline.md`, `docs/storage.md` | the episode runner, the scripted baselines, the database |
| `docs/training.md` | training, checkpoints, evaluation, candidate and stable models |
| `docs/fidelity.md` | how the headless game was compared with the game in Chrome |
| `docs/stage-1-report.md`, `docs/stage-2-report.md` | what each stage delivered and measured |

## Requirements (browser autopilot)

- Node.js 24 or newer (TypeScript runs directly; there is no build step and no runtime dependency)
- Google Chrome or Microsoft Edge
- A GPU that runs WebGL 2

## Setup

```sh
npm install          # dev tools only: the TypeScript checker and Node types
npm run mirror       # one-time copy of the game's public static files into ./mirror
npm start -- --fill  # first session(s): warm-up, see below
```

`npm run mirror` downloads the page, its JS/CSS chunks, the data files and the files named in the bundles
(~900 files, ~40 MB), with plain GETs like a normal visit. Add `-- --deep` to also fetch the per-species sprites,
portraits, icons and cries up front.

Sprites, music and map textures are addressed by id and loaded as a run needs them. **Warm-up** (`--fill`) lets
the mirror fetch a static file it does not have yet, once, and keep it. It is the only other thing that talks to
the public site, it is off by default, and it only ever issues GETs for static files (no login, no API). After a
couple of warm-up runs the mirror is complete for the maps you play and you never need `--fill` again; a file that
is still missing shows up in `data/logs/missing-assets.log` (the game draws a placeholder for a missing sprite).

Run `npm run mirror` again when the live build changes (the chunk names change with it).

## Run

```sh
npm start                 # sandbox host + sandbox browser + bot; plays run after run until you stop it (Ctrl+C)
npm run dry-run           # perceive and decide, log the decisions, send no input (you play; the bot narrates what it would do)
npm run browser           # host + sandbox browser, no bot: play by hand
npm run sandbox           # host only
npm test                  # unit tests of the strategy layer and the mock API
npm run typecheck
```

Flags after `--`: `--headless`, `--runs=3` (stop after N runs), `--bank=600` (end the run and bank it after N seconds
of run time), `--species=4,1,7` (Pokédex ids to prefer, first one the profile has), `--mode=standard`,
`--port=8080`, `--fill`, `--debug`, `--trace-hits`, `--speed=4`.

Dashboard: <http://localhost:8080/__sandbox/> — run journal (runs, time survived, level, deaths, captures), what the
bot is doing now, and its recent decisions.

The first start walks through the game's own onboarding in the sandbox profile: language, guest session, starter
picks, the intro and the guide. Later starts restore the session from the sandbox browser's profile.

## Faster runs

`npm start -- --speed=4` (or `"bot": { "speed": 4 }`) runs the game faster than real time so results come in
sooner. How, and what it costs:

- The game steps its simulation by `min(frame time, 1/20 s) × timeScale`. The sandbox sets that time scale. **This
  is the one place where it writes to the game's state instead of only reading it**; it is off by default
  (`speed: 1` leaves the game untouched), and it only makes sense in the sandbox.
- The step is never allowed to exceed 1/20 s of game time, the largest step the game takes on its own, so physics
  stay within what the game is built for. That makes the reachable speed `frames per second ÷ 20`: about ×3 at
  60 fps. With `speed` above 1 the browser is started without its frame-rate limit, which on a decent GPU gives
  well over 100 fps and so ×5 to ×8. The log says what it settled on (`game speed ×5.5 (112 fps)`).
- The bot ticks `speed` times as often, so it sees and decides as often per second of game time. Above roughly ×6
  it can no longer keep up with that (each tick takes ~10–15 ms) and it plays a little worse than at ×1.
- The game's own slow-motion moments are left alone. Menus and dialogs are not sped up.

Journal times are game time, so runs at different speeds compare directly. A browser-level alternative (DevTools
virtual time) was tried and has no effect on a visible, GPU-driven page.

## Configure

Optional `config.json` in the repo root; anything not set keeps its default (`src/config.ts`).

```json
{
  "port": 8080,
  "browser": { "headless": false, "width": 1280, "height": 800, "mute": true, "lang": "en", "path": "" },
  "bot": {
    "tickHz": 10,
    "species": [4, 1, 7],
    "bankAfterSec": 0,
    "maxRuns": 0,
    "stuckSec": 25,
    "recordEverySec": 0,
    "speed": 1,
    "traceHits": false,
    "tuning": { "lowHp": 0.42, "wakeLevel": [14, 22, 30], "ultHerd": 8, "hordeSize": 45 },
    "builds": { "155": [{ "name": "mine", "core": ["Burning Jealousy", "Temper Flare"], "scale": ["area", "damage"], "avoid": [] }] }
  }
}
```

Every heuristic weight is listed with a comment in `src/bot/brain/tuning.ts`. Builds are in `src/bot/brain/builds.ts`.
Keep `browser.lang` at `en`: dialogs are recognised by structure first, but button labels are matched in English.

## How it plays

The policy (`src/bot/brain/`) is a pure function of the state snapshot.

- **Survival first.** Sixteen headings (and standing still) are scored. For every enemy: how close does it get if
  the bot walks that way, both if it keeps its course (closest approach of two straight paths, which sees a head-on
  meeting coming) and if it turns to chase. Plus how crowded each side is, strike circles (out before they land),
  pools, shot lanes, the dash lanes of chargers and bosses (left sideways, never outrun). Hard hitters get half
  again as much room. Escaping a surround beats kills: the bot takes the gap and dashes when the ring is tight.
  Shock rings are jumped as they arrive.
- **Terrain.** The world is not flat. Every tick the bot measures, in 16 directions, how far it can walk and how
  far it can get by jumping, from the game's own height map and prop colliders: it does not steer into walls,
  trees, water or the map edge (a square), and it climbs hills by jumping all the way up. Far goals are reached
  along an A* route over the terrain, replanned twice a second. If it still makes no headway it jumps, leans to
  one side, and finally gives the spot up.
- **The edge.** A horde that follows the bot into a corner has it. Ground within 32 m of the map edge costs more
  the nearer it is, and near the edge circling and fleeing bend back towards open ground, on the side that leads
  the pack inwards.
- **Over the crowd.** Jumping clears a crowd of walkers. When it is ringed in the bot jumps, and while it is in the
  air ground enemies count for little (flyers and bosses still count), so it crosses over the pack and lands on
  the far side with the pack still bunched behind it.
- **Herding.** In a fight it circles the pack at the range its moves want instead of running from it, so what
  chases it ends up in one clump where the cone, the shockwave and the ultimate hit the most at once. A fight
  within reach is finished before anything else is fetched.
- **Targeting.** The game aims for you (auto-aim); the bot chooses where to stand. When healthy and not pressed it
  positions on ranged and support enemies and on elites that are nearly down, at the range the kit's moves want.
- **Ultimate.** Used in the guardian fight, when surrounded, when most of the herd is bunched inside its reach,
  or when hurt and pressed; under high arena pressure it is used on cooldown, except when the guardian is about to
  be woken.
- **Zone flow.** Level up, then wake the zone's guardian at its altar (level threshold per zone with the ultimate
  mostly charged, or a time limit), fight it at kit range, take the portal. Optional handicaps offered before the
  fight are declined.
- **Level-up picks.** Curated builds per starter line: upgrade core moves first, then take new core moves, then
  what the build scales with (area, damage, ...). Survivability only when needed: under 50% HP, or when a single hit
  takes more than a fifth of the HP bar. Situational new moves only early and with a free slot. A weak hand is
  refreshed while refreshes are left.
- **Balls and loot.** Free first: Great Balls, then cursed balls. A paid Poké Ball only when the Pokédollars
  earned from KOs cover its current price, which rises with every ball bought. Altars and berries too. All of it
  only while it is calm, the horde is small and no fight is within reach.
- **Captures.** When a capture window opens, the target is approached and the ball thrown, rarer targets with more
  urgency, never out of a crowd or at low HP.
- **Low HP.** Below 42% the bot drops every goal and runs from the weight of what is near (to a berry if one is close).
- **Diagnostics.** Every hit is logged with what was around; `--trace-hits` also writes the 1.5 s of snapshots and
  decisions before each hit to `data/hits/` (`node scripts/hit-trace.ts` prints them, `node scripts/explain.ts <file>`
  shows the score of every heading for one snapshot). Several tests are recorded hits turned into regressions.
- **Mutations.** The daily arena-wide modifier is read as its effect on enemies (speed, damage, HP, numbers) and the
  margins move with it: faster enemies → wider kiting and an earlier dash, harder hits → more distance and earlier
  healing picks, bigger crowds → an earlier ultimate.
- **Safety nets.** If nothing changes for `stuckSec` the session tries Escape, then a visible button, then reloads
  the page; a run that was live comes back from its save through the mock's resume endpoints. A page that leaves
  the sandbox origin is brought back before any input is sent.

## Layout

```
src/main.ts                 npm start
src/config.ts               defaults, config.json, flags
src/logger.ts               console + data/logs/bot-<date>.log
src/sandbox/server.ts       the sandbox host (mirror, /__api, /__sandbox)
src/sandbox/mirror.ts       static files: serve, one-time copy, warm-up
src/sandbox/mockApi.ts      the mock API        → docs/ENDPOINTS.md
src/sandbox/progress.ts     the sandbox's own progression rules
src/sandbox/store.ts        JSON persistence under ./data
src/cdp/client.ts           minimal DevTools Protocol client
src/cdp/browser.ts          sandbox browser: launch, network containment, request routing
src/bot/perception.ts       finds the run object, takes snapshots        → docs/SNAPSHOT.md
src/bot/extract.ts          the snapshot reader (runs in the page, read-only)
src/bot/ui.ts               the DOM reader (runs in the page, read-only)
src/bot/snapshot.ts         snapshot types
src/bot/brain/              the policy: movement.ts, choices.ts, builds.ts, tuning.ts (pure functions)
src/bot/executor.ts         keys and clicks through the browser
src/bot/session.ts          run lifecycle, menus, dialogs, stuck detection, recovery
src/dashboard/index.html    the dashboard page
scripts/                    developer probes (snapshot recorder, run-object probe, route planner, hit traces, endpoint table)
test/                       unit tests + fixtures recorded from sandbox play
```

## Limits

- **Modes.** The bot starts Classic runs from the Play menu. The other modes on the priority list (daily
  Mutation, boss rush, expedition, training) are understood by the policy and the mock (a mutation ticket carries a
  mutation of the day; the policy adapts to its multipliers), but the session manager does not navigate to them
  yet, and the sandbox profile starts with them locked the way a new account does.
- **Progression** in the sandbox is the mock's own approximation (`src/sandbox/progress.ts`), not the game's rules.
- **Builds** for starters other than the one played during development are first drafts: move names that do not
  match a card are simply never preferred, and the build falls back to its stat weights.
- **Aim** is the game's auto-aim. The bot does not move the camera.
- **Guardians and bosses** are the weakest part. Strike circles, pools, shock rings, shots and charge lanes are
  read generically and the fight is kept at the far end of the kit's reach, but in the runs recorded so far the
  bot has not beaten a zone guardian: it reaches the first one healthy and loses the fight (status effects such
  as paralysis are not handled, and a guardian woken late arrives on top of a large horde). A boss with a
  mechanic that is none of the above (one that rewinds its attacks or shifts the arena) is survived by distance
  and dodging, not by a script for that boss.
- **Game updates** can rename what the readers look for. `scripts/probe-run.ts` and `data/logs/modals.jsonl` are
  the tools for catching up.
