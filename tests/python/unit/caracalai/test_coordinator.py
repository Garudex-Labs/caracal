"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Coordinator REST client unit tests: Session start, heartbeat, delegate, and terminate flows.
"""

import unittest

import httpx

from caracalai.coordinator import (
    Lifecycle,
    CoordinatorClient,
    DelegationConstraints,
    DelegationRequest,
    StartSessionRequest,
    acquire_session_lease,
    create_delegation,
    heartbeat_session,
    start_coordinator_session,
    terminate_session,
)
from caracalai.errors import CoordinatorError


def _client(handler) -> CoordinatorClient:
    return CoordinatorClient(
        base_url="http://coordinator.test",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


class StartSessionTests(unittest.IsolatedAsyncioTestCase):
    async def test_returns_session_id_from_response(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"agent_session_id": "agent-1"})

        res = await start_coordinator_session(
            _client(handler),
            "tok",
            StartSessionRequest(zone_id="z", application_id="app"),
        )
        self.assertEqual(res.session_id, "agent-1")

    async def test_raises_on_http_error(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json={"error": "internal"})

        with self.assertRaises(CoordinatorError) as caught:
            await start_coordinator_session(
                _client(handler),
                "tok",
                StartSessionRequest(zone_id="z", application_id="app"),
            )
        self.assertEqual(caught.exception.status, 500)
        self.assertEqual(caught.exception.method, "POST")
        self.assertIn("internal", caught.exception.body)
        self.assertIsNone(caught.exception.retry_after_seconds)

    async def test_carries_server_retry_after_hint(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(
                429, headers={"retry-after": "3"}, json={"error": "throttled"}
            )

        with self.assertRaises(CoordinatorError) as caught:
            await start_coordinator_session(
                _client(handler),
                "tok",
                StartSessionRequest(zone_id="z", application_id="app"),
            )
        self.assertEqual(caught.exception.retry_after_seconds, 3.0)

    async def test_caps_error_body_in_message(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(400, text="x" * 5000)

        with self.assertRaises(CoordinatorError) as caught:
            await start_coordinator_session(
                _client(handler),
                "tok",
                StartSessionRequest(zone_id="z", application_id="app"),
            )
        self.assertIn("\u2026 (truncated)", str(caught.exception))
        self.assertLess(len(str(caught.exception)), 2300)

    async def test_raises_when_response_has_no_id(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"other": "field"})

        with self.assertRaises(ValueError):
            await start_coordinator_session(
                _client(handler),
                "tok",
                StartSessionRequest(zone_id="z", application_id="app"),
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

        res = await start_coordinator_session(
            _client(handler),
            "tok",
            StartSessionRequest(zone_id="z/1", application_id="app"),
        )
        self.assertEqual(res.heartbeat_deadline_at, "2026-07-04T00:02:00+00:00")
        self.assertEqual(captured[0].url.raw_path.decode(), "/zones/z%2F1/agents")

    async def test_base_url_trailing_slash_is_normalized(self) -> None:
        captured: list[httpx.Request] = []

        async def handler(req: httpx.Request) -> httpx.Response:
            captured.append(req)
            return httpx.Response(
                200, json={"agent_session_id": "a-1", "lease_generation": 1}
            )

        c = CoordinatorClient(
            base_url="http://coordinator.test/",
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        await start_coordinator_session(
            c, "tok", StartSessionRequest(zone_id="z", application_id="app")
        )
        self.assertEqual(str(captured[0].url), "http://coordinator.test/zones/z/agents")

    async def test_sends_optional_fields_when_set(self) -> None:
        captured: list[dict] = []

        async def handler(req: httpx.Request) -> httpx.Response:
            import json

            captured.append(json.loads(req.content))
            return httpx.Response(
                200, json={"agent_session_id": "a-1", "lease_generation": 1}
            )

        await start_coordinator_session(
            _client(handler),
            "tok",
            StartSessionRequest(
                zone_id="z",
                application_id="app",
                subject_authority_record_id="sid-1",
                subject_authority_record_token="subject-mandate",
                parent_id="parent-1",
                lifecycle=Lifecycle.SERVICE,
                ttl_seconds=60,
                metadata={"purpose": "test"},
                labels=["refunds.execute", "ledger.read"],
            ),
        )
        body = captured[0]
        self.assertEqual(body["subject_session_id"], "sid-1")
        self.assertEqual(body["subject_token"], "subject-mandate")
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

        await start_coordinator_session(
            _client(handler),
            "tok",
            StartSessionRequest(
                zone_id="z",
                application_id="app",
                subject_authority_record_id="sid-1",
                parent_id="parent-1",
            ),
        )
        self.assertNotIn("idempotency-key", captured[0].headers)

    async def test_explicit_idempotency_key_sent(self) -> None:
        captured: list[httpx.Request] = []

        async def handler(req: httpx.Request) -> httpx.Response:
            captured.append(req)
            return httpx.Response(200, json={"agent_session_id": "a-1"})

        await start_coordinator_session(
            _client(handler),
            "tok",
            StartSessionRequest(
                zone_id="z",
                application_id="app",
                subject_authority_record_id="sid-1",
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


class HeartbeatSessionTests(unittest.IsolatedAsyncioTestCase):
    async def test_propagates_one_trace_with_fresh_spans(self) -> None:
        captured: list[httpx.Request] = []
        trace_id = "1" * 32

        async def handler(req: httpx.Request) -> httpx.Response:
            captured.append(req)
            if str(req.url).endswith("/heartbeat"):
                return httpx.Response(
                    200,
                    json={"agent": {"status": "active", "lease_generation": 1}},
                )
            return httpx.Response(
                200,
                json={"agent_session_id": "session-1", "lease_generation": 1},
            )

        client = _client(handler)
        await start_coordinator_session(
            client,
            "tok",
            StartSessionRequest(
                zone_id="z",
                application_id="app",
                lifecycle=Lifecycle.SERVICE,
                trace_id=trace_id,
                trace_flags="01",
                trace_state="vendor=value",
            ),
        )
        await heartbeat_session(
            client,
            "tok",
            "z",
            "session-1",
            1,
            trace_id=trace_id,
            trace_flags="01",
            trace_state="vendor=value",
        )

        traceparents = [request.headers["traceparent"] for request in captured]
        self.assertTrue(all(value.split("-")[1] == trace_id for value in traceparents))
        self.assertNotEqual(
            traceparents[0].split("-")[2], traceparents[1].split("-")[2]
        )
        self.assertEqual(
            [request.headers["tracestate"] for request in captured],
            ["vendor=value", "vendor=value"],
        )

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
                        "lease_generation": 3,
                    }
                },
            )

        res = await heartbeat_session(
            _client(handler), "tok", "z 1", "agent 1", 3, "degraded"
        )
        self.assertEqual(res.status, "suspended")
        self.assertEqual(res.heartbeat_deadline_at, "2026-07-04T00:02:00+00:00")
        self.assertEqual(
            captured[0].url.raw_path.decode(),
            "/zones/z%201/agents/agent%201/heartbeat",
        )
        import json

        self.assertEqual(
            json.loads(captured[0].content),
            {"status": "degraded", "lease_generation": 3},
        )
        self.assertEqual(res.lease_generation, 3)

    async def test_tolerates_empty_response_body(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(204)

        res = await heartbeat_session(_client(handler), "tok", "z", "session-1", 1)
        self.assertIsNone(res.status)
        self.assertIsNone(res.heartbeat_deadline_at)

    async def test_raises_coordinator_error_with_status(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(409, json={"error": "agent_lease_expired"})

        with self.assertRaises(CoordinatorError) as caught:
            await heartbeat_session(_client(handler), "tok", "z", "session-1", 1)
        self.assertEqual(caught.exception.status, 409)

    async def test_acquires_a_new_lease_generation(self) -> None:
        captured: list[httpx.Request] = []

        async def handler(req: httpx.Request) -> httpx.Response:
            captured.append(req)
            return httpx.Response(
                200,
                json={
                    "status": "active",
                    "heartbeat_deadline_at": "2026-07-04T00:02:00+00:00",
                    "lease_generation": 4,
                },
            )

        res = await acquire_session_lease(_client(handler), "tok", "z", "session-1")

        self.assertEqual(res.lease_generation, 4)
        self.assertTrue(str(captured[0].url).endswith("/agents/session-1/lease"))


class TerminateSessionTests(unittest.IsolatedAsyncioTestCase):
    async def test_propagates_errors(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(500)

        with self.assertRaises(CoordinatorError):
            await terminate_session(_client(handler), "tok", "z", "session-1")

    async def test_succeeds_on_204(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(204)

        await terminate_session(_client(handler), "tok", "z", "session-1")

    async def test_sends_service_lease_generation(self) -> None:
        captured: list[httpx.Request] = []

        async def handler(req: httpx.Request) -> httpx.Response:
            captured.append(req)
            return httpx.Response(204)

        await terminate_session(_client(handler), "tok", "z", "session-1", 7)

        import json

        self.assertEqual(json.loads(captured[0].content), {"lease_generation": 7})


class CreateDelegationTests(unittest.IsolatedAsyncioTestCase):
    async def test_returns_delegation_id(self) -> None:
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
        self.assertEqual(res.delegation_id, "edge-1")
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

    async def test_raises_when_response_has_no_delegation_id(self) -> None:
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
            policy_approved=True,
            expires_at="2026-12-31T00:00:00Z",
            broad_reason="operator approved",
        )
        wire = c.to_wire()
        self.assertEqual(wire["resources"], ["res"])
        self.assertEqual(wire["max_depth"], 3)
        self.assertEqual(wire["max_hops"], 3)
        self.assertEqual(wire["ttl_seconds"], 30)
        self.assertEqual(wire["policy_approved"], True)
        self.assertEqual(wire["expires_at"], "2026-12-31T00:00:00Z")
        self.assertEqual(wire["broad_reason"], "operator approved")


class EventTests(unittest.IsolatedAsyncioTestCase):
    async def test_emits_coordinator_call_events(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            if req.method == "DELETE":
                return httpx.Response(403, json={"error": "denied"})
            return httpx.Response(200, json={"agent_session_id": "agent-1"})

        events = []

        def sink(event):
            events.append(event)
            raise RuntimeError("sink failure")

        client = _client(handler)
        client.on_event = sink
        await start_coordinator_session(
            client, "tok", StartSessionRequest(zone_id="z", application_id="app")
        )
        with self.assertRaises(CoordinatorError):
            await terminate_session(client, "tok", "z", "session-1")

        self.assertEqual(len(events), 2)
        sessions, denied = events
        self.assertEqual(sessions.type, "coordinator.call")
        self.assertEqual(sessions.method, "POST")
        self.assertEqual(sessions.path, "/zones/z/agents")
        self.assertTrue(sessions.ok)
        self.assertEqual(sessions.status, 200)
        self.assertFalse(denied.ok)
        self.assertEqual(denied.status, 403)
        self.assertEqual(denied.method, "DELETE")


if __name__ == "__main__":
    unittest.main()
