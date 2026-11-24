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
    c = {"kills": 0, "guardiansDefeated": 0, "legendariesDefeated": 0, "zonesEntered": 1, "damageTaken": 0.0, "mapUse": 0, "shopSold": 0}
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
    assert training["reward"]["version"] == "v2" and training["env"]["action_repeat"] == 3 and training["device"] == "cpu"
    assert training["scenarios"]["species"] == [150]
    evaluation = cfg.load(REPO / "configs" / "evaluation.yaml", cfg.EVALUATION_DEFAULTS, ["workers.envs=2", "seeds=4-6"])
    assert evaluation["workers"]["envs"] == 2 and cfg.parse_seeds(evaluation["seeds"]) == [4, 5, 6]
    assert evaluation["scenario"]["species"] == 150 and evaluation["reward"]["version"] == "v2" and len(cfg.parse_seeds(evaluation["promotion"]["seeds"])) == 50
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
