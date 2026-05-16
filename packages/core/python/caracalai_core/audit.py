# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Centralized audit emit client for Python: HMAC-signed events to caracal.audit.events with disk-spill fallback.

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import tempfile
import threading
import time
import uuid
from collections import deque
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Protocol

from .json_types import JsonValue
from .logging import DevLogger, create_logger

AUDIT_STREAM = "caracal.audit.events"


@dataclass
class AuditEvent:
    """Canonical audit event. Mirrors packages/core/go/audit/event.go.

    JSON field names are the on-the-wire contract; do not rename.
    """
    id: str
    zone_id: str
    event_type: str
    request_id: str
    decision: str
    evaluation_status: str
    determining_policies_json: JsonValue = field(default_factory=list)
    diagnostics_json: JsonValue = field(default_factory=dict)
    occurred_at: str = ""
    policy_set_id: str | None = None
    policy_set_version_id: str | None = None
    manifest_sha: str | None = None
    metadata_json: JsonValue | None = None

    def to_wire(self) -> dict[str, JsonValue]:
        d = asdict(self)
        return {k: v for k, v in d.items() if v is not None}


class AuditStreamer(Protocol):
    """Minimal Redis-stream interface; pass redis-py or any compatible client."""
    def xadd(self, stream: str, fields: dict[str, str]) -> object: ...


class AuditClient:
    """Bounded, HMAC-signed, async-flushing audit emitter with disk fallback."""

    def __init__(
        self,
        *,
        streamer: AuditStreamer,
        replay_dir: str | os.PathLike[str],
        hmac_key: bytes | None = None,
        logger: DevLogger | None = None,
        buffer_cap: int = 10_000,
        flush_batch: int = 1_000,
        flush_ttl_ms: int = 50,
        stream: str = AUDIT_STREAM,
        production: bool = False,
        on_dropped: Callable[[int], None] | None = None,
        on_sink_error: Callable[[], None] | None = None,
        on_replay_persisted: Callable[[int], None] | None = None,
        on_replay_drained: Callable[[int], None] | None = None,
    ) -> None:
        if streamer is None:
            raise ValueError("audit: streamer is required")
        if production and not hmac_key:
            raise ValueError("audit: hmac_key is required in production")
        if hmac_key and len(hmac_key) < 32:
            raise ValueError("audit: hmac_key must be at least 32 bytes")
        self._streamer = streamer
        self._replay_dir = Path(replay_dir)
        self._hmac_key = hmac_key
        self._logger = logger or create_logger("audit", "warn")
        self._buffer_cap = buffer_cap
        self._flush_batch = flush_batch
        self._flush_ttl_ms = flush_ttl_ms
        self._stream = stream
        self._on_dropped = on_dropped
        self._on_sink_error = on_sink_error
        self._on_replay_persisted = on_replay_persisted
        self._on_replay_drained = on_replay_drained
        self._buffer: deque[AuditEvent] = deque()
        self._lock = threading.Lock()
        self._emitted = 0
        self._dropped = 0
        self._persisted = 0
        self._drained = 0
        self._sink_errors = 0
        self._closed = False
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._replay_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.replay_pending()
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, name="caracal-audit-flush", daemon=True)
            self._thread.start()

    def emit(self, event: AuditEvent) -> None:
        if self._closed:
            return
        with self._lock:
            if len(self._buffer) >= self._buffer_cap:
                self._dropped += 1
                if self._on_dropped:
                    self._on_dropped(self._dropped)
                if self._dropped == 1 or self._dropped % 1000 == 0:
                    self._logger.warn("audit buffer full", dropped=self._dropped)
                return
            self._buffer.append(event)
            self._emitted += 1

    def dropped(self) -> int:
        return self._dropped

    def snapshot(self) -> dict[str, int]:
        """Stable snapshot of audit metrics for /metrics exposure."""
        with self._lock:
            depth = len(self._buffer)
        return {
            "emitted": self._emitted,
            "dropped": self._dropped,
            "persisted": self._persisted,
            "drained": self._drained,
            "sink_errors": self._sink_errors,
            "queue_depth": depth,
            "queue_cap": self._buffer_cap,
        }

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
        self._flush_once()
        with self._lock:
            remaining = list(self._buffer)
            self._buffer.clear()
        if remaining:
            self._persist_batch(remaining)

    def _run(self) -> None:
        interval = self._flush_ttl_ms / 1000.0
        while not self._stop.wait(interval):
            self._flush_once()

    def _drain(self) -> list[AuditEvent]:
        with self._lock:
            if not self._buffer:
                return []
            n = min(len(self._buffer), self._flush_batch)
            batch = [self._buffer.popleft() for _ in range(n)]
            return batch

    def _flush_once(self) -> None:
        batch = self._drain()
        if not batch:
            return
        failed: list[AuditEvent] = []
        for ev in batch:
            try:
                self._xadd(ev)
            except Exception as exc:  # noqa: BLE001 - sink is opaque
                self._logger.error("xadd audit event", id=ev.id, err=str(exc))
                self._sink_errors += 1
                if self._on_sink_error:
                    self._on_sink_error()
                failed.append(ev)
        if failed:
            self._persist_batch(failed)

    def _sign(self, data: str) -> str | None:
        if not self._hmac_key:
            return None
        return hmac.new(self._hmac_key, data.encode("utf-8"), hashlib.sha256).hexdigest()

    def _xadd(self, ev: AuditEvent) -> None:
        data = json.dumps(ev.to_wire(), separators=(",", ":"), sort_keys=True)
        fields = {"id": ev.id, "data": data}
        sig = self._sign(data)
        if sig:
            fields["sig"] = sig
        self._streamer.xadd(self._stream, fields)

    def _persist_batch(self, batch: Iterable[AuditEvent]) -> None:
        items = list(batch)
        if not items:
            return
        nonce = secrets.token_hex(4)
        path = self._replay_dir / f"pending-{os.getpid()}-{int(time.time()*1000)}-{nonce}.ndjson"
        try:
            tmp = path.with_suffix(".ndjson.tmp")
            body = "\n".join(json.dumps(ev.to_wire(), separators=(",", ":"), sort_keys=True) for ev in items) + "\n"
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(body)
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)
            self._persisted += len(items)
            if self._on_replay_persisted:
                self._on_replay_persisted(len(items))
            self._logger.warn("audit batch persisted to disk for later replay", path=str(path), count=len(items))
        except OSError as exc:
            self._logger.error("audit replay file write", path=str(path), err=str(exc))

    def replay_pending(self) -> None:
        if not self._replay_dir.exists():
            return
        for path in sorted(self._replay_dir.glob("*.ndjson")):
            replayed = 0
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    for line in fh:
                        line = line.strip()
                        if not line:
                            continue
                        raw = json.loads(line)
                        ev = AuditEvent(
                            id=raw["id"],
                            zone_id=raw["zone_id"],
                            event_type=raw["event_type"],
                            request_id=raw["request_id"],
                            decision=raw["decision"],
                            evaluation_status=raw["evaluation_status"],
                            determining_policies_json=raw.get("determining_policies_json", []),
                            diagnostics_json=raw.get("diagnostics_json", {}),
                            occurred_at=raw.get("occurred_at", ""),
                            policy_set_id=raw.get("policy_set_id"),
                            policy_set_version_id=raw.get("policy_set_version_id"),
                            manifest_sha=raw.get("manifest_sha"),
                            metadata_json=raw.get("metadata_json"),
                        )
                        self._xadd(ev)
                        replayed += 1
                path.unlink()
                self._drained += replayed
                if self._on_replay_drained and replayed > 0:
                    self._on_replay_drained(replayed)
                self._logger.info("audit replay file drained", path=str(path), count=replayed)
            except Exception as exc:  # noqa: BLE001
                self._logger.error("audit replay file failed; will retry on next start", path=str(path), err=str(exc))


def default_replay_dir(service: str) -> str:
    return str(Path(tempfile.gettempdir()) / "caracal-audit-replay" / service)


def new_event_id() -> str:
    return str(uuid.uuid4())
