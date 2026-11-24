"""The network's input side: from the two observation buffers to one feature vector.

Architecture "sets-v1". The observation is a handful of fixed vectors (player, stats, terrain, inventory, the open
dialog) and several lists of things (enemies, projectiles, hazards, pickups, map points, move slots, dialog options),
each a table of rows with a `present` flag (docs/observation.md). Accordingly:

- every category id (species, move, item, …) goes through an embedding table of its vocabulary;
- every list is encoded row by row with one small network shared by all rows of that list;
- lists whose order carries no meaning beyond "nearest first" (enemies, shots, hazards, pickups, points) are reduced
  with max and mean over the rows that are present;
- lists whose row index is what an action refers to (move slots, dialog options: choice index = option row + 1) are
  kept in order, so the policy head can tell option 3 from option 4;
- everything is concatenated and mixed by one linear layer.

Segment offsets, shapes and vocabulary sizes come from the layout descriptor (python/pokebonk_rl/layout.py); the spec
is stored inside every saved model, and a model is refused on a layout with another hash.
"""
from __future__ import annotations

from typing import Any

import torch
from gymnasium import spaces
from stable_baselines3.common.torch_layers import BaseFeaturesExtractor
from torch import nn

ARCHITECTURE = "sets-v1"
# Row width after the shared row network, per list; lists not named here are fixed vectors.
POOLED = {"enemies": 64, "shots": 32, "hazards": 32, "pickups": 32, "points": 64}
ORDERED = {"moves": 32, "options": 16}
# Which category-id segment belongs to which list (row for row).
ROW_IDS = {"enemies": "enemy_species", "moves": "move_slots", "options": "option_entity"}


def _embedding_dim(size: int) -> int:
    return 4 if size <= 8 else 8 if size <= 64 else 16


class SetsExtractor(BaseFeaturesExtractor):
    def __init__(self, observation_space: spaces.Dict, spec: dict[str, Any], features_dim: int = 512):
        super().__init__(observation_space, features_dim)
        if observation_space["float"].shape != (spec["float_size"],) or observation_space["int"].shape != (spec["int_size"],):
            raise ValueError("the observation space does not have the sizes of the layout the extractor was built for")
        self.spec = spec
        self.float_segments = {s["name"]: s for s in spec["float"]}
        self.int_segments = {s["name"]: s for s in spec["int"]}
        # Keys are prefixed: a vocabulary is called "type", which a module container cannot use as a name.
        self.embeddings = nn.ModuleDict({f"vocab_{v}": nn.Embedding(n, _embedding_dim(n), padding_idx=0) for v, n in spec["vocab_sizes"].items()})

        def ids_width(segment: str) -> int:
            return sum(self.embeddings[f"vocab_{v}"].embedding_dim for v in self.int_segments[segment]["vocabs"])

        self.row_nets = nn.ModuleDict()
        width = 0
        for name, s in self.float_segments.items():
            if name in POOLED or name in ORDERED:
                if not s["present"]:
                    raise ValueError(f"list segment {name!r} has no `present` flag in its first column")
                out = POOLED.get(name) or ORDERED[name]
                cols = s["cols"] + (ids_width(ROW_IDS[name]) if name in ROW_IDS else 0)
                self.row_nets[name] = nn.Sequential(nn.Linear(cols, out), nn.ReLU(), nn.Linear(out, out), nn.ReLU())
                width += 2 * out if name in POOLED else s["rows"] * out
            elif s["rows"] == 1:
                width += s["cols"]
            else:
                raise ValueError(f"float segment {name!r} is a list the extractor has no rule for")
        for name in ROW_IDS.values():
            if name not in self.int_segments:
                raise ValueError(f"the layout has no category-id segment {name!r}")
        self.vector_ids = [name for name, s in self.int_segments.items() if name not in ROW_IDS.values()]
        for name in self.vector_ids:
            s = self.int_segments[name]
            if s["rows"] != 1:
                raise ValueError(f"category-id segment {name!r} is a list the extractor has no rule for")
            width += ids_width(name)
        self.mix = nn.Sequential(nn.Linear(width, features_dim), nn.ReLU())

    def _embed(self, ints: torch.Tensor, segment: str) -> torch.Tensor:
        """(batch, rows, sum of embedding widths) for one category-id segment."""
        s = self.int_segments[segment]
        block = ints[:, s["offset"]: s["offset"] + s["rows"] * s["cols"]].reshape(-1, s["rows"], s["cols"])
        parts = []
        for j, vocab in enumerate(s["vocabs"]):
            table = self.embeddings[f"vocab_{vocab}"]
            parts.append(table(block[:, :, j].clamp(0, table.num_embeddings - 1)))
        return torch.cat(parts, dim=-1)

    def forward(self, observations: dict[str, torch.Tensor]) -> torch.Tensor:
        floats = observations["float"]
        ints = observations["int"].long()
        out = []
        for name, s in self.float_segments.items():
            block = floats[:, s["offset"]: s["offset"] + s["rows"] * s["cols"]]
            if name not in self.row_nets:
                out.append(block)
                continue
            rows = block.reshape(-1, s["rows"], s["cols"])
            present = rows[:, :, :1]
            x = torch.cat([rows, self._embed(ints, ROW_IDS[name])], dim=-1) if name in ROW_IDS else rows
            h = self.row_nets[name](x) * present
            if name in POOLED:
                count = present.sum(dim=1).clamp(min=1.0)
                out.append(h.max(dim=1).values)      # rows that are absent are 0 and the row network ends in ReLU, so they never win
                out.append(h.sum(dim=1) / count)
            else:
                out.append(h.flatten(1))
        for name in self.vector_ids:
            out.append(self._embed(ints, name).flatten(1))
        return self.mix(torch.cat(out, dim=1))
