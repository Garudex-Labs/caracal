"""Unit tests for registered tool mapping column migration."""

from __future__ import annotations

from pathlib import Path
import importlib.util

import pytest


import sys as _sys
_sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tests._caracal_source import caracal_path as _caracal_path
_MIGRATION_PATH = _caracal_path("db", "migrations", "versions", "w2x3y4z5a6b7_add_registered_tool_mapping_columns.py")


@pytest.fixture
def migration_module():
    spec = importlib.util.spec_from_file_location("migration_w2x3y4z5a6b7", _MIGRATION_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.mark.unit
def test_upgrade_adds_mapping_columns_and_provider_index(monkeypatch: pytest.MonkeyPatch, migration_module) -> None:
    add_column_calls = []
    create_index_calls = []

    class _Op:
        def add_column(self, table_name, column):
            add_column_calls.append((table_name, column.name))

        def create_index(self, name, table_name, columns, unique=False):
            create_index_calls.append((name, table_name, tuple(columns), unique))

    monkeypatch.setattr(migration_module, "op", _Op())
    monkeypatch.setattr(migration_module, "_has_column", lambda _table, _column: False)
    monkeypatch.setattr(migration_module, "_has_index", lambda _table, _index: False)

    migration_module.upgrade()

    assert add_column_calls == [
        ("registered_tools", "provider_name"),
        ("registered_tools", "resource_scope"),
        ("registered_tools", "action_scope"),
        ("registered_tools", "provider_definition_id"),
    ]
    assert create_index_calls == [
        ("ix_registered_tools_provider_name", "registered_tools", ("provider_name",), False)
    ]


@pytest.mark.unit
def test_downgrade_drops_index_then_columns(monkeypatch: pytest.MonkeyPatch, migration_module) -> None:
    drop_index_calls = []
    drop_column_calls = []

    class _Op:
        def drop_index(self, name, table_name=None):
            drop_index_calls.append((name, table_name))

        def drop_column(self, table_name, column_name):
            drop_column_calls.append((table_name, column_name))

    monkeypatch.setattr(migration_module, "op", _Op())
    monkeypatch.setattr(migration_module, "_has_index", lambda _table, _index: True)
    monkeypatch.setattr(migration_module, "_has_column", lambda _table, _column: True)

    migration_module.downgrade()

    assert drop_index_calls == [("ix_registered_tools_provider_name", "registered_tools")]
    assert drop_column_calls == [
        ("registered_tools", "provider_definition_id"),
        ("registered_tools", "action_scope"),
        ("registered_tools", "resource_scope"),
        ("registered_tools", "provider_name"),
    ]
