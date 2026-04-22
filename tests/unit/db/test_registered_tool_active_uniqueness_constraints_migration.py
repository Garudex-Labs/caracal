"""Unit tests for registered tool active uniqueness constraints migration."""

from __future__ import annotations

from pathlib import Path
import importlib.util

import pytest


import sys as _sys
_sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tests._caracal_source import caracal_path as _caracal_path
_MIGRATION_PATH = _caracal_path("db", "migrations", "versions", "z5a6b7c8d9e0_add_registered_tool_active_uniqueness_constraints.py")


@pytest.fixture
def migration_module():
    spec = importlib.util.spec_from_file_location("migration_z5a6b7c8d9e0", _MIGRATION_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.mark.unit
def test_upgrade_replaces_global_uniqueness_with_active_workspace_indexes(
    monkeypatch: pytest.MonkeyPatch,
    migration_module,
) -> None:
    execute_calls = []
    drop_index_calls = []
    drop_constraint_calls = []
    create_index_calls = []
    existing_indexes = {"ix_registered_tools_tool_id"}

    class _Op:
        def execute(self, statement):
            execute_calls.append(str(statement))

        def drop_index(self, name, table_name=None):
            drop_index_calls.append((name, table_name))
            existing_indexes.discard(name)

        def drop_constraint(self, name, table_name, type_=None):
            drop_constraint_calls.append((name, table_name, type_))

        def create_index(self, name, table_name, columns, unique=False, **kwargs):
            create_index_calls.append((name, table_name, tuple(columns), unique, kwargs))
            existing_indexes.add(name)

    monkeypatch.setattr(migration_module, "op", _Op())
    monkeypatch.setattr(migration_module, "_has_table", lambda _table: True)
    monkeypatch.setattr(migration_module, "_has_index", lambda _table, index: index in existing_indexes)
    monkeypatch.setattr(migration_module, "_has_unique_constraint", lambda _table, _constraint: True)

    migration_module.upgrade()

    assert execute_calls
    assert "UPDATE registered_tools SET workspace_name = 'default'" in execute_calls[0]
    assert drop_index_calls == [("ix_registered_tools_tool_id", "registered_tools")]
    assert drop_constraint_calls == [
        ("uq_registered_tools_tool_id", "registered_tools", "unique")
    ]

    created_index_names = [call[0] for call in create_index_calls]
    assert created_index_names == [
        "ix_registered_tools_tool_id",
        "uq_registered_tools_active_workspace_tool_id",
        "uq_registered_tools_active_workspace_binding",
    ]
    assert create_index_calls[0][3] is False
    assert create_index_calls[1][3] is True
    assert create_index_calls[2][3] is True


@pytest.mark.unit
def test_downgrade_restores_global_uniqueness(monkeypatch: pytest.MonkeyPatch, migration_module) -> None:
    drop_index_calls = []
    create_constraint_calls = []
    create_index_calls = []
    existing_indexes = {
        "uq_registered_tools_active_workspace_binding",
        "uq_registered_tools_active_workspace_tool_id",
        "ix_registered_tools_tool_id",
    }

    class _Op:
        def drop_index(self, name, table_name=None):
            drop_index_calls.append((name, table_name))
            existing_indexes.discard(name)

        def create_unique_constraint(self, name, table_name, columns):
            create_constraint_calls.append((name, table_name, tuple(columns)))

        def create_index(self, name, table_name, columns, unique=False, **kwargs):
            create_index_calls.append((name, table_name, tuple(columns), unique, kwargs))
            existing_indexes.add(name)

    monkeypatch.setattr(migration_module, "op", _Op())
    monkeypatch.setattr(migration_module, "_has_table", lambda _table: True)
    monkeypatch.setattr(migration_module, "_has_index", lambda _table, index: index in existing_indexes)
    monkeypatch.setattr(migration_module, "_has_unique_constraint", lambda _table, _constraint: False)

    migration_module.downgrade()

    assert drop_index_calls == [
        ("uq_registered_tools_active_workspace_binding", "registered_tools"),
        ("uq_registered_tools_active_workspace_tool_id", "registered_tools"),
        ("ix_registered_tools_tool_id", "registered_tools"),
    ]
    assert create_constraint_calls == [
        ("uq_registered_tools_tool_id", "registered_tools", ("tool_id",))
    ]
    assert create_index_calls == [
        (
            "ix_registered_tools_tool_id",
            "registered_tools",
            ("tool_id",),
            True,
            {},
        )
    ]
