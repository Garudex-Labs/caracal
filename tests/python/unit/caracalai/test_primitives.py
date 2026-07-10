"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK primitives unit tests: session, delegation, and service lease flows.
"""

import unittest

import httpx

from caracalai.coordinator import CoordinatorClient
from caracalai.context import current
from caracalai.errors import CoordinatorError
from caracalai.primitives import (
    Authority,
    accept_delegation,
    attach_session,
    delegate,
    session,
)


def _coord(handler) -> CoordinatorClient:
    return CoordinatorClient(
        base_url="http://coord.test",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


def _default_handler(req: httpx.Request) -> httpx.Response:
    if req.method == "POST" and str(req.url).endswith("/agents"):
        return httpx.Response(200, json={"agent_session_id": "agent-1"})
    if req.method == "DELETE":
        return httpx.Response(204)
    if req.method == "POST" and str(req.url).endswith("/delegations"):
        return httpx.Response(200, json={"delegation_edge_id": "edge-1"})
    return httpx.Response(404)


class SessionTests(unittest.IsolatedAsyncioTestCase):
    async def test_yields_context_with_session_id(self) -> None:
        coord = _coord(_default_handler)
        async with session(
            coordinator=coord,
            zone_id="z",
            application_id="app",
            subject_token="tok",
        ) as ctx:
            self.assertEqual(ctx.session_id, "agent-1")
            self.assertEqual(ctx.zone_id, "z")
            self.assertIsNotNone(current())

    async def test_sets_ambient_context_and_clears_on_exit(self) -> None:
        coord = _coord(_default_handler)
        async with session(
            coordinator=coord, zone_id="z", application_id="app", subject_token="tok"
        ):
            self.assertIsNotNone(current())
        self.assertIsNone(current())

    async def test_terminates_on_exit(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(req: httpx.Request) -> httpx.Response:
            requests.append(req)
            if req.method == "POST":
                return httpx.Response(200, json={"agent_session_id": "agent-1"})
            return httpx.Response(204)

        coord = _coord(handler)
        async with session(
            coordinator=coord,
            zone_id="z",
            application_id="app",
            subject_token="tok",
        ):
            pass

        methods = [r.method for r in requests]
        self.assertIn("DELETE", methods)

    async def test_on_session_start_hook_called(self) -> None:
        events: list[str] = []

        async def on_start(ctx) -> None:
            events.append(f"start:{ctx.session_id}")

        coord = _coord(_default_handler)
        async with session(
            coordinator=coord,
            zone_id="z",
            application_id="app",
            subject_token="tok",
            on_session_start=on_start,
        ):
            pass

        self.assertEqual(events, ["start:agent-1"])

    async def test_on_session_end_hook_called(self) -> None:
        events: list[str] = []

        async def on_end(ctx) -> None:
            events.append(f"end:{ctx.session_id}")

        coord = _coord(_default_handler)
        async with session(
            coordinator=coord,
            zone_id="z",
            application_id="app",
            subject_token="tok",
            on_session_end=on_end,
        ):
            pass

        self.assertEqual(events, ["end:agent-1"])

    async def test_start_hook_failure_terminates_without_end_hook(self) -> None:
        calls: list[str] = []
        events: list[str] = []

        async def handler(req: httpx.Request) -> httpx.Response:
            calls.append(req.method)
            if req.method == "POST":
                return httpx.Response(200, json={"agent_session_id": "agent-1"})
            return httpx.Response(204)

        async def on_start(ctx) -> None:
            events.append(f"start:{ctx.session_id}")
            raise RuntimeError("start failed")

        async def on_end(ctx) -> None:
            events.append(f"end:{ctx.session_id}")

        coord = _coord(handler)
        with self.assertRaises(RuntimeError):
            async with session(
                coordinator=coord,
                zone_id="z",
                application_id="app",
                subject_token="tok",
                on_session_start=on_start,
                on_session_end=on_end,
            ):
                pass  # pragma: no cover

        self.assertEqual(events, ["start:agent-1"])
        self.assertIn("DELETE", calls)

    async def test_propagates_coordinator_error(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(403)

        coord = _coord(handler)
        with self.assertRaises(CoordinatorError):
            async with session(
                coordinator=coord,
                zone_id="z",
                application_id="app",
                subject_token="tok",
            ):
                pass  # pragma: no cover

    async def test_retries_transient_spawn_failure_with_same_idempotency_key(
        self,
    ) -> None:
        keys: list[str | None] = []

        async def handler(req: httpx.Request) -> httpx.Response:
            if req.method == "POST" and str(req.url).endswith("/agents"):
                keys.append(req.headers.get("idempotency-key"))
                if len(keys) == 1:
                    return httpx.Response(503, json={"error": "unavailable"})
                return httpx.Response(200, json={"agent_session_id": "agent-1"})
            return httpx.Response(204)

        coord = _coord(handler)
        async with session(
            coordinator=coord,
            zone_id="z",
            application_id="app",
            subject_token="tok",
        ) as ctx:
            self.assertEqual(ctx.session_id, "agent-1")

        self.assertEqual(len(keys), 2)
        self.assertIsNotNone(keys[0])
        self.assertEqual(keys[0], keys[1])

    async def test_does_not_retry_client_errors(self) -> None:
        attempts = 0

        async def handler(req: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            return httpx.Response(400, json={"error": "bad request"})

        coord = _coord(handler)
        with self.assertRaises(CoordinatorError):
            async with session(
                coordinator=coord,
                zone_id="z",
                application_id="app",
                subject_token="tok",
            ):
                pass  # pragma: no cover
        self.assertEqual(attempts, 1)


class DelegateTests(unittest.IsolatedAsyncioTestCase):
    async def test_raises_without_active_agent_session(self) -> None:
        coord = _coord(_default_handler)
        with self.assertRaises(RuntimeError):
            await delegate(
                coordinator=coord,
                to_session_id="agent-2",
                to_application_id="app-2",
                scopes=["tool:call"],
            )

    async def test_returns_edge_without_rebinding_issuer_context(self) -> None:
        coord = _coord(_default_handler)
        async with session(
            coordinator=coord, zone_id="z", application_id="app", subject_token="tok"
        ) as parent:
            res = await delegate(
                coordinator=coord,
                to_session_id="agent-2",
                to_application_id="app-2",
                scopes=["tool:call"],
            )
            self.assertEqual(res.delegation_id, "edge-1")
            self.assertEqual(current().session_id, parent.session_id)
            self.assertEqual(current().delegation_id, parent.delegation_id)
            self.assertEqual(current().hop, parent.hop)

    async def test_adopt_delegation_derives_receiver_context(self) -> None:
        coord = _coord(_default_handler)
        async with session(
            coordinator=coord, zone_id="z", application_id="app", subject_token="tok"
        ) as receiver:
            accepted = accept_delegation(receiver, "edge-42")
            self.assertEqual(accepted.delegation_id, "edge-42")
            self.assertEqual(accepted.parent_delegation_id, receiver.delegation_id)
            self.assertEqual(accepted.hop, receiver.hop + 1)
            self.assertIsNone(receiver.delegation_id)

    async def test_retries_transient_delegation_failure_with_same_key(self) -> None:
        keys: list[str | None] = []

        async def handler(req: httpx.Request) -> httpx.Response:
            if req.method == "POST" and str(req.url).endswith("/delegations"):
                keys.append(req.headers.get("idempotency-key"))
                if len(keys) == 1:
                    return httpx.Response(503, json={"error": "unavailable"})
                return httpx.Response(200, json={"delegation_edge_id": "edge-retry"})
            if req.method == "POST" and str(req.url).endswith("/agents"):
                return httpx.Response(200, json={"agent_session_id": "agent-1"})
            return httpx.Response(204)

        coord = _coord(handler)
        async with session(
            coordinator=coord, zone_id="z", application_id="app", subject_token="tok"
        ):
            res = await delegate(
                coordinator=coord,
                to_session_id="agent-2",
                to_application_id="app-2",
                scopes=["tool:call"],
            )
        self.assertEqual(res.delegation_id, "edge-retry")
        self.assertEqual(len(keys), 2)
        self.assertIsNotNone(keys[0])
        self.assertEqual(keys[0], keys[1])

    async def test_does_not_retry_delegation_rejected_by_policy(self) -> None:
        attempts = 0

        async def handler(req: httpx.Request) -> httpx.Response:
            nonlocal attempts
            if req.method == "POST" and str(req.url).endswith("/delegations"):
                attempts += 1
                return httpx.Response(403, json={"error": "denied"})
            if req.method == "POST" and str(req.url).endswith("/agents"):
                return httpx.Response(200, json={"agent_session_id": "agent-1"})
            return httpx.Response(204)

        coord = _coord(handler)
        async with session(
            coordinator=coord, zone_id="z", application_id="app", subject_token="tok"
        ):
            with self.assertRaises(CoordinatorError):
                await delegate(
                    coordinator=coord,
                    to_session_id="agent-2",
                    to_application_id="app-2",
                    scopes=["tool:call"],
                )
        self.assertEqual(attempts, 1)

    async def test_narrow_accepts_single_scope_string(self) -> None:
        self.assertEqual(Authority.narrow("read").scopes, ("read",))
        self.assertEqual(Authority.narrow(["read", "write"]).scopes, ("read", "write"))


class AttachSessionTests(unittest.IsolatedAsyncioTestCase):
    async def test_refreshes_initial_heartbeat_once_after_401(self) -> None:
        seen: list[str] = []
        tokens = iter(("token-1", "token-2", "token-3"))
        invalidations = 0

        async def handler(request: httpx.Request) -> httpx.Response:
            nonlocal invalidations
            seen.append(request.headers.get("authorization", ""))
            if len(seen) == 1:
                return httpx.Response(401, json={"error": "invalid_token"})
            if request.method == "DELETE":
                return httpx.Response(204)
            return httpx.Response(200, json={"agent": {"status": "active"}})

        def invalidate() -> None:
            nonlocal invalidations
            invalidations += 1

        handle = await attach_session(
            coordinator=CoordinatorClient(
                base_url="http://coord",
                http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            ),
            zone_id="z",
            application_id="app",
            subject_token="stale",
            session_id="svc-1",
            token_source=lambda: next(tokens),
            invalidate=invalidate,
            heartbeat_interval=0,
        )
        self.assertEqual(invalidations, 1)
        self.assertEqual(seen[:2], ["Bearer token-1", "Bearer token-2"])
        await handle.aclose()

    async def test_validates_lease_and_returns_live_handle(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(req: httpx.Request) -> httpx.Response:
            requests.append(req)
            if req.method == "DELETE":
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

        coord = _coord(handler)
        handle = await attach_session(
            coordinator=coord,
            zone_id="z",
            application_id="app",
            subject_token="tok",
            session_id="agent-persisted",
            heartbeat_interval=0,
        )
        self.assertEqual(handle.session_id, "agent-persisted")
        self.assertEqual(handle.context.session_id, "agent-persisted")
        self.assertEqual(handle.heartbeat_deadline_at, "2026-07-09T12:00:00+00:00")
        self.assertTrue(
            str(requests[0].url).endswith("/zones/z/agents/agent-persisted/heartbeat")
        )
        await handle.aclose()
        self.assertIn(
            "DELETE", [r.method for r in requests if "agent-persisted" in str(r.url)]
        )

    async def test_fails_fast_when_session_is_gone(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(404, json={"error": "not found"})

        coord = _coord(handler)
        with self.assertRaises(CoordinatorError):
            await attach_session(
                coordinator=coord,
                zone_id="z",
                application_id="app",
                subject_token="tok",
                session_id="agent-reaped",
                heartbeat_interval=0,
            )


class SessionNarrowGrantTests(unittest.IsolatedAsyncioTestCase):
    async def test_raises_without_active_parent(self) -> None:
        coord = _coord(_default_handler)
        with self.assertRaises(RuntimeError):
            async with session(
                coordinator=coord,
                zone_id="z",
                application_id="app",
                subject_token="tok",
                authority=Authority.narrow(["tool:call"]),
            ):
                pass  # pragma: no cover

    async def test_records_spawn_then_delegation_in_order(self) -> None:
        calls: list[tuple[str, str]] = []

        async def handler(req: httpx.Request) -> httpx.Response:
            path = req.url.path
            calls.append((req.method, path))
            if req.method == "POST" and path.endswith("/agents"):
                return httpx.Response(200, json={"agent_session_id": "child-1"})
            if req.method == "POST" and path.endswith("/delegations"):
                return httpx.Response(200, json={"delegation_edge_id": "edge-9"})
            if req.method == "DELETE":
                return httpx.Response(204)
            return httpx.Response(404)

        coord = _coord(handler)
        async with session(
            coordinator=coord, zone_id="z", application_id="app", subject_token="tok"
        ) as parent:
            async with session(
                coordinator=coord,
                zone_id="z",
                application_id="app-child",
                subject_token="tok",
                authority=Authority.narrow(["tool:call"]),
            ) as child:
                self.assertEqual(child.session_id, "child-1")
                self.assertEqual(child.delegation_id, "edge-9")
                self.assertEqual(child.parent_delegation_id, parent.delegation_id)
                self.assertEqual(child.hop, parent.hop + 1)

        posts = [c for c in calls if c[0] == "POST"]
        self.assertEqual(len(posts), 3)
        self.assertTrue(posts[1][1].endswith("/agents"))
        self.assertTrue(posts[2][1].endswith("/delegations"))
        self.assertTrue(any(m == "DELETE" for m, _ in calls))

    async def test_delegation_failure_terminates_sessions_child(self) -> None:
        calls: list[tuple[str, str]] = []

        async def handler(req: httpx.Request) -> httpx.Response:
            calls.append((req.method, req.url.path))
            if req.method == "POST" and req.url.path.endswith("/agents"):
                return httpx.Response(200, json={"agent_session_id": "child-1"})
            if req.method == "POST" and req.url.path.endswith("/delegations"):
                return httpx.Response(403)
            if req.method == "DELETE":
                return httpx.Response(204)
            return httpx.Response(404)

        coord = _coord(handler)
        async with session(
            coordinator=coord, zone_id="z", application_id="app", subject_token="tok"
        ):
            with self.assertRaises(CoordinatorError):
                async with session(
                    coordinator=coord,
                    zone_id="z",
                    application_id="app-child",
                    subject_token="tok",
                    authority=Authority.narrow(["tool:call"]),
                ):
                    pass  # pragma: no cover

        self.assertTrue(
            any(
                method == "DELETE" and path.endswith("/agents/child-1")
                for method, path in calls
            )
        )

    async def test_start_hook_failure_terminates_sessions_child_without_end_hook(
        self,
    ) -> None:
        calls: list[str] = []
        events: list[str] = []

        async def handler(req: httpx.Request) -> httpx.Response:
            calls.append(req.method)
            if req.method == "POST" and req.url.path.endswith("/agents"):
                return httpx.Response(200, json={"agent_session_id": "child-1"})
            if req.method == "POST" and req.url.path.endswith("/delegations"):
                return httpx.Response(200, json={"delegation_edge_id": "edge-9"})
            if req.method == "DELETE":
                return httpx.Response(204)
            return httpx.Response(404)

        async def on_start(ctx) -> None:
            events.append(f"start:{ctx.session_id}")
            raise RuntimeError("start failed")

        async def on_end(ctx) -> None:
            events.append(f"end:{ctx.session_id}")

        coord = _coord(handler)
        async with session(
            coordinator=coord, zone_id="z", application_id="app", subject_token="tok"
        ):
            with self.assertRaises(RuntimeError):
                async with session(
                    coordinator=coord,
                    zone_id="z",
                    application_id="app-child",
                    subject_token="tok",
                    authority=Authority.narrow(["tool:call"]),
                    on_session_start=on_start,
                    on_session_end=on_end,
                ):
                    pass  # pragma: no cover

        self.assertEqual(events, ["start:child-1"])
        self.assertEqual(calls.count("DELETE"), 2)


class ParentCtxOverrideTests(unittest.IsolatedAsyncioTestCase):
    """CP-3: Session start must accept an explicit parent context."""

    async def test_spawn_uses_explicit_parent_ctx_when_no_current(self) -> None:
        from caracalai.context import CaracalContext

        captured: dict = {}

        def handler(req: httpx.Request) -> httpx.Response:
            if req.method == "POST" and str(req.url).endswith("/agents"):
                import json

                captured["body"] = json.loads(req.content.decode())
                return httpx.Response(200, json={"agent_session_id": "agent-2"})
            return httpx.Response(204)

        parent = CaracalContext(
            subject_token="parent-tok",
            zone_id="z",
            application_id="parent-app",
            session_id="parent-session",
            hop=2,
            trace_id="11111111111111111111111111111111",
        )
        coord = _coord(handler)
        self.assertIsNone(current())
        async with session(
            coordinator=coord,
            zone_id="z",
            application_id="child-app",
            subject_token="tok",
            parent_ctx=parent,
        ) as ctx:
            self.assertEqual(ctx.session_id, "agent-2")
            self.assertEqual(ctx.hop, 2)
            self.assertEqual(ctx.trace_id, "11111111111111111111111111111111")
        self.assertEqual(captured["body"].get("parent_id"), "parent-session")

    async def test_spawn_narrow_uses_explicit_parent_ctx(self) -> None:
        from caracalai.context import CaracalContext

        seen = {"delegations": 0, "agents": 0}

        def handler(req: httpx.Request) -> httpx.Response:
            url = str(req.url)
            if req.method == "POST" and url.endswith("/delegations"):
                seen["delegations"] += 1
                return httpx.Response(200, json={"delegation_edge_id": "edge-9"})
            if req.method == "POST" and url.endswith("/agents"):
                seen["agents"] += 1
                return httpx.Response(200, json={"agent_session_id": "agent-9"})
            return httpx.Response(204)

        parent = CaracalContext(
            subject_token="parent-tok",
            zone_id="z",
            application_id="parent-app",
            session_id="parent-session",
            hop=1,
            trace_id="11111111111111111111111111111111",
        )
        coord = _coord(handler)
        self.assertIsNone(current())
        async with session(
            coordinator=coord,
            zone_id="z",
            application_id="child-app",
            subject_token="tok",
            authority=Authority.narrow(["tool:call"]),
            parent_ctx=parent,
        ) as ctx:
            self.assertEqual(ctx.hop, 2)
            self.assertEqual(ctx.delegation_id, "edge-9")
        self.assertEqual(seen["delegations"], 1)
        self.assertEqual(seen["agents"], 1)

    async def test_spawn_narrow_requires_parent_session(self) -> None:
        from caracalai.context import CaracalContext

        coord = _coord(_default_handler)
        bare = CaracalContext(
            subject_token="parent-tok",
            zone_id="z",
            application_id="parent-app",
            session_id=None,
        )
        with self.assertRaises(RuntimeError):
            async with session(
                coordinator=coord,
                zone_id="z",
                application_id="child-app",
                subject_token="tok",
                authority=Authority.narrow(["tool:call"]),
                parent_ctx=bare,
            ):
                pass


class SessionInheritDelegationTests(unittest.IsolatedAsyncioTestCase):
    async def test_inherit_child_carries_parent_edge_forward(self) -> None:
        from caracalai.context import CaracalContext

        captured: dict = {}

        def handler(req: httpx.Request) -> httpx.Response:
            if req.method == "POST" and str(req.url).endswith("/agents"):
                import json

                captured["body"] = json.loads(req.content.decode())
                return httpx.Response(
                    200,
                    json={
                        "agent_session_id": "agent-2",
                        "delegation_edge_id": "edge-child",
                    },
                )
            return httpx.Response(204)

        parent = CaracalContext(
            subject_token="parent-tok",
            zone_id="z",
            application_id="app",
            session_id="parent-session",
            delegation_id="edge-parent",
            hop=1,
            trace_id="11111111111111111111111111111111",
        )
        coord = _coord(handler)
        async with session(
            coordinator=coord,
            zone_id="z",
            application_id="app",
            subject_token="tok",
            parent_ctx=parent,
        ) as ctx:
            self.assertEqual(ctx.delegation_id, "edge-child")
            self.assertEqual(ctx.parent_delegation_id, "edge-parent")
            self.assertEqual(ctx.hop, parent.hop + 1)
        self.assertEqual(captured["body"].get("parent_authority"), "inherit")
        self.assertNotIn("inherit_parent_edge_id", captured["body"])

    async def test_inherit_skips_edge_when_cross_app(self) -> None:
        from caracalai.context import CaracalContext

        captured: dict = {}

        def handler(req: httpx.Request) -> httpx.Response:
            if req.method == "POST" and str(req.url).endswith("/agents"):
                import json

                captured["body"] = json.loads(req.content.decode())
                return httpx.Response(200, json={"agent_session_id": "agent-2"})
            return httpx.Response(204)

        parent = CaracalContext(
            subject_token="parent-tok",
            zone_id="z",
            application_id="parent-app",
            session_id="parent-session",
            delegation_id="edge-parent",
            hop=1,
        )
        coord = _coord(handler)
        async with session(
            coordinator=coord,
            zone_id="z",
            application_id="child-app",
            subject_token="tok",
            parent_ctx=parent,
        ) as ctx:
            self.assertIsNone(ctx.delegation_id)
            self.assertEqual(ctx.hop, parent.hop)
        self.assertEqual(captured["body"].get("parent_authority"), "inherit")
        self.assertNotIn("inherit_parent_edge_id", captured["body"])

    async def test_inherit_root_parent_creates_no_edge(self) -> None:
        from caracalai.context import CaracalContext

        captured: dict = {}

        def handler(req: httpx.Request) -> httpx.Response:
            if req.method == "POST" and str(req.url).endswith("/agents"):
                import json

                captured["body"] = json.loads(req.content.decode())
                return httpx.Response(200, json={"agent_session_id": "agent-2"})
            return httpx.Response(204)

        parent = CaracalContext(
            subject_token="parent-tok",
            zone_id="z",
            application_id="app",
            session_id="parent-session",
            delegation_id=None,
            hop=0,
        )
        coord = _coord(handler)
        async with session(
            coordinator=coord,
            zone_id="z",
            application_id="app",
            subject_token="tok",
            parent_ctx=parent,
        ) as ctx:
            self.assertIsNone(ctx.delegation_id)
            self.assertEqual(ctx.hop, 0)
        self.assertEqual(captured["body"].get("parent_authority"), "inherit")

    async def test_narrow_grant_suppresses_server_inheritance(self) -> None:
        import json

        from caracalai.context import CaracalContext

        captured: dict = {}

        def handler(req: httpx.Request) -> httpx.Response:
            if req.method == "POST" and str(req.url).endswith("/agents"):
                captured["body"] = json.loads(req.content.decode())
                return httpx.Response(200, json={"agent_session_id": "agent-2"})
            if req.method == "POST" and str(req.url).endswith("/delegations"):
                return httpx.Response(200, json={"delegation_edge_id": "edge-n"})
            return httpx.Response(204)

        parent = CaracalContext(
            subject_token="parent-tok",
            zone_id="z",
            application_id="app",
            session_id="parent-session",
            delegation_id="edge-parent",
            hop=1,
        )
        coord = _coord(handler)
        async with session(
            coordinator=coord,
            zone_id="z",
            application_id="app",
            subject_token="tok",
            parent_ctx=parent,
            authority=Authority.narrow(["tool:call"]),
        ) as ctx:
            self.assertEqual(ctx.delegation_id, "edge-n")
        self.assertEqual(captured["body"].get("parent_authority"), "none")

    async def test_auto_heartbeat_renews_in_background(self) -> None:
        import asyncio
        from caracalai.primitives import start_session

        heartbeats = 0

        def handler(req: httpx.Request) -> httpx.Response:
            nonlocal heartbeats
            if req.method == "POST" and str(req.url).endswith("/agents"):
                return httpx.Response(200, json={"agent_session_id": "agent-1"})
            if req.method == "POST" and str(req.url).endswith("/heartbeat"):
                heartbeats += 1
                return httpx.Response(200, json={"id": "agent-1"})
            return httpx.Response(204)

        coord = _coord(handler)
        agent = await start_session(
            coordinator=coord,
            zone_id="z",
            application_id="app",
            subject_token="tok",
            heartbeat_interval=0.01,
        )
        await asyncio.sleep(0.05)
        await agent.aclose()
        after_close = heartbeats
        self.assertGreater(heartbeats, 0)
        await asyncio.sleep(0.03)
        self.assertEqual(heartbeats, after_close)

    async def test_auto_heartbeat_survives_transient_failure(self) -> None:
        import asyncio
        from caracalai.primitives import start_session

        calls = 0

        def handler(req: httpx.Request) -> httpx.Response:
            nonlocal calls
            if req.method == "POST" and str(req.url).endswith("/agents"):
                return httpx.Response(200, json={"agent_session_id": "agent-1"})
            if req.method == "POST" and str(req.url).endswith("/heartbeat"):
                calls += 1
                if calls == 1:
                    return httpx.Response(503)
                return httpx.Response(200, json={"id": "agent-1"})
            return httpx.Response(204)

        coord = _coord(handler)
        agent = await start_session(
            coordinator=coord,
            zone_id="z",
            application_id="app",
            subject_token="tok",
            heartbeat_interval=0.01,
        )
        await asyncio.sleep(0.05)
        await agent.aclose()
        self.assertGreaterEqual(calls, 2)

    async def test_auto_heartbeat_disabled_with_nonpositive_interval(self) -> None:
        import asyncio
        from caracalai.primitives import start_session

        heartbeats = 0

        def handler(req: httpx.Request) -> httpx.Response:
            nonlocal heartbeats
            if req.method == "POST" and str(req.url).endswith("/agents"):
                return httpx.Response(200, json={"agent_session_id": "agent-1"})
            if req.method == "POST" and str(req.url).endswith("/heartbeat"):
                heartbeats += 1
                return httpx.Response(200, json={"id": "agent-1"})
            return httpx.Response(204)

        coord = _coord(handler)
        agent = await start_session(
            coordinator=coord,
            zone_id="z",
            application_id="app",
            subject_token="tok",
            heartbeat_interval=0,
        )
        self.assertIsNone(agent._auto_task)
        await asyncio.sleep(0.03)
        self.assertEqual(heartbeats, 0)
        await agent.heartbeat("degraded")
        self.assertEqual(heartbeats, 1)
        await agent.aclose()

    async def test_auto_heartbeat_defaults_to_lease_derived_cadence(self) -> None:
        from caracalai.primitives import start_session

        def handler(req: httpx.Request) -> httpx.Response:
            if req.method == "POST" and str(req.url).endswith("/agents"):
                return httpx.Response(200, json={"agent_session_id": "agent-1"})
            return httpx.Response(204)

        coord = _coord(handler)
        agent = await start_session(
            coordinator=coord,
            zone_id="z",
            application_id="app",
            subject_token="tok",
        )
        self.assertIsNotNone(agent._auto_task)
        delay = agent._next_delay()
        self.assertGreaterEqual(delay, 27.0)
        self.assertLessEqual(delay, 33.0)
        await agent.aclose()
        self.assertIsNone(agent._auto_task)

    async def test_next_delay_derives_from_lease_deadline(self) -> None:
        import time
        from datetime import datetime, timezone
        from caracalai.primitives import start_session

        deadline = datetime.fromtimestamp(time.time() + 30, tz=timezone.utc)

        def handler(req: httpx.Request) -> httpx.Response:
            if req.method == "POST" and str(req.url).endswith("/agents"):
                return httpx.Response(
                    200,
                    json={
                        "agent_session_id": "agent-1",
                        "heartbeat_deadline_at": deadline.isoformat(),
                    },
                )
            return httpx.Response(204)

        coord = _coord(handler)
        agent = await start_session(
            coordinator=coord,
            zone_id="z",
            application_id="app",
            subject_token="tok",
        )
        delay = agent._next_delay()
        self.assertGreaterEqual(delay, 8.0)
        self.assertLessEqual(delay, 12.0)
        await agent.aclose()

    async def test_lease_lost_stops_auto_heartbeat_and_notifies_once(self) -> None:
        import asyncio
        from caracalai.primitives import start_session

        heartbeats = 0
        lost: list[BaseException] = []

        def handler(req: httpx.Request) -> httpx.Response:
            nonlocal heartbeats
            if req.method == "POST" and str(req.url).endswith("/agents"):
                return httpx.Response(200, json={"agent_session_id": "agent-1"})
            if req.method == "POST" and str(req.url).endswith("/heartbeat"):
                heartbeats += 1
                return httpx.Response(404, json={"error": "not found"})
            return httpx.Response(204)

        coord = _coord(handler)
        agent = await start_session(
            coordinator=coord,
            zone_id="z",
            application_id="app",
            subject_token="tok",
            heartbeat_interval=0.01,
            on_lease_lost=lost.append,
        )
        await asyncio.sleep(0.08)
        self.assertEqual(heartbeats, 1)
        self.assertEqual(len(lost), 1)
        self.assertIsInstance(lost[0], CoordinatorError)
        await agent.aclose()

    async def test_narrow_grant_issues_delegation_edge(self) -> None:
        from caracalai.primitives import start_session

        calls: list[tuple[str, str]] = []
        captured: dict = {}

        async def handler(req: httpx.Request) -> httpx.Response:
            calls.append((req.method, req.url.path))
            if req.method == "POST" and req.url.path.endswith("/agents"):
                return httpx.Response(200, json={"agent_session_id": "svc-1"})
            if req.method == "POST" and req.url.path.endswith("/delegations"):
                import json

                captured["body"] = json.loads(req.content)
                return httpx.Response(200, json={"delegation_edge_id": "edge-svc"})
            if req.method == "DELETE":
                return httpx.Response(204)
            return httpx.Response(404)

        coord = _coord(handler)
        async with session(
            coordinator=coord, zone_id="z", application_id="app", subject_token="tok"
        ) as parent:
            agent = await start_session(
                coordinator=coord,
                zone_id="z",
                application_id="app-worker",
                subject_token="tok",
                authority=Authority.narrow(
                    ["ledger:read"], resource_id="resource://ledger"
                ),
            )
            self.assertEqual(agent.context.delegation_id, "edge-svc")
            self.assertEqual(agent.context.parent_delegation_id, parent.delegation_id)
            self.assertEqual(agent.context.hop, parent.hop + 1)
            self.assertEqual(captured["body"]["source_session_id"], parent.session_id)
            self.assertEqual(captured["body"]["target_session_id"], "svc-1")
            self.assertEqual(captured["body"]["scopes"], ["ledger:read"])
            await agent.aclose()

    async def test_narrow_grant_failure_terminates_service_agent(self) -> None:
        from caracalai.primitives import start_session

        calls: list[tuple[str, str]] = []

        async def handler(req: httpx.Request) -> httpx.Response:
            calls.append((req.method, req.url.path))
            if req.method == "POST" and req.url.path.endswith("/agents"):
                return httpx.Response(200, json={"agent_session_id": "svc-1"})
            if req.method == "POST" and req.url.path.endswith("/delegations"):
                return httpx.Response(403)
            if req.method == "DELETE":
                return httpx.Response(204)
            return httpx.Response(404)

        coord = _coord(handler)
        async with session(
            coordinator=coord, zone_id="z", application_id="app", subject_token="tok"
        ):
            with self.assertRaises(CoordinatorError):
                await start_session(
                    coordinator=coord,
                    zone_id="z",
                    application_id="app",
                    subject_token="tok",
                    authority=Authority.narrow(["x:y"]),
                )
        deletes = [path for method, path in calls if method == "DELETE"]
        self.assertTrue(any("svc-1" in path for path in deletes))

    async def test_narrow_grant_requires_parent_session(self) -> None:
        from caracalai.primitives import start_session

        coord = _coord(_default_handler)
        with self.assertRaises(RuntimeError):
            await start_session(
                coordinator=coord,
                zone_id="z",
                application_id="app",
                subject_token="tok",
                authority=Authority.narrow(["x:y"]),
            )

    async def test_inherit_grant_carries_parent_edge_forward(self) -> None:
        import json

        from caracalai.context import CaracalContext
        from caracalai.primitives import start_session

        captured: dict = {}

        async def handler(req: httpx.Request) -> httpx.Response:
            if req.method == "POST" and req.url.path.endswith("/agents"):
                captured["body"] = json.loads(req.content)
                return httpx.Response(
                    200,
                    json={
                        "agent_session_id": "svc-1",
                        "delegation_edge_id": "edge-mirror",
                    },
                )
            if req.method == "DELETE":
                return httpx.Response(204)
            return httpx.Response(404)

        parent = CaracalContext(
            subject_token="tok",
            zone_id="z",
            application_id="app",
            session_id="parent-1",
            delegation_id="edge-parent",
            hop=1,
        )
        agent = await start_session(
            coordinator=_coord(handler),
            zone_id="z",
            application_id="app",
            subject_token="tok",
            parent_ctx=parent,
        )
        self.assertEqual(captured["body"]["parent_authority"], "inherit")
        self.assertEqual(agent.context.delegation_id, "edge-mirror")
        self.assertEqual(agent.context.hop, 2)
        await agent.aclose()

    async def test_on_agent_end_runs_once_before_terminate(self) -> None:
        from caracalai.primitives import start_session

        order: list[str] = []

        async def handler(req: httpx.Request) -> httpx.Response:
            if req.method == "POST" and req.url.path.endswith("/agents"):
                return httpx.Response(200, json={"agent_session_id": "svc-1"})
            if req.method == "DELETE":
                order.append("terminate")
                return httpx.Response(204)
            return httpx.Response(404)

        async def on_end(ctx) -> None:
            order.append("end")

        agent = await start_session(
            coordinator=_coord(handler),
            zone_id="z",
            application_id="app",
            subject_token="tok",
            heartbeat_interval=0,
            on_session_end=on_end,
        )
        await agent.aclose()
        await agent.aclose()
        self.assertEqual(order, ["end", "terminate"])

    async def test_heartbeat_single_flights_token_refresh_on_401(self) -> None:
        from caracalai.primitives import start_session

        tokens = ["tok-stale"]
        invalidations = 0
        bearers: list[str] = []

        def token_source() -> str:
            return tokens[-1]

        def invalidate() -> None:
            nonlocal invalidations
            invalidations += 1
            tokens.append("tok-fresh")

        def handler(req: httpx.Request) -> httpx.Response:
            if req.method == "POST" and req.url.path.endswith("/agents"):
                return httpx.Response(200, json={"agent_session_id": "svc-1"})
            if req.method == "POST" and req.url.path.endswith("/heartbeat"):
                bearer = req.headers["authorization"].removeprefix("Bearer ")
                bearers.append(bearer)
                if bearer == "tok-stale":
                    return httpx.Response(401, json={"error": "revoked"})
                return httpx.Response(200, json={"id": "svc-1"})
            if req.method == "DELETE":
                return httpx.Response(204)
            return httpx.Response(404)

        agent = await start_session(
            coordinator=_coord(handler),
            zone_id="z",
            application_id="app",
            subject_token="tok-stale",
            token_source=token_source,
            invalidate=invalidate,
            heartbeat_interval=0,
        )
        await agent.heartbeat()
        self.assertEqual(invalidations, 1)
        self.assertEqual(bearers, ["tok-stale", "tok-fresh"])
        await agent.aclose()


if __name__ == "__main__":
    unittest.main()
