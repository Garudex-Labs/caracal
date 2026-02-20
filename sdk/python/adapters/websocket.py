"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

WebSocket transport adapter (placeholder — coming in v0.4).
"""

from __future__ import annotations

from caracal.sdk.adapters.base import BaseAdapter, SDKRequest, SDKResponse


class WebSocketAdapter(BaseAdapter):
    """Real-time WebSocket transport (not yet implemented).

    Args:
        url: WebSocket endpoint (e.g. ``wss://caracal.internal:8443``).
    """

    def __init__(self, url: str) -> None:
        self._url = url

    async def send(self, request: SDKRequest) -> SDKResponse:
        raise NotImplementedError("WebSocket adapter coming in v0.4")

    def close(self) -> None:
        pass

    @property
    def is_connected(self) -> bool:
        return False
