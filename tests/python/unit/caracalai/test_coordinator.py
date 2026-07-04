"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Coordinator REST client unit tests: spawn, heartbeat, delegate, and terminate flows.
"""

import unittest

import httpx

from caracalai.coordinator import (
    Lifecycle,
    CoordinatorClient,
    DelegationConstraints,
    DelegationRequest,
    SpawnRequest,
    create_delegation,
    heartbeat_agent,
    spawn_agent,
    terminate_agent,
)
from caracalai.errors import CoordinatorError


def _client(handler) -> CoordinatorClient:
    return CoordinatorClient(
        base_url="http://coordinator.test",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


class SpawnAgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_returns_agent_session_id_from_response(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"agent_session_id": "agent-1"})

        res = await spawn_agent(
            _client(handler),
            "tok",
            SpawnRequest(zone_id="z", application_id="app"),
        )
        self.assertEqual(res.agent_session_id, "agent-1")

    async def test_raises_on_http_error(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json={"error": "internal"})

        with self.assertRaises(CoordinatorError) as caught:
            await spawn_agent(
                _client(handler),
                "tok",
                SpawnRequest(zone_id="z", application_id="app"),
            )
        self.assertEqual(caught.exception.status, 500)
        self.assertEqual(caught.exception.method, "POST")
        self.assertIn("internal", caught.exception.body)

    async def test_raises_when_response_has_no_id(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"other": "field"})

        with self.assertRaises(ValueError):
            await spawn_agent(
                _client(handler),
                "tok",
                SpawnRequest(zone_id="z", application_id="app"),
            )

    async def test_parses_heartbeat_deadline_and_quotes_zone(self) -> None:
        captured: list[httpx.Request] = []

        async def handler(req: httpx.Request) -> httpx.Response:
            captured.append(req)
            return httpx.Response(
                200,
                json={
                    "agent_session_id": "a-1",
                    "heartbeat_deadline_at": "2026-07-04T00:02:00+00:00",
                },
            )

        res = await spawn_agent(
            _client(handler),
            "tok",
            SpawnRequest(zone_id="z/1", application_id="app"),
        )
        self.assertEqual(res.heartbeat_deadline_at, "2026-07-04T00:02:00+00:00")
        self.assertEqual(captured[0].url.raw_path.decode(), "/zones/z%2F1/agents")

    async def test_base_url_trailing_slash_is_normalized(self) -> None:
        captured: list[httpx.Request] = []

        async def handler(req: httpx.Request) -> httpx.Response:
            captured.append(req)
            return httpx.Response(200, json={"agent_session_id": "a-1"})

        c = CoordinatorClient(
            base_url="http://coordinator.test/",
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        await spawn_agent(c, "tok", SpawnRequest(zone_id="z", application_id="app"))
        self.assertEqual(str(captured[0].url), "http://coordinator.test/zones/z/agents")

    async def test_sends_optional_fields_when_set(self) -> None:
        captured: list[dict] = []

        async def handler(req: httpx.Request) -> httpx.Response:
            import json

            captured.append(json.loads(req.content))
            return httpx.Response(200, json={"agent_session_id": "a-1"})

        await spawn_agent(
            _client(handler),
            "tok",
            SpawnRequest(
                zone_id="z",
                application_id="app",
                subject_session_id="sid-1",
                parent_id="parent-1",
                lifecycle=Lifecycle.SERVICE,
                ttl_seconds=60,
                metadata={"purpose": "test"},
                labels=["refunds.execute", "ledger.read"],
            ),
        )
        body = captured[0]
        self.assertEqual(body["subject_session_id"], "sid-1")
        self.assertEqual(body["parent_id"], "parent-1")
        self.assertEqual(body["lifecycle"], "service")
        self.assertEqual(body["ttl_seconds"], 60)
        self.assertEqual(body["metadata"], {"purpose": "test"})
        self.assertEqual(body["labels"], ["refunds.execute", "ledger.read"])

    async def test_no_idempotency_key_when_not_supplied(self) -> None:
        captured: list[httpx.Request] = []

        async def handler(req: httpx.Request) -> httpx.Response:
            captured.append(req)
            return httpx.Response(200, json={"agent_session_id": "a-1"})

        await spawn_agent(
            _client(handler),
            "tok",
            SpawnRequest(
                zone_id="z",
                application_id="app",
                subject_session_id="sid-1",
                parent_id="parent-1",
            ),
        )
        self.assertNotIn("idempotency-key", captured[0].headers)

    async def test_explicit_idempotency_key_sent(self) -> None:
        captured: list[httpx.Request] = []

        async def handler(req: httpx.Request) -> httpx.Response:
            captured.append(req)
            return httpx.Response(200, json={"agent_session_id": "a-1"})

        await spawn_agent(
            _client(handler),
            "tok",
            SpawnRequest(
                zone_id="z",
                application_id="app",
                subject_session_id="sid-1",
                idempotency_key="user-supplied-key",
            ),
        )
        self.assertEqual(
            captured[0].headers.get("idempotency-key"), "user-supplied-key"
        )


class CoordinatorLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_http_client_is_created_lazily_with_timeout(self) -> None:
        c = CoordinatorClient(base_url="http://coordinator.test", timeout=3.5)
        self.assertIsNone(c.http_client)
        client = c._http()
        self.assertIs(c.http_client, client)
        await c.aclose()

    async def test_close_is_idempotent(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"agent_session_id": "a-1"})

        c = _client(handler)
        c._http()
        await c.aclose()
        await c.aclose()
        self.assertIsNone(c.http_client)


class HeartbeatAgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_returns_status_and_deadline_from_agent_wire(self) -> None:
        captured: list[httpx.Request] = []

        async def handler(req: httpx.Request) -> httpx.Response:
            captured.append(req)
            return httpx.Response(
                200,
                json={
                    "agent": {
                        "status": "suspended",
                        "heartbeat_deadline_at": "2026-07-04T00:02:00+00:00",
                    }
                },
            )

        res = await heartbeat_agent(
            _client(handler), "tok", "z 1", "agent 1", "degraded"
        )
        self.assertEqual(res.status, "suspended")
        self.assertEqual(res.heartbeat_deadline_at, "2026-07-04T00:02:00+00:00")
        self.assertEqual(
            captured[0].url.raw_path.decode(),
            "/zones/z%201/agents/agent%201/heartbeat",
        )
        import json

        self.assertEqual(json.loads(captured[0].content), {"status": "degraded"})

    async def test_tolerates_empty_response_body(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(204)

        res = await heartbeat_agent(_client(handler), "tok", "z", "agent-1")
        self.assertIsNone(res.status)
        self.assertIsNone(res.heartbeat_deadline_at)

    async def test_raises_coordinator_error_with_status(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(409, json={"error": "agent_lease_expired"})

        with self.assertRaises(CoordinatorError) as caught:
            await heartbeat_agent(_client(handler), "tok", "z", "agent-1")
        self.assertEqual(caught.exception.status, 409)


class TerminateAgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_propagates_errors(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(500)

        with self.assertRaises(CoordinatorError):
            await terminate_agent(_client(handler), "tok", "z", "agent-1")

    async def test_succeeds_on_204(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(204)

        await terminate_agent(_client(handler), "tok", "z", "agent-1")


class CreateDelegationTests(unittest.IsolatedAsyncioTestCase):
    async def test_returns_delegation_edge_id(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "delegation_edge_id": "edge-1",
                    "scopes": ["tool:call"],
                    "expires_at": "2026-07-04T12:00:00+00:00",
                },
            )

        res = await create_delegation(
            _client(handler),
            "tok",
            DelegationRequest(
                zone_id="z",
                issuer_application_id="app",
                source_session_id="agent-1",
                target_session_id="agent-2",
                receiver_application_id="app-2",
                scopes=["tool:call"],
            ),
        )
        self.assertEqual(res.delegation_edge_id, "edge-1")
        self.assertEqual(res.scopes, ["tool:call"])
        self.assertEqual(res.expires_at, "2026-07-04T12:00:00+00:00")

    async def test_raises_on_http_error(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(403, json={"error": "forbidden"})

        with self.assertRaises(CoordinatorError):
            await create_delegation(
                _client(handler),
                "tok",
                DelegationRequest(
                    zone_id="z",
                    issuer_application_id="app",
                    source_session_id="agent-1",
                    target_session_id="agent-2",
                    receiver_application_id="app-2",
                    scopes=["tool:call"],
                ),
            )

    async def test_raises_when_response_has_no_delegation_edge_id(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"other": "field"})

        with self.assertRaises(ValueError):
            await create_delegation(
                _client(handler),
                "tok",
                DelegationRequest(
                    zone_id="z",
                    issuer_application_id="app",
                    source_session_id="agent-1",
                    target_session_id="agent-2",
                    receiver_application_id="app-2",
                    scopes=["tool:call"],
                ),
            )

    async def test_sends_constraints_and_ttl(self) -> None:
        captured: list[dict] = []

        async def handler(req: httpx.Request) -> httpx.Response:
            import json

            captured.append(json.loads(req.content))
            return httpx.Response(200, json={"delegation_edge_id": "edge-1"})

        await create_delegation(
            _client(handler),
            "tok",
            DelegationRequest(
                zone_id="z",
                issuer_application_id="app",
                source_session_id="agent-1",
                target_session_id="agent-2",
                receiver_application_id="app-2",
                scopes=["tool:call"],
                constraints=DelegationConstraints(resources=["calendar"], max_depth=2),
                ttl_seconds=30,
            ),
        )
        body = captured[0]
        self.assertEqual(
            body["constraints"], {"resources": ["calendar"], "max_depth": 2}
        )
        self.assertEqual(body["ttl_seconds"], 30)

    async def test_sends_resource_and_parent_edge_when_set(self) -> None:
        captured: list[dict] = []

        async def handler(req: httpx.Request) -> httpx.Response:
            import json

            captured.append(json.loads(req.content))
            return httpx.Response(200, json={"delegation_edge_id": "edge-1"})

        await create_delegation(
            _client(handler),
            "tok",
            DelegationRequest(
                zone_id="z",
                issuer_application_id="app",
                source_session_id="agent-1",
                target_session_id="agent-2",
                receiver_application_id="app-2",
                scopes=["tool:call"],
                resource_id="calendar",
                parent_edge_id="parent-edge",
            ),
        )

        self.assertEqual(captured[0]["resource_id"], "calendar")
        self.assertEqual(captured[0]["parent_edge_id"], "parent-edge")


class DelegationConstraintsTests(unittest.TestCase):
    def test_to_wire_omits_none_fields(self) -> None:
        c = DelegationConstraints()
        self.assertEqual(c.to_wire(), {})

    def test_to_wire_includes_set_fields(self) -> None:
        c = DelegationConstraints(
            resources=["res"],
            max_depth=3,
            max_hops=3,
            ttl_seconds=30,
            budget=1,
            policy_approved=True,
            expires_at="2026-12-31T00:00:00Z",
            broad_reason="operator approved",
        )
        wire = c.to_wire()
        self.assertEqual(wire["resources"], ["res"])
        self.assertEqual(wire["max_depth"], 3)
        self.assertEqual(wire["max_hops"], 3)
        self.assertEqual(wire["ttl_seconds"], 30)
        self.assertEqual(wire["budget"], 1)
        self.assertEqual(wire["policy_approved"], True)
        self.assertEqual(wire["expires_at"], "2026-12-31T00:00:00Z")
        self.assertEqual(wire["broad_reason"], "operator approved")


if __name__ == "__main__":
    unittest.main()
