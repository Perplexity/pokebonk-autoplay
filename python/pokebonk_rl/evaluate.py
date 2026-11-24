"""Evaluate a saved model on a fixed list of seeds, offline, and compare it with a reference.

  python -m pokebonk_rl.evaluate --model models/runs/<run>/checkpoints/ckpt_000000100000
  python -m pokebonk_rl.evaluate --model <run>            the run's newest checkpoint
  python -m pokebonk_rl.evaluate --model stable           the current stable model
  python -m pokebonk_rl.evaluate --model … --seeds 1-10 --reference baseline-heuristic --set workers.envs=3   (information only)

Every seed is played once, from a file on disk, by a process that shares nothing with a trainer: the model is loaded
from the given checkpoint folder after its hash has been checked. The episodes are stored as a batch (with every
dialog decision), the result as a row of `evaluations` with the comparison and the verdict of the promotion rule in
configs/evaluation.yaml. Exit code: 0 passed or no rule applied, 1 not passed, 2 bad arguments, 3 episodes lost to errors.
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from collections import deque
from pathlib import Path
from typing import Any

from . import offline
from .reward import ended_idle as _ended_idle


def score(e: dict[str, Any]) -> float:
    """KOs plus the overtime bonus when it was cashed. `e` is a stored episode row or an episode record.
    A run ended by the rule against standing still is invalid and scores 0: in the game it would never have ended,
    and a run that does not end is never counted."""
    if _ended_idle(e):
        return 0.0
    if "overtime" in e:
        return float(e["kills"]) + (float(e["overtime"]["bonus"]) if e["overtime"]["cashed"] else 0.0)
    return float(e["kills"]) + (float(e["overtime_bonus"]) if e["overtime_cashed"] else 0.0)


def summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """The figures an evaluation is judged by, over stored episode rows (sqlite rows or dicts with the same keys)."""
    if not rows:
        return {"episodes": 0}
    kos, scores = [float(r["kills"]) for r in rows], [score(r) for r in rows]
    zones: dict[str, int] = {}
    for r in rows:
        zones[str(r["zone"])] = zones.get(str(r["zone"]), 0) + 1
    return {
        "episodes": len(rows),
        "kos_mean": statistics.fmean(kos), "kos_median": statistics.median(kos), "kos_min": min(kos), "kos_max": max(kos),
        "score_mean": statistics.fmean(scores), "score_median": statistics.median(scores),
        "game_time_mean": statistics.fmean(float(r["game_time"]) for r in rows),
        "level_mean": statistics.fmean(float(r["level"]) for r in rows),
        "guardians_mean": statistics.fmean(float(r["guardians_defeated"]) for r in rows),
        "completed": sum(1 for r in rows if r["victory"]), "overtime_cashed": sum(1 for r in rows if r["overtime_cashed"]),
        "died": sum(1 for r in rows if r["terminated"] and not r["victory"]), "truncated": sum(1 for r in rows if r["truncated"]),
        "invalid": sum(1 for r in rows if _ended_idle(r)),
        "zones": dict(sorted(zones.items())),
    }


#: What two batches must share for their results to be compared: the game, the account preset, the rules, and what
#: the player can do (the action and decision schemas: a batch played before the slot machine, the dojo, rifts or
#: Max form could be used is not a reference for one played with them).
COMPARABLE = ("game_build", "bundle_sha256", "profile_preset", "ranked", "hz", "action_repeat", "action_schema", "decision_schema")


def incomparable(mine: Any, reference: Any) -> list[str]:
    """The properties in which two batches differ so that their results cannot be compared (empty: comparable)."""
    return [c for c in COMPARABLE if mine[c] != reference[c]]


def compare(mine: list[dict[str, Any]], theirs: list[dict[str, Any]], metric: str, min_ratio: float) -> dict[str, Any]:
    """Model against reference on the seeds both played: the summaries, the per-seed record, and the promotion rule's verdict."""
    a, b = {int(r["seed"]): r for r in mine}, {int(r["seed"]): r for r in theirs}
    seeds = sorted(set(a) & set(b))
    sa, sb = summarize([a[s] for s in seeds]), summarize([b[s] for s in seeds])
    out: dict[str, Any] = {"seeds_compared": len(seeds), "seeds_missing_in_reference": sorted(set(a) - set(b)), "metric": metric, "min_ratio": min_ratio, "model": sa, "reference": sb}
    if not seeds or set(a) - set(b):
        out.update(ratio=None, passed=False, why="the reference did not play every evaluated seed")
        return out
    if metric not in sa:
        raise KeyError(f"unknown promotion metric {metric!r} (known: {', '.join(k for k in sa if k != 'zones')})")
    wins = sum(1 for s in seeds if score(a[s]) > score(b[s]))
    losses = sum(1 for s in seeds if score(a[s]) < score(b[s]))
    ratio = (sa[metric] / sb[metric]) if sb[metric] else (float("inf") if sa[metric] > 0 else 1.0)
    out.update(ratio=ratio, passed=bool(ratio >= min_ratio), per_seed_by_score={"wins": wins, "losses": losses, "ties": len(seeds) - wins - losses})
    return out


def play_seeds(model, *, layouts, env_options: dict[str, Any], scenario: dict[str, Any], seeds: list[int], reward, workers: int, deterministic: bool,
               recycle_after: int, recycle_rss_mb: int, log_dir: Path | None, step_timeout: float, reset_timeout: float, on_episode, on_error, on_metadata) -> int:
    """Play every seed once with `model`. Returns the number of seeds lost to errors."""
    import numpy as np
    from .bridge import NodeWorker, WorkerError
    from .layout import check_against_metadata
    from .reward import RewardTracker

    pending = deque(seeds)
    started = {"workers": 0, "metadata": False}
    lost = 0

    class Seat:
        def __init__(self):
            self.worker = None
            self.seed = None
            self.frame = None
            self.tracker = RewardTracker(reward)

    def new_worker():
        wid = started["workers"]
        started["workers"] += 1
        log = None
        if log_dir:
            log_dir.mkdir(parents=True, exist_ok=True)
            log = log_dir / f"worker-{wid:04d}.log"
        return NodeWorker(env_options, record_decisions=True, log_path=log, worker_id=wid)

    def begin(seat) -> bool:
        """Start the next pending seed on this seat (False when none is left). A seed whose reset fails is lost, the next one is tried."""
        nonlocal lost
        while pending:
            seat.seed = pending.popleft()
            try:
                if seat.worker is None or seat.worker.closed or seat.worker.episodes >= recycle_after or seat.worker.rss_mb > recycle_rss_mb:
                    if seat.worker is not None and not seat.worker.closed:
                        seat.worker.close()
                    seat.worker = new_worker()
                seat.frame = seat.worker.reset(seat.seed, timeout=reset_timeout, **scenario)
                if not started["metadata"] and seat.worker.metadata is not None:
                    check_against_metadata(layouts, seat.worker.metadata)
                    started["metadata"] = True
                    on_metadata(seat.worker.metadata)
                seat.tracker.reset(seat.frame.header["c"])
                return True
            except WorkerError as e:
                lost += 1
                on_error(e, {"seed": seat.seed, "during": "reset", "workerId": seat.worker.worker_id if seat.worker else None})
                if seat.worker is not None:
                    seat.worker.kill()
        seat.seed = None
        return False

    seats = [Seat() for _ in range(min(workers, len(seeds)))]
    try:
        active = [s for s in seats if begin(s)]
        while active:
            obs = {"float": np.stack([s.frame.float for s in active]), "int": np.stack([s.frame.int for s in active])}
            masks = np.stack([s.frame.mask for s in active]).astype(bool)
            actions, _ = model.predict(obs, action_masks=masks, deterministic=deterministic)
            failed = {}
            for s, a in zip(active, actions):
                try:
                    s.worker.request_step(a)
                except WorkerError as e:
                    failed[id(s)] = e
            still = []
            for s in active:
                try:
                    if id(s) in failed:
                        raise failed[id(s)]
                    s.frame = s.worker.recv(step_timeout)
                except WorkerError as e:
                    lost += 1
                    on_error(e, {"seed": s.seed, "during": "step", "workerId": s.worker.worker_id})
                    s.worker.kill()
                    if begin(s):
                        still.append(s)
                    continue
                episode = s.frame.header.get("episode")
                s.tracker.step(s.frame.header["c"], episode, s.frame.header.get("ot"), bool(s.frame.header.get("sw")), bool(s.frame.header.get("rf")))
                if episode is None:
                    still.append(s)
                    continue
                on_episode(episode, s.tracker.summary(), s.worker.worker_id)
                if begin(s):
                    still.append(s)
            active = still
    finally:
        for s in seats:
            if s.worker is not None and not s.worker.closed:
                s.worker.kill() if s.seed is not None else s.worker.close()
    return lost


def resolve_model(ref: str, models_root: Path, store) -> tuple[Path, dict[str, Any]]:
    """A checkpoint folder from: a path, a run name (its newest checkpoint), `stable`, or `candidate:<id>`."""
    from .checkpoints import latest_checkpoint, read_checkpoint
    from .registry import current_stable
    p = Path(ref)
    if ref == "stable":
        row = current_stable(store)
        if row is None:
            raise LookupError("there is no stable model yet")
        p = Path(row["path"])
    elif ref.startswith("candidate:"):
        row = store.db.execute("SELECT * FROM models WHERE id = ?", (int(ref.split(":", 1)[1]),)).fetchone()
        if row is None:
            raise LookupError(f"no model {ref}")
        p = Path(row["path"])
    elif not (p / "model.zip").exists():
        run_ckpts = models_root / "runs" / ref / "checkpoints"
        latest = latest_checkpoint(run_ckpts)
        if latest is None:
            raise LookupError(f"{ref!r} is neither a checkpoint folder nor a run with a complete checkpoint under {models_root / 'runs'}")
        p = latest
    return p.resolve(), read_checkpoint(p)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="pokebonk_rl.evaluate", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", required=True, help="checkpoint folder, run name, `stable`, or `candidate:<id>`")
    ap.add_argument("--config", help="evaluation configuration file (default: configs/evaluation.yaml)")
    ap.add_argument("--seeds", help='seeds, e.g. "1-30" or "1-5,9" (overrides the configuration)')
    ap.add_argument("--reference", help="what to compare with: a batch id or batch label, `stable`, or `none` (default: the promotion rule's reference)")
    ap.add_argument("--stochastic", action="store_true", help="sample actions instead of taking the most probable one")
    ap.add_argument("--label", help="label of the stored batch (default: eval:<model hash>)")
    ap.add_argument("--set", action="append", default=[], metavar="KEY=VALUE", help="override a configuration key")
    args = ap.parse_args(argv)

    offline.install_network_guard()
    from sb3_contrib import MaskablePPO
    from . import config as cfg
    from .bridge import REPO
    from .layout import load_layouts
    from .registry import current_stable
    from .reward import RewardConfig
    from .storage import Store, dumps

    config = cfg.load(args.config or REPO / "configs" / "evaluation.yaml", cfg.EVALUATION_DEFAULTS, args.set)
    offline.check_config(config)
    seeds = cfg.parse_seeds(args.seeds or config["seeds"])
    deterministic = bool(config["deterministic"]) and not args.stochastic
    scenario = {"species": int(config["scenario"]["species"]), "map": str(config["scenario"]["map"]), "tier": int(config["scenario"]["tier"])}
    layouts = load_layouts(config["game"]["build"])
    reward = RewardConfig.from_dict(config["reward"])
    store = Store(cfg.resolve(config["paths"]["database"]))
    models_root = cfg.resolve(config["paths"]["models"])
    try:
        try:
            ckpt, state = resolve_model(args.model, models_root, store)
        except (LookupError, FileNotFoundError, ValueError) as e:
            print(f"evaluate: {e}", file=sys.stderr)
            return 2
        if state.get("observation_layout_hash") != layouts.observation_hash or state.get("action_layout_hash") != layouts.action_hash:
            print(f"evaluate: {ckpt} was trained on other observation or action layouts than data/encoding/{layouts.build}/ holds; it cannot play this build", file=sys.stderr)
            return 2
        sha = state["model_sha256"]
        import torch
        device = ("cuda" if torch.cuda.is_available() else "cpu") if config["device"] == "auto" else config["device"]
        model = MaskablePPO.load(str(ckpt / "model.zip"), device=device)
        run = store.training_run(state["run"]) if state.get("run") else None

        # ---------------------------------------------------------- the reference
        rule = config["promotion"]
        stable = current_stable(store)
        rule_reference = "stable" if stable is not None and stable["sha256"] != sha else str(rule["first_reference"])
        ref_name = args.reference if args.reference is not None else rule_reference
        # A comparison is a promotion verdict only on the held-out seeds and against the reference the rule names.
        not_a_verdict = []
        if sorted(seeds) != sorted(cfg.parse_seeds(rule["seeds"])):
            not_a_verdict.append(f"played on other seeds than promotion.seeds ({rule['seeds']})")
        if ref_name != rule_reference:
            not_a_verdict.append(f"compared with {ref_name!r}, not with the rule's reference ({rule_reference!r})")
        ref_rows: list[dict[str, Any]] | None = None
        ref_text: str | None = None
        ref_batch = None
        if ref_name != "none":
            try:
                if ref_name == "stable":
                    stable = current_stable(store)
                    if stable is None:
                        raise LookupError("there is no stable model to compare with")
                    ev = store.db.execute("SELECT * FROM evaluations WHERE model_sha256 = ? AND scenario_json = ? AND deterministic = ? ORDER BY id DESC",
                                          (stable["sha256"], dumps(scenario), int(deterministic))).fetchall()
                    ev = [e for e in ev if set(seeds) <= set(json.loads(e["seeds_json"]))]
                    if not ev:
                        raise LookupError(f"the stable model (model {stable['id']}) has no evaluation on these seeds and this scenario: evaluate it first (--model stable --reference none)")
                    ref_batch = store.batch(int(ev[0]["batch_id"]))
                    ref_text = f"stable model {stable['id']} (evaluation {ev[0]['id']}, batch {ref_batch['id']})"
                else:
                    ref_batch = store.find_batch(ref_name)
                    ref_text = f"batch {ref_batch['id']} ({ref_batch['label']})"
                ref_config = json.loads(ref_batch["config_json"])
                ref_scenario = ref_config.get("scenario") or {"species": ref_config.get("species"), "map": ref_config.get("map"), "tier": ref_config.get("tier")}
                if ref_scenario != scenario:
                    raise LookupError(f"{ref_text} was played on {ref_scenario}, this evaluation is on {scenario}")
                ref_rows = [dict(r) for r in store.episodes(int(ref_batch["id"])) if int(r["seed"]) in set(seeds)]
            except LookupError as e:
                print(f"evaluate: {e}", file=sys.stderr)
                return 2

        # ---------------------------------------------------------- play
        w = config["workers"]
        # species / map / tier / maxGameTime are repeated flat, under the names the Node runner uses, so that its reports describe the batch.
        batch_config = {**config, "scenario": scenario, **scenario, "maxGameTime": float(config["env"]["max_game_time"]), "seeds": seeds, "model": str(ckpt), "model_sha256": sha,
                        "deterministic": deterministic}
        batch_id = store.create_batch(label=args.label or f"eval:{sha[:12]}", policy_name="ppo", policy_version=sha[:12], config=batch_config, hz=int(config["env"]["hz"]),
                                      action_repeat=int(config["env"]["action_repeat"]), reward_version=reward.version, episodes_planned=len(seeds))
        t0 = time.time()
        status = "failed"
        print(f"evaluate: {ckpt.name} of run {state.get('run')!r} ({state.get('timesteps')} timesteps, model {sha[:12]}), {len(seeds)} seeds on {scenario}, "
              f"{'most probable action' if deterministic else 'sampled actions'}, batch {batch_id}")

        def on_episode(episode, reward_summary, worker_id):
            store.insert_episode(batch_id, episode, worker_id=worker_id, reward=reward_summary)
            print(f"  seed {episode['seed']:>7}  KOs {episode['kills']:>6}  zone {episode['zone']}  level {episode['level']:>3}  {episode['gameTime']:>7.1f} s  {episode['endCause']}")

        def on_error(error, context):
            store.insert_error(batch_id, kind=error.kind, message=str(error), details={**error.details, **context}, seed=context.get("seed"), worker_id=context.get("workerId"))
            print(f"  seed {context.get('seed')}: LOST ({context.get('during')}): {error}", file=sys.stderr)

        try:
            lost = play_seeds(model, layouts=layouts, env_options=cfg.env_options(config, **scenario), scenario=scenario, seeds=seeds, reward=reward, workers=int(w["envs"]),
                              deterministic=deterministic, recycle_after=int(w["recycle_after"]), recycle_rss_mb=int(w["recycle_rss_mb"]),
                              log_dir=cfg.resolve(config["paths"]["logs"]) / f"batch-{batch_id:05d}", step_timeout=float(w["step_timeout"]), reset_timeout=float(w["reset_timeout"]),
                              on_episode=on_episode, on_error=on_error, on_metadata=lambda m: store.set_batch_metadata(batch_id, m))
            status = "completed" if lost == 0 else "failed"
        finally:
            store.finish_batch(batch_id, status, time.time() - t0)

        # ---------------------------------------------------------- judge
        rows = [dict(r) for r in store.episodes(batch_id)]
        summary = summarize(rows)
        rewards = store.db.execute("SELECT r.total, r.components_json FROM episode_rewards r JOIN episodes e ON e.id = r.episode_id WHERE e.batch_id = ?", (batch_id,)).fetchall()
        if rewards:
            summary["reward_mean"] = statistics.fmean(float(r["total"]) for r in rewards)
            keys = json.loads(rewards[0]["components_json"]).keys()
            summary["reward_components_mean"] = {k: statistics.fmean(float(json.loads(r["components_json"])[k]) for r in rewards) for k in keys}
        summary["lost_to_errors"] = lost
        comparison = None
        passed: bool | None = None
        if ref_rows is not None:
            comparison = compare(rows, ref_rows, str(rule["metric"]), float(rule["min_ratio"]))
            passed = bool(comparison["passed"]) and lost == 0
            if lost:
                comparison["why"] = f"{lost} episode(s) lost to errors"
            # Results are comparable only on the same game, account preset and rules (docs/baseline.md).
            mine = store.batch(batch_id)
            differing = incomparable(mine, ref_batch)
            if differing:
                passed = False
                comparison["passed"] = False
                comparison["why"] = "the reference was played on another " + ", ".join(f"{c} ({ref_batch[c]!r} against {mine[c]!r})" for c in differing)
            comparison["verdict"] = not not_a_verdict
            if not_a_verdict:
                comparison["met_the_rule"] = passed
                comparison["not_a_verdict_because"] = not_a_verdict
                passed = None
        evaluation_id = store.insert_evaluation(batch_id=batch_id, model_path=str(ckpt), model_sha256=sha, run_id=int(run["id"]) if run is not None else None,
                                                timesteps=state.get("timesteps"), deterministic=deterministic, seeds=seeds, scenario=scenario, summary=summary,
                                                reference=ref_text, comparison=comparison, passed=passed)

        print(f"\nevaluation {evaluation_id} (batch {batch_id}): {summary['episodes']} of {len(seeds)} episodes, {lost} lost to errors")
        if summary["episodes"]:
            line = lambda name, s: (f"  {name:<10} KOs mean {s['kos_mean']:.0f}, median {s['kos_median']:.0f}, max {s['kos_max']:.0f}; score mean {s['score_mean']:.0f}, median {s['score_median']:.0f}; "  # noqa: E731
                                    f"completed {s['completed']}, died {s['died']}, invalid (stood still) {s.get('invalid', 0)}; zones {s['zones']}")
            print(line("model", summary))
            if comparison is not None and comparison["seeds_compared"]:
                print(line("reference", comparison["reference"]) + f"   [{ref_text}]")
                if comparison.get("ratio") is not None:
                    ps = comparison["per_seed_by_score"]
                    print(f"  {rule['metric']} ratio {comparison['ratio']:.3f} (needed: {rule['min_ratio']}); per seed by score: {ps['wins']} better, {ps['losses']} worse, {ps['ties']} equal")
        if comparison is not None and not comparison["verdict"]:
            print(f"  for information ({'met' if comparison['met_the_rule'] else 'did not meet'} the rule" + (f": {comparison['why']}" if comparison.get("why") else "") + "); "
                  f"not a promotion verdict: {'; '.join(not_a_verdict)}")
        elif passed is None:
            print("  no reference: nothing was judged")
        else:
            print(f"  verdict: {'PASSED' if passed else 'NOT PASSED'}" + (f" ({comparison['why']})" if comparison.get("why") else ""))
        if lost:
            return 3
        return 0 if passed in (None, True) else 1
    finally:
        store.close()


if __name__ == "__main__":
    sys.exit(main())
