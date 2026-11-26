"""The manager (phase 2 of the heuristic + RL refactor): the learner that chooses a skill or a dialog answer about once
a game second, on top of the phase 1 heuristic (src/hybrid on the Node side).

What is here:

- `ManagerLayouts`: the manager's observation and action layouts (data/encoding/<build>/manager-*.json) and the id
  registry (data/encoding/manager-ids.json), and the check that a running environment or a saved model matches them;
- `ManagerExtractor` (architecture "manager-v1"): the network's input side. Its output ends with the heuristic's
  proposal, unchanged, so that the policy head (one linear layer) has a direct path from "the heuristic would do X" to
  the logit of X. `prime_proposal` sets that path's weight: an untrained manager already takes the proposal;
- `TimeDiscountBuffer`: generalised advantage estimation with a discount by elapsed GAME time. A manager step lasts
  from no time at all (a dialog answer) to a second or more (a skill), so "γ per step" would value a dialog-heavy
  stretch differently from a quiet one;
- `build_manager_model`.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .bridge import REPO

ARCHITECTURE = "manager-v1"
# Row width after the shared row network, per ordered list (row index = what an action refers to).
ORDERED = {"moves": 32, "options": 16}
# Segments joined row for row before the row network: more columns of the same rows.
ROW_EXTRA = {"options": ["option_fx"]}
ROW_IDS = {"moves": ["move_slots"], "options": ["option_entity", "option_fx_stats"]}
PROPOSAL = "proposal"


@dataclass(frozen=True)
class ManagerLayouts:
    build: str
    observation: dict[str, Any]
    action: dict[str, Any]
    registry: dict[str, Any]

    @property
    def float_size(self) -> int:
        return int(self.observation["floatSize"])

    @property
    def int_size(self) -> int:
        return int(self.observation["intSize"])

    @property
    def n_actions(self) -> int:
        return int(self.action["size"])

    @property
    def mask_size(self) -> int:
        return self.n_actions

    @property
    def observation_hash(self) -> str:
        return str(self.observation["hash"])

    @property
    def compat(self) -> str:
        return str(self.observation["compat"])

    @property
    def action_hash(self) -> str:
        return str(self.action["hash"])

    @property
    def vocab_sizes(self) -> dict[str, int]:
        # An embedding has one row per id the registry can ever give (its capacity), plus row 0 for "none".
        return {name: int(t["capacity"]) + 1 for name, t in self.registry["tables"].items()}

    def action_space(self):
        from gymnasium import spaces
        return spaces.Discrete(self.n_actions)

    def segment(self, name: str) -> dict[str, Any]:
        for s in self.observation["segments"]:
            if s["name"] == name:
                return s
        raise KeyError(f"the manager's observation has no segment {name!r}")

    def extractor_spec(self) -> dict[str, Any]:
        floats, ints = [], []
        for s in self.observation["segments"]:
            rows, cols = (int(x) for x in s["shape"])
            entry = {"name": s["name"], "offset": int(s["offset"]), "rows": rows, "cols": cols}
            if s["dtype"] == "int32":
                entry["vocabs"] = [f["vocab"] for f in s["features"]]
                ints.append(entry)
            else:
                entry["present"] = bool(rows > 1 and s["features"][0]["name"] == "present")
                floats.append(entry)
        used = sorted({v for s in ints for v in s["vocabs"]})
        return {"float": floats, "int": ints, "vocab_sizes": {v: self.vocab_sizes[v] for v in used}, "float_size": self.float_size, "int_size": self.int_size,
                "n_actions": self.n_actions, "compat": self.compat, "layout_hash": self.observation_hash}

    def identity(self) -> dict[str, Any]:
        """What a saved model keeps of the layouts it was trained on."""
        return {"observation_version": int(self.observation["version"]), "observation_hash": self.observation_hash, "compat": self.compat, "action_version": int(self.action["version"]),
                "action_hash": self.action_hash, "n_actions": self.n_actions, "action_names": list(self.action["names"]),
                "registry": {name: {"capacity": int(t["capacity"]), "keys": list(t["keys"])} for name, t in self.registry["tables"].items()}}

    def check_metadata(self, worker) -> None:
        """The running environment must encode with exactly these layouts."""
        m = getattr(worker, "manager_metadata", None)
        if m is None:
            raise RuntimeError("the environment process did not report the manager's layouts: it was not started in manager mode")
        problems = []
        if worker.metadata and worker.metadata["gameBuild"] != self.build:
            problems.append(f"game build {worker.metadata['gameBuild']} (layouts are for {self.build})")
        if m["observation"]["hash"] != self.observation_hash:
            problems.append(f"manager observation layout {m['observation']['hash'][:16]}… (file: {self.observation_hash[:16]}…)")
        if m["action"]["hash"] != self.action_hash:
            problems.append(f"manager action layout {m['action']['hash'][:16]}… (file: {self.action_hash[:16]}…)")
        if problems:
            raise RuntimeError("the running environment does not match the exported manager layouts: " + "; ".join(problems) + ". Re-export with `npm run export:encoding`.")

    def accepts(self, trained: dict[str, Any]) -> list[str]:
        """Why a model trained on the layouts `trained` (its stored `identity()`) cannot be used on these; empty = it can.

        A model stays valid when later game builds only APPENDED: the shapes, scales and capacities are the same
        (`compat`), every id it knows still means the same key, and every action it knows still means the same thing.
        """
        why = []
        if trained.get("compat") != self.compat:
            why.append(f"the observation's shape differs (compat {str(trained.get('compat'))[:16]}… against {self.compat[:16]}…)")
        names, mine = list(trained.get("action_names", [])), list(self.action["names"])
        if int(trained.get("n_actions", -1)) != self.n_actions or names != mine[:len(names)]:
            why.append("the action table differs (it may only grow at the end, and a grown table needs a model of that size)")
        for name, t in (trained.get("registry") or {}).items():
            now = self.registry["tables"].get(name)
            if now is None or int(now["capacity"]) != int(t["capacity"]) or list(now["keys"][:len(t["keys"])]) != list(t["keys"]):
                why.append(f"the ids of table {name!r} are not those the model was trained with")
        return why


def load_manager_layouts(build: str, repo: Path = REPO) -> ManagerLayouts:
    enc = repo / "data" / "encoding"
    files = (enc / build / "manager-observation-layout.json", enc / build / "manager-action-layout.json", enc / "manager-ids.json")
    for p in files:
        if not p.exists():
            raise FileNotFoundError(f"{p} is missing: run `npm run export:encoding` for build {build}")
    obs, act, reg = (json.loads(p.read_text("utf-8")) for p in files)
    if obs["action"]["hash"] != act["hash"]:
        raise RuntimeError("manager-observation-layout.json and manager-action-layout.json come from different exports: run `npm run export:encoding`")
    return ManagerLayouts(build=build, observation=obs, action=act, registry=reg)


def gamma_per_second(horizon_seconds: float) -> float:
    """The discount of one game second for a horizon of `horizon_seconds` (a reward that far away counts 1/e)."""
    if not horizon_seconds > 0:
        raise ValueError(f"the horizon must be positive, got {horizon_seconds}")
    return math.exp(-1.0 / float(horizon_seconds))


def prime_proposal(model, logit: float, rare: dict[int, float] | None = None) -> None:
    """Set the direct path from the proposal to the action: logit(a) = `logit` where the heuristic proposes a.

    The rest of the policy head starts as the library initialises it (close to zero), so an untrained manager's most
    probable action is the proposal, and sampled actions are the proposal with probability about
    e^logit / (e^logit + allowed − 1).

    `rare` (action id → how much): actions that start that much less likely than any other when the heuristic does
    NOT propose them, and exactly as likely as any other proposal when it does (bias −b, own path `logit` + b).
    For what cannot be taken back in the next second: a sampled "take the portal" in Overtime cashes the bonus.
    Start values like the rest: training moves them.
    """
    import torch
    net = model.policy.action_net
    n = net.out_features
    mix = net.in_features - n
    if mix < 0:
        raise ValueError("the policy head is narrower than the action table: was the model built with pi = []?")
    with torch.no_grad():
        net.weight[:, mix:] = torch.eye(n, device=net.weight.device) * float(logit)
        for a, b in (rare or {}).items():
            if not 0 <= int(a) < n or not float(b) >= 0:
                raise ValueError(f"rare action {a}: outside the action table, or a negative amount")
            net.bias[int(a)] = -float(b)
            net.weight[int(a), mix + int(a)] = float(logit) + float(b)


def rare_actions(config_manager: dict[str, Any], layouts: "ManagerLayouts") -> dict[int, float]:
    """`manager.rare_actions` (action name → amount) as action ids."""
    names = list(layouts.action["names"])
    out = {}
    for name, b in (config_manager.get("rare_actions") or {}).items():
        if name not in names:
            raise ValueError(f"manager.rare_actions: the action table has no action {name!r}")
        out[names.index(name)] = float(b)
    return out


def build_manager_model(config: dict[str, Any], venv, layouts: ManagerLayouts, tensorboard: Path | None, device: str):
    from sb3_contrib import MaskablePPO
    from .manager_net import ManagerExtractor as extractor, TimeDiscountBuffer as buffer
    net, p, m = config["network"], config["ppo"], config["manager"]
    if net["architecture"] != ARCHITECTURE:
        raise ValueError(f"the manager needs network.architecture {ARCHITECTURE!r}, got {net['architecture']!r}")
    if list(net["pi"]):
        raise ValueError("the manager's policy head is one linear layer (network.pi must be []): the proposal reaches the action directly")
    model = MaskablePPO(
        "MultiInputPolicy", venv, n_steps=int(p["n_steps"]), batch_size=int(p["batch_size"]), n_epochs=int(p["n_epochs"]), learning_rate=float(p["learning_rate"]),
        gamma=gamma_per_second(float(m["horizon_seconds"])), gae_lambda=float(p["gae_lambda"]), clip_range=float(p["clip_range"]), ent_coef=float(p["ent_coef"]),
        vf_coef=float(p["vf_coef"]), max_grad_norm=float(p["max_grad_norm"]), target_kl=None if p["target_kl"] is None else float(p["target_kl"]),
        rollout_buffer_class=buffer,
        policy_kwargs={"features_extractor_class": extractor, "features_extractor_kwargs": {"spec": layouts.extractor_spec(), "mix_dim": int(net["features_dim"])},
                       "net_arch": {"pi": [], "vf": list(net["vf"])}},
        tensorboard_log=str(tensorboard) if tensorboard else None, seed=int(config["seed"]), device=device, verbose=1)
    prime_proposal(model, float(m["proposal_logit"]), rare_actions(m, layouts))
    return model


def spaces_only_env(layouts: ManagerLayouts):
    """A vectorised environment that has the manager's spaces and plays nothing: enough to build or load a model
    without a game process (copying the heuristic from stored episodes, tests)."""
    from gymnasium import spaces
    from stable_baselines3.common.vec_env.base_vec_env import VecEnv

    class SpacesOnly(VecEnv):
        last_dt = np.zeros(1, np.float32)

        def __init__(self):
            super().__init__(1, spaces.Dict({"float": spaces.Box(-np.inf, np.inf, (layouts.float_size,), np.float32),
                                             "int": spaces.Box(0, max(layouts.vocab_sizes.values()), (layouts.int_size,), np.int32)}), layouts.action_space())

        def reset(self):
            return {"float": np.zeros((1, layouts.float_size), np.float32), "int": np.zeros((1, layouts.int_size), np.int32)}

        def step_async(self, actions):
            raise RuntimeError("this environment has spaces only: nothing can be played on it")

        def step_wait(self):
            raise RuntimeError("this environment has spaces only: nothing can be played on it")

        def close(self):
            pass

        def env_method(self, method_name, *a, indices=None, **k):
            if method_name == "action_masks":
                return [np.ones(layouts.n_actions, bool)]
            raise AttributeError(method_name)

        def get_attr(self, attr_name, indices=None):
            return [None]

        def set_attr(self, attr_name, value, indices=None):
            raise AttributeError(attr_name)

        def env_is_wrapped(self, wrapper_class, indices=None):
            return [False]

        def seed(self, seed=None):
            return [None]

        def action_masks(self):
            return np.ones((1, layouts.n_actions), bool)

    return SpacesOnly()
