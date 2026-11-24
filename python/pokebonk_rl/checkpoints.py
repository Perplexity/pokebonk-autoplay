"""Checkpoints of a training run: one folder each, written completely or not at all.

  models/runs/<run>/checkpoints/ckpt_<timesteps, 12 digits>/
      model.zip            the learner (policy, optimiser, hyper-parameters, timestep counter)
      vecnormalize.pkl     the reward normaliser's running statistics (absent when rewards are not normalised)
      state.json           what the trainer needs besides: counters, hashes, kind, when

A checkpoint is first written into `<name>.partial` and renamed when everything is on disk; a folder without a
`state.json` whose hash matches `model.zip` is not a checkpoint and is never loaded. Existing checkpoints are never
overwritten.
"""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any

from .storage import now, sha256_file


def checkpoint_name(timesteps: int) -> str:
    return f"ckpt_{timesteps:012d}"


def save_checkpoint(folder: Path, *, model, vecnormalize, timesteps: int, state: dict[str, Any]) -> tuple[Path, str]:
    """Write the checkpoint for `timesteps` under `folder`; returns its path and the hash of model.zip."""
    final = folder / checkpoint_name(timesteps)
    if final.exists():
        raise FileExistsError(f"{final} exists: a checkpoint is never overwritten")
    partial = folder / (final.name + ".partial")
    if partial.exists():
        shutil.rmtree(partial)   # left by a crash while writing; it never was a checkpoint
    partial.mkdir(parents=True)
    model.save(str(partial / "model.zip"))
    if vecnormalize is not None:
        vecnormalize.save(str(partial / "vecnormalize.pkl"))
    sha = sha256_file(partial / "model.zip")
    (partial / "state.json").write_text(json.dumps({**state, "timesteps": timesteps, "model_sha256": sha, "created_at": now()}, indent=1), "utf-8")
    os.replace(partial, final)
    return final, sha


def read_checkpoint(path: Path) -> dict[str, Any]:
    """The state of a checkpoint folder, after checking that it is complete and that model.zip is the file it was written with."""
    path = Path(path)
    state_file, model_file = path / "state.json", path / "model.zip"
    if not state_file.exists() or not model_file.exists():
        raise FileNotFoundError(f"{path} is not a complete checkpoint (model.zip and state.json are both required)")
    state = json.loads(state_file.read_text("utf-8"))
    sha = sha256_file(model_file)
    if sha != state.get("model_sha256"):
        raise ValueError(f"{model_file} has hash {sha[:16]}…, its state.json says {str(state.get('model_sha256'))[:16]}…: the checkpoint is damaged")
    return state


def list_checkpoints(folder: Path) -> list[Path]:
    """Complete checkpoints under `folder`, oldest first."""
    if not folder.exists():
        return []
    out = [p for p in sorted(folder.iterdir()) if p.is_dir() and p.name.startswith("ckpt_") and not p.name.endswith(".partial") and (p / "state.json").exists() and (p / "model.zip").exists()]
    return out


def latest_checkpoint(folder: Path) -> Path | None:
    """The newest checkpoint that passes its integrity check (a damaged one is skipped, with the older one before it used instead)."""
    for p in reversed(list_checkpoints(folder)):
        try:
            read_checkpoint(p)
            return p
        except (ValueError, FileNotFoundError, json.JSONDecodeError):
            continue
    return None
