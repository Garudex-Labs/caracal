"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

HTTP/REST transport adapter (default).
"""

from __future__ import annotations

import time
from typing import Optional

import httpx

from caracal_sdk._compat import get_logger
from caracal_sdk.adapters.base import BaseAdapter, SDKRequest, SDKResponse

logger = get_logger(__name__)


class HttpAdapter(BaseAdapter):
    """Default HTTP transport using ``httpx.AsyncClient``.

    Args:
        base_url: Root URL of the Caracal API (e.g. ``http://localhost:8000``).
        api_key: Optional API key added as ``Authorization: Bearer`` header.
        timeout: Request timeout in seconds.
        max_retries: Maximum retry attempts on transient failures.
        transport: Optional httpx transport override (e.g. ``MockTransport`` for
            intercepting outbound responses beneath broker request construction).
    """

    def __init__(
        self,
        base_url: str,
        api_key: Optional[str] = None,
        timeout: int = 30,
        max_retries: int = 3,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._timeout = timeout
        self._max_retries = max_retries
        self._transport = transport
        self._client: Optional[httpx.AsyncClient] = None
        self._connected = False

    def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None:
            headers = {}
            if self._api_key:
                headers["Authorization"] = f"Bearer {self._api_key}"
            kwargs: dict = dict(
                base_url=self._base_url,
                headers=headers,
                timeout=self._timeout,
            )
            if self._transport is not None:
                kwargs["transport"] = self._transport
            self._client = httpx.AsyncClient(**kwargs)
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
