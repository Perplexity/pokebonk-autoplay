"""Tests that start real game processes (slow): the bridge, the vectorised environment, and the whole path
train → checkpoint → resume → evaluate → register → promote, each through its command line."""
from __future__ import annotations

import json
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from pokebonk_rl import config as cfg
from pokebonk_rl.bridge import REPO, NodeWorker, WorkerError, default_env_options
from pokebonk_rl.layout import check_against_metadata, load_layouts
from pokebonk_rl.reward import RewardConfig
from pokebonk_rl.storage import sha256_file
from pokebonk_rl.vec_env import NodeVecEnv, Scenarios

pytestmark = pytest.mark.game
BUILD = "mwsewi0r"
LAYOUTS = load_layouts(BUILD)
OFFSETS = np.concatenate([[0], np.cumsum(LAYOUTS.nvec)[:-1]])


def masked_random(mask: np.ndarray, rng) -> list[int]:
    return [int(rng.choice(np.flatnonzero(mask[o:o + n]))) for o, n in zip(OFFSETS, LAYOUTS.nvec)]


def reward_config() -> RewardConfig:
    return RewardConfig.from_dict(cfg.load(None, cfg.TRAINING_DEFAULTS)["reward"])


# ---------------------------------------------------------------- bridge

def play(seed: int, steps: int, log: Path):
    rng = np.random.default_rng(123)
    w = NodeWorker(default_env_options(), log_path=log)
    try:
        frame = w.reset(seed, species=155, map="forest", tier=0)
        trace = [(frame.float.copy(), frame.int.copy(), frame.mask.copy(), dict(frame.header["c"]))]
        for _ in range(steps):
            frame = w.step(masked_random(frame.mask, rng))
            trace.append((frame.float.copy(), frame.int.copy(), frame.mask.copy(), dict(frame.header["c"])))
        return trace, w.metadata
    finally:
        w.close()
        assert w.proc.returncode == 0


def test_bridge_delivers_the_layouts_buffers_and_the_same_episode_for_the_same_seed_and_actions(tmp_path):
    a, metadata = play(41, 150, tmp_path / "a.log")
    b, _ = play(41, 150, tmp_path / "b.log")
    check_against_metadata(LAYOUTS, metadata)
    assert a[0][0].shape == (LAYOUTS.float_size,) and a[0][1].shape == (LAYOUTS.int_size,) and a[0][2].shape == (LAYOUTS.mask_size,)
    assert a[0][0].dtype == np.float32 and a[0][1].dtype == np.int32
    for k, (x, y) in enumerate(zip(a, b)):
        assert np.array_equal(x[0], y[0]) and np.array_equal(x[1], y[1]) and np.array_equal(x[2], y[2]) and x[3] == y[3], f"two processes differ at step {k}"
    assert a[-1][3]["time"] > 5 and not np.array_equal(a[0][0], a[-1][0])
    assert metadata["profilePreset"] == "unlocked-v3" and metadata["full"]["offline"]["blocked"] == []
    # Another layout than the running environment's is refused, not adapted to.
    other = type(LAYOUTS)(build=BUILD, observation={**LAYOUTS.observation, "hash": "0" * 64}, action=LAYOUTS.action, vocab_sizes=LAYOUTS.vocab_sizes)
    with pytest.raises(RuntimeError, match="does not match the exported layouts"):
        check_against_metadata(other, metadata)


def test_bridge_reports_an_action_the_mask_forbids_and_the_process_ends(tmp_path):
    w = NodeWorker(default_env_options(), log_path=tmp_path / "w.log")
    try:
        frame = w.reset(5)
        assert frame.header["phase"] == "play" and frame.mask[OFFSETS[5] + 1] == 0
        with pytest.raises(WorkerError) as e:
            w.step([0, 0, 0, 0, 0, 1])            # a dialog choice while no dialog is open
        assert e.value.kind == "episode-error" and e.value.details["seed"] == 5
        w.proc.wait(timeout=30)
        assert w.proc.returncode == 1
        with pytest.raises(WorkerError):          # nothing more comes from it
            w.step([0, 0, 0, 0, 0, 0], timeout=10)
    finally:
        w.kill()


def test_bridge_adds_a_top_down_view_only_when_asked_and_the_episode_stays_the_same(tmp_path):
    """`view: true` (python/pokebonk_rl/watch.py, the dashboard's Watch page) adds a picture of the moment to every
    reply. It is read from the observation: the episode it describes is the one played without it."""
    plain, _ = play(41, 40, tmp_path / "plain.log")
    rng = np.random.default_rng(123)
    w = NodeWorker(default_env_options(), log_path=tmp_path / "view.log", view=True)
    try:
        frame = w.reset(41, species=155, map="forest", tier=0)
        views = [frame.header["v"]]
        for k in range(40):
            frame = w.step(masked_random(frame.mask, rng))
            views.append(frame.header["v"])
            assert np.array_equal(frame.float, plain[k + 1][0]) and frame.header["c"] == plain[k + 1][3], f"the watched episode differs at step {k + 1}"
    finally:
        w.close()
    first, last = views[0], views[-1]
    assert set(first) == {"time", "zone", "kills", "level", "hp", "maxHp", "x", "z", "phase", "enemies", "near", "boss", "points", "hazards", "shots", "decision", "bounds"}
    assert first["time"] == 0 and first["phase"] == "play" and first["hp"] == first["maxHp"] > 0 and first["zone"] == 1
    assert any(kind == "boss" for kind, _x, _z, _used in first["points"]), "the guardian altar is always on the map"
    assert last["time"] > 0 and all(len(e) == 4 for e in last["near"]) and len(last["near"]) <= last["enemies"]
    # Without the option the reply is what it always was.
    w = NodeWorker(default_env_options(), log_path=tmp_path / "none.log")
    try:
        assert "v" not in w.reset(41, species=155, map="forest", tier=0).header
    finally:
        w.close()


# ---------------------------------------------------------------- vectorised environment

def test_vec_env_swaps_in_spares_recycles_processes_and_accounts_for_every_episode(tmp_path):
    episodes, errors = [], []
    venv = NodeVecEnv(n_envs=2, n_spares=1, layouts=LAYOUTS, env_options=default_env_options(maxGameTime=6), reward=reward_config(),
                      scenarios=Scenarios([155, 25], ["forest"], [0], seed=1), first_seed=2_000_000, first_episode=10, recycle_after=2, log_dir=tmp_path,
                      on_episode=episodes.append, on_error=lambda e, c: errors.append((e, c)))
    rng = np.random.default_rng(0)
    try:
        obs = venv.reset()
        assert obs["float"].shape == (2, LAYOUTS.float_size) and obs["int"].shape == (2, LAYOUTS.int_size) and venv.has_attr("action_masks")
        returns = np.zeros(2)
        finished = []
        for _ in range(700):
            masks = np.stack(venv.env_method("action_masks"))
            assert masks.shape == (2, LAYOUTS.mask_size) and masks.dtype == bool
            obs, rewards, dones, infos = venv.step(np.array([masked_random(m, rng) for m in masks]))
            returns += rewards
            for i in range(2):
                if dones[i]:
                    info = infos[i]
                    # The cap on game time ended it: truncated, with the last observation of the old episode attached…
                    assert info["TimeLimit.truncated"] is True and info["terminal_observation"]["float"].shape == (LAYOUTS.float_size,)
                    assert info["episode"]["r"] == pytest.approx(returns[i], abs=1e-4) and info["pokebonk"]["reward"]["total"] == pytest.approx(returns[i], abs=1e-4)
                    # … and the observation returned for the slot is the first of a new episode (run clock back near zero).
                    assert not np.array_equal(obs["float"][i], info["terminal_observation"]["float"])
                    finished.append(info["pokebonk"])
                    returns[i] = 0
            if len(finished) >= 5:
                break
        assert len(finished) >= 5 and finished == episodes[:len(finished)] and not errors
        seeds = [f["episode"]["seed"] for f in finished]
        assert len(set(seeds)) == len(seeds) and all(2_000_010 <= s < 2_000_010 + venv.episodes_started for s in seeds)
        for f in finished:
            assert f["episode"]["seed"] == 2_000_000 + f["episode_index"] and f["episode"]["species"] == f["scenario"]["species"]
            assert f["episode"]["truncated"] and f["episode"]["gameTime"] >= 6 and f["episode"]["blockedNetwork"] == []
            assert f["reward"]["raw"]["ko"] == f["episode"]["kills"]
        assert {f["scenario"]["species"] for f in finished} <= {155, 25}
        # 2 slots + 1 spare at the start; with 2 episodes per process, 5 finished episodes need replacements.
        assert venv.workers_started > 3 and venv.errors == 0
    finally:
        venv.close()


def test_vec_env_stops_after_too_many_environment_errors(tmp_path):
    errors = []
    venv = NodeVecEnv(n_envs=1, n_spares=0, layouts=LAYOUTS, env_options=default_env_options(), reward=reward_config(), scenarios=Scenarios([2], ["forest"], [0]),
                      first_seed=1, max_errors=1, log_dir=tmp_path, on_error=lambda e, c: errors.append((e, c)))
    try:
        with pytest.raises(RuntimeError, match="2 environment errors in this session \\(limit 1\\)"):
            venv.reset()                      # species 2 is not a League member: every reset is refused by the environment
        assert len(errors) == 2 and "not a League member" in str(errors[0][0]) and errors[0][1]["during"] == "reset" and errors[0][1]["seed"] == 1
    finally:
        venv.close()


# ---------------------------------------------------------------- train, resume, evaluate, promote

def run(module: str, *args: str, timeout: int = 900) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-m", f"pokebonk_rl.{module}", *args], cwd=REPO, capture_output=True, text=True, timeout=timeout)


def tree(folder: Path) -> dict[str, str]:
    return {str(p.relative_to(folder)): sha256_file(p) for p in sorted(folder.rglob("*")) if p.is_file()}


@pytest.fixture(scope="module")
def trained(tmp_path_factory):
    """A tiny run: 256 timesteps on 2 game processes, episodes capped at 3 game seconds so that some finish."""
    root = tmp_path_factory.mktemp("pipeline")
    paths = [f"paths.database={(root / 'db.sqlite').as_posix()}", f"paths.models={(root / 'models').as_posix()}", f"paths.logs={(root / 'logs').as_posix()}"]
    common = ["workers.envs=2", "workers.spares=1", "ppo.n_steps=64", "ppo.batch_size=64", "ppo.n_epochs=2", "env.max_game_time=3", "checkpoint_every_timesteps=128",
              f"paths.tensorboard={(root / 'tb').as_posix()}", *paths]
    sets = [x for s in common for x in ("--set", s)]
    first = run("train", "--config", str(REPO / "configs" / "training.yaml"), "--name", "tiny", "--timesteps", "256", *sets)
    assert first.returncode == 0, first.stderr[-3000:]
    return {"root": root, "paths": paths, "sets": sets, "first": first}


def db(root: Path) -> sqlite3.Connection:
    con = sqlite3.connect(root / "db.sqlite")
    con.row_factory = sqlite3.Row
    return con


def test_short_training_run_completes_and_leaves_recoverable_checkpoints(trained):
    root = trained["root"]
    ckpts = sorted(p.name for p in (root / "models" / "runs" / "tiny" / "checkpoints").iterdir())
    assert ckpts == ["ckpt_000000000128", "ckpt_000000000256"]
    last = root / "models" / "runs" / "tiny" / "checkpoints" / "ckpt_000000000256"
    assert {p.name for p in last.iterdir()} == {"model.zip", "vecnormalize.pkl", "state.json"}
    state = json.loads((last / "state.json").read_text("utf-8"))
    assert state["timesteps"] == 256 and state["run"] == "tiny" and state["reward_version"] == "v6" and state["model_sha256"] == sha256_file(last / "model.zip")
    assert state["observation_layout_hash"] == LAYOUTS.observation_hash and state["action_layout_hash"] == LAYOUTS.action_hash
    con = db(root)
    run_row = con.execute("SELECT * FROM training_runs WHERE name = 'tiny'").fetchone()
    assert run_row["algorithm"] == "MaskablePPO" and run_row["reward_version"] == "v6" and run_row["game_build"] == BUILD
    session = con.execute("SELECT * FROM training_sessions").fetchone()
    assert session["status"] == "completed" and session["start_timesteps"] == 0 and session["end_timesteps"] == 256 and session["resumed_from"] is None
    batch = con.execute("SELECT * FROM batches WHERE id = ?", (session["batch_id"],)).fetchone()
    assert batch["status"] == "completed" and batch["policy_name"] == "ppo-train" and batch["reward_version"] == "v6" and batch["profile_preset"] == "unlocked-v3" and batch["error_count"] == 0
    assert [(c["kind"], c["timesteps"]) for c in con.execute("SELECT * FROM checkpoints ORDER BY id")] == [("periodic", 128), ("periodic", 256)]
    # Episodes that ended while training are stored with their reward split into components, and no network attempt.
    episodes = con.execute("SELECT e.*, r.total, r.components_json, r.reward_version AS rv FROM episodes e JOIN episode_rewards r ON r.episode_id = e.id WHERE e.batch_id = ?", (batch["id"],)).fetchall()
    assert len(episodes) >= 2 and all(e["seed"] >= 1_000_000 and e["truncated"] == 1 and e["blocked_network"] == 0 and e["rv"] == "v6" for e in episodes)
    assert all(json.loads(e["components_json"]).keys() == {"ko", "guardian", "zone", "legendary", "overtime", "overtime_void", "map_use", "shop_sale", "death", "idle", "point_use", "item", "spend", "earn", "rift"} for e in episodes)
    assert any(f.name.startswith("events.out.tfevents") for f in (root / "tb").rglob("*"))
    assert "Using cpu device" in trained["first"].stdout


def test_training_resumes_from_the_newest_checkpoint_and_refuses_what_would_change_the_run(trained):
    root = trained["root"]
    # A run name is used once; a resume takes no other configuration.
    again = run("train", "--config", str(REPO / "configs" / "training.yaml"), "--name", "tiny", *trained["sets"])
    assert again.returncode == 2 and "--resume tiny" in again.stderr
    con = db(root)
    seeds_before = {r["seed"] for r in con.execute("SELECT seed FROM episodes")}
    started_before = json.loads((root / "models" / "runs" / "tiny" / "checkpoints" / "ckpt_000000000256" / "state.json").read_text("utf-8"))["episodes_started"]
    resumed = run("train", "--resume", "tiny", "--models", str(root / "models"), "--timesteps", "384")
    assert resumed.returncode == 0, resumed.stderr[-3000:]
    assert "256 of 384 timesteps done" in resumed.stdout
    ckpt = root / "models" / "runs" / "tiny" / "checkpoints" / "ckpt_000000000384"
    state = json.loads((ckpt / "state.json").read_text("utf-8"))
    assert state["timesteps"] == 384 and state["episodes_started"] > started_before
    sessions = con.execute("SELECT * FROM training_sessions ORDER BY id").fetchall()
    assert len(sessions) == 2 and sessions[1]["start_timesteps"] == 256 and sessions[1]["end_timesteps"] == 384 and sessions[1]["resumed_from"].endswith("ckpt_000000000256")
    # The second session continues the run's episode numbering: no seed is played twice.
    new_seeds = [r["seed"] for r in con.execute("SELECT seed FROM episodes WHERE batch_id = ?", (sessions[1]["batch_id"],))]
    assert new_seeds and not (set(new_seeds) & seeds_before) and min(new_seeds) >= 1_000_000 + started_before
    # Earlier checkpoints are untouched by the resume.
    assert json.loads((root / "models" / "runs" / "tiny" / "checkpoints" / "ckpt_000000000256" / "state.json").read_text("utf-8"))["timesteps"] == 256
    # A run cannot be continued under another reward: the stored configuration is edited behind its back here.
    config_file = root / "models" / "runs" / "tiny" / "config.json"
    original = config_file.read_text("utf-8")
    changed = json.loads(original)
    changed["reward"]["weights"]["ko"] = 2.0
    config_file.write_text(json.dumps(changed), "utf-8")
    try:
        refused = run("train", "--resume", "tiny", "--models", str(root / "models"), "--timesteps", "512")
        assert refused.returncode == 2 and "another reward" in refused.stderr
    finally:
        config_file.write_text(original, "utf-8")
    assert not (root / "models" / "runs" / "tiny" / "checkpoints" / "ckpt_000000000512").exists()


def test_evaluation_plays_the_requested_model_reproducibly_and_promotion_follows_the_rule(trained):
    root, paths = trained["root"], trained["paths"]
    ckpts = root / "models" / "runs" / "tiny" / "checkpoints"
    wanted = ckpts / "ckpt_000000000128"                 # not the newest: the evaluator must take the one it is given
    sets = [x for s in ["workers.envs=2", "env.max_game_time=8", "seeds=1-3", *[p for p in paths]] for x in ("--set", s)]
    first = run("evaluate", "--model", str(wanted), "--reference", "none", *sets)
    assert first.returncode == 0, first.stderr[-3000:]
    con = db(root)
    ev1 = con.execute("SELECT * FROM evaluations ORDER BY id DESC LIMIT 1").fetchone()
    sha = sha256_file(wanted / "model.zip")
    assert ev1["model_sha256"] == sha and Path(ev1["model_path"]) == wanted.resolve() and ev1["timesteps"] == 128 and ev1["passed"] is None and ev1["deterministic"] == 1
    assert sha != sha256_file(ckpts / "ckpt_000000000256" / "model.zip")
    b1 = con.execute("SELECT * FROM batches WHERE id = ?", (ev1["batch_id"],)).fetchone()
    assert b1["policy_name"] == "ppo" and b1["policy_version"] == sha[:12] and b1["status"] == "completed" and json.loads(b1["config_json"])["model_sha256"] == sha
    rows1 = con.execute("SELECT * FROM episodes WHERE batch_id = ? ORDER BY seed", (b1["id"],)).fetchall()
    assert [r["seed"] for r in rows1] == [1, 2, 3] and all(r["blocked_network"] == 0 for r in rows1)
    # Evaluation episodes keep every dialog decision.
    assert con.execute("SELECT COUNT(*) FROM decisions d JOIN episodes e ON e.id = d.episode_id WHERE e.batch_id = ?", (b1["id"],)).fetchone()[0] == sum(r["decision_count"] for r in rows1)

    # The same file on the same seeds again, compared with the first evaluation: the same episodes, so the ratio is 1. These are not the
    # seeds of the promotion rule and the reference was chosen by hand, so the comparison is stored as information, not as a verdict.
    second = run("evaluate", "--model", str(wanted), "--reference", str(b1["id"]), *sets)
    assert second.returncode == 0, second.stderr[-3000:]
    ev2 = con.execute("SELECT * FROM evaluations ORDER BY id DESC LIMIT 1").fetchone()
    rows2 = con.execute("SELECT * FROM episodes WHERE batch_id = ? ORDER BY seed", (ev2["batch_id"],)).fetchall()
    same = ("seed", "kills", "steps", "sim_steps", "game_time", "level", "decision_count", "end_cause", "counters_json", "final_build_json")
    assert [tuple(r[c] for c in same) for r in rows1] == [tuple(r[c] for c in same) for r in rows2]
    comparison = json.loads(ev2["comparison_json"])
    assert comparison["ratio"] == pytest.approx(1.0) and comparison["per_seed_by_score"] == {"wins": 0, "losses": 0, "ties": 3}
    assert ev2["passed"] is None and comparison["verdict"] is False and comparison["met_the_rule"] is True and len(comparison["not_a_verdict_because"]) == 2
    assert "not a promotion verdict" in second.stdout

    # Registered, the file cannot be promoted on that: nothing has judged it.
    registry = ["--database", str(root / "db.sqlite"), "--models", str(root / "models")]
    registered = run("registry", *registry, "register", "--model", str(wanted))
    assert registered.returncode == 0, registered.stderr
    candidate = con.execute("SELECT * FROM models WHERE role = 'candidate'").fetchone()
    assert candidate["sha256"] == sha and candidate["timesteps"] == 128
    early = run("registry", *registry, "promote", "--candidate", str(candidate["id"]), "--yes")
    assert early.returncode != 0 and "no passed evaluation" in early.stderr
    assert con.execute("SELECT COUNT(*) FROM models WHERE role = 'stable'").fetchone()[0] == 0 and not list((root / "models" / "stable").glob("*"))

    # On the rule's own seeds and against the rule's own reference the same comparison is a verdict, and the candidate can be promoted.
    rule = [x for s in ["promotion.seeds=1-3", f"promotion.first_reference={b1['id']}"] for x in ("--set", s)]
    third = run("evaluate", "--model", f"candidate:{candidate['id']}", *sets, *rule)
    assert third.returncode == 0, third.stderr[-3000:]
    ev3 = con.execute("SELECT * FROM evaluations ORDER BY id DESC LIMIT 1").fetchone()
    verdict = json.loads(ev3["comparison_json"])
    assert ev3["id"] != ev2["id"] and ev3["model_sha256"] == sha and ev3["passed"] == 1 and verdict["verdict"] is True and verdict["ratio"] == pytest.approx(1.0)
    promoted = run("registry", *registry, "promote", "--candidate", str(candidate["id"]), "--yes")
    assert promoted.returncode == 0, promoted.stderr
    stable = con.execute("SELECT * FROM models WHERE role = 'stable'").fetchone()
    assert stable["sha256"] == sha and stable["evaluation_id"] == ev3["id"]
    stable_tree = tree(root / "models" / "stable")
    assert stable_tree[str(Path(Path(stable["path"]).name) / "model.zip")] == sha

    # A training run that fails (its Pokémon is not playable) and an evaluation that loses its episodes leave the stable model as it is.
    failing = run("train", "--config", str(REPO / "configs" / "training.yaml"), "--name", "broken", "--timesteps", "128", "--set", "scenarios.species=[2]", "--set", "workers.max_errors=1",
                  *[x for s in ["workers.envs=1", "workers.spares=0", "ppo.n_steps=64", "ppo.batch_size=64", f"paths.tensorboard={(root / 'tb').as_posix()}", *paths] for x in ("--set", s)])
    assert failing.returncode != 0 and "environment errors in this session" in failing.stderr
    broken = con.execute("SELECT s.status, b.status AS batch_status, b.error_count FROM training_sessions s JOIN batches b ON b.id = s.batch_id JOIN training_runs r ON r.id = s.run_id WHERE r.name = 'broken'").fetchone()
    assert broken["status"] == "failed" and broken["batch_status"] == "failed" and broken["error_count"] >= 2
    assert not list((root / "models" / "runs" / "broken").glob("checkpoints/ckpt_*"))
    lost = run("evaluate", "--model", "stable", "--reference", "none", *[x for s in ["workers.envs=1", "seeds=1-2", "scenario.species=2", *paths] for x in ("--set", s)])
    assert lost.returncode == 3 and "LOST" in lost.stderr
    assert tree(root / "models" / "stable") == stable_tree
    assert con.execute("SELECT id FROM models WHERE role = 'stable'").fetchone()["id"] == stable["id"]

    # A model saved for other layouts is refused by the evaluator.
    foreign = root / "foreign"
    shutil.copytree(wanted, foreign)
    state = json.loads((foreign / "state.json").read_text("utf-8"))
    state["observation_layout_hash"] = "0" * 64
    (foreign / "state.json").write_text(json.dumps(state), "utf-8")
    refused = run("evaluate", "--model", str(foreign), "--reference", "none", *sets)
    assert refused.returncode == 2 and "other observation or action layouts" in refused.stderr
