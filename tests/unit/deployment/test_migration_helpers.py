"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for MigrationManager pure helper methods.
"""
import pytest
from unittest.mock import MagicMock, patch


def _make_manager():
    """Build a MigrationManager with mocked dependencies."""
    with (
        patch("caracal.deployment.migration.ConfigManager"),
        patch("caracal.deployment.migration.get_deployment_edition_adapter"),
        patch("caracal.deployment.migration.Path.mkdir"),
        patch("caracal.deployment.migration.Path.chmod"),
    ):
        from caracal.deployment.migration import MigrationManager
        mgr = MigrationManager.__new__(MigrationManager)
        mgr.config_manager = MagicMock()
        mgr.edition_adapter = MagicMock()
        return mgr


@pytest.mark.unit
class TestResolveCredentialSelection:
    def setup_method(self):
        self.mgr = _make_manager()

    def test_none_include_returns_all_sorted(self):
        selected, missing = self.mgr._resolve_credential_selection(
            ["c", "a", "b"], None
        )
        assert selected == ["a", "b", "c"]
        assert missing == []

    def test_empty_available_with_none_include(self):
        selected, missing = self.mgr._resolve_credential_selection([], None)
        assert selected == []
        assert missing == []

    def test_include_subset_of_available(self):
        selected, missing = self.mgr._resolve_credential_selection(
            ["a", "b", "c"], ["a", "c"]
        )
        assert selected == ["a", "c"]
        assert missing == []

    def test_missing_credentials_reported(self):
        selected, missing = self.mgr._resolve_credential_selection(
            ["a", "b"], ["a", "x", "y"]
        )
        assert selected == ["a"]
        assert "x" in missing
        assert "y" in missing

    def test_duplicates_in_available_deduplicated(self):
        selected, missing = self.mgr._resolve_credential_selection(
            ["a", "a", "b"], None
        )
        assert selected == ["a", "b"]

    def test_empty_string_available_filtered(self):
        selected, missing = self.mgr._resolve_credential_selection(
            ["a", "", "b"], None
        )
        assert "" not in selected
        assert "a" in selected

    def test_empty_string_in_include_ignored(self):
        selected, missing = self.mgr._resolve_credential_selection(
            ["a", "b"], ["a", ""]
        )
        assert selected == ["a"]
        assert "" not in missing

    def test_include_ordering_preserved(self):
        selected, missing = self.mgr._resolve_credential_selection(
            ["a", "b", "c"], ["c", "a"]
        )
        assert selected == ["c", "a"]

    def test_duplicate_includes_deduplicated(self):
        selected, missing = self.mgr._resolve_credential_selection(
            ["a", "b"], ["a", "a", "b"]
        )
        assert selected.count("a") == 1


@pytest.mark.unit
class TestAppendMigrationAudit:
    def setup_method(self):
        self.mgr = _make_manager()

    def test_appends_event_to_empty_metadata(self):
        meta: dict = {}
        self.mgr._append_migration_audit(meta, "oss_to_enterprise", "ws1", {"k": "v"})
        audit = meta["migration_audit"]
        assert len(audit) == 1
        assert audit[0]["event"] == "oss_to_enterprise"
        assert audit[0]["workspace"] == "ws1"
        assert audit[0]["payload"] == {"k": "v"}
        assert "timestamp" in audit[0]

    def test_appends_to_existing_list(self):
        meta = {"migration_audit": [{"event": "first", "workspace": "w", "timestamp": "t", "payload": {}}]}
        self.mgr._append_migration_audit(meta, "second", "ws1", {})
        assert len(meta["migration_audit"]) == 2

    def test_non_list_audit_value_reset(self):
        meta = {"migration_audit": "bad_value"}
        self.mgr._append_migration_audit(meta, "reset", "ws1", {})
        assert isinstance(meta["migration_audit"], list)
        assert len(meta["migration_audit"]) == 1

    def test_audit_capped_at_200(self):
        existing = [{"event": str(i), "workspace": "w", "timestamp": "t", "payload": {}} for i in range(205)]
        meta = {"migration_audit": existing}
        self.mgr._append_migration_audit(meta, "new", "w", {})
        assert len(meta["migration_audit"]) == 200
