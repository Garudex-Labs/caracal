"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

In-memory idempotency cache keyed per provider.
"""
from __future__ import annotations

from threading import Lock

_store: dict[tuple[str, str], dict] = {}
_lock = Lock()


def get(provider: str, key: str) -> dict | None:
    with _lock:
        return _store.get((provider, key))


def put(provider: str, key: str, response: dict) -> None:
    with _lock:
        _store[(provider, key)] = response


def clear() -> None:
    with _lock:
        _store.clear()
