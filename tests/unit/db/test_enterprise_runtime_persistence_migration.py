"""Unit tests for enterprise runtime persistence hard-cut migration."""

from __future__ import annotations

from pathlib import Path
import importlib.util

import pytest


import sys as _sys
_sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tests._caracal_source import caracal_path as _caracal_path
_MIGRATION_PATH = _caracal_path("db", "migrations", "versions", "r7s8t9u0v1w2_enterprise_runtime_persistence_hardcut.py")


@pytest.fixture
def migration_module():
    spec = importlib.util.spec_from_file_location("migration_r7s8t9u0v1w2", _MIGRATION_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.mark.unit
def test_upgrade_creates_table_and_migrates_runtime_row(monkeypatch: pytest.MonkeyPatch, migration_module) -> None:
    create_table_calls = []
    execute_calls = []

    class _Op:
        def create_table(self, *args, **kwargs):
            create_table_calls.append((args, kwargs))

        def execute(self, statement, params=None):
            execute_calls.append((str(statement), params))

    monkeypatch.setattr(migration_module, "op", _Op())
    monkeypatch.setattr(migration_module, "_has_table", lambda name: False)
    monkeypatch.setattr(migration_module, "_has_column", lambda table, column: table == "sync_metadata" and column == "metadata")

    migration_module.upgrade()

    assert len(create_table_calls) == 1
    assert create_table_calls[0][0][0] == "enterprise_runtime_config"

    assert len(execute_calls) == 2
    assert "INSERT INTO enterprise_runtime_config" in execute_calls[0][0]
    assert "ON CONFLICT (runtime_key)" in execute_calls[0][0]
    assert execute_calls[0][1] == {"runtime_key": "__enterprise_runtime__"}
    assert "DELETE FROM sync_metadata" in execute_calls[1][0]
    assert execute_calls[1][1] == {"runtime_key": "__enterprise_runtime__"}


@pytest.mark.unit
def test_upgrade_skips_copy_when_sync_metadata_column_missing(monkeypatch: pytest.MonkeyPatch, migration_module) -> None:
    create_table_calls = []
    execute_calls = []

    class _Op:
        def create_table(self, *args, **kwargs):
            create_table_calls.append((args, kwargs))

        def execute(self, statement, params=None):
            execute_calls.append((str(statement), params))

    monkeypatch.setattr(migration_module, "op", _Op())
    monkeypatch.setattr(migration_module, "_has_table", lambda name: True)
    monkeypatch.setattr(migration_module, "_has_column", lambda _table, _column: False)

    migration_module.upgrade()

    assert create_table_calls == []
    assert execute_calls == []


@pytest.mark.unit
def test_downgrade_restores_sync_metadata_and_drops_table(monkeypatch: pytest.MonkeyPatch, migration_module) -> None:
    execute_calls = []
    drop_table_calls = []

    class _Op:
        def execute(self, statement, params=None):
            execute_calls.append((str(statement), params))

        def drop_table(self, table_name):
            drop_table_calls.append(table_name)

    monkeypatch.setattr(migration_module, "op", _Op())
    monkeypatch.setattr(migration_module, "_has_table", lambda name: name == "enterprise_runtime_config")
    monkeypatch.setattr(migration_module, "_has_column", lambda table, column: table == "sync_metadata" and column == "metadata")

    migration_module.downgrade()

    assert len(execute_calls) == 1
    assert "INSERT INTO sync_metadata" in execute_calls[0][0]
    assert "jsonb_build_object('enterprise_config'" in execute_calls[0][0]
    assert "ON CONFLICT (workspace)" in execute_calls[0][0]
    assert execute_calls[0][1] == {"runtime_key": "__enterprise_runtime__"}
    assert drop_table_calls == ["enterprise_runtime_config"]


@pytest.mark.unit
def test_downgrade_is_idempotent_when_table_absent(monkeypatch: pytest.MonkeyPatch, migration_module) -> None:
    execute_calls = []
    drop_table_calls = []

    class _Op:
        def execute(self, statement, params=None):
            execute_calls.append((str(statement), params))

        def drop_table(self, table_name):
            drop_table_calls.append(table_name)

    monkeypatch.setattr(migration_module, "op", _Op())
    monkeypatch.setattr(migration_module, "_has_table", lambda _name: False)
    monkeypatch.setattr(migration_module, "_has_column", lambda _table, _column: False)

    migration_module.downgrade()

    assert execute_calls == []
    assert drop_table_calls == []
