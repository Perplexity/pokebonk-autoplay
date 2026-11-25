"""Train a masked PPO policy on the headless game, offline.

  python -m pokebonk_rl.train --config configs/training.yaml --name my-run
  python -m pokebonk_rl.train --resume my-run                      continue from its newest checkpoint
  python -m pokebonk_rl.train --resume my-run --timesteps 5000000  … up to another total
  python -m pokebonk_rl.train --config … --set workers.envs=3 --set total_timesteps=20000

A run is one model. Its configuration, reward and layouts are fixed when it is created (models/runs/<name>/config.json)
and a resume uses exactly those: only the total number of timesteps can be raised. Stop it with Ctrl+C or by creating
the file models/runs/<name>/STOP: the current step finishes and a checkpoint is written before it exits.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import signal
import sys
import time
from collections import deque
from pathlib import Path
from typing import Any

from . import offline


def build_model(config: dict[str, Any], venv, spec: dict[str, Any], tensorboard: Path | None, device: str):
    from sb3_contrib import MaskablePPO
    from .features import ARCHITECTURE, SetsExtractor
    net = config["network"]
    if net["architecture"] != ARCHITECTURE:
        raise ValueError(f"network architecture {net['architecture']!r} is not implemented (known: {ARCHITECTURE})")
    p = config["ppo"]
    return MaskablePPO(
        "MultiInputPolicy", venv, n_steps=int(p["n_steps"]), batch_size=int(p["batch_size"]), n_epochs=int(p["n_epochs"]), learning_rate=float(p["learning_rate"]),
        gamma=float(p["gamma"]), gae_lambda=float(p["gae_lambda"]), clip_range=float(p["clip_range"]), ent_coef=float(p["ent_coef"]), vf_coef=float(p["vf_coef"]),
        max_grad_norm=float(p["max_grad_norm"]), target_kl=None if p["target_kl"] is None else float(p["target_kl"]),
        policy_kwargs={"features_extractor_class": SetsExtractor, "features_extractor_kwargs": {"spec": spec, "features_dim": int(net["features_dim"])},
                       "net_arch": {"pi": list(net["pi"]), "vf": list(net["vf"])}},
        tensorboard_log=str(tensorboard) if tensorboard else None, seed=int(config["seed"]), device=device, verbose=1)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="pokebonk_rl.train", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", help="training configuration file (configs/training.yaml); not used with --resume")
    ap.add_argument("--name", help="name of the new run")
    ap.add_argument("--resume", metavar="RUN", help="continue this run from its newest checkpoint")
    ap.add_argument("--models", help="with --resume: the models folder the run lives in (default: models)")
    ap.add_argument("--timesteps", type=int, help="total timesteps of the run (overrides the configuration; on resume: the new total)")
    ap.add_argument("--set", action="append", default=[], metavar="KEY=VALUE", help="override a configuration key (new runs only)")
    args = ap.parse_args(argv)

    offline.install_network_guard()

    # Imported after the guard is in place.
    from stable_baselines3.common.callbacks import BaseCallback
    from stable_baselines3.common.vec_env import VecNormalize
    from sb3_contrib import MaskablePPO
    from . import config as cfg
    from .bridge import WorkerError
    from .checkpoints import latest_checkpoint, read_checkpoint, save_checkpoint
    from .layout import load_layouts
    from .manager import build_manager_model, gamma_per_second, load_manager_layouts
    from .evaluate import score
    from .reward import RewardConfig, ended_idle
    from .storage import Store
    from .vec_env import NodeVecEnv, Scenarios

    # ------------------------------------------------------------ configuration: new run or resume
    if args.resume:
        if args.config or args.set or args.name:
            ap.error("--resume uses the run's own stored configuration: --config, --name and --set are not allowed with it")
        models_root = cfg.resolve(args.models or cfg.TRAINING_DEFAULTS["paths"]["models"])
        run_dir = models_root / "runs" / args.resume
        if not (run_dir / "config.json").exists():
            print(f"train: no run {args.resume!r} under {models_root / 'runs'}", file=sys.stderr)
            return 2
        config = json.loads((run_dir / "config.json").read_text("utf-8"))
        name = args.resume
    else:
        if args.models:
            ap.error("--models is for --resume; a new run takes its folders from the configuration (paths.models)")
        config = cfg.load(args.config, cfg.TRAINING_DEFAULTS, args.set)
        name = args.name or config["name"] or "ppo-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S")
        config["name"] = name
        run_dir = cfg.resolve(config["paths"]["models"]) / "runs" / name
        if run_dir.exists():
            print(f"train: the run {name!r} exists ({run_dir}). Continue it with --resume {name}, or choose another --name.", file=sys.stderr)
            return 2
    if args.timesteps is not None:
        config["total_timesteps"] = int(args.timesteps)
    offline.check_config(config)

    # Manager mode (phase 2): the learner decides a skill or a dialog answer about once a game second, on the
    # manager's own layouts. A run is one or the other for good: its stored configuration says which.
    manager = cfg.manager_options(config)
    layouts = load_manager_layouts(config["game"]["build"]) if manager is not None else load_layouts(config["game"]["build"])
    reward = RewardConfig.from_dict(config["reward"])
    store = Store(cfg.resolve(config["paths"]["database"]))
    ckpt_dir = run_dir / "checkpoints"

    resumed_from: Path | None = None
    state: dict[str, Any] = {"episodes_started": 0, "episodes_finished": 0}
    row = store.training_run(name)
    if args.resume:
        if row is None:
            print(f"train: the run {name!r} has a folder but no row in {store.path}", file=sys.stderr)
            return 2
        # Never continue a model under another observation layout, action layout or reward.
        if row["observation_layout_hash"] != layouts.observation_hash or row["action_layout_hash"] != layouts.action_hash:
            print(f"train: the run {name!r} was trained on other layouts than data/encoding/{layouts.build}/ now holds; it cannot be continued", file=sys.stderr)
            return 2
        if json.loads(row["reward_json"]) != reward.to_dict():
            print(f"train: the run {name!r} was trained with another reward than its stored configuration now gives; it cannot be continued", file=sys.stderr)
            return 2
        resumed_from = latest_checkpoint(ckpt_dir)
        if resumed_from is None:
            print(f"train: the run {name!r} has no complete checkpoint to resume from", file=sys.stderr)
            return 2
        state = read_checkpoint(resumed_from)
        run_id = int(row["id"])
    else:
        if row is not None:
            print(f"train: a run named {name!r} is already recorded in {store.path}", file=sys.stderr)
            return 2
        run_dir.mkdir(parents=True)
        (run_dir / "config.json").write_text(json.dumps(config, indent=1), "utf-8")
        run_id = store.create_training_run(name=name, algorithm="MaskablePPO (manager)" if manager is not None else "MaskablePPO", config=config, reward=reward.to_dict(), observation_layout_hash=layouts.observation_hash,
                                           action_layout_hash=layouts.action_hash, game_build=layouts.build, directory=str(run_dir))
    (run_dir / "config.json").write_text(json.dumps(config, indent=1), "utf-8")
    # A STOP file is a request to the session that was running when it was written. One left behind (that session
    # obeyed it and exited) would stop this session at its first step.
    (run_dir / "STOP").unlink(missing_ok=True)

    # ------------------------------------------------------------ records
    w = config["workers"]
    batch_id = store.create_batch(label=f"train:{name}", policy_name="ppo-train", policy_version=name, config=config, hz=int(config["env"]["hz"]),
                                  action_repeat=int(config["env"]["action_repeat"]), reward_version=reward.version, episodes_planned=0)
    start_timesteps = int(state.get("timesteps", 0))
    session_id = store.create_session(run_id, batch_id, start_timesteps, str(resumed_from) if resumed_from else None)
    session_log = cfg.resolve(config["paths"]["logs"]) / name / f"session-{session_id:04d}"
    recent: deque[dict[str, Any]] = deque(maxlen=100)
    counters = {"timesteps": start_timesteps}

    seen = {"profile_preset": state.get("profile_preset")}

    def on_metadata(m: dict[str, Any]) -> None:
        store.set_batch_metadata(batch_id, m)
        # A model belongs to the account preset it was trained on (unlocked-v4 with its item archive, …).
        if seen["profile_preset"] not in (None, m.get("profilePreset")):
            raise RuntimeError(f"the run {name!r} was trained on account preset {seen['profile_preset']!r}; the environment now runs {m.get('profilePreset')!r}")
        seen["profile_preset"] = m.get("profilePreset")

    def on_episode(info: dict[str, Any]) -> None:
        store.insert_episode(batch_id, info["episode"], worker_id=info["worker_id"], reward=info["reward"], timesteps=counters["timesteps"])
        recent.append(info)

    def on_error(error: WorkerError, context: dict[str, Any]) -> None:
        store.insert_error(batch_id, kind=error.kind, message=str(error), details={**error.details, **context}, seed=context.get("seed"), worker_id=context.get("workerId"))
        print(f"train: environment error on seed {context.get('seed')} ({context.get('during')}): {error}", file=sys.stderr)

    scenarios = Scenarios(config["scenarios"]["species"], config["scenarios"]["maps"], config["scenarios"]["tiers"], seed=int(config["seed"]))
    venv = NodeVecEnv(
        n_envs=int(w["envs"]), n_spares=int(w["spares"]), layouts=layouts, env_options=cfg.env_options(config), reward=reward, scenarios=scenarios,
        first_seed=int(config["episode_seeds"]["first"]), first_episode=int(state["episodes_started"]), recycle_after=int(w["recycle_after"]), recycle_rss_mb=int(w["recycle_rss_mb"]),
        record_decisions=bool(config["store_decisions"]), log_dir=session_log, step_timeout=float(w["step_timeout"]), reset_timeout=float(w["reset_timeout"]),
        max_errors=int(w["max_errors"]), on_episode=on_episode, on_error=on_error, on_metadata=on_metadata, manager=manager)
    mcfg = config.get("manager") or {}
    stray0, stray_fade = (float(mcfg.get("stray_penalty", 0.0)), int(mcfg.get("stray_fade_timesteps", 0))) if manager is not None else (0.0, 0)

    def stray_penalty(timesteps: int) -> float:
        """The reward taken away for a decision that is not the heuristic's proposal: from `stray_penalty` to zero, linearly."""
        return stray0 * max(0.0, 1.0 - timesteps / stray_fade) if stray_fade > 0 else 0.0

    status, model, env = "failed", None, venv
    t_start = time.time()
    stop = {"requested": False, "why": ""}
    previous_handler = signal.getsignal(signal.SIGINT)

    def on_sigint(_sig, _frame):
        if stop["requested"]:
            raise KeyboardInterrupt
        stop.update(requested=True, why="interrupted (Ctrl+C); press again to abort without a checkpoint")
        print("\ntrain: stopping after this step, then writing a checkpoint…", file=sys.stderr)

    try:
        import torch
        device = ("cuda" if torch.cuda.is_available() else "cpu") if config["device"] == "auto" else config["device"]
        if resumed_from is not None:
            if (resumed_from / "vecnormalize.pkl").exists():
                env = VecNormalize.load(str(resumed_from / "vecnormalize.pkl"), venv)
            model = MaskablePPO.load(str(resumed_from / "model.zip"), env=env, device=device, tensorboard_log=str(cfg.resolve(config["paths"]["tensorboard"])))
            if model.num_timesteps != start_timesteps:
                raise RuntimeError(f"{resumed_from}: model.zip is at {model.num_timesteps} timesteps, state.json says {start_timesteps}")
        else:
            if config["normalize_reward"]:
                env = VecNormalize(venv, norm_obs=False, norm_reward=True, clip_reward=10.0,
                                   gamma=gamma_per_second(float(mcfg["horizon_seconds"])) if manager is not None else float(config["ppo"]["gamma"]))
            if manager is not None:
                model = build_manager_model(config, env, layouts, cfg.resolve(config["paths"]["tensorboard"]), device)
                if mcfg.get("init_from"):
                    # The warm start: the policy (and value network) of a stored model, usually the copy of the heuristic.
                    from .evaluate import resolve_model
                    src_dir, src_state = resolve_model(str(mcfg["init_from"]), cfg.resolve(config["paths"]["models"]), store)
                    why = layouts.accepts((src_state.get("manager") or {}).get("layouts") or {})
                    if why:
                        raise RuntimeError(f"manager.init_from {src_dir} cannot start this run: " + "; ".join(why))
                    model.policy.load_state_dict(MaskablePPO.load(str(src_dir / "model.zip"), device=device).policy.state_dict())
                    print(f"train: policy taken from {src_dir} (model {src_state['model_sha256'][:12]})")
            else:
                model = build_model(config, env, layouts.extractor_spec(), cfg.resolve(config["paths"]["tensorboard"]), device)
        if manager is not None:
            # The buffer discounts by game time and reads how long each step lasted from the environment.
            model.rollout_buffer.dt_source = venv
            venv.stray_penalty = stray_penalty(model.num_timesteps)
        vecnorm = env if isinstance(env, VecNormalize) else None
        total = int(config["total_timesteps"])
        every = int(config["checkpoint_every_timesteps"])

        def checkpoint(kind: str) -> Path | None:
            if (ckpt_dir / f"ckpt_{model.num_timesteps:012d}").exists():
                return None   # nothing was learned since the last one
            path, sha = save_checkpoint(ckpt_dir, model=model, vecnormalize=vecnorm, timesteps=model.num_timesteps, state={
                "run": name, "kind": kind, "session_id": session_id, "episodes_started": venv.episodes_started,
                "episodes_finished": int(state["episodes_finished"]) + venv.episodes_finished, "observation_layout_hash": layouts.observation_hash,
                "action_layout_hash": layouts.action_hash, "reward_version": reward.version, "game_build": layouts.build,
                "profile_preset": seen["profile_preset"], "archive": config["env"].get("archive"),
                **({"manager": {"options": manager, "plan": mcfg.get("plan") or {}, "horizon_seconds": float(mcfg["horizon_seconds"]), "layouts": layouts.identity()}} if manager is not None else {})})
            store.insert_checkpoint(run_id=run_id, session_id=session_id, kind=kind, timesteps=model.num_timesteps,
                                    episodes=int(state["episodes_finished"]) + venv.episodes_finished, path=str(path), sha256=sha)
            print(f"train: checkpoint {path.name} ({kind})")
            return path

        class Loop(BaseCallback):
            """Checkpoints between updates, the stop request, and the game's own metrics for TensorBoard."""

            def _on_training_start(self) -> None:
                self.last_checkpoint = self.model.num_timesteps
                self.t0, self.steps0, self.wait0, self.episodes0 = time.time(), self.model.num_timesteps, venv.seconds_waiting, venv.episodes_finished

            def _on_step(self) -> bool:
                counters["timesteps"] = self.model.num_timesteps
                if manager is not None:
                    venv.stray_penalty = stray_penalty(self.model.num_timesteps)
                if not stop["requested"] and (run_dir / "STOP").exists():
                    stop.update(requested=True, why=f"stop file {run_dir / 'STOP'}")
                return not stop["requested"]

            def _on_rollout_end(self) -> None:
                now_t = time.time()
                wall = max(1e-9, now_t - self.t0)
                self.logger.record("perf/decisions_per_second", (self.model.num_timesteps - self.steps0) / wall)
                self.logger.record("perf/waiting_for_game_share", (venv.seconds_waiting - self.wait0) / wall)
                self.logger.record("perf/episodes_per_hour", (venv.episodes_finished - self.episodes0) / wall * 3600)
                self.logger.record("perf/environment_errors", venv.errors)
                self.logger.record("perf/game_processes_started", venv.workers_started)
                self.t0, self.steps0, self.wait0, self.episodes0 = now_t, self.model.num_timesteps, venv.seconds_waiting, venv.episodes_finished
                if recent:
                    eps = [r["episode"] for r in recent]
                    n = len(eps)
                    mean = lambda xs: sum(xs) / n  # noqa: E731
                    self.logger.record("game/episodes_in_window", n)
                    self.logger.record("game/kos_mean", mean([e["kills"] for e in eps]))
                    self.logger.record("game/score_mean", mean([score(e) for e in eps]))
                    self.logger.record("game/invalid_share", mean([1.0 if ended_idle(e) else 0.0 for e in eps]))
                    self.logger.record("game/time_mean", mean([e["gameTime"] for e in eps]))
                    self.logger.record("game/level_mean", mean([e["level"] for e in eps]))
                    self.logger.record("game/zone_mean", mean([e["zone"] for e in eps]))
                    self.logger.record("game/guardians_mean", mean([e["guardiansDefeated"] for e in eps]))
                    self.logger.record("game/completed_share", mean([1.0 if e["victory"] else 0.0 for e in eps]))
                    for k in recent[0]["reward"]["components"]:
                        self.logger.record(f"reward/{k}_mean", mean([r["reward"]["components"][k] for r in recent]))
                    self.logger.record("reward/total_mean", mean([r["reward"]["total"] for r in recent]))
                    if manager is not None:
                        self.logger.record("manager/decisions_mean", mean([r["manager"]["decisions"] for r in recent]))
                        self.logger.record("manager/strayed_share", sum(r["manager"]["strayed"] for r in recent) / max(1, sum(r["manager"]["decisions"] for r in recent)))
                        self.logger.record("manager/stray_penalty", venv.stray_penalty)
                if self.model.num_timesteps - self.last_checkpoint >= every:
                    checkpoint("periodic")
                    self.last_checkpoint = self.model.num_timesteps

        signal.signal(signal.SIGINT, on_sigint)
        remaining = total - model.num_timesteps
        print(f"train: run {name!r}, session {session_id}, batch {batch_id}; {model.num_timesteps} of {total} timesteps done; device {device}; "
              f"{w['envs']} game processes + {w['spares']} spare; reward {reward.version}")
        if remaining > 0:
            model.learn(total_timesteps=remaining, reset_num_timesteps=False, tb_log_name=name, callback=Loop(), progress_bar=False)
        if stop["requested"]:
            checkpoint("interrupt")
            status = "interrupted"
            print(f"train: stopped: {stop['why']}")
        else:
            checkpoint("final")
            status = "completed"
        return 0
    except KeyboardInterrupt:
        status = "interrupted"
        print("train: aborted without a checkpoint; the newest earlier checkpoint is intact", file=sys.stderr)
        return 130
    except Exception as e:  # noqa: BLE001  (recorded, then re-raised with its traceback)
        try:
            store.insert_error(batch_id, kind="runner", message=f"{type(e).__name__}: {e}", details={"where": "trainer"})
        except Exception:  # noqa: BLE001
            pass
        raise
    finally:
        signal.signal(signal.SIGINT, previous_handler)
        try:
            venv.close()
        finally:
            store.finish_batch(batch_id, status, time.time() - t_start)
            store.finish_session(session_id, status, int(model.num_timesteps) if model is not None else start_timesteps)
            store.close()


if __name__ == "__main__":
    sys.exit(main())
