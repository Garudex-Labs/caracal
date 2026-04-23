"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Cooperative cancellation registry: maps run_id to an asyncio.Event that the
swarm checks between turns so a user-initiated stop terminates the run
without corrupting in-flight LLM/tool calls.
"""
from __future__ import annotations

import asyncio
from threading import Lock


class CancelRegistry:
    def __init__(self) -> None:
        self._events: dict[str, asyncio.Event] = {}
        self._lock = Lock()

    def register(self, run_id: str) -> asyncio.Event:
        with self._lock:
            ev = self._events.get(run_id)
            if ev is None:
                ev = asyncio.Event()
                self._events[run_id] = ev
            return ev

    def cancel(self, run_id: str) -> bool:
        with self._lock:
            ev = self._events.get(run_id)
        if ev is None:
            return False
        ev.set()
        return True

    def is_cancelled(self, run_id: str) -> bool:
        with self._lock:
            ev = self._events.get(run_id)
        return bool(ev and ev.is_set())

    def clear(self, run_id: str) -> None:
        with self._lock:
            self._events.pop(run_id, None)


cancellation = CancelRegistry()
