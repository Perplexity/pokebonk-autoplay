"""Play one episode with a stored model and print what happens, a JSON line per moment, for somebody to watch.

  python -m pokebonk_rl.watch --model <checkpoint folder | run name | stable | candidate:<id>> --seed 5 [--speed 4]

Started by the dashboard (dashboard/server/watch.ts), which passes the lines on to the page; it can be run by hand
too. One game process, no network (the same guard as training), nothing written to the database or the models folder.

Lines, in order:
  {"t": "start", "model", "sha256", "run", "timesteps", "seed", "scenario", "deterministic", "speed"}
  {"t": "frame", …the bridge's top-down view (src/ipc/server.ts, viewOf)…, "action": what the model does next}
  {"t": "end", "kills", "score", "gameTime", "level", "zone", "endCause", "steps"}

`--speed N` paces the episode at N times real time (the game makes 20 decisions per game second); 0 plays as fast as
the machine allows. At most about 30 frames a second are printed; moments with an open dialog are always printed.

An episode stored by an evaluation is watched again by giving its model and seed: with the most probable action
(the default) the same file on the same seed plays the same episode (docs/training.md §5).
"""
from __future__ import annotations

import argparse
import json
import signal
import sys
import time
from typing import Any

from . import offline

MAX_FPS = 30.0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="pokebonk_rl.watch", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", required=True, help="checkpoint folder, run name, `stable`, or `candidate:<id>`")
    ap.add_argument("--seed", type=int, required=True)
    ap.add_argument("--speed", type=float, default=4.0, help="times real time; 0 = as fast as possible")
    ap.add_argument("--stochastic", action="store_true", help="sample actions instead of taking the most probable one")
    ap.add_argument("--species", type=int, help="Pokémon (default: the evaluation scenario)")
    ap.add_argument("--map")
    ap.add_argument("--tier", type=int)
    ap.add_argument("--config", help="evaluation configuration file (default: configs/evaluation.yaml)")
    ap.add_argument("--set", action="append", default=[], metavar="KEY=VALUE", help="override a configuration key")
    args = ap.parse_args(argv)

    offline.install_network_guard()
    from sb3_contrib import MaskablePPO
    from . import config as cfg
    from .bridge import REPO, NodeWorker, WorkerError
    from .evaluate import resolve_model, score
    from .layout import check_against_metadata, load_layouts
    from .storage import Store

    def say(event: dict[str, Any]) -> None:
        sys.stdout.write(json.dumps(event, separators=(",", ":")) + "\n")
        sys.stdout.flush()

    config = cfg.load(args.config or REPO / "configs" / "evaluation.yaml", cfg.EVALUATION_DEFAULTS, args.set)
    offline.check_config(config)
    scenario = {"species": int(args.species if args.species is not None else config["scenario"]["species"]), "map": str(args.map or config["scenario"]["map"]),
                "tier": int(args.tier if args.tier is not None else config["scenario"]["tier"])}
    layouts = load_layouts(config["game"]["build"])
    store = Store(cfg.resolve(config["paths"]["database"]))
    try:
        try:
            ckpt, state = resolve_model(args.model, cfg.resolve(config["paths"]["models"]), store)
        except (LookupError, FileNotFoundError, ValueError) as e:
            print(f"watch: {e}", file=sys.stderr)
            return 2
    finally:
        store.close()
    if state.get("observation_layout_hash") != layouts.observation_hash or state.get("action_layout_hash") != layouts.action_hash:
        print(f"watch: {ckpt} was trained on other observation or action layouts than data/encoding/{layouts.build}/ holds; it cannot play this build", file=sys.stderr)
        return 2
    import torch
    device = ("cuda" if torch.cuda.is_available() else "cpu") if config["device"] == "auto" else config["device"]
    model = MaskablePPO.load(str(ckpt / "model.zip"), device=device)
    deterministic = not args.stochastic
    dims = layouts.action["dims"]

    def in_words(action, view: dict[str, Any]) -> dict[str, Any]:
        """The action vector as the page shows it: a direction, the buttons pressed, and the dialog answer."""
        a = [int(x) for x in action]
        choice = None
        if view.get("phase") == "choice":
            name = dims[-1]["values"][a[-1]]
            options = (view.get("decision") or {}).get("options") or []
            if name.startswith("option:") and int(name[7:]) < len(options):
                choice = options[int(name[7:])]
            else:
                choice = name.replace("extra:", "")
            return {"move": 0, "buttons": [], "choice": choice}
        return {"move": a[0], "buttons": [d["name"] for d, v in zip(dims[1:-1], a[1:-1]) if v], "choice": None}

    # The dashboard ends a session by ending this process: leave no game process behind.
    def stop(_sig, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)

    worker = NodeWorker(cfg.env_options(config, **scenario), view=True)
    try:
        frame = worker.reset(args.seed, timeout=float(config["workers"]["reset_timeout"]), **scenario)
        check_against_metadata(layouts, worker.metadata)
        say({"t": "start", "model": str(ckpt), "sha256": state["model_sha256"], "run": state.get("run"), "timesteps": state.get("timesteps"), "seed": args.seed, "scenario": scenario,
             "deterministic": deterministic, "speed": args.speed})
        per_decision = int(config["env"]["action_repeat"]) / int(config["env"]["hz"])   # game seconds per decision
        started, game_clock, last_print = time.monotonic(), 0.0, 0.0
        while True:
            view = frame.header["v"]
            obs = {"float": frame.float[None], "int": frame.int[None]}
            action, _ = model.predict(obs, action_masks=frame.mask.astype(bool)[None], deterministic=deterministic)
            now = time.monotonic()
            dialog = view["phase"] == "choice"
            if dialog or args.speed == 0 or now - last_print >= 1.0 / MAX_FPS:
                say({"t": "frame", **view, "action": in_words(action[0], view)})
                last_print = now
            if args.speed > 0:
                # A dialog takes no game time; give the eye a moment to read it.
                game_clock += 0.4 if dialog else per_decision
                ahead = game_clock / args.speed - (time.monotonic() - started)
                if ahead > 0:
                    time.sleep(min(ahead, 1.0))
            frame = worker.step(action[0], timeout=float(config["workers"]["step_timeout"]))
            episode = frame.header.get("episode")
            if episode is not None:
                say({"t": "frame", **frame.header["v"], "action": None})
                # The evaluator's own score: 0 for a run that was ended for standing still.
                say({"t": "end", "kills": episode["kills"], "score": score(episode), "gameTime": episode["gameTime"], "level": episode["level"], "zone": episode["zone"],
                     "endCause": episode["endCause"], "steps": episode["steps"]})
                return 0
    except KeyboardInterrupt:
        return 130
    except WorkerError as e:
        print(f"watch: the game process failed: {e}", file=sys.stderr)
        return 1
    finally:
        worker.kill()


if __name__ == "__main__":
    sys.exit(main())
