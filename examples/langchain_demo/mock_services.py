"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Mock HTTP transport for outbound provider calls in demo mock mode.
"""

from __future__ import annotations

import json
from typing import Any, Optional

import httpx

_MOCK_REGISTRY: dict[str, dict] = {}


def register_mock(path: str, response_body: dict, status_code: int = 200) -> None:
    """Register a deterministic mock response for a given path prefix."""
    _MOCK_REGISTRY[path.rstrip("/")] = {"body": response_body, "status": status_code}


class MockTransport(httpx.AsyncBaseTransport):
    """Intercept outbound HTTP calls to external provider endpoints.

    Placement: after workspace selection, tool registry resolution, mandate
    validation, provider/resource/action validation, and broker request
    construction — before the real external network response is received.

    Mock mode must not bypass MCP service, authority evaluation, broker
    request-scope validation, or tool registry checks. This transport only
    substitutes the final external response.
    """

    def __init__(self, registry: Optional[dict[str, dict]] = None) -> None:
        self._registry = registry if registry is not None else _MOCK_REGISTRY

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.rstrip("/")
        entry = self._registry.get(path)
        if entry is None:
            for registered_path, reg_entry in self._registry.items():
                if path.startswith(registered_path):
                    entry = reg_entry
                    break
        if entry is None:
            entry = self._default_response(path)
        body_bytes = json.dumps(entry["body"]).encode()
        return httpx.Response(
            status_code=entry.get("status", 200),
            headers={"content-type": "application/json"},
            content=body_bytes,
            request=request,
        )

    @staticmethod
    def _default_response(path: str) -> dict:
        return {
            "body": {"status": "ok", "mock": True, "path": path},
            "status": 200,
        }


def build_mock_transport() -> MockTransport:
    """Return a MockTransport pre-loaded with demo-mode deterministic responses."""
    register_mock("/incidents", {"incidents": [], "open_count": 0, "severity": "none", "mock": True})
    register_mock("/deployments/current", {"status": "stable", "current_version": "v1.0.0-mock", "mock": True})
    register_mock("/logs", {"logs": [], "lines_returned": 0, "mock": True})
    register_mock("/recommendations", {"accepted": True, "recommendation_id": "REC-mock-001", "mock": True})
    return MockTransport()
