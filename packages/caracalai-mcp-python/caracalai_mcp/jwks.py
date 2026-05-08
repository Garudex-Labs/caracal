# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# JWKS cache with 5-min TTL for Python MCP middleware.

import asyncio
import time
import httpx
from typing import Any

_TTL = 300.0


class JwksCache:
    def __init__(self) -> None:
        self._cache: dict[str, tuple[list[dict[str, Any]], float]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._locks_guard = asyncio.Lock()

    async def _lock_for(self, issuer: str) -> asyncio.Lock:
        async with self._locks_guard:
            lock = self._locks.get(issuer)
            if lock is None:
                lock = asyncio.Lock()
                self._locks[issuer] = lock
            return lock

    async def get_keys(self, issuer: str) -> list[dict[str, Any]]:
        url = issuer.rstrip("/") + "/.well-known/jwks.json"
        entry = self._cache.get(issuer)
        if entry and time.monotonic() - entry[1] < _TTL:
            return entry[0]

        # Per-issuer lock coalesces concurrent fetches: the second caller
        # waits, then reads the freshly-cached entry instead of re-fetching.
        lock = await self._lock_for(issuer)
        async with lock:
            entry = self._cache.get(issuer)
            if entry and time.monotonic() - entry[1] < _TTL:
                return entry[0]

            async with httpx.AsyncClient() as client:
                resp = await client.get(url)
                resp.raise_for_status()
                body = resp.json()

            keys: list[dict[str, Any]] = body.get("keys", [])
            self._cache[issuer] = (keys, time.monotonic())
            return keys
