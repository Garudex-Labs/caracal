"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for removed OSS Enterprise runtime persistence migration.
"""

from __future__ import annotations

from pathlib import Path
import importlib.util

import pytest


import sys as _sys

_sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tests.mock.source import caracal_path as _caracal_path

_MIGRATION_PATH = _caracal_path(
    "db",
    "migrations",
    "versions",
    "r7s8t9u0v1w2_enterprise_runtime_persistence_hardcut.py",
)


@pytest.fixture
def migration_module():
    spec = importlib.util.spec_from_file_location("migration_r7s8t9u0v1w2", _MIGRATION_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.mark.unit
def test_upgrade_is_noop(migration_module) -> None:
    migration_module.upgrade()


@pytest.mark.unit
def test_downgrade_is_noop(migration_module) -> None:
    migration_module.downgrade()