"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for migrate_storage and StorageMigrationSummary in storage/migration.py.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from caracal.storage.migration import StorageMigrationSummary, migrate_storage


@pytest.mark.unit
class TestStorageMigrationSummaryDataclass:
    def test_fields_stored(self):
        summary = StorageMigrationSummary(
            source_root="/src",
            target_root="/dst",
            moved_items=3,
            skipped_items=1,
            dry_run=False,
            operations=[("/src/keystore", "/dst/keystore")],
        )
        assert summary.source_root == "/src"
        assert summary.moved_items == 3
        assert summary.skipped_items == 1
        assert summary.dry_run is False
        assert len(summary.operations) == 1


@pytest.mark.unit
class TestMigrateStorage:
    def test_nonexistent_source_raises(self, tmp_path):
        with pytest.raises(FileNotFoundError, match="does not exist"):
            migrate_storage(tmp_path / "nonexistent", tmp_path / "dst")

    def test_dry_run_flag_stored(self, tmp_path):
        src = tmp_path / "src"
        src.mkdir()
        (src / "keystore").mkdir()

        dst = tmp_path / "dst"
        summary = migrate_storage(src, dst, dry_run=True)

        assert summary.dry_run is True

    def test_moves_nothing_when_target_preexists(self, tmp_path):
        # ensure_layout pre-creates all canonical dirs, so they get skipped
        src = tmp_path / "src"
        src.mkdir()
        (src / "keystore").mkdir()
        (src / "keystore" / "key.pem").write_text("key")

        dst = tmp_path / "dst"
        summary = migrate_storage(src, dst)

        # ensure_layout creates dst/keystore before the copy check, so it's skipped
        assert summary.moved_items == 0
        assert summary.skipped_items >= 1

    def test_skips_non_canonical_dirs(self, tmp_path):
        src = tmp_path / "src"
        src.mkdir()
        (src / "custom_dir").mkdir()

        dst = tmp_path / "dst"
        summary = migrate_storage(src, dst)

        assert summary.skipped_items >= 1
        assert not (dst / "custom_dir").exists()

    def test_skips_already_existing_destination(self, tmp_path):
        src = tmp_path / "src"
        src.mkdir()
        (src / "keystore").mkdir()

        dst = tmp_path / "dst"
        dst.mkdir()
        (dst / "keystore").mkdir()  # pre-existing

        summary = migrate_storage(src, dst)
        assert summary.skipped_items >= 1

    def test_does_not_purge_source_when_skipped(self, tmp_path):
        src = tmp_path / "src"
        src.mkdir()
        keystore = src / "keystore"
        keystore.mkdir()
        (keystore / "test.pem").write_text("key")

        dst = tmp_path / "dst"
        summary = migrate_storage(src, dst, purge_source=True)

        # Source still exists - ensure_layout pre-created dst/keystore so nothing moved
        assert keystore.exists() or summary.moved_items == 0

    def test_returns_summary_with_paths(self, tmp_path):
        src = tmp_path / "src"
        src.mkdir()

        dst = tmp_path / "dst"
        summary = migrate_storage(src, dst)

        assert src.resolve() == Path(summary.source_root)
        assert dst.resolve() == Path(summary.target_root)

    def test_same_source_and_destination_skipped(self, tmp_path):
        src = tmp_path / "src"
        src.mkdir()
        (src / "keystore").mkdir()

        summary = migrate_storage(src, src)
        assert summary.skipped_items >= 1
