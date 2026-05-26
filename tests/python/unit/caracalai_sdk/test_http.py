"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for CaracalContextASGIMiddleware non-HTTP scope passthrough.
"""

from __future__ import annotations

import unittest

from caracalai_sdk.http import CaracalContextASGIMiddleware


class CaracalContextASGIMiddlewareTests(unittest.IsolatedAsyncioTestCase):
    async def test_passes_non_http_scope_to_inner_app(self) -> None:
        received: list[dict] = []

        async def app(scope, receive, send):
            received.append(scope)

        middleware = CaracalContextASGIMiddleware(app, None)  # type: ignore[arg-type]
        scope = {"type": "lifespan"}
        await middleware(scope, None, None)

        self.assertEqual(received, [scope])

    async def test_passes_websocket_scope_to_inner_app(self) -> None:
        received: list[dict] = []

        async def app(scope, receive, send):
            received.append(scope)

        middleware = CaracalContextASGIMiddleware(app, None)  # type: ignore[arg-type]
        scope = {"type": "websocket"}
        await middleware(scope, None, None)

        self.assertEqual(received, [scope])


if __name__ == "__main__":
    unittest.main()
