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
        self._lock = threading.Lock()
        self._default_ttl_ms = default_ttl_ms

    def is_revoked(self, sid: str) -> bool:
        with self._lock:
            expiry = self._entries.get(sid)
            if expiry is None:
                return False
            if time.monotonic() * 1000 >= expiry:
                del self._entries[sid]
                return False
            return True

    def mark_revoked(self, sid: str, ttl_ms: int | None = None) -> None:
        with self._lock:
            ttl = self._default_ttl_ms if ttl_ms is None else ttl_ms
            self._entries[sid] = time.monotonic() * 1000 + ttl
