"""The observation and action layouts exported by the Node side (data/encoding/<build>/), as the trainer needs them.

The layout descriptor is the contract between the encoder (src/observations/encode.ts) and everything here: segment
offsets and shapes are read from it, never written down a second time.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .bridge import REPO


@dataclass(frozen=True)
class Layouts:
    build: str
    observation: dict[str, Any]
    action: dict[str, Any]
    vocab_sizes: dict[str, int]

    @property
    def float_size(self) -> int:
        return int(self.observation["floatSize"])

    @property
    def int_size(self) -> int:
        return int(self.observation["intSize"])

    @property
    def nvec(self) -> list[int]:
        return [int(n) for n in self.action["nvec"]]

    @property
    def mask_size(self) -> int:
        return sum(self.nvec)

    @property
    def observation_hash(self) -> str:
        return str(self.observation["hash"])

    @property
    def action_hash(self) -> str:
        return str(self.action["hash"])

    def extractor_spec(self) -> dict[str, Any]:
        """What the feature extractor needs, as plain data (it is stored inside every saved model)."""
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
        return {"float": floats, "int": ints, "vocab_sizes": {v: self.vocab_sizes[v] for v in used},
                "float_size": self.float_size, "int_size": self.int_size, "layout_hash": self.observation_hash}


def load_layouts(build: str, repo: Path = REPO) -> Layouts:
    enc = repo / "data" / "encoding" / build
    know = repo / "data" / "game-knowledge" / build
    for p in (enc / "observation-layout.json", enc / "action-layout.json", know / "vocab.json"):
        if not p.exists():
            raise FileNotFoundError(f"{p} is missing: run `npm run export:knowledge` and `npm run export:encoding` for build {build}")
    obs = json.loads((enc / "observation-layout.json").read_text("utf-8"))
    act = json.loads((enc / "action-layout.json").read_text("utf-8"))
    vocab = json.loads((know / "vocab.json").read_text("utf-8"))
    # Index 0 of every table is reserved ("none / unknown"), so an embedding needs one row more than the table has keys.
    sizes = {name: max(table.values()) + 1 for name, table in vocab["tables"].items()}
    return Layouts(build=build, observation=obs, action=act, vocab_sizes=sizes)


def check_against_metadata(layouts: Layouts, metadata: dict[str, Any]) -> None:
    """The running environment must encode with exactly the layouts loaded here; anything else is refused."""
    enc = metadata["full"]["encoding"]
    problems = []
    if metadata["gameBuild"] != layouts.build:
        problems.append(f"game build {metadata['gameBuild']} (layouts are for {layouts.build})")
    if enc["observation"]["layoutHash"] != layouts.observation_hash:
        problems.append(f"observation layout {enc['observation']['layoutHash'][:16]}… (file: {layouts.observation_hash[:16]}…)")
    if enc["action"]["hash"] != layouts.action_hash:
        problems.append(f"action layout {enc['action']['hash'][:16]}… (file: {layouts.action_hash[:16]}…)")
    if [int(n) for n in enc["action"]["nvec"]] != layouts.nvec:
        problems.append(f"action sizes {enc['action']['nvec']} (file: {layouts.nvec})")
    if problems:
        raise RuntimeError("the running environment does not match the exported layouts: " + "; ".join(problems)
                           + ". Re-export with `npm run export:encoding`; a model trained on another layout cannot be used.")
