"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal drop-in client tests for env loading, header projection, and ASGI middleware.
"""

import base64
import json
import os
import tempfile
import unittest
from pathlib import Path
from typing import Any

import httpx

from caracalai_sdk import (
    Caracal,
    CaracalContextASGIMiddleware,
    CaracalConfig,
    ResourceBinding,
)
from caracalai_sdk.advanced import (
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
                "CARACAL_ZONE_ID": "z1",
                "CARACAL_APPLICATION_ID": "a1",
                "CARACAL_SUBJECT_TOKEN": "t1",
            }
        )
        self.assertEqual(c.config.zone_id, "z1")
        self.assertEqual(c.config.subject_token, "t1")
        self.assertEqual(c.config.coordinator.base_url, "http://localhost:4000")
        self.assertEqual(c.config.gateway_url, "http://localhost:8081")

    def test_auto_detects_local_credential_files(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            credential_dir = Path(root) / "caracal" / "runtime" / "z" / "app"
            credential_dir.mkdir(parents=True)
            secret = credential_dir / "client-secret"
            credentials = credential_dir / "credentials.json"
            secret.write_text("secret\n")
            credentials.write_text(json.dumps([{"resource": "calendar"}]))
            if os.name != "nt":
                secret.chmod(0o600)
                credentials.chmod(0o600)

            c = Caracal.from_env(
                {
                    "XDG_CONFIG_HOME": root,
                    "CARACAL_ZONE_ID": "z",
                    "CARACAL_APPLICATION_ID": "app",
                    "CARACAL_STS_URL": "http://sts",
                }
            )

        exchanger = getattr(c.config._token_source, "__self__")
        self.assertEqual(exchanger._client_secret, "secret")
        self.assertEqual(exchanger._resources, ["calendar"])

    def test_env_manifest_keeps_explicit_resource_ids(self) -> None:
        c = Caracal.from_env(
            {
                "CARACAL_ZONE_ID": "z",
                "CARACAL_APPLICATION_ID": "app",
                "CARACAL_APP_CLIENT_SECRET": "secret",
                "CARACAL_RUN_CREDENTIALS": json.dumps([{"resource": "calendar"}]),
                "CARACAL_APP_RESOURCES": "drive,calendar",
            }
        )

        exchanger = getattr(c.config._token_source, "__self__")
        self.assertEqual(exchanger._resources, ["calendar", "drive"])

    def test_rejects_expired_jwt_subject_token(self) -> None:
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

    def test_production_requires_service_urls(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "CARACAL_COORDINATOR_URL"):
            Caracal.from_env({
                "NODE_ENV": "production",
                "CARACAL_ZONE_ID": "z",
                "CARACAL_APPLICATION_ID": "app",
                "CARACAL_SUBJECT_TOKEN": "tok",
            })

    def test_client_secret_env_rejects_conflicting_sources(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "only one"):
            Caracal.from_env({
                "CARACAL_ZONE_ID": "z",
                "CARACAL_APPLICATION_ID": "app",
                "CARACAL_APP_CLIENT_SECRET": "secret",
                "CARACAL_APP_CLIENT_SECRET_FILE": "/tmp/secret",
            })

    def test_credential_manifest_rejects_conflicts_and_bad_shapes(self) -> None:
        base = {
            "CARACAL_ZONE_ID": "z",
            "CARACAL_APPLICATION_ID": "app",
            "CARACAL_APP_CLIENT_SECRET": "secret",
        }
        with self.assertRaisesRegex(RuntimeError, "only one"):
            Caracal.from_env({
                **base,
                "CARACAL_RUN_CREDENTIALS": "[]",
                "CARACAL_RUN_CREDENTIALS_FILE": "/tmp/credentials.json",
            })
        with self.assertRaisesRegex(RuntimeError, "must be an array or object"):
            Caracal.from_env({**base, "CARACAL_RUN_CREDENTIALS": '"bad"'})
        with self.assertRaisesRegex(RuntimeError, "credentials\\[0\\]\\.resource"):
            Caracal.from_env({**base, "CARACAL_RUN_CREDENTIALS": "[{}]"})


class ConfigTests(unittest.TestCase):
    def test_config_requires_exactly_one_token_source(self) -> None:
        coordinator = CoordinatorClient(base_url="http://coord")
        with self.assertRaises(ValueError):
            CaracalConfig(coordinator=coordinator, zone_id="z", application_id="app")
        with self.assertRaises(ValueError):
            CaracalConfig(
                coordinator=coordinator,
                zone_id="z",
                application_id="app",
                subject_token="tok",
                token_source=lambda: "fresh",
            )

    def test_token_source_is_read_when_subject_token_is_requested(self) -> None:
        calls: list[int] = []
        cfg = CaracalConfig(
            coordinator=CoordinatorClient(base_url="http://coord"),
            zone_id="z",
            application_id="app",
            token_source=lambda: calls.append(1) or "fresh",
        )
        self.assertEqual(cfg.subject_token, "fresh")
        self.assertEqual(calls, [1])


class AutoDetectTests(unittest.TestCase):
    def test_missing_explicit_env_config_path_raises(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            missing = Path(root) / "missing.toml"
            with self.assertRaisesRegex(RuntimeError, "not found"):
                Caracal(env={"CARACAL_CONFIG": str(missing)})

    def test_config_path_takes_precedence_over_env_credentials(self) -> None:
        with tempfile.NamedTemporaryFile("w", suffix=".toml", delete=False) as fh:
            fh.write(
                'zone_id = "z"\n'
                'application_id = "app"\n'
                'app_client_secret = "secret"\n'
                'sts_url = "https://sts.example.com"\n'
                'coordinator_url = "https://coord.example.com"\n'
                '[[credentials]]\n'
                'resource = "calendar"\n'
                'upstream_prefix = "https://api.example.com/v1"\n'
            )
            cfg_path = fh.name

        c = Caracal(config_path=cfg_path, env={
            "CARACAL_ZONE_ID": "other",
            "CARACAL_APPLICATION_ID": "other",
            "CARACAL_SUBJECT_TOKEN": "tok",
        })
        self.assertEqual(c.config.zone_id, "z")


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


class FromClientSecretTests(unittest.TestCase):
    def test_requires_at_least_one_resource(self) -> None:
        with self.assertRaises(ValueError):
            Caracal.from_client_secret(
                coordinator_url="http://coord",
                sts_url="http://sts",
                zone_id="z",
                application_id="app",
                client_secret="secret",
                resources=[],
            )

    def test_accepts_resource_bindings_as_gateway_bindings_and_sts_resources(self) -> None:
        c = Caracal.from_client_secret(
            coordinator_url="http://coord",
            sts_url="http://sts",
            zone_id="z",
            application_id="app",
            client_secret="secret",
            resources=[ResourceBinding("calendar", "https://api.example.com/v1")],
            gateway_url="https://gateway.example.com/proxy",
            scope="custom",
        )
        exchanger = getattr(c.config._token_source, "__self__")
        self.assertEqual(exchanger._resources, ["calendar"])
        self.assertEqual(exchanger._scope, "custom")
        self.assertEqual(c.config.resources[0].resource_id, "calendar")


def _build_caracal() -> Caracal:
    return Caracal(
        CaracalConfig(
            coordinator=CoordinatorClient(base_url="http://coord"),
            zone_id="z",
            application_id="app",
            subject_token="tok",
        )
    )


class HeadersTests(unittest.IsolatedAsyncioTestCase):
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

    async def test_bind_from_headers_allows_trusted_root_and_resets_context(self) -> None:
        c = _build_caracal()
        async with c.bind_from_headers({}, allow_root=True) as ctx:
            self.assertEqual(ctx.subject_token, "tok")
            self.assertIs(c.current(), ctx)
        self.assertIsNone(c.current())

    def test_context_middleware_factory_captures_allow_root(self) -> None:
        c = _build_caracal()

        async def app(_scope, _receive, _send):
            return None

        middleware = c.context_middleware(allow_root=True)(app)
        self.assertIs(middleware.caracal, c)
        self.assertTrue(middleware.allow_root)


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

    async def test_service_heartbeats_and_does_not_auto_terminate(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request):
            requests.append(request)
            if request.method == "POST" and str(request.url).endswith("/agents"):
                return httpx.Response(200, json={"agent_session_id": "svc-1"})
            if request.method == "POST" and str(request.url).endswith("/heartbeat"):
                return httpx.Response(200, json={"agent": {"id": "svc-1"}})
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
            )
        )

        svc = await c.service(labels=["billing-worker"])
        self.assertEqual(svc.agent_session_id, "svc-1")
        self.assertEqual(json.loads(requests[0].content), {
            "application_id": "app",
            "lifecycle": "service",
            "labels": ["billing-worker"],
        })

        await svc.heartbeat()
        self.assertTrue(str(requests[1].url).endswith("/zones/z/agents/svc-1/heartbeat"))

        await svc.aclose()
        await client.aclose()
        self.assertEqual([r.method for r in requests], ["POST", "POST", "DELETE"])


class AsgiMiddlewareTests(unittest.IsolatedAsyncioTestCase):
    async def test_binds_inbound_envelope(self) -> None:
        c = _build_caracal()
        captured: dict[str, str] = {}

        async def app(scope, receive, send):
            ctx = current()
            captured["sub"] = ctx.subject_token
            captured["agent"] = ctx.agent_session_id or ""
            captured["hop"] = str(ctx.hop)

        mw = CaracalContextASGIMiddleware(app, c)
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

        async def receive() -> dict[str, Any]:
            return {"type": "http.request"}

        async def send(_msg) -> None:
            return None

        await mw(scope, receive, send)
        self.assertEqual(captured, {"sub": "inbound", "agent": "sess9", "hop": "3"})
        self.assertIsNone(current())

    async def test_rejects_missing_bearer(self) -> None:
        c = _build_caracal()
        sent: list[dict] = []

        async def app(scope, receive, send):
            raise AssertionError("app should not run")

        mw = CaracalContextASGIMiddleware(app, c)
        scope = {"type": "http", "headers": []}

        async def receive() -> dict[str, Any]:
            return {"type": "http.request"}

        async def send(msg) -> None:
            sent.append(msg)

        await mw(scope, receive, send)
        self.assertEqual(sent[0]["status"], 401)


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

    async def test_gateway_request_builds_explicit_gateway_target(self) -> None:
        c = Caracal(
            CaracalConfig(
                coordinator=CoordinatorClient(base_url="http://coord"),
                zone_id="z",
                application_id="app",
                subject_token="tok",
                gateway_url="https://gateway.example.com/proxy",
            )
        )
        request = c.gateway_request("resource://calendar", "events?limit=10")
        seen = {}

        async def handler(http_request):
            seen["url"] = str(http_request.url)
            seen["resource"] = http_request.headers["X-Caracal-Resource"]
            seen["auth"] = http_request.headers[HEADER_AUTHORIZATION]
            return httpx.Response(204)

        async with c.transport(transport=httpx.MockTransport(handler), allow_root=True) as client:
            await client.get(request.url, headers=request.headers)

        self.assertEqual(seen["url"], "https://gateway.example.com/proxy/events?limit=10")
        self.assertEqual(seen["resource"], "resource://calendar")
        self.assertEqual(seen["auth"], "Bearer tok")

    async def test_fetch_composes_gateway_request_and_transport(self) -> None:
        c = Caracal(
            CaracalConfig(
                coordinator=CoordinatorClient(base_url="http://coord"),
                zone_id="z",
                application_id="app",
                subject_token="tok",
                gateway_url="https://gateway.example.com/proxy",
            )
        )
        seen = {}

        async def handler(http_request):
            seen["url"] = str(http_request.url)
            seen["method"] = http_request.method
            seen["resource"] = http_request.headers["X-Caracal-Resource"]
            seen["content_type"] = http_request.headers["content-type"]
            seen["auth"] = http_request.headers[HEADER_AUTHORIZATION]
            return httpx.Response(204)

        resp = await c.fetch(
            "resource://calendar",
            "events?limit=10",
            method="POST",
            headers={"content-type": "application/json"},
            allow_root=True,
            transport=httpx.MockTransport(handler),
        )

        self.assertEqual(resp.status_code, 204)
        self.assertEqual(seen["url"], "https://gateway.example.com/proxy/events?limit=10")
        self.assertEqual(seen["method"], "POST")
        self.assertEqual(seen["resource"], "resource://calendar")
        self.assertEqual(seen["content_type"], "application/json")
        self.assertEqual(seen["auth"], "Bearer tok")

    async def test_gateway_request_rejects_invalid_inputs(self) -> None:
        c = Caracal(
            CaracalConfig(
                coordinator=CoordinatorClient(base_url="http://coord"),
                zone_id="z",
                application_id="app",
                subject_token="tok",
                gateway_url="https://gateway.example.com/proxy",
            )
        )
        with self.assertRaises(RuntimeError):
            _build_caracal().gateway_request("resource://calendar", "/events")
        with self.assertRaises(ValueError):
            c.gateway_request("", "/events")
        with self.assertRaises(ValueError):
            c.gateway_request("resource://calendar", "https://api.example.com/events")

    async def test_unmatched_provider_call_is_not_routed(self) -> None:
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
            seen["url"] = str(request.url)
            seen["resource"] = request.headers.get("X-Caracal-Resource")
            return httpx.Response(204)

        async with c.transport(transport=httpx.MockTransport(handler), allow_root=True) as client:
            await client.get("https://other.example.com/v1/events")
        self.assertEqual(seen, {"url": "https://other.example.com/v1/events", "resource": None})

    async def test_explicit_unbound_resource_routes_to_gateway(self) -> None:
        c = Caracal(
            CaracalConfig(
                coordinator=CoordinatorClient(base_url="http://coord"),
                zone_id="z",
                application_id="app",
                subject_token="tok",
                gateway_url="https://gateway.example.com/proxy",
                resources=[],
            )
        )
        self.assertEqual(
            c._route_through_gateway("https://api.example.com/v1/events?limit=1", "resource://calendar"),
            ("https://gateway.example.com/proxy/v1/events?limit=1", "resource://calendar"),
        )
        self.assertIsNone(c._route_through_gateway("not a url", None))
        self.assertIsNone(c._route_through_gateway("https://gateway.example.com/proxy/v1/events", None))

    async def test_sync_transport_routes_and_enforces_root_guard(self) -> None:
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

        def handler(request):
            seen["url"] = str(request.url)
            seen["auth"] = request.headers[HEADER_AUTHORIZATION]
            seen["resource"] = request.headers["X-Caracal-Resource"]
            return httpx.Response(204)

        with c.sync_transport(transport=httpx.MockTransport(handler), allow_root=True) as client:
            self.assertEqual(client.get("https://api.example.com/v1/events").status_code, 204)
        self.assertEqual(seen, {
            "url": "https://gateway.example.com/proxy/events",
            "auth": "Bearer tok",
            "resource": "calendar",
        })

        with c.sync_transport(transport=httpx.MockTransport(handler)) as client:
            with self.assertRaises(RuntimeError):
                client.get("https://api.example.com/v1/events")


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

    def test_from_config_reads_client_secret_file(self) -> None:
        import os
        import tempfile

        secret_file = tempfile.NamedTemporaryFile("w", delete=False)
        secret_file.write("secret-from-file\n")
        secret_file.close()
        if os.name != "nt":
            os.chmod(secret_file.name, 0o400)
        cfg_path = self._write_toml(
            'zone_id = "z"\n'
            'application_id = "a"\n'
            f'app_client_secret_file = "{secret_file.name}"\n'
            'sts_url = "https://sts.example.com"\n'
            'coordinator_url = "https://coord.example.com"\n'
            '[[credentials]]\n'
            'resource = "calendar"\n'
            'upstream_prefix = "https://api.example.com/v1"\n'
        )

        c = Caracal.from_config(cfg_path)

        self.assertEqual([b.resource_id for b in c.config.resources], ["calendar"])

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

    def test_from_config_requires_resource_bindings(self) -> None:
        cfg_path = self._write_toml(
            'zone_id = "z"\n'
            'application_id = "a"\n'
            'app_client_secret = "s"\n'
            'sts_url = "https://sts.example.com"\n'
            'coordinator_url = "https://coord.example.com"\n'
        )
        with self.assertRaises(RuntimeError) as cm:
            Caracal.from_config(cfg_path)
        self.assertIn("at least one resource binding", str(cm.exception))


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

    def test_invalid_url_raises(self) -> None:
        from caracalai_sdk.client import _load_resource_bindings_file

        path = self._write('{"calendar":"not-a-url"}')
        with self.assertRaises(ValueError) as cm:
            _load_resource_bindings_file(path)
        self.assertIn("absolute URL", str(cm.exception))

    def test_unsupported_top_level_raises(self) -> None:
        from caracalai_sdk.client import _load_resource_bindings_file

        with self.assertRaises(ValueError):
            _load_resource_bindings_file(self._write('"not-a-binding"'))


class ClientSecretCustomHTTPClientTests(unittest.IsolatedAsyncioTestCase):
    """Verify that from_client_secret integrates custom HTTP clients correctly."""

    async def test_from_client_secret_custom_http_client(self) -> None:
        called = False

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal called
            called = True
            return httpx.Response(200, json={"access_token": "abc.def.ghi", "expires_in": 3600})

        custom_transport = httpx.MockTransport(handler)
        custom_client = httpx.Client(transport=custom_transport)

        c = Caracal.from_client_secret(
            coordinator_url="http://coord",
            sts_url="http://sts",
            zone_id="z",
            application_id="app",
            client_secret="secret",
            resources=["calendar"],
            http_client=custom_client,
        )

        try:
            headers = c.headers(allow_root=True)
            self.assertEqual(headers[HEADER_AUTHORIZATION], "Bearer abc.def.ghi")
            self.assertTrue(called)
        finally:
            await c.close()
            self.assertFalse(custom_client.is_closed)
            custom_client.close()


if __name__ == "__main__":
    unittest.main()
