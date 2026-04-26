"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for enterprise_sync_payload module.
"""

import pytest
from unittest.mock import patch, MagicMock

from caracal.deployment.enterprise_sync_payload import (
    _validate_schema,
    _load_local_principals,
    _load_local_policies,
    _load_local_mandates,
    _load_local_ledger,
    _load_local_delegation,
    build_enterprise_sync_payload,
)


pytestmark = pytest.mark.unit


class TestValidateSchema:
    def test_valid_simple_name(self):
        assert _validate_schema("public") == "public"

    def test_valid_with_underscores(self):
        assert _validate_schema("ws_myworkspace") == "ws_myworkspace"

    def test_valid_alphanumeric(self):
        assert _validate_schema("schema123") == "schema123"

    def test_valid_leading_underscore(self):
        assert _validate_schema("_schema") == "_schema"

    def test_raises_on_space(self):
        with pytest.raises(ValueError, match="Invalid schema"):
            _validate_schema("bad schema")

    def test_raises_on_dash(self):
        with pytest.raises(ValueError, match="Invalid schema"):
            _validate_schema("bad-schema")

    def test_raises_on_leading_digit(self):
        with pytest.raises(ValueError, match="Invalid schema"):
            _validate_schema("1schema")

    def test_raises_on_semicolon(self):
        with pytest.raises(ValueError, match="Invalid schema"):
            _validate_schema("schema;drop")

    def test_raises_on_empty(self):
        with pytest.raises(ValueError, match="Invalid schema"):
            _validate_schema("")


class TestLoadLocalPrincipals:
    def test_returns_empty_on_exception(self):
        with patch("caracal.deployment.enterprise_sync_payload._validate_schema", side_effect=Exception("fail")):
            with patch("caracal.flow.workspace.get_workspace", side_effect=Exception("no workspace")):
                result = _load_local_principals()
        assert result == []

    def test_returns_list_from_json_file(self, tmp_path):
        import json
        agents_file = tmp_path / "agents.json"
        agents_file.write_text(json.dumps([{"name": "agent1"}]))

        ws_mock = MagicMock()
        ws_mock.agents_path = agents_file

        with patch("caracal.deployment.enterprise_sync_payload._validate_schema", side_effect=Exception("skip db")):
            with patch("caracal.flow.workspace.get_workspace", return_value=ws_mock):
                result = _load_local_principals()

        assert result == [{"name": "agent1"}]

    def test_returns_empty_list_when_no_file(self, tmp_path):
        ws_mock = MagicMock()
        ws_mock.agents_path = tmp_path / "nonexistent.json"
        ws_mock.config_path = tmp_path / "nonexistent_config.yaml"

        with patch("caracal.flow.workspace.get_workspace", return_value=ws_mock):
            result = _load_local_principals()

        assert result == []

    def test_handles_dict_with_principals_key(self, tmp_path):
        import json
        agents_file = tmp_path / "agents.json"
        data = {"principals": [{"name": "p1"}, {"name": "p2"}]}
        agents_file.write_text(json.dumps(data))

        ws_mock = MagicMock()
        ws_mock.agents_path = agents_file

        with patch("caracal.deployment.enterprise_sync_payload._validate_schema", side_effect=Exception("skip db")):
            with patch("caracal.flow.workspace.get_workspace", return_value=ws_mock):
                result = _load_local_principals()

        assert len(result) == 2


class TestLoadLocalPolicies:
    def test_returns_empty_on_exception(self):
        with patch("caracal.flow.workspace.get_workspace", side_effect=Exception("no workspace")):
            result = _load_local_policies()
        assert result == []

    def test_returns_list_from_json_file(self, tmp_path):
        import json
        policies_file = tmp_path / "policies.json"
        policies_file.write_text(json.dumps([{"policy_id": "p1"}]))

        ws_mock = MagicMock()
        ws_mock.policies_path = policies_file
        ws_mock.config_path = tmp_path / "nonexistent.yaml"

        with patch("caracal.flow.workspace.get_workspace", return_value=ws_mock):
            result = _load_local_policies()

        assert result == [{"policy_id": "p1"}]

    def test_returns_empty_when_no_file(self, tmp_path):
        ws_mock = MagicMock()
        ws_mock.policies_path = tmp_path / "nonexistent.json"
        ws_mock.config_path = tmp_path / "nonexistent.yaml"

        with patch("caracal.flow.workspace.get_workspace", return_value=ws_mock):
            result = _load_local_policies()

        assert result == []


class TestLoadLocalMandates:
    def test_returns_empty_on_exception(self):
        with patch("caracal.flow.workspace.get_workspace", side_effect=Exception("no workspace")):
            result = _load_local_mandates()
        assert result == []

    def test_returns_empty_when_no_config_file(self, tmp_path):
        ws_mock = MagicMock()
        ws_mock.config_path = tmp_path / "nonexistent.yaml"
        ws_mock.root = MagicMock()
        ws_mock.root.name = "test"

        with patch("caracal.flow.workspace.get_workspace", return_value=ws_mock):
            result = _load_local_mandates()

        assert result == []


class TestLoadLocalLedger:
    def test_returns_empty_on_exception(self):
        with patch("caracal.deployment.enterprise_sync_payload._load_local_ledger.__code__", None, create=True):
            pass
        with patch("caracal.config.load_config", side_effect=Exception("no config")):
            result = _load_local_ledger()
        assert result == []


class TestLoadLocalDelegation:
    def test_returns_empty_on_exception(self):
        with patch("caracal.flow.workspace.get_workspace", side_effect=Exception("no workspace")):
            result = _load_local_delegation()
        assert result == []

    def test_returns_empty_when_no_config_file(self, tmp_path):
        ws_mock = MagicMock()
        ws_mock.config_path = tmp_path / "nonexistent.yaml"
        ws_mock.root = MagicMock()
        ws_mock.root.name = "test"

        with patch("caracal.flow.workspace.get_workspace", return_value=ws_mock):
            result = _load_local_delegation()

        assert result == []


class TestBuildEnterpriseSyncPayload:
    def _patch_loaders(self):
        return [
            patch("caracal.deployment.enterprise_sync_payload._load_local_principals", return_value=[{"name": "p1"}]),
            patch("caracal.deployment.enterprise_sync_payload._load_local_policies", return_value=[{"policy_id": "pol1"}]),
            patch("caracal.deployment.enterprise_sync_payload._load_local_mandates", return_value=[]),
            patch("caracal.deployment.enterprise_sync_payload._load_local_ledger", return_value=[]),
            patch("caracal.deployment.enterprise_sync_payload._load_local_delegation", return_value=[]),
            patch("caracal.deployment.enterprise_sync_payload._build_client_metadata", return_value={"k": "v"}),
        ]

    def test_returns_dict_with_required_keys(self):
        patches = self._patch_loaders()
        for p in patches:
            p.start()
        try:
            result = build_enterprise_sync_payload()
        finally:
            for p in patches:
                p.stop()

        assert "client_instance_id" in result
        assert "client_metadata" in result
        assert "principals" in result
        assert "policies" in result
        assert "mandates" in result
        assert "ledger_entries" in result
        assert "delegation_edges" in result

    def test_uses_provided_client_instance_id(self):
        patches = self._patch_loaders()
        for p in patches:
            p.start()
        try:
            result = build_enterprise_sync_payload(client_instance_id="inst-123")
        finally:
            for p in patches:
                p.stop()

        assert result["client_instance_id"] == "inst-123"

    def test_uses_provided_client_metadata(self):
        patches = self._patch_loaders()
        for p in patches:
            p.start()
        try:
            meta = {"custom": "value"}
            result = build_enterprise_sync_payload(client_metadata=meta)
        finally:
            for p in patches:
                p.stop()

        assert result["client_metadata"] == {"custom": "value"}

    def test_calls_build_client_metadata_when_none(self):
        patches = self._patch_loaders()
        for p in patches:
            p.start()
        try:
            result = build_enterprise_sync_payload(client_instance_id=None, client_metadata=None)
        finally:
            for p in patches:
                p.stop()

        assert result["client_metadata"] == {"k": "v"}

    def test_includes_principals_from_loader(self):
        patches = self._patch_loaders()
        for p in patches:
            p.start()
        try:
            result = build_enterprise_sync_payload()
        finally:
            for p in patches:
                p.stop()

        assert result["principals"] == [{"name": "p1"}]

    def test_client_instance_id_defaults_to_none(self):
        patches = self._patch_loaders()
        for p in patches:
            p.start()
        try:
            result = build_enterprise_sync_payload()
        finally:
            for p in patches:
                p.stop()

        assert result["client_instance_id"] is None
