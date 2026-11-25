"""The manager's warm start: copy the phase 1 heuristic (phase 2 of the heuristic + RL refactor).

  python -m pokebonk_rl.bc collect --config configs/manager.yaml --seeds 1000000-1000019 --out data/bc/plan3
  python -m pokebonk_rl.bc fit     --config configs/manager.yaml --data data/bc/plan3 --name manager-copy-01

`collect` plays whole episodes in manager mode with every decision the heuristic's own proposal (which is the
heuristic itself, to the key press: src/hybrid/manager.ts) and stores, for every decision, the manager's observation,
the mask, the proposal, the game seconds the step lasted and the run's counters. Nothing of it depends on a reward
version: any reward can be computed from the counters later.

`fit` builds the manager's network and trains its policy to give the stored proposal (cross-entropy on the masked
action distribution), then writes it as a run with one checkpoint at 0 timesteps: a model like any other, to be
evaluated (`pokebonk_rl.evaluate --model <name>`) and to start a PPO run from (`manager.init_from`).

The network has a direct path from the proposal (an input) to the action, primed before any training
(manager.prime_proposal): the copy is close to exact by construction. What `fit` adds is sharper probabilities for
sampled play and a first training of the rest of the network. The check that matters is the evaluation of the copy
against the heuristic on whole episodes.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from collections import deque
from pathlib import Path
from typing import Any

import numpy as np

from . import offline

HELD_OUT = range(900001, 900051)


# ---------------------------------------------------------------- storage of one episode: sparse rows

class _Sparse:
    """Rows of a mostly-zero matrix: indexes and values of the non-zeros, row after row."""

    def __init__(self, dtype):
        self.dtype, self.idx, self.val, self.ptr = dtype, [], [], [0]

    def add(self, row: np.ndarray) -> None:
        nz = np.flatnonzero(row)
        self.idx.append(nz.astype(np.uint16))
        self.val.append(row[nz].astype(self.dtype))
        self.ptr.append(self.ptr[-1] + len(nz))

    def arrays(self, prefix: str) -> dict[str, np.ndarray]:
        cat = lambda xs, dt: np.concatenate(xs) if xs else np.zeros(0, dt)  # noqa: E731
        return {f"{prefix}_idx": cat(self.idx, np.uint16), f"{prefix}_val": cat(self.val, self.dtype), f"{prefix}_ptr": np.asarray(self.ptr, np.int64)}


def dense(idx: np.ndarray, val: np.ndarray, ptr: np.ndarray, rows: np.ndarray, width: int, dtype) -> np.ndarray:
    """The rows `rows` of a stored sparse matrix, dense."""
    out = np.zeros((len(rows), width), dtype)
    for k, r in enumerate(rows):
        a, b = int(ptr[r]), int(ptr[r + 1])
        out[k, idx[a:b]] = val[a:b]
    return out


class _Recorder:
    def __init__(self, n_actions: int):
        self.n_actions = n_actions
        self.f, self.i = _Sparse(np.float32), _Sparse(np.int32)
        self.mask, self.action, self.dt, self.kills, self.bonus, self.time = [], [], [], [], [], []

    def add(self, frame, action: int) -> None:
        self.f.add(frame.float)
        self.i.add(frame.int)
        self.mask.append(np.packbits(frame.mask.astype(bool)))
        self.action.append(action)
        c, ot = frame.header["c"], frame.header.get("ot") or {}
        self.kills.append(float(c.get("kills", 0)))
        self.bonus.append(float(ot.get("bonus", 0) or 0))
        self.time.append(float(c.get("time", 0)))

    def stepped(self, dt: float) -> None:
        self.dt.append(dt)

    def save(self, path: Path, episode: dict[str, Any]) -> None:
        tmp = path.with_suffix(".partial.npz")
        np.savez_compressed(tmp, **self.f.arrays("f"), **self.i.arrays("i"), mask=np.stack(self.mask), action=np.asarray(self.action, np.int16), dt=np.asarray(self.dt, np.float32),
                            kills=np.asarray(self.kills), bonus=np.asarray(self.bonus), time=np.asarray(self.time),
                            episode=np.frombuffer(json.dumps({k: episode[k] for k in ("seed", "kills", "gameTime", "level", "zone", "endCause", "overtime", "victory", "terminated", "truncated")}).encode("utf-8"), np.uint8))
        tmp.replace(path)


# ---------------------------------------------------------------- collect

def collect(args) -> int:
    from . import config as cfg
    from .bridge import NodeWorker, WorkerError
    from .manager import load_manager_layouts

    config = cfg.load(args.config, cfg.TRAINING_DEFAULTS, args.set)
    offline.check_config(config)
    manager = cfg.manager_options(config)
    if manager is None:
        print("bc: the configuration does not enable the manager (manager.enabled)", file=sys.stderr)
        return 2
    seeds = cfg.parse_seeds(args.seeds)
    if any(s in HELD_OUT for s in seeds):
        print("bc: seeds 900001-900050 are held out; nothing is trained on them", file=sys.stderr)
        return 2
    sc = config["scenarios"]
    if len(sc["species"]) != 1 or len(sc["maps"]) != 1 or len(sc["tiers"]) != 1:
        print("bc: collect plays one scenario (one species, one map, one tier)", file=sys.stderr)
        return 2
    scenario = {"species": int(sc["species"][0]), "map": str(sc["maps"][0]), "tier": int(sc["tiers"][0])}
    layouts = load_manager_layouts(config["game"]["build"])
    out = cfg.resolve(args.out)
    out.mkdir(parents=True, exist_ok=True)
    todo = deque(s for s in seeds if not (out / f"seed-{s}.npz").exists())
    print(f"bc collect: {len(todo)} of {len(seeds)} seeds to play on {scenario} (archive {config['env'].get('archive')!r}), into {out}")
    w = config["workers"]
    env_options = cfg.env_options(config, **scenario)
    meta: dict[str, Any] = {"layouts": layouts.identity(), "manager": manager, "plan": config["manager"].get("plan") or {}, "scenario": scenario, "env": env_options, "profile_preset": None}
    seats: list[dict[str, Any]] = []
    started, lost, done, t0 = 0, 0, 0, time.time()

    def begin(seat) -> bool:
        nonlocal started, lost
        while todo:
            seat["seed"] = todo.popleft()
            try:
                wk = seat.get("worker")
                if wk is None or wk.closed or wk.episodes >= int(w["recycle_after"]) or wk.rss_mb > int(w["recycle_rss_mb"]):
                    if wk is not None and not wk.closed:
                        wk.close()
                    log = cfg.resolve(config["paths"]["logs"]) / "bc" / out.name / f"worker-{started:04d}.log"
                    log.parent.mkdir(parents=True, exist_ok=True)
                    seat["worker"] = NodeWorker(env_options, log_path=log, worker_id=started, manager=manager)
                    started += 1
                seat["frame"] = seat["worker"].reset(seat["seed"], timeout=float(w["reset_timeout"]), **scenario)
                if meta["profile_preset"] is None and seat["worker"].metadata is not None:
                    layouts.check_metadata(seat["worker"])
                    meta["profile_preset"] = seat["worker"].metadata.get("profilePreset")
                    meta["plan_version"] = seat["worker"].manager_metadata.get("plan")
                    (out / "meta.json").write_text(json.dumps(meta, indent=1), "utf-8")
                seat["rec"] = _Recorder(layouts.n_actions)
                return True
            except WorkerError as e:
                lost += 1
                print(f"  seed {seat['seed']}: LOST (reset): {e}", file=sys.stderr)
                if seat.get("worker") is not None:
                    seat["worker"].kill()
        return False

    try:
        for _ in range(min(int(w["envs"]), len(todo))):
            seat: dict[str, Any] = {}
            if begin(seat):
                seats.append(seat)
        active = list(seats)
        while active:
            for s in active:
                a = int(s["frame"].header["p"])
                s["rec"].add(s["frame"], a)
                try:
                    s["worker"].request_step(a)
                except WorkerError as e:
                    s["error"] = e
            still = []
            for s in active:
                try:
                    if "error" in s:
                        raise s.pop("error")
                    s["frame"] = s["worker"].recv(float(w["step_timeout"]))
                except WorkerError as e:
                    lost += 1
                    print(f"  seed {s['seed']}: LOST (step): {e}", file=sys.stderr)
                    s["worker"].kill()
                    if begin(s):
                        still.append(s)
                    continue
                s["rec"].stepped(float(s["frame"].header.get("dt", 0.0)))
                episode = s["frame"].header.get("episode")
                if episode is None:
                    still.append(s)
                    continue
                s["rec"].save(out / f"seed-{s['seed']}.npz", episode)
                done += 1
                ot = episode["overtime"]
                print(f"  seed {episode['seed']:>8}  score {episode['kills'] + (ot['bonus'] if ot['cashed'] else 0):>9}  {len(s['rec'].action):>5} decisions  {episode['gameTime']:>7.0f} s  {episode['endCause']}", flush=True)
                if begin(s):
                    still.append(s)
            active = still
    finally:
        for s in seats:
            wk = s.get("worker")
            if wk is not None and not wk.closed:
                wk.kill()
    print(f"bc collect: {done} episodes stored, {lost} lost, {time.time() - t0:.0f} s")
    return 0 if lost == 0 else 3


# ---------------------------------------------------------------- fit

def load_dataset(folder: Path) -> tuple[dict[str, Any], list[dict[str, np.ndarray]]]:
    meta = json.loads((folder / "meta.json").read_text("utf-8"))
    episodes = []
    for p in sorted(folder.glob("seed-*.npz")):
        if p.name.endswith(".partial.npz"):
            continue
        with np.load(p) as z:
            episodes.append({k: z[k] for k in z.files})
    if not episodes:
        raise FileNotFoundError(f"{folder} holds no stored episode (seed-*.npz)")
    return meta, episodes


def fit(args) -> int:
    offline.install_network_guard()
    import torch
    from . import config as cfg
    from .checkpoints import save_checkpoint
    from .manager import build_manager_model, load_manager_layouts, spaces_only_env
    from .reward import RewardConfig
    from .storage import Store

    config = cfg.load(args.config, cfg.TRAINING_DEFAULTS, args.set)
    offline.check_config(config)
    manager = cfg.manager_options(config)
    if manager is None:
        print("bc: the configuration does not enable the manager (manager.enabled)", file=sys.stderr)
        return 2
    layouts = load_manager_layouts(config["game"]["build"])
    folder = cfg.resolve(args.data)
    meta, episodes = load_dataset(folder)
    why = layouts.accepts(meta["layouts"])
    if why:
        print(f"bc: the episodes in {folder} were stored on other layouts: " + "; ".join(why), file=sys.stderr)
        return 2
    if meta["manager"] != manager or (meta.get("plan") or {}) != (config["manager"].get("plan") or {}):
        print(f"bc: the episodes in {folder} were played with other manager options or another plan than this configuration has", file=sys.stderr)
        return 2
    name = args.name
    config["name"] = name
    run_dir = cfg.resolve(config["paths"]["models"]) / "runs" / name
    store = Store(cfg.resolve(config["paths"]["database"]))
    try:
        if run_dir.exists() or store.training_run(name) is not None:
            print(f"bc: a run named {name!r} exists; choose another --name", file=sys.stderr)
            return 2
        device = ("cuda" if torch.cuda.is_available() else "cpu") if config["device"] == "auto" else config["device"]
        model = build_manager_model(config, spaces_only_env(layouts), layouts, None, device)
        policy = model.policy
        index = np.concatenate([np.stack([np.full(len(e["action"]), k), np.arange(len(e["action"]))], axis=1) for k, e in enumerate(episodes)])
        n = len(index)
        rng = np.random.default_rng(int(config["seed"]))

        def batch(rows: np.ndarray):
            f = np.zeros((len(rows), layouts.float_size), np.float32)
            i = np.zeros((len(rows), layouts.int_size), np.int32)
            m = np.zeros((len(rows), layouts.n_actions), bool)
            a = np.zeros(len(rows), np.int64)
            for k in np.unique(rows[:, 0]):
                sel = np.flatnonzero(rows[:, 0] == k)
                e, r = episodes[int(k)], rows[sel, 1]
                f[sel] = dense(e["f_idx"], e["f_val"], e["f_ptr"], r, layouts.float_size, np.float32)
                i[sel] = dense(e["i_idx"], e["i_val"], e["i_ptr"], r, layouts.int_size, np.int32)
                m[sel] = np.unpackbits(e["mask"][r], axis=1)[:, :layouts.n_actions].astype(bool)
                a[sel] = e["action"][r]
            obs = {"float": torch.as_tensor(f, device=device), "int": torch.as_tensor(i, device=device)}
            return obs, torch.as_tensor(m, device=device), torch.as_tensor(a, device=device)

        def measure(rows: np.ndarray) -> dict[str, float]:
            """How well the policy gives the proposal on these decisions."""
            policy.set_training_mode(False)
            hit, p_sum, ce = 0, 0.0, 0.0
            with torch.no_grad():
                for s in range(0, len(rows), 2048):
                    obs, m, a = batch(rows[s:s + 2048])
                    dist = policy.get_distribution(obs, action_masks=m)
                    lp = dist.log_prob(a)
                    hit += int((dist.get_actions(deterministic=True) == a).sum())
                    p_sum += float(lp.exp().sum())
                    ce += float(-lp.sum())
            return {"decisions": len(rows), "agreement": hit / len(rows), "proposal_probability": p_sum / len(rows), "cross_entropy": ce / len(rows)}

        held = rng.permutation(n)[: max(1, min(20000, n // 10))]
        train = np.setdiff1d(np.arange(n), held)
        before = measure(index[held])
        print(f"bc fit: {len(episodes)} episodes, {n} decisions ({len(train)} to train on, {len(held)} held back); before training: "
              f"agreement {before['agreement']:.4f}, probability of the proposal {before['proposal_probability']:.4f}")
        opt = torch.optim.Adam(policy.parameters(), lr=float(args.learning_rate))
        size, t0, steps = int(args.batch_size), time.time(), 0
        for epoch in range(int(args.epochs)):
            policy.set_training_mode(True)
            order = rng.permutation(train)
            for s in range(0, len(order), size):
                obs, m, a = batch(index[order[s:s + size]])
                _, log_prob, _ = policy.evaluate_actions(obs, a, action_masks=m)
                loss = -log_prob.mean()
                opt.zero_grad()
                loss.backward()
                torch.nn.utils.clip_grad_norm_(policy.parameters(), 1.0)
                opt.step()
                steps += 1
            now = measure(index[held])
            print(f"  epoch {epoch + 1}: agreement {now['agreement']:.4f}, probability of the proposal {now['proposal_probability']:.4f}, cross-entropy {now['cross_entropy']:.5f} ({time.time() - t0:.0f} s)", flush=True)
        after = measure(index[held])
        reward = RewardConfig.from_dict(config["reward"])
        run_dir.mkdir(parents=True)
        (run_dir / "config.json").write_text(json.dumps(config, indent=1), "utf-8")
        run_id = store.create_training_run(name=name, algorithm="behaviour cloning (manager)", config=config, reward=reward.to_dict(), observation_layout_hash=layouts.observation_hash,
                                           action_layout_hash=layouts.action_hash, game_build=layouts.build, directory=str(run_dir))
        batch_id = store.create_batch(label=f"bc:{name}", policy_name="bc-fit", policy_version=name, config={**config, "data": str(folder), "episodes": len(episodes), "decisions": n},
                                      hz=int(config["env"]["hz"]), action_repeat=int(config["env"]["action_repeat"]), reward_version=reward.version, episodes_planned=0)
        session_id = store.create_session(run_id, batch_id, 0, None)
        path, sha = save_checkpoint(run_dir / "checkpoints", model=model, vecnormalize=None, timesteps=0, state={
            "run": name, "kind": "bc", "session_id": session_id, "episodes_started": 0, "episodes_finished": 0, "observation_layout_hash": layouts.observation_hash,
            "action_layout_hash": layouts.action_hash, "reward_version": reward.version, "game_build": layouts.build, "profile_preset": meta.get("profile_preset"),
            "archive": config["env"].get("archive"),
            "manager": {"options": manager, "plan": config["manager"].get("plan") or {}, "horizon_seconds": float(config["manager"]["horizon_seconds"]), "layouts": layouts.identity()},
            "bc": {"data": str(folder), "episodes": len(episodes), "decisions": n, "epochs": int(args.epochs), "gradient_steps": steps, "before": before, "after": after}})
        store.insert_checkpoint(run_id=run_id, session_id=session_id, kind="final", timesteps=0, episodes=0, path=str(path), sha256=sha)
        store.finish_session(session_id, "completed", 0)
        store.finish_batch(batch_id, "completed", time.time() - t0)
        print(f"bc fit: {path} (model {sha[:12]}); agreement {after['agreement']:.4f}, probability of the proposal {after['proposal_probability']:.4f}")
        return 0
    finally:
        store.close()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="pokebonk_rl.bc", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("collect", help="play episodes as the heuristic, in manager mode, and store every decision")
    c.add_argument("--config", required=True)
    c.add_argument("--seeds", required=True, help='e.g. "1000000-1000019" (never the held-out seeds)')
    c.add_argument("--out", required=True, help="folder for the stored episodes (one file per seed; seeds already there are skipped)")
    c.add_argument("--set", action="append", default=[], metavar="KEY=VALUE")
    f = sub.add_parser("fit", help="train the manager's policy to give the stored proposals, and write it as a run")
    f.add_argument("--config", required=True)
    f.add_argument("--data", required=True)
    f.add_argument("--name", required=True)
    f.add_argument("--epochs", type=int, default=1)
    f.add_argument("--batch-size", type=int, default=512)
    f.add_argument("--learning-rate", type=float, default=1e-4)
    f.add_argument("--set", action="append", default=[], metavar="KEY=VALUE")
    args = ap.parse_args(argv)
    if args.cmd == "collect":
        offline.install_network_guard()
        return collect(args)
    return fit(args)


if __name__ == "__main__":
    sys.exit(main())
