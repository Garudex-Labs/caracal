"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal drop-in client tests for env loading, header projection, and ASGI middleware.
"""

import json
import unittest

import httpx

from caracalai_sdk import (
    Caracal,
    CaracalASGIMiddleware,
    CaracalConfig,
    ResourceBinding,
)
from caracalai_sdk.advanced import (
    AgentKind,
    CoordinatorClient,
    DelegationConstraints,
    HEADER_AUTHORIZATION,
    HEADER_BAGGAGE,
    HEADER_TRACEPARENT,
    BAGGAGE_AGENT_SESSION,
    BAGGAGE_HOP,
    parse_baggage,
    parse_traceparent,
    current,
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


class GatewayRoutingTests(unittest.IsolatedAsyncioTestCase):
    async def test_transport_routes_bound_provider_calls_through_gateway(self) -> None:
        c = Caracal(
            CaracalConfig(
                coordinator=CoordinatorClient(base_url="http://coord"),
                zone_id="z",
                application_id="app",
                subject_token="tok",
                gateway_url="https://gateway.example.com/proxy",
                resources=[
                    ResourceBinding(
                        resource_id="calendar",
                        upstream_prefix="https://api.example.com/v1",
                    )
                ],
            )
        )

        async def handler(request):
            self.assertEqual(str(request.url), "https://gateway.example.com/proxy/events?limit=10")
            self.assertEqual(request.headers["X-Caracal-Resource"], "calendar")
            self.assertEqual(request.headers[HEADER_AUTHORIZATION], "Bearer tok")
            return httpx.Response(204)

        async with c.transport(transport=httpx.MockTransport(handler)) as client:
            response = await client.get("https://api.example.com/v1/events?limit=10")

        self.assertEqual(response.status_code, 204)


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_spawn_delegate_hooks_and_termination_flow(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request):
            requests.append(request)
            if request.method == "POST" and str(request.url).endswith("/agents"):
                return httpx.Response(200, json={"agent_session_id": "agent-1"})
            if request.method == "POST" and str(request.url).endswith("/delegations"):
                return httpx.Response(200, json={"delegation_edge_id": "edge-1"})
            if request.method == "DELETE":
                return httpx.Response(204)
            return httpx.Response(404)

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        c = Caracal(
            CaracalConfig(
                coordinator=CoordinatorClient(base_url="https://coordinator.example.com", _client=client),
                zone_id="z",
                application_id="app",
                subject_token="tok",
                default_kind=AgentKind.EPHEMERAL,
                default_ttl_seconds=60,
            )
        )
        events: list[str] = []

        async def on_start(ctx) -> None:
            events.append(f"start:{ctx.agent_session_id}")

        async def on_end(ctx) -> None:
            events.append(f"end:{ctx.agent_session_id}")

        c.on_agent_start(on_start)
        c.on_agent_end(on_end)

        async with c.spawn(metadata={"purpose": "test"}) as ctx:
            self.assertEqual(ctx.agent_session_id, "agent-1")
            self.assertEqual(current().agent_session_id, "agent-1")
            async with c.delegate(
                to="agent-2",
                to_application_id="app-2",
                scopes=["tool:call"],
                constraints=DelegationConstraints(resources=["calendar"], max_depth=2),
                ttl_seconds=30,
            ) as child:
                self.assertEqual(child.delegation_edge_id, "edge-1")
                self.assertEqual(child.hop, 1)

        await client.aclose()
        self.assertEqual(events, ["start:agent-1", "end:agent-1"])
        self.assertEqual([r.method for r in requests], ["POST", "POST", "DELETE"])
        self.assertEqual(json.loads(requests[0].content), {
            "application_id": "app",
            "kind": "ephemeral",
            "ttl_seconds": 60,
            "metadata": {"purpose": "test"},
        })
        self.assertEqual(json.loads(requests[1].content), {
            "issuer_application_id": "app",
            "source_session_id": "agent-1",
            "target_session_id": "agent-2",
            "receiver_application_id": "app-2",
            "scopes": ["tool:call"],
            "constraints": {"resources": ["calendar"], "max_depth": 2},
            "ttl_seconds": 30,
        })
        self.assertIsNone(current())

    async def test_delegate_requires_active_agent_context(self) -> None:
        c = _build_caracal()

        with self.assertRaises(RuntimeError):
            async with c.delegate(to="agent-2", to_application_id="app-2", scopes=["tool:call"]):
                pass


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
        self.assertIsNone(current())


if __name__ == "__main__":
    unittest.main()
