# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Governed transport tests: application authority lifecycle, mandate caching, cleanup, and resolver fail-closed behavior.

import asyncio
import json
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import parse_qs

import httpx

from caracalai import (
    Caracal,
    CredentialsUnavailableError,
    ResourceBinding,
)
from caracalai.advanced import ClientCredentials, from_credentials
from caracalai.errors import CoordinatorError

RESOURCE = "resource://pipernet"
UPSTREAM = "https://api.pipernet.example"


class _Platform:
    """Fake STS + coordinator behind one httpx transport, mirroring the wire
    contract the governed cycle drives: lifecycle exchange, agent spawns,
    delegation, delegated mint, and terminate."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict, dict[str, str]]] = []
        self.mints = 0
        self.spawns = 0
        self.deletes: list[str] = []
        self.delegation_status = 200

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    def handler(self, req: httpx.Request) -> httpx.Response:
        path = req.url.path
        if path == "/oauth/2/token":
            body = parse_qs(req.content.decode()) if req.content else {}
        else:
            body = json.loads(req.content) if req.content else {}
        self.calls.append((req.method, str(req.url), body, dict(req.headers.items())))
        if path == "/oauth/2/token":
            if body.get("scope") == ["agent:lifecycle"] and not body.get(
                "agent_session_id"
            ):
                return httpx.Response(
                    200, json={"access_token": "boot-token", "expires_in": 900}
                )
            self.mints += 1
            return httpx.Response(
                200,
                json={"access_token": f"mandate-{self.mints}", "expires_in": 900},
            )
        if req.method == "POST" and path.endswith("/agents"):
            self.spawns += 1
            return httpx.Response(
                200, json={"agent_session_id": f"agent-{self.spawns}"}
            )
        if req.method == "POST" and path.endswith("/delegations"):
            if self.delegation_status != 200:
                return httpx.Response(self.delegation_status, json={"error": "denied"})
            return httpx.Response(200, json={"delegation_edge_id": "edge-1"})
        if req.method == "DELETE" and "/agents/" in path:
            self.deletes.append(path.rsplit("/", 1)[-1])
            return httpx.Response(200, json={})
        return httpx.Response(404, json={"error": f"unhandled {path}"})

    def mint_forms(self) -> list[dict]:
        return [
            body
            for method, url, body, _ in self.calls
            if url.endswith("/oauth/2/token")
            and body.get("scope") != ["agent:lifecycle"]
        ]

    def spawn_calls(self) -> list[tuple[str, dict, dict[str, str]]]:
        return [
            (url, body, headers)
            for method, url, body, headers in self.calls
            if method == "POST" and url.endswith("/agents")
        ]

    def delegation_bodies(self) -> list[dict]:
        return [
            body
            for method, url, body, _ in self.calls
            if method == "POST" and url.endswith("/delegations")
        ]


_presented: set[str] = set()


def _gateway_echo(req: httpx.Request) -> httpx.Response:
    mandate = req.headers.get("authorization", "")
    if mandate in _presented:
        return httpx.Response(409, json={"error": "token_replayed"})
    _presented.add(mandate)
    return httpx.Response(
        200,
        json={
            "presented": req.headers.get("authorization", ""),
            "resource": req.headers.get("x-caracal-resource", ""),
            "target": str(req.url),
            "traceparent": req.headers.get("traceparent", ""),
            "baggage": req.headers.get("baggage", ""),
        },
    )


def _client(platform: _Platform, **overrides) -> Caracal:
    _presented.clear()
    kwargs = dict(
        coordinator_url="http://coord",
        sts_url="http://sts",
        zone_id="z",
        application_id="app",
        client_secret="secret",
        resources=[ResourceBinding(RESOURCE, UPSTREAM)],
        gateway_url="http://gateway",
        http_client=httpx.Client(transport=platform.transport()),
    )
    kwargs.update(overrides)
    if "credentials" in overrides:
        kwargs.pop("zone_id", None)
        kwargs.pop("application_id", None)
        kwargs.pop("client_secret", None)
        return from_credentials(**kwargs)
    return Caracal.from_client_secret(**kwargs)


class GovernedCycleTests(unittest.TestCase):
    def setUp(self) -> None:
        _presented.clear()

    def test_runs_the_full_cycle_and_presents_the_delegated_mandate(self) -> None:
        platform = _Platform()
        c = _client(platform)
        with c.sync_application_transport(
            RESOURCE,
            scopes=["data:read"],
            labels=["worker"],
            mandate_ttl_seconds=300,
            transport=httpx.MockTransport(_gateway_echo),
        ) as client:
            body = client.get(f"{UPSTREAM}/tasks?x=1").json()

        self.assertEqual(body["presented"], "Bearer mandate-1")
        self.assertEqual(body["resource"], RESOURCE)
        self.assertEqual(body["target"], "http://gateway/tasks?x=1")
        self.assertTrue(body["traceparent"].startswith("00-"))
        self.assertIn("caracal.agent_session=agent-2", body["baggage"])
        self.assertIn("caracal.delegation_edge=edge-1", body["baggage"])

        spawns = platform.spawn_calls()
        self.assertEqual(len(spawns), 2)
        for url, spawn_body, headers in spawns:
            self.assertEqual(url, "http://coord/zones/z/agents")
            self.assertIn("idempotency-key", headers)
            self.assertEqual(headers["authorization"], "Bearer boot-token")
            self.assertEqual(spawn_body["application_id"], "app")
            self.assertEqual(spawn_body["labels"], ["worker"])
            self.assertEqual(spawn_body["ttl_seconds"], 420)

        delegation = platform.delegation_bodies()[0]
        self.assertEqual(delegation["issuer_application_id"], "app")
        self.assertEqual(delegation["source_session_id"], "agent-1")
        self.assertEqual(delegation["target_session_id"], "agent-2")
        self.assertEqual(delegation["receiver_application_id"], "app")
        self.assertEqual(delegation["scopes"], ["data:read"])
        self.assertEqual(delegation["constraints"], {"resources": [RESOURCE]})
        self.assertEqual(delegation["ttl_seconds"], 420)

        mint = platform.mint_forms()[-1]
        self.assertEqual(mint["zone_id"], ["z"])
        self.assertEqual(mint["application_id"], ["app"])
        self.assertEqual(mint["agent_session_id"], ["agent-2"])
        self.assertEqual(mint["delegation_edge_id"], ["edge-1"])
        self.assertEqual(mint["ttl_seconds"], ["300"])
        self.assertEqual(mint["scope"], ["data:read"])
        self.assertEqual(mint["resource"], [RESOURCE])
        self.assertNotIn("subject_token", mint)

    def test_application_transport_consumes_an_approved_challenge(self) -> None:
        platform = _Platform()
        c = _client(platform)
        with c.sync_application_transport(
            RESOURCE,
            scopes=["data:read"],
            approval_id="approval-1",
            transport=httpx.MockTransport(_gateway_echo),
        ) as client:
            self.assertEqual(client.get(f"{UPSTREAM}/tasks").status_code, 200)

        self.assertEqual(platform.mint_forms()[-1]["approval_id"], ["approval-1"])

    def test_gateway_targeted_requests_pass_through(self) -> None:
        platform = _Platform()
        c = _client(platform)
        with c.sync_application_transport(
            RESOURCE,
            scopes=["data:read"],
            transport=httpx.MockTransport(_gateway_echo),
        ) as client:
            body = client.get("http://gateway/direct").json()
        self.assertEqual(body["target"], "http://gateway/direct")
        self.assertEqual(body["presented"], "Bearer mandate-1")

    def test_labels_default_to_the_application_id(self) -> None:
        platform = _Platform()
        c = _client(platform)
        with c.sync_application_transport(
            RESOURCE,
            scopes=["data:read"],
            transport=httpx.MockTransport(_gateway_echo),
        ) as client:
            client.get("http://gateway/direct")
        spawns = platform.spawn_calls()
        self.assertEqual(len(spawns), 2)
        for _, spawn_body, _ in spawns:
            self.assertEqual(spawn_body["labels"], ["app"])
            self.assertEqual(spawn_body["ttl_seconds"], 1020)

    def test_mints_a_fresh_mandate_across_requests(self) -> None:
        platform = _Platform()
        c = _client(platform)
        with c.sync_application_transport(
            RESOURCE,
            scopes=["data:read"],
            transport=httpx.MockTransport(_gateway_echo),
        ) as client:
            client.get("http://gateway/one")
            client.get("http://gateway/two")
        self.assertEqual(platform.mints, 2)
        self.assertEqual(platform.spawns, 2)

    def test_cache_separates_different_labels_and_ttls(self) -> None:
        platform = _Platform()
        c = _client(platform)
        with c.sync_application_transport(
            RESOURCE,
            scopes=["data:read"],
            labels=["worker"],
            mandate_ttl_seconds=300,
            transport=httpx.MockTransport(_gateway_echo),
        ) as client:
            client.get("http://gateway/worker")
        with c.sync_application_transport(
            RESOURCE,
            scopes=["data:read"],
            labels=["a", "b"],
            mandate_ttl_seconds=60,
            transport=httpx.MockTransport(_gateway_echo),
        ) as client:
            client.get("http://gateway/admin")

        self.assertEqual(platform.mints, 2)
        self.assertEqual(platform.spawns, 4)
        spawns = platform.spawn_calls()
        self.assertEqual(spawns[2][1]["labels"], ["a", "b"])
        self.assertEqual(spawns[2][1]["ttl_seconds"], 180)
        self.assertEqual(platform.mint_forms()[-1]["ttl_seconds"], ["60"])

    def test_concurrent_requests_share_one_cycle(self) -> None:
        platform = _Platform()
        c = _client(platform)
        with c.sync_application_transport(
            RESOURCE,
            scopes=["data:read"],
            transport=httpx.MockTransport(_gateway_echo),
        ) as client:
            with ThreadPoolExecutor(max_workers=4) as pool:
                results = list(
                    pool.map(lambda i: client.get(f"http://gateway/{i}"), range(4))
                )
        self.assertTrue(all(r.status_code == 200 for r in results))
        self.assertEqual(platform.mints, 4)
        self.assertEqual(platform.spawns, 2)

    def test_evicts_and_retires_authority_pairs_at_capacity(self) -> None:
        platform = _Platform()
        c = _client(platform)
        for index in range(20):
            with c.sync_application_transport(
                RESOURCE,
                scopes=["data:read"],
                labels=[f"worker-{index}"],
                transport=httpx.MockTransport(_gateway_echo),
            ) as client:
                client.get(f"http://gateway/{index}")
        self.assertEqual(platform.spawns, 40)
        self.assertEqual(len(platform.deletes), 2)

    def test_async_transport_runs_the_cycle(self) -> None:
        platform = _Platform()
        c = _client(platform)

        async def run() -> dict:
            async with c.application_transport(
                RESOURCE,
                scopes=["data:read"],
                transport=httpx.MockTransport(_gateway_echo),
            ) as client:
                resp = await client.get("http://gateway/direct")
                return resp.json()

        body = asyncio.run(run())
        self.assertEqual(body["presented"], "Bearer mandate-1")
        self.assertEqual(platform.spawns, 2)

    def test_terminates_sessions_sessions_when_the_cycle_fails(self) -> None:
        platform = _Platform()
        platform.delegation_status = 403
        c = _client(platform)
        with c.sync_application_transport(
            RESOURCE,
            scopes=["data:read"],
            transport=httpx.MockTransport(_gateway_echo),
        ) as client:
            with self.assertRaises(CoordinatorError):
                client.get("http://gateway/direct")
        self.assertEqual(sorted(platform.deletes), ["agent-1", "agent-2"])

    def test_aclose_terminates_sessions_backing_cached_mandates(self) -> None:
        platform = _Platform()
        c = _client(platform)
        with c.sync_application_transport(
            RESOURCE,
            scopes=["data:read"],
            transport=httpx.MockTransport(_gateway_echo),
        ) as client:
            client.get(f"{UPSTREAM}/tasks")

        asyncio.run(c.aclose())
        asyncio.run(c.aclose())
        self.assertEqual(sorted(platform.deletes), ["agent-1", "agent-2"])
        with self.assertRaisesRegex(RuntimeError, "Caracal client is closed"):
            c.gateway_request(RESOURCE, "/tasks")

    def test_aclose_rejects_inflight_and_subsequent_requests(self) -> None:
        platform = _Platform()
        first_delegation = threading.Event()
        release_first = threading.Event()

        def handler(request: httpx.Request) -> httpx.Response:
            if request.method == "POST" and request.url.path.endswith("/delegations"):
                first_delegation.set()
                release_first.wait()
            return platform.handler(request)

        c = _client(
            platform,
            http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        )

        async def run() -> None:
            async with c.application_transport(
                RESOURCE,
                scopes=["data:read"],
                transport=httpx.MockTransport(_gateway_echo),
            ) as client:
                first = asyncio.create_task(client.get("http://gateway/first"))
                closing: asyncio.Task[None] | None = None
                second: asyncio.Task[httpx.Response] | None = None
                try:
                    self.assertTrue(await asyncio.to_thread(first_delegation.wait, 5))
                    closing = asyncio.create_task(c.aclose())
                    await asyncio.sleep(0)
                    with c._app_mandate_guard:
                        self.assertEqual(c._app_generation, 1)
                    second = asyncio.create_task(client.get("http://gateway/second"))
                    release_first.set()
                finally:
                    release_first.set()
                    results = await asyncio.gather(
                        first,
                        *([second] if second is not None else []),
                        *([closing] if closing is not None else []),
                        return_exceptions=True,
                    )
                self.assertIsInstance(results[0], RuntimeError)
                self.assertIn("Caracal client is closed", str(results[0]))
                self.assertIsInstance(results[1], RuntimeError)
                self.assertIn("Caracal client is closed", str(results[1]))
                self.assertIsNone(results[2])

        asyncio.run(run())
        self.assertEqual(platform.spawns, 2)
        self.assertEqual(platform.deletes, ["agent-1", "agent-2"])


class GovernedGuardTests(unittest.TestCase):
    def test_requires_client_secret_credentials(self) -> None:
        from caracalai.advanced import CaracalConfig
        from caracalai.coordinator import CoordinatorClient

        c = Caracal(
            CaracalConfig(
                coordinator=CoordinatorClient(base_url="http://coord"),
                zone_id="z",
                application_id="app",
                subject_token="tok",
            )
        )
        with self.assertRaisesRegex(RuntimeError, "client-secret credentials"):
            c.sync_application_transport(RESOURCE, scopes=["data:read"])

    def test_requires_a_resource_id(self) -> None:
        c = _client(_Platform())
        with self.assertRaisesRegex(ValueError, "resource_id is required"):
            c.sync_application_transport("  ", scopes=["data:read"])

    def test_requires_scopes(self) -> None:
        c = _client(_Platform())
        with self.assertRaisesRegex(ValueError, "scopes are required"):
            c.sync_application_transport(RESOURCE, scopes=[])


class CredentialsResolverTests(unittest.TestCase):
    def test_resolver_client_without_resources_runs_the_cycle(self) -> None:
        platform = _Platform()
        c = _client(
            platform,
            zone_id=None,
            application_id=None,
            client_secret=None,
            resources=None,
            credentials=lambda: ClientCredentials(
                zone_id="z", application_id="app", client_secret="secret"
            ),
        )
        with c.sync_application_transport(
            RESOURCE,
            scopes=["data:read"],
            transport=httpx.MockTransport(_gateway_echo),
        ) as client:
            body = client.get("http://gateway/direct").json()
        self.assertEqual(body["presented"], "Bearer mandate-1")

    def test_fails_closed_before_any_network_call_and_recovers(self) -> None:
        platform = _Platform()
        holder: dict[str, ClientCredentials | None] = {"creds": None}
        c = _client(
            platform,
            zone_id=None,
            application_id=None,
            client_secret=None,
            resources=None,
            credentials=lambda: holder["creds"],
        )
        with c.sync_application_transport(
            RESOURCE,
            scopes=["data:read"],
            transport=httpx.MockTransport(_gateway_echo),
        ) as client:
            with self.assertRaises(CredentialsUnavailableError):
                client.get("http://gateway/direct")
            self.assertEqual(platform.calls, [])

            holder["creds"] = ClientCredentials(
                zone_id="z", application_id="app", client_secret="secret"
            )
            body = client.get("http://gateway/direct").json()
        self.assertEqual(body["presented"], "Bearer mandate-1")

    def test_identity_change_runs_a_fresh_cycle_under_the_new_identity(self) -> None:
        platform = _Platform()
        holder = {
            "creds": ClientCredentials(
                zone_id="zone-1", application_id="app-1", client_secret="cs-1"
            )
        }
        c = _client(
            platform,
            zone_id=None,
            application_id=None,
            client_secret=None,
            resources=None,
            credentials=lambda: holder["creds"],
        )
        with c.sync_application_transport(
            RESOURCE,
            scopes=["data:read"],
            transport=httpx.MockTransport(_gateway_echo),
        ) as client:
            client.get("http://gateway/one")
            holder["creds"] = ClientCredentials(
                zone_id="zone-2", application_id="app-2", client_secret="cs-2"
            )
            client.get("http://gateway/two")

        self.assertEqual(platform.mints, 2)
        self.assertEqual(platform.spawns, 4)
        last_mint = platform.mint_forms()[-1]
        self.assertEqual(last_mint["zone_id"], ["zone-2"])
        self.assertEqual(last_mint["application_id"], ["app-2"])

    def test_secret_only_rotation_runs_a_fresh_authority_cycle(self) -> None:
        platform = _Platform()
        holder = {
            "creds": ClientCredentials(
                zone_id="z", application_id="app", client_secret="secret-1"
            )
        }
        c = _client(
            platform,
            zone_id=None,
            application_id=None,
            client_secret=None,
            resources=None,
            credentials=lambda: holder["creds"],
        )
        with c.sync_application_transport(
            RESOURCE,
            scopes=["data:read"],
            transport=httpx.MockTransport(_gateway_echo),
        ) as client:
            client.get("http://gateway/one")
            holder["creds"] = ClientCredentials(
                zone_id="z", application_id="app", client_secret="secret-2"
            )
            client.get("http://gateway/two")
        self.assertEqual(platform.spawns, 4)
        self.assertEqual(platform.deletes, ["agent-1", "agent-2"])

    def test_resolver_path_does_not_accept_the_static_triple(self) -> None:
        with self.assertRaises(TypeError):
            from_credentials(
                coordinator_url="http://coord",
                sts_url="http://sts",
                credentials=lambda: ClientCredentials(
                    zone_id="z", application_id="app", client_secret="secret"
                ),
                resources=[RESOURCE],
                zone_id="z",
            )

    def test_lifecycle_paths_still_require_a_resource(self) -> None:
        c = _client(
            _Platform(),
            zone_id=None,
            application_id=None,
            client_secret=None,
            resources=None,
            credentials=lambda: ClientCredentials(
                zone_id="z", application_id="app", client_secret="secret"
            ),
        )
        with self.assertRaisesRegex(RuntimeError, "no resources configured"):
            c.config.subject_token


if __name__ == "__main__":
    unittest.main()
