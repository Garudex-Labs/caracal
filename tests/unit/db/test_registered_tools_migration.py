"""Unit tests for registered tools table migration."""

from __future__ import annotations

from pathlib import Path
import importlib.util

import pytest


import sys as _sys
_sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tests.mock.source import caracal_path as _caracal_path
_MIGRATION_PATH = _caracal_path("db", "migrations", "versions", "v1w2x3y4z5a6_add_registered_tools_table.py")


@pytest.fixture
def migration_module():
    spec = importlib.util.spec_from_file_location("migration_v1w2x3y4z5a6", _MIGRATION_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.mark.unit
def test_upgrade_creates_registered_tools_table_and_indexes(monkeypatch: pytest.MonkeyPatch, migration_module) -> None:
    create_table_calls = []
    create_index_calls = []

    class _Op:
        def create_table(self, *args, **kwargs):
            create_table_calls.append((args, kwargs))

        def create_index(self, *args, **kwargs):
            create_index_calls.append((args, kwargs))

    monkeypatch.setattr(migration_module, "op", _Op())
    monkeypatch.setattr(migration_module, "_has_table", lambda _name: False)
    monkeypatch.setattr(migration_module, "_has_index", lambda _table, _index: False)

    migration_module.upgrade()

    assert len(create_table_calls) == 1
    table_args = create_table_calls[0][0]
    assert table_args[0] == "registered_tools"
    assert any(getattr(arg, "name", "") == "tool_id" for arg in table_args)
    assert any(getattr(arg, "name", "") == "active" for arg in table_args)

    assert len(create_index_calls) == 2
    index_names = {call[0][0] for call in create_index_calls}
    assert "ix_registered_tools_tool_id" in index_names
    assert "ix_registered_tools_active" in index_names


@pytest.mark.unit
def test_downgrade_drops_indexes_then_table(monkeypatch: pytest.MonkeyPatch, migration_module) -> None:
    drop_index_calls = []
    drop_table_calls = []

    class _Op:
        def drop_index(self, *args, **kwargs):
            drop_index_calls.append((args, kwargs))

        def drop_table(self, *args, **kwargs):
            drop_table_calls.append((args, kwargs))

    monkeypatch.setattr(migration_module, "op", _Op())

    def _has_index(_table: str, index_name: str) -> bool:
        return index_name in {"ix_registered_tools_tool_id", "ix_registered_tools_active"}

    monkeypatch.setattr(migration_module, "_has_index", _has_index)
    monkeypatch.setattr(migration_module, "_has_table", lambda table_name: table_name == "registered_tools")

    migration_module.downgrade()

    assert [call[0][0] for call in drop_index_calls] == [
        "ix_registered_tools_active",
        "ix_registered_tools_tool_id",
    ]
    assert drop_table_calls[0][0][0] == "registered_tools"
