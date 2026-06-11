"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Coordinator REST client unit tests: spawn, delegate, and terminate flows.
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
    spawn_agent,
    terminate_agent,
)


def _client(handler) -> CoordinatorClient:
    return CoordinatorClient(
        base_url="http://coordinator.test",
        _client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
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

        with self.assertRaises(httpx.HTTPStatusError):
            await spawn_agent(
                _client(handler),
                "tok",
                SpawnRequest(zone_id="z", application_id="app"),
            )

    async def test_raises_when_response_has_no_id(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"other": "field"})

        with self.assertRaises(KeyError):
            await spawn_agent(
                _client(handler),
                "tok",
                SpawnRequest(zone_id="z", application_id="app"),
            )

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
        self.assertIsNone(c._client)
        client = c._http()
        self.assertIs(c._client, client)
        await c.aclose()

    async def test_close_is_idempotent(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"agent_session_id": "a-1"})

        c = _client(handler)
        c._http()
        await c.aclose()
        await c.aclose()
        self.assertIsNone(c._client)


class TerminateAgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_propagates_errors(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(500)

        with self.assertRaises(httpx.HTTPStatusError):
            await terminate_agent(_client(handler), "tok", "z", "agent-1")

    async def test_succeeds_on_204(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(204)

        await terminate_agent(_client(handler), "tok", "z", "agent-1")


class CreateDelegationTests(unittest.IsolatedAsyncioTestCase):
    async def test_returns_delegation_edge_id(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"delegation_edge_id": "edge-1"})

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

    async def test_raises_on_http_error(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(403, json={"error": "forbidden"})

        with self.assertRaises(httpx.HTTPStatusError):
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

        with self.assertRaises(KeyError):
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
