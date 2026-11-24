"""Candidate and stable models: registration, promotion, rollback.

  python -m pokebonk_rl.registry list
  python -m pokebonk_rl.registry register --model <checkpoint folder | run name> [--note …]
  python -m pokebonk_rl.registry promote --candidate <id> --yes
  python -m pokebonk_rl.registry rollback --to <id> --yes

  models/candidates/<id>-<hash>/     a copy of a checkpoint folder, registered for evaluation
  models/stable/<id>-<hash>/         a promoted copy; one folder per promotion, never written again
  models/stable/current.json         which of them is the stable model now

Rules, enforced here and not left to the caller:
- A candidate is promoted only if an evaluation of exactly its file (same hash) has passed the promotion rule
  (python/pokebonk_rl/evaluate.py), and that evaluation is the newest one of that file.
- Promotion copies; it never moves, overwrites or deletes. The previous stable model keeps its folder and becomes
  `retired`. A copy is verified by hash before the pointer moves, and the pointer is replaced atomically.
- Rollback points back at a retired model whose files are still what they were. Nothing here deletes a model.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any

from .checkpoints import read_checkpoint
from .storage import Store, now, sha256_file


class RegistryError(RuntimeError):
    pass


def current_stable(store: Store):
    rows = store.db.execute("SELECT * FROM models WHERE role = 'stable' ORDER BY id").fetchall()
    if len(rows) > 1:
        raise RegistryError(f"{len(rows)} models are marked stable (ids {[r['id'] for r in rows]}); exactly one may be")
    return rows[0] if rows else None


def _copy_checkpoint(src: Path, dest: Path, sha: str) -> None:
    if dest.exists():
        raise RegistryError(f"{dest} exists: model folders are written once")
    partial = dest.with_name(dest.name + ".partial")
    if partial.exists():
        shutil.rmtree(partial)
    shutil.copytree(src, partial)
    got = sha256_file(partial / "model.zip")
    if got != sha:
        shutil.rmtree(partial)
        raise RegistryError(f"copy of {src} has hash {got[:16]}…, expected {sha[:16]}…")
    os.replace(partial, dest)


def _write_pointer(models_root: Path, payload: dict[str, Any]) -> None:
    stable = models_root / "stable"
    stable.mkdir(parents=True, exist_ok=True)
    tmp = stable / "current.json.tmp"
    tmp.write_text(json.dumps(payload, indent=1), "utf-8")
    os.replace(tmp, stable / "current.json")


def register_candidate(store: Store, models_root: Path, checkpoint: Path, note: str | None = None) -> int:
    """Copy a checkpoint folder into models/candidates and record it. Returns the model id."""
    checkpoint = Path(checkpoint).resolve()
    state = read_checkpoint(checkpoint)
    sha = state["model_sha256"]
    run = store.training_run(state["run"]) if state.get("run") else None
    with store._tx():
        cur = store.db.execute("INSERT INTO models (role, created_at, path, sha256, run_id, timesteps, note) VALUES ('candidate', ?, ?, ?, ?, ?, ?)",
                               (now(), f"pending:{sha}:{now()}", sha, int(run["id"]) if run is not None else None, state.get("timesteps"), note))
        model_id = int(cur.lastrowid)
        dest = models_root / "candidates" / f"{model_id:04d}-{sha[:12]}"
        dest.parent.mkdir(parents=True, exist_ok=True)
        _copy_checkpoint(checkpoint, dest, sha)
        store.db.execute("UPDATE models SET path = ? WHERE id = ?", (str(dest), model_id))
        store.db.execute("INSERT INTO model_events (at, action, model_id, note) VALUES (?, 'register', ?, ?)", (now(), model_id, note))
    return model_id


def passing_evaluation(store: Store, sha: str):
    """The newest evaluation of the file with this hash, if it passed; None when there is none or the newest did not pass."""
    row = store.db.execute("SELECT * FROM evaluations WHERE model_sha256 = ? AND passed IS NOT NULL ORDER BY id DESC LIMIT 1", (sha,)).fetchone()
    return row if row is not None and row["passed"] == 1 else None


def promote(store: Store, models_root: Path, candidate_id: int, note: str | None = None) -> int:
    """Make a candidate the stable model. Returns the id of the new stable model row."""
    cand = store.db.execute("SELECT * FROM models WHERE id = ?", (candidate_id,)).fetchone()
    if cand is None or cand["role"] != "candidate":
        raise RegistryError(f"model {candidate_id} is not a candidate")
    src = Path(cand["path"])
    state = read_checkpoint(src)                       # complete, and model.zip is the file that was registered
    if state["model_sha256"] != cand["sha256"]:
        raise RegistryError(f"{src} no longer holds the file registered as model {candidate_id}")
    evaluation = passing_evaluation(store, cand["sha256"])
    if evaluation is None:
        raise RegistryError(f"model {candidate_id} ({cand['sha256'][:12]}) has no passed evaluation as its newest judged one: evaluate it first (python -m pokebonk_rl.evaluate --model candidate:{candidate_id})")
    previous = current_stable(store)
    with store._tx():
        cur = store.db.execute("INSERT INTO models (role, created_at, path, sha256, run_id, timesteps, evaluation_id, note) VALUES ('stable', ?, ?, ?, ?, ?, ?, ?)",
                               (now(), f"pending:{cand['sha256']}:{now()}", cand["sha256"], cand["run_id"], cand["timesteps"], int(evaluation["id"]), note))
        stable_id = int(cur.lastrowid)
        dest = models_root / "stable" / f"{stable_id:04d}-{cand['sha256'][:12]}"
        dest.parent.mkdir(parents=True, exist_ok=True)
        _copy_checkpoint(src, dest, cand["sha256"])
        store.db.execute("UPDATE models SET path = ? WHERE id = ?", (str(dest), stable_id))
        if previous is not None:
            store.db.execute("UPDATE models SET role = 'retired' WHERE id = ?", (int(previous["id"]),))
        store.db.execute("INSERT INTO model_events (at, action, model_id, previous_stable_id, evaluation_id, note) VALUES (?, 'promote', ?, ?, ?, ?)",
                         (now(), stable_id, int(previous["id"]) if previous is not None else None, int(evaluation["id"]), note))
        _write_pointer(models_root, {"model_id": stable_id, "path": str(dest), "sha256": cand["sha256"], "promoted_at": now(), "evaluation_id": int(evaluation["id"]),
                                     "previous_stable_id": int(previous["id"]) if previous is not None else None})
    return stable_id


def rollback(store: Store, models_root: Path, to_id: int, note: str | None = None) -> None:
    """Make a retired model the stable one again; the current stable model becomes retired."""
    target = store.db.execute("SELECT * FROM models WHERE id = ?", (to_id,)).fetchone()
    if target is None or target["role"] != "retired":
        raise RegistryError(f"model {to_id} is not a retired stable model")
    state = read_checkpoint(Path(target["path"]))
    if state["model_sha256"] != target["sha256"]:
        raise RegistryError(f"{target['path']} no longer holds the file that was stable as model {to_id}")
    previous = current_stable(store)
    with store._tx():
        if previous is not None:
            store.db.execute("UPDATE models SET role = 'retired' WHERE id = ?", (int(previous["id"]),))
        store.db.execute("UPDATE models SET role = 'stable' WHERE id = ?", (to_id,))
        store.db.execute("INSERT INTO model_events (at, action, model_id, previous_stable_id, evaluation_id, note) VALUES (?, 'rollback', ?, ?, ?, ?)",
                         (now(), to_id, int(previous["id"]) if previous is not None else None, target["evaluation_id"], note))
        _write_pointer(models_root, {"model_id": to_id, "path": target["path"], "sha256": target["sha256"], "promoted_at": now(), "evaluation_id": target["evaluation_id"],
                                     "previous_stable_id": int(previous["id"]) if previous is not None else None, "rollback": True})


def main(argv: list[str] | None = None) -> int:
    from . import config as cfg
    ap = argparse.ArgumentParser(prog="pokebonk_rl.registry", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--database", default=cfg.EVALUATION_DEFAULTS["paths"]["database"])
    ap.add_argument("--models", default=cfg.EVALUATION_DEFAULTS["paths"]["models"])
    sub = ap.add_subparsers(dest="command", required=True)
    sub.add_parser("list")
    r = sub.add_parser("register")
    r.add_argument("--model", required=True)
    r.add_argument("--note")
    p = sub.add_parser("promote")
    p.add_argument("--candidate", type=int, required=True)
    p.add_argument("--yes", action="store_true", help="required: promotion changes which model is the stable one")
    p.add_argument("--note")
    b = sub.add_parser("rollback")
    b.add_argument("--to", type=int, required=True)
    b.add_argument("--yes", action="store_true", help="required: rollback changes which model is the stable one")
    b.add_argument("--note")
    args = ap.parse_args(argv)
    store = Store(cfg.resolve(args.database))
    models_root = cfg.resolve(args.models)
    try:
        if args.command == "list":
            rows = store.db.execute("SELECT * FROM models ORDER BY id").fetchall()
            if not rows:
                print("no registered models")
            for m in rows:
                ev = passing_evaluation(store, m["sha256"])
                print(f"{m['id']:>4}  {m['role']:<9}  {m['sha256'][:12]}  {m['timesteps'] or 0:>10} timesteps  {'passed evaluation ' + str(ev['id']) if ev is not None else 'no passed evaluation'}  {m['path']}")
            return 0
        if args.command == "register":
            from .evaluate import resolve_model
            ckpt, _ = resolve_model(args.model, models_root, store)
            model_id = register_candidate(store, models_root, ckpt, args.note)
            print(f"registered candidate {model_id}; evaluate it with: python -m pokebonk_rl.evaluate --model candidate:{model_id}")
            return 0
        if not args.yes:
            print(f"registry: {args.command} changes which model is the stable one; repeat with --yes to do it", file=sys.stderr)
            return 2
        if args.command == "promote":
            stable_id = promote(store, models_root, args.candidate, args.note)
            print(f"model {stable_id} is now the stable model (promoted from candidate {args.candidate})")
        else:
            rollback(store, models_root, args.to, args.note)
            print(f"model {args.to} is the stable model again")
        return 0
    except (RegistryError, LookupError, FileNotFoundError, ValueError) as e:
        print(f"registry: {e}", file=sys.stderr)
        return 1
    finally:
        store.close()


if __name__ == "__main__":
    sys.exit(main())
