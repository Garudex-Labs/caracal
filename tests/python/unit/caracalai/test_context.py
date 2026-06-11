"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for CaracalContext bound context and envelope conversion.
"""

from __future__ import annotations

import unittest

from caracalai.advanced import (
    CaracalContext,
    Envelope,
    abind,
    bind,
    describe_authority,
    current,
    from_envelope,
    to_envelope,
    with_overrides,
)


class CurrentTests(unittest.TestCase):
    def test_returns_none_when_no_context_is_active(self) -> None:
        self.assertIsNone(current())


class BindTests(unittest.TestCase):
    def test_sets_context_during_call_and_resets_after(self) -> None:
        ctx = CaracalContext(subject_token="tok", zone_id="z", application_id="app")
        captured: list[CaracalContext | None] = []

        def fn() -> None:
            captured.append(current())

        bind(ctx, fn)
        captured.append(current())

        self.assertIs(captured[0], ctx)
        self.assertIsNone(captured[1])

    def test_returns_the_function_return_value(self) -> None:
        ctx = CaracalContext(subject_token="tok", zone_id="z", application_id="app")
        result = bind(ctx, lambda: 42)
        self.assertEqual(result, 42)

    def test_resets_context_even_when_function_raises(self) -> None:
        ctx = CaracalContext(subject_token="tok", zone_id="z", application_id="app")

        def boom() -> None:
            raise ValueError("oops")

        with self.assertRaises(ValueError):
            bind(ctx, boom)

        self.assertIsNone(current())


class AbindTests(unittest.IsolatedAsyncioTestCase):
    async def test_sets_context_during_awaitable_and_resets_after(self) -> None:
        ctx = CaracalContext(subject_token="tok", zone_id="z", application_id="app")
        captured: CaracalContext | None = None

        async def coro() -> None:
            nonlocal captured
            captured = current()

        await abind(ctx, coro())
        self.assertIs(captured, ctx)
        self.assertIsNone(current())


class WithOverridesTests(unittest.TestCase):
    def test_returns_patched_copy_of_active_context(self) -> None:
        ctx = CaracalContext(subject_token="tok", zone_id="z", application_id="app")

        def fn() -> CaracalContext:
            return with_overrides(agent_session_id="agent-1")

        patched = bind(ctx, fn)
        self.assertEqual(patched.subject_token, "tok")
        self.assertEqual(patched.agent_session_id, "agent-1")

    def test_raises_when_no_context_is_active(self) -> None:
        with self.assertRaises(RuntimeError):
            with_overrides(agent_session_id="agent-1")


class ToEnvelopeTests(unittest.TestCase):
    def test_converts_context_fields_to_envelope(self) -> None:
        ctx = CaracalContext(
            subject_token="tok",
            zone_id="z",
            application_id="app",
            agent_session_id="agent-1",
            delegation_edge_id="edge-1",
            parent_edge_id="parent-1",
            session_id="sid-1",
            trace_id="a" * 32,
            hop=3,
        )
        env = to_envelope(ctx)
        self.assertEqual(env.subject_token, "tok")
        self.assertEqual(env.agent_session_id, "agent-1")
        self.assertEqual(env.delegation_edge_id, "edge-1")
        self.assertEqual(env.parent_edge_id, "parent-1")
        self.assertEqual(env.session_id, "sid-1")
        self.assertEqual(env.trace_id, "a" * 32)
        self.assertEqual(env.hop, 3)


class FromEnvelopeTests(unittest.TestCase):
    def test_builds_context_from_envelope(self) -> None:
        env = Envelope(
            subject_token="tok",
            agent_session_id="agent-1",
            session_id="sid-1",
            hop=2,
        )
        ctx = from_envelope(env, zone_id="z1", application_id="app-1")
        self.assertEqual(ctx.subject_token, "tok")
        self.assertEqual(ctx.zone_id, "z1")
        self.assertEqual(ctx.application_id, "app-1")
        self.assertEqual(ctx.agent_session_id, "agent-1")
        self.assertEqual(ctx.session_id, "sid-1")
        self.assertEqual(ctx.hop, 2)

    def test_raises_when_envelope_has_no_subject_token(self) -> None:
        env = Envelope()
        with self.assertRaises(ValueError):
            from_envelope(env, zone_id="z", application_id="app")


class DescribeAuthorityTests(unittest.TestCase):
    def test_returns_redacted_authority_chain(self) -> None:
        ctx = CaracalContext(
            subject_token="tok",
            zone_id="z",
            application_id="app",
            session_id="sid-1",
            agent_session_id="agent-1",
            delegation_edge_id="edge-1",
            hop=2,
        )
        summary = describe_authority(ctx)
        self.assertIsNotNone(summary)
        assert summary is not None
        self.assertEqual(summary.application_id, "app")
        self.assertEqual(summary.session_id, "sid-1")
        self.assertEqual(
            summary.chain,
            ("session:sid-1", "agent-session:agent-1", "delegation-edge:edge-1"),
        )
        self.assertNotIn("tok", repr(summary))


if __name__ == "__main__":
    unittest.main()
