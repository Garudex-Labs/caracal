"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for CaracalASGIMiddleware boundary binding, rejection, and passthrough.
"""

from __future__ import annotations

import unittest

from caracalai import Caracal, VerifiedClaims
from caracalai.advanced import CaracalConfig
from caracalai.coordinator import CoordinatorClient
from caracalai.http import CaracalASGIMiddleware


def make_caracal() -> Caracal:
    return Caracal(
        CaracalConfig(
            coordinator=CoordinatorClient(base_url="http://coordinator"),
            zone_id="zone-1",
            application_id="app-1",
            subject_token="root-tok",
        )
    )


class CaracalASGIMiddlewareTests(unittest.IsolatedAsyncioTestCase):
    async def test_passes_non_connection_scope_to_inner_app(self) -> None:
        received: list[dict] = []

        async def app(scope, receive, send):
            received.append(scope)

        middleware = CaracalASGIMiddleware(app, None)  # type: ignore[arg-type]
        scope = {"type": "lifespan"}
        await middleware(scope, None, None)

        self.assertEqual(received, [scope])

    async def test_binds_websocket_scope_and_runs_app(self) -> None:
        seen: dict[str, object] = {}

        async def app(_scope, _receive, _send):
            ctx = middleware.caracal.current()
            seen["token"] = ctx.subject_token if ctx else None

        middleware = CaracalASGIMiddleware(app, make_caracal())
        scope = {
            "type": "websocket",
            "headers": [(b"authorization", b"Bearer ws-tok")],
        }
        await middleware(scope, None, None)

        self.assertEqual(seen["token"], "ws-tok")

    async def test_websocket_missing_token_closes_with_policy_violation(self) -> None:
        sent: list[dict] = []

        async def send(message):
            sent.append(message)

        async def app(_scope, _receive, _send):
            raise AssertionError("app should not run without a token")

        middleware = CaracalASGIMiddleware(app, make_caracal())
        scope = {"type": "websocket", "headers": []}
        await middleware(scope, None, send)

        self.assertEqual(sent, [{"type": "websocket.close", "code": 1008}])

    async def test_boundary_failures_answer_401(self) -> None:
        sent: list[dict] = []

        async def send(message):
            sent.append(message)

        async def app(_scope, _receive, _send):
            raise AssertionError("app should not run when binding fails")

        async def verifier(_token: str) -> None:
            raise RuntimeError("token validation failed")

        middleware = CaracalASGIMiddleware(app, make_caracal(), verifier=verifier)
        scope = {"type": "http", "headers": [(b"authorization", b"Bearer abc.def.ghi")]}
        await middleware(scope, None, send)

        self.assertEqual(sent[0]["status"], 401)
        self.assertIn(b"invalid_token", sent[1]["body"])

    async def test_missing_token_returns_401(self) -> None:
        sent: list[dict] = []

        async def send(message):
            sent.append(message)

        async def verifier(_token: str) -> None:
            raise AssertionError("verifier should not run without a token")

        async def app(_scope, _receive, _send):
            raise AssertionError("app should not run without a token")

        middleware = CaracalASGIMiddleware(app, make_caracal(), verifier=verifier)
        scope = {"type": "http", "headers": []}
        await middleware(scope, None, send)

        self.assertEqual(sent[0]["status"], 401)
        self.assertIn(b"missing_token", sent[1]["body"])

    async def test_verifier_runs_at_boundary_then_binds(self) -> None:
        seen: dict[str, object] = {"token": None, "app": 0}

        async def verifier(token: str) -> None:
            seen["token"] = token

        async def app(_scope, _receive, _send):
            seen["app"] = 1

        middleware = CaracalASGIMiddleware(app, make_caracal(), verifier=verifier)
        scope = {"type": "http", "headers": [(b"authorization", b"Bearer abc.def.ghi")]}
        await middleware(scope, None, None)

        self.assertEqual(seen["token"], "abc.def.ghi")
        self.assertEqual(seen["app"], 1)

    async def test_verified_claims_override_envelope(self) -> None:
        seen: dict[str, object] = {}

        async def verifier(_token: str) -> VerifiedClaims:
            return VerifiedClaims(
                zone_id="zone-proved",
                session_id="agent-proved",
                hop=3,
            )

        async def app(_scope, _receive, _send):
            ctx = middleware.caracal.current()
            assert ctx is not None
            seen["claims"] = (ctx.zone_id, ctx.session_id, ctx.hop)

        middleware = CaracalASGIMiddleware(app, make_caracal(), verifier=verifier)
        scope = {
            "type": "http",
            "headers": [
                (b"authorization", b"Bearer abc.def.ghi"),
                (b"baggage", b"caracal.agent_session=forged,caracal.hop=9"),
            ],
        }
        await middleware(scope, None, None)

        self.assertEqual(seen["claims"], ("zone-proved", "agent-proved", 3))

    async def test_app_errors_propagate_unchanged(self) -> None:
        async def app(_scope, _receive, _send):
            raise RuntimeError("handler blew up")

        middleware = CaracalASGIMiddleware(app, make_caracal())
        scope = {"type": "http", "headers": [(b"authorization", b"Bearer tok")]}
        with self.assertRaisesRegex(RuntimeError, "handler blew up"):
            await middleware(scope, None, None)


if __name__ == "__main__":
    unittest.main()
