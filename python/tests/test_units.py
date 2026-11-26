"""Tests that need no game process: reward, configuration, offline rule, storage, checkpoints, registry, network."""
from __future__ import annotations

import json
import socket
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from pokebonk_rl import config as cfg
from pokebonk_rl import offline
from pokebonk_rl.bridge import REPO
from pokebonk_rl.checkpoints import latest_checkpoint, list_checkpoints, read_checkpoint, save_checkpoint
from pokebonk_rl.evaluate import compare, score, summarize
from pokebonk_rl.layout import load_layouts
from pokebonk_rl.registry import RegistryError, current_stable, promote, register_candidate, rollback
from pokebonk_rl.reward import RewardConfig, RewardTracker
from pokebonk_rl.storage import Store, sha256_file
from pokebonk_rl.vec_env import Scenarios

BUILD = "mwsewi0r"


# ---------------------------------------------------------------- reward

def counters(**over):
    c = {"kills": 0, "guardiansDefeated": 0, "legendariesDefeated": 0, "zonesEntered": 1, "damageTaken": 0.0, "mapUse": 0, "shopSold": 0, "pointsUsed": 0, "itemsPeak": 0, "goldSpent": 0, "goldEarned": 0, "riftsCleared": 0, "time": 0.0}
    c.update(over)
    return c


def episode_end(*, terminated=True, victory=False, cashed=False, bonus=0, started=False, record=None):
    return {"terminated": terminated, "victory": victory, "overtime": {"cashed": cashed, "bonus": bonus, "started": started}, "record": record}


def default_reward(version: str = "v0") -> RewardConfig:
    import yaml
    return RewardConfig.from_dict(yaml.safe_load((REPO / "configs" / f"reward-{version}.yaml").read_text("utf-8")))


def test_reward_v0_pays_kos_and_milestones_from_counter_differences():
    r = default_reward()
    t = RewardTracker(r)
    t.reset(counters(kills=5))
    assert t.step(counters(kills=5), None) == 0.0                      # nothing happened: nothing is paid, time is not rewarded
    assert t.step(counters(kills=12), None) == pytest.approx(7 * 0.01)
    # A guardian falls (the game's boss counter rises), then the portal is taken.
    assert t.step(counters(kills=12, guardiansDefeated=1), None) == pytest.approx(250 * 0.01)
    assert t.step(counters(kills=12, guardiansDefeated=1, zonesEntered=2), None) == pytest.approx(250 * 0.01)
    # The legendary raises both of the game's counters: it is paid as a legendary, not also as a guardian.
    assert t.step(counters(kills=13, guardiansDefeated=2, legendariesDefeated=1, zonesEntered=2), None) == pytest.approx((1 + 500) * 0.01)
    s = t.summary()
    assert s["raw"]["ko"] == 8 and s["raw"]["guardian"] == 1 and s["raw"]["zone"] == 1 and s["raw"]["legendary"] == 1
    assert s["total"] == pytest.approx(sum(s["components"].values()))
    assert s["version"] == "v0" and s["steps"] == 5


def test_reward_v0_end_of_episode_terms():
    r = default_reward()
    died = RewardTracker(r)
    died.reset(counters())
    assert died.step(counters(kills=3), episode_end()) == pytest.approx((3 - 100) * 0.01)
    cashed = RewardTracker(r)
    cashed.reset(counters())
    assert cashed.step(counters(), episode_end(victory=True, cashed=True, bonus=419)) == pytest.approx(419 * 0.01)
    lost = RewardTracker(r)           # fainted in overtime: a victory without the bonus, and not a death
    lost.reset(counters())
    assert lost.step(counters(), episode_end(victory=True, cashed=False, bonus=419)) == 0.0
    capped = RewardTracker(r)         # the safety cap on game time ended it: no death either
    capped.reset(counters())
    assert capped.step(counters(), episode_end(terminated=False)) == 0.0


def test_reward_measures_damage_taken_without_paying_for_it():
    t = RewardTracker(default_reward())
    t.reset(counters())
    assert t.step(counters(damageTaken=40.0), None) == 0.0
    assert t.summary()["raw"]["damage_taken"] == 40.0


def test_reward_refuses_unknown_versions_components_and_falling_counters():
    with pytest.raises(ValueError, match="not implemented"):
        RewardConfig(version="v9")
    with pytest.raises(ValueError, match="unknown: \\['style'\\]"):
        RewardConfig(weights={**default_reward().weights, "style": 1.0})
    with pytest.raises(ValueError, match="missing: \\['ko'\\]"):
        RewardConfig(weights={k: v for k, v in default_reward().weights.items() if k != "ko"})
    t = RewardTracker(default_reward())
    t.reset(counters(kills=10))
    with pytest.raises(RuntimeError, match="went down"):
        t.step(counters(kills=9), None)
    with pytest.raises(RuntimeError, match="before reset"):
        RewardTracker(default_reward()).step(counters(), None)


def test_kos_are_the_largest_share_of_the_reward_in_the_stored_complete_runs():
    """The owner's rule (KOs are the biggest contributor), checked on what a complete run really contains: 3 guardians,
    3 portals, the legendary, a cashed bonus, against the KOs of the baseline's complete runs (docs/baseline.md)."""
    w = default_reward().weights
    milestones = 3 * w["guardian"] + 3 * w["zone"] + w["legendary"]
    assert milestones == 2000
    for kos, bonus in [(6566, 141), (7413, 419)]:
        assert kos * w["ko"] > milestones + bonus * w["overtime"]


# ---------------------------------------------------------------- reward v1

def ot(*, live=True, over=False, bonus=0):
    return {"live": live, "over": over, "cashed": False, "lost": False, "round": 1, "bonus": bonus}


def test_reward_v1_keeps_kos_as_the_objective_and_milestones_small():
    r = default_reward("v1")
    w = r.weights
    assert r.version == "v1" and w["ko"] == 1.0 and w["overtime"] == 1.0 and w["overtime_void"] == -1.0
    # A complete run's milestones are worth less than half of v0's, and less than the KOs of any stored complete run.
    milestones = 3 * w["guardian"] + 3 * w["zone"] + w["legendary"]
    assert milestones == 800 < 5463
    t = RewardTracker(r)
    t.reset(counters())
    assert t.step(counters(kills=7), None, None) == pytest.approx(7 * 0.01)
    assert t.step(counters(kills=7, guardiansDefeated=1), None, None) == pytest.approx(100 * 0.01)
    assert t.step(counters(kills=7, guardiansDefeated=1, zonesEntered=2), None, None) == pytest.approx(100 * 0.01)
    assert t.step(counters(kills=7, guardiansDefeated=2, legendariesDefeated=1, zonesEntered=2), None, None) == pytest.approx(200 * 0.01)
    assert t.step(counters(kills=9, guardiansDefeated=2, legendariesDefeated=1, zonesEntered=2), episode_end()) == pytest.approx((2 - 100) * 0.01)
    assert set(t.summary()["components"]) == {"ko", "guardian", "zone", "legendary", "overtime", "overtime_void", "death"}


def test_reward_v1_pays_the_overtime_bonus_as_it_builds_up_and_the_sum_is_what_was_cashed():
    t = RewardTracker(default_reward("v1"))
    t.reset(counters(kills=5000))
    # Before overtime the game reports no overtime, or one that is not live: nothing is paid for it.
    assert t.step(counters(kills=5000), None, None) == 0.0
    assert t.step(counters(kills=5000), None, ot(live=False, bonus=0)) == 0.0
    # Round 1 at ×1.25: 400 KOs carry 100 bonus KOs; round 2 at ×1.5: 200 KOs carry 100 more.
    assert t.step(counters(kills=5400), None, ot(bonus=100)) == pytest.approx((400 + 100) * 0.01)
    assert t.step(counters(kills=5600), None, ot(bonus=200)) == pytest.approx((200 + 100) * 0.01)
    # Cashed at the portal: the end record's bonus is the total; what was not paid yet is paid now.
    end = episode_end(victory=True, cashed=True, bonus=230, started=True, record={"ot": {"k0": 5000, "cashed": True}})
    assert t.step(counters(kills=5650), end, ot(live=False, over=True, bonus=230)) == pytest.approx((50 + 30) * 0.01)
    s = t.summary()
    assert s["raw"]["overtime"] == 230 and s["raw"]["overtime_void"] == 0 and s["raw"]["death"] == 0
    assert s["total"] == pytest.approx((650 + 230) * 0.01)        # the run's KOs since the reset, plus the cashed bonus: what the ranking counts


def test_reward_v1_takes_everything_of_a_lost_overtime_back():
    def play(record, started=True):
        t = RewardTracker(default_reward("v1"))
        t.reset(counters(kills=4000))
        t.step(counters(kills=5000), None, None)                   # 1000 KOs before overtime
        t.step(counters(kills=5400), None, ot(bonus=100))
        t.step(counters(kills=5600), None, ot(bonus=200))
        last = t.step(counters(kills=5610), episode_end(victory=True, cashed=False, bonus=200, started=started, record=record), ot(live=False, over=True, bonus=200))
        return t, last

    # Fainted in overtime: the bonus paid so far is taken back and the KOs made in overtime are voided, by the game's own start figure.
    t, last = play({"ot": {"k0": 5000, "cashed": False}})
    assert last == pytest.approx((10 - 200 - 610) * 0.01)
    s = t.summary()
    assert s["raw"]["overtime"] == 0 and s["raw"]["overtime_void"] == 610 and s["raw"]["death"] == 0
    assert s["total"] == pytest.approx(1000 * 0.01)                # what is left is what was made before overtime
    # Without the game's record the tracker's own figure is used: the run's KOs when overtime was first seen live.
    t, _ = play(None)
    assert t.summary()["raw"]["overtime_void"] == 610 and t.summary()["total"] == pytest.approx(1000 * 0.01)
    # The safety cap on game time is not a lost overtime: what was paid stays.
    capped = RewardTracker(default_reward("v1"))
    capped.reset(counters(kills=4000))
    capped.step(counters(kills=4400), None, ot(bonus=100))
    assert capped.step(counters(kills=4400), episode_end(terminated=False, started=True), ot(bonus=100)) == 0.0
    assert capped.summary()["total"] == pytest.approx(500 * 0.01)


def test_reward_v2_pays_for_each_use_of_the_map_and_stays_small_next_to_kos():
    r = default_reward("v2")
    w = r.weights
    v1 = default_reward("v1").weights
    assert r.version == "v2" and {k: w[k] for k in v1} == v1, "v2 is v1 plus the map-use payment"
    assert w["map_use"] == 10.0 and w["shop_sale"] == -30.0
    assert {k: w[k] for k in v1} == v1 and set(w) - set(v1) == {"map_use", "shop_sale"}
    t = RewardTracker(r)
    t.reset(counters(kills=100, mapUse=3))
    # Three uses in a step (a Poké Ball opened, two slot-machine spins) and 5 KOs.
    assert t.step(counters(kills=105, mapUse=6), None, None) == pytest.approx((5 + 3 * 10) * 0.01)
    assert t.step(counters(kills=105, mapUse=6), None, None) == 0.0
    assert t.step(counters(kills=120, mapUse=7), episode_end(), None) == pytest.approx((15 + 10 - 100) * 0.01)
    s = t.summary()
    assert s["raw"]["map_use"] == 4 and s["raw"]["ko"] == 20 and s["components"]["map_use"] == pytest.approx(0.4)
    assert set(s["components"]) == {"ko", "guardian", "zone", "legendary", "overtime", "overtime_void", "map_use", "shop_sale", "death"}
    # Selling in the shop takes reward away. A sale followed by the two spins its Pokédollars pay for still loses,
    # and so does buying an item and selling it again.
    sale = RewardTracker(r)
    sale.reset(counters())
    assert sale.step(counters(shopSold=1), None, None) == pytest.approx(-30 * 0.01)
    assert sale.step(counters(shopSold=1, mapUse=2), None, None) == pytest.approx(20 * 0.01)
    assert sale.step(counters(shopSold=2, mapUse=3), None, None) == pytest.approx((10 - 30) * 0.01)
    out = sale.summary()
    assert out["raw"]["shop_sale"] == 2 and out["components"]["shop_sale"] == pytest.approx(-0.6) and out["total"] < 0
    assert abs(w["shop_sale"]) > 2 * w["map_use"]
    with pytest.raises(ValueError, match="wrong sign"):
        RewardConfig(version="v2", weights={**w, "shop_sale": 5.0})
    # A zone of the forest has under 90 map points: using every one of them in three zones is worth fewer KOs
    # than the median random run of Mewtwo makes (docs/baseline.md §11).
    assert 3 * 90 * w["map_use"] < 12872
    # The counter is the environment's: one that does not report it cannot be trained with v2.
    old = RewardTracker(r)
    old.reset({k: v for k, v in counters().items() if k != "mapUse"})
    with pytest.raises(RuntimeError, match="needs the counter 'mapUse'"):
        old.step({k: v for k, v in counters(kills=1).items() if k != "mapUse"}, None, None)
    older = RewardTracker(r)
    older.reset({k: v for k, v in counters().items() if k != "shopSold"})
    with pytest.raises(RuntimeError, match="needs the counter 'shopSold'"):
        older.step({k: v for k, v in counters(kills=1).items() if k != "shopSold"}, None, None)
    # v1 does not read it.
    plain = RewardTracker(default_reward("v1"))
    plain.reset({"kills": 0, "guardiansDefeated": 0, "legendariesDefeated": 0, "zonesEntered": 1, "damageTaken": 0.0})
    assert plain.step({"kills": 2, "guardiansDefeated": 0, "legendariesDefeated": 0, "zonesEntered": 1, "damageTaken": 0.0}, None, None) == pytest.approx(0.02)
    with pytest.raises(ValueError, match="wrong sign"):
        RewardConfig(version="v2", weights={**w, "map_use": -1.0})


def test_reward_v4_pays_for_a_map_point_and_for_an_item_added_to_the_collection():
    r = default_reward("v4")
    v3 = default_reward("v3").weights
    assert r.version == "v4" and {k: r.weights[k] for k in v3} == v3 and set(r.weights) - set(v3) == {"point_use", "item"}, "v4 is v3 plus two payments"
    t = RewardTracker(r)
    t.reset(counters(kills=10, itemsPeak=1))
    # A paid Poké Ball is opened: the point is used (map_use as before, and point_use on top), no item yet.
    assert t.step(counters(kills=10, itemsPeak=1, mapUse=1, pointsUsed=1), None, None) == pytest.approx((r.weights["map_use"] + r.weights["point_use"]) * 0.01)
    # Its item is taken: the collection is larger than it ever was.
    assert t.step(counters(kills=10, itemsPeak=2, mapUse=1, pointsUsed=1), None, None) == pytest.approx(r.weights["item"] * 0.01)
    # A slot-machine spin, a shop purchase, a Max form: a use of the map, not a point. Paid as in v3 and no more.
    assert t.step(counters(kills=10, itemsPeak=2, mapUse=2, pointsUsed=1), None, None) == pytest.approx(r.weights["map_use"] * 0.01)
    # Selling an item and buying another does not raise the peak: nothing is paid twice.
    assert t.step(counters(kills=10, itemsPeak=2, mapUse=2, pointsUsed=1), None, None) == 0.0
    s = t.summary()
    assert s["raw"]["point_use"] == 1 and s["raw"]["item"] == 1 and s["raw"]["map_use"] == 2
    # A point must be worth walking to in the first minutes, when there are few KOs; a milestone stays worth more.
    assert r.weights["map_use"] + r.weights["point_use"] >= 50 and r.weights["point_use"] < r.weights["guardian"] and 0 < r.weights["item"] <= -r.weights["shop_sale"]
    # The counters must be there: an environment that does not report them is refused, not paid 0.
    for missing in ("pointsUsed", "itemsPeak"):
        other = RewardTracker(r)
        other.reset(counters())
        with pytest.raises(RuntimeError, match=missing):
            other.step({k: v for k, v in counters(kills=1).items() if k != missing}, None, None)
    with pytest.raises(ValueError, match="wrong sign"):
        RewardConfig(version="v4", weights={**r.weights, "item": -1.0})
    # v3 does not know them: an old run is paid as it always was.
    old = RewardTracker(default_reward("v3"))
    old.reset(counters())
    assert old.step(counters(mapUse=1, pointsUsed=1, itemsPeak=1), None, None) == pytest.approx(0.1) and "point_use" not in old.summary()["raw"]


def test_reward_v6_pays_a_completed_rift_by_how_quickly_it_was_done():
    from pokebonk_rl.reward import RIFT_HALF_SECONDS
    r = default_reward("v6")
    w = r.weights
    v5 = default_reward("v5").weights
    assert r.version == "v6" and {k: w[k] for k in v5} == v5 and set(w) - set(v5) == {"rift"} and w["rift"] > 0

    def visit(seconds, cleared=True, leave=True):
        t = RewardTracker(r)
        t.reset(counters(time=100.0))
        paid = t.step(counters(time=100.05), None, None, False, True)                                   # walks in
        done = counters(time=100.0 + seconds - 0.05, riftsCleared=int(cleared))
        paid += t.step(done, None, None, False, True)                                                    # still inside
        if leave:
            paid += t.step({**done, "time": 100.0 + seconds}, None, None, False, False)                 # back in the zone
        return paid, t.summary()

    # Cleared and left after 30 s: the full weight would be for no time at all, half of it for RIFT_HALF_SECONDS.
    quick, s = visit(30)
    assert quick == pytest.approx(w["rift"] * RIFT_HALF_SECONDS / (RIFT_HALF_SECONDS + 30) * 0.01) and s["raw"]["rift"] == pytest.approx(RIFT_HALF_SECONDS / (RIFT_HALF_SECONDS + 30))
    assert s["raw"]["rifts_completed"] == 1 and s["raw"]["rift_seconds"] == pytest.approx(30)
    half, _ = visit(RIFT_HALF_SECONDS)
    slow, _ = visit(600)
    hour, _ = visit(3600)
    # The quicker, the more; never nothing, never a penalty: a rift has all the time it takes.
    assert quick > half > slow > hour > 0 and half == pytest.approx(w["rift"] / 2 * 0.01)
    # Not completed: left without clearing it, or cleared and still inside when the episode ends. Nothing is paid.
    assert visit(30, cleared=False)[0] == 0.0 and visit(30, leave=False)[0] == 0.0
    # A second rift is timed from its own entrance.
    t = RewardTracker(r)
    t.reset(counters(time=0.0))
    t.step(counters(time=10.0), None, None, False, True)
    first = t.step(counters(time=40.0, riftsCleared=1), None, None, False, False)
    t.step(counters(time=500.0, riftsCleared=1), None, None, False, False)                               # the zone, meanwhile
    t.step(counters(time=500.05, riftsCleared=1), None, None, False, True)
    second = t.step(counters(time=540.0, riftsCleared=2), None, None, False, False)
    assert first > 0 and second == pytest.approx(w["rift"] * RIFT_HALF_SECONDS / (RIFT_HALF_SECONDS + 40) * 0.01)
    # v5 does not know the component.
    old = RewardTracker(default_reward("v5"))
    old.reset(counters(time=0.0))
    old.step(counters(time=1.0), None, None, False, True)
    assert old.step(counters(time=30.0, riftsCleared=1), None, None, False, False) == 0.0 and "rift" not in old.summary()["components"]


# ---------------------------------------------------------------- reward v7 (phase 3: the root of the score)

LIVE = {"live": True, "over": False}


def run_v7(r: RewardConfig, steps):
    """Plays (counters, episode, overtime) triples through a tracker; returns every payment and the summary."""
    t = RewardTracker(r)
    t.reset(counters())
    paid = [t.step(c, e, ot) for c, e, ot in steps]
    return paid, t.summary()


def test_reward_v7_pays_the_change_of_the_root_of_the_score_and_the_payments_add_up():
    import math
    r = default_reward("v7")
    unit = 5 / math.sqrt(20_000_000)
    assert r.version == "v7" and r.scale == 1.0 and r.score_return(20_000_000) == pytest.approx(5.0)
    assert [round(r.score_return(x), 2) for x in (100_000, 1_000_000, 5_000_000)] == [0.35, 1.12, 2.5]
    paid, s = run_v7(r, [
        (counters(kills=100), None, None),
        (counters(kills=100, healed=5000, damageTaken=900.0, level=40), None, None),        # healing, HP, levels: nothing
        (counters(kills=10_000), None, None),
        (counters(kills=10_000), None, {**LIVE, "bonus": 0}),                               # Overtime goes live
        (counters(kills=12_000), None, {**LIVE, "bonus": 4_000}),                           # its bonus builds up
        (counters(kills=12_100), episode_end(victory=True, cashed=True, bonus=4_000, started=True), {"live": False, "over": True, "bonus": 4_000}),
    ])
    assert paid[0] == pytest.approx(unit * 10) and paid[1] == 0.0
    assert paid[4] == pytest.approx(unit * (math.sqrt(16_000) - 100))                       # the KOs and the bonus, as one score
    # The payments add up to the root of the final score, whatever the steps were.
    assert sum(paid) == pytest.approx(unit * math.sqrt(16_100)) == pytest.approx(s["components"]["score"]) and s["total"] == pytest.approx(sum(paid))
    assert s["total"] == pytest.approx(sum(s["components"].values()))
    assert s["raw"]["ko"] == 12_100 and s["raw"]["overtime"] == 4_000 and s["raw"]["damage_taken"] == 900.0
    # In one step or in many: the same sum.
    once, _ = run_v7(r, [(counters(kills=12_100), episode_end(victory=True, cashed=True, bonus=4_000, started=True), None)])
    assert sum(once) == pytest.approx(sum(paid))
    # An early KO is worth more than a late one, and a run of 20 million more than four of 1 million.
    assert r.score_return(1) - r.score_return(0) > 100 * (r.score_return(1_000_001) - r.score_return(1_000_000))
    assert r.score_return(20_000_000) > 4 * r.score_return(1_000_000)
    # KOs made before the reset are not owed.
    t = RewardTracker(r)
    t.reset(counters(kills=400))
    assert t.step(counters(kills=400), None) == 0.0 and t.step(counters(kills=900), None) == pytest.approx(unit * 10)


def test_reward_v7_cashing_beats_fainting_at_the_same_bonus_and_a_lost_bonus_is_taken_back():
    import math
    r = default_reward("v7")
    unit = 5 / math.sqrt(20_000_000)
    before = [(counters(kills=1_000_000), None, {**LIVE, "bonus": 0}), (counters(kills=1_000_000), None, {**LIVE, "bonus": 500_000})]
    cashed, sc = run_v7(r, before + [(counters(kills=1_000_000), episode_end(victory=True, cashed=True, bonus=500_000, started=True), {"live": False, "over": True, "bonus": 500_000})])
    fainted, sf = run_v7(r, before + [(counters(kills=1_000_000), episode_end(victory=True, cashed=False, bonus=500_000, started=True), {**LIVE, "bonus": 500_000})])
    assert sum(cashed) == pytest.approx(unit * math.sqrt(1_500_000)) and sum(fainted) == pytest.approx(unit * 1000)
    assert sum(cashed) > sum(fainted)
    # The last payment of the lost Overtime is the bonus part, negative; the KOs stay paid (the evaluation's score keeps them).
    assert fainted[-1] == pytest.approx(unit * (1000 - math.sqrt(1_500_000))) and fainted[-1] < 0 and cashed[-1] == 0.0
    # One more round and then fainting is worth less than cashing now, however many KOs the round had...
    greedy, _ = run_v7(r, before + [(counters(kills=1_400_000), episode_end(victory=True, cashed=False, bonus=900_000, started=True), {**LIVE, "bonus": 900_000})])
    assert sum(cashed) > sum(greedy)
    # ...and one more round and then cashing is worth more.
    more, _ = run_v7(r, before + [(counters(kills=1_100_000), episode_end(victory=True, cashed=True, bonus=700_000, started=True), {"live": False, "over": True, "bonus": 700_000})])
    assert sum(more) > sum(cashed)
    # Fainting before the map is cleared: the KOs stay paid, and a small penalty on top.
    dead, sd = run_v7(r, [(counters(kills=40_000), episode_end(terminated=True, victory=False), None)])
    assert sd["components"]["death"] == pytest.approx(r.weights["death"] * r.reference_return) and sum(dead) == pytest.approx(unit * 200 + sd["components"]["death"])
    assert sc["components"]["death"] == 0.0 and sf["components"]["death"] == 0.0
    # A run ended by a rule against standing still is invalid and scores 0: everything the score paid is taken back.
    invalid, si = run_v7(r, [(counters(kills=250_000), None, None), (counters(kills=250_000), {**episode_end(terminated=False), "endCause": "idle: no KO for 30 s of game time"}, None)])
    assert sum(invalid) == pytest.approx(0.0, abs=1e-12) and si["components"]["idle"] == pytest.approx(-unit * 500) and si["raw"]["idle"] == 1
    assert score({"kills": 250_000, "overtime": {"cashed": False, "bonus": 0}, "endCause": "idle: no KO for 30 s of game time"}) == 0.0


def test_reward_v7_smaller_terms_keep_the_owners_order_and_stay_under_five_percent_of_a_million_run():
    from pokebonk_rl.reward import V7_GROUPS, V7_TERMS
    r = default_reward("v7")
    ref = r.reference_return
    assert ref == pytest.approx(r.score_return(1_000_000))
    shares = {k: r.terms[k]["share"] for k in V7_TERMS}
    groups = {g: sum(shares[k] for k in ks) for g, ks in V7_GROUPS.items()}
    assert sum(shares.values()) < 0.05 and groups["map"] > groups["earn"] > groups["rest"] > 0
    # A run that does a hundred times what the heuristic does on every count: still under 5 %.
    huge = counters(kills=0, pointsUsed=11_300, mapUse=18_700, itemsPeak=12_800, goldSpent=51_500_000, goldEarned=166_000_000, guardiansDefeated=400, legendariesDefeated=100, zonesEntered=301)
    paid, s = run_v7(r, [(huge, None, None)])
    others = sum(v for k, v in s["components"].items() if k in V7_TERMS)
    assert others == pytest.approx(sum(paid)) and 0.9 * sum(shares.values()) * ref < others < 0.05 * ref
    # What the phase 1 heuristic does in a run on tier 2 (means of seeds 1-30): about half of each cap, in the order.
    typical = counters(kills=0, pointsUsed=113, mapUse=187, itemsPeak=128, goldSpent=515_000, goldEarned=1_660_000, guardiansDefeated=4, legendariesDefeated=1, zonesEntered=4)
    _, s = run_v7(r, [(typical, None, None)])
    c = s["components"]
    by_group = {g: sum(c[k] for k in ks) for g, ks in V7_GROUPS.items()}
    assert by_group["map"] > by_group["earn"] > by_group["rest"] > 0 and 0.02 * ref < sum(by_group.values()) < 0.035 * ref
    assert s["raw"]["guardian"] == 3 and s["raw"]["zone"] == 3 and s["raw"]["legendary"] == 1
    # Each term is paid as it happens and less each time: the first map point more than the 200th, never nothing.
    t = RewardTracker(r)
    t.reset(counters())
    first = t.step(counters(pointsUsed=1, mapUse=1), None)
    t.step(counters(pointsUsed=199, mapUse=199), None)
    late = t.step(counters(pointsUsed=200, mapUse=200), None)
    assert first > late > 0
    # A point (with its use) is worth more than a Pokédollar spent, which is worth more than a Pokédollar earned.
    assert r.term_paid("point_use", 1) + r.term_paid("map_use", 1) > r.term_paid("spend", 1) > r.term_paid("earn", 1) > 0
    # Selling in the shop costs reward, every time, and more than one item pays.
    t = RewardTracker(r)
    t.reset(counters(itemsPeak=5))
    assert r.weights["shop_sale"] < 0 and t.step(counters(itemsPeak=5, shopSold=1), None) == pytest.approx(r.weights["shop_sale"] * ref)
    assert t.step(counters(itemsPeak=5, shopSold=3), None) == pytest.approx(2 * r.weights["shop_sale"] * ref)
    assert -r.weights["shop_sale"] * ref > r.term_paid("item", 1)
    # A rift is counted by how quickly it was done, as in v6.
    t = RewardTracker(r)
    t.reset(counters(time=100.0))
    t.step(counters(time=100.05), None, None, False, True)
    quick = t.step(counters(time=130.0, riftsCleared=1, mapUse=1), None, None, False, False)
    assert t.summary()["raw"]["rift"] == pytest.approx(60 / 90) and quick == pytest.approx(r.term_paid("rift", 60 / 90) + r.term_paid("map_use", 1))


def test_reward_v7_refuses_what_would_break_its_rules_and_v7log_is_the_same_reward_with_the_logarithm():
    import math
    import yaml
    d = yaml.safe_load((REPO / "configs" / "reward-v7.yaml").read_text("utf-8"))
    r = RewardConfig.from_dict(d)
    assert RewardConfig.from_dict(r.to_dict()) == r and r.to_dict()["score"] == {"transform": "sqrt"}
    with pytest.raises(ValueError, match="under 0.05"):
        RewardConfig.from_dict({**d, "terms": {**d["terms"], "earn": {"share": 0.02, "half": 1}}})
    with pytest.raises(ValueError, match="order"):
        RewardConfig.from_dict({**d, "terms": {**d["terms"], "earn": {"share": 0.004, "half": 1}, "guardian": {"share": 0.006, "half": 1}}})
    with pytest.raises(ValueError, match="exactly the terms"):
        RewardConfig.from_dict({**d, "terms": {**d["terms"], "heal": {"share": 0.001, "half": 100}}})
    with pytest.raises(ValueError, match="neither positive"):
        RewardConfig.from_dict({**d, "weights": {"death": -0.005, "shop_sale": 0.0005}})
    with pytest.raises(ValueError, match="transform"):
        RewardConfig.from_dict({**d, "score": {"transform": "log", "knee": 10000}})
    with pytest.raises(ValueError, match="v7's"):
        RewardConfig.from_dict({**yaml.safe_load((REPO / "configs" / "reward-v6.yaml").read_text("utf-8")), "score": {"transform": "sqrt"}})
    log = default_reward("v7log")
    assert log.version == "v7log" and log.terms == r.terms and log.weights == r.weights and log.score == {"transform": "log", "knee": 10000}
    assert log.score_return(20_000_000) == pytest.approx(5.0) and log.score_return(0) == 0.0
    assert log.score_return(1_000_000) == pytest.approx(5 * math.log1p(100) / math.log1p(2000))
    paid, s = run_v7(log, [(counters(kills=30_000), None, None), (counters(kills=900_000), None, {**LIVE, "bonus": 100_000}),
                           (counters(kills=900_000), episode_end(victory=True, cashed=True, bonus=100_000, started=True), None)])
    assert sum(paid) == pytest.approx(log.score_return(1_000_000)) == pytest.approx(s["components"]["score"])
    # The logarithm pays a doubling about the same anywhere; the root pays the top end far more.
    assert log.score_return(2_000_000) - log.score_return(1_000_000) == pytest.approx(log.score_return(20_000_000) - log.score_return(10_000_000), rel=0.02)
    assert r.score_return(20_000_000) - r.score_return(10_000_000) > 3 * (r.score_return(2_000_000) - r.score_return(1_000_000))
    # The smaller terms are the same shares of a 1-million run in both.
    assert log.term_paid("item", 130) / log.reference_return == pytest.approx(r.term_paid("item", 130) / r.reference_return) == pytest.approx(0.0035)


def test_reward_v5_follows_the_owners_order_of_importance():
    """KOs first, then the KOs of staying (final swarms, Overtime), then spending Pokédollars and using the map,
    then earning Pokédollars, then everything else."""
    r = default_reward("v5")
    w = r.weights
    v4 = default_reward("v4").weights
    assert r.version == "v5" and set(w) - set(v4) == {"spend", "earn"} and set(v4) <= set(w)
    # 1 and 2: a KO is a KO wherever it is made, and an Overtime bonus KO is one too: the ranking's own count.
    assert w["ko"] == 1.0 and w["overtime"] == 1.0 and w["overtime_void"] == -1.0
    # 3 before 4: a Pokédollar spent is worth more than a Pokédollar earned, so earning and keeping it never beats spending it.
    assert w["spend"] > w["earn"] > 0
    # 3: a Poké Ball bought (a point used, its price spent, its item taken) is worth more than anything of "the rest".
    ball = w["map_use"] + w["point_use"] + w["item"] + 60 * w["spend"]
    assert ball > max(w["guardian"], w["zone"], w["legendary"])
    # 5: leaving a zone pays less than one more map point in it: nothing pulls the run out of a zone early.
    assert w["guardian"] + w["zone"] <= w["map_use"] + w["point_use"]
    # Over a run that does well on every count (figures of the stored baselines, rounded up), the groups come in order.
    kos = 12000 * w["ko"]
    map_and_spending = 40 * (w["map_use"] + w["point_use"]) + 10 * w["item"] + 4000 * w["spend"]
    earning = 5000 * w["earn"]
    rest = 3 * w["guardian"] + 3 * w["zone"] + w["legendary"]
    assert kos > map_and_spending > earning > rest > 0
    t = RewardTracker(r)
    t.reset(counters(kills=100, goldEarned=500.5, goldSpent=0))
    # 40 Pokédollars picked up, 3 KOs made while the zone's final swarm is on.
    assert t.step(counters(kills=103, goldEarned=540.5), None, None, True) == pytest.approx((3 + 40 * w["earn"]) * 0.01)
    # A Poké Ball bought for 60: the point, the price, and then its item.
    assert t.step(counters(kills=103, goldEarned=540.5, goldSpent=60, mapUse=1, pointsUsed=1), None, None, True) == pytest.approx((w["map_use"] + w["point_use"] + 60 * w["spend"]) * 0.01)
    assert t.step(counters(kills=105, goldEarned=540.5, goldSpent=60, mapUse=1, pointsUsed=1, itemsPeak=1), None, None, False) == pytest.approx((2 + w["item"]) * 0.01)
    s = t.summary()
    assert s["raw"]["spend"] == 60 and s["raw"]["earn"] == pytest.approx(40) and s["raw"]["ko"] == 5
    # Measured, not paid on top: how many of the KOs were made in a final swarm.
    assert s["raw"]["swarm_kos"] == 3 and "swarm_kos" not in s["components"]
    for missing in ("goldSpent", "goldEarned"):
        other = RewardTracker(r)
        other.reset(counters())
        with pytest.raises(RuntimeError, match=missing):
            other.step({k: v for k, v in counters(kills=1).items() if k != missing}, None, None)
    with pytest.raises(ValueError, match="wrong sign"):
        RewardConfig(version="v5", weights={**w, "earn": -1.0})
    # v4 does not know them.
    old = RewardTracker(default_reward("v4"))
    old.reset(counters())
    assert old.step(counters(goldSpent=100, goldEarned=100), None, None) == 0.0 and "spend" not in old.summary()["raw"]


def test_reward_v3_punishes_an_episode_ended_for_standing_still_and_its_score_is_zero():
    from pokebonk_rl.evaluate import score, summarize
    from pokebonk_rl.reward import ended_idle
    r = default_reward("v3")
    v2 = default_reward("v2").weights
    assert r.version == "v3" and {k: r.weights[k] for k in v2} == v2 and set(r.weights) - set(v2) == {"idle"}, "v3 is v2 plus the idle penalty"
    # Standing still must never come out ahead of playing on and fainting.
    assert r.weights["idle"] <= r.weights["death"] < 0
    idle_end = {**episode_end(terminated=False), "truncated": True, "endCause": "idle: no KO and no movement for 30 s of game time"}
    capped = {**episode_end(terminated=False), "truncated": True, "endCause": "truncated: game time reached the cap of 3600 s"}
    assert ended_idle(idle_end) and not ended_idle(capped) and not ended_idle(episode_end())
    t = RewardTracker(r)
    t.reset(counters(kills=100))
    assert t.step(counters(kills=124), None, None) == pytest.approx(24 * 0.01)
    assert t.step(counters(kills=124), idle_end, None) == pytest.approx(-100 * 0.01)
    s = t.summary()
    assert s["raw"]["idle"] == 1 and s["raw"]["death"] == 0 and s["components"]["idle"] == pytest.approx(-1.0) and s["total"] == pytest.approx(-0.76)
    # The safety cap is not standing still, and fainting is not either.
    for end, component in [(capped, None), (episode_end(), "death")]:
        other = RewardTracker(r)
        other.reset(counters())
        other.step(counters(), end, None)
        assert other.summary()["raw"]["idle"] == 0 and (component is None or other.summary()["raw"][component] == 1)
    with pytest.raises(ValueError, match="wrong sign"):
        RewardConfig(version="v3", weights={**r.weights, "idle": 5.0})
    # v2 does not know the component: an old run is paid as it always was.
    old = RewardTracker(default_reward("v2"))
    old.reset(counters())
    assert old.step(counters(kills=3), idle_end, None) == pytest.approx(0.03) and "idle" not in old.summary()["raw"]
    # Evaluation: an invalid run scores 0 whatever it had made, as a stored row and as an episode record.
    row = {"kills": 5000, "overtime_bonus": 0, "overtime_cashed": 0, "game_time": 400.0, "level": 30, "guardians_defeated": 0, "victory": 0, "terminated": 0, "truncated": 1, "zone": 1}
    assert score({**row, "end_cause": "idle: no KO and no movement for 30 s of game time"}) == 0.0
    assert score({**row, "end_cause": "truncated: game time reached the cap of 3600 s"}) == 5000.0
    assert score({"kills": 5000, "overtime": {"bonus": 0, "cashed": False}, "endCause": "idle: no KO and no movement for 30 s of game time"}) == 0.0
    summary = summarize([{**row, "end_cause": "idle: no KO and no movement for 30 s of game time"}, {**row, "end_cause": "died", "terminated": 1, "truncated": 0}])
    assert summary["invalid"] == 1 and summary["score_mean"] == 2500 and summary["kos_mean"] == 5000


def test_a_reference_played_on_other_rules_or_with_other_actions_is_not_comparable():
    from pokebonk_rl.evaluate import incomparable
    mine = {"game_build": "b", "bundle_sha256": "s", "profile_preset": "unlocked-v3", "ranked": 1, "hz": 60, "action_repeat": 3, "action_schema": 2, "decision_schema": 2, "label": "x"}
    assert incomparable(mine, {**mine, "label": "another batch"}) == []
    # The baselines stored before the map features were playable (action and decision schema 1).
    assert incomparable(mine, {**mine, "action_schema": 1, "decision_schema": 1}) == ["action_schema", "decision_schema"]
    assert incomparable(mine, {**mine, "hz": 30, "game_build": "c"}) == ["game_build", "hz"]


def test_reward_weights_must_have_the_sign_of_their_component():
    w = default_reward("v1").weights
    with pytest.raises(ValueError, match="wrong sign"):
        RewardConfig(version="v1", weights={**w, "overtime_void": 1.0})
    with pytest.raises(ValueError, match="wrong sign"):
        RewardConfig(version="v1", weights={**w, "guardian": -5.0})
    with pytest.raises(ValueError, match="unknown: \\['overtime_void'\\]"):
        RewardConfig(version="v0", weights=w)
    RewardConfig(version="v1", weights={**w, "overtime_void": 0.0, "guardian": 0.0})      # zero is allowed: a component can be switched off


# ---------------------------------------------------------------- configuration

def test_configuration_files_load_and_unknown_keys_are_errors(tmp_path):
    training = cfg.load(REPO / "configs" / "training.yaml", cfg.TRAINING_DEFAULTS)
    assert training["reward"]["version"] == "v6" and training["env"]["action_repeat"] == 3 and training["device"] == "cpu"
    assert training["scenarios"]["species"] == [150]
    assert cfg.env_options(training)["maxIdleGameTime"] == 30 == cfg.env_options(cfg.load(REPO / "configs" / "evaluation.yaml", cfg.EVALUATION_DEFAULTS))["maxIdleGameTime"]
    # A run created before the rule existed has no such key in its stored configuration: it is resumed without it.
    assert cfg.env_options({"env": {k: v for k, v in training["env"].items() if k != "max_idle_game_time"}})["maxIdleGameTime"] == 0
    # The rule against going without a KO: on in both files, off for a run stored before it existed.
    assert cfg.env_options(training)["maxKoGapGameTime"] == 30
    assert cfg.env_options({"env": {k: v for k, v in training["env"].items() if k != "max_ko_gap_game_time"}})["maxKoGapGameTime"] == 0
    evaluation = cfg.load(REPO / "configs" / "evaluation.yaml", cfg.EVALUATION_DEFAULTS, ["workers.envs=2", "seeds=4-6"])
    assert cfg.env_options(evaluation)["maxKoGapGameTime"] == 30
    # The opening's grace for that rule: none in these two files and in a stored configuration without the key; 90 s
    # for the manager, in training and in evaluation alike.
    assert cfg.env_options(training)["koGapGraceGameTime"] == 0 == cfg.env_options(evaluation)["koGapGraceGameTime"]
    assert cfg.env_options({"env": {k: v for k, v in training["env"].items() if k != "ko_gap_grace_game_time"}})["koGapGraceGameTime"] == 0
    for name, defaults in (("manager.yaml", cfg.TRAINING_DEFAULTS), ("manager-evaluation.yaml", cfg.EVALUATION_DEFAULTS)):
        loaded = cfg.load(REPO / "configs" / name, defaults)
        options = cfg.env_options(loaded)
        assert (options["maxKoGapGameTime"], options["koGapGraceGameTime"]) == (30, 90)
        # The manager is trained and evaluated under reward v7 (phase 3), in the learner's own unit.
        assert loaded["reward"]["version"] == "v7" and RewardConfig.from_dict(loaded["reward"]).score_return(20_000_000) == pytest.approx(5.0)
    assert cfg.load(REPO / "configs" / "manager.yaml", cfg.TRAINING_DEFAULTS)["normalize_reward"] is False
    # The promotion metric the owner agreed for the manager (2026-11-26): p90 at least the heuristic's, with a floor
    # of 90 % under the median, on the 50 held-out seeds.
    rule = cfg.load(REPO / "configs" / "manager-evaluation.yaml", cfg.EVALUATION_DEFAULTS)["promotion"]
    assert (rule["metric"], rule["min_ratio"], rule["floors"]) == ("score_p90", 1.0, {"score_median": 0.9})
    assert rule["first_reference"] == "heldout-tier2-mewtwo-h2p3-balanced-fresh" and len(cfg.parse_seeds(rule["seeds"])) == 50
    assert evaluation["workers"]["envs"] == 2 and cfg.parse_seeds(evaluation["seeds"]) == [4, 5, 6]
    assert evaluation["scenario"]["species"] == 150 and evaluation["reward"]["version"] == "v6" and len(cfg.parse_seeds(evaluation["promotion"]["seeds"])) == 50
    # The files spell out every default: a default changed in code without the file (or the reverse) shows here.
    for path, defaults in [("training.yaml", cfg.TRAINING_DEFAULTS), ("evaluation.yaml", cfg.EVALUATION_DEFAULTS)]:
        loaded = cfg.load(REPO / "configs" / path, defaults)
        loaded.pop("reward")
        assert loaded == defaults, path
    bad = tmp_path / "bad.yaml"
    bad.write_text("ppo:\n  learning_rat: 1\n", "utf-8")
    with pytest.raises(KeyError, match="ppo.learning_rat"):
        cfg.load(bad, cfg.TRAINING_DEFAULTS)
    with pytest.raises(KeyError, match="workers.nope"):
        cfg.load(None, cfg.TRAINING_DEFAULTS, ["workers.nope=1"])


def test_seed_lists():
    assert cfg.parse_seeds("1-3,9") == [1, 2, 3, 9]
    assert cfg.parse_seeds([5, 6]) == [5, 6]
    for bad in ["", "1,1", "3-1"]:
        with pytest.raises(ValueError):
            cfg.parse_seeds(bad)


def test_scenarios_depend_only_on_the_episode_number():
    a, b = Scenarios([1, 4, 7, 25], ["forest", "coast"], [0, 1], seed=3), Scenarios([1, 4, 7, 25], ["forest", "coast"], [0, 1], seed=3)
    picks = [a.pick(k) for k in range(200)]
    assert picks == [b.pick(k) for k in range(200)]
    assert {p["species"] for p in picks} == {1, 4, 7, 25} and {p["map"] for p in picks} == {"forest", "coast"} and {p["tier"] for p in picks} == {0, 1}
    assert picks != [Scenarios([1, 4, 7, 25], ["forest", "coast"], [0, 1], seed=4).pick(k) for k in range(200)]


# ---------------------------------------------------------------- offline rule

def test_offline_rule_refuses_remote_endpoints_in_a_configuration():
    offline.check_config({"paths": {"database": "data/x.sqlite"}, "seeds": "1-3", "file": "file:///C:/x"})
    for bad in [{"game": {"endpoint": "example.org"}}, {"a": ["https://example.org/api"]}, {"inference": {"api_key": "k"}}, {"x": "wss://example.org"}]:
        with pytest.raises(offline.OfflineViolation):
            offline.check_config(bad)
    # An unset endpoint key is not a violation.
    offline.check_config({"endpoint": None})


def test_network_guard_blocks_everything_but_loopback():
    """Runs in a child process: the guard replaces socket functions for good."""
    code = r"""
import socket, sys
from pokebonk_rl import offline
offline.install_network_guard()
results = []
def attempt(name, fn):
    try:
        fn(); results.append(name + ":allowed")
    except offline.OfflineViolation:
        results.append(name + ":refused")
    except OSError:
        results.append(name + ":allowed")       # it got past the guard and failed in the operating system
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM); s.settimeout(0.5)
attempt("connect-remote", lambda: s.connect(("192.0.2.1", 80)))
attempt("connect_ex-remote", lambda: s.connect_ex(("192.0.2.1", 80)))
attempt("create-remote", lambda: socket.create_connection(("192.0.2.1", 80), timeout=0.5))
attempt("lookup-remote", lambda: socket.getaddrinfo("example.org", 80))
u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
attempt("sendto-remote", lambda: u.sendto(b"x", ("192.0.2.1", 9)))
server = socket.socket(); server.bind(("127.0.0.1", 0)); server.listen(1)
c = socket.socket(); attempt("connect-loopback", lambda: c.connect(server.getsockname()))
attempt("lookup-loopback", lambda: socket.getaddrinfo("localhost", 80))
print(";".join(results)); print(len(offline.blocked))
"""
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    lines = out.stdout.strip().splitlines()
    assert lines[0] == ("connect-remote:refused;connect_ex-remote:refused;create-remote:refused;lookup-remote:refused;sendto-remote:refused;"
                        "connect-loopback:allowed;lookup-loopback:allowed")
    assert lines[1] == "5"


def test_training_and_evaluation_install_the_guard_before_anything_else():
    for module in ("train", "evaluate"):
        source = (REPO / "python" / "pokebonk_rl" / f"{module}.py").read_text("utf-8")
        body = source[source.index("def main("):]
        assert "offline.install_network_guard()" in body and "offline.check_config(config)" in body
        # Nothing that could open a connection is imported before the guard is in place.
        assert body.index("offline.install_network_guard()") < body.index("import MaskablePPO")
        head = source[:source.index("def main(")] if module == "evaluate" else source[:source.index("def build_model(")]
        assert "import torch" not in head and "stable_baselines3" not in head and "sb3_contrib" not in head


# ---------------------------------------------------------------- storage

def episode_record(seed: int, kills: int = 10) -> dict:
    return {
        "seed": seed, "species": 155, "finalSpecies": 156, "map": "forest", "tier": 0, "ranked": True, "terminated": True, "truncated": False, "endCause": "died", "endHow": "died",
        "victory": False, "gameTime": 12.5, "kills": kills, "overtime": {"started": False, "bonus": 0, "rounds": 0, "cashed": False}, "level": 4, "zone": 1, "guardiansDefeated": 0,
        "legendariesDefeated": 0, "sealsKept": 0, "steps": 250, "simSteps": 750, "wallSeconds": 1.5, "resetSeconds": 2.5, "finalBuild": {"species": 156}, "counters": {"kills": kills},
        "record": {"kills": kills, "name": "Pokémon"}, "blockedNetwork": [], "decisionCount": 3,
        "decisions": [{"serial": 1, "step": 40, "gameTime": 2.0, "zone": 1, "level": 2, "kind": "levelup", "method": "showLevelUp", "options": [{"id": "a", "label": "A", "data": {}}],
                       "context": {}, "mask": {"phase": "choice", "options": [True], "extras": {}}, "chosen": {"type": "choice", "option": 0}, "chosenId": "a"}],
        "worker": {"id": 0, "pid": 1234, "episode": 1, "rssMB": 400}, "startedAt": "2026-11-24T00:00:00.000Z", "finishedAt": "2026-11-24T00:00:02.000Z",
    }


def new_batch(store: Store, label: str = "test") -> int:
    return store.create_batch(label=label, policy_name="ppo", policy_version="x", config={"species": 155, "map": "forest", "tier": 0}, hz=60, action_repeat=3, reward_version="v0", episodes_planned=1)


def test_store_applies_the_shared_migrations_and_writes_what_the_node_reports_read(tmp_path):
    path = tmp_path / "db.sqlite"
    store = Store(path)
    migrations = sorted((REPO / "src" / "storage" / "migrations").glob("*.sql"))
    assert store.schema_version() == len(migrations) >= 2
    batch = new_batch(store, "python-written")
    reward = {"version": "v0", "total": -0.9, "components": {"ko": 0.1, "death": -1.0}, "raw": {"ko": 10, "death": 1}}
    episode_id = store.insert_episode(batch, episode_record(5), worker_id=2, reward=reward, timesteps=77)
    store.insert_error(batch, kind="episode-error", message="boom", details={"x": 1}, seed=6, worker_id=2)
    store.finish_batch(batch, "completed", 3.0)
    row = store.episodes(batch)[0]
    assert row["seed"] == 5 and row["decision_count"] == 3 and row["worker_id"] == 2 and json.loads(row["record_json"])["name"] == "Pokémon"
    assert store.db.execute("SELECT COUNT(*) FROM decisions WHERE episode_id = ?", (episode_id,)).fetchone()[0] == 1
    r = store.db.execute("SELECT * FROM episode_rewards WHERE episode_id = ?", (episode_id,)).fetchone()
    assert r["total"] == -0.9 and r["timesteps"] == 77 and json.loads(r["components_json"])["death"] == -1.0
    b = store.batch(batch)
    assert b["status"] == "completed" and b["episodes_done"] == 1 and b["error_count"] == 1
    # Constraints of the schema hold from Python too: a seed is played once per batch, and an episode needs its batch.
    with pytest.raises(Exception, match="UNIQUE"):
        store.insert_episode(batch, episode_record(5))
    assert len(store.episodes(batch)) == 1                               # … and the failed insert left nothing behind
    with pytest.raises(Exception, match="FOREIGN KEY"):
        store.insert_episode(9999, episode_record(8))
    store.close()
    # Reopening migrates nothing; the Node side reads the same file with its own code.
    again = Store(path)
    assert again.db.execute("SELECT COUNT(*) FROM schema_version").fetchone()[0] == len(migrations)
    again.close()
    node = subprocess.run(["node", "scripts/baseline-report.ts", f"--db={path}", "--label=python-written"], cwd=REPO, capture_output=True, text=True, timeout=120)
    assert node.returncode == 0, node.stderr
    assert 'batch 1 "python-written"' in node.stdout and "1/1 episodes, 1 error(s)" in node.stdout and "KOs            mean 10" in node.stdout


def test_store_refuses_a_database_written_by_newer_code(tmp_path):
    path = tmp_path / "db.sqlite"
    store = Store(path)
    store.db.execute("INSERT INTO schema_version (version, name, applied_at) VALUES (99, 'future', 'x')")
    store.close()
    with pytest.raises(RuntimeError, match="newer code"):
        Store(path)


# ---------------------------------------------------------------- checkpoints and registry

class FakeModel:
    """Stands in for the learner where only "a file is written" matters."""

    def __init__(self, content: bytes):
        self.content = content

    def save(self, path: str) -> None:
        Path(path).write_bytes(self.content)


def make_checkpoint(folder: Path, timesteps: int, content: bytes, run: str = "r") -> Path:
    path, _ = save_checkpoint(folder, model=FakeModel(content), vecnormalize=None, timesteps=timesteps, state={"run": run, "kind": "periodic", "episodes_started": 3})
    return path


def test_checkpoints_are_complete_or_absent_and_never_overwritten(tmp_path):
    folder = tmp_path / "checkpoints"
    first = make_checkpoint(folder, 100, b"one")
    state = read_checkpoint(first)
    assert state["timesteps"] == 100 and state["model_sha256"] == sha256_file(first / "model.zip") and state["episodes_started"] == 3
    with pytest.raises(FileExistsError):
        make_checkpoint(folder, 100, b"other")
    assert (first / "model.zip").read_bytes() == b"one"
    second = make_checkpoint(folder, 200, b"two")
    # A crash while writing leaves a .partial folder, which is not a checkpoint; a folder without state.json is none either.
    (folder / "ckpt_000000000300.partial").mkdir()
    (folder / "ckpt_000000000300.partial" / "model.zip").write_bytes(b"half")
    (folder / "ckpt_000000000400").mkdir()
    (folder / "ckpt_000000000400" / "model.zip").write_bytes(b"no state")
    assert list_checkpoints(folder) == [first, second] and latest_checkpoint(folder) == second
    # A damaged newest checkpoint is detected and the one before it is used.
    (second / "model.zip").write_bytes(b"corrupted")
    with pytest.raises(ValueError, match="damaged"):
        read_checkpoint(second)
    assert latest_checkpoint(folder) == first
    # The .partial of a crashed attempt does not block the next attempt at the same step.
    third = make_checkpoint(folder, 300, b"three")
    assert read_checkpoint(third)["timesteps"] == 300 and not (folder / "ckpt_000000000300.partial").exists()


def tree(folder: Path) -> dict[str, str]:
    return {str(p.relative_to(folder)): sha256_file(p) for p in sorted(folder.rglob("*")) if p.is_file()}


def judge(store: Store, sha: str, passed: bool | None) -> int:
    batch = new_batch(store, "eval")
    return store.insert_evaluation(batch_id=batch, model_path="x", model_sha256=sha, run_id=None, timesteps=1, deterministic=True, seeds=[1], scenario={"species": 155, "map": "forest", "tier": 0},
                                   summary={}, reference="test", comparison={}, passed=passed)


def test_promotion_needs_a_passed_evaluation_and_never_touches_an_earlier_stable_model(tmp_path):
    store, models = Store(tmp_path / "db.sqlite"), tmp_path / "models"
    a = make_checkpoint(tmp_path / "ckpts", 100, b"model A")
    b = make_checkpoint(tmp_path / "ckpts", 200, b"model B")
    sha_a, sha_b = sha256_file(a / "model.zip"), sha256_file(b / "model.zip")
    cand_a = register_candidate(store, models, a, note="first")
    assert current_stable(store) is None

    # No evaluation, an unjudged one, a failed one: no promotion, and nothing appears under models/stable.
    with pytest.raises(RegistryError, match="no passed evaluation"):
        promote(store, models, cand_a)
    judge(store, sha_a, None)
    with pytest.raises(RegistryError, match="no passed evaluation"):
        promote(store, models, cand_a)
    judge(store, sha_a, False)
    with pytest.raises(RegistryError, match="no passed evaluation"):
        promote(store, models, cand_a)
    assert not (models / "stable").exists()

    passed_a = judge(store, sha_a, True)
    stable_a = promote(store, models, cand_a)
    row_a = current_stable(store)
    assert row_a["id"] == stable_a and row_a["sha256"] == sha_a and row_a["evaluation_id"] == passed_a
    pointer = json.loads((models / "stable" / "current.json").read_text("utf-8"))
    assert pointer["model_id"] == stable_a and pointer["sha256"] == sha_a and Path(pointer["path"]) == Path(row_a["path"])
    before = tree(Path(row_a["path"]))
    assert before["model.zip"] == sha_a

    # A later failed evaluation of B, then a passed one followed by a failed one: B stays out, A stays stable and untouched.
    cand_b = register_candidate(store, models, b)
    judge(store, sha_b, True)
    judge(store, sha_b, False)
    with pytest.raises(RegistryError, match="no passed evaluation"):
        promote(store, models, cand_b)
    assert current_stable(store)["id"] == stable_a and json.loads((models / "stable" / "current.json").read_text("utf-8")) == pointer
    assert tree(Path(row_a["path"])) == before

    # B passes: it becomes stable in its own folder; A's folder is byte for byte what it was and A is retired, not deleted.
    judge(store, sha_b, True)
    stable_b = promote(store, models, cand_b)
    assert current_stable(store)["id"] == stable_b
    assert tree(Path(row_a["path"])) == before
    assert store.db.execute("SELECT role FROM models WHERE id = ?", (stable_a,)).fetchone()["role"] == "retired"
    assert json.loads((models / "stable" / "current.json").read_text("utf-8"))["previous_stable_id"] == stable_a
    assert len([p for p in (models / "stable").iterdir() if p.is_dir()]) == 2

    # A candidate whose file was changed after registration is refused, and so is promoting something that is not a candidate.
    with pytest.raises(RegistryError, match="not a candidate"):
        promote(store, models, stable_b)
    c = make_checkpoint(tmp_path / "ckpts", 300, b"model C")
    cand_c = register_candidate(store, models, c)
    judge(store, sha256_file(c / "model.zip"), True)
    cand_c_path = Path(store.db.execute("SELECT path FROM models WHERE id = ?", (cand_c,)).fetchone()["path"])
    (cand_c_path / "model.zip").write_bytes(b"tampered")
    with pytest.raises(ValueError, match="damaged"):
        promote(store, models, cand_c)
    assert current_stable(store)["id"] == stable_b

    # Rollback: A is stable again, B retired, both folders intact.
    with pytest.raises(RegistryError, match="not a retired"):
        rollback(store, models, cand_a)
    rollback(store, models, stable_a, note="B regressed")
    assert current_stable(store)["id"] == stable_a
    assert json.loads((models / "stable" / "current.json").read_text("utf-8"))["model_id"] == stable_a
    assert tree(Path(row_a["path"])) == before and (Path(store.db.execute("SELECT path FROM models WHERE id = ?", (stable_b,)).fetchone()["path"]) / "model.zip").read_bytes() == b"model B"
    actions = [r["action"] for r in store.db.execute("SELECT action FROM model_events ORDER BY id")]
    assert actions == ["register", "promote", "register", "promote", "register", "rollback"]
    store.close()


def test_registry_command_line_needs_yes_to_change_the_stable_model(tmp_path):
    store, models = Store(tmp_path / "db.sqlite"), tmp_path / "models"
    a = make_checkpoint(tmp_path / "ckpts", 100, b"model A")
    cand = register_candidate(store, models, a)
    judge(store, sha256_file(a / "model.zip"), True)
    store.close()
    base = [sys.executable, "-m", "pokebonk_rl.registry", "--database", str(tmp_path / "db.sqlite"), "--models", str(models)]
    no = subprocess.run(base + ["promote", "--candidate", str(cand)], capture_output=True, text=True, timeout=120)
    assert no.returncode == 2 and "--yes" in no.stderr and not (models / "stable").exists()
    yes = subprocess.run(base + ["promote", "--candidate", str(cand), "--yes"], capture_output=True, text=True, timeout=120)
    assert yes.returncode == 0, yes.stderr
    listing = subprocess.run(base + ["list"], capture_output=True, text=True, timeout=120)
    assert "stable" in listing.stdout and "candidate" in listing.stdout and "passed evaluation" in listing.stdout


# ---------------------------------------------------------------- evaluation arithmetic

def stored(seed, kills, bonus=0, cashed=0, victory=0, zone=1):
    return {"seed": seed, "kills": kills, "overtime_bonus": bonus, "overtime_cashed": cashed, "victory": victory, "terminated": 1, "truncated": 0, "zone": zone, "game_time": 100.0,
            "level": 10, "guardians_defeated": zone - 1}


def test_score_counts_the_overtime_bonus_only_when_cashed():
    assert score(stored(1, 100, bonus=50, cashed=1)) == 150 and score(stored(1, 100, bonus=50, cashed=0)) == 100
    assert score({"kills": 100, "overtime": {"bonus": 50, "cashed": True}}) == 150


def test_comparison_is_seed_by_seed_and_the_rule_is_applied_as_configured():
    mine = [stored(1, 100), stored(2, 300), stored(3, 700, bonus=100, cashed=1, victory=1, zone=4)]
    ref = [stored(1, 150), stored(2, 250), stored(3, 400), stored(4, 99999)]
    c = compare(mine, ref, "score_median", 1.0)
    assert c["seeds_compared"] == 3 and c["model"]["score_median"] == 300 and c["reference"]["score_median"] == 250      # seed 4 is not part of it
    assert c["ratio"] == pytest.approx(1.2) and c["passed"] is True and c["per_seed_by_score"] == {"wins": 2, "losses": 1, "ties": 0}
    assert compare(mine, ref, "score_median", 1.25)["passed"] is False
    assert compare(mine, ref, "kos_mean", 1.0)["ratio"] == pytest.approx((1100 / 3) / (800 / 3))
    # A reference that did not play every evaluated seed cannot pass anything.
    partial = compare(mine, ref[:2], "score_median", 0.1)
    assert partial["passed"] is False and partial["seeds_missing_in_reference"] == [3]
    with pytest.raises(KeyError, match="unknown promotion metric"):
        compare(mine, ref, "style", 1.0)
    # The top of the distribution with a floor under its middle (phase 3): both must hold.
    from pokebonk_rl.evaluate import percentile
    assert percentile([1, 2, 3, 4, 5], 0.9) == pytest.approx(4.6) and percentile([7], 0.9) == 7 and percentile(list(range(1, 31)), 0.9) == pytest.approx(27.1)
    top = compare(mine, ref, "score_p90", 1.0, {"score_median": 0.9})
    assert top["model"]["score_p90"] == pytest.approx(700) and top["reference"]["score_p90"] == pytest.approx(370) and top["model"]["score_max"] == 800
    assert top["passed"] is True and top["floors"]["score_median"] == {"ratio": pytest.approx(1.2), "needed": 0.9, "held": True}
    under = compare(mine, ref, "score_p90", 1.0, {"score_median": 1.3})
    assert under["passed"] is False and under["ratio"] > 1 and under["floors"]["score_median"]["held"] is False
    with pytest.raises(KeyError, match="unknown promotion metric"):
        compare(mine, ref, "score_p90", 1.0, {"style": 1.0})
    s = summarize(mine)
    assert s["completed"] == 1 and s["died"] == 2 and s["zones"] == {"1": 2, "4": 1} and s["overtime_cashed"] == 1


# ---------------------------------------------------------------- layouts and the network's input side

def random_observation(layouts, batch: int, rng):
    import torch
    spec = layouts.extractor_spec()
    f = rng.standard_normal((batch, layouts.float_size)).astype(np.float32)
    i = np.zeros((batch, layouts.int_size), np.int32)
    for s in spec["int"]:
        for j, vocab in enumerate(s["vocabs"]):
            cols = [s["offset"] + r * s["cols"] + j for r in range(s["rows"])]
            i[:, cols] = rng.integers(0, spec["vocab_sizes"][vocab], (batch, len(cols)))
    for s in spec["float"]:
        if s["present"]:
            for r in range(s["rows"]):
                f[:, s["offset"] + r * s["cols"]] = (rng.random(batch) < 0.6).astype(np.float32)
    return {"float": torch.from_numpy(f), "int": torch.from_numpy(i).float()}, spec


def test_layout_files_describe_the_buffers_the_trainer_slices():
    layouts = load_layouts(BUILD)
    spec = layouts.extractor_spec()
    assert layouts.nvec == [9, 2, 2, 2, 2, 2, 2, 2, 89] and layouts.mask_size == 112
    # Segments tile each buffer exactly: no gap, no overlap.
    for key, size in (("float", layouts.float_size), ("int", layouts.int_size)):
        at = 0
        for s in sorted(spec[key], key=lambda s: s["offset"]):
            assert s["offset"] == at, s["name"]
            at += s["rows"] * s["cols"]
        assert at == size
    assert all(n >= 2 for n in spec["vocab_sizes"].values()) and spec["vocab_sizes"]["entity"] == layouts.vocab_sizes["entity"]
    with pytest.raises(FileNotFoundError, match="export:encoding"):
        load_layouts("no-such-build")


def test_feature_extractor_reads_every_segment_and_ignores_rows_that_are_not_present():
    import torch
    from gymnasium import spaces
    from pokebonk_rl.features import ORDERED, POOLED, SetsExtractor
    layouts = load_layouts(BUILD)
    rng = np.random.default_rng(0)
    obs, spec = random_observation(layouts, 4, rng)
    space = spaces.Dict({"float": spaces.Box(-np.inf, np.inf, (layouts.float_size,), np.float32), "int": spaces.Box(0, 2000, (layouts.int_size,), np.int32)})
    torch.manual_seed(0)
    net = SetsExtractor(space, spec, features_dim=64).eval()
    assert {s["name"] for s in spec["float"] if s["rows"] > 1} == set(POOLED) | set(ORDERED)       # every list of the layout has a rule
    with torch.no_grad():
        base = net(obs)
        assert base.shape == (4, 64) and torch.isfinite(base).all()
        for s in spec["float"]:
            changed = {k: v.clone() for k, v in obs.items()}
            if s["rows"] == 1:
                changed["float"][:, s["offset"]: s["offset"] + s["cols"]] += 1.0
                assert not torch.allclose(net(changed), base), f"fixed vector {s['name']} has no influence"
                continue
            block = changed["float"][:, s["offset"]: s["offset"] + s["rows"] * s["cols"]].reshape(4, s["rows"], s["cols"])
            absent = block[:, :, 0] == 0
            # What an absent row contains must not matter…
            block[:, :, 1:][absent] += 5.0
            assert torch.allclose(net(changed), base, atol=1e-6), f"absent rows of {s['name']} leak into the features"
            # … what a present row contains must.
            block[:, :, 1:][~absent] += 5.0
            assert not torch.allclose(net(changed), base), f"present rows of {s['name']} have no influence"
        for s in spec["int"]:
            changed = {k: v.clone() for k, v in obs.items()}
            block = changed["int"][:, s["offset"]: s["offset"] + s["rows"] * s["cols"]]
            block[:] = torch.where(block > 1, block - 1, block + 1)
            assert not torch.allclose(net(changed), base), f"category ids of {s['name']} have no influence"
    with pytest.raises(ValueError, match="sizes of the layout"):
        SetsExtractor(spaces.Dict({"float": spaces.Box(-1, 1, (10,), np.float32), "int": space["int"]}), spec)


# ---------------------------------------------------------------- the manager (phase 2)

def manager_layouts():
    from pokebonk_rl.manager import load_manager_layouts
    return load_manager_layouts(BUILD)


def test_manager_layouts_accept_what_only_grew_at_the_end_and_refuse_everything_else():
    import copy
    L = manager_layouts()
    assert L.n_actions == L.mask_size == len(L.action["names"]) and L.float_size > 0 and L.int_size > 0
    assert L.observation["action"]["hash"] == L.action_hash
    # An embedding has a row for every id the registry can ever give, so appended keys need no new rows.
    assert L.vocab_sizes["item"] == L.registry["tables"]["item"]["capacity"] + 1 > len(L.registry["tables"]["item"]["keys"]) + 1
    trained = L.identity()
    assert L.accepts(trained) == []
    # A later game build appended an item to the registry (within its capacity): the model is still valid.
    grown = copy.deepcopy(L.registry)
    grown["tables"]["item"]["keys"].append("brand-new-item")
    later = type(L)(build=L.build, observation=L.observation, action=L.action, registry=grown)
    assert later.accepts(trained) == []
    # …but not when an id changed its meaning, a capacity changed, the shape changed, or the action table is another.
    moved = copy.deepcopy(L.registry)
    moved["tables"]["item"]["keys"][0], moved["tables"]["item"]["keys"][1] = moved["tables"]["item"]["keys"][1], moved["tables"]["item"]["keys"][0]
    assert any("item" in w for w in type(L)(build=L.build, observation=L.observation, action=L.action, registry=moved).accepts(trained))
    wider = copy.deepcopy(L.registry)
    wider["tables"]["item"]["capacity"] += 8
    assert any("item" in w for w in type(L)(build=L.build, observation=L.observation, action=L.action, registry=wider).accepts(trained))
    assert any("shape" in w for w in type(L)(build=L.build, observation={**L.observation, "compat": "0" * 64}, action=L.action, registry=L.registry).accepts(trained))
    renamed = {**L.action, "names": ["other"] + list(L.action["names"][1:])}
    assert any("action table" in w for w in type(L)(build=L.build, observation=L.observation, action=renamed, registry=L.registry).accepts(trained))
    longer = {**L.action, "names": list(L.action["names"]) + ["use:new-kind"], "size": L.n_actions + 1}
    assert any("action table" in w for w in type(L)(build=L.build, observation=L.observation, action=longer, registry=L.registry).accepts(trained)), "a longer table needs a model of that size"
    assert L.accepts({}) != []


def test_manager_configuration_names_the_mode_the_plan_and_the_archive():
    config = cfg.load(REPO / "configs" / "manager.yaml", cfg.TRAINING_DEFAULTS)
    assert cfg.manager_options(config) == {"sliceSeconds": 1.0, "endOnProposalChange": True, "fuseNeeds": "tm-case"}
    assert cfg.env_options(config, species=150, map="forest", tier=2)["archive"] == "balanced"
    assert config["network"] == {"architecture": "manager-v1", "features_dim": 512, "pi": [], "vf": [256]}
    # The low-level configuration stays what it was: no manager, no archive.
    low = cfg.load(REPO / "configs" / "training.yaml", cfg.TRAINING_DEFAULTS)
    assert cfg.manager_options(low) is None and "archive" not in cfg.env_options(low)
    with_plan = cfg.load(REPO / "configs" / "manager.yaml", cfg.TRAINING_DEFAULTS, ['manager.plan={"base": "plan-2"}'])
    assert cfg.manager_options(with_plan)["plan"] == {"base": "plan-2"}
    with pytest.raises(KeyError):
        cfg.load(REPO / "configs" / "manager.yaml", cfg.TRAINING_DEFAULTS, ["manager.slice=2"])


def test_discount_by_game_time_matches_the_formula_and_ordinary_gae_when_every_step_lasts_a_second():
    import torch
    from gymnasium import spaces
    from pokebonk_rl.manager import gamma_per_second
    from pokebonk_rl.manager_net import TimeDiscountBuffer

    assert gamma_per_second(1000) == pytest.approx(0.9990005, abs=1e-7) and gamma_per_second(1000) ** 1000 == pytest.approx(1 / 2.718281828, rel=1e-6)
    with pytest.raises(ValueError):
        gamma_per_second(0)
    space = spaces.Dict({"float": spaces.Box(-1, 1, (3,), np.float32), "int": spaces.Box(0, 5, (2,), np.int32)})

    class Source:
        last_dt = np.zeros(1, np.float32)

    def run(dts, rewards, values, last_value, gamma=0.9, lam=0.8, starts=None):
        buf = TimeDiscountBuffer(len(dts), space, spaces.Discrete(4), device="cpu", gamma=gamma, gae_lambda=lam, n_envs=1)
        buf.dt_source = Source()
        obs = {"float": np.zeros((1, 3), np.float32), "int": np.zeros((1, 2), np.int32)}
        for k, (dt, r, v) in enumerate(zip(dts, rewards, values)):
            Source.last_dt = np.array([dt], np.float32)
            buf.add(obs, np.array([[0]]), np.array([r], np.float32), np.array([float(starts[k]) if starts else 0.0]), torch.tensor([v]), torch.tensor([0.0]), action_masks=np.ones((1, 4), bool))
        buf.compute_returns_and_advantage(torch.tensor([last_value]), np.array([False]))
        return buf.advantages[:, 0].copy(), buf.returns[:, 0].copy()

    # By hand: a dialog answer (no time), a skill of 2 s, a skill of 0.5 s.
    g, lam = 0.9, 0.8
    dts, rewards, values, last = [0.0, 2.0, 0.5], [1.0, 2.0, 3.0], [0.5, 0.25, 0.75], 1.5
    gs = [g ** d for d in dts]
    d2 = rewards[2] + gs[2] * last - values[2]
    d1 = rewards[1] + gs[1] * values[2] - values[1]
    d0 = rewards[0] + gs[0] * values[1] - values[0]
    a2 = d2
    a1 = d1 + gs[1] * lam * a2
    a0 = d0 + gs[0] * lam * a1
    adv, ret = run(dts, rewards, values, last)
    assert adv == pytest.approx([a0, a1, a2], rel=1e-5) and ret == pytest.approx([a0 + 0.5, a1 + 0.25, a2 + 0.75], rel=1e-5)
    assert gs[0] == 1.0, "a step that takes no game time is not discounted"
    # Every step one second: the library's own estimate with that γ.
    from sb3_contrib.common.maskable.buffers import MaskableDictRolloutBuffer
    plain = MaskableDictRolloutBuffer(3, space, spaces.Discrete(4), device="cpu", gamma=g, gae_lambda=lam, n_envs=1)
    obs = {"float": np.zeros((1, 3), np.float32), "int": np.zeros((1, 2), np.int32)}
    for r, v in zip(rewards, values):
        plain.add(obs, np.array([[0]]), np.array([r], np.float32), np.array([0.0]), torch.tensor([v]), torch.tensor([0.0]), action_masks=np.ones((1, 4), bool))
    plain.compute_returns_and_advantage(torch.tensor([last]), np.array([False]))
    adv1, _ = run([1.0, 1.0, 1.0], rewards, values, last)
    assert adv1 == pytest.approx(plain.advantages[:, 0], rel=1e-5)
    # An episode that begins inside the buffer cuts the estimate there.
    cut, _ = run(dts, rewards, values, last, starts=[False, False, True])
    assert cut[1] == pytest.approx(rewards[1] - values[1], rel=1e-5)
    # Without a source of step lengths the buffer refuses to guess.
    bare = TimeDiscountBuffer(1, space, spaces.Discrete(4), device="cpu", gamma=g, gae_lambda=lam, n_envs=1)
    with pytest.raises(RuntimeError, match="dt_source"):
        bare.add(obs, np.array([[0]]), np.array([0.0], np.float32), np.array([0.0]), torch.tensor([0.0]), torch.tensor([0.0]), action_masks=np.ones((1, 4), bool))


def test_an_untrained_manager_takes_the_heuristics_proposal_and_a_trained_one_can_leave_it():
    import torch
    from pokebonk_rl.manager import build_manager_model, spaces_only_env

    L = manager_layouts()
    config = cfg.load(REPO / "configs" / "manager.yaml", cfg.TRAINING_DEFAULTS)
    model = build_manager_model(config, spaces_only_env(L), L, None, "cpu")
    seg = L.segment("proposal")
    assert seg["shape"] == [1, L.n_actions]
    rng = np.random.default_rng(0)
    n = 64
    obs = {"float": rng.uniform(-1, 1, (n, L.float_size)).astype(np.float32), "int": np.zeros((n, L.int_size), np.int32)}
    obs["float"][:, seg["offset"]: seg["offset"] + L.n_actions] = 0
    masks = rng.random((n, L.n_actions)) < 0.2
    proposals = np.array([rng.integers(L.n_actions) for _ in range(n)])
    for k, p in enumerate(proposals):
        obs["float"][k, seg["offset"] + p] = 1
        masks[k, p] = True
    actions, _ = model.predict(obs, action_masks=masks, deterministic=True)
    assert np.array_equal(actions, proposals), "the most probable action of an untrained manager is the proposal, whatever else it sees"
    with torch.no_grad():
        t = {k: torch.as_tensor(v) for k, v in obs.items()}
        dist = model.policy.get_distribution(t, action_masks=torch.as_tensor(masks))
        p = dist.log_prob(torch.as_tensor(proposals)).exp().numpy()
    assert p.min() > 0.9, "…and sampled play takes it nearly always"
    # The mask still rules: a proposal that is not allowed is not taken.
    masks2 = masks.copy()
    masks2[np.arange(n), proposals] = False
    masks2[:, 0] = True
    actions2, _ = model.predict(obs, action_masks=masks2, deterministic=True)
    assert not np.any(actions2 == proposals) and all(masks2[k, a] for k, a in enumerate(actions2))
    # The path is a weight like any other: training can move away from the proposal where that pays.
    head = model.policy.action_net
    assert head.in_features == int(config["network"]["features_dim"]) + L.n_actions and head.weight.requires_grad
    names = list(L.action["names"])
    rare = {names.index(k): v for k, v in config["manager"]["rare_actions"].items()}
    assert set(config["manager"]["rare_actions"]) == {"skill:portal", "skill:wake"}
    want = torch.eye(L.n_actions) * float(config["manager"]["proposal_logit"])
    for a, b in rare.items():
        want[a, a] += b
    assert torch.allclose(head.weight[:, -L.n_actions:], want)
    # What cannot be taken back starts rare when the heuristic does not propose it, and is taken like any proposal when it does.
    farm, portal, retreat = names.index("skill:farm"), names.index("skill:portal"), names.index("skill:retreat")
    one = {"float": np.zeros((2, L.float_size), np.float32), "int": np.zeros((2, L.int_size), np.int32)}
    one["float"][0, seg["offset"] + farm] = 1        # the heuristic proposes farming...
    one["float"][1, seg["offset"] + portal] = 1      # ...and the portal
    allowed = np.zeros((2, L.n_actions), bool)
    allowed[:, [farm, portal, retreat]] = True
    with torch.no_grad():
        probs = model.policy.get_distribution({k: torch.as_tensor(v) for k, v in one.items()}, action_masks=torch.as_tensor(allowed)).distribution.probs.numpy()
    assert probs[0, farm] > 0.99 and probs[0, portal] < 0.05 * probs[0, retreat], "an unproposed portal is far less likely than another stray skill"
    assert probs[1, portal] == pytest.approx(probs[0, farm], abs=2e-3), "a proposed portal is taken as any proposal is"
    with pytest.raises(ValueError, match="no action"):
        build_manager_model({**config, "manager": {**config["manager"], "rare_actions": {"skill:fly": 1.0}}}, spaces_only_env(L), L, None, "cpu")
    # A policy head with hidden layers would have no such path: refused.
    bad = cfg.load(REPO / "configs" / "manager.yaml", cfg.TRAINING_DEFAULTS, ["network.pi=[64]"])
    with pytest.raises(ValueError, match="one linear layer"):
        build_manager_model(bad, spaces_only_env(L), L, None, "cpu")


def test_stored_decisions_come_back_as_they_were(tmp_path):
    from pokebonk_rl.bc import _Sparse, dense
    rng = np.random.default_rng(1)
    rows = (rng.random((7, 300)) < 0.05) * rng.uniform(-1, 1, (7, 300))
    rows = rows.astype(np.float32)
    rows[3] = 0
    s = _Sparse(np.float32)
    for r in rows:
        s.add(r)
    a = s.arrays("f")
    assert a["f_ptr"].tolist()[0] == 0 and len(a["f_idx"]) == int((rows != 0).sum())
    assert np.array_equal(dense(a["f_idx"], a["f_val"], a["f_ptr"], np.arange(7), 300, np.float32), rows)
    assert np.array_equal(dense(a["f_idx"], a["f_val"], a["f_ptr"], np.array([5, 3, 0]), 300, np.float32), rows[[5, 3, 0]])
