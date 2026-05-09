"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal drop-in client tests for env loading, header projection, and ASGI middleware.
"""

import unittest

from caracalai_sdk import (
    Caracal,
    CaracalASGIMiddleware,
    CaracalConfig,
)
from caracalai_sdk.advanced import (
    CoordinatorClient,
    HEADER_AUTHORIZATION,
    HEADER_BAGGAGE,
    HEADER_TRACEPARENT,
    BAGGAGE_AGENT_SESSION,
    BAGGAGE_HOP,
    parse_baggage,
    parse_traceparent,
    current,
    try_current,
)


class FromEnvTests(unittest.TestCase):
    def test_missing_raises(self) -> None:
        with self.assertRaises(RuntimeError):
            Caracal.from_env({})

    def test_loads_full_env(self) -> None:
        c = Caracal.from_env(
            {
                "CARACAL_COORDINATOR_URL": "http://x",
                "CARACAL_ZONE_ID": "z1",
                "CARACAL_APPLICATION_ID": "a1",
                "CARACAL_SUBJECT_TOKEN": "t1",
            }
        )
        self.assertEqual(c.config.zone_id, "z1")
        self.assertEqual(c.config.subject_token, "t1")


def _build_caracal() -> Caracal:
    return Caracal(
        CaracalConfig(
            coordinator=CoordinatorClient(base_url="http://coord"),
            zone_id="z",
            application_id="app",
            subject_token="tok",
        )
    )


class HeadersTests(unittest.TestCase):
    def test_no_context_falls_back_to_subject_token(self) -> None:
        c = _build_caracal()
        h = c.headers()
        self.assertEqual(h[HEADER_AUTHORIZATION], "Bearer tok")
        self.assertIsNotNone(parse_traceparent(h[HEADER_TRACEPARENT]))
        self.assertEqual(parse_baggage(h.get(HEADER_BAGGAGE)).get(BAGGAGE_HOP), "0")


class AsgiMiddlewareTests(unittest.IsolatedAsyncioTestCase):
    async def test_binds_inbound_envelope(self) -> None:
        c = _build_caracal()
        captured: dict[str, str] = {}

        async def app(scope, receive, send):
            ctx = current()
            captured["sub"] = ctx.subject_token
            captured["agent"] = ctx.agent_session_id or ""
            captured["hop"] = str(ctx.hop)

        mw = CaracalASGIMiddleware(app, c)
        scope = {
            "type": "http",
            "headers": [
                (HEADER_AUTHORIZATION.encode(), b"Bearer inbound"),
                (
                    HEADER_TRACEPARENT.encode(),
                    b"00-0123456789abcdef0123456789abcdef-aabbccddeeff0011-01",
                ),
                (
                    HEADER_BAGGAGE.encode(),
                    f"{BAGGAGE_AGENT_SESSION}=sess9,{BAGGAGE_HOP}=3".encode(),
                ),
            ],
        }

        async def receive() -> dict[str, str]:
            return {"type": "http.request"}

        async def send(_msg) -> None:
            return None

        await mw(scope, receive, send)
        self.assertEqual(captured, {"sub": "inbound", "agent": "sess9", "hop": "3"})
        self.assertIsNone(try_current())


if __name__ == "__main__":
    unittest.main()
