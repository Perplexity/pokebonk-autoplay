"""The trainer's side of the SQLite database (docs/storage.md).

Same file, same schema and same migration files as the Node runner (src/storage/): episodes played while training or
evaluating are rows of `batches` / `episodes` / `decisions` like any other, so the baseline reports read them too.
One process writes at a time per database (the trainer or the evaluator, which is the only writer of its own run).
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import platform
import re
import sqlite3
from pathlib import Path
from typing import Any

from .bridge import REPO

MIGRATIONS = REPO / "src" / "storage" / "migrations"
DEFAULT_DATABASE = REPO / "data" / "pokebonk.sqlite"


def now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def dumps(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def host_info() -> dict[str, Any]:
    info: dict[str, Any] = {"platform": platform.platform(), "python": platform.python_version(), "machine": platform.machine(), "processor": platform.processor()}
    try:
        import torch
        info["torch"] = torch.__version__
        info["cuda"] = torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
    except Exception:  # noqa: BLE001
        pass
    return info


class Store:
    def __init__(self, path: Path | str = DEFAULT_DATABASE, migrations: Path = MIGRATIONS):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(self.path), isolation_level=None, timeout=30)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.execute("PRAGMA journal_mode = WAL")
        self.db.execute("PRAGMA synchronous = NORMAL")
        self.db.execute("PRAGMA busy_timeout = 30000")
        self._migrate(migrations)

    def close(self) -> None:
        self.db.close()

    # ---------------------------------------------------------------- schema

    def _migrate(self, folder: Path) -> None:
        files = sorted(p for p in folder.glob("*.sql") if re.match(r"^\d{3}_", p.name))
        migrations = [(int(p.name[:3]), p.stem[4:], p) for p in files]
        for i, (version, _, p) in enumerate(migrations):
            if version != i + 1:
                raise RuntimeError(f"[storage] migration files must be numbered 001, 002, …: found {p.name} at position {i + 1}")
        if not migrations:
            raise RuntimeError(f"[storage] no migration files in {folder}")
        self.db.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)")
        have = int(self.db.execute("SELECT COALESCE(MAX(version), 0) FROM schema_version").fetchone()[0])
        newest = migrations[-1][0]
        if have > newest:
            raise RuntimeError(f"[storage] {self.path} has schema version {have}, this code knows up to {newest}: it was written by newer code")
        for version, name, p in migrations:
            if version <= have:
                continue
            sql = p.read_text("utf-8")
            try:
                self.db.execute("BEGIN IMMEDIATE")
                for statement in _statements(sql):
                    self.db.execute(statement)
                self.db.execute("INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)", (version, name, now()))
                self.db.execute("COMMIT")
            except Exception as e:
                self.db.execute("ROLLBACK")
                raise RuntimeError(f"[storage] migration {p.name} failed: {e}") from e

    def schema_version(self) -> int:
        return int(self.db.execute("SELECT MAX(version) FROM schema_version").fetchone()[0])

    def _tx(self):
        return _Transaction(self.db)

    # ---------------------------------------------------------------- batches, episodes, errors (schema 1)

    def create_batch(self, *, label: str | None, policy_name: str, policy_version: str, config: dict[str, Any], hz: int, action_repeat: int,
                     reward_version: str | None, episodes_planned: int) -> int:
        cur = self.db.execute(
            "INSERT INTO batches (started_at, label, policy_name, policy_version, config_json, hz, action_repeat, reward_version, host_json, episodes_planned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (now(), label, policy_name, policy_version, dumps(config), hz, action_repeat, reward_version, dumps(host_info()), episodes_planned))
        return int(cur.lastrowid)

    def set_batch_metadata(self, batch_id: int, m: dict[str, Any]) -> None:
        self.db.execute(
            "UPDATE batches SET game_build = ?, game_version = ?, bundle_sha256 = ?, shim_hash = ?, observation_schema = ?, action_schema = ?, decision_schema = ?, snapshot_schema = ?, profile_preset = ?, ranked = ?, metadata_json = ? WHERE id = ?",
            (m["gameBuild"], m["gameVersion"], m["bundleSha256"], m["shimHash"], m["observationSchema"], m["actionSchema"], m["decisionSchema"], m["snapshotSchema"],
             m["profilePreset"], int(bool(m["ranked"])), dumps(m["full"]), batch_id))

    def finish_batch(self, batch_id: int, status: str, wall_seconds: float) -> None:
        self.db.execute(
            "UPDATE batches SET status = ?, finished_at = ?, wall_seconds = ?, episodes_done = (SELECT COUNT(*) FROM episodes WHERE batch_id = batches.id), "
            "error_count = (SELECT COUNT(*) FROM errors WHERE batch_id = batches.id) WHERE id = ?", (status, now(), wall_seconds, batch_id))

    def insert_episode(self, batch_id: int, e: dict[str, Any], *, worker_id: int = 0, reward: dict[str, Any] | None = None, timesteps: int | None = None) -> int:
        """An episode record as src/ipc/server.ts sends it (the runner's EpisodeRecord plus `decisionCount`), with its decisions and its reward."""
        w, ot = e["worker"], e["overtime"]
        blocked = e.get("blockedNetwork") or []
        with self._tx():
            cur = self.db.execute(
                "INSERT INTO episodes (batch_id, seed, species, final_species, map, tier, ranked, end_cause, end_how, terminated, truncated, victory, game_time, kills, "
                "overtime_started, overtime_bonus, overtime_rounds, overtime_cashed, level, zone, guardians_defeated, legendaries_defeated, seals_kept, steps, sim_steps, decision_count, "
                "wall_seconds, reset_seconds, final_build_json, counters_json, record_json, blocked_network, blocked_network_json, worker_id, worker_pid, worker_episode, worker_rss_mb, started_at, finished_at) "
                "VALUES (" + ", ".join(["?"] * 39) + ")",
                (batch_id, e["seed"], e["species"], e["finalSpecies"], e["map"], e["tier"], int(bool(e["ranked"])), e["endCause"], e["endHow"], int(bool(e["terminated"])), int(bool(e["truncated"])),
                 int(bool(e["victory"])), e["gameTime"], e["kills"], int(bool(ot["started"])), ot["bonus"], ot["rounds"], int(bool(ot["cashed"])), e["level"], e["zone"], e["guardiansDefeated"],
                 e["legendariesDefeated"], e["sealsKept"], e["steps"], e["simSteps"], int(e.get("decisionCount", len(e["decisions"]))), e["wallSeconds"], e["resetSeconds"], dumps(e["finalBuild"]),
                 dumps(e["counters"]), dumps(e["record"]) if e["record"] else None, len(blocked), dumps(blocked) if blocked else None, worker_id, w["pid"], w["episode"], w["rssMB"],
                 e["startedAt"], e["finishedAt"]))
            episode_id = int(cur.lastrowid)
            self.db.executemany(
                "INSERT INTO decisions (episode_id, serial, step, game_time, zone, level, kind, method, options_json, context_json, mask_json, chosen_json, chosen_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [(episode_id, d["serial"], d["step"], d["gameTime"], d["zone"], d["level"], d["kind"], d["method"], dumps(d["options"]), dumps(d["context"]), dumps(d["mask"]), dumps(d["chosen"]), d["chosenId"])
                 for d in e["decisions"]])
            if reward is not None:
                self.db.execute("INSERT INTO episode_rewards (episode_id, reward_version, total, components_json, raw_json, timesteps) VALUES (?, ?, ?, ?, ?, ?)",
                                (episode_id, reward["version"], reward["total"], dumps(reward["components"]), dumps(reward["raw"]), timesteps))
            self.db.execute("UPDATE batches SET episodes_done = episodes_done + 1 WHERE id = ?", (batch_id,))
        return episode_id

    def insert_error(self, batch_id: int, *, kind: str, message: str, details: dict[str, Any], seed: int | None = None, worker_id: int | None = None) -> int:
        with self._tx():
            cur = self.db.execute("INSERT INTO errors (batch_id, episode_id, seed, worker_id, kind, occurred_at, message, details_json) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)",
                                  (batch_id, seed, worker_id, kind, now(), message, dumps(details)))
            self.db.execute("UPDATE batches SET error_count = error_count + 1 WHERE id = ?", (batch_id,))
        return int(cur.lastrowid)

    # ---------------------------------------------------------------- training (schema 2)

    def training_run(self, name: str) -> sqlite3.Row | None:
        return self.db.execute("SELECT * FROM training_runs WHERE name = ?", (name,)).fetchone()

    def create_training_run(self, *, name: str, algorithm: str, config: dict[str, Any], reward: dict[str, Any], observation_layout_hash: str, action_layout_hash: str,
                            game_build: str, directory: str) -> int:
        cur = self.db.execute(
            "INSERT INTO training_runs (name, created_at, algorithm, config_json, reward_version, reward_json, observation_layout_hash, action_layout_hash, game_build, dir) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (name, now(), algorithm, dumps(config), reward["version"], dumps(reward), observation_layout_hash, action_layout_hash, game_build, directory))
        return int(cur.lastrowid)

    def create_session(self, run_id: int, batch_id: int, start_timesteps: int, resumed_from: str | None) -> int:
        cur = self.db.execute("INSERT INTO training_sessions (run_id, batch_id, started_at, resumed_from, start_timesteps, host_json) VALUES (?, ?, ?, ?, ?, ?)",
                              (run_id, batch_id, now(), resumed_from, start_timesteps, dumps(host_info())))
        return int(cur.lastrowid)

    def finish_session(self, session_id: int, status: str, end_timesteps: int) -> None:
        self.db.execute("UPDATE training_sessions SET status = ?, finished_at = ?, end_timesteps = ? WHERE id = ?", (status, now(), end_timesteps, session_id))

    def insert_checkpoint(self, *, run_id: int, session_id: int, kind: str, timesteps: int, episodes: int, path: str, sha256: str) -> int:
        cur = self.db.execute("INSERT INTO checkpoints (run_id, session_id, created_at, kind, timesteps, episodes, path, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                              (run_id, session_id, now(), kind, timesteps, episodes, path, sha256))
        return int(cur.lastrowid)

    def insert_evaluation(self, *, batch_id: int, model_path: str, model_sha256: str, run_id: int | None, timesteps: int | None, deterministic: bool, seeds: list[int],
                          scenario: dict[str, Any], summary: dict[str, Any], reference: str | None, comparison: dict[str, Any] | None, passed: bool | None) -> int:
        cur = self.db.execute(
            "INSERT INTO evaluations (created_at, batch_id, model_path, model_sha256, run_id, timesteps, deterministic, seeds_json, scenario_json, summary_json, reference, comparison_json, passed) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (now(), batch_id, model_path, model_sha256, run_id, timesteps, int(deterministic), dumps(seeds), dumps(scenario), dumps(summary), reference,
             dumps(comparison) if comparison is not None else None, None if passed is None else int(passed)))
        return int(cur.lastrowid)

    def episodes(self, batch_id: int) -> list[sqlite3.Row]:
        return self.db.execute("SELECT * FROM episodes WHERE batch_id = ? ORDER BY seed", (batch_id,)).fetchall()

    def batch(self, batch_id: int) -> sqlite3.Row | None:
        return self.db.execute("SELECT * FROM batches WHERE id = ?", (batch_id,)).fetchone()

    def find_batch(self, ref: str | int) -> sqlite3.Row:
        """A batch by id, or the newest completed batch whose label is exactly `ref`."""
        if isinstance(ref, int) or str(ref).isdigit():
            row = self.batch(int(ref))
        else:
            row = self.db.execute("SELECT * FROM batches WHERE label = ? AND status = 'completed' ORDER BY id DESC LIMIT 1", (ref,)).fetchone()
        if row is None:
            raise LookupError(f"no batch {ref!r} in {self.path}")
        return row


class _Transaction:
    def __init__(self, db: sqlite3.Connection):
        self.db = db

    def __enter__(self):
        self.db.execute("BEGIN IMMEDIATE")

    def __exit__(self, exc_type, exc, tb):
        self.db.execute("ROLLBACK" if exc_type else "COMMIT")
        return False


def _statements(sql: str) -> list[str]:
    """Split a migration file into statements (the files contain no triggers, so `;` at a line end is a statement end)."""
    out, current = [], []
    for line in sql.splitlines():
        stripped = line.split("--", 1)[0].rstrip()
        if not stripped.strip():
            continue
        current.append(stripped)
        if stripped.endswith(";"):
            out.append("\n".join(current))
            current = []
    if current:
        out.append("\n".join(current))
    return out
