"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for SDK Hooks and Extension interface.
"""

import pytest

from caracal.sdk.hooks import (
    HookRegistry,
    SDKRequest,
    SDKResponse,
    ScopeRef,
    StateSnapshot,
)
from caracal.sdk.extensions import CaracalExtension


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def registry():
    return HookRegistry()


@pytest.fixture
def sample_request():
    return SDKRequest(method="GET", path="/agents", headers={"Authorization": "Bearer tok"})


@pytest.fixture
def sample_response():
    return SDKResponse(status_code=200, body={"agents": []}, elapsed_ms=42.0)


@pytest.fixture
def sample_scope():
    return ScopeRef(organization_id="org_1", workspace_id="ws_1")


# ---------------------------------------------------------------------------
# HookRegistry — registration & firing
# ---------------------------------------------------------------------------

class TestHookRegistryInitialize:
    def test_fire_initialize_no_callbacks(self, registry):
        """Firing with no registered callbacks should not raise."""
        registry.fire_initialize()

    def test_fire_initialize_single(self, registry):
        called = []
        registry.on_initialize(lambda: called.append("init"))
        registry.fire_initialize()
        assert called == ["init"]

    def test_fire_initialize_multiple_in_order(self, registry):
        order = []
        registry.on_initialize(lambda: order.append("first"))
        registry.on_initialize(lambda: order.append("second"))
        registry.on_initialize(lambda: order.append("third"))
        registry.fire_initialize()
        assert order == ["first", "second", "third"]


class TestHookRegistryBeforeRequest:
    def test_passthrough(self, registry, sample_request, sample_scope):
        """Without callbacks, request passes through unchanged."""
        result = registry.fire_before_request(sample_request, sample_scope)
        assert result is sample_request

    def test_mutating_callback(self, registry, sample_request, sample_scope):
        def add_header(req, scope):
            req.headers["X-Custom"] = "injected"
            return req

        registry.on_before_request(add_header)
        result = registry.fire_before_request(sample_request, sample_scope)
        assert result.headers["X-Custom"] == "injected"

    def test_pipeline_ordering(self, registry, sample_scope):
        """Later callbacks see mutations from earlier ones."""
        req = SDKRequest(method="POST", path="/mandates")

        def step_a(r, s):
            r.headers["X-Step"] = "A"
            return r

        def step_b(r, s):
            r.headers["X-Step"] += ",B"
            return r

        registry.on_before_request(step_a)
        registry.on_before_request(step_b)
        result = registry.fire_before_request(req, sample_scope)
        assert result.headers["X-Step"] == "A,B"


class TestHookRegistryAfterResponse:
    def test_fire(self, registry, sample_response, sample_scope):
        received = []
        registry.on_after_response(lambda res, s: received.append(res.status_code))
        registry.fire_after_response(sample_response, sample_scope)
        assert received == [200]


class TestHookRegistryStateChange:
    def test_fire(self, registry):
        seen = []
        registry.on_state_change(lambda st: seen.append(st.organization_id))
        registry.fire_state_change(StateSnapshot(organization_id="org_x"))
        assert seen == ["org_x"]


class TestHookRegistryError:
    def test_fire_error(self, registry):
        errors = []
        registry.on_error(lambda e: errors.append(str(e)))
        registry.fire_error(RuntimeError("boom"))
        assert errors == ["boom"]

    def test_error_in_error_hook_does_not_recurse(self, registry):
        """If the error hook itself throws, it must not cause infinite recursion."""
        def bad_hook(e):
            raise ValueError("hook crashed")

        registry.on_error(bad_hook)
        # Should not raise or recurse
        registry.fire_error(RuntimeError("original"))


class TestHookRegistryContextSwitch:
    def test_fire(self, registry, sample_scope):
        switches = []
        registry.on_context_switch(lambda f, t: switches.append((f, t.workspace_id)))
        registry.fire_context_switch(None, sample_scope)
        assert switches == [(None, "ws_1")]


# ---------------------------------------------------------------------------
# CaracalExtension — ABC contract
# ---------------------------------------------------------------------------

class TestCaracalExtension:
    def test_cannot_instantiate_abstract(self):
        with pytest.raises(TypeError):
            CaracalExtension()  # type: ignore[abstract]

    def test_concrete_extension_installs(self, registry):
        class DemoExtension(CaracalExtension):
            @property
            def name(self) -> str:
                return "demo"

            @property
            def version(self) -> str:
                return "0.1.0"

            def install(self, hooks: HookRegistry) -> None:
                hooks.on_initialize(lambda: None)
                hooks.on_before_request(self._before)

            @staticmethod
            def _before(req, scope):
                req.headers["X-Demo"] = "true"
                return req

        ext = DemoExtension()
        assert ext.name == "demo"
        assert ext.version == "0.1.0"

        ext.install(registry)
        # Verify hooks were registered
        assert len(registry._initialize_callbacks) == 1
        assert len(registry._before_request_callbacks) == 1

    def test_extension_hooks_fire_correctly(self, registry):
        class AuditExtension(CaracalExtension):
            def __init__(self):
                self.seen_requests = []

            @property
            def name(self):
                return "audit"

            @property
            def version(self):
                return "1.0.0"

            def install(self, hooks):
                hooks.on_before_request(self._capture)

            def _capture(self, req, scope):
                self.seen_requests.append(req.path)
                return req

        ext = AuditExtension()
        ext.install(registry)

        req = SDKRequest(method="GET", path="/agents")
        scope = ScopeRef()
        registry.fire_before_request(req, scope)

        assert ext.seen_requests == ["/agents"]
