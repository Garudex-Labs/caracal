"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

In-process event bus keyed by run ID with full per-run history.
"""
from __future__ import annotations

import asyncio
from collections import defaultdict

from app.events.types import Event


class EventBus:
    def __init__(self) -> None:
        self._history: dict[str, list[Event]] = defaultdict(list)
        self._run_queues: dict[str, list[asyncio.Queue]] = defaultdict(list)
        self._global_queues: list[asyncio.Queue] = []

    def publish(self, event: Event) -> None:
        self._history[event.run_id].append(event)
        for q in list(self._run_queues[event.run_id]):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass
        for q in list(self._global_queues):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass

    def history(self, run_id: str) -> list[Event]:
        return list(self._history[run_id])

    def runs(self) -> list[str]:
        return list(self._history.keys())

    def subscribe(self, run_id: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=2000)
        self._run_queues[run_id].append(q)
        return q

    def unsubscribe(self, run_id: str, q: asyncio.Queue) -> None:
        queues = self._run_queues.get(run_id)
        if queues and q in queues:
            queues.remove(q)

    def subscribe_global(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=5000)
        self._global_queues.append(q)
        return q

    def unsubscribe_global(self, q: asyncio.Queue) -> None:
        if q in self._global_queues:
            self._global_queues.remove(q)


bus = EventBus()
