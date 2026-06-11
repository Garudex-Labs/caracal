"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for CaracalASGIMiddleware non-HTTP scope passthrough.
"""

from __future__ import annotations

import unittest

from caracalai.http import CaracalASGIMiddleware


class CaracalASGIMiddlewareTests(unittest.IsolatedAsyncioTestCase):
    async def test_passes_non_http_scope_to_inner_app(self) -> None:
        received: list[dict] = []

        async def app(scope, receive, send):
            received.append(scope)

        middleware = CaracalASGIMiddleware(app, None)  # type: ignore[arg-type]
        scope = {"type": "lifespan"}
        await middleware(scope, None, None)

        self.assertEqual(received, [scope])

    async def test_passes_websocket_scope_to_inner_app(self) -> None:
        received: list[dict] = []

        async def app(scope, receive, send):
            received.append(scope)

        middleware = CaracalASGIMiddleware(app, None)  # type: ignore[arg-type]
        scope = {"type": "websocket"}
        await middleware(scope, None, None)

        self.assertEqual(received, [scope])

    async def test_reraises_runtime_errors_unrelated_to_missing_token(self) -> None:
        class BrokenCaracal:
            def bind_from_headers(self, _headers, *, allow_root=False):
                class Manager:
                    async def __aenter__(self):
                        raise RuntimeError("database unavailable")

                    async def __aexit__(self, _exc_type, _exc, _tb):
                        return False

                return Manager()

        async def app(_scope, _receive, _send):
            raise AssertionError("app should not run")

        middleware = CaracalASGIMiddleware(app, BrokenCaracal())  # type: ignore[arg-type]
        scope = {"type": "http", "headers": [(b"authorization", b"Bearer tok")]}
        with self.assertRaisesRegex(RuntimeError, "database unavailable"):
            await middleware(scope, None, None)

    async def test_verifier_runs_at_boundary_then_binds(self) -> None:
        seen: dict[str, object] = {"token": None, "app": 0}

        class PassthroughCaracal:
            def bind_from_headers(self, _headers, *, allow_root=False):
                class Manager:
                    async def __aenter__(self):
                        return None

                    async def __aexit__(self, _exc_type, _exc, _tb):
                        return False

                return Manager()

        async def verifier(token: str) -> None:
            seen["token"] = token

        async def app(_scope, _receive, _send):
            seen["app"] = 1

        middleware = CaracalASGIMiddleware(
            app,
            PassthroughCaracal(),
            verifier=verifier,  # type: ignore[arg-type]
        )
        scope = {"type": "http", "headers": [(b"authorization", b"Bearer abc.def.ghi")]}
        await middleware(scope, None, None)

        self.assertEqual(seen["token"], "abc.def.ghi")
        self.assertEqual(seen["app"], 1)

    async def test_verifier_rejection_blocks_app_with_401(self) -> None:
        async def verifier(_token: str) -> None:
            raise RuntimeError("token validation failed")

        async def app(_scope, _receive, _send):
            raise AssertionError("app should not run when verification fails")

        middleware = CaracalASGIMiddleware(
            app,
            None,
            verifier=verifier,  # type: ignore[arg-type]
        )
        scope = {"type": "http", "headers": [(b"authorization", b"Bearer abc.def.ghi")]}
        with self.assertRaisesRegex(RuntimeError, "token validation failed"):
            await middleware(scope, None, None)

    async def test_verifier_missing_token_returns_401(self) -> None:
        sent: list[dict] = []

        async def send(message):
            sent.append(message)

        async def verifier(_token: str) -> None:
            raise AssertionError("verifier should not run without a token")

        async def app(_scope, _receive, _send):
            raise AssertionError("app should not run without a token")

        middleware = CaracalASGIMiddleware(
            app,
            None,
            verifier=verifier,  # type: ignore[arg-type]
        )
        scope = {"type": "http", "headers": []}
        await middleware(scope, None, send)

        self.assertEqual(sent[0]["status"], 401)


if __name__ == "__main__":
    unittest.main()
