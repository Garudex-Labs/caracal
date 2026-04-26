"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for deployment_cli.py pure helper functions.
"""
import pytest
import click

from caracal.cli.deployment_cli import (
    _parse_metadata_pairs,
    _provider_mode,
    _provider_credential_status,
    _parse_resources,
    _parse_actions,
)


@pytest.mark.unit
class TestParseMetadataPairs:
    def test_single_pair(self):
        result = _parse_metadata_pairs(("key=value",))
        assert result == {"key": "value"}

    def test_multiple_pairs(self):
        result = _parse_metadata_pairs(("a=1", "b=2"))
        assert result == {"a": "1", "b": "2"}

    def test_empty_input(self):
        assert _parse_metadata_pairs(()) == {}

    def test_value_with_equals_sign(self):
        result = _parse_metadata_pairs(("k=v=extra",))
        assert result["k"] == "v=extra"

    def test_missing_equals_raises(self):
        with pytest.raises(click.ClickException):
            _parse_metadata_pairs(("badvalue",))

    def test_empty_key_raises(self):
        with pytest.raises(click.ClickException):
            _parse_metadata_pairs(("=value",))

    def test_strips_whitespace(self):
        result = _parse_metadata_pairs(("  key  = value  ",))
        assert "key" in result
        assert result["key"] == "value"


@pytest.mark.unit
class TestProviderMode:
    def test_scoped_when_enforce_and_resources(self):
        entry = {
            "enforce_scoped_requests": True,
            "definition": {"resources": {"r1": {}}},
        }
        assert _provider_mode(entry) == "scoped"

    def test_passthrough_when_not_enforce(self):
        entry = {
            "enforce_scoped_requests": False,
            "definition": {"resources": {"r1": {}}},
        }
        assert _provider_mode(entry) == "passthrough"

    def test_passthrough_when_no_resources(self):
        entry = {
            "enforce_scoped_requests": True,
            "definition": {"resources": {}},
        }
        assert _provider_mode(entry) == "passthrough"

    def test_passthrough_when_no_definition(self):
        entry = {"enforce_scoped_requests": True}
        assert _provider_mode(entry) == "passthrough"

    def test_passthrough_empty_entry(self):
        assert _provider_mode({}) == "passthrough"


@pytest.mark.unit
class TestProviderCredentialStatus:
    def test_none_auth_scheme_reports_not_required(self):
        assert _provider_credential_status({"auth_scheme": "none"}) == "not_required"

    def test_configured_when_credential_ref_present(self):
        result = _provider_credential_status({"auth_scheme": "api-key", "credential_ref": "ref"})
        assert result == "configured"

    def test_missing_when_no_credential_ref(self):
        result = _provider_credential_status({"auth_scheme": "api-key"})
        assert result == "missing"

    def test_empty_entry_missing(self):
        assert _provider_credential_status({}) == "not_required"


@pytest.mark.unit
class TestParseResources:
    def test_single_resource_no_description(self):
        result = _parse_resources(("deployments",))
        assert "deployments" in result
        assert result["deployments"]["description"] == "deployments"

    def test_resource_with_description(self):
        result = _parse_resources(("deployments=Deploy resources",))
        assert result["deployments"]["description"] == "Deploy resources"

    def test_empty_specs(self):
        assert _parse_resources(()) == {}

    def test_empty_spec_string_skipped(self):
        result = _parse_resources(("  ",))
        assert result == {}

    def test_empty_resource_id_raises(self):
        with pytest.raises(click.ClickException):
            _parse_resources(("=description",))

    def test_multiple_resources(self):
        result = _parse_resources(("r1", "r2"))
        assert "r1" in result
        assert "r2" in result


@pytest.mark.unit
class TestParseActions:
    def test_valid_action_added_to_resource(self):
        resources = {"r1": {"actions": {}}}
        _parse_actions(("r1:act:POST:/v1/path",), resources)
        assert "act" in resources["r1"]["actions"]
        assert resources["r1"]["actions"]["act"]["method"] == "POST"
        assert resources["r1"]["actions"]["act"]["path_prefix"] == "/v1/path"

    def test_missing_resource_raises(self):
        resources = {}
        with pytest.raises(click.ClickException):
            _parse_actions(("r1:act:POST:/path",), resources)

    def test_bad_spec_raises(self):
        resources = {"r1": {"actions": {}}}
        with pytest.raises(click.ClickException):
            _parse_actions(("r1:act:POST",), resources)

    def test_path_without_slash_raises(self):
        resources = {"r1": {"actions": {}}}
        with pytest.raises(click.ClickException):
            _parse_actions(("r1:act:POST:no_slash",), resources)

    def test_no_actions_with_no_resources_ok(self):
        resources = {}
        _parse_actions((), resources)

    def test_no_actions_with_resources_raises(self):
        resources = {"r1": {"actions": {}}}
        with pytest.raises(click.ClickException):
            _parse_actions((), resources)
