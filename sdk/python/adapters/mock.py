"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Mock transport adapter for local testing.
"""

from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

from caracal.sdk.adapters.base import BaseAdapter, SDKRequest, SDKResponse


class MockAdapter(BaseAdapter):
    """In-memory mock adapter for unit tests.

    Args:
        responses: Mapping from ``(method, path)`` tuples to
            ``SDKResponse`` instances.

    Example::

        adapter = MockAdapter({
            ("GET", "/agents"): SDKResponse(status_code=200, body=[]),
        })
    """

    def __init__(
        self,
        responses: Optional[Dict[Tuple[str, str], SDKResponse]] = None,
    ) -> None:
        self._responses: Dict[Tuple[str, str], SDKResponse] = responses or {}
        self._sent: list[SDKRequest] = []

    async def send(self, request: SDKRequest) -> SDKResponse:
        self._sent.append(request)
        key = (request.method.upper(), request.path)
        if key in self._responses:
            return self._responses[key]
        return SDKResponse(
            status_code=404,
            headers={},
            body={"error": "not mocked"},
            elapsed_ms=0.0,
        )

    def close(self) -> None:
        self._responses.clear()
        self._sent.clear()

    @property
    def is_connected(self) -> bool:
        return True

    @property
    def sent_requests(self) -> list[SDKRequest]:
        """All requests that have been sent through this adapter."""
        return list(self._sent)
