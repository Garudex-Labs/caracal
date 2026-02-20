"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

HTTP/REST transport adapter (default).
"""

from __future__ import annotations

import time
from typing import Optional

import httpx

from caracal.logging_config import get_logger
from caracal.sdk.adapters.base import BaseAdapter, SDKRequest, SDKResponse

logger = get_logger(__name__)


class HttpAdapter(BaseAdapter):
    """Default HTTP transport using ``httpx.AsyncClient``.

    Args:
        base_url: Root URL of the Caracal API (e.g. ``http://localhost:8000``).
        api_key: Optional API key added as ``Authorization: Bearer`` header.
        timeout: Request timeout in seconds.
        max_retries: Maximum retry attempts on transient failures.
    """

    def __init__(
        self,
        base_url: str,
        api_key: Optional[str] = None,
        timeout: int = 30,
        max_retries: int = 3,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._timeout = timeout
        self._max_retries = max_retries
        self._client: Optional[httpx.AsyncClient] = None
        self._connected = False

    def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None:
            headers = {}
            if self._api_key:
                headers["Authorization"] = f"Bearer {self._api_key}"
            self._client = httpx.AsyncClient(
                base_url=self._base_url,
                headers=headers,
                timeout=self._timeout,
            )
            self._connected = True
        return self._client

    async def send(self, request: SDKRequest) -> SDKResponse:
        client = self._ensure_client()
        start = time.monotonic()

        resp = await client.request(
            method=request.method,
            url=request.path,
            headers=request.headers,
            json=request.body,
            params=request.params,
        )
        elapsed = (time.monotonic() - start) * 1000

        return SDKResponse(
            status_code=resp.status_code,
            headers=dict(resp.headers),
            body=resp.json() if resp.content else None,
            elapsed_ms=round(elapsed, 2),
        )

    def close(self) -> None:
        if self._client:
            # httpx.AsyncClient.aclose() is async; for sync teardown we
            # just drop the reference — the GC will handle the sockets.
            self._client = None
            self._connected = False

    @property
    def is_connected(self) -> bool:
        return self._connected
