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

from caracalai import (
    Caracal,
    ResourceBinding,
)
from caracalai.advanced import (
    CaracalASGIMiddleware,
    CaracalConfig,
    CoordinatorClient,
    DelegationConstraints,
    StartSessionRequest,
    HEADER_AUTHORIZATION,
    HEADER_BAGGAGE,
    HEADER_TRACEPARENT,
    BAGGAGE_AGENT_SESSION,
    BAGGAGE_HOP,
    parse_baggage,
    parse_traceparent,
    current,
    from_config,
    from_env,
)
from caracalai.coordinator import start_coordinator_session


class FromEnvTests(unittest.TestCase):
    def test_missing_raises(self) -> None:
        with self.assertRaises(RuntimeError):
            from_env({})

    def test_loads_full_env(self) -> None:
        c = from_env(
            {
                "CARACAL_ZONE_ID": "z1",
                "CARACAL_APPLICATION_ID": "a1",
                "CARACAL_BOOTSTRAP_TOKEN": "t1",
            }
        )
        self.assertEqual(c.config.zone_id, "z1")
        self.assertEqual(c.config.subject_token, "t1")
        self.assertEqual(c.config.coordinator.base_url, "http://localhost:4000")
        self.assertEqual(c.config.gateway_url, "http://localhost:8081")

    def test_does_not_inspect_local_credential_files(self) -> None:
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

            with self.assertRaisesRegex(
                RuntimeError, "provide CARACAL_APP_CLIENT_SECRET"
            ):
                from_env(
                    {
                        "XDG_CONFIG_HOME": root,
                        "CARACAL_ZONE_ID": "z",
                        "CARACAL_APPLICATION_ID": "app",
                        "CARACAL_STS_URL": "http://sts",
                    }
                )

    def test_explicit_resource_ids_are_deduplicated(self) -> None:
        c = from_env(
            {
                "CARACAL_ZONE_ID": "z",
                "CARACAL_APPLICATION_ID": "app",
                "CARACAL_APP_CLIENT_SECRET": "secret",
                "CARACAL_APP_RESOURCES": "drive,calendar",
            }
        )

        exchanger = getattr(c.config._token_source, "__self__")
        self.assertEqual(exchanger._resources, ["drive", "calendar"])

    def test_rejects_expired_jwt_subject_token(self) -> None:
        header = base64.urlsafe_b64encode(b'{"alg":"ES256"}').rstrip(b"=").decode()
        payload = (
            base64.urlsafe_b64encode(json.dumps({"exp": 1_000_000}).encode())
            .rstrip(b"=")
            .decode()
        )
        token = f"{header}.{payload}.sig"
        with self.assertRaises(RuntimeError) as cm:
            from_env(
                {
                    "CARACAL_COORDINATOR_URL": "http://x",
                    "CARACAL_ZONE_ID": "z1",
                    "CARACAL_APPLICATION_ID": "a1",
                    "CARACAL_BOOTSTRAP_TOKEN": token,
                }
            )
        self.assertIn("expired", str(cm.exception))

    def test_rejects_alg_none_subject_token(self) -> None:
        header = base64.urlsafe_b64encode(b'{"alg":"none"}').rstrip(b"=").decode()
        payload = (
            base64.urlsafe_b64encode(json.dumps({"exp": 4_000_000_000}).encode())
            .rstrip(b"=")
            .decode()
        )
        token = f"{header}.{payload}."
        with self.assertRaisesRegex(RuntimeError, 'alg "none"'):
            from_env(
                {
                    "CARACAL_COORDINATOR_URL": "http://x",
                    "CARACAL_ZONE_ID": "z1",
                    "CARACAL_APPLICATION_ID": "a1",
                    "CARACAL_BOOTSTRAP_TOKEN": token,
                }
            )

    def test_production_requires_service_urls(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "CARACAL_COORDINATOR_URL"):
            from_env(
                {
                    "CARACAL_ENV": "production",
                    "CARACAL_ZONE_ID": "z",
                    "CARACAL_APPLICATION_ID": "app",
                    "CARACAL_BOOTSTRAP_TOKEN": "tok",
                }
            )

    def test_production_restricts_http_urls_to_loopback_or_override(self) -> None:
        base = {
            "CARACAL_ENV": "production",
            "CARACAL_ZONE_ID": "z",
            "CARACAL_APPLICATION_ID": "app",
            "CARACAL_BOOTSTRAP_TOKEN": "tok",
            "CARACAL_STS_URL": "https://sts.internal",
            "CARACAL_GATEWAY_URL": "https://gateway.internal",
        }
        with self.assertRaisesRegex(RuntimeError, "must use https"):
            from_env(
                base | {"CARACAL_COORDINATOR_URL": "http://coordinator.internal:4000"}
            )
        from_env(base | {"CARACAL_COORDINATOR_URL": "http://127.0.0.1:4000"})
        from_env(
            base
            | {
                "CARACAL_COORDINATOR_URL": "http://coordinator.internal:4000",
                "CARACAL_ALLOW_INSECURE_CONFIG_URLS": "true",
            }
        )

    def test_production_client_secret_requires_https_sts(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "sts_url must use https"):
            from_env(
                {
                    "CARACAL_ENV": "production",
                    "CARACAL_COORDINATOR_URL": "https://coordinator.internal",
                    "CARACAL_GATEWAY_URL": "https://gateway.internal",
                    "CARACAL_ZONE_ID": "z",
                    "CARACAL_APPLICATION_ID": "app",
                    "CARACAL_APP_CLIENT_SECRET": "secret",
                    "CARACAL_STS_URL": "http://sts.internal:8080",
                    "CARACAL_RESOURCES": "calendar=https://api.example.com/v1",
                }
            )

    def test_client_secret_env_rejects_conflicting_sources(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "only one"):
            from_env(
                {
                    "CARACAL_ZONE_ID": "z",
                    "CARACAL_APPLICATION_ID": "app",
                    "CARACAL_APP_CLIENT_SECRET": "secret",
                    "CARACAL_APP_CLIENT_SECRET_FILE": "/tmp/secret",
                }
            )


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
                from_config(missing)

    def test_config_path_takes_precedence_over_env_credentials(self) -> None:
        with tempfile.NamedTemporaryFile("w", suffix=".toml", delete=False) as fh:
            fh.write(
                'zone_id = "z"\n'
                'application_id = "app"\n'
                'app_client_secret = "secret"\n'
                'sts_url = "https://sts.example.com"\n'
                'coordinator_url = "https://coord.example.com"\n'
                "[[credentials]]\n"
                'resource = "calendar"\n'
                'upstream_prefix = "https://api.example.com/v1"\n'
            )
            cfg_path = fh.name

        c = from_config(
            cfg_path,
            {
                "CARACAL_ZONE_ID": "other",
                "CARACAL_APPLICATION_ID": "other",
                "CARACAL_BOOTSTRAP_TOKEN": "tok",
            },
        )
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
        self.assertEqual(
            [b.resource_id for b in cfg.resources], ["long", "mid", "short"]
        )


class FromClientSecretTests(unittest.TestCase):
    def test_rejects_malformed_endpoints_at_initialization(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "absolute http or https URL"):
            Caracal.from_client_secret(
                coordinator_url="coordinator.internal:4000",
                sts_url="http://sts",
                zone_id="z",
                application_id="app",
                client_secret="secret",
            )

    def test_rejects_non_integer_default_ttl(self) -> None:
        for value in (True, 1.5):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "positive integer"):
                    Caracal.from_client_secret(
                        coordinator_url="http://coord",
                        sts_url="http://sts",
                        zone_id="z",
                        application_id="app",
                        client_secret="secret",
                        default_ttl_seconds=value,
                    )

    def test_rejects_malformed_direct_resource_binding(self) -> None:
        with self.assertRaisesRegex(ValueError, "absolute http or https URL"):
            Caracal.from_client_secret(
                coordinator_url="http://coord",
                sts_url="http://sts",
                zone_id="z",
                application_id="app",
                client_secret="secret",
                resources=[ResourceBinding("calendar", "ftp://calendar.example.com")],
            )

    def test_lifecycle_paths_require_a_resource(self) -> None:
        c = Caracal.from_client_secret(
            coordinator_url="http://coord",
            sts_url="http://sts",
            zone_id="z",
            application_id="app",
            client_secret="secret",
        )
        with self.assertRaisesRegex(RuntimeError, "no resources configured"):
            c.config.subject_token

    def test_accepts_resource_bindings_as_gateway_bindings_and_sts_resources(
        self,
    ) -> None:
        c = Caracal.from_client_secret(
            coordinator_url="http://coord",
            sts_url="http://sts",
            zone_id="z",
            application_id="app",
            client_secret="secret",
            resources=[ResourceBinding("calendar", "https://api.example.com/v1")],
            gateway_url="https://gateway.example.com/proxy",
        )
        exchanger = getattr(c.config._token_source, "__self__")
        self.assertEqual(exchanger._resources, ["calendar"])
        self.assertEqual(exchanger._scope, "agent:lifecycle")
        self.assertEqual(c.config.resources[0].resource_id, "calendar")
        self.assertIs(c.config.exchanger, exchanger)


class MintMandateTests(unittest.TestCase):
    def _client(self, handler) -> Caracal:
        return Caracal.from_client_secret(
            coordinator_url="http://coord",
            sts_url="http://sts",
            zone_id="z",
            application_id="app",
            client_secret="secret",
            resources=["resource://payments"],
            http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        )

    def test_requires_client_secret_credentials(self) -> None:
        with self.assertRaises(RuntimeError):
            _build_caracal().mint_mandate("resource://payments", ["pay:write"])

    def test_passes_explicit_context_identity(self) -> None:
        captured: list[bytes] = []

        def handler(req: httpx.Request) -> httpx.Response:
            captured.append(req.content)
            return httpx.Response(200, json={"access_token": "mandate-token"})

        from caracalai import CaracalContext

        ctx = CaracalContext(
            subject_token="tok",
            zone_id="z",
            application_id="app",
            session_id="agent_9",
            delegation_id="edge_9",
        )
        token = self._client(handler).mint_mandate(
            "resource://payments", ["pay:write"], ctx=ctx, ttl_seconds=60
        )
        self.assertEqual(token.token, "mandate-token")
        body = captured[0].decode()
        self.assertIn("agent_session_id=agent_9", body)
        self.assertIn("delegation_edge_id=edge_9", body)
        self.assertIn("ttl_seconds=60", body)

    def test_uses_bound_context_identity(self) -> None:
        captured: list[bytes] = []

        def handler(req: httpx.Request) -> httpx.Response:
            captured.append(req.content)
            return httpx.Response(200, json={"access_token": "mandate-token"})

        from caracalai import CaracalContext
        from caracalai.advanced import bind

        ctx = CaracalContext(
            subject_token="tok",
            zone_id="z",
            application_id="app",
            session_id="agent_3",
        )
        client = self._client(handler)
        bind(ctx, lambda: client.mint_mandate("resource://payments", ["pay:read"]))
        body = captured[0].decode()
        self.assertIn("agent_session_id=agent_3", body)
        self.assertNotIn("delegation_edge_id", body)

    def test_appends_lifecycle_hint_for_delegationless_session_deny(self) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(
                403, json={"error": "access_denied", "error_description": "denied"}
            )

        from caracalai import CaracalContext, CaracalError
        from caracalai.advanced import bind

        ctx = CaracalContext(
            subject_token="tok",
            zone_id="z",
            application_id="app",
            session_id="agent_3",
        )
        client = self._client(handler)
        with self.assertRaises(CaracalError) as caught:
            bind(
                ctx,
                lambda: client.mint_mandate("resource://payments", ["pay:read"]),
            )
        notes = getattr(caught.exception, "__notes__", [])
        self.assertTrue(any("lifecycle-only authority" in note for note in notes))

    def test_no_hint_when_delegation_is_bound(self) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(
                403, json={"error": "access_denied", "error_description": "denied"}
            )

        from caracalai import CaracalContext, CaracalError
        from caracalai.advanced import bind

        ctx = CaracalContext(
            subject_token="tok",
            zone_id="z",
            application_id="app",
            session_id="agent_3",
            delegation_id="edge_3",
        )
        client = self._client(handler)
        with self.assertRaises(CaracalError) as caught:
            bind(
                ctx,
                lambda: client.mint_mandate("resource://payments", ["pay:read"]),
            )
        self.assertEqual(getattr(caught.exception, "__notes__", []), [])


class FederateSubjectTests(unittest.TestCase):
    def _client(self, handler) -> Caracal:
        return Caracal.from_client_secret(
            coordinator_url="http://coord",
            sts_url="http://sts",
            zone_id="z",
            application_id="app",
            client_secret="secret",
            resources=["resource://payments"],
            http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        )

    @staticmethod
    def _subject_mandate(payload: dict[str, Any]) -> str:
        body = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=")
        return f"eyJhbGciOiJFUzI1NiJ9.{body.decode()}.sig"

    def test_requires_client_secret_credentials(self) -> None:
        with self.assertRaises(RuntimeError):
            _build_caracal().federate_subject("id-token")

    def test_returns_subject_authority_record_id_from_minted_mandate(self) -> None:
        import time as time_module

        token = self._subject_mandate(
            {
                "sid": "sess-42",
                "sub": "richard.hendricks@piedpiper.example",
                "exp": int(time_module.time()) + 600,
            }
        )
        captured: list[bytes] = []

        def handler(req: httpx.Request) -> httpx.Response:
            captured.append(req.content)
            return httpx.Response(200, json={"access_token": token})

        federated = self._client(handler).federate_subject("id-token", ttl_seconds=600)
        self.assertEqual(federated.subject_authority_record_id, "sess-42")
        self.assertEqual(federated.token, token)
        self.assertGreater(federated.expires_in_seconds, 0)
        body = captured[0].decode()
        self.assertIn("subject_token=id-token", body)
        self.assertIn(
            "subject_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aid_token",
            body,
        )
        self.assertIn("ttl_seconds=600", body)
        self.assertNotIn("resource=", body)

    def test_rejects_mandate_without_session_id(self) -> None:
        import time as time_module

        token = self._subject_mandate(
            {"sub": "user", "exp": int(time_module.time()) + 600}
        )

        def handler(_req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"access_token": token})

        with self.assertRaises(RuntimeError) as caught:
            self._client(handler).federate_subject("id-token")
        self.assertIn("carries no authority record ID", str(caught.exception))


class WithApprovalTests(unittest.IsolatedAsyncioTestCase):
    def _client(self, states: list[str]) -> Caracal:
        polled = iter(states)

        def handler(req: httpx.Request) -> httpx.Response:
            if "/step-up/" in str(req.url):
                return httpx.Response(200, json={"state": next(polled)})
            return httpx.Response(200, json={"access_token": "unused"})

        return Caracal.from_client_secret(
            coordinator_url="http://coord",
            sts_url="http://sts",
            zone_id="z",
            application_id="app",
            client_secret="secret",
            resources=["resource://payments"],
            http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        )

    async def test_retries_with_approval_id_once_approved(self) -> None:
        from caracalai import ApprovalRequired

        client = self._client(["approved"])
        calls: list[str | None] = []

        async def fn(approval_id: str | None) -> str:
            calls.append(approval_id)
            if approval_id is None:
                raise ApprovalRequired("chal_9")
            return "minted"

        result = await client.with_approval(fn, timeout_seconds=5.0)
        self.assertEqual(result, "minted")
        self.assertEqual(calls, [None, "chal_9"])

    async def test_reraises_hold_on_rejection(self) -> None:
        from caracalai import ApprovalRequired

        client = self._client(["rejected"])
        calls: list[str | None] = []

        async def fn(approval_id: str | None) -> str:
            calls.append(approval_id)
            raise ApprovalRequired("chal_9")

        with self.assertRaises(ApprovalRequired):
            await client.with_approval(fn, timeout_seconds=5.0)
        self.assertEqual(calls, [None])

    async def test_passes_other_errors_through(self) -> None:
        client = self._client([])

        async def fn(approval_id: str | None) -> str:
            raise ValueError("boom")

        with self.assertRaises(ValueError):
            await client.with_approval(fn)


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
    def test_no_context_raises_without_as_application(self) -> None:
        c = _build_caracal()
        with self.assertRaises(RuntimeError) as cm:
            c.headers()
        self.assertIn("no CaracalContext", str(cm.exception))
        self.assertIn("as_application=True", str(cm.exception))

    def test_no_context_emits_root_when_as_application_true(self) -> None:
        c = _build_caracal()
        h = c.headers(as_application=True)
        self.assertEqual(h[HEADER_AUTHORIZATION], "Bearer tok")
        self.assertIsNotNone(parse_traceparent(h[HEADER_TRACEPARENT]))
        self.assertNotIn(HEADER_BAGGAGE, h)

    async def test_bind_from_headers_runs_verifier_before_binding(self) -> None:
        c = _build_caracal()
        seen: list[str] = []

        async def verifier(token: str) -> None:
            seen.append(token)

        async with c.bind_from_headers(
            {HEADER_AUTHORIZATION: "Bearer inbound"}, verifier=verifier
        ) as ctx:
            self.assertEqual(ctx.subject_token, "inbound")
        self.assertEqual(seen, ["inbound"])

        async def rejecting(token: str) -> None:
            raise RuntimeError("revoked")

        with self.assertRaises(RuntimeError):
            async with c.bind_from_headers(
                {HEADER_AUTHORIZATION: "Bearer inbound"}, verifier=rejecting
            ):
                pass

    async def test_bind_from_headers_allows_trusted_root_and_resets_context(
        self,
    ) -> None:
        c = _build_caracal()
        async with c.bind_from_headers({}, as_application=True) as ctx:
            self.assertEqual(ctx.subject_token, "tok")
            self.assertIs(c.current(), ctx)
        self.assertIsNone(c.current())

    def test_context_middleware_factory_captures_allow_root(self) -> None:
        c = _build_caracal()

        async def app(_scope, _receive, _send):
            return None

        middleware = c.context_middleware(as_application=True)(app)
        self.assertIs(middleware.caracal, c)
        self.assertTrue(middleware.as_application)


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
            self.assertEqual(
                str(request.url), "https://gateway.example.com/proxy/events?limit=10"
            )
            self.assertEqual(request.headers["X-Caracal-Resource"], "calendar")
            self.assertEqual(request.headers[HEADER_AUTHORIZATION], "Bearer tok")
            return httpx.Response(204)

        async with c.transport(
            transport=httpx.MockTransport(handler), as_application=True
        ) as client:
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
                    ResourceBinding(
                        "treasury", "https://api.example.com/v1/accounts/treasury"
                    ),
                    ResourceBinding("accounts", "https://api.example.com/v1/accounts"),
                ],
            )
        )

        seen: list[str] = []

        async def handler(request):
            seen.append(request.headers["X-Caracal-Resource"])
            return httpx.Response(204)

        async with c.transport(
            transport=httpx.MockTransport(handler), as_application=True
        ) as client:
            await client.get("https://api.example.com/v1/accounts/treasury/balance")
            await client.get("https://api.example.com/v1/accounts/payable")
            await client.get("https://api.example.com/v1/markets/spot")

        self.assertEqual(seen, ["treasury", "accounts", "broad"])

    async def test_direct_upstream_never_receives_subject_token(self) -> None:
        c = Caracal(
            CaracalConfig(
                coordinator=CoordinatorClient(base_url="http://coord"),
                zone_id="z",
                application_id="app",
                subject_token="tok",
            )
        )
        seen = {}

        async def handler(request):
            seen["auth"] = request.headers.get(HEADER_AUTHORIZATION)
            seen["traceparent"] = request.headers.get(HEADER_TRACEPARENT)
            return httpx.Response(204)

        async with c.transport(
            transport=httpx.MockTransport(handler), as_application=True
        ) as client:
            await client.get("https://api.unbound.example.com/data")

        self.assertIsNone(seen["auth"])
        self.assertIsNotNone(parse_traceparent(seen["traceparent"]))


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
                coordinator=CoordinatorClient(
                    base_url="https://coordinator.example.com", http_client=client
                ),
                zone_id="z",
                application_id="app",
                subject_token="tok",
                default_ttl_seconds=60,
            )
        )
        events: list[str] = []

        async def on_start(ctx) -> None:
            events.append(f"start:{ctx.session_id}")

        async def on_end(ctx) -> None:
            events.append(f"end:{ctx.session_id}")

        c.on_session_start(on_start)
        c.on_session_end(on_end)

        async with c.session(metadata={"purpose": "test"}) as ctx:
            self.assertEqual(ctx.session_id, "agent-1")
            self.assertEqual(current().session_id, "agent-1")
            res = await c.delegate(
                to_session_id="agent-2",
                to_application_id="app-2",
                scopes=["tool:call"],
                constraints=DelegationConstraints(resources=["calendar"], max_depth=2),
                ttl_seconds=30,
            )
            self.assertEqual(res.delegation_id, "edge-1")
            self.assertEqual(current().session_id, "agent-1")

        await client.aclose()
        self.assertEqual(events, ["start:agent-1", "end:agent-1"])
        self.assertEqual([r.method for r in requests], ["POST", "POST", "DELETE"])
        self.assertEqual(
            json.loads(requests[0].content),
            {
                "application_id": "app",
                "ttl_seconds": 60,
                "metadata": {"purpose": "test"},
                "parent_authority": "inherit",
            },
        )
        self.assertEqual(
            json.loads(requests[1].content),
            {
                "issuer_application_id": "app",
                "source_session_id": "agent-1",
                "target_session_id": "agent-2",
                "receiver_application_id": "app-2",
                "scopes": ["tool:call"],
                "constraints": {"resources": ["calendar"], "max_depth": 2},
                "ttl_seconds": 30,
            },
        )
        self.assertIsNone(current())

    async def test_delegate_requires_active_agent_context(self) -> None:
        c = _build_caracal()

        with self.assertRaises(RuntimeError):
            await c.delegate(
                to_session_id="agent-2", to_application_id="app-2", scopes=["tool:call"]
            )

    async def test_task_option_recorded_as_metadata_task(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request):
            requests.append(request)
            if request.method == "POST" and str(request.url).endswith("/agents"):
                return httpx.Response(200, json={"agent_session_id": "agent-1"})
            return httpx.Response(204)

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        c = Caracal(
            CaracalConfig(
                coordinator=CoordinatorClient(
                    base_url="https://coordinator.example.com", http_client=client
                ),
                zone_id="z",
                application_id="app",
                subject_token="tok",
            )
        )
        async with c.session(
            task="Refund order #8412", metadata={"task": "stale", "ticket": "T-1"}
        ):
            pass
        handle = await c.start_session(
            task="Nightly PiperNet reconciliation", heartbeat_interval=0
        )
        await handle.aclose()
        await client.aclose()
        spawns = [
            r for r in requests if r.method == "POST" and str(r.url).endswith("/agents")
        ]
        self.assertEqual(
            json.loads(spawns[0].content)["metadata"],
            {"task": "Refund order #8412", "ticket": "T-1"},
        )
        self.assertEqual(
            json.loads(spawns[1].content)["metadata"],
            {"task": "Nightly PiperNet reconciliation"},
        )

    async def test_caller_operation_id_reused_across_separate_creation_calls(
        self,
    ) -> None:
        requests: list[httpx.Request] = []

        async def handler(request):
            requests.append(request)
            if request.method == "POST" and str(request.url).endswith("/agents"):
                return httpx.Response(200, json={"agent_session_id": "agent-1"})
            return httpx.Response(204)

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        c = Caracal(
            CaracalConfig(
                coordinator=CoordinatorClient(
                    base_url="https://coordinator.example.com", http_client=client
                ),
                zone_id="z",
                application_id="app",
                subject_token="tok",
            )
        )
        async with c.session(idempotency_key="queue-msg-77"):
            pass
        async with c.session(idempotency_key="queue-msg-77"):
            pass
        await client.aclose()
        keys = [
            r.headers.get("idempotency-key")
            for r in requests
            if r.method == "POST" and str(r.url).endswith("/agents")
        ]
        self.assertEqual(keys, ["queue-msg-77", "queue-msg-77"])

    async def test_unsafe_explicit_idempotency_keys_fail_before_network(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request):
            requests.append(request)
            return httpx.Response(500)

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        c = Caracal(
            CaracalConfig(
                coordinator=CoordinatorClient(
                    base_url="https://coordinator.example.com", http_client=client
                ),
                zone_id="z",
                application_id="app",
                subject_token="tok",
            )
        )
        for key in ("", " key", "key ", "key\nvalue", "x" * 256):
            with self.assertRaisesRegex(ValueError, "idempotency_key must be"):
                async with c.session(idempotency_key=key):
                    pass
        await client.aclose()
        self.assertEqual(requests, [])

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
                coordinator=CoordinatorClient(
                    base_url="https://coordinator.example.com", http_client=client
                ),
                zone_id="z",
                application_id="app",
                subject_token="tok",
            )
        )

        svc = await c.start_session(labels=["billing-worker"])
        self.assertEqual(svc.session_id, "svc-1")
        self.assertEqual(
            json.loads(requests[0].content),
            {
                "application_id": "app",
                "lifecycle": "service",
                "labels": ["billing-worker"],
                "parent_authority": "inherit",
            },
        )

        await svc.heartbeat()
        self.assertTrue(
            str(requests[1].url).endswith("/zones/z/agents/svc-1/heartbeat")
        )

        await svc.aclose()
        await client.aclose()
        self.assertEqual([r.method for r in requests], ["POST", "POST", "DELETE"])

    async def test_on_event_forwards_coordinator_events(self) -> None:
        async def handler(request):
            if request.method == "POST" and str(request.url).endswith("/agents"):
                return httpx.Response(200, json={"agent_session_id": "agent-1"})
            return httpx.Response(204)

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        c = Caracal(
            CaracalConfig(
                coordinator=CoordinatorClient(
                    base_url="https://coordinator.example.com", http_client=client
                ),
                zone_id="z",
                application_id="app",
                subject_token="tok",
            )
        )
        events = []

        def failing_sink(event) -> None:
            raise RuntimeError("sink failure")

        c.on_event(events.append)
        c.on_event(failing_sink)

        async with c.session():
            pass
        await client.aclose()

        self.assertEqual([e.type for e in events], ["coordinator.call"] * 2)
        self.assertEqual(events[0].method, "POST")
        self.assertEqual(events[0].path, "/zones/z/agents")
        self.assertTrue(events[0].ok)
        self.assertEqual(events[1].method, "DELETE")

    async def test_on_event_disposer_stops_delivery(self) -> None:
        async def handler(request):
            if request.method == "POST" and str(request.url).endswith("/agents"):
                return httpx.Response(200, json={"agent_session_id": "agent-1"})
            return httpx.Response(204)

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        c = Caracal(
            CaracalConfig(
                coordinator=CoordinatorClient(
                    base_url="https://coordinator.example.com", http_client=client
                ),
                zone_id="z",
                application_id="app",
                subject_token="tok",
            )
        )
        events = []
        remove = c.on_event(events.append)
        async with c.session():
            pass
        delivered = len(events)
        self.assertGreater(delivered, 0)
        remove()
        async with c.session():
            pass
        await client.aclose()
        self.assertEqual(len(events), delivered)

    async def test_identity_exposes_acting_identity(self) -> None:
        self.assertEqual(_build_caracal().identity(), ("z", "app"))

    async def test_attach_session_revalidates_persisted_session(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request):
            requests.append(request)
            if request.method == "DELETE":
                return httpx.Response(204)
            return httpx.Response(
                200,
                json={
                    "agent": {
                        "status": "active",
                        "heartbeat_deadline_at": "2026-07-09T12:00:00+00:00",
                    }
                },
            )

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        c = Caracal(
            CaracalConfig(
                coordinator=CoordinatorClient(
                    base_url="https://coordinator.example.com", http_client=client
                ),
                zone_id="z",
                application_id="app",
                subject_token="tok",
            )
        )
        ends: list[str] = []

        async def on_end(ctx) -> None:
            ends.append(ctx.session_id)

        c.on_session_end(on_end)
        handle = await c.attach_session("agent-persisted", heartbeat_interval=0)
        self.assertEqual(handle.session_id, "agent-persisted")
        self.assertEqual(handle.heartbeat_deadline_at, "2026-07-09T12:00:00+00:00")
        self.assertTrue(
            str(requests[0].url).endswith("/zones/z/agents/agent-persisted/heartbeat")
        )
        await handle.aclose()
        await client.aclose()
        self.assertEqual(ends, ["agent-persisted"])
        self.assertIn("DELETE", [r.method for r in requests])

    async def test_accept_delegation_validates_against_inbound_list(self) -> None:
        items = [{"id": "edge-42", "status": "active"}]

        async def handler(request):
            if "/delegations/inbound/" in str(request.url):
                return httpx.Response(200, json=items[0])
            return httpx.Response(204)

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        c = Caracal(
            CaracalConfig(
                coordinator=CoordinatorClient(
                    base_url="https://coordinator.example.com", http_client=client
                ),
                zone_id="z",
                application_id="app",
                subject_token="tok",
            )
        )
        from caracalai import CaracalContext

        ctx = CaracalContext(
            subject_token="tok", zone_id="z", application_id="app", session_id="s1"
        )
        events = []
        c.on_event(events.append)
        async with c.bind(ctx):
            async with c.accept_delegation("edge-42", validate=True) as accepted:
                self.assertEqual(accepted.delegation_id, "edge-42")

            items[0]["status"] = "revoked"
            with self.assertRaisesRegex(RuntimeError, "not live for session s1"):
                async with c.accept_delegation("edge-42", validate=True):
                    pass  # pragma: no cover

            async with c.accept_delegation("edge-77") as unchecked:
                self.assertEqual(unchecked.delegation_id, "edge-77")
        await client.aclose()

        accepts = [e for e in events if e.type == "delegation.accept"]
        self.assertEqual(
            [(e.delegation_id, e.session_id, e.ok) for e in accepts],
            [
                ("edge-42", "s1", True),
                ("edge-42", "s1", False),
                ("edge-77", "s1", True),
            ],
        )


class AsgiMiddlewareTests(unittest.IsolatedAsyncioTestCase):
    async def test_binds_inbound_envelope(self) -> None:
        c = _build_caracal()
        captured: dict[str, str] = {}

        async def app(scope, receive, send):
            ctx = current()
            captured["sub"] = ctx.subject_token
            captured["agent"] = ctx.session_id or ""
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

        mw = CaracalASGIMiddleware(app, c)
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

        async with c.transport(
            transport=httpx.MockTransport(handler), as_application=True
        ) as client:
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

        async with c.transport(
            transport=httpx.MockTransport(handler), as_application=True
        ) as client:
            await client.get(request.url, headers=request.headers)

        self.assertEqual(
            seen["url"], "https://gateway.example.com/proxy/events?limit=10"
        )
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
            as_application=True,
            transport=httpx.MockTransport(handler),
        )

        self.assertEqual(resp.status_code, 204)
        self.assertEqual(
            seen["url"], "https://gateway.example.com/proxy/events?limit=10"
        )
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
        with self.assertRaises(ValueError):
            c.gateway_request("resource://calendar", "/events/../admin")
        with self.assertRaises(ValueError):
            c.gateway_request("resource://calendar", "./events")

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

        async with c.transport(
            transport=httpx.MockTransport(handler), as_application=True
        ) as client:
            await client.get("https://other.example.com/v1/events")
        self.assertEqual(
            seen, {"url": "https://other.example.com/v1/events", "resource": None}
        )

    async def test_gateway_only_propagation_skips_third_party_hosts(self) -> None:
        calls: list[dict[str, str | None]] = []

        async def handler(request):
            calls.append(
                {
                    "url": str(request.url),
                    "traceparent": request.headers.get("traceparent"),
                    "baggage": request.headers.get("baggage"),
                }
            )
            return httpx.Response(204)

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
        async with c.transport(
            transport=httpx.MockTransport(handler),
            as_application=True,
            propagation="gateway-only",
        ) as client:
            await client.get("https://third-party.example.com/data")
            await client.get("https://api.example.com/v1/events")
        self.assertIsNone(calls[0]["traceparent"])
        self.assertIsNone(calls[0]["baggage"])
        self.assertEqual(calls[1]["url"], "https://gateway.example.com/proxy/events")
        self.assertIsNotNone(calls[1]["traceparent"])

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
            c._route_through_gateway(
                "https://api.example.com/v1/events?limit=1", "resource://calendar"
            ),
            (
                "https://gateway.example.com/proxy/v1/events?limit=1",
                "resource://calendar",
            ),
        )
        self.assertIsNone(c._route_through_gateway("not a url", None))
        self.assertIsNone(
            c._route_through_gateway(
                "https://gateway.example.com/proxy/v1/events", None
            )
        )

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

        with c.sync_transport(
            transport=httpx.MockTransport(handler), as_application=True
        ) as client:
            self.assertEqual(
                client.get("https://api.example.com/v1/events").status_code, 204
            )
        self.assertEqual(
            seen,
            {
                "url": "https://gateway.example.com/proxy/events",
                "auth": "Bearer tok",
                "resource": "calendar",
            },
        )

        with c.sync_transport(transport=httpx.MockTransport(handler)) as client:
            with self.assertRaises(RuntimeError):
                client.get("https://api.example.com/v1/events")


class ExplicitContextAndScopesTests(unittest.IsolatedAsyncioTestCase):
    """transport()/fetch()/sync_transport() honour explicit ctx= and per-call scopes=."""

    def _ctx(self):
        from caracalai import CaracalContext

        return CaracalContext(
            subject_token="child-tok",
            zone_id="z",
            application_id="app",
            session_id="agent_7",
            delegation_id="edge_7",
        )

    def _scoped_client(self, sts_calls: list[bytes]) -> Caracal:
        def sts_handler(req: httpx.Request) -> httpx.Response:
            sts_calls.append(req.content)
            return httpx.Response(200, json={"access_token": "mandate-tok"})

        return Caracal.from_client_secret(
            coordinator_url="http://coord",
            sts_url="http://sts",
            zone_id="z",
            application_id="app",
            client_secret="secret",
            resources=[ResourceBinding("calendar", "https://api.example.com/v1")],
            gateway_url="https://gateway.example.com/proxy",
            http_client=httpx.Client(transport=httpx.MockTransport(sts_handler)),
        )

    async def test_transport_uses_explicit_ctx_without_binding(self) -> None:
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
            seen["agent"] = parse_baggage(request.headers.get(HEADER_BAGGAGE)).get(
                BAGGAGE_AGENT_SESSION
            )
            return httpx.Response(204)

        async with c.transport(
            transport=httpx.MockTransport(handler), ctx=self._ctx()
        ) as client:
            resp = await client.get("https://api.example.com/v1/events")

        self.assertEqual(resp.status_code, 204)
        self.assertEqual(seen["auth"], "Bearer child-tok")
        self.assertEqual(seen["agent"], "agent_7")

    async def test_transport_scopes_mint_scoped_mandate(self) -> None:
        sts_calls: list[bytes] = []
        c = self._scoped_client(sts_calls)
        seen = {}

        async def handler(request):
            seen["auth"] = request.headers[HEADER_AUTHORIZATION]
            seen["resource"] = request.headers["X-Caracal-Resource"]
            return httpx.Response(204)

        async with c.transport(
            transport=httpx.MockTransport(handler),
            ctx=self._ctx(),
            scopes=["cal:read"],
        ) as client:
            await client.get("https://api.example.com/v1/events")

        self.assertEqual(seen["auth"], "Bearer mandate-tok")
        self.assertEqual(seen["resource"], "calendar")
        body = sts_calls[-1].decode()
        self.assertIn("scope=cal%3Aread", body)
        self.assertIn("resource=calendar", body)
        self.assertIn("agent_session_id=agent_7", body)
        self.assertIn("delegation_edge_id=edge_7", body)

    async def test_fetch_passes_ctx_and_scopes(self) -> None:
        sts_calls: list[bytes] = []
        c = self._scoped_client(sts_calls)
        seen = {}

        async def handler(request):
            seen["auth"] = request.headers[HEADER_AUTHORIZATION]
            seen["resource"] = request.headers["X-Caracal-Resource"]
            return httpx.Response(204)

        resp = await c.fetch(
            "calendar",
            "events",
            ctx=self._ctx(),
            scopes=["cal:read"],
            transport=httpx.MockTransport(handler),
        )
        self.assertEqual(resp.status_code, 204)
        self.assertEqual(seen["auth"], "Bearer mandate-tok")
        self.assertEqual(seen["resource"], "calendar")
        self.assertIn("session_id=agent_7", sts_calls[-1].decode())

    async def test_sync_transport_explicit_ctx_and_scopes(self) -> None:
        sts_calls: list[bytes] = []
        c = self._scoped_client(sts_calls)
        seen = {}

        def handler(request):
            seen["auth"] = request.headers[HEADER_AUTHORIZATION]
            return httpx.Response(204)

        with c.sync_transport(
            transport=httpx.MockTransport(handler),
            ctx=self._ctx(),
            scopes=["cal:write"],
        ) as client:
            self.assertEqual(
                client.get("https://api.example.com/v1/events").status_code, 204
            )
        self.assertEqual(seen["auth"], "Bearer mandate-tok")
        self.assertIn("scope=cal%3Awrite", sts_calls[-1].decode())

    async def test_scopes_without_credentials_raise(self) -> None:
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

        async with c.transport(
            transport=httpx.MockTransport(handler),
            ctx=self._ctx(),
            scopes=["cal:read"],
        ) as client:
            with self.assertRaises(RuntimeError) as cm:
                await client.get("https://api.example.com/v1/events")
        self.assertIn("client-secret", str(cm.exception))

    def test_headers_accept_explicit_ctx(self) -> None:
        c = _build_caracal()
        h = c.headers(ctx=self._ctx())
        self.assertEqual(h[HEADER_AUTHORIZATION], "Bearer child-tok")
        self.assertEqual(
            parse_baggage(h.get(HEADER_BAGGAGE)).get(BAGGAGE_AGENT_SESSION), "agent_7"
        )

    def test_bind_helpers_are_advanced(self) -> None:
        import caracalai
        from caracalai import advanced

        self.assertFalse(hasattr(caracalai, "bind"))
        self.assertFalse(hasattr(caracalai, "abind"))
        self.assertFalse(hasattr(caracalai, "current"))
        out = advanced.bind(self._ctx(), lambda: advanced.current().session_id)
        self.assertEqual(out, "agent_7")


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
            c = from_config(cfg_path)
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
            f"app_client_secret_file = {json.dumps(secret_file.name)}\n"
            'sts_url = "https://sts.example.com"\n'
            'coordinator_url = "https://coord.example.com"\n'
            "[[credentials]]\n"
            'resource = "calendar"\n'
            'upstream_prefix = "https://api.example.com/v1"\n'
        )

        c = from_config(cfg_path)

        self.assertEqual([b.resource_id for b in c.config.resources], ["calendar"])

    def test_from_config_unions_toml_and_env_resources(self) -> None:
        import os

        cfg_path = self._write_toml(
            'zone_id = "z"\n'
            'application_id = "a"\n'
            'app_client_secret = "s"\n'
            'sts_url = "https://sts.example.com"\n'
            'coordinator_url = "https://coord.example.com"\n'
            "[[credentials]]\n"
            'resource = "calendar"\n'
            'upstream_prefix = "https://api.example.com/v1"\n'
        )
        prev = os.environ.get("CARACAL_RESOURCES")
        os.environ["CARACAL_RESOURCES"] = "billing=https://billing.example.com/v2"
        try:
            c = from_config(cfg_path)
        finally:
            if prev is None:
                os.environ.pop("CARACAL_RESOURCES", None)
            else:
                os.environ["CARACAL_RESOURCES"] = prev
        rids = sorted(b.resource_id for b in c.config.resources)
        self.assertEqual(rids, ["billing", "calendar"])

    def test_from_config_allows_no_resource_bindings(self) -> None:
        cfg_path = self._write_toml(
            'zone_id = "z"\n'
            'application_id = "a"\n'
            'app_client_secret = "s"\n'
            'sts_url = "https://sts.example.com"\n'
            'coordinator_url = "https://coord.example.com"\n'
        )
        c = from_config(cfg_path)
        with self.assertRaisesRegex(RuntimeError, "no resources configured"):
            c.config.subject_token


class ResourceBindingsValidationTests(unittest.TestCase):
    """CP-4: malformed ``CARACAL_RESOURCES_FILE`` entries must raise."""

    def _write(self, body: str) -> str:
        import tempfile

        fh = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        fh.write(body)
        fh.close()
        return fh.name

    def test_dict_shape_loads(self) -> None:
        from caracalai.client import _load_resource_bindings_file

        bindings = _load_resource_bindings_file(
            self._write('{"calendar":"https://api.example.com/v1"}')
        )
        self.assertEqual(len(bindings), 1)
        self.assertEqual(bindings[0].resource_id, "calendar")

    def test_list_shape_loads(self) -> None:
        from caracalai.client import _load_resource_bindings_file

        bindings = _load_resource_bindings_file(
            self._write(
                '[{"resource_id":"calendar","upstream_prefix":"https://api.example.com/v1"}]'
            )
        )
        self.assertEqual(len(bindings), 1)

    def test_typo_field_raises(self) -> None:
        from caracalai.client import _load_resource_bindings_file

        path = self._write(
            '[{"resource_id":"calendar","upstreamprefix":"https://api.example.com/v1"}]'
        )
        with self.assertRaises(ValueError) as cm:
            _load_resource_bindings_file(path)
        self.assertIn("upstreamprefix", str(cm.exception))

    def test_missing_field_raises(self) -> None:
        from caracalai.client import _load_resource_bindings_file

        path = self._write('[{"resource_id":"calendar"}]')
        with self.assertRaises(ValueError) as cm:
            _load_resource_bindings_file(path)
        self.assertIn("upstream_prefix", str(cm.exception))

    def test_empty_value_raises(self) -> None:
        from caracalai.client import _load_resource_bindings_file

        path = self._write('{"calendar":""}')
        with self.assertRaises(ValueError):
            _load_resource_bindings_file(path)

    def test_invalid_url_raises(self) -> None:
        from caracalai.client import _load_resource_bindings_file

        path = self._write('{"calendar":"not-a-url"}')
        with self.assertRaises(ValueError) as cm:
            _load_resource_bindings_file(path)
        self.assertIn("absolute URL", str(cm.exception))

    def test_unsupported_top_level_raises(self) -> None:
        from caracalai.client import _load_resource_bindings_file

        with self.assertRaises(ValueError):
            _load_resource_bindings_file(self._write('"not-a-binding"'))


class ClientSecretCustomHTTPClientTests(unittest.IsolatedAsyncioTestCase):
    """Verify that from_client_secret integrates custom HTTP clients correctly."""

    async def test_from_client_secret_custom_http_client(self) -> None:
        called = False

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal called
            called = True
            return httpx.Response(
                200, json={"access_token": "abc.def.ghi", "expires_in": 3600}
            )

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
            headers = c.headers(as_application=True)
            self.assertEqual(headers[HEADER_AUTHORIZATION], "Bearer abc.def.ghi")
            self.assertTrue(called)
        finally:
            await c.aclose()
            self.assertFalse(custom_client.is_closed)
            custom_client.close()

    async def test_custom_http_transport_reaches_coordinator(self) -> None:
        urls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            urls.append(str(request.url))
            if request.url.host == "sts":
                return httpx.Response(
                    200, json={"access_token": "abc.def.ghi", "expires_in": 3600}
                )
            return httpx.Response(200, json={"agent_session_id": "session-1"})

        custom_client = httpx.Client(transport=httpx.MockTransport(handler))
        coordinator_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        c = Caracal.from_client_secret(
            coordinator_url="http://coordinator",
            sts_url="http://sts",
            zone_id="z",
            application_id="app",
            client_secret="secret",
            resources=["calendar"],
            http_client=custom_client,
            coordinator_http_client=coordinator_client,
        )

        try:
            await start_coordinator_session(
                c.config.coordinator,
                "token",
                StartSessionRequest(zone_id="z", application_id="app"),
            )
            self.assertIn("http://coordinator/zones/z/agents", urls)
        finally:
            await c.aclose()
            custom_client.close()


if __name__ == "__main__":
    unittest.main()
