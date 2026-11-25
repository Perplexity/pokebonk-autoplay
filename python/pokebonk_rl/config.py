"""Configuration files (configs/*.yaml): loading, defaults, overrides, validation. Nothing is configured in source code
beyond the defaults written here, and a key no code reads is an error, not a silent no-op."""
from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

import yaml

from .bridge import REPO

#: The manager (phase 2: python/pokebonk_rl/manager.py, src/hybrid). With `enabled` the learner chooses a skill or a
#: dialog answer about once a game second on top of the phase 1 heuristic, instead of keys 20 times a second.
MANAGER_DEFAULTS: dict[str, Any] = {
    "enabled": False,
    "plan": {},                     # keys of the heuristic's plan to replace (src/agents/heuristic2/plan.ts); {} = its default plan
    "slice_seconds": 1.0,           # game seconds a skill runs before the manager is asked again
    "end_on_proposal_change": True, # ...or until the heuristic's own proposal changes
    "fuse_needs": "tm-case",        # Bill's machine fuses or links only while this item is held ("" = no such rule)
    "horizon_seconds": 1000.0,      # discount by elapsed game time: a reward this far away counts 1/e
    "proposal_logit": 8.0,          # start of the direct path from the heuristic's proposal to the action
    "stray_penalty": 0.0,           # reward taken away per decision that is not the proposal, at the start of the run...
    "stray_fade_timesteps": 0,      # ...fading linearly to zero over this many timesteps (0 = no penalty at all)
    "init_from": None,              # a checkpoint folder or run name whose policy the new run starts from (the copy of the heuristic)
}

TRAINING_DEFAULTS: dict[str, Any] = {
    "name": None,
    "seed": 1,
    "game": {"build": "mwsewi0r"},
    "env": {"hz": 60, "action_repeat": 3, "max_game_time": 0, "max_idle_game_time": 30, "max_ko_gap_game_time": 30, "ranked": True, "archive": None},
    "scenarios": {"species": [150], "maps": ["forest"], "tiers": [0]},
    "episode_seeds": {"first": 1_000_000},
    "workers": {"envs": 5, "spares": 2, "recycle_after": 1, "recycle_rss_mb": 1500, "max_errors": 20, "step_timeout": 300, "reset_timeout": 600},
    "reward_file": "reward-v6.yaml",
    "ppo": {"n_steps": 1024, "batch_size": 1024, "n_epochs": 4, "learning_rate": 3.0e-4, "gamma": 0.999, "gae_lambda": 0.95, "clip_range": 0.2,
            "ent_coef": 0.01, "vf_coef": 0.5, "max_grad_norm": 0.5, "target_kl": None},
    "network": {"architecture": "sets-v1", "features_dim": 512, "pi": [256], "vf": [256]},
    "normalize_reward": True,
    "manager": dict(MANAGER_DEFAULTS),
    "total_timesteps": 2_000_000,
    "checkpoint_every_timesteps": 100_000,
    "device": "cpu",
    "store_decisions": False,
    "paths": {"database": "data/pokebonk.sqlite", "models": "models", "tensorboard": "logs/tensorboard", "logs": "logs/training"},
}

EVALUATION_DEFAULTS: dict[str, Any] = {
    "game": {"build": "mwsewi0r"},
    "env": {"hz": 60, "action_repeat": 3, "max_game_time": 3600, "max_idle_game_time": 30, "max_ko_gap_game_time": 30, "ranked": True, "archive": None},
    "scenario": {"species": 150, "map": "forest", "tier": 0},
    "seeds": "900001-900050",
    "workers": {"envs": 5, "recycle_after": 1, "recycle_rss_mb": 1500, "step_timeout": 300, "reset_timeout": 600},
    "deterministic": True,
    "device": "cpu",
    "reward_file": "reward-v6.yaml",
    # What a model must do to be promotable: its `metric` over the seeds, divided by the reference's, must reach `min_ratio`,
    # with no episode lost to an error. The reference is the stable model's evaluation on the same seeds and scenario when
    # there is a stable model, else the batch labelled `first_reference`. Only an evaluation on exactly the seeds
    # `promotion.seeds` (the held-out list), compared with that reference, is a verdict; any other is information.
    "promotion": {"metric": "score_median", "min_ratio": 1.0, "first_reference": "heldout-mewtwo-random", "seeds": "900001-900050"},
    "paths": {"database": "data/pokebonk.sqlite", "models": "models", "logs": "logs/evaluation"},
}


def _merge(base: dict[str, Any], over: dict[str, Any], path: str) -> dict[str, Any]:
    out = copy.deepcopy(base)
    for k, v in over.items():
        if k not in base:
            raise KeyError(f"unknown configuration key {path}{k} (known: {', '.join(sorted(base))})")
        if isinstance(base[k], dict) and base[k] and isinstance(v, dict):
            out[k] = _merge(base[k], v, f"{path}{k}.")
        elif isinstance(base[k], dict) and base[k] and v is not None:
            raise TypeError(f"configuration key {path}{k} must be a mapping")
        else:
            out[k] = v
    return out


def _set(config: dict[str, Any], dotted: str, raw: str) -> None:
    keys = dotted.split(".")
    node = config
    for k in keys[:-1]:
        if not isinstance(node.get(k), dict):
            raise KeyError(f"unknown configuration key {dotted}")
        node = node[k]
    if keys[-1] not in node:
        raise KeyError(f"unknown configuration key {dotted}")
    node[keys[-1]] = yaml.safe_load(raw)


def load(path: str | Path | None, defaults: dict[str, Any], overrides: list[str] | None = None) -> dict[str, Any]:
    """Defaults, overlaid with the file, overlaid with `key.sub=value` overrides. Adds `reward` from `reward_file`."""
    given: dict[str, Any] = {}
    base_dir = REPO / "configs"
    if path is not None:
        p = Path(path)
        given = yaml.safe_load(p.read_text("utf-8")) or {}
        if not isinstance(given, dict):
            raise TypeError(f"{p} must contain a mapping")
        base_dir = p.resolve().parent
    config = _merge(defaults, given, "")
    for o in overrides or []:
        if "=" not in o:
            raise ValueError(f"an override is written key=value, got {o!r}")
        k, v = o.split("=", 1)
        _set(config, k.strip(), v)
    reward_path = Path(config["reward_file"])
    if not reward_path.is_absolute():
        reward_path = base_dir / reward_path
    reward = yaml.safe_load(reward_path.read_text("utf-8"))
    config["reward"] = reward
    return config


def env_options(config: dict[str, Any], **scenario) -> dict[str, Any]:
    e = config["env"]
    # `max_idle_game_time` and `max_ko_gap_game_time` did not exist before 2026-11-24: a run created without one is
    # resumed without that rule.
    out = {"hz": int(e["hz"]), "actionRepeat": int(e["action_repeat"]), "maxGameTime": float(e["max_game_time"]), "maxIdleGameTime": float(e.get("max_idle_game_time", 0)),
           "maxKoGapGameTime": float(e.get("max_ko_gap_game_time", 0)),
           "ranked": bool(e["ranked"]), "species": 155, "map": "forest", "tier": 0}
    if e.get("archive"):
        out["archive"] = str(e["archive"])     # account preset unlocked-v4 with this item archive (docs/environment.md)
    out.update(scenario)
    return out


def manager_options(config: dict[str, Any]) -> dict[str, Any] | None:
    """What the environment process is told in manager mode (None: the low-level action space)."""
    m = config.get("manager") or {}
    if not m.get("enabled"):
        return None
    out: dict[str, Any] = {"sliceSeconds": float(m["slice_seconds"]), "endOnProposalChange": bool(m["end_on_proposal_change"]), "fuseNeeds": str(m["fuse_needs"] or "")}
    if m.get("plan"):
        out["plan"] = dict(m["plan"])
    return out


def resolve(path: str | Path) -> Path:
    p = Path(path)
    return p if p.is_absolute() else REPO / p


def parse_seeds(spec: Any) -> list[int]:
    """`"1-30"`, `"1-10,21,40-42"`, or a list of integers."""
    if isinstance(spec, (list, tuple)):
        seeds = [int(s) for s in spec]
    else:
        seeds = []
        for part in str(spec).split(","):
            part = part.strip()
            if "-" in part:
                a, b = part.split("-", 1)
                seeds.extend(range(int(a), int(b) + 1))
            elif part:
                seeds.append(int(part))
    if not seeds or len(set(seeds)) != len(seeds):
        raise ValueError(f"seeds {spec!r}: need at least one seed and no duplicates")
    return seeds
