"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Reserved for a future WebSocket transport implementation.
"""

from __future__ import annotations

from caracal_sdk.adapters.base import BaseAdapter, SDKRequest, SDKResponse


class WebSocketAdapter(BaseAdapter):
    """Reserved for a future WebSocket transport implementation."""

    def __init__(self, url: str) -> None:
        self._url = url

    async def send(self, request: SDKRequest) -> SDKResponse:
        raise NotImplementedError("WebSocket transport is not implemented.")

    def close(self) -> None:
        pass

    @property
    def is_connected(self) -> bool:
        return False
