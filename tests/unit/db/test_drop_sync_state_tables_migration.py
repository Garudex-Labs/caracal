"""Unit tests for destructive sync-state hard-cut migration."""

from __future__ import annotations

from pathlib import Path
import importlib.util

import pytest


import sys as _sys
_sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tests.mock.source import caracal_path as _caracal_path
_MIGRATION_PATH = _caracal_path("db", "migrations", "versions", "s8t9u0v1w2x3_drop_sync_state_tables_hardcut.py")


@pytest.fixture
def migration_module():
    spec = importlib.util.spec_from_file_location("migration_s8t9u0v1w2x3", _MIGRATION_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.mark.unit
def test_upgrade_drops_sync_tables_and_indexes_when_present(monkeypatch: pytest.MonkeyPatch, migration_module) -> None:
    dropped_indexes = []
    dropped_tables = []

    class _Op:
        def drop_index(self, name, table_name=None):
            dropped_indexes.append((name, table_name))

        def drop_table(self, table_name):
            dropped_tables.append(table_name)

    monkeypatch.setattr(migration_module, "op", _Op())
    monkeypatch.setattr(migration_module, "_has_table", lambda _table: True)
    monkeypatch.setattr(migration_module, "_has_index", lambda _table, _index: True)

    migration_module.upgrade()

    assert dropped_tables == ["sync_metadata", "sync_conflicts", "sync_operations"]
    assert len(dropped_indexes) == sum(len(v) for v in migration_module._SYNC_INDEXES.values())


@pytest.mark.unit
def test_upgrade_is_idempotent_when_tables_absent(monkeypatch: pytest.MonkeyPatch, migration_module) -> None:
    dropped_indexes = []
    dropped_tables = []

    class _Op:
        def drop_index(self, name, table_name=None):
            dropped_indexes.append((name, table_name))

        def drop_table(self, table_name):
            dropped_tables.append(table_name)

    monkeypatch.setattr(migration_module, "op", _Op())
    monkeypatch.setattr(migration_module, "_has_table", lambda _table: False)
    monkeypatch.setattr(migration_module, "_has_index", lambda _table, _index: False)

    migration_module.upgrade()

    assert dropped_indexes == []
    assert dropped_tables == []


@pytest.mark.unit
def test_downgrade_recreates_sync_tables_when_missing(monkeypatch: pytest.MonkeyPatch, migration_module) -> None:
    created_tables = []
    created_indexes = []

    class _Op:
        def create_table(self, table_name, *args, **kwargs):
            created_tables.append(table_name)

        def create_index(self, name, table_name, columns):
            created_indexes.append((name, table_name, tuple(columns)))

    monkeypatch.setattr(migration_module, "op", _Op())
    monkeypatch.setattr(migration_module, "_has_table", lambda _table: False)

    migration_module.downgrade()

    assert created_tables == ["sync_operations", "sync_conflicts", "sync_metadata"]
    assert len(created_indexes) == sum(len(v) for v in migration_module._SYNC_INDEXES.values())


@pytest.mark.unit
def test_downgrade_skips_existing_tables(monkeypatch: pytest.MonkeyPatch, migration_module) -> None:
    created_tables = []

    class _Op:
        def create_table(self, table_name, *args, **kwargs):
            created_tables.append(table_name)

        def create_index(self, name, table_name, columns):
            return None

    monkeypatch.setattr(migration_module, "op", _Op())
    monkeypatch.setattr(migration_module, "_has_table", lambda _table: True)

    migration_module.downgrade()

    assert created_tables == []
