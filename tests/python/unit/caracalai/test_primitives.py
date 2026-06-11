"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK primitives unit tests: spawn and delegate context manager flows.
"""

import unittest

import httpx

from caracalai.coordinator import CoordinatorClient
from caracalai.context import current
from caracalai.primitives import Grant, spawn, delegate


def _coord(handler) -> CoordinatorClient:
    return CoordinatorClient(
        base_url="http://coord.test",
        _client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


def _default_handler(req: httpx.Request) -> httpx.Response:
    if req.method == "POST" and str(req.url).endswith("/agents"):
        return httpx.Response(200, json={"agent_session_id": "agent-1"})
    if req.method == "DELETE":
        return httpx.Response(204)
    if req.method == "POST" and str(req.url).endswith("/delegations"):
        return httpx.Response(200, json={"delegation_edge_id": "edge-1"})
    return httpx.Response(404)


class SpawnTests(unittest.IsolatedAsyncioTestCase):
    async def test_yields_context_with_agent_session_id(self) -> None:
        coord = _coord(_default_handler)
        async with spawn(
            coordinator=coord,
            zone_id="z",
            application_id="app",
            subject_token="tok",
        ) as ctx:
            self.assertEqual(ctx.agent_session_id, "agent-1")
            self.assertEqual(ctx.zone_id, "z")
            self.assertIsNotNone(current())

    async def test_sets_ambient_context_and_clears_on_exit(self) -> None:
        coord = _coord(_default_handler)
        async with spawn(
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
        async with spawn(
            coordinator=coord,
            zone_id="z",
            application_id="app",
            subject_token="tok",
        ):
            pass

        methods = [r.method for r in requests]
        self.assertIn("DELETE", methods)

    async def test_on_agent_start_hook_called(self) -> None:
        events: list[str] = []

        async def on_start(ctx) -> None:
            events.append(f"start:{ctx.agent_session_id}")

        coord = _coord(_default_handler)
        async with spawn(
            coordinator=coord,
            zone_id="z",
            application_id="app",
            subject_token="tok",
            on_agent_start=on_start,
        ):
            pass

        self.assertEqual(events, ["start:agent-1"])

    async def test_on_agent_end_hook_called(self) -> None:
        events: list[str] = []

        async def on_end(ctx) -> None:
            events.append(f"end:{ctx.agent_session_id}")

        coord = _coord(_default_handler)
        async with spawn(
            coordinator=coord,
            zone_id="z",
            application_id="app",
            subject_token="tok",
            on_agent_end=on_end,
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
            events.append(f"start:{ctx.agent_session_id}")
            raise RuntimeError("start failed")

        async def on_end(ctx) -> None:
            events.append(f"end:{ctx.agent_session_id}")

        coord = _coord(handler)
        with self.assertRaises(RuntimeError):
            async with spawn(
                coordinator=coord,
                zone_id="z",
                application_id="app",
                subject_token="tok",
                on_agent_start=on_start,
                on_agent_end=on_end,
            ):
                pass  # pragma: no cover

        self.assertEqual(events, ["start:agent-1"])
        self.assertIn("DELETE", calls)

    async def test_propagates_coordinator_error(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(500)

        coord = _coord(handler)
        with self.assertRaises(httpx.HTTPStatusError):
            async with spawn(
                coordinator=coord,
                zone_id="z",
                application_id="app",
                subject_token="tok",
            ):
                pass  # pragma: no cover


class DelegateTests(unittest.IsolatedAsyncioTestCase):
    async def test_raises_without_active_agent_session(self) -> None:
        coord = _coord(_default_handler)
        with self.assertRaises(RuntimeError):
            async with delegate(
                coordinator=coord,
                to_agent_session_id="agent-2",
                to_application_id="app-2",
                scopes=["tool:call"],
            ):
                pass  # pragma: no cover

    async def test_yields_child_context_with_delegation_edge(self) -> None:
        coord = _coord(_default_handler)
        async with spawn(
            coordinator=coord, zone_id="z", application_id="app", subject_token="tok"
        ) as parent:
            async with delegate(
                coordinator=coord,
                to_agent_session_id="agent-2",
                to_application_id="app-2",
                scopes=["tool:call"],
            ) as child:
                self.assertEqual(child.delegation_edge_id, "edge-1")
                self.assertEqual(child.hop, parent.hop + 1)
                self.assertEqual(child.parent_edge_id, parent.delegation_edge_id)

    async def test_restores_parent_context_on_exit(self) -> None:
        coord = _coord(_default_handler)
        async with spawn(
            coordinator=coord, zone_id="z", application_id="app", subject_token="tok"
        ) as parent:
            async with delegate(
                coordinator=coord,
                to_agent_session_id="agent-2",
                to_application_id="app-2",
                scopes=["tool:call"],
            ):
                pass
            self.assertEqual(current().agent_session_id, parent.agent_session_id)


class SpawnNarrowGrantTests(unittest.IsolatedAsyncioTestCase):
    async def test_raises_without_active_parent(self) -> None:
        coord = _coord(_default_handler)
        with self.assertRaises(RuntimeError):
            async with spawn(
                coordinator=coord,
                zone_id="z",
                application_id="app",
                subject_token="tok",
                grant=Grant.narrow(["tool:call"]),
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
        async with spawn(
            coordinator=coord, zone_id="z", application_id="app", subject_token="tok"
        ) as parent:
            async with spawn(
                coordinator=coord,
                zone_id="z",
                application_id="app-child",
                subject_token="tok",
                grant=Grant.narrow(["tool:call"]),
            ) as child:
                self.assertEqual(child.agent_session_id, "child-1")
                self.assertEqual(child.delegation_edge_id, "edge-9")
                self.assertEqual(child.parent_edge_id, parent.delegation_edge_id)
                self.assertEqual(child.hop, parent.hop + 1)

        posts = [c for c in calls if c[0] == "POST"]
        self.assertEqual(len(posts), 3)
        self.assertTrue(posts[1][1].endswith("/agents"))
        self.assertTrue(posts[2][1].endswith("/delegations"))
        self.assertTrue(any(m == "DELETE" for m, _ in calls))

    async def test_delegation_failure_terminates_spawned_child(self) -> None:
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
        async with spawn(
            coordinator=coord, zone_id="z", application_id="app", subject_token="tok"
        ):
            with self.assertRaises(httpx.HTTPStatusError):
                async with spawn(
                    coordinator=coord,
                    zone_id="z",
                    application_id="app-child",
                    subject_token="tok",
                    grant=Grant.narrow(["tool:call"]),
                ):
                    pass  # pragma: no cover

        self.assertTrue(
            any(
                method == "DELETE" and path.endswith("/agents/child-1")
                for method, path in calls
            )
        )

    async def test_start_hook_failure_terminates_spawned_child_without_end_hook(
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
            events.append(f"start:{ctx.agent_session_id}")
            raise RuntimeError("start failed")

        async def on_end(ctx) -> None:
            events.append(f"end:{ctx.agent_session_id}")

        coord = _coord(handler)
        async with spawn(
            coordinator=coord, zone_id="z", application_id="app", subject_token="tok"
        ):
            with self.assertRaises(RuntimeError):
                async with spawn(
                    coordinator=coord,
                    zone_id="z",
                    application_id="app-child",
                    subject_token="tok",
                    grant=Grant.narrow(["tool:call"]),
                    on_agent_start=on_start,
                    on_agent_end=on_end,
                ):
                    pass  # pragma: no cover

        self.assertEqual(events, ["start:child-1"])
        self.assertEqual(calls.count("DELETE"), 2)


class ParentCtxOverrideTests(unittest.IsolatedAsyncioTestCase):
    """CP-3: spawn must accept an explicit parent context."""

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
            agent_session_id="parent-session",
            hop=2,
            trace_id="11111111111111111111111111111111",
        )
        coord = _coord(handler)
        self.assertIsNone(current())
        async with spawn(
            coordinator=coord,
            zone_id="z",
            application_id="child-app",
            subject_token="tok",
            parent_ctx=parent,
        ) as ctx:
            self.assertEqual(ctx.agent_session_id, "agent-2")
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
            agent_session_id="parent-session",
            hop=1,
            trace_id="11111111111111111111111111111111",
        )
        coord = _coord(handler)
        self.assertIsNone(current())
        async with spawn(
            coordinator=coord,
            zone_id="z",
            application_id="child-app",
            subject_token="tok",
            grant=Grant.narrow(["tool:call"]),
            parent_ctx=parent,
        ) as ctx:
            self.assertEqual(ctx.hop, 2)
            self.assertEqual(ctx.delegation_edge_id, "edge-9")
        self.assertEqual(seen["delegations"], 1)
        self.assertEqual(seen["agents"], 1)

    async def test_spawn_narrow_requires_parent_session(self) -> None:
        from caracalai.context import CaracalContext

        coord = _coord(_default_handler)
        bare = CaracalContext(
            subject_token="parent-tok",
            zone_id="z",
            application_id="parent-app",
            agent_session_id=None,
        )
        with self.assertRaises(RuntimeError):
            async with spawn(
                coordinator=coord,
                zone_id="z",
                application_id="child-app",
                subject_token="tok",
                grant=Grant.narrow(["tool:call"]),
                parent_ctx=bare,
            ):
                pass


class SpawnInheritEdgeTests(unittest.IsolatedAsyncioTestCase):
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
            agent_session_id="parent-session",
            delegation_edge_id="edge-parent",
            hop=1,
            trace_id="11111111111111111111111111111111",
        )
        coord = _coord(handler)
        async with spawn(
            coordinator=coord,
            zone_id="z",
            application_id="app",
            subject_token="tok",
            parent_ctx=parent,
        ) as ctx:
            self.assertEqual(ctx.delegation_edge_id, "edge-child")
            self.assertEqual(ctx.parent_edge_id, "edge-parent")
            self.assertEqual(ctx.hop, parent.hop + 1)
        self.assertEqual(captured["body"].get("inherit_parent_edge_id"), "edge-parent")

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
            agent_session_id="parent-session",
            delegation_edge_id="edge-parent",
            hop=1,
        )
        coord = _coord(handler)
        async with spawn(
            coordinator=coord,
            zone_id="z",
            application_id="child-app",
            subject_token="tok",
            parent_ctx=parent,
        ) as ctx:
            self.assertIsNone(ctx.delegation_edge_id)
            self.assertEqual(ctx.hop, parent.hop)
        self.assertIsNone(captured["body"].get("inherit_parent_edge_id"))

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
            agent_session_id="parent-session",
            delegation_edge_id=None,
            hop=0,
        )
        coord = _coord(handler)
        async with spawn(
            coordinator=coord,
            zone_id="z",
            application_id="app",
            subject_token="tok",
            parent_ctx=parent,
        ) as ctx:
            self.assertIsNone(ctx.delegation_edge_id)
            self.assertEqual(ctx.hop, 0)
        self.assertIsNone(captured["body"].get("inherit_parent_edge_id"))

    async def test_auto_heartbeat_renews_in_background(self) -> None:
        import asyncio
        from caracalai.primitives import spawn_service

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
        agent = await spawn_service(
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
        from caracalai.primitives import spawn_service

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
        agent = await spawn_service(
            coordinator=coord,
            zone_id="z",
            application_id="app",
            subject_token="tok",
            heartbeat_interval=0.01,
        )
        await asyncio.sleep(0.05)
        await agent.aclose()
        self.assertGreaterEqual(calls, 2)

    async def test_no_auto_heartbeat_without_interval(self) -> None:
        import asyncio
        from caracalai.primitives import spawn_service

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
        agent = await spawn_service(
            coordinator=coord,
            zone_id="z",
            application_id="app",
            subject_token="tok",
        )
        await asyncio.sleep(0.03)
        await agent.aclose()
        self.assertEqual(heartbeats, 0)


if __name__ == "__main__":
    unittest.main()
