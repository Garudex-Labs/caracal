"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for OSS gateway feature flag ownership boundaries.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


pytestmark = pytest.mark.unit


def test_gateway_feature_module_is_not_shipped_in_oss_core() -> None:
    assert importlib.util.find_spec("caracal.core.gateway_features") is None


def test_gateway_feature_source_is_not_owned_by_oss_core() -> None:
    repo_root = Path(__file__).resolve().parents[3]
    source_path = repo_root / "packages" / "caracal-server" / "caracal" / "core" / "gateway_features.py"

    assert not source_path.exists()