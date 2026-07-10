# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Zone-scoped JWKS cache with 5-min TTL.

import asyncio
import ipaddress
import os
import time
from urllib.parse import urlencode, urlsplit
import httpx
from caracalai_core import JsonValue

_TTL = 300.0
_MAX_JWKS_BYTES = 256 * 1024
_FETCH_TIMEOUT = 5.0


def _assert_secure_issuer(issuer: str) -> None:
    parts = urlsplit(issuer)
    if parts.scheme == "https":
        return
    if parts.scheme == "http":
        insecure_allowed = (
            _is_loopback_host(parts.hostname)
            or os.environ.get("CARACAL_ALLOW_INSECURE_CONFIG_URLS") == "true"
        )
        if insecure_allowed:
            return
    raise ValueError(f"insecure issuer scheme: {parts.scheme or '<none>'}")


def _is_loopback_host(host: str | None) -> bool:
    if host is None:
        return False
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


class JwksCache:
    def __init__(self, http_client: httpx.AsyncClient | None = None) -> None:
        self._cache: dict[
            tuple[str, str], tuple[list[dict[str, JsonValue]], float]
        ] = {}
        self._locks: dict[tuple[str, str], asyncio.Lock] = {}
        self._locks_guard = asyncio.Lock()
        self._http_client = http_client

    async def _lock_for(self, key: tuple[str, str]) -> asyncio.Lock:
        async with self._locks_guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = asyncio.Lock()
                self._locks[key] = lock
            return lock

    async def get_keys(self, issuer: str, zone_id: str) -> list[dict[str, JsonValue]]:
        _assert_secure_issuer(issuer)
        if not zone_id:
            raise ValueError("zone_id required: STS serves one signing keyset per zone")
        url = (
            issuer.rstrip("/")
            + "/.well-known/jwks.json?"
            + urlencode({"zone_id": zone_id})
        )
        key = (issuer, zone_id)
        entry = self._cache.get(key)
        if entry and time.monotonic() - entry[1] < _TTL:
            return entry[0]

        # Per-(issuer, zone) lock coalesces concurrent fetches: the second
        # caller waits, then reads the freshly-cached entry instead of
        # re-fetching.
        lock = await self._lock_for(key)
        async with lock:
            entry = self._cache.get(key)
            if entry and time.monotonic() - entry[1] < _TTL:
                return entry[0]

            if self._http_client is None:
                async with httpx.AsyncClient(timeout=_FETCH_TIMEOUT) as client:
                    resp = await client.get(url)
            else:
                resp = await self._http_client.get(url, timeout=_FETCH_TIMEOUT)
            resp.raise_for_status()
            if len(resp.content) > _MAX_JWKS_BYTES:
                raise ValueError("JWKS document too large")
            body = resp.json()

            keys = body.get("keys", []) if isinstance(body, dict) else []
            keys = [k for k in keys if isinstance(k, dict)]
            self._cache[key] = (keys, time.monotonic())
            return keys
