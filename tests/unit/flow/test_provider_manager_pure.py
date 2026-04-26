"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for pure utilities in flow/screens/provider_manager.py.
"""

import pytest

pytestmark = pytest.mark.unit


class TestProviderManagerDataclasses:
    def test_action_starter_fields(self):
        from caracal.flow.screens.provider_manager import ActionStarter
        a = ActionStarter(
            action_id="act_1",
            description="Run job",
            method="POST",
            path_prefix="/jobs",
        )
        assert a.action_id == "act_1"
        assert a.method == "POST"

    def test_resource_starter_fields(self):
        from caracal.flow.screens.provider_manager import ActionStarter, ResourceStarter
        action = ActionStarter(action_id="a", description="d", method="GET", path_prefix="/")
        r = ResourceStarter(
            resource_id="res_1",
            description="A resource",
            actions=(action,),
        )
        assert r.resource_id == "res_1"
        assert len(r.actions) == 1

    def test_provider_starter_pattern_fields(self):
        from caracal.flow.screens.provider_manager import ProviderStarterPattern
        p = ProviderStarterPattern(
            key="my_key",
            label="My Label",
            description="desc",
            service_type="ai",
            recommended_auth_scheme="bearer",
            base_url_example="https://api.example.com",
            resources=(),
        )
        assert p.key == "my_key"
        assert p.service_type == "ai"

    def test_noop_metering_collector_collect_returns_none(self):
        from caracal.flow.screens.provider_manager import _NoopMeteringCollector
        collector = _NoopMeteringCollector()
        result = collector.collect_event({"type": "some_event"})
        assert result is None


class TestAvailablePatterns:
    def test_returns_tuple_for_known_service_type(self):
        from caracal.flow.screens.provider_manager import _available_patterns
        result = _available_patterns("ai")
        assert isinstance(result, tuple)

    def test_returns_empty_for_unknown_service_type(self):
        from caracal.flow.screens.provider_manager import _available_patterns
        result = _available_patterns("nonexistent_type_xyz")
        assert result == ()

    def test_excludes_gateway_only_auth(self):
        from caracal.flow.screens.provider_manager import _available_patterns, _GATEWAY_ONLY_AUTH
        result = _available_patterns("ai")
        for pattern in result:
            assert pattern.recommended_auth_scheme not in _GATEWAY_ONLY_AUTH


class TestResolvePatternByKey:
    def test_returns_none_for_none_key(self):
        from caracal.flow.screens.provider_manager import _resolve_pattern_by_key
        assert _resolve_pattern_by_key(None) is None

    def test_returns_none_for_empty_key(self):
        from caracal.flow.screens.provider_manager import _resolve_pattern_by_key
        assert _resolve_pattern_by_key("") is None

    def test_returns_none_for_unknown_key(self):
        from caracal.flow.screens.provider_manager import _resolve_pattern_by_key
        assert _resolve_pattern_by_key("nonexistent_key_xyz") is None

    def test_returns_pattern_for_known_key(self):
        from caracal.flow.screens.provider_manager import _resolve_pattern_by_key, _PROVIDER_PATTERNS
        for patterns in _PROVIDER_PATTERNS.values():
            if patterns:
                known_key = patterns[0].key
                result = _resolve_pattern_by_key(known_key)
                assert result is not None
                assert result.key == known_key
                return


class TestProviderMode:
    def test_passthrough_when_no_enforce(self):
        from caracal.flow.screens.provider_manager import _provider_mode
        entry = {"enforce_scoped_requests": False, "definition": {"resources": {"r": {}}}}
        assert _provider_mode(entry) == "passthrough"

    def test_passthrough_when_no_resources(self):
        from caracal.flow.screens.provider_manager import _provider_mode
        entry = {"enforce_scoped_requests": True, "definition": {"resources": {}}}
        assert _provider_mode(entry) == "passthrough"

    def test_scoped_when_enforce_and_resources(self):
        from caracal.flow.screens.provider_manager import _provider_mode
        entry = {
            "enforce_scoped_requests": True,
            "definition": {"resources": {"some_resource": {}}},
        }
        assert _provider_mode(entry) == "scoped"

    def test_passthrough_when_no_definition(self):
        from caracal.flow.screens.provider_manager import _provider_mode
        entry = {"enforce_scoped_requests": True}
        assert _provider_mode(entry) == "passthrough"


class TestProviderCredentialStatus:
    def test_not_required_when_auth_none(self):
        from caracal.flow.screens.provider_manager import _provider_credential_status
        entry = {"auth_scheme": "none"}
        assert _provider_credential_status(entry) == "not required"

    def test_not_required_when_auth_scheme_missing(self):
        from caracal.flow.screens.provider_manager import _provider_credential_status
        entry = {}
        assert _provider_credential_status(entry) == "not required"

    def test_configured_when_credential_ref_present(self):
        from caracal.flow.screens.provider_manager import _provider_credential_status
        entry = {"auth_scheme": "bearer", "credential_ref": "ref_abc"}
        assert _provider_credential_status(entry) == "configured"

    def test_missing_when_credential_ref_absent(self):
        from caracal.flow.screens.provider_manager import _provider_credential_status
        entry = {"auth_scheme": "bearer", "credential_ref": None}
        assert _provider_credential_status(entry) == "missing"


class TestDefinitionPayloadForExistingResources:
    def test_returns_none_when_no_definition(self):
        from caracal.flow.screens.provider_manager import _definition_payload_for_existing_resources
        result = _definition_payload_for_existing_resources(
            {},
            provider_name="p",
            service_type="ai",
            definition_id="d1",
            auth_scheme="bearer",
            base_url="http://x",
            metadata={},
        )
        assert result is None

    def test_returns_none_when_no_resources(self):
        from caracal.flow.screens.provider_manager import _definition_payload_for_existing_resources
        result = _definition_payload_for_existing_resources(
            {"definition": {"resources": {}}},
            provider_name="p",
            service_type="ai",
            definition_id="d1",
            auth_scheme="bearer",
            base_url=None,
            metadata={},
        )
        assert result is None

    def test_returns_payload_when_resources_present(self):
        from caracal.flow.screens.provider_manager import _definition_payload_for_existing_resources
        result = _definition_payload_for_existing_resources(
            {"definition": {"resources": {"jobs": {"actions": []}}}},
            provider_name="MyProv",
            service_type="application",
            definition_id="def_99",
            auth_scheme="api_key",
            base_url="http://myserver",
            metadata={"tag": "val"},
        )
        assert result is not None
        assert result["definition_id"] == "def_99"
        assert result["service_type"] == "application"
        assert "jobs" in result["resources"]
