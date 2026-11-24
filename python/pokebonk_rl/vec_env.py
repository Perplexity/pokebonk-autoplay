"""A Stable-Baselines3 vectorised environment over Node game processes.

Each of the `n_envs` slots is one game process (python/pokebonk_rl/bridge.py). Two things differ from an ordinary
vectorised environment, both because a reset of the game takes seconds (it loads a zone) and a game process grows with
every episode it plays:

- **Spare processes.** Besides the slots there are `n_spares` processes that have already been reset and hold the
  first observation of an episode. When a slot's episode ends, a ready spare takes the slot at once and the old
  process resets in the background to become a spare. Without spares every reset would stall all slots.
- **Recycling.** A process that has played `recycle_after` episodes (or grown beyond `recycle_rss_mb`) is closed and
  replaced by a fresh one instead of being reset.

An episode is fully determined by its seed, its scenario and the actions it is given; which slot or process plays it
makes no difference (docs/environment.md §3).

Errors: a process that reports an error, dies or stops answering is replaced. Its episode is given up: the slot
reports it as truncated with reward 0 for that step, the error is passed to `on_error`, and after `max_errors` such
events the trainer stops, because a failure that repeats is a defect to look at, not noise to train through.
"""
from __future__ import annotations

import random
import time
from collections import deque
from pathlib import Path
from typing import Any, Callable, Sequence

import numpy as np
from gymnasium import spaces
from stable_baselines3.common.vec_env.base_vec_env import VecEnv

from .bridge import Frame, NodeWorker, WorkerError
from .layout import Layouts, check_against_metadata
from .reward import RewardConfig, RewardTracker


class Scenarios:
    """Which Pokémon, map and tier an episode is played on: uniform over the configured lists, decided by the episode's number."""

    def __init__(self, species: Sequence[int], maps: Sequence[str], tiers: Sequence[int], seed: int = 0):
        if not species or not maps or not tiers:
            raise ValueError("scenarios need at least one species, one map and one tier")
        self.species, self.maps, self.tiers, self.seed = [int(s) for s in species], [str(m) for m in maps], [int(t) for t in tiers], int(seed)

    def pick(self, episode_index: int) -> dict[str, Any]:
        r = random.Random(self.seed * 1_000_003 + episode_index)
        return {"species": r.choice(self.species), "map": r.choice(self.maps), "tier": r.choice(self.tiers)}

    def to_dict(self) -> dict[str, Any]:
        return {"species": self.species, "maps": self.maps, "tiers": self.tiers, "seed": self.seed}


class _Slot:
    def __init__(self, worker: NodeWorker, reward: RewardConfig):
        self.worker = worker
        self.tracker = RewardTracker(reward)
        self.seed = -1
        self.scenario: dict[str, Any] = {}
        self.episode_index = -1


class NodeVecEnv(VecEnv):
    def __init__(self, *, n_envs: int, layouts: Layouts, env_options: dict[str, Any], reward: RewardConfig, scenarios: Scenarios, first_seed: int,
                 first_episode: int = 0, n_spares: int = 1, recycle_after: int = 8, recycle_rss_mb: int = 1500, record_decisions: bool = False,
                 log_dir: Path | None = None, step_timeout: float = 300.0, reset_timeout: float = 600.0, max_errors: int = 20,
                 on_episode: Callable[[dict[str, Any]], None] | None = None, on_error: Callable[[WorkerError, dict[str, Any]], None] | None = None,
                 on_metadata: Callable[[dict[str, Any]], None] | None = None):
        self.layouts = layouts
        observation_space = spaces.Dict({
            "float": spaces.Box(-np.inf, np.inf, (layouts.float_size,), np.float32),
            "int": spaces.Box(0, max(layouts.vocab_sizes.values()), (layouts.int_size,), np.int32),
        })
        super().__init__(n_envs, observation_space, spaces.MultiDiscrete(layouts.nvec))
        self.env_options, self.reward_config, self.scenarios = dict(env_options), reward, scenarios
        self.first_seed = int(first_seed)
        self.episodes_started = int(first_episode)     # episodes handed out so far in this training run (all sessions)
        self.episodes_finished = 0                      # in this session
        self.n_spares, self.recycle_after, self.recycle_rss_mb = int(n_spares), int(recycle_after), int(recycle_rss_mb)
        self.record_decisions, self.log_dir = record_decisions, Path(log_dir) if log_dir else None
        self.step_timeout, self.reset_timeout, self.max_errors = step_timeout, reset_timeout, int(max_errors)
        self.on_episode, self.on_error, self.on_metadata = on_episode, on_error, on_metadata
        self.errors = 0
        self.workers_started = 0
        self._slots: list[_Slot | None] = [None] * n_envs
        self._spares: deque[_Slot] = deque()
        self._masks = np.zeros((n_envs, layouts.mask_size), dtype=bool)
        self._obs = {"float": np.zeros((n_envs, layouts.float_size), np.float32), "int": np.zeros((n_envs, layouts.int_size), np.int32)}
        self._actions: np.ndarray | None = None
        self._metadata_seen = False
        self._closed = False
        # Wall time spent waiting for game processes: the "simulation" share of a training loop.
        self.seconds_waiting = 0.0

    # ---------------------------------------------------------------- processes

    def _launch(self) -> _Slot:
        """A fresh process with its first reset already requested."""
        wid = self.workers_started
        self.workers_started += 1
        log = self.log_dir / f"worker-{wid:04d}.log" if self.log_dir else None
        if log:
            log.parent.mkdir(parents=True, exist_ok=True)
        slot = _Slot(NodeWorker(self.env_options, record_decisions=self.record_decisions, log_path=log, worker_id=wid), self.reward_config)
        self._request_reset(slot)
        return slot

    def _request_reset(self, slot: _Slot) -> None:
        k = self.episodes_started
        self.episodes_started += 1
        slot.episode_index, slot.seed, slot.scenario = k, self.first_seed + k, self.scenarios.pick(k)
        slot.worker.request_reset(slot.seed, **slot.scenario)

    def _retire(self, slot: _Slot, *, broken: bool = False) -> None:
        """What happens to a process whose episode is over: reset it into the spare line, or replace it."""
        w = slot.worker
        if broken or w.episodes >= self.recycle_after or w.rss_mb > self.recycle_rss_mb:
            (w.kill if broken else w.close)()
            self._spares.append(self._launch())
        else:
            self._request_reset(slot)
            self._spares.append(slot)

    def _take_spare(self) -> tuple[_Slot, Frame]:
        """The next process that holds a fresh episode: a ready one if there is one, else the one that asked first."""
        while True:
            if not self._spares:
                self._spares.append(self._launch())
            pick = next((s for s in self._spares if s.worker.ready()), self._spares[0])
            self._spares.remove(pick)
            try:
                frame = self._recv(pick, self.reset_timeout)
            except WorkerError as e:
                self._failed(pick, e, during="reset")
                self._spares.append(self._launch())
                continue
            if not self._metadata_seen and pick.worker.metadata is not None:
                check_against_metadata(self.layouts, pick.worker.metadata)
                self._metadata_seen = True
                if self.on_metadata:
                    self.on_metadata(pick.worker.metadata)
            pick.tracker.reset(frame.header["c"])
            return pick, frame

    def _recv(self, slot: _Slot, timeout: float) -> Frame:
        t = time.perf_counter()
        try:
            return slot.worker.recv(timeout)
        finally:
            self.seconds_waiting += time.perf_counter() - t

    def _failed(self, slot: _Slot, error: WorkerError, during: str) -> None:
        self.errors += 1
        context = {"seed": slot.seed, "scenario": slot.scenario, "episodeIndex": slot.episode_index, "workerId": slot.worker.worker_id, "during": during}
        slot.worker.kill()
        if self.on_error:
            self.on_error(error, context)
        if self.errors > self.max_errors:
            raise RuntimeError(f"{self.errors} environment errors in this session (limit {self.max_errors}); the last one: {error}") from error

    def _place(self, i: int, slot: _Slot, frame: Frame) -> None:
        self._slots[i] = slot
        self._obs["float"][i], self._obs["int"][i], self._masks[i] = frame.float, frame.int, frame.mask.astype(bool)

    # ---------------------------------------------------------------- VecEnv

    def reset(self):
        """New episodes on every slot. (Called once by the learner; episodes in progress, if any, are abandoned.)"""
        for i, slot in enumerate(self._slots):
            if slot is not None:
                self._retire(slot)
                self._slots[i] = None
        while len(self._spares) < self.num_envs + self.n_spares:
            self._spares.append(self._launch())
        for i in range(self.num_envs):
            slot, frame = self._take_spare()
            self._place(i, slot, frame)
        return self._copy_obs()

    def _copy_obs(self) -> dict[str, np.ndarray]:
        return {"float": self._obs["float"].copy(), "int": self._obs["int"].copy()}

    def step_async(self, actions: np.ndarray) -> None:
        self._actions = np.asarray(actions)

    def step_wait(self):
        actions = self._actions
        failed: dict[int, WorkerError] = {}
        for i, slot in enumerate(self._slots):
            try:
                slot.worker.request_step(actions[i])
            except WorkerError as e:
                failed[i] = e
        rewards = np.zeros(self.num_envs, np.float32)
        dones = np.zeros(self.num_envs, bool)
        infos: list[dict[str, Any]] = [{} for _ in range(self.num_envs)]
        for i, slot in enumerate(self._slots):
            frame = None
            if i not in failed:
                try:
                    frame = self._recv(slot, self.step_timeout)
                except WorkerError as e:
                    failed[i] = e
            if frame is None:
                # The process is gone and with it the episode: end it here as truncated, with what was last observed.
                self._failed(slot, failed[i], during="step")
                dones[i] = True
                infos[i] = {"terminal_observation": {"float": self._obs["float"][i].copy(), "int": self._obs["int"][i].copy()}, "TimeLimit.truncated": True, "worker_error": str(failed[i])}
                new, first = self._take_spare_after(slot, broken=True)
                self._place(i, new, first)
                continue
            episode = frame.header.get("episode")
            rewards[i] = slot.tracker.step(frame.header["c"], episode, frame.header.get("ot"))
            if episode is None:
                self._obs["float"][i], self._obs["int"][i], self._masks[i] = frame.float, frame.int, frame.mask.astype(bool)
                continue
            dones[i] = True
            summary = slot.tracker.summary()
            self.episodes_finished += 1
            infos[i] = {
                "terminal_observation": {"float": frame.float.copy(), "int": frame.int.copy()},
                "TimeLimit.truncated": bool(episode["truncated"] and not episode["terminated"]),
                "episode": {"r": summary["total"], "l": summary["steps"], "t": episode["wallSeconds"]},
                "pokebonk": {"episode": episode, "reward": summary, "scenario": slot.scenario, "episode_index": slot.episode_index, "worker_id": slot.worker.worker_id},
            }
            if self.on_episode:
                self.on_episode(infos[i]["pokebonk"])
            new, first = self._take_spare_after(slot)
            self._place(i, new, first)
        return self._copy_obs(), rewards, dones, infos

    def _take_spare_after(self, old: _Slot, broken: bool = False) -> tuple[_Slot, Frame]:
        if broken:
            self._spares.append(self._launch())
        else:
            self._retire(old)
        return self._take_spare()

    def action_masks(self) -> np.ndarray:
        return self._masks.copy()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        for slot in [s for s in self._slots if s is not None] + list(self._spares):
            try:
                slot.worker.kill()   # an episode in flight is abandoned; nothing of it is kept
            except Exception:  # noqa: BLE001
                pass
        self._slots = [None] * self.num_envs
        self._spares.clear()

    # SB3 plumbing: the only "method of the wrapped environments" is the action mask.
    def env_method(self, method_name: str, *method_args, indices=None, **method_kwargs):
        if method_name != "action_masks":
            raise AttributeError(f"NodeVecEnv has no environment method {method_name!r}")
        idx = range(self.num_envs) if indices is None else ([indices] if isinstance(indices, int) else indices)
        return [self._masks[i].copy() for i in idx]

    def get_attr(self, attr_name: str, indices=None):
        idx = range(self.num_envs) if indices is None else ([indices] if isinstance(indices, int) else indices)
        if attr_name == "action_masks":
            return [None for _ in idx]
        if attr_name == "render_mode":
            return [None for _ in idx]
        raise AttributeError(f"NodeVecEnv has no environment attribute {attr_name!r}")

    def set_attr(self, attr_name: str, value, indices=None) -> None:
        raise AttributeError("NodeVecEnv has no settable environment attributes")

    def env_is_wrapped(self, wrapper_class, indices=None):
        idx = range(self.num_envs) if indices is None else ([indices] if isinstance(indices, int) else indices)
        return [False for _ in idx]

    def seed(self, seed=None):
        # Episode seeds come from `first_seed` and the episode counter, never from the learner's seed.
        return [None] * self.num_envs
