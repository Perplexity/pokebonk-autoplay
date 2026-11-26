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

Version v6 (configs/reward-v6.yaml), after the owner's decision of 2026-11-24: "We should allow rifts infinite time,
but we need a way of rewarding a rift completion based on how quickly we cleared it. The quicker, the more rewards."
Everything of v5, and:

  rift           a rift completed: cleared (`counters.riftsCleared` went up while inside) and left through its portal.
                 Paid at the moment of leaving, RIFT_HALF_SECONDS / (RIFT_HALF_SECONDS + seconds inside) of the weight:
                 all of it for no time at all, half for RIFT_HALF_SECONDS, never nothing and never a penalty. The
                 seconds are the run clock's from walking in to walking out (the bridge's `rf`), so both the fight and
                 the walk to the exit count. A rift left uncleared, or not left before the episode ends, pays nothing.

Version v7 (configs/reward-v7.yaml) and v7log (configs/reward-v7log.yaml), phase 3 of the heuristic + RL refactor,
after the owner's brief: "pay the change in sqrt(KOs + current Overtime bonus), scaled so a 20M run returns about 5.
If Overtime is lost by fainting, take the bonus part back. No reward for healing itself … Other terms stay in
decision 8's order and together under 5% of a 1M-KO run's return." Unit: the learner's own (scale 1), not one KO.

  score          the change of  unit × f(score)  where score = KOs + the Overtime bonus as it stands (the game's own
                 `overtime.bonus` while Overtime is live or over), f = sqrt for v7 and log1p(score / knee) for v7log,
                 and `unit` is such that a score of 20 million gives 5. At the end of an episode the score is the
                 evaluation's: KOs + the bonus if it was cashed, KOs alone if it was not (fainted in Overtime: the
                 last payment is negative, the bonus part is taken back). So the component sums to
                 unit × f(final score): a KO is worth more early than late, and a run of 20 million still returns
                 more than four of 1 million.
  idle           an episode ended by a rule against standing still is invalid and scores 0 in an evaluation: here
                 everything `score` paid is taken back, once, at the end. `score` + `idle` = 0 for such an episode.
  the others     point_use, map_use, item, spend (using the map and spending), earn, and guardian, zone, legendary,
                 rift (the rest): each counted as before (rift: by how quickly, as in v6) and paid as the change of
                 cap × (1 − 2 ** (−count / half)): half of its cap after `half` of them, never more than the cap.
                 The cap is `share` × the return of a run that scores 1 million. The shares of all of them sum to
                 less than 5 % (refused otherwise), and the three groups keep decision 8's order.
  death          fainting before the map is cleared, once (`weights.death`, a share of a 1-million run's return).
  shop_sale      each owned item sold in the shop (`weights.shop_sale`, the same unit), without a cap.

Nothing is paid for healing, for HP, for time survived, for damage or for levels.

Also measured in every version (`raw`, weight 0, like damage taken): `swarm_kos`, the KOs made while the zone's final
swarm was on (the bridge's `sw`). They are KOs and are paid as KOs.

Nothing is paid for time survived, damage dealt or levels. Damage taken is measured (`raw`) but has weight 0.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

COMPONENTS_V0 = ("ko", "guardian", "zone", "legendary", "overtime", "death")
COMPONENTS_V1 = (*COMPONENTS_V0, "overtime_void")
COMPONENTS_V2 = (*COMPONENTS_V1, "map_use", "shop_sale")
COMPONENTS_V3 = (*COMPONENTS_V2, "idle")
COMPONENTS_V4 = (*COMPONENTS_V3, "point_use", "item")
COMPONENTS_V5 = (*COMPONENTS_V4, "spend", "earn")
COMPONENTS_V6 = (*COMPONENTS_V5, "rift")
#: v6: a completed rift is paid this share of the `rift` weight: RIFT_HALF_SECONDS / (RIFT_HALF_SECONDS + seconds inside).
RIFT_HALF_SECONDS = 60.0
#: v7 and v7log (phase 3): the score's transform, then the smaller terms in decision 8's three groups, then penalties.
V7_GROUPS = {"map": ("point_use", "map_use", "item", "spend"), "earn": ("earn",), "rest": ("guardian", "zone", "legendary", "rift")}
V7_TERMS = tuple(k for group in V7_GROUPS.values() for k in group)
COMPONENTS_V7 = ("score", *V7_TERMS, "death", "shop_sale", "idle")
V7_TRANSFORMS = {"v7": "sqrt", "v7log": "log"}
#: The smaller terms of v7 together stay under this share of the return of a run that scores V7_REFERENCE_SCORE.
V7_OTHERS_MAX_SHARE = 0.05
V7_REFERENCE_SCORE = 1_000_000.0
V7_TARGET = (20_000_000.0, 5.0)     # "scaled so a 20M run returns about 5"
COMPONENTS = {"v7": COMPONENTS_V7, "v7log": COMPONENTS_V7, "v6": COMPONENTS_V6, "v0": COMPONENTS_V0, "v1": COMPONENTS_V1, "v2": COMPONENTS_V2, "v3": COMPONENTS_V3, "v4": COMPONENTS_V4, "v5": COMPONENTS_V5}
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
    #: v7 and v7log only. `score`: {"transform": "sqrt"} or {"transform": "log", "knee": …}. `terms`: per smaller term
    #: {"share": of a 1-million run's return, at most, "half": the count that pays half of it}.
    score: dict[str, Any] | None = None
    terms: dict[str, dict[str, float]] | None = None

    def __post_init__(self):
        if self.version not in COMPONENTS:
            raise ValueError(f"reward version {self.version!r} is not implemented (known: {', '.join(COMPONENTS)})")
        if self.version in V7_TRANSFORMS:
            self._check_v7()
            return
        if self.score is not None or self.terms is not None:
            raise ValueError(f"reward {self.version} has no `score` or `terms`: those are v7's")
        unknown = set(self.weights) - set(self.components)
        missing = set(self.components) - set(self.weights)
        if unknown or missing:
            raise ValueError(f"reward {self.version} has exactly the components {self.components}; unknown: {sorted(unknown)}, missing: {sorted(missing)}")
        wrong = [k for k, w in self.weights.items() if (w > 0) if k in PENALTIES] + [k for k, w in self.weights.items() if w < 0 and k not in PENALTIES]
        if wrong:
            raise ValueError(f"reward {self.version}: the weight of {sorted(wrong)} has the wrong sign (penalties: {PENALTIES})")
        if not self.scale > 0:
            raise ValueError("reward scale must be positive")

    def _check_v7(self) -> None:
        v = self.version
        score, terms = self.score or {}, self.terms or {}
        if score.get("transform") != V7_TRANSFORMS[v]:
            raise ValueError(f"reward {v}: score.transform must be {V7_TRANSFORMS[v]!r}")
        if V7_TRANSFORMS[v] == "log" and not float(score.get("knee", 0)) > 0:
            raise ValueError(f"reward {v}: score.knee must be a positive score")
        if set(score) - {"transform", "knee"}:
            raise ValueError(f"reward {v}: unknown keys in score: {sorted(set(score) - {'transform', 'knee'})}")
        if set(terms) != set(V7_TERMS):
            raise ValueError(f"reward {v} has exactly the terms {V7_TERMS}; unknown: {sorted(set(terms) - set(V7_TERMS))}, missing: {sorted(set(V7_TERMS) - set(terms))}")
        for k, t in terms.items():
            if set(t) != {"share", "half"} or not float(t["share"]) > 0 or not float(t["half"]) > 0:
                raise ValueError(f"reward {v}: term {k!r} needs a positive `share` and a positive `half`")
        total = sum(float(t["share"]) for t in terms.values())
        if not total < V7_OTHERS_MAX_SHARE:
            raise ValueError(f"reward {v}: the smaller terms may pay {total:.4f} of a {V7_REFERENCE_SCORE:,.0f} run's return together; they must stay under {V7_OTHERS_MAX_SHARE}")
        groups = [sum(float(terms[k]["share"]) for k in V7_GROUPS[g]) for g in ("map", "earn", "rest")]
        if not groups[0] > groups[1] > groups[2]:
            raise ValueError(f"reward {v}: the owner's order (using the map and spending, then earning, then the rest) is not kept by the shares {groups}")
        if set(self.weights) != {"death", "shop_sale"} or any(w > 0 for w in self.weights.values()):
            raise ValueError(f"reward {v} has exactly the weights death and shop_sale, neither positive")
        if self.scale != 1.0:
            raise ValueError(f"reward {v} is in the learner's own unit: scale must be 1")

    @property
    def components(self) -> tuple[str, ...]:
        return COMPONENTS[self.version]

    # ------------------------------------------------------------ v7: the score's transform
    def score_return(self, score: float) -> float:
        """v7 and v7log: what a run of this score has been paid by the `score` component when it ends."""
        target_score, target_return = V7_TARGET
        if self.score["transform"] == "sqrt":
            return target_return * math.sqrt(max(0.0, score) / target_score)
        knee = float(self.score["knee"])
        return target_return * math.log1p(max(0.0, score) / knee) / math.log1p(target_score / knee)

    @property
    def reference_return(self) -> float:
        """v7 and v7log: the return of a run that scores 1 million, the unit of `terms.*.share` and of the weights."""
        return self.score_return(V7_REFERENCE_SCORE)

    def term_paid(self, term: str, count: float) -> float:
        """v7 and v7log: what the smaller term has paid in all after `count` of its events."""
        t = self.terms[term]
        return float(t["share"]) * self.reference_return * (1.0 - 2.0 ** (-max(0.0, count) / float(t["half"])))

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "RewardConfig":
        return RewardConfig(version=str(d.get("version", "v0")), scale=float(d.get("scale", 0.01)), weights={k: float(v) for k, v in d["weights"].items()},
                            score=dict(d["score"]) if d.get("score") is not None else None,
                            terms={k: {a: float(b) for a, b in t.items()} for k, t in d["terms"].items()} if d.get("terms") is not None else None)

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"version": self.version, "scale": self.scale, "weights": dict(self.weights)}
        if self.score is not None:
            out["score"], out["terms"] = dict(self.score), {k: dict(t) for k, t in (self.terms or {}).items()}
        return out


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
        self.raw["rifts_completed"] = 0.0
        self.raw["rift_seconds"] = 0.0
        self.rift_entered: tuple[float, float] | None = None   # v6: the run clock and `riftsCleared` when the rift was entered
        self.total = 0.0
        self.steps = 0
        self.bonus_paid = 0.0            # v1: overtime bonus KOs paid so far
        self.overtime_k0: float | None = None   # v1: the run's KOs when overtime went live
        if self.config.version in V7_TRANSFORMS:
            self.raw.update(ko=0.0, overtime=0.0)   # plain counts, for the records: both are paid through `score`
            self.score_paid = self.config.score_return(float(counters["kills"])) if counters else 0.0   # nothing is owed for KOs made before the reset
            self.score_paid0 = self.score_paid
            self.bonus_now = 0.0
            self.counts = {k: 0.0 for k in V7_TERMS}

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

    def step(self, counters: dict[str, Any], episode: dict[str, Any] | None, overtime: dict[str, Any] | None = None, final_swarm: bool = False,
             in_rift: bool = False) -> float:
        """`counters` after the step; `episode` is the end-of-episode record on the step that ended it, else None;
        `overtime` is the step's overtime state as the environment reports it (`ot` of the bridge's reply), or None;
        `final_swarm`: the zone's final swarm is on after the step (`sw` of the bridge's reply); `in_rift`: the player
        is inside a rift after the step (`rf`)."""
        if self.prev is None:
            raise RuntimeError("RewardTracker.step before reset")
        if self.config.version in V7_TRANSFORMS:
            return self._step_v7(counters, episode, overtime, final_swarm, in_rift)
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
        completed_in = None
        if "rift" in raw:
            for counter in ("riftsCleared", "time"):
                if counter not in c:
                    raise RuntimeError(f"reward {version} needs the counter {counter!r}, which this environment does not report")
            if in_rift and self.rift_entered is None:
                self.rift_entered = (float(p["time"]), float(p["riftsCleared"]))
            elif not in_rift and self.rift_entered is not None:
                entered, cleared_before = self.rift_entered
                self.rift_entered = None
                if float(c["riftsCleared"]) > cleared_before:
                    completed_in = max(0.0, float(c["time"]) - entered)
                    raw["rift"] = RIFT_HALF_SECONDS / (RIFT_HALF_SECONDS + completed_in)
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
        if completed_in is not None:
            self.raw["rifts_completed"] += 1
            self.raw["rift_seconds"] += completed_in
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

    def _step_v7(self, c: dict[str, Any], episode: dict[str, Any] | None, overtime: dict[str, Any] | None, final_swarm: bool, in_rift: bool) -> float:
        """v7 and v7log. Every payment is the change of a function of the run's cumulative figures, so each component
        sums to that function of the episode's last figures whatever the steps in between were."""
        cfg, p, version = self.config, self.prev, self.config.version
        for counter in ("kills", "mapUse", "pointsUsed", "itemsPeak", "goldSpent", "goldEarned", "shopSold", "riftsCleared", "time", "zonesEntered", "guardiansDefeated", "legendariesDefeated"):
            if counter not in c:
                raise RuntimeError(f"reward {version} needs the counter {counter!r}, which this environment does not report")
        kos = float(c["kills"]) - float(p["kills"])
        if kos < 0:
            raise RuntimeError(f"reward {version}: the KO counter went down by {-kos} in one step; counters are expected to be cumulative")
        part = {k: 0.0 for k in cfg.components}
        # The score: KOs + the Overtime bonus as it stands; at the end, the evaluation's own figure.
        if overtime is not None and (overtime.get("live") or overtime.get("over")):
            bonus = float(overtime.get("bonus") or 0.0)
        else:
            bonus = self.bonus_now
        idle = False
        if episode is not None:
            bonus = float(episode["overtime"]["bonus"]) if episode["overtime"]["cashed"] else 0.0
            idle = ended_idle(episode)
        self.raw["overtime"] += bonus - self.bonus_now
        self.bonus_now = bonus
        due = cfg.score_return(float(c["kills"]) + bonus)
        part["score"] = due - self.score_paid
        self.score_paid = due
        if idle:
            part["idle"] = -(due - self.score_paid0)      # an invalid run scores 0: everything `score` paid is taken back
            self.raw["idle"] += 1.0
        # The smaller terms: counts as in v5 and v6, each paid as the change of a function that never passes its cap.
        gained = {"point_use": float(c["pointsUsed"]) - float(p["pointsUsed"]), "map_use": float(c["mapUse"]) - float(p["mapUse"]),
                  "item": float(c["itemsPeak"]) - float(p["itemsPeak"]), "spend": float(c["goldSpent"]) - float(p["goldSpent"]),
                  "earn": float(c["goldEarned"]) - float(p["goldEarned"]), "guardian": self._guardians(c) - self._guardians(p),
                  "zone": float(c["zonesEntered"]) - float(p["zonesEntered"]), "legendary": float(c["legendariesDefeated"]) - float(p["legendariesDefeated"]), "rift": 0.0}
        completed_in = None
        if in_rift and self.rift_entered is None:
            self.rift_entered = (float(p["time"]), float(p["riftsCleared"]))
        elif not in_rift and self.rift_entered is not None:
            entered, cleared_before = self.rift_entered
            self.rift_entered = None
            if float(c["riftsCleared"]) > cleared_before:
                completed_in = max(0.0, float(c["time"]) - entered)
                gained["rift"] = RIFT_HALF_SECONDS / (RIFT_HALF_SECONDS + completed_in)
        for k, v in gained.items():
            if v < 0:
                raise RuntimeError(f"reward {version}: the counter behind {k!r} went down by {-v} in one step; counters are expected to be cumulative")
            if v:
                before = cfg.term_paid(k, self.counts[k])
                self.counts[k] += v
                part[k] = cfg.term_paid(k, self.counts[k]) - before
                self.raw[k] += v
        unit = cfg.reference_return
        sold = float(c["shopSold"]) - float(p["shopSold"])
        if sold < 0:
            raise RuntimeError(f"reward {version}: the counter behind 'shop_sale' went down by {-sold} in one step")
        if sold:
            part["shop_sale"] = sold * cfg.weights["shop_sale"] * unit
            self.raw["shop_sale"] += sold
        if episode is not None and episode["terminated"] and not episode["victory"]:
            part["death"] = cfg.weights["death"] * unit
            self.raw["death"] += 1.0
        self.raw["ko"] += kos
        self.raw["damage_taken"] += max(0.0, float(c["damageTaken"]) - float(p["damageTaken"]))
        if final_swarm:
            self.raw["swarm_kos"] += kos
        if completed_in is not None:
            self.raw["rifts_completed"] += 1
            self.raw["rift_seconds"] += completed_in
        reward = 0.0
        for k, v in part.items():
            if v:
                self.components[k] += v
                reward += v
        self.raw["score"] = self.score_paid - self.score_paid0
        self.total += reward
        self.steps += 1
        self.prev = dict(c)
        return reward

    def summary(self) -> dict[str, Any]:
        return {"version": self.config.version, "total": self.total, "components": dict(self.components), "raw": dict(self.raw), "steps": self.steps}
