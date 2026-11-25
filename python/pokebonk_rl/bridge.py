"""One headless game environment in a Node process, driven over its stdin / stdout pipes.

The protocol is described at the top of src/ipc/server.ts. No socket is involved.
"""
from __future__ import annotations

import json
import queue
import struct
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

REPO = Path(__file__).resolve().parents[2]
SERVER = "src/ipc/server.ts"
IPC_PROTOCOL = 1


class WorkerError(RuntimeError):
    """The environment process reported an error, exited, or did not answer in time."""

    def __init__(self, message: str, kind: str = "episode-error", details: dict[str, Any] | None = None):
        super().__init__(message)
        self.kind = kind
        self.details = details or {}


@dataclass
class Frame:
    """An observation reply: its header and the three arrays of its payload."""
    header: dict[str, Any]
    float: np.ndarray
    int: np.ndarray
    mask: np.ndarray

    @property
    def done(self) -> bool:
        return bool(self.header["term"] or self.header["trunc"])


def _read_exact(stream, n: int) -> bytes | None:
    chunks, got = [], 0
    while got < n:
        b = stream.read(n - got)
        if not b:
            return None
        chunks.append(b)
        got += len(b)
    return chunks[0] if len(chunks) == 1 else b"".join(chunks)


class NodeWorker:
    """A Node process holding one environment.

    Requests are written at once and never block on the reply, so several can be in flight on different workers; a
    thread per worker reads the replies into a queue (pipes cannot be polled on Windows).
    """

    def __init__(self, env: dict[str, Any], *, record_decisions: bool = False, log_path: Path | None = None,
                 node: str = "node", repo: Path = REPO, worker_id: int = 0, view: bool = False, manager: dict[str, Any] | None = None):
        self.worker_id = worker_id
        # Manager mode (src/hybrid): a step is one action id; the reply's payload is the manager's observation and mask.
        self.manager = None if manager is None else dict(manager)
        self.manager_metadata: dict[str, Any] | None = None
        self.env_options = dict(env)
        self.log_path = log_path
        self._log = open(log_path, "ab") if log_path else subprocess.DEVNULL
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        self.proc = subprocess.Popen([node, SERVER], cwd=str(repo), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=self._log, creationflags=flags, bufsize=0)
        self._frames: queue.Queue = queue.Queue()
        self._reader = threading.Thread(target=self._read_loop, name=f"pokebonk-worker-{worker_id}", daemon=True)
        self._reader.start()
        self.episodes = 0          # episodes started in this process
        self.rss_mb = 0
        self.pid: int | None = None
        self.metadata: dict[str, Any] | None = None
        self.closed = False
        self._hello_seen = False
        init: dict[str, Any] = {"cmd": "init", "env": self.env_options, "recordDecisions": record_decisions}
        if view:
            init["view"] = True   # every observation reply then carries `v`, a top-down picture (watch.py)
        if self.manager is not None:
            init["manager"] = self.manager
        self.send(init)

    # ---------------------------------------------------------------- pipes

    def _read_loop(self) -> None:
        out = self.proc.stdout
        try:
            while True:
                head = _read_exact(out, 8)
                if head is None:
                    break
                json_len, bin_len = struct.unpack("<II", head)
                body = _read_exact(out, json_len + bin_len)
                if body is None:
                    break
                self._frames.put((json.loads(body[:json_len].decode("utf-8")), body[json_len:]))
        except Exception as e:  # noqa: BLE001  (reported to the consumer, which decides)
            self._frames.put(e)
        self._frames.put(None)

    def send(self, header: dict[str, Any]) -> None:
        data = json.dumps(header, separators=(",", ":")).encode("utf-8")
        try:
            self.proc.stdin.write(struct.pack("<II", len(data), 0) + data)
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError) as e:
            raise WorkerError(f"worker {self.worker_id}: its process is gone ({e})", "worker-exit", self._diagnostics()) from e

    def ready(self) -> bool:
        """True when a reply is waiting (a `recv` would not block)."""
        return not self._frames.empty()

    def _diagnostics(self) -> dict[str, Any]:
        d: dict[str, Any] = {"pid": self.pid, "exitCode": self.proc.poll(), "episodesInProcess": self.episodes}
        if self.log_path and Path(self.log_path).exists():
            try:
                d["stderrTail"] = Path(self.log_path).read_text("utf-8", errors="replace")[-4000:]
            except OSError:
                pass
        return d

    def _next(self, timeout: float | None) -> tuple[dict[str, Any], bytes]:
        try:
            item = self._frames.get(timeout=timeout)
        except queue.Empty:
            raise WorkerError(f"worker {self.worker_id}: no reply within {timeout:.0f} s", "worker-timeout", self._diagnostics()) from None
        if item is None:
            self._frames.put(None)
            raise WorkerError(f"worker {self.worker_id}: the process ended (exit code {self.proc.poll()})", "worker-exit", self._diagnostics())
        if isinstance(item, Exception):
            raise WorkerError(f"worker {self.worker_id}: unreadable reply: {item}", "worker-exit", self._diagnostics())
        header, payload = item
        if header.get("t") == "error":
            raise WorkerError(f"{header.get('name')}: {header.get('message')}", "episode-error",
                              {"stack": header.get("stack"), "details": header.get("details"), "seed": header.get("seed"), "step": header.get("step"), **self._diagnostics()})
        return header, payload

    def recv(self, timeout: float | None = None) -> Frame:
        """The next observation reply (the `hello` of a new process is consumed on the way)."""
        header, payload = self._next(timeout)
        if header.get("t") == "hello":
            if header.get("protocol") != IPC_PROTOCOL:
                raise WorkerError(f"worker {self.worker_id}: protocol {header.get('protocol')}, this trainer speaks {IPC_PROTOCOL}", "worker-start")
            self.pid, self._hello_seen = header.get("pid"), True
            header, payload = self._next(timeout)
        if header.get("t") != "obs":
            raise WorkerError(f"worker {self.worker_id}: unexpected reply {header.get('t')!r}", "worker-exit", self._diagnostics())
        nf, ni, nm = header["n"]
        if len(payload) != 4 * nf + 4 * ni + nm:
            raise WorkerError(f"worker {self.worker_id}: payload of {len(payload)} bytes does not match sizes {header['n']}", "worker-exit")
        f = np.frombuffer(payload, dtype="<f4", count=nf, offset=0)
        i = np.frombuffer(payload, dtype="<i4", count=ni, offset=4 * nf)
        m = np.frombuffer(payload, dtype=np.uint8, count=nm, offset=4 * nf + 4 * ni)
        self.rss_mb = int(header.get("rss", 0))
        if "metadata" in header:
            self.metadata = header["metadata"]
        if "manager" in header:
            self.manager_metadata = header["manager"]
        return Frame(header, f, i, m)

    # ---------------------------------------------------------------- requests

    def request_reset(self, seed: int, species: int | None = None, map: str | None = None, tier: int | None = None) -> None:  # noqa: A002
        req: dict[str, Any] = {"cmd": "reset", "seed": int(seed)}
        if species is not None:
            req["species"] = int(species)
        if map is not None:
            req["map"] = map
        if tier is not None:
            req["tier"] = int(tier)
        self.episodes += 1
        self.send(req)

    def request_step(self, action) -> None:
        if self.manager is not None:
            self.send({"cmd": "step", "m": int(action)})
        else:
            self.send({"cmd": "step", "a": [int(x) for x in action]})

    def reset(self, seed: int, timeout: float | None = 600, **scenario) -> Frame:
        self.request_reset(seed, **scenario)
        return self.recv(timeout)

    def step(self, action, timeout: float | None = 300) -> Frame:
        self.request_step(action)
        return self.recv(timeout)

    # ---------------------------------------------------------------- end

    def close(self, grace: float = 5.0) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            if self.proc.poll() is None:
                try:
                    self.send({"cmd": "close"})
                    self.proc.wait(timeout=grace)
                except (WorkerError, subprocess.TimeoutExpired):
                    self.proc.kill()
                    self.proc.wait(timeout=10)
        finally:
            for s in (self.proc.stdin, self.proc.stdout):
                try:
                    s.close()
                except OSError:
                    pass
            if self._log is not subprocess.DEVNULL:
                self._log.close()

    def kill(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
        self.close(grace=0.1)

    def __del__(self):  # best effort: never leave a game process behind
        try:
            if not self.closed and self.proc.poll() is None:
                self.proc.kill()
        except Exception:  # noqa: BLE001
            pass


def default_env_options(**over) -> dict[str, Any]:
    """Environment options of the owner's decisions: Ranked rules, 60 Hz, 3 simulation steps per decision."""
    base = {"hz": 60, "actionRepeat": 3, "maxGameTime": 0, "species": 155, "map": "forest", "tier": 0, "ranked": True}
    base.update(over)
    return base
