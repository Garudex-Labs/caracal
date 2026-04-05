"""Unit tests for hard-cut sync module removal."""

from __future__ import annotations

import importlib

import pytest

@pytest.mark.unit
def test_sync_engine_module_removed() -> None:
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("caracal.deployment.sync_engine")


@pytest.mark.unit
def test_sync_state_module_removed() -> None:
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("caracal.deployment.sync_state")
