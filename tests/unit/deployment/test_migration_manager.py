"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for MigrationManager pure methods.
"""

import pytest
import hashlib
import tempfile
from datetime import datetime
from pathlib import Path
from unittest.mock import patch, MagicMock

from caracal.deployment.migration import MigrationManager
from caracal.deployment.exceptions import MigrationValidationError


pytestmark = pytest.mark.unit


def _make_manager(tmp_path: Path) -> MigrationManager:
    mgr = MigrationManager.__new__(MigrationManager)
    mgr.BACKUP_DIR = tmp_path / "backups"
    mgr.BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    mgr.config_manager = MagicMock()
    mgr.edition_adapter = MagicMock()
    return mgr


class TestCalculateChecksum:
    def test_returns_hex_string(self, tmp_path):
        mgr = _make_manager(tmp_path)
        f = tmp_path / "file.bin"
        f.write_bytes(b"hello world")
        result = mgr._calculate_checksum(f)
        assert len(result) == 64
        assert all(c in "0123456789abcdef" for c in result)

    def test_deterministic(self, tmp_path):
        mgr = _make_manager(tmp_path)
        f = tmp_path / "file.bin"
        f.write_bytes(b"test data")
        assert mgr._calculate_checksum(f) == mgr._calculate_checksum(f)

    def test_different_content_different_hash(self, tmp_path):
        mgr = _make_manager(tmp_path)
        f1 = tmp_path / "f1.bin"
        f2 = tmp_path / "f2.bin"
        f1.write_bytes(b"content1")
        f2.write_bytes(b"content2")
        assert mgr._calculate_checksum(f1) != mgr._calculate_checksum(f2)

    def test_matches_hashlib_sha256(self, tmp_path):
        mgr = _make_manager(tmp_path)
        data = b"test content"
        f = tmp_path / "file.bin"
        f.write_bytes(data)
        expected = hashlib.sha256(data).hexdigest()
        assert mgr._calculate_checksum(f) == expected


class TestGenerateMigrationId:
    def test_contains_migration_type(self, tmp_path):
        mgr = _make_manager(tmp_path)
        result = mgr._generate_migration_id("edition_switch")
        assert result.startswith("edition_switch_")

    def test_contains_timestamp(self, tmp_path):
        mgr = _make_manager(tmp_path)
        result = mgr._generate_migration_id("repo_migration")
        parts = result.split("_")
        assert len(parts) >= 2
        timestamp_part = parts[-1]
        assert timestamp_part.isdigit()

    def test_unique_per_call(self, tmp_path):
        mgr = _make_manager(tmp_path)
        ids = {mgr._generate_migration_id("test") for _ in range(3)}
        assert len(ids) >= 1


class TestTargetWorkspaces:
    def test_returns_single_workspace_when_specified(self, tmp_path):
        mgr = _make_manager(tmp_path)
        result = mgr._target_workspaces("my-workspace")
        assert result == ["my-workspace"]

    def test_calls_list_workspaces_when_none(self, tmp_path):
        mgr = _make_manager(tmp_path)
        mgr.config_manager.list_workspaces.return_value = ["ws1", "ws2"]
        result = mgr._target_workspaces(None)
        assert result == ["ws1", "ws2"]


class TestResolveCredentialSelection:
    def test_returns_all_when_no_filter(self, tmp_path):
        mgr = _make_manager(tmp_path)
        selected, missing = mgr._resolve_credential_selection(["key1", "key2"], None)
        assert sorted(selected) == ["key1", "key2"]
        assert missing == []

    def test_filters_to_requested(self, tmp_path):
        mgr = _make_manager(tmp_path)
        selected, missing = mgr._resolve_credential_selection(["key1", "key2", "key3"], ["key1"])
        assert selected == ["key1"]
        assert missing == []

    def test_reports_missing_credentials(self, tmp_path):
        mgr = _make_manager(tmp_path)
        selected, missing = mgr._resolve_credential_selection(["key1"], ["key1", "key2"])
        assert "key1" in selected
        assert "key2" in missing

    def test_deduplicates_selected(self, tmp_path):
        mgr = _make_manager(tmp_path)
        selected, _ = mgr._resolve_credential_selection(["key1", "key1"], None)
        assert selected.count("key1") == 1

    def test_empty_available_returns_empty(self, tmp_path):
        mgr = _make_manager(tmp_path)
        selected, missing = mgr._resolve_credential_selection([], ["key1"])
        assert selected == []
        assert "key1" in missing


class TestAppendMigrationAudit:
    def test_appends_event(self, tmp_path):
        mgr = _make_manager(tmp_path)
        metadata = {}
        mgr._append_migration_audit(metadata, "oss_to_enterprise", "ws1", {"k": "v"})
        audit = metadata["migration_audit"]
        assert len(audit) == 1
        assert audit[0]["event"] == "oss_to_enterprise"

    def test_appends_multiple_events(self, tmp_path):
        mgr = _make_manager(tmp_path)
        metadata = {}
        mgr._append_migration_audit(metadata, "event1", "ws1", {})
        mgr._append_migration_audit(metadata, "event2", "ws1", {})
        assert len(metadata["migration_audit"]) == 2

    def test_preserves_existing_audit(self, tmp_path):
        mgr = _make_manager(tmp_path)
        existing = [{"event": "old_event", "workspace": "ws1", "timestamp": "t", "payload": {}}]
        metadata = {"migration_audit": existing}
        mgr._append_migration_audit(metadata, "new_event", "ws1", {})
        assert metadata["migration_audit"][0]["event"] == "old_event"
        assert metadata["migration_audit"][1]["event"] == "new_event"

    def test_resets_corrupt_audit(self, tmp_path):
        mgr = _make_manager(tmp_path)
        metadata = {"migration_audit": "corrupted_not_list"}
        mgr._append_migration_audit(metadata, "event", "ws1", {})
        assert isinstance(metadata["migration_audit"], list)


class TestExplicitMigrationContract:
    def test_contract_has_required_keys(self, tmp_path):
        mgr = _make_manager(tmp_path)
        mgr._load_workspace_metadata = MagicMock(return_value={})
        contract = mgr._explicit_migration_contract(
            workspace="ws1",
            direction="oss_to_enterprise",
            gateway_url="https://gw.example.com",
            selected_credentials=["key1"],
        )
        assert contract["version"] == "v1"
        assert contract["direction"] == "oss_to_enterprise"
        assert contract["workspace"] == "ws1"
        assert "key1" in contract["credentials_selected"]

    def test_enterprise_direction_sets_source_target(self, tmp_path):
        mgr = _make_manager(tmp_path)
        mgr._load_workspace_metadata = MagicMock(return_value={})
        contract = mgr._explicit_migration_contract(
            workspace="ws1",
            direction="oss_to_enterprise",
            gateway_url="https://gw.example.com",
            selected_credentials=[],
        )
        assert contract["source_model"] == "broker"
        assert contract["target_model"] == "gateway"

    def test_oss_direction_sets_source_target(self, tmp_path):
        mgr = _make_manager(tmp_path)
        mgr._load_workspace_metadata = MagicMock(return_value={})
        contract = mgr._explicit_migration_contract(
            workspace="ws1",
            direction="enterprise_to_oss",
            gateway_url=None,
            selected_credentials=[],
        )
        assert contract["source_model"] == "gateway"
        assert contract["target_model"] == "broker"

    def test_includes_gateway_url_when_provided(self, tmp_path):
        mgr = _make_manager(tmp_path)
        mgr._load_workspace_metadata = MagicMock(return_value={})
        contract = mgr._explicit_migration_contract(
            workspace="ws1",
            direction="oss_to_enterprise",
            gateway_url="https://gw.example.com",
            selected_credentials=[],
        )
        assert contract["gateway_url"] == "https://gw.example.com"


class TestApplyImportedMigrationContract:
    def test_rejects_wrong_version(self, tmp_path):
        mgr = _make_manager(tmp_path)
        contract = {"version": "v99", "registration_state": {}}
        with pytest.raises(MigrationValidationError, match="version"):
            mgr._apply_imported_migration_contract(workspace="ws1", contract=contract, audit_event="test")

    def test_rejects_non_dict_contract(self, tmp_path):
        mgr = _make_manager(tmp_path)
        with pytest.raises(MigrationValidationError):
            mgr._apply_imported_migration_contract(workspace="ws1", contract="not a dict", audit_event="test")

    def test_applies_registration_state(self, tmp_path):
        mgr = _make_manager(tmp_path)
        metadata = {}
        mgr._load_workspace_metadata = MagicMock(return_value=metadata)
        mgr._save_workspace_metadata = MagicMock()
        contract = {
            "version": "v1",
            "registration_state": {"key": "val"},
            "authority_graph_state": {},
            "runtime_session_state": {},
        }
        mgr._apply_imported_migration_contract(workspace="ws1", contract=contract, audit_event="imported")
        assert metadata.get("registration_state") == {"key": "val"}


class TestListBackups:
    def test_returns_empty_when_no_backups(self, tmp_path):
        mgr = _make_manager(tmp_path)
        result = mgr.list_backups()
        assert result == []

    def test_returns_backup_info(self, tmp_path):
        mgr = _make_manager(tmp_path)
        backup_file = mgr.BACKUP_DIR / "backup_test_abc_20260101.tar.gz"
        backup_file.write_bytes(b"fake tar content")
        result = mgr.list_backups()
        assert len(result) == 1
        assert result[0]["name"] == "backup_test_abc_20260101.tar.gz"
        assert "size_bytes" in result[0]
        assert "created_at" in result[0]

    def test_has_checksum_flag(self, tmp_path):
        mgr = _make_manager(tmp_path)
        backup_file = mgr.BACKUP_DIR / "backup_test_abc_20260101.tar.gz"
        backup_file.write_bytes(b"fake tar content")
        checksum_file = backup_file.with_suffix(".tar.gz.sha256")
        checksum_file.write_text("abc123")
        result = mgr.list_backups()
        assert result[0]["has_checksum"] is True
