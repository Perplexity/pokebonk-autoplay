"""The manager's network parts (imported after the offline guard is in place, like every module that loads PyTorch):
the feature extractor "manager-v1" and the rollout buffer that discounts by elapsed game time. See manager.py."""
from __future__ import annotations

from typing import Any

import numpy as np
import torch
from gymnasium import spaces
from sb3_contrib.common.maskable.buffers import MaskableDictRolloutBuffer
from stable_baselines3.common.torch_layers import BaseFeaturesExtractor
from torch import nn

from .manager import ORDERED, PROPOSAL, ROW_EXTRA, ROW_IDS


def embedding_dim(size: int) -> int:
    return 4 if size <= 8 else 8 if size <= 64 else 16

class ManagerExtractor(BaseFeaturesExtractor):
    """Features = [a mix of everything (`mix_dim`), the heuristic's proposal one-hot]."""

    def __init__(self, observation_space: spaces.Dict, spec: dict[str, Any], mix_dim: int = 512):
        n_actions = int(spec["n_actions"])
        super().__init__(observation_space, mix_dim + n_actions)
        if observation_space["float"].shape != (spec["float_size"],) or observation_space["int"].shape != (spec["int_size"],):
            raise ValueError("the observation space does not have the sizes of the layout the extractor was built for")
        self.spec, self.mix_dim, self.n_actions = spec, mix_dim, n_actions
        self.float_segments = {s["name"]: s for s in spec["float"]}
        self.int_segments = {s["name"]: s for s in spec["int"]}
        self.embeddings = nn.ModuleDict({f"vocab_{v}": nn.Embedding(n, embedding_dim(n), padding_idx=0) for v, n in spec["vocab_sizes"].items()})
        prop = self.float_segments.get(PROPOSAL)
        if prop is None or prop["rows"] != 1 or prop["cols"] != n_actions:
            raise ValueError("the layout has no `proposal` segment of the action table's size")
        self.extra_rows = {x for xs in ROW_EXTRA.values() for x in xs}
        row_ids = {x for xs in ROW_IDS.values() for x in xs}
        for name in list(self.extra_rows) + list(row_ids):
            if name not in self.float_segments and name not in self.int_segments:
                raise ValueError(f"the layout has no segment {name!r}")

        def ids_width(segment: str) -> int:
            return sum(self.embeddings[f"vocab_{v}"].embedding_dim for v in self.int_segments[segment]["vocabs"])

        self.row_nets = nn.ModuleDict()
        width = 0
        for name, s in self.float_segments.items():
            if name in self.extra_rows:
                continue
            if name in ORDERED:
                if not s["present"]:
                    raise ValueError(f"list segment {name!r} has no `present` flag in its first column")
                cols = s["cols"] + sum(self.float_segments[x]["cols"] for x in ROW_EXTRA.get(name, [])) + sum(ids_width(x) for x in ROW_IDS.get(name, []))
                for x in ROW_EXTRA.get(name, []) + ROW_IDS.get(name, []):
                    other = self.float_segments.get(x) or self.int_segments[x]
                    if other["rows"] != s["rows"]:
                        raise ValueError(f"segment {x!r} has {other['rows']} rows, {name!r} has {s['rows']}")
                out = ORDERED[name]
                self.row_nets[name] = nn.Sequential(nn.Linear(cols, out), nn.ReLU(), nn.Linear(out, out), nn.ReLU())
                width += s["rows"] * out
            elif s["rows"] == 1:
                width += s["cols"]
            else:
                raise ValueError(f"float segment {name!r} is a list the extractor has no rule for")
        self.vector_ids = [name for name in self.int_segments if name not in row_ids]
        for name in self.vector_ids:
            if self.int_segments[name]["rows"] != 1:
                raise ValueError(f"category-id segment {name!r} is a list the extractor has no rule for")
            width += ids_width(name)
        self.mix = nn.Sequential(nn.Linear(width, mix_dim), nn.ReLU())

    def _block(self, floats, name: str):
        s = self.float_segments[name]
        return floats[:, s["offset"]: s["offset"] + s["rows"] * s["cols"]], s

    def _embed(self, ints, segment: str):
        s = self.int_segments[segment]
        block = ints[:, s["offset"]: s["offset"] + s["rows"] * s["cols"]].reshape(-1, s["rows"], s["cols"])
        parts = []
        for j, vocab in enumerate(s["vocabs"]):
            table = self.embeddings[f"vocab_{vocab}"]
            parts.append(table(block[:, :, j].clamp(0, table.num_embeddings - 1)))
        return torch.cat(parts, dim=-1)

    def forward(self, observations):
        floats = observations["float"]
        ints = observations["int"].long()
        out = []
        for name in self.float_segments:
            if name in self.extra_rows:
                continue
            block, s = self._block(floats, name)
            if name not in self.row_nets:
                out.append(block)
                continue
            rows = block.reshape(-1, s["rows"], s["cols"])
            present = rows[:, :, :1]
            parts = [rows]
            for x in ROW_EXTRA.get(name, []):
                b, sx = self._block(floats, x)
                parts.append(b.reshape(-1, sx["rows"], sx["cols"]))
            for x in ROW_IDS.get(name, []):
                parts.append(self._embed(ints, x))
            out.append((self.row_nets[name](torch.cat(parts, dim=-1)) * present).flatten(1))
        for name in self.vector_ids:
            out.append(self._embed(ints, name).flatten(1))
        proposal, _ = self._block(floats, PROPOSAL)
        return torch.cat([self.mix(torch.cat(out, dim=1)), proposal], dim=1)

class TimeDiscountBuffer(MaskableDictRolloutBuffer):
    """GAE with the discount of each step taken from the game time it lasted: γ_t = γ_second ** dt_t.

    `dt_source` is the vectorised environment (python/pokebonk_rl/vec_env.py), whose `last_dt` holds, per slot, the
    game seconds of the step just taken; the learner passes nothing of the kind to a buffer. `self.gamma` is the
    discount of one game second.
    """
    dt_source = None

    def reset(self) -> None:
        self.dts = np.zeros((self.buffer_size, self.n_envs), dtype=np.float32)
        super().reset()

    def add(self, *args, **kwargs) -> None:
        if self.dt_source is None:
            raise RuntimeError("TimeDiscountBuffer.dt_source is not set: the buffer does not know how long a step lasted")
        self.dts[self.pos] = np.asarray(self.dt_source.last_dt, dtype=np.float32)
        super().add(*args, **kwargs)

    def compute_returns_and_advantage(self, last_values, dones: np.ndarray) -> None:
        last_values = last_values.clone().cpu().numpy().flatten()
        last_gae = 0
        for step in reversed(range(self.buffer_size)):
            if step == self.buffer_size - 1:
                next_non_terminal = 1.0 - dones.astype(np.float32)
                next_values = last_values
            else:
                next_non_terminal = 1.0 - self.episode_starts[step + 1]
                next_values = self.values[step + 1]
            g = np.power(self.gamma, self.dts[step])
            delta = self.rewards[step] + g * next_values * next_non_terminal - self.values[step]
            last_gae = delta + g * self.gae_lambda * next_non_terminal * last_gae
            self.advantages[step] = last_gae
        self.returns = self.advantages + self.values
