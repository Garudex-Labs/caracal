"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK primitives unit tests: spawn and delegate context manager flows.
"""

import unittest

import httpx

from caracalai_sdk.coordinator import AgentKind, CoordinatorClient
from caracalai_sdk.context import current
from caracalai_sdk.primitives import spawn, delegate


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

    async def test_service_kind_skips_termination(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(req: httpx.Request) -> httpx.Response:
            requests.append(req)
            if req.method == "POST":
                return httpx.Response(200, json={"agent_session_id": "agent-1"})
            return httpx.Response(204)

        coord = _coord(handler)
        async with spawn(
            coordinator=coord, zone_id="z", application_id="app",
            subject_token="tok", kind=AgentKind.SERVICE,
        ):
            pass

        methods = [r.method for r in requests]
        self.assertNotIn("DELETE", methods)

    async def test_non_service_kind_terminates_on_exit(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(req: httpx.Request) -> httpx.Response:
            requests.append(req)
            if req.method == "POST":
                return httpx.Response(200, json={"agent_session_id": "agent-1"})
            return httpx.Response(204)

        coord = _coord(handler)
        async with spawn(
            coordinator=coord, zone_id="z", application_id="app",
            subject_token="tok", kind=AgentKind.EPHEMERAL,
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
            coordinator=coord, zone_id="z", application_id="app",
            subject_token="tok", on_agent_start=on_start,
        ):
            pass

        self.assertEqual(events, ["start:agent-1"])

    async def test_on_agent_end_hook_called(self) -> None:
        events: list[str] = []

        async def on_end(ctx) -> None:
            events.append(f"end:{ctx.agent_session_id}")

        coord = _coord(_default_handler)
        async with spawn(
            coordinator=coord, zone_id="z", application_id="app",
            subject_token="tok", on_agent_end=on_end,
        ):
            pass

        self.assertEqual(events, ["end:agent-1"])

    async def test_propagates_coordinator_error(self) -> None:
        async def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(500)

        coord = _coord(handler)
        with self.assertRaises(httpx.HTTPStatusError):
            async with spawn(
                coordinator=coord, zone_id="z", application_id="app", subject_token="tok"
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


if __name__ == "__main__":
    unittest.main()
