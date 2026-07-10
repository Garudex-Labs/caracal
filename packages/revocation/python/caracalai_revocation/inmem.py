# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# In-memory RevocationStore default with optional TTL eviction.

from __future__ import annotations

import threading
import time

DEFAULT_TTL_MS = 24 * 60 * 60 * 1000


class InMemoryRevocationStore:
    def __init__(self, default_ttl_ms: int = DEFAULT_TTL_MS) -> None:
        self._entries: dict[str, float] = {}
        self._delegation_epochs: dict[str, tuple[float, int]] = {}
        self._lock = threading.Lock()
        self._default_ttl_ms = default_ttl_ms

    def is_revoked(self, anchor_id: str) -> bool:
        with self._lock:
            expiry = self._entries.get(anchor_id)
            if expiry is None:
                return False
            if time.monotonic() * 1000 >= expiry:
                del self._entries[anchor_id]
                return False
            return True

    def mark_revoked(self, anchor_id: str, ttl_ms: int | None = None) -> None:
        with self._lock:
            ttl = self._default_ttl_ms if ttl_ms is None else ttl_ms
            self._entries[anchor_id] = time.monotonic() * 1000 + ttl

    def current_delegation_epoch(self, zone_id: str) -> int:
        with self._lock:
            return self._current_epoch_locked(zone_id)

    def mark_delegation_epoch(
        self, zone_id: str, epoch: int, ttl_ms: int | None = None
    ) -> None:
        with self._lock:
            if epoch <= self._current_epoch_locked(zone_id):
                return
            ttl = self._default_ttl_ms if ttl_ms is None else ttl_ms
            self._delegation_epochs[zone_id] = (
                time.monotonic() * 1000 + ttl,
                epoch,
            )

    def _current_epoch_locked(self, zone_id: str) -> int:
        entry = self._delegation_epochs.get(zone_id)
        if entry is None:
            return 0
        expiry, epoch = entry
        if time.monotonic() * 1000 >= expiry:
            del self._delegation_epochs[zone_id]
            return 0
        return epoch
