# ADR 0001: Run the unmodified game bundle headless in Node as the training environment

Status: accepted (owner review 2026-11-23)
Date: 2026-11-23
Game build: `mwsewi0r` (client 0.10.26)

## Context

The project is changing from a browser-driven bot to an offline reinforcement-learning system. The spec requires
the real game rules, no browser automation, no network, deterministic and accelerated episodes, and a
programmatic reset / step / observe interface.

There is no TypeScript source for the game here. What exists is the website's minified production bundle and its
assets, mirrored locally. Discovery (docs/discovery.md) showed that this bundle boots and plays a full run inside
Node under browser shims, deterministically, at 65–80× real time on one core.

## Decision

1. **The environment is the unmodified bundle** loaded in a Node process with a shimmed browser (happy-dom, null
   WebGL2, pixel-accurate 2D canvas for sprite measurement, null audio, virtual clock, seeded entropy). No game
   rule is reimplemented, simplified or edited. Files under `mirror/` are never changed on disk.
2. **Instrumentation is limited to three declared points**, each listed in every run's metadata:
   - a module load hook that exposes the app instance and the App/Run classes (in memory);
   - the fetch layer, where the game service is answered by the in-process mock and the run ticket's `seed` and
     `id` are pinned;
   - the HUD instance, whose dialog methods are replaced so that choices arrive as structured decisions and are
     answered through the game's own callbacks.
3. **Actions go through the game's own input object** (`press` / `release`), never through DOM events.
4. **One Node process is one environment.** Parallelism is N worker processes. The trainer talks to workers over
   stdin/stdout pipes with length-prefixed messages; no sockets.
5. **Training is in Python** (PyTorch, Stable-Baselines3, Gymnasium) in a separate process; the simulation stays in
   Node. Python 3.15 is installed but too new for the ML stack, so a 3.12 or 3.13 interpreter is added at setup.
6. **Offline enforcement is in-process**: network primitives in both processes record and throw, and a startup
   self-test fails if a connection can be opened. There is no OS-level sandbox, by the owner's decision.
7. **The build is pinned.** Game knowledge (moves, items, kits, passives) is exported from the running game's
   registries into `data/game-knowledge/<build>/` and versioned; a game update is an explicit re-derivation and
   re-validation, never automatic.
8. **The browser harness is retained only as a fidelity oracle**: it may record traces from the real client in the
   local sandbox browser for comparison with headless runs. It is never used to train or to play.

## Alternatives considered

- **Rewrite the rules as new TypeScript.** Rejected: 3+ MB of minified logic cannot be reproduced faithfully, and
  it would be a reimplementation of someone else's game.
- **Construct `Run` directly with stub renderer / HUD / meta, skipping the App.** Smaller surface, but it requires
  stubbing interfaces whose full extent is unknown, and skips the game's own start-of-run path. Booting the whole
  app turned out to work and is closer to the original.
- **Keep driving a real browser, faster.** Rejected by the spec, and capped at about ×6.
- **TypeScript-native training.** Avoids a second runtime but gives up the standard RL tooling; rejected by the
  owner.

## Consequences

- Fidelity is as high as it can be without the source: the rules are the shipped code. The risks are in the shims
  and the stepping, listed in docs/discovery.md §7, chiefly the step-rate-dependent enemy cap and sprite-derived
  collision sizes.
- Throughput is bounded by the game's own per-step cost (about 0.7 ms early, more with large hordes) and by a
  1.65 s reset.
- Every game update can break identifier patterns and field names. The harness is tied to a build on purpose.
- The offline guarantee is weaker than OS isolation and depends on the guard being complete; the self-test and the
  attempt log are what make that checkable.
- The result is for offline use. Nothing here connects to, or is meant to be pointed at, the live service.

## Decisions taken at review (2026-11-23, by the owner)

1. Step rate: **60 Hz**, with action repeat (default 3, so 20 decisions per second). Measured in Stage 1: the game's
   frame-rate governor never cuts the live-enemy cap at this rate.
2. Profile: a fresh account with **everything unlocked**, including items and permanent stat upgrades.
3. Episode: a **full Ranked run** (zones 1–3, the sanctuary, overtime) played until it ends. The objective is the
   most KOs before the run can no longer continue, ending the run in the final zone. A game-time cap exists only as
   an optional safety limit and ends an episode as truncated.
4. Target rules: **Ranked**, offline. In this build that is the standard mode with the `competitive` run option
   (docs/game-mechanics.md §2).

The instrumentation list in point 2 of the decision grew during Stage 1; the authoritative list is
docs/environment.md §6 and `getMetadata().instrumentation`.
