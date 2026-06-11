"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

In-process event bus keyed by run ID with full per-run history.
"""
from __future__ import annotations

import asyncio
import logging
import os
from collections import defaultdict
from pathlib import Path

from app.events.types import Event

log = logging.getLogger("lynx.events")


class EventBus:
    def __init__(self) -> None:
        self._history: dict[str, list[Event]] = defaultdict(list)
        self._run_queues: dict[str, list[asyncio.Queue]] = defaultdict(list)
        self._global_queues: list[asyncio.Queue] = []
        self._loop: asyncio.AbstractEventLoop | None = None
        self._dropped_events = 0
        log_dir = os.getenv("LYNX_EVENT_LOG_DIR", "").strip()
        self._log_dir: Path | None = Path(log_dir) if log_dir else None
        if self._log_dir:
            self._log_dir.mkdir(parents=True, exist_ok=True)

    def publish(self, event: Event) -> None:
        """Record and fan out one event. Publishers run on the server loop, in
        executor threads, and in stream consumer threads; asyncio queues are not
        thread-safe, so off-loop publishes marshal the fan-out onto the loop the
        subscribers wait on."""
        self._history[event.run_id].append(event)
        self._persist(event)
        loop = self._loop
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if loop is not None and running is not loop and loop.is_running():
            loop.call_soon_threadsafe(self._fanout, event)
        else:
            self._fanout(event)

    def _fanout(self, event: Event) -> None:
        for q in list(self._run_queues[event.run_id]):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                self._dropped_events += 1
        for q in list(self._global_queues):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                self._dropped_events += 1

    def _persist(self, event: Event) -> None:
        if not self._log_dir:
            return
        try:
            with (self._log_dir / f"{event.run_id}.jsonl").open("a", encoding="utf-8") as fh:
                fh.write(event.model_dump_json() + "\n")
        except OSError as exc:
            log.warning("event log write failed for %s: %s", event.run_id, exc)

    def history(self, run_id: str) -> list[Event]:
        return list(self._history[run_id])

    def runs(self) -> list[str]:
        return list(self._history.keys())

    def dropped_events(self) -> int:
        return self._dropped_events

    def subscribe(self, run_id: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=2000)
        self._loop = asyncio.get_running_loop()
        self._run_queues[run_id].append(q)
        return q

    def unsubscribe(self, run_id: str, q: asyncio.Queue) -> None:
        queues = self._run_queues.get(run_id)
        if queues and q in queues:
            queues.remove(q)

    def subscribe_global(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=5000)
        self._loop = asyncio.get_running_loop()
        self._global_queues.append(q)
        return q

    def unsubscribe_global(self, q: asyncio.Queue) -> None:
        if q in self._global_queues:
            self._global_queues.remove(q)


bus = EventBus()
