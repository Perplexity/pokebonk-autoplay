"""The offline rule, enforced in the trainer's own process.

Training and evaluation need no network at all: the game runs in child processes that talk over pipes, metrics are
written to local files. `install_network_guard` therefore makes every non-loopback connection attempt of this Python
process fail before anything is sent, and `check_config` refuses a configuration that names a remote endpoint.
(The game processes have their own guard: src/sim, docs/environment.md §5.)
"""
from __future__ import annotations

import ipaddress
import os
import re
import socket
from typing import Any

_URL = re.compile(r"^[a-z][a-z0-9+.-]*://", re.IGNORECASE)
_installed = False
blocked: list[str] = []


class OfflineViolation(RuntimeError):
    pass


def _is_loopback(host: Any) -> bool:
    if isinstance(host, bytes):
        host = host.decode("ascii", "replace")
    if not isinstance(host, str):
        return False
    if host in ("localhost", ""):
        return host == "localhost"
    try:
        return ipaddress.ip_address(host.split("%")[0]).is_loopback
    except ValueError:
        return False


def install_network_guard() -> None:
    """After this, `socket.connect`, `connect_ex`, `sendto`, `create_connection` and `getaddrinfo` refuse anything but loopback."""
    global _installed
    if _installed:
        return
    for name in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE"):
        os.environ[name] = "1"
    os.environ["WANDB_MODE"] = "disabled"
    os.environ.setdefault("NO_PROXY", "*")

    def refuse(what: str, target: Any):
        blocked.append(f"{what} {target!r}")
        raise OfflineViolation(f"offline rule: {what} to {target!r} was refused (training and evaluation run without network)")

    def host_of(address: Any) -> Any:
        return address[0] if isinstance(address, tuple) and address else address

    real_connect, real_connect_ex, real_sendto = socket.socket.connect, socket.socket.connect_ex, socket.socket.sendto
    real_create, real_getaddrinfo = socket.create_connection, socket.getaddrinfo

    def allowed(sock: socket.socket, address: Any) -> bool:
        return sock.family not in (socket.AF_INET, socket.AF_INET6) or _is_loopback(host_of(address))

    def connect(self, address):
        if not allowed(self, address):
            refuse("connect", address)
        return real_connect(self, address)

    def connect_ex(self, address):
        if not allowed(self, address):
            refuse("connect", address)
        return real_connect_ex(self, address)

    def sendto(self, *args):
        if not allowed(self, args[-1]):
            refuse("sendto", args[-1])
        return real_sendto(self, *args)

    def create_connection(address, *args, **kwargs):
        if not _is_loopback(host_of(address)):
            refuse("connect", address)
        return real_create(address, *args, **kwargs)

    def getaddrinfo(host, *args, **kwargs):
        if host is not None and not _is_loopback(host):
            refuse("name lookup", host)
        return real_getaddrinfo(host, *args, **kwargs)

    socket.socket.connect, socket.socket.connect_ex, socket.socket.sendto = connect, connect_ex, sendto
    socket.create_connection, socket.getaddrinfo = create_connection, getaddrinfo
    _installed = True


def guard_installed() -> bool:
    return _installed


def check_config(config: Any, path: str = "config") -> None:
    """Refuse a configuration that names a URL or a remote host: nothing in training or evaluation may use one."""
    if isinstance(config, dict):
        for k, v in config.items():
            key = str(k).lower()
            if any(word in key for word in ("endpoint", "api_url", "api_key", "apikey", "remote", "webhook")) and v not in (None, "", False):
                raise OfflineViolation(f"offline rule: {path}.{k} is set ({v!r}); training and evaluation use the local game copy only")
            check_config(v, f"{path}.{k}")
    elif isinstance(config, (list, tuple)):
        for i, v in enumerate(config):
            check_config(v, f"{path}[{i}]")
    elif isinstance(config, str) and _URL.match(config) and not config.lower().startswith("file://"):
        raise OfflineViolation(f"offline rule: {path} is a URL ({config!r}); training and evaluation use the local game copy only")
