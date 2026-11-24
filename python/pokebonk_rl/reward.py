"""Reward functions, versioned. The environment sends the run's cumulative counters (the game's own figures) with
every step; a reward is computed here from their differences, so a new reward version never touches the environment.

Unit: one KO. Every component is a count of something the game itself counts, times a weight in KOs; the sum is
multiplied by `scale` before it reaches the learner.

Version v0 (configs/reward-v0.yaml), Stage 2:

  ko         KOs made in the step (`counters.kills`)
  guardian   zone guardians beaten
  zone       zones entered through a portal (zones 2, 3 and the sanctuary)
  legendary  the sanctuary's legendary beaten
  overtime   the overtime bonus KOs, paid once, at the end, and only if overtime was cashed
  death      fainting before the map is cleared (a run that ends as a victory is not a death)

Version v1 (configs/reward-v1.yaml), Stage 3, after the owner's decisions (KOs are the objective because the ranking
counts KOs; survive overtime as long as possible for its multipliers). Same components, and:

  overtime       the overtime bonus KOs **as they build up** (the game's own `overtime.bonus`), so each overtime round's
                 multiplier is felt when the KOs are made. If overtime is lost by fainting, everything paid here is
                 taken back at the end: the component sums to the cashed bonus, or to 0.
  overtime_void  the KOs made during an overtime that was lost by fainting, counted once at the end (weight negative).
                 The game's run history says of a lost overtime that "its KOs are voided" (docs/game-mechanics.md §1).

Version v2 (configs/reward-v2.yaml), Stage 3, after the owner's decision that using what is on the map should be
rewarded as much as possible. Everything of v1, and:

  map_use        uses of the map (`counters.mapUse`, src/observations/state.ts): each map point the game marks used
                 (Poké Balls, altars, Snorlax, cages, rocks, berries, Ditto, trades, the dojo, Bill's machine, …; not
                 the guardian altar, the shrine or the portal, which are paid as milestones), each shop purchase, each
                 slot-machine spin, each lesson of Hypno, each rift cleared and each Max form.
  shop_sale      each owned item sold in the shop (`counters.shopSold`; weight negative). The owner: "Selling in the
                 shop should take rewards away not add to it." A found item turned down for Pokédollars and what is
                 forgotten at Hypno are not sales in the shop: nothing is paid or taken for them.

Version v3 (configs/reward-v3.yaml), after the owner's decision of 2026-11-24 ("in a real run, you'd be getting KOs
extremely often. I would invalidate and/punish any run where no KOs or movement happens for 30 seconds"). Everything
of v2, and:

  idle           the episode was ended by the environment's rule against standing still (`env.max_idle_game_time`:
                 no KO and no movement for that long; src/environment, `maxIdleGameTime`), counted once, at the end
                 (weight negative). Such an episode is a true end for the learner, like fainting: nothing is
                 bootstrapped from the state it stopped in (python/pokebonk_rl/vec_env.py).

Version v4 (configs/reward-v4.yaml), after `mewtwo-v3-01` learned to stand in a corner of the map and use nothing
(docs/training.md §3): the 10 KOs of `map_use` were 0.4 % of an episode's reward. Everything of v3, and:

  point_use      map points used (`counters.pointsUsed`: the part of `mapUse` that is a point, each point once), paid
                 on top of `map_use`. Not the repeatable uses (shop purchases, slot-machine spins, lessons, Max forms),
                 which stay at `map_use` alone: those are limited only by Pokédollars.
  item           items by which the collection grew beyond the largest it has been (`counters.itemsPeak`, the game's
                 own `peakItems`). Selling and buying again does not raise the peak, so it is paid once per item.

Version v5 (configs/reward-v5.yaml), after the owner's order of importance of 2026-11-24: "KOs are most important,
overtime KOs per zone is next, so the longer the run goes per zone the better, spending pokedollars and opening item
chests and other map interactions is next, then earning pokedollars, and then its everything else." Everything of v4,
with the milestones (guardian, zone, legendary: "everything else") made smaller than a map point, and:

  spend          Pokédollars spent (`counters.goldSpent`, the game's own `run.goldSpent`: Poké Balls, the shop and its
                 rerolls, cages, slot machines, …), per Pokédollar.
  earn           Pokédollars earned (`counters.goldEarned`, the game's own `stats.gold`), per Pokédollar; less than
                 `spend`, so that keeping them never pays as much as spending them.

Also measured in every version (`raw`, weight 0, like damage taken): `swarm_kos`, the KOs made while the zone's final
swarm was on (the bridge's `sw`). They are KOs and are paid as KOs.

Nothing is paid for time survived, damage dealt or levels. Damage taken is measured (`raw`) but has weight 0.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

COMPONENTS_V0 = ("ko", "guardian", "zone", "legendary", "overtime", "death")
COMPONENTS_V1 = (*COMPONENTS_V0, "overtime_void")
COMPONENTS_V2 = (*COMPONENTS_V1, "map_use", "shop_sale")
COMPONENTS_V3 = (*COMPONENTS_V2, "idle")
COMPONENTS_V4 = (*COMPONENTS_V3, "point_use", "item")
COMPONENTS_V5 = (*COMPONENTS_V4, "spend", "earn")
COMPONENTS = {"v0": COMPONENTS_V0, "v1": COMPONENTS_V1, "v2": COMPONENTS_V2, "v3": COMPONENTS_V3, "v4": COMPONENTS_V4, "v5": COMPONENTS_V5}
#: Components whose weight is a penalty: the count is positive, the weight must not be.
PENALTIES = ("death", "overtime_void", "shop_sale", "idle")


def ended_idle(episode: Any) -> bool:
    """The episode was ended by the rule against standing still, which makes the run invalid. `episode` is an episode
    record of the bridge (`endCause`) or a stored row of `episodes` (`end_cause`)."""
    try:
        cause = episode["end_cause"] if "end_cause" in episode.keys() else episode["endCause"]
    except (KeyError, IndexError):
        return False
    return str(cause or "").startswith("idle")


@dataclass(frozen=True)
class RewardConfig:
    version: str = "v0"
    scale: float = 0.01
    weights: dict[str, float] = field(default_factory=lambda: {"ko": 1.0, "guardian": 250.0, "zone": 250.0, "legendary": 500.0, "overtime": 1.0, "death": -100.0})

    def __post_init__(self):
        if self.version not in COMPONENTS:
            raise ValueError(f"reward version {self.version!r} is not implemented (known: {', '.join(COMPONENTS)})")
        unknown = set(self.weights) - set(self.components)
        missing = set(self.components) - set(self.weights)
        if unknown or missing:
            raise ValueError(f"reward {self.version} has exactly the components {self.components}; unknown: {sorted(unknown)}, missing: {sorted(missing)}")
        wrong = [k for k, w in self.weights.items() if (w > 0) if k in PENALTIES] + [k for k, w in self.weights.items() if w < 0 and k not in PENALTIES]
        if wrong:
            raise ValueError(f"reward {self.version}: the weight of {sorted(wrong)} has the wrong sign (penalties: {PENALTIES})")
        if not self.scale > 0:
            raise ValueError("reward scale must be positive")

    @property
    def components(self) -> tuple[str, ...]:
        return COMPONENTS[self.version]

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "RewardConfig":
        return RewardConfig(version=str(d.get("version", "v0")), scale=float(d.get("scale", 0.01)), weights={k: float(v) for k, v in d["weights"].items()})

    def to_dict(self) -> dict[str, Any]:
        return {"version": self.version, "scale": self.scale, "weights": dict(self.weights)}


class RewardTracker:
    """The reward of one episode, step by step. `components` are the weighted, scaled sums; `raw` the plain counts."""

    def __init__(self, config: RewardConfig):
        self.config = config
        self.reset(None)

    def reset(self, counters: dict[str, Any] | None) -> None:
        self.prev = dict(counters) if counters else None
        self.components = {k: 0.0 for k in self.config.components}
        self.raw = {k: 0.0 for k in self.config.components}
        self.raw["damage_taken"] = 0.0
        self.raw["swarm_kos"] = 0.0
        self.total = 0.0
        self.steps = 0
        self.bonus_paid = 0.0            # v1: overtime bonus KOs paid so far
        self.overtime_k0: float | None = None   # v1: the run's KOs when overtime went live

    @staticmethod
    def _guardians(c: dict[str, Any]) -> float:
        # The game's boss counter includes legendaries (src/runner/episode.ts `defeated`).
        return max(0.0, float(c["guardiansDefeated"]) - float(c["legendariesDefeated"]))

    def _overtime_v1(self, raw: dict[str, float], p: dict[str, Any], c: dict[str, Any], episode: dict[str, Any] | None, overtime: dict[str, Any] | None) -> None:
        """Fills `overtime` (change of the bonus paid) and, at the end of a lost overtime, `overtime_void`."""
        running = overtime is not None and bool(overtime.get("live") or overtime.get("over"))
        if overtime is not None and overtime.get("live") and self.overtime_k0 is None:
            self.overtime_k0 = float(p["kills"])
        target = float(overtime["bonus"]) if running else self.bonus_paid
        if episode is not None:
            o = episode["overtime"]
            if o["cashed"]:
                target = float(o["bonus"])
            elif episode["terminated"] and o.get("started"):
                # Lost by fainting: the bonus is not kept, and the KOs made since overtime began are voided.
                target = 0.0
                record = (episode.get("record") or {}).get("ot") or {}
                k0 = record.get("k0", self.overtime_k0)
                raw["overtime_void"] = max(0.0, float(c["kills"]) - float(k0)) if k0 is not None else 0.0
        raw["overtime"] = target - self.bonus_paid
        self.bonus_paid = target

    def step(self, counters: dict[str, Any], episode: dict[str, Any] | None, overtime: dict[str, Any] | None = None, final_swarm: bool = False) -> float:
        """`counters` after the step; `episode` is the end-of-episode record on the step that ended it, else None;
        `overtime` is the step's overtime state as the environment reports it (`ot` of the bridge's reply), or None;
        `final_swarm`: the zone's final swarm is on after the step (`sw` of the bridge's reply)."""
        if self.prev is None:
            raise RuntimeError("RewardTracker.step before reset")
        p, c = self.prev, counters
        version = self.config.version
        raw = {k: 0.0 for k in self.config.components}
        raw["ko"] = float(c["kills"]) - float(p["kills"])
        raw["guardian"] = self._guardians(c) - self._guardians(p)
        raw["zone"] = float(c["zonesEntered"]) - float(p["zonesEntered"])
        raw["legendary"] = float(c["legendariesDefeated"]) - float(p["legendariesDefeated"])
        if version == "v0":
            if episode is not None and episode["overtime"]["cashed"]:
                raw["overtime"] = float(episode["overtime"]["bonus"])
        else:
            self._overtime_v1(raw, p, c, episode, overtime)
        if "map_use" in raw:
            if "mapUse" not in c:
                raise RuntimeError(f"reward {version} needs the counter 'mapUse', which this environment does not report (state schema 2 or later)")
            raw["map_use"] = float(c["mapUse"]) - float(p["mapUse"])
        if "shop_sale" in raw:
            if "shopSold" not in c:
                raise RuntimeError(f"reward {version} needs the counter 'shopSold', which this environment does not report")
            raw["shop_sale"] = float(c["shopSold"]) - float(p["shopSold"])
        for component, counter in (("point_use", "pointsUsed"), ("item", "itemsPeak"), ("spend", "goldSpent"), ("earn", "goldEarned")):
            if component in raw:
                if counter not in c:
                    raise RuntimeError(f"reward {version} needs the counter {counter!r}, which this environment does not report")
                raw[component] = float(c[counter]) - float(p[counter])
        if episode is not None and episode["terminated"] and not episode["victory"]:
            raw["death"] = 1.0
        if "idle" in raw and episode is not None and ended_idle(episode):
            raw["idle"] = 1.0
        for k, v in raw.items():
            if v < 0 and not (k == "overtime" and version != "v0"):
                raise RuntimeError(f"reward {version}: the counter behind {k!r} went down by {-v} in one step; counters are expected to be cumulative")
        self.raw["damage_taken"] += max(0.0, float(c["damageTaken"]) - float(p["damageTaken"]))
        if final_swarm:
            self.raw["swarm_kos"] += raw["ko"]
        w, s = self.config.weights, self.config.scale
        reward = 0.0
        for k, v in raw.items():
            if v:
                part = v * w[k] * s
                self.raw[k] += v
                self.components[k] += part
                reward += part
        self.total += reward
        self.steps += 1
        self.prev = dict(c)
        return reward

    def summary(self) -> dict[str, Any]:
        return {"version": self.config.version, "total": self.total, "components": dict(self.components), "raw": dict(self.raw), "steps": self.steps}
