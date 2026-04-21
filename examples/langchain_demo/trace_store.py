"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Thread-safe in-memory trace aggregation for demo run observability.
"""

from __future__ import annotations

import threading
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional


@dataclass
class TraceEvent:
    timestamp: str
    run_id: str
    correlation_id: str
    workspace: str
    principal_id: str
    principal_kind: str
    tool_id: str
    result_type: str
    mode: str
    parent_principal_id: Optional[str] = None
    provider_name: Optional[str] = None
    resource_scope: Optional[str] = None
    action_scope: Optional[str] = None
    execution_mode: Optional[str] = None
    lifecycle_event: Optional[str] = None
    group_id: Optional[str] = None
    latency_ms: Optional[float] = None
    ledger_event_ids: list[str] = field(default_factory=list)
    detail: Optional[str] = None


class TraceStore:
    """Run-scoped trace aggregation backed by an in-memory deque."""

    def __init__(self, maxsize: int = 1000) -> None:
        self._lock = threading.Lock()
        self._events: deque[TraceEvent] = deque(maxlen=maxsize)
        self._by_run: dict[str, list[TraceEvent]] = {}

    def record(self, event: TraceEvent) -> None:
        with self._lock:
            self._events.append(event)
            self._by_run.setdefault(event.run_id, []).append(event)

    def get_by_run(self, run_id: str) -> list[TraceEvent]:
        with self._lock:
            return list(self._by_run.get(run_id, []))

    def recent(self, n: int = 100) -> list[TraceEvent]:
        with self._lock:
            events = list(self._events)
        return events[-n:]

    def run_ids(self) -> list[str]:
        with self._lock:
            return list(self._by_run.keys())

    def clear(self) -> None:
        with self._lock:
            self._events.clear()
            self._by_run.clear()


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
