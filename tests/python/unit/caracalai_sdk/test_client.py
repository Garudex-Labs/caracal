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

    def test_rejects_expired_jwt_subject_token(self) -> None:
        import base64
        import json

        header = base64.urlsafe_b64encode(b'{"alg":"ES256"}').rstrip(b"=").decode()
        payload = base64.urlsafe_b64encode(
            json.dumps({"exp": 1_000_000}).encode()
        ).rstrip(b"=").decode()
        token = f"{header}.{payload}.sig"
        with self.assertRaises(RuntimeError) as cm:
            Caracal.from_env({
                "CARACAL_COORDINATOR_URL": "http://x",
                "CARACAL_ZONE_ID": "z1",
                "CARACAL_APPLICATION_ID": "a1",
                "CARACAL_SUBJECT_TOKEN": token,
            })
        self.assertIn("expired", str(cm.exception))


class ResourceBindingSortTests(unittest.TestCase):
    def test_post_init_sorts_bindings_longest_prefix_first(self) -> None:
        cfg = CaracalConfig(
            coordinator=CoordinatorClient(base_url="http://x"),
            zone_id="z",
            application_id="a",
            subject_token="t",
            resources=[
                ResourceBinding("short", "https://api.example.com/v1"),
                ResourceBinding("long", "https://api.example.com/v1/accounts/treasury"),
                ResourceBinding("mid", "https://api.example.com/v1/accounts"),
            ],
        )
        self.assertEqual([b.resource_id for b in cfg.resources], ["long", "mid", "short"])


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
    def test_no_context_raises_without_allow_root(self) -> None:
        c = _build_caracal()
        with self.assertRaises(RuntimeError) as cm:
            c.headers()
        self.assertIn("no CaracalContext", str(cm.exception))
        self.assertIn("allow_root=True", str(cm.exception))

    def test_no_context_emits_root_when_allow_root_true(self) -> None:
        c = _build_caracal()
        h = c.headers(allow_root=True)
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

        async with c.transport(transport=httpx.MockTransport(handler), allow_root=True) as client:
            response = await client.get("https://api.example.com/v1/events?limit=10")

        self.assertEqual(response.status_code, 204)

    async def test_longest_prefix_wins_when_bindings_overlap(self) -> None:
        c = Caracal(
            CaracalConfig(
                coordinator=CoordinatorClient(base_url="http://coord"),
                zone_id="z",
                application_id="app",
                subject_token="tok",
                gateway_url="https://gateway.example.com/proxy",
                resources=[
                    ResourceBinding("broad", "https://api.example.com/v1"),
                    ResourceBinding("treasury", "https://api.example.com/v1/accounts/treasury"),
                    ResourceBinding("accounts", "https://api.example.com/v1/accounts"),
                ],
            )
        )

        seen: list[str] = []

        async def handler(request):
            seen.append(request.headers["X-Caracal-Resource"])
            return httpx.Response(204)

        async with c.transport(transport=httpx.MockTransport(handler), allow_root=True) as client:
            await client.get("https://api.example.com/v1/accounts/treasury/balance")
            await client.get("https://api.example.com/v1/accounts/payable")
            await client.get("https://api.example.com/v1/markets/spot")

        self.assertEqual(seen, ["treasury", "accounts", "broad"])


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


class TransportRootGuardTests(unittest.IsolatedAsyncioTestCase):
    """CP-1: gateway-routed requests must refuse to leak the bootstrap subject."""

    async def test_transport_refuses_root_fallback_by_default(self) -> None:
        c = Caracal(
            CaracalConfig(
                coordinator=CoordinatorClient(base_url="http://coord"),
                zone_id="z",
                application_id="app",
                subject_token="tok",
                gateway_url="https://gateway.example.com/proxy",
                resources=[ResourceBinding("calendar", "https://api.example.com/v1")],
            )
        )

        async def handler(request):
            return httpx.Response(204)

        async with c.transport(transport=httpx.MockTransport(handler)) as client:
            with self.assertRaises(RuntimeError):
                await client.get("https://api.example.com/v1/events")

    async def test_transport_root_allowed_when_opted_in(self) -> None:
        c = Caracal(
            CaracalConfig(
                coordinator=CoordinatorClient(base_url="http://coord"),
                zone_id="z",
                application_id="app",
                subject_token="tok",
                gateway_url="https://gateway.example.com/proxy",
                resources=[ResourceBinding("calendar", "https://api.example.com/v1")],
            )
        )
        seen = {}

        async def handler(request):
            seen["auth"] = request.headers[HEADER_AUTHORIZATION]
            return httpx.Response(204)

        async with c.transport(transport=httpx.MockTransport(handler), allow_root=True) as client:
            await client.get("https://api.example.com/v1/events")
        self.assertEqual(seen["auth"], "Bearer tok")


class FromConfigBindingsTests(unittest.TestCase):
    """CP-2: ``from_config`` must honour ``CARACAL_RESOURCES_FILE`` like ``from_env``."""

    def _write_toml(self, body: str) -> str:
        import tempfile

        fh = tempfile.NamedTemporaryFile("w", suffix=".toml", delete=False)
        fh.write(body)
        fh.close()
        return fh.name

    def test_from_config_loads_resources_file_env_var(self) -> None:
        import os
        import tempfile

        cfg_path = self._write_toml(
            'zone_id = "z"\n'
            'application_id = "a"\n'
            'app_client_secret = "s"\n'
            'sts_url = "https://sts.example.com"\n'
            'coordinator_url = "https://coord.example.com"\n'
        )
        bindings_file = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        bindings_file.write(
            '[{"resource_id":"calendar","upstream_prefix":"https://api.example.com/v1"}]'
        )
        bindings_file.close()

        prev = os.environ.get("CARACAL_RESOURCES_FILE")
        os.environ["CARACAL_RESOURCES_FILE"] = bindings_file.name
        try:
            c = Caracal.from_config(cfg_path)
        finally:
            if prev is None:
                os.environ.pop("CARACAL_RESOURCES_FILE", None)
            else:
                os.environ["CARACAL_RESOURCES_FILE"] = prev
        rids = [b.resource_id for b in c.config.resources]
        self.assertIn("calendar", rids)

    def test_from_config_unions_toml_and_env_resources(self) -> None:
        import os

        cfg_path = self._write_toml(
            'zone_id = "z"\n'
            'application_id = "a"\n'
            'app_client_secret = "s"\n'
            'sts_url = "https://sts.example.com"\n'
            'coordinator_url = "https://coord.example.com"\n'
            '[[credentials]]\n'
            'resource = "calendar"\n'
            'upstream_prefix = "https://api.example.com/v1"\n'
        )
        prev = os.environ.get("CARACAL_RESOURCES")
        os.environ["CARACAL_RESOURCES"] = "billing=https://billing.example.com/v2"
        try:
            c = Caracal.from_config(cfg_path)
        finally:
            if prev is None:
                os.environ.pop("CARACAL_RESOURCES", None)
            else:
                os.environ["CARACAL_RESOURCES"] = prev
        rids = sorted(b.resource_id for b in c.config.resources)
        self.assertEqual(rids, ["billing", "calendar"])


class ResourceBindingsValidationTests(unittest.TestCase):
    """CP-4: malformed ``CARACAL_RESOURCES_FILE`` entries must raise."""

    def _write(self, body: str) -> str:
        import tempfile

        fh = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        fh.write(body)
        fh.close()
        return fh.name

    def test_dict_shape_loads(self) -> None:
        from caracalai_sdk.client import _load_resource_bindings_file

        bindings = _load_resource_bindings_file(
            self._write('{"calendar":"https://api.example.com/v1"}')
        )
        self.assertEqual(len(bindings), 1)
        self.assertEqual(bindings[0].resource_id, "calendar")

    def test_list_shape_loads(self) -> None:
        from caracalai_sdk.client import _load_resource_bindings_file

        bindings = _load_resource_bindings_file(
            self._write(
                '[{"resource_id":"calendar","upstream_prefix":"https://api.example.com/v1"}]'
            )
        )
        self.assertEqual(len(bindings), 1)

    def test_typo_field_raises(self) -> None:
        from caracalai_sdk.client import _load_resource_bindings_file

        path = self._write(
            '[{"resource_id":"calendar","upstreamprefix":"https://api.example.com/v1"}]'
        )
        with self.assertRaises(ValueError) as cm:
            _load_resource_bindings_file(path)
        self.assertIn("upstreamprefix", str(cm.exception))

    def test_missing_field_raises(self) -> None:
        from caracalai_sdk.client import _load_resource_bindings_file

        path = self._write('[{"resource_id":"calendar"}]')
        with self.assertRaises(ValueError) as cm:
            _load_resource_bindings_file(path)
        self.assertIn("upstream_prefix", str(cm.exception))

    def test_empty_value_raises(self) -> None:
        from caracalai_sdk.client import _load_resource_bindings_file

        path = self._write('{"calendar":""}')
        with self.assertRaises(ValueError):
            _load_resource_bindings_file(path)

    def test_unsupported_top_level_raises(self) -> None:
        from caracalai_sdk.client import _load_resource_bindings_file

        with self.assertRaises(ValueError):
            _load_resource_bindings_file(self._write('"not-a-binding"'))


if __name__ == "__main__":
    unittest.main()
